<?php
declare(strict_types=1);

require_once __DIR__ . '/bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(405, [
        'success' => false,
        'message' => 'Method not allowed. Use POST.',
    ]);
}

if (HDEV_CALLBACK_SECRET !== '') {
    $provided = trim((string) ($_SERVER['HTTP_X_HDEV_CALLBACK_SECRET'] ?? ''));
    if (!hash_equals(HDEV_CALLBACK_SECRET, $provided)) {
        json_response(401, [
            'success' => false,
            'message' => 'Unauthorized callback.',
        ]);
    }
}

$input = get_input();
$txRef = trim((string) ($input['tx_ref'] ?? $input['transaction_ref'] ?? $_GET['tx_ref'] ?? ''));

if ($txRef === '') {
    json_response(422, [
        'success' => false,
        'message' => 'tx_ref is required.',
    ]);
}

$result = sync_payment_status(db(), $txRef);
json_response((int) ($result['http_code'] ?? 500), $result);
