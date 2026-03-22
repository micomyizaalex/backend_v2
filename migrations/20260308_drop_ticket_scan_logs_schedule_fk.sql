-- ticket_scan_logs.schedule_id may reference either schedules.id or bus_schedules.schedule_id
-- so a strict FK to schedules(id) breaks valid scans for shared-route trips.

ALTER TABLE IF EXISTS ticket_scan_logs
DROP CONSTRAINT IF EXISTS ticket_scan_logs_schedule_id_fkey;