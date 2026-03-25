<?php
declare(strict_types=1);

require_once __DIR__ . '/bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(405, [
        'success' => false,
        'message' => 'Method not allowed. Use POST.',
    ]);
}

$input = get_input();

$userId = isset($input['user_id']) ? (int) $input['user_id'] : 0;
$busId = isset($input['bus_id']) ? (int) $input['bus_id'] : 0;
$seatNumber = trim((string) ($input['seat_number'] ?? ''));
$amount = $input['amount'] ?? null;
$phone = normalize_phone((string) ($input['tel'] ?? $input['phone'] ?? ''));
$phoneE164 = format_phone_for_hdev((string) ($input['tel'] ?? $input['phone'] ?? ''));

if ($userId <= 0 || $busId <= 0 || $seatNumber === '' || !is_valid_amount($amount) || !is_valid_phone($phone)) {
    json_response(422, [
        'success' => false,
        'message' => 'Invalid input. Required: user_id, bus_id, seat_number, amount, tel.',
    ]);
}

$amount = number_format((float) $amount, 2, '.', '');
$txRef = generate_tx_ref();

try {
    log_payment_event('initiate_request_received', [
        'tx_ref' => $txRef,
        'user_id' => $userId,
        'bus_id' => $busId,
        'seat_number' => $seatNumber,
        'amount' => $amount,
        'phone_e164_last4' => substr($phone, -4),
        'env' => [
            'PAYMENT_API_BASE_URL' => HDEV_PAYMENT_API_BASE_URL,
            'PAYMENT_INITIATE_PATH' => HDEV_PAYMENT_INITIATE_PATH,
            'PAYMENT_STATUS_PATH' => HDEV_PAYMENT_STATUS_PATH,
            'PAYMENT_API_ID_set' => HDEV_PAYMENT_API_ID !== '',
            'PAYMENT_API_KEY_set' => HDEV_PAYMENT_API_KEY !== '',
        ],
    ]);

    // Strict sequence required by the business flow: call gateway first.
    $gatewayResponse = hdev_payment::pay($phoneE164, $amount, $txRef, HDEV_CALLBACK_URL);
    $gatewayData = as_array($gatewayResponse);
    $gatewayStatus = normalize_gateway_status($gatewayData);

    log_payment_event('initiate_gateway_raw_response', [
        'tx_ref' => $txRef,
        'http_code' => find_gateway_http_code($gatewayData),
        'normalized_status' => $gatewayStatus,
        'raw' => $gatewayData,
    ]);

    if (!has_gateway_push_ack($gatewayData)) {
        json_response(502, [
            'success' => false,
            'push_acknowledged' => false,
            'message' => 'Provider did not acknowledge push request. Not moving booking to waiting state.',
            'tx_ref' => $txRef,
            'gateway_status' => $gatewayStatus,
            'gateway_http_code' => find_gateway_http_code($gatewayData),
            'gateway' => $gatewayData,
        ]);
    }

    if ($gatewayStatus === 'FAILED') {
        json_response(402, [
            'success' => false,
            'push_acknowledged' => false,
            'message' => 'Payment initiation failed at gateway.',
            'tx_ref' => $txRef,
            'gateway' => $gatewayData,
        ]);
    }

    $pdo = db();
    $pdo->beginTransaction();

    // Prevent booking a seat already ticketed.
        $ticketSeatCheck = $pdo->prepare(<<<'SQL'
                SELECT id
                FROM tickets
                WHERE bus_id = :bus_id
                    AND seat_number = :seat_number
                    AND status IN ('CONFIRMED', 'CHECKED_IN')
                LIMIT 1
                FOR UPDATE
                SQL
        );
    $ticketSeatCheck->execute([
        ':bus_id' => $busId,
        ':seat_number' => $seatNumber,
    ]);
    if ($ticketSeatCheck->fetch()) {
        $pdo->rollBack();
        json_response(409, [
            'success' => false,
            'message' => 'Seat already booked.',
        ]);
    }

    // Prevent concurrent pending checkouts for the same seat.
        $seatLockCheck = $pdo->prepare(<<<'SQL'
                SELECT id, tx_ref, expires_at
                FROM seat_locks
                WHERE bus_id = :bus_id
                    AND seat_number = :seat_number
                    AND status = 'LOCKED'
                    AND expires_at > NOW()
                LIMIT 1
                FOR UPDATE
                SQL
        );
    $seatLockCheck->execute([
        ':bus_id' => $busId,
        ':seat_number' => $seatNumber,
    ]);
    $existingLock = $seatLockCheck->fetch();
    if ($existingLock) {
        $pdo->rollBack();
        json_response(409, [
            'success' => false,
            'message' => 'Seat is currently locked by another payment session.',
            'lock_tx_ref' => $existingLock['tx_ref'],
        ]);
    }

    $insertBooking = $pdo->prepare(<<<'SQL'
        INSERT INTO bookings (user_id, bus_id, seat_number, amount, tx_ref, status, created_at, updated_at)
        VALUES (:user_id, :bus_id, :seat_number, :amount, :tx_ref, :status, NOW(), NOW())
        RETURNING id
        SQL
    );
    $insertBooking->execute([
        ':user_id' => $userId,
        ':bus_id' => $busId,
        ':seat_number' => $seatNumber,
        ':amount' => $amount,
        ':tx_ref' => $txRef,
        ':status' => 'PENDING_PAYMENT',
    ]);

    $bookingRow = $insertBooking->fetch();
    $bookingId = (int) ($bookingRow['id'] ?? 0);
    if ($bookingId <= 0) {
        throw new RuntimeException('Failed to persist booking.');
    }

    $insertLock = $pdo->prepare(<<<'SQL'
        INSERT INTO seat_locks (booking_id, tx_ref, bus_id, seat_number, status, expires_at, created_at, updated_at)
        VALUES (:booking_id, :tx_ref, :bus_id, :seat_number, :status, NOW() + INTERVAL '10 minutes', NOW(), NOW())
        SQL
    );
    $insertLock->execute([
        ':booking_id' => $bookingId,
        ':tx_ref' => $txRef,
        ':bus_id' => $busId,
        ':seat_number' => $seatNumber,
        ':status' => 'LOCKED',
    ]);

    $pdo->commit();

    json_response(200, [
        'success' => true,
        'push_acknowledged' => true,
        'message' => 'Waiting for payment confirmation...',
        'booking_id' => $bookingId,
        'tx_ref' => $txRef,
        'status' => 'PENDING_PAYMENT',
        'gateway' => $gatewayData,
    ]);
} catch (Throwable $e) {
    if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) {
        $pdo->rollBack();
    }
    json_response(500, [
        'success' => false,
        'message' => 'Failed to initiate payment: ' . $e->getMessage(),
    ]);
}
