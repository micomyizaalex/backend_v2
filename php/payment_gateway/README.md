# SafariTix + HDEV Payment Gateway (PHP)

## Files

- `payment_request.php` starts payment and stores booking as `PENDING_PAYMENT`
- `payment_status.php` checks gateway status and finalizes booking/ticket atomically
- `payment_callback.php` optional webhook endpoint
- `migrations/create_bookings_payment_tables.sql` MySQL schema

## Strict Flow Enforced

1. Frontend calls `payment_request.php` when user clicks Confirm & Pay.
2. Backend calls `hdev_payment::pay(...)`.
3. Backend creates booking with `PENDING_PAYMENT` and locks seat.
4. Frontend shows Waiting for payment confirmation and polls `payment_status.php?tx_ref=...`.
5. Backend calls `hdev_payment::get_pay(tx_ref)`.
6. On SUCCESS: booking -> `PAID`, ticket created once, lock -> `CONFIRMED`.
7. On FAIL/CANCEL: booking -> `FAILED`, lock -> `RELEASED`, no ticket created.

## Polling Example

```javascript
async function startPayment(payload) {
  const request = await fetch('/php/payment_gateway/payment_request.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const init = await request.json();
  if (!init.success) throw new Error(init.message || 'Payment initiation failed');

  const txRef = init.tx_ref;
  const poll = setInterval(async () => {
    const res = await fetch('/php/payment_gateway/payment_status.php?tx_ref=' + encodeURIComponent(txRef));
    const data = await res.json();

    if (data.status === 'PAID') {
      clearInterval(poll);
      // show success page
    } else if (data.status === 'FAILED') {
      clearInterval(poll);
      // show failure/cancel message
    } else {
      // keep waiting UI
    }
  }, 4000);
}
```
