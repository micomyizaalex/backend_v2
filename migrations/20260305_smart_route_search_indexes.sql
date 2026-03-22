-- Smart route search and segmented booking indexes

CREATE INDEX IF NOT EXISTS idx_route_stops_route_order
  ON route_stops(route_id, sequence);

CREATE INDEX IF NOT EXISTS idx_tickets_schedule_seat
  ON tickets(schedule_id, seat_number);

CREATE INDEX IF NOT EXISTS idx_tickets_schedule_segment
  ON tickets(schedule_id, from_stop, to_stop);

CREATE INDEX IF NOT EXISTS idx_rura_routes_from_to
  ON rura_routes(LOWER(TRIM(from_location)), LOWER(TRIM(to_location)));
