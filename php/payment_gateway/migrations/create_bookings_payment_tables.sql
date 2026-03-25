-- SafariTix HDEV Payment Flow (PostgreSQL / Neon)
-- Strict rule: tickets can be created only after booking payment is PAID.

BEGIN;

SET LOCAL search_path TO public;

-- Optional PostgreSQL ENUM types for strict status values.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'booking_payment_status'
      AND n.nspname = current_schema()
  ) THEN
    CREATE TYPE booking_payment_status AS ENUM ('PENDING_PAYMENT', 'PAID', 'FAILED');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'seat_lock_status'
      AND n.nspname = current_schema()
  ) THEN
    CREATE TYPE seat_lock_status AS ENUM ('LOCKED', 'CONFIRMED', 'RELEASED');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'ticket_status'
      AND n.nspname = current_schema()
  ) THEN
    CREATE TYPE ticket_status AS ENUM ('CONFIRMED', 'CHECKED_IN', 'CANCELLED');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS bookings (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  bus_id BIGINT NOT NULL,
  seat_number VARCHAR(32) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  tx_ref VARCHAR(128) NOT NULL,
  status public.booking_payment_status NOT NULL DEFAULT 'PENDING_PAYMENT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uk_bookings_tx_ref UNIQUE (tx_ref)
);

CREATE TABLE IF NOT EXISTS seat_locks (
  id BIGSERIAL PRIMARY KEY,
  booking_id BIGINT NOT NULL,
  tx_ref VARCHAR(128) NOT NULL,
  bus_id BIGINT NOT NULL,
  seat_number VARCHAR(32) NOT NULL,
  status public.seat_lock_status NOT NULL DEFAULT 'LOCKED',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uk_seat_locks_booking UNIQUE (booking_id),
  CONSTRAINT uk_seat_locks_tx_ref UNIQUE (tx_ref),
  CONSTRAINT fk_seat_locks_booking
    FOREIGN KEY (booking_id)
    REFERENCES bookings(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tickets (
  id BIGSERIAL PRIMARY KEY,
  booking_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  bus_id BIGINT NOT NULL,
  seat_number VARCHAR(32) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  ticket_number VARCHAR(128) NOT NULL,
  status public.ticket_status NOT NULL DEFAULT 'CONFIRMED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uk_tickets_booking UNIQUE (booking_id),
  CONSTRAINT uk_tickets_ticket_number UNIQUE (ticket_number),
  CONSTRAINT fk_tickets_booking
    FOREIGN KEY (booking_id)
    REFERENCES bookings(id)
    ON DELETE CASCADE
);

-- Compatibility layer for existing databases where these tables already exist
-- with older shapes (e.g., tickets table without booking_id).
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS user_id BIGINT,
  ADD COLUMN IF NOT EXISTS bus_id BIGINT,
  ADD COLUMN IF NOT EXISTS seat_number VARCHAR(32),
  ADD COLUMN IF NOT EXISTS amount NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS tx_ref VARCHAR(128),
  ADD COLUMN IF NOT EXISTS status public.booking_payment_status,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

ALTER TABLE bookings
  ALTER COLUMN created_at SET DEFAULT NOW(),
  ALTER COLUMN updated_at SET DEFAULT NOW();

ALTER TABLE seat_locks
  ADD COLUMN IF NOT EXISTS booking_id BIGINT,
  ADD COLUMN IF NOT EXISTS tx_ref VARCHAR(128),
  ADD COLUMN IF NOT EXISTS bus_id BIGINT,
  ADD COLUMN IF NOT EXISTS seat_number VARCHAR(32),
  ADD COLUMN IF NOT EXISTS status public.seat_lock_status,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

ALTER TABLE seat_locks
  ALTER COLUMN created_at SET DEFAULT NOW(),
  ALTER COLUMN updated_at SET DEFAULT NOW();

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS booking_id BIGINT,
  ADD COLUMN IF NOT EXISTS user_id BIGINT,
  ADD COLUMN IF NOT EXISTS bus_id BIGINT,
  ADD COLUMN IF NOT EXISTS seat_number VARCHAR(32),
  ADD COLUMN IF NOT EXISTS amount NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS ticket_number VARCHAR(128),
  ADD COLUMN IF NOT EXISTS status public.ticket_status,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

ALTER TABLE tickets
  ALTER COLUMN created_at SET DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uk_bookings_tx_ref' AND conrelid = 'bookings'::regclass
  ) THEN
    ALTER TABLE bookings ADD CONSTRAINT uk_bookings_tx_ref UNIQUE (tx_ref);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uk_seat_locks_booking' AND conrelid = 'seat_locks'::regclass
  ) THEN
    ALTER TABLE seat_locks ADD CONSTRAINT uk_seat_locks_booking UNIQUE (booking_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uk_seat_locks_tx_ref' AND conrelid = 'seat_locks'::regclass
  ) THEN
    ALTER TABLE seat_locks ADD CONSTRAINT uk_seat_locks_tx_ref UNIQUE (tx_ref);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uk_tickets_booking' AND conrelid = 'tickets'::regclass
  ) THEN
    ALTER TABLE tickets ADD CONSTRAINT uk_tickets_booking UNIQUE (booking_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uk_tickets_ticket_number' AND conrelid = 'tickets'::regclass
  ) THEN
    ALTER TABLE tickets ADD CONSTRAINT uk_tickets_ticket_number UNIQUE (ticket_number);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_seat_locks_booking' AND conrelid = 'seat_locks'::regclass
  ) THEN
    ALTER TABLE seat_locks
      ADD CONSTRAINT fk_seat_locks_booking
      FOREIGN KEY (booking_id)
      REFERENCES bookings(id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_tickets_booking' AND conrelid = 'tickets'::regclass
  ) THEN
    ALTER TABLE tickets
      ADD CONSTRAINT fk_tickets_booking
      FOREIGN KEY (booking_id)
      REFERENCES bookings(id)
      ON DELETE CASCADE;
  END IF;
END
$$;

-- Keep updated_at current without MySQL-style ON UPDATE clause.
CREATE OR REPLACE FUNCTION set_row_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bookings_set_updated_at ON bookings;
CREATE TRIGGER trg_bookings_set_updated_at
BEFORE UPDATE ON bookings
FOR EACH ROW
EXECUTE FUNCTION set_row_updated_at();

DROP TRIGGER IF EXISTS trg_seat_locks_set_updated_at ON seat_locks;
CREATE TRIGGER trg_seat_locks_set_updated_at
BEFORE UPDATE ON seat_locks
FOR EACH ROW
EXECUTE FUNCTION set_row_updated_at();

-- Hard guarantee: no ticket row can be inserted unless booking is already PAID.
CREATE OR REPLACE FUNCTION enforce_ticket_booking_paid()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_booking_id_text TEXT;
  v_payment_id_text TEXT;
  v_booking_status_text TEXT;
  v_payment_status_text TEXT;
  v_payment_booking_status_text TEXT;
BEGIN
  -- Read identifiers generically so the function remains compatible with
  -- different ticket schemas across environments.
  v_booking_id_text := NULLIF(to_jsonb(NEW) ->> 'booking_id', '');
  v_payment_id_text := NULLIF(to_jsonb(NEW) ->> 'payment_id', '');

  -- Primary rule: booking-driven flow.
  IF v_booking_id_text IS NOT NULL THEN
    SELECT status::text
    INTO v_booking_status_text
    FROM bookings
    WHERE id::text = v_booking_id_text
    FOR UPDATE;

    IF v_booking_status_text IS NULL THEN
      RAISE EXCEPTION 'Cannot create ticket: booking % does not exist', v_booking_id_text;
    END IF;

    IF v_booking_status_text <> 'PAID' THEN
      RAISE EXCEPTION 'Cannot create ticket: booking % is %, expected PAID', v_booking_id_text, v_booking_status_text;
    END IF;

    RETURN NEW;
  END IF;

  -- Compatibility rule: existing Node flow using payments table.
  IF v_payment_id_text IS NOT NULL THEN
    IF to_regclass('public.payments') IS NULL THEN
      RAISE EXCEPTION 'Cannot create ticket: payments table not found for payment_id flow';
    END IF;

    SELECT
      COALESCE(booking_status::text, ''),
      COALESCE(status::text, '')
    INTO v_payment_booking_status_text, v_payment_status_text
    FROM payments
    WHERE id::text = v_payment_id_text
    FOR UPDATE;

    IF v_payment_status_text IS NULL THEN
      RAISE EXCEPTION 'Cannot create ticket: payment % does not exist', v_payment_id_text;
    END IF;

    IF LOWER(v_payment_booking_status_text) <> 'paid' AND LOWER(v_payment_status_text) <> 'success' THEN
      RAISE EXCEPTION
        'Cannot create ticket: payment % is booking_status=% status=%, expected paid/success',
        v_payment_id_text,
        COALESCE(v_payment_booking_status_text, 'null'),
        COALESCE(v_payment_status_text, 'null');
    END IF;

    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Cannot create ticket: booking_id or payment_id is required';
END;
$$;

DROP TRIGGER IF EXISTS trg_tickets_require_paid_booking ON tickets;
CREATE TRIGGER trg_tickets_require_paid_booking
BEFORE INSERT OR UPDATE OF booking_id ON tickets
FOR EACH ROW
EXECUTE FUNCTION enforce_ticket_booking_paid();

-- Performance indexes.
CREATE INDEX IF NOT EXISTS idx_bookings_status
  ON bookings (status);

CREATE INDEX IF NOT EXISTS idx_bookings_user_created
  ON bookings (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bookings_bus_seat_status
  ON bookings (bus_id, seat_number, status);

CREATE INDEX IF NOT EXISTS idx_seat_locks_lookup
  ON seat_locks (bus_id, seat_number, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_seat_locks_booking_status
  ON seat_locks (booking_id, status);

CREATE INDEX IF NOT EXISTS idx_tickets_bus_seat
  ON tickets (bus_id, seat_number);

CREATE INDEX IF NOT EXISTS idx_tickets_user_created
  ON tickets (user_id, created_at DESC);

COMMIT;
