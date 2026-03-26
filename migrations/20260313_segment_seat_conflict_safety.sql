-- Segment-based seat safety hardening for SafariTix
-- Run after 20260304_shared_route_booking.sql

BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS route_id TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS trip_date DATE;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS from_sequence INTEGER;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS to_sequence INTEGER;

-- Backfill route_id/trip_date from schedules.
UPDATE tickets t
SET
  route_id = COALESCE(
    t.route_id,
    s.route_id::text
  ),
  trip_date = COALESCE(
    t.trip_date,
    s.schedule_date
  )
FROM schedules s
WHERE s.id::text = t.schedule_id::text;

-- Backfill route_id/trip_date when ticket belongs only to bus_schedules.
UPDATE tickets t
SET
  route_id = COALESCE(t.route_id, bs.route_id::text),
  trip_date = COALESCE(t.trip_date, bs.date)
FROM bus_schedules bs
WHERE bs.schedule_id::text = t.schedule_id::text
  AND (t.route_id IS NULL OR t.trip_date IS NULL);

-- Backfill from_sequence/to_sequence from route_stops for existing tickets.
UPDATE tickets t
SET
  from_sequence = rs_from.sequence,
  to_sequence = rs_to.sequence
FROM route_stops rs_from
JOIN route_stops rs_to
  ON rs_to.route_id::text = rs_from.route_id::text
WHERE t.route_id IS NOT NULL
  AND rs_from.route_id::text = t.route_id::text
  AND LOWER(TRIM(rs_from.stop_name)) = LOWER(TRIM(COALESCE(t.from_stop, '')))
  AND LOWER(TRIM(rs_to.stop_name)) = LOWER(TRIM(COALESCE(t.to_stop, '')))
  AND (t.from_sequence IS NULL OR t.to_sequence IS NULL);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tickets_segment_sequence_valid'
  ) THEN
    ALTER TABLE tickets
      ADD CONSTRAINT tickets_segment_sequence_valid
      CHECK (
        (from_sequence IS NULL AND to_sequence IS NULL)
        OR (from_sequence IS NOT NULL AND to_sequence IS NOT NULL AND from_sequence < to_sequence)
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_tickets_schedule_seat_status
  ON tickets (schedule_id, seat_number, status);

CREATE INDEX IF NOT EXISTS idx_tickets_schedule_segment_seq
  ON tickets (schedule_id, from_sequence, to_sequence)
  WHERE status IN ('PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tickets_no_overlapping_segments'
  ) THEN
    ALTER TABLE tickets
      ADD CONSTRAINT tickets_no_overlapping_segments
      EXCLUDE USING gist (
        schedule_id WITH =,
        seat_number WITH =,
        int4range(from_sequence, to_sequence, '[)') WITH &&
      )
      WHERE (
        status IN ('PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN')
        AND from_sequence IS NOT NULL
        AND to_sequence IS NOT NULL
      );
  END IF;
END
$$;

COMMIT;
