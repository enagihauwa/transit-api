import { faker } from '@faker-js/faker';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import config from '../config.js';
import db, { countRows } from './db.js';
import { initSchema } from './db.js';
import { seedId } from './lib/ids.js';

const OPERATORS = ['CityLink Transit', 'MetroRide', 'Harbor Express', 'NorthGate Mobility', 'Skyline Lines', 'TransContinental'];
const MODE_POOL = ['bus', 'bus', 'bus', 'tram', 'metro', 'rail'];
const ZONES = ['1', '2', '3', '4', '5'];
const YEAR = new Date().getFullYear();

// Real rolling stock per mode. faker.vehicle.* returns car brands ("BMW",
// "Model T"), which is nonsense for a 190-seat metro, so pair real
// transit manufacturers with models that plausibly exist in that mode.
const ROLLING_STOCK = {
  bus: [
    { make: 'Gillig', model: 'Low Floor' },
    { make: 'New Flyer', model: 'Xcelsior' },
    { make: 'Wrightbus', model: 'StreetLite' },
    { make: 'Mercedes-Benz', model: 'Citaro' },
    { make: 'Volvo', model: '7700' },
    { make: 'BYD', model: 'K9' }
  ],
  tram: [
    { make: 'Alstom', model: 'Citadis 302' },
    { make: 'Stadler', model: 'Variobahn' },
    { make: 'Siemens', model: 'S70' },
    { make: 'CAF', model: 'Urbos 3' },
    { make: 'Bombardier', model: 'Flexity Outlook' }
  ],
  metro: [
    { make: 'Alstom', model: 'Metropolis' },
    { make: 'Siemens', model: 'Inspiro' },
    { make: 'Bombardier', model: 'Innovia Metro 300' },
    { make: 'Stadler', model: 'Vinycia' },
    { make: 'CRRC', model: 'Changchun Series' }
  ],
  rail: [
    { make: 'Stadler', model: 'FLIRT' },
    { make: 'Alstom', model: 'Coradia LINT' },
    { make: 'Bombardier', model: ' Talent 3' },
    { make: 'Siemens', model: 'Desiro City' },
    { make: 'CAF', model: 'Civity' }
  ]
};

const CITIES = [
  { city: 'Seattle', lat: 47.6062, lon: -122.3321 },
  { city: 'Vancouver', lat: 49.2827, lon: -123.1207 },
  { city: 'Portland', lat: 45.5152, lon: -122.6784 },
  { city: 'San Francisco', lat: 37.7749, lon: -122.4194 },
  { city: 'Toronto', lat: 43.6532, lon: -79.3832 },
  { city: 'Chicago', lat: 41.8781, lon: -87.6298 },
  { city: 'Boston', lat: 42.3601, lon: -71.0589 },
  { city: 'Austin', lat: 30.2672, lon: -97.7431 },
  { city: 'Denver', lat: 39.7392, lon: -104.9903 },
  { city: 'Miami', lat: 25.7617, lon: -80.1918 }
];

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;
const createdAt = () => faker.date.past({ days: 365 }).toISOString();

function stopName() {
  const kind = faker.number.int({ min: 1, max: 10 });
  if (kind <= 6) return `${faker.location.street()} & ${faker.location.street()}`;
  if (kind <= 8) return faker.location.street();
  if (kind === 9) return `${faker.person.lastName()} Station`;
  return `${faker.location.street()} Transit Hub`;
}

async function seedStops(seed) {
  const sql = `INSERT INTO stops (id, name, city, latitude, longitude, stop_type, zone, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`;
  let inserted = 0;
  for (let i = 0; i < config.seed.stops; i++) {
    const city = CITIES[faker.number.int({ min: 0, max: CITIES.length - 1 })];
    const name = stopName();
    const info = await seed.run(sql,
      seedId('stp', `${city.city}|${name}`),
      name,
      city.city,
      round(city.lat + faker.number.float({ min: -0.035, max: 0.035 }), 4),
      round(city.lon + faker.number.float({ min: -0.045, max: 0.045 }), 4),
      faker.helpers.arrayElement(MODE_POOL),
      faker.helpers.arrayElement(ZONES),
      createdAt()
    );
    inserted += info.changes;
  }
  return inserted;
}

async function seedRoutes(seed) {
  const sql = `INSERT INTO routes (id, code, name, mode, city, distance_km, base_fare, operator, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`;
  let inserted = 0;
  for (let i = 0; i < config.seed.routes; i++) {
    const city = CITIES[faker.number.int({ min: 0, max: CITIES.length - 1 })];
    const code = `${faker.helpers.arrayElement('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''))}${faker.number.int({ min: 100, max: 999 })}`;
    const distance = round(faker.number.float({ min: 3, max: 42 }), 1);
    const info = await seed.run(sql,
      seedId('rte', code),
      code,
      `${faker.location.street()} to ${faker.location.street()}`,
      faker.helpers.arrayElement(MODE_POOL),
      city.city,
      distance,
      round(distance * faker.number.float({ min: 0.25, max: 0.55 }), 2),
      faker.helpers.arrayElement(OPERATORS),
      faker.number.int({ min: 1, max: 100 }) > 8 ? 1 : 0,
      createdAt()
    );
    inserted += info.changes;
  }
  return inserted;
}

async function seedRouteStops(seed) {
  const routes = await seed.all('SELECT id, city FROM routes');
  const stopsByCity = new Map();
  let inserted = 0;
  for (const route of routes) {
    let stops = stopsByCity.get(route.city);
    if (!stops) {
      stops = await seed.all('SELECT id FROM stops WHERE city = ?', route.city);
      stopsByCity.set(route.city, stops);
    }
    const count = Math.min(stops.length, faker.number.int({ min: 6, max: 16 }));
    const chosen = faker.helpers.shuffle([...stops]).slice(0, count);
    for (const [index, stop] of chosen.entries()) {
      const info = await seed.run(
        'INSERT INTO route_stops (route_id, stop_id, stop_order) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        route.id, stop.id, index
      );
      inserted += info.changes;
    }
  }
  return inserted;
}

async function seedVehicles(seed) {
  const routesByCity = new Map();
  for (const r of await seed.all('SELECT id, city, mode FROM routes')) {
    if (!routesByCity.has(r.city)) routesByCity.set(r.city, []);
    routesByCity.get(r.city).push(r);
  }
  const sql = `INSERT INTO vehicles (id, registration, make, model, year, capacity, vehicle_type, status, route_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`;
  const CAPACITY = { bus: [40, 90], tram: [120, 220], metro: [180, 320], rail: [150, 240] };
  let inserted = 0;
  for (let i = 0; i < config.seed.vehicles; i++) {
    const city = CITIES[faker.number.int({ min: 0, max: CITIES.length - 1 })];
    const type = faker.helpers.arrayElement(MODE_POOL);
    const candidates = (routesByCity.get(city.city) || []).filter((r) => r.mode === type);
    const routeId = candidates.length > 0 && faker.number.int({ min: 1, max: 100 }) <= 75 ? faker.helpers.arrayElement(candidates).id : null;
    const registration = `${faker.string.alpha({ length: 2 }).toUpperCase()}-${faker.number.int({ min: 1000, max: 9999 })}`;
    const roll = faker.number.int({ min: 1, max: 100 });
    const status = roll <= 70 ? 'active' : roll <= 88 ? 'maintenance' : 'retired';
    const [min, max] = CAPACITY[type];
    const stock = faker.helpers.arrayElement(ROLLING_STOCK[type]);
    const info = await seed.run(sql,
      seedId('veh', registration),
      registration,
      stock.make,
      stock.model,
      faker.number.int({ min: 2014, max: Math.min(2025, YEAR - 1) }),
      faker.number.int({ min, max }),
      type,
      status,
      routeId,
      createdAt()
    );
    inserted += info.changes;
  }
  return inserted;
}

async function seedBookings(seed) {
  const routes = await seed.all('SELECT id, base_fare FROM routes');
  const sql = `INSERT INTO bookings (id, reference, passenger_name, email, route_id, from_stop_id, to_stop_id, seats, fare, status, travel_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`;
  let inserted = 0;
  for (let i = 0; i < config.seed.bookings; i++) {
    const route = routes[faker.number.int({ min: 0, max: routes.length - 1 })];
    const stops = await seed.all('SELECT stop_id FROM route_stops WHERE route_id = ?', route.id);
    if (stops.length < 2) continue;
    const [from, to] = faker.helpers.shuffle(stops.map((s) => s.stop_id)).slice(0, 2);
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    const seatsRoll = faker.number.int({ min: 1, max: 100 });
    const seats = seatsRoll <= 70 ? 1 : seatsRoll <= 90 ? 2 : faker.number.int({ min: 3, max: 4 });
    const statusRoll = faker.number.int({ min: 1, max: 100 });
    const status = statusRoll <= 70 ? 'confirmed' : statusRoll <= 85 ? 'pending' : 'cancelled';
    const travel = new Date(Date.now() + faker.number.int({ min: 0, max: 45 * 86400000 })).toISOString().slice(0, 10);
    const reference = `TVT-${faker.string.alphanumeric({ length: 6, casing: 'upper' })}`;
    const info = await seed.run(sql,
      seedId('bkg', reference),
      reference,
      `${firstName} ${lastName}`,
      faker.internet.email({ firstName, lastName }),
      route.id,
      from,
      to,
      seats,
      round(route.base_fare * seats, 2),
      status,
      travel,
      faker.date.past({ days: 90 }).toISOString()
    );
    inserted += info.changes;
  }
  return inserted;
}

// Child rows first so foreign keys never dangle.
const TABLES_IN_DELETE_ORDER = ['bookings', 'route_stops', 'vehicles', 'routes', 'stops'];

export async function resetData() {
  await initSchema();
  const report = await db.transaction(async (seed) => {
    const cleared = {};
    for (const table of TABLES_IN_DELETE_ORDER) {
      await seed.run(`DELETE FROM ${table}`);
      cleared[table] = true;
    }
    return cleared;
  });
  console.log('[transit-api] reset complete', JSON.stringify(report));
  return report;
}

export async function runSeed() {
  await initSchema();
  faker.seed(config.seed.value);
  const report = await db.transaction(async (seed) => {
    const stops = await seedStops(seed);
    const routes = await seedRoutes(seed);
    const routeStops = await seedRouteStops(seed);
    const vehicles = await seedVehicles(seed);
    const bookings = await seedBookings(seed);
    return { stops, routes, routeStops, vehicles, bookings };
  });
  console.log('[transit-api] seed complete', JSON.stringify(report));
  return report;
}

export async function ensureSeeded() {
  if (config.seed.skipAtBoot) {
    return { skipped: true };
  }
  if ((await countRows('stops')) > 0) {
    return { skipped: true, reason: 'already-seeded' };
  }
  return runSeed();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const wantsReset = process.argv.slice(2).includes('--reset');
  const task = wantsReset
    ? resetData().then(() => runSeed())
    : runSeed();
  task.catch((err) => {
    console.error('[transit-api] seed failed', err);
    process.exit(1);
  });
}