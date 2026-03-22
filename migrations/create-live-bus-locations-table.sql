-- Migration: Align live_bus_locations with bus_schedules-based live tracking
-- Purpose: Store append-only GPS samples keyed by bus_schedules.schedule_id
-- Date: 2026-03-07

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS live_bus_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_id UUID NOT NULL,
    latitude NUMERIC(10, 8) NOT NULL,
    longitude NUMERIC(11, 8) NOT NULL,
    speed NUMERIC(5, 2),
    heading NUMERIC(5, 2),
    recorded_at TIMESTAMP NOT NULL DEFAULT NOW(),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE live_bus_locations
    ADD COLUMN IF NOT EXISTS id UUID,
    ADD COLUMN IF NOT EXISTS schedule_id UUID,
    ADD COLUMN IF NOT EXISTS latitude NUMERIC(10, 8),
    ADD COLUMN IF NOT EXISTS longitude NUMERIC(11, 8),
    ADD COLUMN IF NOT EXISTS speed NUMERIC(5, 2),
    ADD COLUMN IF NOT EXISTS heading NUMERIC(5, 2),
    ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMP DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

UPDATE live_bus_locations
SET id = gen_random_uuid()
WHERE id IS NULL;

UPDATE live_bus_locations
SET recorded_at = COALESCE(recorded_at, NOW()),
    created_at = COALESCE(created_at, NOW()),
    updated_at = COALESCE(updated_at, NOW())
WHERE recorded_at IS NULL
   OR created_at IS NULL
   OR updated_at IS NULL;

ALTER TABLE live_bus_locations
    ALTER COLUMN id SET NOT NULL,
    ALTER COLUMN schedule_id SET NOT NULL,
    ALTER COLUMN latitude SET NOT NULL,
    ALTER COLUMN longitude SET NOT NULL,
    ALTER COLUMN recorded_at SET NOT NULL,
    ALTER COLUMN created_at SET NOT NULL,
    ALTER COLUMN updated_at SET NOT NULL,
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN recorded_at SET DEFAULT NOW(),
    ALTER COLUMN created_at SET DEFAULT NOW(),
    ALTER COLUMN updated_at SET DEFAULT NOW();

DO $$
DECLARE
    primary_key_columns TEXT;
    constraint_name TEXT;
BEGIN
    SELECT string_agg(att.attname, ',' ORDER BY key_cols.ordinality)
    INTO primary_key_columns
    FROM pg_constraint con
    INNER JOIN pg_class rel ON rel.oid = con.conrelid
    INNER JOIN unnest(con.conkey) WITH ORDINALITY AS key_cols(attnum, ordinality) ON TRUE
    INNER JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = key_cols.attnum
    WHERE rel.relname = 'live_bus_locations'
      AND con.contype = 'p';

    IF primary_key_columns IS NOT NULL AND primary_key_columns <> 'id' THEN
        ALTER TABLE live_bus_locations DROP CONSTRAINT IF EXISTS live_bus_locations_pkey;
    END IF;

    FOR constraint_name IN
        SELECT con.conname
        FROM pg_constraint con
        INNER JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname = 'live_bus_locations'
          AND con.contype IN ('u', 'f')
    LOOP
        IF constraint_name LIKE '%schedule_id%' OR constraint_name LIKE '%live_bus_locations_schedule_id%' THEN
            EXECUTE format('ALTER TABLE live_bus_locations DROP CONSTRAINT IF EXISTS %I', constraint_name);
        END IF;
    END LOOP;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint con
        INNER JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname = 'live_bus_locations'
          AND con.contype = 'p'
          AND con.conname = 'live_bus_locations_pkey'
    ) THEN
        ALTER TABLE live_bus_locations ADD CONSTRAINT live_bus_locations_pkey PRIMARY KEY (id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint con
        INNER JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname = 'live_bus_locations'
          AND con.conname = 'live_bus_locations_schedule_id_fkey'
    ) THEN
        ALTER TABLE live_bus_locations
            ADD CONSTRAINT live_bus_locations_schedule_id_fkey
            FOREIGN KEY (schedule_id)
            REFERENCES bus_schedules(schedule_id)
            ON DELETE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_live_bus_locations_schedule_recorded_at
    ON live_bus_locations (schedule_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_live_bus_locations_schedule_updated_at
    ON live_bus_locations (schedule_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_live_bus_locations_recorded_at
    ON live_bus_locations (recorded_at DESC);

CREATE OR REPLACE FUNCTION set_live_bus_locations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_live_bus_locations_updated_at ON live_bus_locations;
CREATE TRIGGER trg_live_bus_locations_updated_at
    BEFORE UPDATE ON live_bus_locations
    FOR EACH ROW
    EXECUTE FUNCTION set_live_bus_locations_updated_at();

COMMENT ON TABLE live_bus_locations IS 'Append-only GPS samples for active bus_schedules trips';
COMMENT ON COLUMN live_bus_locations.id IS 'Primary key for each location sample';
COMMENT ON COLUMN live_bus_locations.schedule_id IS 'Foreign key to bus_schedules.schedule_id';
COMMENT ON COLUMN live_bus_locations.latitude IS 'Latitude coordinate (degrees, -90 to 90)';
COMMENT ON COLUMN live_bus_locations.longitude IS 'Longitude coordinate (degrees, -180 to 180)';
COMMENT ON COLUMN live_bus_locations.speed IS 'Speed in km/h';
COMMENT ON COLUMN live_bus_locations.heading IS 'Compass heading in degrees (0-360)';
COMMENT ON COLUMN live_bus_locations.recorded_at IS 'Timestamp when location was recorded';

SELECT 'live_bus_locations table aligned successfully' AS status;
