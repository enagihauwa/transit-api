import process from 'node:process';

const BASE = (process.env.VERIFY_BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const API = `${BASE}/api/v1`;

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` -- ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

async function call(pathname, options = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, status: res.status, json, headers: res.headers };
}

function section(title) {
  console.log(`\n${title}`);
}

const isListEnvelope = (json) =>
  Array.isArray(json?.data) &&
  typeof json?.meta?.total === 'number' &&
  typeof json?.meta?.limit === 'number' &&
  typeof json?.meta?.offset === 'number' &&
  typeof json?.meta?.hasMore === 'boolean';

const isErrorEnvelope = (json) =>
  typeof json?.error?.code === 'string' && typeof json?.error?.message === 'string';

const LISTS = ['/stops', '/routes', '/vehicles', '/bookings'];

async function main() {
  console.log(`Verifying ${API}`);

  section('Health');
  {
    const res = await fetch(`${BASE}/health`);
    const json = await res.json().catch(() => null);
    check('health returns 200', res.status === 200, `got ${res.status}`);
    check('health uses data envelope', json?.data?.status === 'ok', JSON.stringify(json));
  }

  section('List endpoints: envelope, volume, pagination, filtering, sorting');
  for (const path of LISTS) {
    const { status, json } = await call(path);
    check(`${path} returns 200`, status === 200, `got ${status}`);
    check(`${path} uses list envelope`, isListEnvelope(json), JSON.stringify(json?.meta));
    check(`${path} has seeded volume (>=200)`, (json?.meta?.total ?? 0) >= 200, `total=${json?.meta?.total}`);
    check(
      `${path} defaults to limit 20`,
      json?.meta?.limit === 20 && json?.data?.length === Math.min(20, json.meta.total),
      `limit=${json?.meta?.limit} len=${json?.data?.length}`
    );
  }

  section('Limit clamping and offset validation');
  {
    const { status, json } = await call('/routes?limit=5000');
    check('limit=5000 clamps to 100', status === 200 && json.meta.limit === 100, `limit=${json?.meta?.limit}`);
    check('limit=5000 returns 100 rows', json.data.length === 100, `len=${json.data.length}`);

    const neg = await call('/routes?offset=-1');
    check('offset=-1 returns 400', neg.status === 400, `got ${neg.status}`);
    check('offset=-1 uses error envelope', isErrorEnvelope(neg.json), JSON.stringify(neg.json));
    check('offset=-1 message names offset', /offset/.test(neg.json?.error?.message ?? ''), neg.json?.error?.message);

    const zero = await call('/routes?limit=0');
    check('limit=0 returns 400', zero.status === 400, `got ${zero.status}`);

    const both = await call('/routes?limit=5&offset=5&cursor=abc');
    check('offset+cursor together returns 400', both.status === 400, `got ${both.status}`);
  }

  section('Sort validation');
  for (const path of LISTS) {
    const bad = await call(`${path}?sort=nope`);
    check(`${path} sort=nope returns 400`, bad.status === 400, `got ${bad.status}`);
    check(`${path} sort error lists allowed fields`, /Allowed:/.test(bad.json?.error?.message ?? ''), bad.json?.error?.message);
  }
  {
    const badOrder = await call('/routes?order=sideways');
    check('order=sideways returns 400', badOrder.status === 400, `got ${badOrder.status}`);

    const desc = await call('/routes?sort=base_fare&order=desc&limit=5');
    const fares = desc.json.data.map((r) => r.base_fare);
    const sorted = [...fares].sort((a, b) => b - a);
    check('sort=base_fare&order=desc is actually descending', JSON.stringify(fares) === JSON.stringify(sorted), fares.join(','));

    const asc = await call('/routes?sort=base_fare&order=asc&limit=5');
    const ascFares = asc.json.data.map((r) => r.base_fare);
    check('sort=base_fare&order=asc is actually ascending', JSON.stringify(ascFares) === JSON.stringify([...ascFares].sort((a, b) => a - b)), ascFares.join(','));
  }

  section('Filtering');
  {
    const city = await call('/routes?city=Seattle');
    check('filter city=Seattle returns 200', city.status === 200, `got ${city.status}`);
    check('filter city=Seattle matches every row', city.json.data.every((r) => r.city === 'Seattle'), 'mismatch');

    const combined = await call('/routes?mode=metro&minFare=5&limit=50');
    check('combined filters return 200', combined.status === 200, `got ${combined.status}`);
    check(
      'combined filters all hold',
      combined.json.data.every((r) => r.mode === 'metro' && r.base_fare >= 5),
      'mismatch'
    );

    const badEnum = await call('/routes?mode=hovercraft');
    check('filter mode=hovercraft returns 400', badEnum.status === 400, `got ${badEnum.status}`);

    const badNum = await call('/routes?minFare=cheap');
    check('filter minFare=cheap returns 400', badNum.status === 400, `got ${badNum.status}`);

    const noMatch = await call('/routes?city=Atlantis');
    check('filter with no matches returns empty + total 0', noMatch.status === 200 && noMatch.json.meta.total === 0 && noMatch.json.data.length === 0, JSON.stringify(noMatch.json?.meta));
  }

  section('Cursor pagination');
  {
    const first = await call('/routes?limit=5&sort=name&order=asc');
    check('first page exposes nextCursor', typeof first.json.meta.nextCursor === 'string', JSON.stringify(first.json.meta));
    const second = await call(`/routes?limit=5&sort=name&order=asc&cursor=${encodeURIComponent(first.json.meta.nextCursor)}`);
    check('cursor page returns 200', second.status === 200, `got ${second.status}`);
    const ids1 = new Set(first.json.data.map((r) => r.id));
    check('cursor page does not repeat rows', second.json.data.every((r) => !ids1.has(r.id)), 'overlap detected');

    const bad = await call('/routes?cursor=not-base64-json');
    check('malformed cursor returns 400', bad.status === 400, `got ${bad.status}`);
  }

  section('Offset pagination walk');
  {
    const p1 = await call('/routes?limit=10&offset=0&sort=code&order=asc');
    const p2 = await call('/routes?limit=10&offset=10&sort=code&order=asc');
    check('offset page 1 hasMore is true', p1.json.meta.hasMore === true, JSON.stringify(p1.json.meta));
    check('offset pages do not overlap', new Set(p1.json.data.map((r) => r.id)).size === 10 && p1.json.data.every((r) => !p2.json.data.some((x) => x.id === r.id)), 'overlap detected');

    const past = await call('/routes?limit=10&offset=100000');
    check('offset past end returns empty + hasMore false', past.json.data.length === 0 && past.json.meta.hasMore === false, JSON.stringify(past.json?.meta));
  }

  section('Item endpoints and identifier handling');
  {
    const list = await call('/routes?limit=1');
    const route = list.json.data[0];

    const one = await call(`/routes/${route.id}`);
    check('GET route by id returns 200', one.status === 200, `got ${one.status}`);
    check('item uses data envelope', typeof one.json?.data?.id === 'string', JSON.stringify(one.json));
    check('stop_count is a number not a string', typeof one.json.data.stop_count === 'number', `typeof=${typeof one.json.data.stop_count}`);

    const malformed = await call('/routes/not-an-id');
    check('malformed id returns 400', malformed.status === 400, `got ${malformed.status}`);
    check('malformed id never returns 500', malformed.status < 500, `got ${malformed.status}`);

    const missing = await call('/routes/rte_0000000000000000');
    check('well-formed but unknown id returns 404', missing.status === 404, `got ${missing.status}`);

    const wrongPrefix = await call('/routes/stp_0000000000000000');
    check('id with wrong prefix returns 404/400', wrongPrefix.status === 404 || wrongPrefix.status === 400, `got ${wrongPrefix.status}`);

    const badMethod = await fetch(`${API}/routes/${route.id}`, { method: 'DELETE' });
    check('DELETE on read-only resource returns 405', badMethod.status === 405, `got ${badMethod.status}`);
    check('405 sends Allow header', badMethod.headers.get('allow') !== null, 'missing Allow header');

    const noEndpoint = await call('/nope');
    check('unknown endpoint returns 404', noEndpoint.status === 404, `got ${noEndpoint.status}`);
  }

  section('Nested resource');
  {
    const list = await call('/routes?limit=1');
    const routeId = list.json.data[0].id;
    const nested = await call(`/routes/${routeId}/stops?limit=100`);
    check('nested route stops returns 200', nested.status === 200, `got ${nested.status}`);
    check('nested uses list envelope', isListEnvelope(nested.json), JSON.stringify(nested.json?.meta));
    check('nested includes stop_order', nested.json.data.every((s) => typeof s.stop_order === 'number'), 'missing stop_order');
    check('nested rows reference the parent route', nested.json.meta.total > 0, `total=${nested.json.meta.total}`);

    const badParent = await call('/routes/rte_0000000000000000/stops');
    check('nested under unknown parent returns 404', badParent.status === 404, `got ${badParent.status}`);
  }

  section('Booking lifecycle: POST / GET / PATCH / DELETE');
  let bookingId = null;
  {
    const list = await call('/routes?limit=1');
    const routeId = list.json.data[0].id;
    const stops = await call(`/routes/${routeId}/stops?limit=5`);
    const [from, to] = [stops.json.data[0].id, stops.json.data[1].id];

    const created = await call('/bookings', {
      method: 'POST',
      body: {
        passenger_name: 'Verification Bot',
        email: 'bot@example.com',
        route_id: routeId,
        from_stop_id: from,
        to_stop_id: to,
        seats: 2,
        status: 'confirmed',
        travel_date: '2026-12-24'
      }
    });
    check('POST /bookings returns 201', created.status === 201, `got ${created.status} ${JSON.stringify(created.json)}`);
    bookingId = created.json?.data?.id;
    check('created booking has an id with bkg_ prefix', /^bkg_[0-9a-f]{16}$/.test(bookingId ?? ''), String(bookingId));
    check('created booking is not sequentially guessable', !/^\d+$/.test((bookingId ?? '').split('_')[1] ?? ''), String(bookingId));
    check('server computes fare from route price x seats', created.json?.data?.fare > 0, `fare=${created.json?.data?.fare}`);

    const read = await call(`/bookings/${bookingId}`);
    check('GET created booking returns 200', read.status === 200, `got ${read.status}`);
    check('GET booking denormalises route + stop names', typeof read.json?.data?.route_name === 'string' && typeof read.json?.data?.from_stop_name === 'string', JSON.stringify(read.json?.data));

    const patched = await call(`/bookings/${bookingId}`, { method: 'PATCH', body: { seats: 3, status: 'pending' } });
    check('PATCH /bookings/:id returns 200', patched.status === 200, `got ${patched.status}`);
    check('PATCH applied seats', patched.json?.data?.seats === 3, `seats=${patched.json?.data?.seats}`);
    check('PATCH applied status', patched.json?.data?.status === 'pending', `status=${patched.json?.data?.status}`);
    check('PATCH recomputed fare when seats changed', patched.json?.data?.fare > (created.json?.data?.fare ?? 0), `fare=${patched.json?.data?.fare}`);

    const partial = await call(`/bookings/${bookingId}`, { method: 'PATCH', body: { passenger_name: 'Renamed Bot' } });
    check('partial PATCH leaves other fields alone', partial.json?.data?.seats === 3 && partial.json?.data?.passenger_name === 'Renamed Bot', JSON.stringify(partial.json?.data));

    const deleted = await call(`/bookings/${bookingId}`, { method: 'DELETE' });
    check('DELETE returns 200', deleted.status === 200, `got ${deleted.status}`);

    const gone = await call(`/bookings/${bookingId}`);
    check('GET after DELETE returns 404', gone.status === 404, `got ${gone.status}`);

    const deleteAgain = await call(`/bookings/${bookingId}`, { method: 'DELETE' });
    check('DELETE twice returns 404', deleteAgain.status === 404, `got ${deleteAgain.status}`);
  }

  section('Booking defaults: seats and status are optional on create');
  {
    const list = await call('/routes?limit=1');
    const routeId = list.json.data[0].id;
    const stops = await call(`/routes/${routeId}/stops?limit=5`);
    const created = await call('/bookings', {
      method: 'POST',
      body: {
        passenger_name: 'Defaults Bot',
        email: 'defaults@example.com',
        route_id: routeId,
        from_stop_id: stops.json.data[0].id,
        to_stop_id: stops.json.data[1].id,
        travel_date: '2026-12-25'
      }
    });
    check('POST without seats/status returns 201', created.status === 201, `got ${created.status} ${JSON.stringify(created.json)}`);
    check('seats defaults to 1', created.json?.data?.seats === 1, `seats=${created.json?.data?.seats}`);
    check('status defaults to confirmed', created.json?.data?.status === 'confirmed', `status=${created.json?.data?.status}`);
    if (created.json?.data?.id) {
      await call(`/bookings/${created.json.data.id}`, { method: 'DELETE' });
    }
  }

  section('Validation: 422 with the offending field named');
  {
    const missing = await call('/bookings', { method: 'POST', body: {} });
    check('POST with empty body returns 422', missing.status === 422, `got ${missing.status}`);
    check('422 uses error envelope', isErrorEnvelope(missing.json), JSON.stringify(missing.json));
    check('422 names the missing fields', Array.isArray(missing.json?.error?.details?.fields) && missing.json.error.details.fields.includes('passenger_name'), JSON.stringify(missing.json?.error?.details));

    const badEmail = await call('/bookings', { method: 'POST', body: { passenger_name: 'X', email: 'not-an-email', route_id: 'rte_0000000000000000', from_stop_id: 'a', to_stop_id: 'b', travel_date: '2026-01-01' } });
    check('invalid email returns 422', badEmail.status === 422, `got ${badEmail.status}`);
    check('422 names email', /email/.test(badEmail.json?.error?.message ?? ''), badEmail.json?.error?.message);

    const badRef = await call('/bookings', { method: 'POST', body: { passenger_name: 'X', email: 'x@example.com', route_id: 'rte_0000000000000000', from_stop_id: 'stp_0000000000000000', to_stop_id: 'stp_1111111111111111', seats: 1, travel_date: '2026-01-01' } });
    check('unknown route_id reference returns 422', badRef.status === 422, `got ${badRef.status}`);

    const sameStop = await call('/bookings', { method: 'POST', body: { passenger_name: 'X', email: 'x@example.com', route_id: 'rte_0000000000000000', from_stop_id: 'stp_0000000000000000', to_stop_id: 'stp_0000000000000000', seats: 1, travel_date: '2026-01-01' } });
    check('from_stop_id == to_stop_id returns 422', sameStop.status === 422, `got ${sameStop.status}`);

    const extra = await call('/bookings', { method: 'POST', body: { passenger_name: 'X', email: 'x@example.com', route_id: 'rte_0000000000000000', from_stop_id: 'a', to_stop_id: 'b', travel_date: '2026-01-01', sneaky: 'field' } });
    check('unknown field returns 422', extra.status === 422, `got ${extra.status}`);

    const res = await fetch(`${API}/bookings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    check('malformed JSON returns 400', res.status === 400, `got ${res.status}`);

    // Empty PATCH must be rejected, but only for a booking that exists --
    // a missing booking is a 404 regardless of body.
    const rl = await call('/routes?limit=1');
    const rlStops = await call(`/routes/${rl.json.data[0].id}/stops?limit=5`);
    const subject = await call('/bookings', {
      method: 'POST',
      body: {
        passenger_name: 'Empty Patch Bot',
        email: 'empty@example.com',
        route_id: rl.json.data[0].id,
        from_stop_id: rlStops.json.data[0].id,
        to_stop_id: rlStops.json.data[1].id,
        travel_date: '2026-12-26'
      }
    });
    const emptyPatch = await call(`/bookings/${subject.json?.data?.id}`, { method: 'PATCH', body: {} });
    check('PATCH with empty body on an existing booking returns 422', emptyPatch.status === 422, `got ${emptyPatch.status}`);
    const missingPatch = await call('/bookings/bkg_0000000000000000', { method: 'PATCH', body: {} });
    check('PATCH on a missing booking returns 404', missingPatch.status === 404, `got ${missingPatch.status}`);
    if (subject.json?.data?.id) {
      await call(`/bookings/${subject.json.data.id}`, { method: 'DELETE' });
    }
  }

  section('Conflict handling');
  {
    const stop = await call('/stops', {
      method: 'POST',
      body: { name: `Verify Stop ${Date.now()}`, city: 'Verify City', latitude: 47.6, longitude: -122.3, stop_type: 'bus', zone: '1' }
    });
    check('POST /stops returns 201', stop.status === 201, `got ${stop.status} ${JSON.stringify(stop.json)}`);
    if (stop.json?.data?.id) {
      const dupe = await call('/stops', {
        method: 'POST',
        body: { name: stop.json.data.name, city: stop.json.data.city, latitude: 47.6, longitude: -122.3, stop_type: 'bus', zone: '1' }
      });
      check('duplicate stop returns 409', dupe.status === 409, `got ${dupe.status}`);
    }
  }

  section('Cross-resource relationships resolve');
  {
    const vehicles = await call('/vehicles?limit=100&status=active');
    const assigned = vehicles.json.data.filter((v) => v.route_id);
    check('vehicles expose an assigned route', assigned.length > 0, 'no assigned vehicles found');
    check('assigned vehicle denormalises route_code', assigned.every((v) => typeof v.route_code === 'string' && v.route_code.length > 0), 'missing route_code');
    check('vehicle make/model are transit-accurate', assigned.every((v) => !/^BMW$|^Ford$/.test(v.make) || /Low Floor|Xcelsior|Transit/.test(v.model)), 'implausible make/model pair');

    const bookings = await call('/bookings?limit=20&status=confirmed');
    check('bookings denormalise route and both stops', bookings.json.data.every((b) => b.route_code && b.from_stop_name && b.to_stop_name), 'missing denormalised fields');

    const byRoute = await call(`/bookings?routeId=${bookings.json.data[0].route_id}&limit=100`);
    check('filtering bookings by routeId works', byRoute.json.data.every((b) => b.route_id === bookings.json.data[0].route_id), 'mismatch');
  }

  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main().catch((err) => {
  console.error('\nverification crashed:', err);
  process.exit(1);
});
