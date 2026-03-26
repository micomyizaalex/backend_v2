<?php
declare(strict_types=1);

require_once __DIR__ . '/bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    json_response(405, [
        'success' => false,
        'message' => 'Method not allowed. Use GET.',
    ]);
}

$txRef = trim((string) ($_GET['tx_ref'] ?? ''));
if ($txRef === '') {
    json_response(422, [
        'success' => false,
        'message' => 'tx_ref is required.',
    ]);
}

$result = sync_payment_status(db(), $txRef);
json_response((int) ($result['http_code'] ?? 500), $result);
