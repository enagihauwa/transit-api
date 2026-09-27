CREATE TABLE IF NOT EXISTS stops (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  stop_type TEXT NOT NULL CHECK (stop_type IN ('bus', 'tram', 'metro', 'rail')),
  zone TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (name, city)
);

CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('bus', 'tram', 'metro', 'rail')),
  city TEXT NOT NULL,
  distance_km DOUBLE PRECISION NOT NULL,
  base_fare DOUBLE PRECISION NOT NULL,
  operator TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS route_stops (
  route_id TEXT NOT NULL REFERENCES routes (id),
  stop_id TEXT NOT NULL REFERENCES stops (id),
  stop_order INTEGER NOT NULL,
  PRIMARY KEY (route_id, stop_id)
);

CREATE INDEX IF NOT EXISTS idx_route_stops_route ON route_stops (route_id);
CREATE INDEX IF NOT EXISTS idx_route_stops_stop ON route_stops (stop_id);

CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  registration TEXT NOT NULL UNIQUE,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER NOT NULL,
  capacity INTEGER NOT NULL,
  vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('bus', 'tram', 'metro', 'rail')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'retired')),
  route_id TEXT REFERENCES routes (id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vehicles_route ON vehicles (route_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_status ON vehicles (status);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  passenger_name TEXT NOT NULL,
  email TEXT NOT NULL,
  route_id TEXT NOT NULL REFERENCES routes (id),
  from_stop_id TEXT NOT NULL REFERENCES stops (id),
  to_stop_id TEXT NOT NULL REFERENCES stops (id),
  seats INTEGER NOT NULL DEFAULT 1 CHECK (seats BETWEEN 1 AND 10),
  fare DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'pending', 'cancelled')),
  travel_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookings_route ON bookings (route_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings (status);
CREATE INDEX IF NOT EXISTS idx_bookings_travel_date ON bookings (travel_date);
CREATE INDEX IF NOT EXISTS idx_bookings_from_stop ON bookings (from_stop_id);