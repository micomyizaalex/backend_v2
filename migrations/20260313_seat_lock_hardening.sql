-- Seat lock hardening: enforce valid statuses and unique active lock per seat/schedule
-- Safe to re-run.

BEGIN;

-- Normalize historical invalid lock statuses if any legacy rows exist.
UPDATE seat_locks
SET status = 'CONSUMED', updated_at = NOW()
WHERE status::text = 'CONFIRMED';

-- If status column is plain text/varchar, enforce allowed values.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'seat_locks'
      AND column_name = 'status'
      AND udt_name NOT ILIKE '%enum%'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'seat_locks_status_allowed_chk'
  ) THEN
    ALTER TABLE seat_locks
      ADD CONSTRAINT seat_locks_status_allowed_chk
      CHECK (status IN ('ACTIVE', 'EXPIRED', 'RELEASED', 'CONSUMED'));
  END IF;
END $$;

-- DB-level protection: only one ACTIVE lock per schedule+seat.
CREATE UNIQUE INDEX IF NOT EXISTS seat_locks_one_active_per_seat
ON seat_locks (schedule_id, seat_number)
WHERE status = 'ACTIVE';

-- Fast expiration scans for cleanup job.
CREATE INDEX IF NOT EXISTS idx_seat_locks_active_expires_at
ON seat_locks (expires_at)
WHERE status = 'ACTIVE';

COMMIT;
