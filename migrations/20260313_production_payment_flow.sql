-- Production payment flow support for SafariTix
-- Safe to re-run.

BEGIN;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS booking_status VARCHAR(32) NOT NULL DEFAULT 'pending_payment';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_name VARCHAR(64);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_reference VARCHAR(255);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_status VARCHAR(64);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS currency VARCHAR(8) NOT NULL DEFAULT 'RWF';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS seat_lock_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS held_ticket_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS seat_numbers JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_reference
ON payments (provider_reference)
WHERE provider_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_booking_status
ON payments (booking_status);

CREATE INDEX IF NOT EXISTS idx_payments_status
ON payments (status);

CREATE INDEX IF NOT EXISTS idx_payments_expires_at_pending
ON payments (expires_at)
WHERE booking_status = 'pending_payment';

COMMIT;
