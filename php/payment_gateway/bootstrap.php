<?php
declare(strict_types=1);

/**
 * Shared bootstrap for SafariTix PHP payment integration.
 */

if (!defined('HDEV_PAYMENT_API_ID')) {
    define('HDEV_PAYMENT_API_ID', getenv('PAYMENT_API_ID') ?: (getenv('HDEV_API_ID') ?: 'HDEV-79df19cc-3202-44d1-a56a-12c5c73faeaf-ID'));
}

if (!defined('HDEV_PAYMENT_API_KEY')) {
    define('HDEV_PAYMENT_API_KEY', getenv('PAYMENT_API_KEY') ?: (getenv('HDEV_API_KEY') ?: 'HDEV-c0dd395e-e7c0-4e06-b6e2-25595b3827c5-KEY'));
}

if (!defined('HDEV_PAYMENT_API_BASE_URL')) {
    define('HDEV_PAYMENT_API_BASE_URL', getenv('PAYMENT_API_BASE_URL') ?: (getenv('HDEV_API_BASE_URL') ?: ''));
}

if (!defined('HDEV_PAYMENT_INITIATE_PATH')) {
    define('HDEV_PAYMENT_INITIATE_PATH', getenv('PAYMENT_INITIATE_PATH') ?: (getenv('HDEV_PAYMENT_INITIATE_PATH') ?: '/initiate'));
}

if (!defined('HDEV_PAYMENT_STATUS_PATH')) {
    define('HDEV_PAYMENT_STATUS_PATH', getenv('PAYMENT_STATUS_PATH') ?: (getenv('HDEV_PAYMENT_STATUS_PATH') ?: '/status'));
}

if (!defined('HDEV_CALLBACK_URL')) {
    define('HDEV_CALLBACK_URL', getenv('HDEV_CALLBACK_URL') ?: 'https://your-domain.com/php/payment_gateway/payment_callback.php');
}

if (!defined('HDEV_CALLBACK_SECRET')) {
    define('HDEV_CALLBACK_SECRET', getenv('HDEV_CALLBACK_SECRET') ?: '');
}

$gatewayClassPath = __DIR__ . '/hdev_payment.php';
if (file_exists($gatewayClassPath)) {
    require_once $gatewayClassPath;
}

if (!class_exists('hdev_payment')) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode([
        'success' => false,
        'message' => 'hdev_payment class not found. Place hdev_payment.php in this folder.',
    ]);
    exit;
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $host = getenv('PGHOST') ?: (getenv('POSTGRES_HOST') ?: '127.0.0.1');
    $port = getenv('PGPORT') ?: (getenv('POSTGRES_PORT') ?: '5432');
    $name = getenv('PGDATABASE') ?: (getenv('POSTGRES_DB') ?: 'safaritix');
    $user = getenv('PGUSER') ?: (getenv('POSTGRES_USER') ?: 'postgres');
    $pass = getenv('PGPASSWORD') ?: (getenv('POSTGRES_PASSWORD') ?: '');
    $sslMode = getenv('PGSSLMODE') ?: 'require';

    $dsn = sprintf('pgsql:host=%s;port=%s;dbname=%s;sslmode=%s', $host, $port, $name, $sslMode);
    $pdo = new PDO($dsn, $user, $pass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);

    return $pdo;
}

function json_response(int $statusCode, array $payload): void
{
    http_response_code($statusCode);
    header('Content-Type: application/json');
    echo json_encode($payload);
    exit;
}

function get_input(): array
{
    $raw = file_get_contents('php://input');
    $json = json_decode($raw ?: '', true);
    if (is_array($json)) {
        return $json;
    }
    return $_POST ?: [];
}

function normalize_phone(string $phone): string
{
    $digits = preg_replace('/\D+/', '', $phone) ?: '';
    if (str_starts_with($digits, '0') && strlen($digits) === 10) {
        return '25' . $digits;
    }
    if (strlen($digits) === 9) {
        return '250' . $digits;
    }
    return $digits;
}

function format_phone_for_hdev(string $phone): string
{
    $normalized = normalize_phone($phone);
    if (!$normalized) {
        return '';
    }
    return '+' . $normalized;
}

function is_valid_phone(string $phone): bool
{
    return preg_match('/^2507[2389]\d{7}$/', $phone) === 1;
}

function is_valid_amount($amount): bool
{
    if (!is_numeric($amount)) {
        return false;
    }
    $value = (float) $amount;
    return $value > 0 && $value <= 10000000;
}

function generate_tx_ref(): string
{
    return 'STX-' . date('YmdHis') . '-' . strtoupper(bin2hex(random_bytes(5)));
}

function as_array($value): array
{
    if (is_array($value)) {
        return $value;
    }
    if (is_object($value)) {
        return json_decode(json_encode($value), true) ?: [];
    }
    return [];
}

function payment_log_path(): string
{
    return __DIR__ . '/logs/hdev_payment.log';
}

function log_payment_event(string $event, array $context = []): void
{
    $dir = __DIR__ . '/logs';
    if (!is_dir($dir)) {
        @mkdir($dir, 0775, true);
    }

    $payload = [
        'time' => gmdate('c'),
        'event' => $event,
        'context' => $context,
    ];

    @file_put_contents(payment_log_path(), json_encode($payload, JSON_UNESCAPED_SLASHES) . PHP_EOL, FILE_APPEND);
}

function find_gateway_http_code(array $data): ?int
{
    $candidates = [
        $data['http_code'] ?? null,
        $data['status_code'] ?? null,
        $data['code'] ?? null,
        $data['response_code'] ?? null,
    ];

    foreach ($candidates as $candidate) {
        if (is_numeric($candidate)) {
            return (int) $candidate;
        }
    }

    return null;
}

function has_gateway_push_ack(array $data): bool
{
    $status = normalize_gateway_status($data);
    $httpCode = find_gateway_http_code($data);

    $hasReference = false;
    foreach (['provider_reference', 'reference', 'tx_ref', 'transaction_ref', 'transaction_id'] as $key) {
        if (!empty($data[$key]) && is_string($data[$key])) {
            $hasReference = true;
            break;
        }
    }

    $rawMessage = strtolower(trim((string) (
        $data['message'] ??
        $data['msg'] ??
        $data['description'] ??
        ''
    )));
    $messageLooksPositive = $rawMessage !== '' && (
        str_contains($rawMessage, 'request sent') ||
        str_contains($rawMessage, 'initiated') ||
        str_contains($rawMessage, 'processing') ||
        str_contains($rawMessage, 'pending') ||
        str_contains($rawMessage, 'success')
    );

    if ($status === 'FAILED') {
        return false;
    }

    if ($hasReference) {
        return true;
    }

    if ($httpCode !== null && $httpCode >= 200 && $httpCode < 300 && ($status === 'PENDING' || $status === 'SUCCESS')) {
        return true;
    }

    if ($messageLooksPositive && ($status === 'PENDING' || $status === 'SUCCESS')) {
        return true;
    }

    return false;
}

function normalize_gateway_status($gatewayResponse): string
{
    $data = as_array($gatewayResponse);
    $rawStatus = '';

    $statusCandidates = [
        $data['status'] ?? null,
        $data['payment_status'] ?? null,
        $data['result'] ?? null,
        $data['state'] ?? null,
    ];

    foreach ($statusCandidates as $candidate) {
        if (is_string($candidate) && trim($candidate) !== '') {
            $rawStatus = strtoupper(trim($candidate));
            break;
        }
    }

    if (in_array($rawStatus, ['SUCCESS', 'PAID', 'COMPLETED', 'DONE', 'OK'], true)) {
        return 'SUCCESS';
    }

    if (in_array($rawStatus, ['FAILED', 'FAIL', 'CANCELLED', 'CANCELED', 'DECLINED', 'ERROR', 'EXPIRED'], true)) {
        return 'FAILED';
    }

    return 'PENDING';
}

function create_ticket_if_missing(PDO $pdo, array $booking): array
{
    $find = $pdo->prepare('SELECT id, ticket_number, booking_id, status, created_at FROM tickets WHERE booking_id = :booking_id LIMIT 1');
    $find->execute([':booking_id' => $booking['id']]);
    $existing = $find->fetch();
    if ($existing) {
        return $existing;
    }

    $ticketNumber = 'TIX-' . date('YmdHis') . '-' . strtoupper(bin2hex(random_bytes(4)));

    $insert = $pdo->prepare(
        'INSERT INTO tickets (booking_id, user_id, bus_id, seat_number, amount, ticket_number, status, created_at)
         VALUES (:booking_id, :user_id, :bus_id, :seat_number, :amount, :ticket_number, :status, NOW())'
    );

    try {
        $insert->execute([
            ':booking_id' => $booking['id'],
            ':user_id' => $booking['user_id'],
            ':bus_id' => $booking['bus_id'],
            ':seat_number' => $booking['seat_number'],
            ':amount' => $booking['amount'],
            ':ticket_number' => $ticketNumber,
            ':status' => 'CONFIRMED',
        ]);
    } catch (PDOException $e) {
        if ($e->getCode() !== '23505') {
            throw $e;
        }
    }

    $find->execute([':booking_id' => $booking['id']]);
    $ticket = $find->fetch();
    if (!$ticket) {
        throw new RuntimeException('Ticket creation failed unexpectedly.');
    }

    return $ticket;
}

function sync_payment_status(PDO $pdo, string $txRef): array
{
    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare('SELECT * FROM bookings WHERE tx_ref = :tx_ref LIMIT 1 FOR UPDATE');
        $stmt->execute([':tx_ref' => $txRef]);
        $booking = $stmt->fetch();

        if (!$booking) {
            $pdo->rollBack();
            return [
                'success' => false,
                'http_code' => 404,
                'message' => 'Booking not found for transaction reference.',
            ];
        }

        if ($booking['status'] === 'PAID') {
            $ticket = create_ticket_if_missing($pdo, $booking);
            $updateLock = $pdo->prepare('UPDATE seat_locks SET status = :status, updated_at = NOW() WHERE booking_id = :booking_id');
            $updateLock->execute([':status' => 'CONFIRMED', ':booking_id' => $booking['id']]);
            $pdo->commit();
            return [
                'success' => true,
                'http_code' => 200,
                'status' => 'PAID',
                'booking_id' => (int) $booking['id'],
                'tx_ref' => $booking['tx_ref'],
                'ticket' => $ticket,
            ];
        }

        if ($booking['status'] === 'FAILED') {
            $pdo->commit();
            return [
                'success' => true,
                'http_code' => 200,
                'status' => 'FAILED',
                'booking_id' => (int) $booking['id'],
                'tx_ref' => $booking['tx_ref'],
            ];
        }

        $gatewayResponse = hdev_payment::get_pay($txRef);
        $gatewayStatus = normalize_gateway_status($gatewayResponse);

        if ($gatewayStatus === 'SUCCESS') {
            $updateBooking = $pdo->prepare('UPDATE bookings SET status = :status, updated_at = NOW() WHERE id = :id');
            $updateBooking->execute([':status' => 'PAID', ':id' => $booking['id']]);

            $updateLock = $pdo->prepare('UPDATE seat_locks SET status = :status, updated_at = NOW() WHERE booking_id = :booking_id');
            $updateLock->execute([':status' => 'CONFIRMED', ':booking_id' => $booking['id']]);

            $stmt->execute([':tx_ref' => $txRef]);
            $booking = $stmt->fetch();
            $ticket = create_ticket_if_missing($pdo, $booking);

            $pdo->commit();
            return [
                'success' => true,
                'http_code' => 200,
                'status' => 'PAID',
                'booking_id' => (int) $booking['id'],
                'tx_ref' => $booking['tx_ref'],
                'gateway' => as_array($gatewayResponse),
                'ticket' => $ticket,
            ];
        }

        if ($gatewayStatus === 'FAILED') {
            $updateBooking = $pdo->prepare('UPDATE bookings SET status = :status, updated_at = NOW() WHERE id = :id');
            $updateBooking->execute([':status' => 'FAILED', ':id' => $booking['id']]);

            $updateLock = $pdo->prepare('UPDATE seat_locks SET status = :status, updated_at = NOW() WHERE booking_id = :booking_id');
            $updateLock->execute([':status' => 'RELEASED', ':booking_id' => $booking['id']]);

            $pdo->commit();
            return [
                'success' => true,
                'http_code' => 200,
                'status' => 'FAILED',
                'booking_id' => (int) $booking['id'],
                'tx_ref' => $booking['tx_ref'],
                'gateway' => as_array($gatewayResponse),
            ];
        }

        $pdo->commit();
        return [
            'success' => true,
            'http_code' => 200,
            'status' => 'PENDING_PAYMENT',
            'booking_id' => (int) $booking['id'],
            'tx_ref' => $booking['tx_ref'],
            'gateway' => as_array($gatewayResponse),
        ];
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        return [
            'success' => false,
            'http_code' => 500,
            'message' => 'Payment status sync failed: ' . $e->getMessage(),
        ];
    }
}
