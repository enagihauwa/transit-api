import { Router } from 'express';
import { z } from 'zod';
import db from './db.js';
import { ApiError } from './lib/errors.js';
import { isValidId, makeId, makeReference } from './lib/ids.js';
import { createItemHandler, createListHandler } from './lib/pagination.js';
import { validateBody } from './lib/validate.js';
import { methodNotAllowedHandler } from './middleware/errors.js';

const router = Router();

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const toBool = (row) => ({ ...row, active: Boolean(row.active) });

const asApiError = (message) => new ApiError(422, 'INVALID_REFERENCE', message);

const STOP_FILTERS = [
  { param: 'city', column: 'city' },
  { param: 'stopType', column: 'stop_type', enum: ['bus', 'tram', 'metro', 'rail'] },
  { param: 'zone', column: 'zone' },
  { param: 'name', column: 'name', op: 'like' }
];

const ROUTE_FILTERS = [
  { param: 'city', column: 'r.city' },
  { param: 'mode', column: 'r.mode', enum: ['bus', 'tram', 'metro', 'rail'] },
  {
    param: 'active',
    column: 'r.active',
    coerce: (value) => {
      if (value === 'true' || value === '1') return 1;
      if (value === 'false' || value === '0') return 0;
      throw new ApiError(400, 'INVALID_FILTER', `active must be "true" or "false", got "${value}"`);
    }
  },
  { param: 'minFare', column: 'r.base_fare', op: 'gte', type: 'number' },
  { param: 'maxFare', column: 'r.base_fare', op: 'lte', type: 'number' }
];

const ROUTE_STOP_FILTERS = [
  { param: 'stopType', column: 's.stop_type', enum: ['bus', 'tram', 'metro', 'rail'] },
  { param: 'zone', column: 's.zone' },
  { param: 'name', column: 's.name', op: 'like' }
];

const VEHICLE_FILTERS = [
  { param: 'status', column: 'v.status', enum: ['active', 'maintenance', 'retired'] },
  { param: 'vehicleType', column: 'v.vehicle_type', enum: ['bus', 'tram', 'metro', 'rail'] },
  { param: 'routeId', column: 'v.route_id' }
];

const BOOKING_FILTERS = [
  { param: 'status', column: 'b.status', enum: ['confirmed', 'pending', 'cancelled'] },
  { param: 'routeId', column: 'b.route_id' },
  { param: 'fromStopId', column: 'b.from_stop_id' },
  { param: 'toStopId', column: 'b.to_stop_id' },
  { param: 'travelDate', column: 'b.travel_date' },
  { param: 'minFare', column: 'b.fare', op: 'gte', type: 'number' },
  { param: 'maxFare', column: 'b.fare', op: 'lte', type: 'number' },
  { param: 'passenger', column: 'b.passenger_name', op: 'like' }
];

const BOOKING_SELECT = `
  b.id, b.reference, b.passenger_name, b.email,
  b.route_id, r.code AS route_code, r.name AS route_name, r.mode AS route_mode,
  b.from_stop_id, fs.name AS from_stop_name,
  b.to_stop_id, ts.name AS to_stop_name,
  b.seats, b.fare, b.status, b.travel_date, b.created_at`;

const BOOKING_JOIN = `
  JOIN routes r ON r.id = b.route_id
  JOIN stops fs ON fs.id = b.from_stop_id
  JOIN stops ts ON ts.id = b.to_stop_id`;

const getBooking = (id) => db.get(`SELECT ${BOOKING_SELECT} FROM bookings b ${BOOKING_JOIN} WHERE b.id = ?`, id);

router.get('/stops', createListHandler({
  table: 'stops',
  select: 'id, name, city, latitude, longitude, stop_type, zone, created_at',
  orderFields: {
    name: { column: 'name', type: 'text' },
    city: { column: 'city', type: 'text' },
    zone: { column: 'zone', type: 'text' },
    latitude: { column: 'latitude', type: 'number' },
    longitude: { column: 'longitude', type: 'number' },
    created_at: { column: 'created_at', type: 'text' }
  },
  defaultOrderField: 'name',
  defaultOrderDir: 'asc',
  filters: STOP_FILTERS
}));

router.get('/stops/:id', createItemHandler({
  resourceName: 'Stop',
  table: 'stops',
  idPrefix: 'stp',
  select: 'id, name, city, latitude, longitude, stop_type, zone, created_at'
}));

router.get('/routes', createListHandler({
  table: 'routes r',
  select: `r.id, r.code, r.name, r.mode, r.city, r.distance_km, r.base_fare, r.operator, r.active,
    (SELECT COUNT(*)::int FROM route_stops WHERE route_id = r.id) AS stop_count, r.created_at`,
  orderFields: {
    code: { column: 'r.code', type: 'text' },
    name: { column: 'r.name', type: 'text' },
    city: { column: 'r.city', type: 'text' },
    operator: { column: 'r.operator', type: 'text' },
    distance_km: { column: 'r.distance_km', type: 'number' },
    base_fare: { column: 'r.base_fare', type: 'number' },
    created_at: { column: 'r.created_at', type: 'text' }
  },
  defaultOrderField: 'base_fare',
  filters: ROUTE_FILTERS,
  transform: (rows) => rows.map(toBool)
}));

router.get('/routes/:id', createItemHandler({
  resourceName: 'Route',
  table: 'routes r',
  idPrefix: 'rte',
  select: `r.id, r.code, r.name, r.mode, r.city, r.distance_km, r.base_fare, r.operator, r.active,
    (SELECT COUNT(*)::int FROM route_stops WHERE route_id = r.id) AS stop_count, r.created_at`,
  transform: toBool
}));

router.get('/routes/:id/stops', asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  if (!isValidId('rte', id)) {
    throw new ApiError(400, 'INVALID_ID', `Malformed "rte_" identifier: ${id}`);
  }
  const route = await db.get('SELECT id FROM routes WHERE id = ?', id);
  if (!route) {
    throw new ApiError(404, 'NOT_FOUND', 'Route not found');
  }
  return createListHandler({
    table: 'route_stops rs',
    select: 's.id, s.name, s.city, s.latitude, s.longitude, s.stop_type, s.zone, rs.stop_order, s.created_at',
    join: 'JOIN stops s ON s.id = rs.stop_id',
    orderFields: {
      stop_order: { column: 'rs.stop_order', type: 'number' },
      name: { column: 's.name', type: 'text' },
      city: { column: 's.city', type: 'text' },
      zone: { column: 's.zone', type: 'text' }
    },
    defaultOrderField: 'stop_order',
    defaultOrderDir: 'asc',
    idColumn: 's.id',
    baseWhere: { sql: 'rs.route_id = ?', params: [id] },
    filters: ROUTE_STOP_FILTERS
  })(req, res, next);
}));

router.get('/vehicles', createListHandler({
  table: 'vehicles v',
  select: 'v.id, v.registration, v.make, v.model, v.year, v.capacity, v.vehicle_type, v.status, v.route_id, r.code AS route_code, v.created_at',
  join: 'LEFT JOIN routes r ON r.id = v.route_id',
  orderFields: {
    registration: { column: 'v.registration', type: 'text' },
    make: { column: 'v.make', type: 'text' },
    year: { column: 'v.year', type: 'number' },
    capacity: { column: 'v.capacity', type: 'number' },
    created_at: { column: 'v.created_at', type: 'text' }
  },
  idColumn: 'v.id',
  filters: VEHICLE_FILTERS
}));

router.get('/vehicles/:id', createItemHandler({
  resourceName: 'Vehicle',
  table: 'vehicles v',
  idPrefix: 'veh',
  select: 'v.id, v.registration, v.make, v.model, v.year, v.capacity, v.vehicle_type, v.status, v.route_id, r.code AS route_code, v.created_at',
  join: 'LEFT JOIN routes r ON r.id = v.route_id',
  idColumn: 'v.id'
}));

router.get('/bookings', createListHandler({
  table: 'bookings b',
  select: BOOKING_SELECT,
  join: BOOKING_JOIN,
  orderFields: {
    reference: { column: 'b.reference', type: 'text' },
    passenger_name: { column: 'b.passenger_name', type: 'text' },
    fare: { column: 'b.fare', type: 'number' },
    seats: { column: 'b.seats', type: 'number' },
    travel_date: { column: 'b.travel_date', type: 'text' },
    status: { column: 'b.status', type: 'text' },
    created_at: { column: 'b.created_at', type: 'text' }
  },
  defaultOrderField: 'travel_date',
  defaultOrderDir: 'asc',
  idColumn: 'b.id',
  filters: BOOKING_FILTERS
}));

router.get('/bookings/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidId('bkg', id)) {
    throw new ApiError(400, 'INVALID_ID', `Malformed "bkg_" identifier: ${id}`);
  }
  const booking = await getBooking(id);
  if (!booking) {
    throw new ApiError(404, 'NOT_FOUND', 'Booking not found');
  }
  res.json({ data: booking });
}));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (value) => {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

const DATE_FIELD = z.string().refine(isDate, { message: 'must be a valid YYYY-MM-DD date' });

const POST_BOOKING_SCHEMA = z
  .object({
    passenger_name: z.string().min(1, 'is required').max(120),
    email: z.string().email('must be a valid email address'),
    route_id: z.string().min(1),
    from_stop_id: z.string().min(1),
    to_stop_id: z.string().min(1),
    seats: z.number().int().min(1).max(10).optional().default(1),
    status: z.enum(['confirmed', 'pending', 'cancelled']).optional().default('confirmed'),
    travel_date: DATE_FIELD
  })
  .strict()
  .refine((v) => v.from_stop_id !== v.to_stop_id, {
    message: 'from_stop_id and to_stop_id must be different stops',
    path: ['to_stop_id']
  });

const PATCH_BOOKING_SCHEMA = z
  .object({
    passenger_name: z.string().min(1).max(120),
    email: z.string().email('must be a valid email address'),
    seats: z.number().int().min(1).max(10),
    status: z.enum(['confirmed', 'pending', 'cancelled']),
    travel_date: DATE_FIELD
  })
  .strict()
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });

function requireRoute(id) {
  return db.get('SELECT id, base_fare FROM routes WHERE id = ?', id);
}

function requireRouteStop(routeId, stopId) {
  return db.get('SELECT stop_order FROM route_stops WHERE route_id = ? AND stop_id = ?', routeId, stopId);
}

function computeFare(routeBaseFare, seats) {
  return Math.round(routeBaseFare * seats * 100) / 100;
}

router.post('/bookings', asyncHandler(async (req, res) => {
  const body = validateBody(POST_BOOKING_SCHEMA, req.body ?? {});

  const route = await requireRoute(body.route_id);
  if (!route) {
    throw asApiError(`route_id "${body.route_id}" does not match any route`);
  }
  if (!(await requireRouteStop(body.route_id, body.from_stop_id))) {
    throw asApiError(`from_stop_id "${body.from_stop_id}" is not a stop on route "${body.route_id}"`);
  }
  if (!(await requireRouteStop(body.route_id, body.to_stop_id))) {
    throw asApiError(`to_stop_id "${body.to_stop_id}" is not a stop on route "${body.route_id}"`);
  }

  const seats = body.seats;
  const status = body.status;
  const fare = computeFare(route.base_fare, seats);
  const id = makeId('bkg');
  const reference = makeReference();

  await db.run(
    `INSERT INTO bookings (id, reference, passenger_name, email, route_id, from_stop_id, to_stop_id, seats, fare, status, travel_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, reference, body.passenger_name, body.email, body.route_id, body.from_stop_id, body.to_stop_id, seats, fare, status, body.travel_date, new Date().toISOString()
  );

  res.status(201).json({ data: await getBooking(id) });
}));

router.patch('/bookings/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidId('bkg', id)) {
    throw new ApiError(400, 'INVALID_ID', `Malformed "bkg_" identifier: ${id}`);
  }
  const existing = await getBooking(id);
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Booking not found');
  }
  const body = validateBody(PATCH_BOOKING_SCHEMA, req.body ?? {});

  const sets = [];
  const params = [];
  if ('passenger_name' in body) {
    sets.push('passenger_name = ?');
    params.push(body.passenger_name);
  }
  if ('email' in body) {
    sets.push('email = ?');
    params.push(body.email);
  }
  if ('status' in body) {
    sets.push('status = ?');
    params.push(body.status);
  }
  if ('travel_date' in body) {
    sets.push('travel_date = ?');
    params.push(body.travel_date);
  }
  if ('seats' in body) {
    const route = await requireRoute(existing.route_id);
    const fare = computeFare(route.base_fare, body.seats);
    sets.push('seats = ?', 'fare = ?');
    params.push(body.seats, fare);
  }

  params.push(id);
  await db.run(`UPDATE bookings SET ${sets.join(', ')} WHERE id = ?`, ...params);
  res.json({ data: await getBooking(id) });
}));

router.delete('/bookings/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidId('bkg', id)) {
    throw new ApiError(400, 'INVALID_ID', `Malformed "bkg_" identifier: ${id}`);
  }
  const info = await db.run('DELETE FROM bookings WHERE id = ?', id);
  if (info.changes === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Booking not found');
  }
  res.json({ data: { id, deleted: true } });
}));

const isUniqueViolation = (err) => err && err.code === '23505';

const POST_STOP_SCHEMA = z
  .object({
    name: z.string().min(1, 'is required').max(120),
    city: z.string().min(1, 'is required').max(80),
    latitude: z.number().min(-90).max(90, 'must be between -90 and 90'),
    longitude: z.number().min(-180).max(180, 'must be between -180 and 180'),
    stop_type: z.enum(['bus', 'tram', 'metro', 'rail']),
    zone: z.string().min(1, 'is required').max(20)
  })
  .strict();

const STOP_SELECT = 'id, name, city, latitude, longitude, stop_type, zone, created_at';

router.post('/stops', asyncHandler(async (req, res) => {
  const body = validateBody(POST_STOP_SCHEMA, req.body ?? {});
  const id = makeId('stp');
  try {
    await db.run(
      `INSERT INTO stops (id, name, city, latitude, longitude, stop_type, zone, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, body.name, body.city, body.latitude, body.longitude, body.stop_type, body.zone, new Date().toISOString()
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'CONFLICT', `Stop "${body.name}" already exists in "${body.city}"`);
    }
    throw err;
  }
  res.status(201).json({ data: await db.get(`SELECT ${STOP_SELECT} FROM stops WHERE id = ?`, id) });
}));

const POST_ROUTE_SCHEMA = z
  .object({
    code: z.string().min(1, 'is required').max(10),
    name: z.string().min(1, 'is required').max(120),
    mode: z.enum(['bus', 'tram', 'metro', 'rail']),
    city: z.string().min(1, 'is required').max(80),
    distance_km: z.number().positive('must be a positive number'),
    base_fare: z.number().nonnegative('must be a non-negative number'),
    operator: z.string().min(1, 'is required').max(80),
    active: z.boolean().optional().default(true)
  })
  .strict();

const ROUTE_SELECT = 'id, code, name, mode, city, distance_km, base_fare, operator, active, created_at';

router.post('/routes', asyncHandler(async (req, res) => {
  const body = validateBody(POST_ROUTE_SCHEMA, req.body ?? {});
  const id = makeId('rte');
  try {
    await db.run(
      `INSERT INTO routes (id, code, name, mode, city, distance_km, base_fare, operator, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, body.code, body.name, body.mode, body.city, body.distance_km, body.base_fare, body.operator, body.active ? 1 : 0, new Date().toISOString()
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'CONFLICT', `Route code "${body.code}" already exists`);
    }
    throw err;
  }
  res.status(201).json({ data: toBool(await db.get(`SELECT ${ROUTE_SELECT} FROM routes WHERE id = ?`, id)) });
}));

const POST_VEHICLE_SCHEMA = z
  .object({
    registration: z.string().min(1, 'is required').max(20),
    make: z.string().min(1, 'is required').max(80),
    model: z.string().min(1, 'is required').max(80),
    year: z.number().int('must be an integer').min(1900).max(new Date().getFullYear() + 1, `must be at most ${new Date().getFullYear() + 1}`),
    capacity: z.number().int('must be an integer').positive('must be a positive integer'),
    vehicle_type: z.enum(['bus', 'tram', 'metro', 'rail']),
    status: z.enum(['active', 'maintenance', 'retired']).optional().default('active'),
    route_id: z.string().min(1).nullable().optional()
  })
  .strict();

const VEHICLE_SELECT = 'v.id, v.registration, v.make, v.model, v.year, v.capacity, v.vehicle_type, v.status, v.route_id, r.code AS route_code, v.created_at';

router.post('/vehicles', asyncHandler(async (req, res) => {
  const body = validateBody(POST_VEHICLE_SCHEMA, req.body ?? {});
  if (body.route_id != null && !(await requireRoute(body.route_id))) {
    throw asApiError(`route_id "${body.route_id}" does not match any route`);
  }
  const id = makeId('veh');
  try {
    await db.run(
      `INSERT INTO vehicles (id, registration, make, model, year, capacity, vehicle_type, status, route_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, body.registration, body.make, body.model, body.year, body.capacity, body.vehicle_type, body.status, body.route_id ?? null, new Date().toISOString()
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'CONFLICT', `Vehicle registration "${body.registration}" already exists`);
    }
    throw err;
  }
  res.status(201).json({
    data: await db.get(`SELECT ${VEHICLE_SELECT} FROM vehicles v LEFT JOIN routes r ON r.id = v.route_id WHERE v.id = ?`, id)
  });
}));

router.use('/stops/:id', methodNotAllowedHandler(['GET']));
router.use('/routes/:id', methodNotAllowedHandler(['GET']));
router.use('/routes/:id/stops', methodNotAllowedHandler(['GET']));
router.use('/vehicles/:id', methodNotAllowedHandler(['GET']));
router.use('/bookings/:id', methodNotAllowedHandler(['GET', 'PATCH', 'DELETE']));

export default router;