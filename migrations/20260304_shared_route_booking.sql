-- Shared-route booking support
-- Safe migration: creates missing tables/columns only.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS route_stops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id UUID NOT NULL REFERENCES rura_routes(id) ON DELETE CASCADE,
  stop_name VARCHAR(255) NOT NULL,
  sequence INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_route_stops_route_sequence
  ON route_stops(route_id, sequence);

CREATE TABLE IF NOT EXISTS bus_schedules (
  schedule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bus_id UUID NOT NULL REFERENCES buses(id) ON DELETE CASCADE,
  route_id UUID NOT NULL REFERENCES rura_routes(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  time TIME NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  company_id UUID NULL REFERENCES companies(id) ON DELETE SET NULL,
  status VARCHAR(30) DEFAULT 'scheduled',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bus_schedules_route_date ON bus_schedules(route_id, date);
CREATE INDEX IF NOT EXISTS idx_bus_schedules_company_date ON bus_schedules(company_id, date);

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS from_stop VARCHAR(255);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS to_stop VARCHAR(255);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS passenger_name VARCHAR(255);
