# Transit API

A public REST API for a fictional transit market — stops, routes, vehicles, and bookings — plus a small
consumer app that calls it. No authentication is required for any endpoint; the API is the product.

- **Status:** running locally only (`http://localhost:8080`) — not yet deployed to a public host.
- **Health check:** `GET /health`

## Contents

- [Resource design](#resource-design)
- [Seed data](#seed-data)
- [Endpoints](#endpoints)
- [Pagination, filtering, sorting](#pagination-filtering-sorting)
- [Envelopes and status codes](#envelopes-and-status-codes)
- [Rate limiting](#rate-limiting)
- [Design decisions](#design-decisions)
- [Local development](#local-development)
- [Deployment](#deployment)
- [Consumer app](#consumer-app)

## Resource design

Four resources, related as: a **route** has many **stops** (ordered, many-to-many via `route_stops`); a
**vehicle** optionally belongs to one **route**; a **booking** belongs to one **route** and references two
**stops** (`from` and `to`).

```
stops ──┬──< route_stops >──┬── routes ──< vehicles
        │                   │
        └────< bookings >───┘   (booking.from_stop_id / to_stop_id also point at stops)
```

### stops

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | generated | `stp_` + 16 hex chars |
| `name` | string | yes | e.g. street intersection or station name |
| `city` | string | yes | |
| `latitude` | number | yes | -90..90 |
| `longitude` | number | yes | -180..180 |
| `stop_type` | enum | yes | `bus` \| `tram` \| `metro` \| `rail` |
| `zone` | string | yes | fare zone, e.g. `"1"` |
| `created_at` | string (ISO 8601) | server-set | |

Unique on `(name, city)`.

### routes

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | generated | `rte_` + 16 hex chars |
| `code` | string | yes | unique, e.g. `G776` |
| `name` | string | yes | |
| `mode` | enum | yes | `bus` \| `tram` \| `metro` \| `rail` |
| `city` | string | yes | |
| `distance_km` | number | yes | positive |
| `base_fare` | number | yes | non-negative; multiplied by `seats` on booking |
| `operator` | string | yes | |
| `active` | boolean | no (default `true`) | |
| `created_at` | string (ISO 8601) | server-set | |

`GET /routes` and `GET /routes/:id` also return `stop_count`, computed from `route_stops`.

### route_stops (join table, no direct endpoint)

| Field | Type | Notes |
|---|---|---|
| `route_id` | string | FK → routes.id |
| `stop_id` | string | FK → stops.id |
| `stop_order` | integer | position of the stop along the route |

Exposed via the nested `GET /routes/:id/stops`.

### vehicles

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | generated | `veh_` + 16 hex chars |
| `registration` | string | yes | unique |
| `make` | string | yes | |
| `model` | string | yes | |
| `year` | integer | yes | 1900..next year |
| `capacity` | integer | yes | positive |
| `vehicle_type` | enum | yes | `bus` \| `tram` \| `metro` \| `rail` |
| `status` | enum | no (default `active`) | `active` \| `maintenance` \| `retired` |
| `route_id` | string \| null | no | FK → routes.id; a vehicle may be unassigned |
| `created_at` | string (ISO 8601) | server-set | |

### bookings

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | generated | `bkg_` + 16 hex chars |
| `reference` | string | generated | unique, e.g. `TVT-4CZ3H1` |
| `passenger_name` | string | yes | |
| `email` | string | yes | valid email |
| `route_id` | string | yes | FK → routes.id |
| `from_stop_id` | string | yes | FK → stops.id, must be on `route_id` |
| `to_stop_id` | string | yes | FK → stops.id, must be on `route_id`, must differ from `from_stop_id` |
| `seats` | integer | no (default `1`) | 1..10 |
| `fare` | number | server-computed | `route.base_fare * seats` |
| `status` | enum | no (default `confirmed`) | `confirmed` \| `pending` \| `cancelled` |
| `travel_date` | string (`YYYY-MM-DD`) | yes | |
| `created_at` | string (ISO 8601) | server-set | |

Every identifier is a random, prefixed, non-sequential token (e.g. `rte_4d7113fc1c609843`), not a sequential
integer — see [Design decisions](#design-decisions).

## Seed data

`src/seed.js` generates realistic records with [`@faker-js/faker`](https://www.npmjs.com/package/@faker-js/faker),
seeded deterministically (`SEED_VALUE` in `.env`) so the same run always produces the same dataset. It:

- picks stops and route names from 10 real cities with real-ish coordinates,
- pairs each vehicle type with actual transit rolling stock (`Alstom Citadis`, `New Flyer Xcelsior`, …) instead
  of faker's car-brand defaults, which would be nonsense for a 190-seat metro,
- links routes to stops (6–16 stops per route, ordered), vehicles to routes in the same city/mode, and bookings
  to a route plus two of its stops,
- inserts with `ON CONFLICT DO NOTHING` against a content-derived id (`seedId`), so **running the seed twice
  never duplicates data**.

Default volumes: 300 stops, 300 routes, 300 vehicles, 800 bookings (configurable via `SEED_*` env vars).

```bash
npm run seed        # idempotent: safe to re-run
npm run seed:reset   # wipes all tables first, then reseeds
```

The server also auto-seeds an empty database on boot (`ensureSeeded()` in `src/server.js`), which is what makes
a fresh deploy usable immediately without a manual step. Set `SEED_SKIP_AT_BOOT=true` to disable that.

## Endpoints

Base path: `/api/v1`. All request/response bodies are JSON.

### Stops

**`GET /api/v1/stops`** — list, paginated/filterable/sortable.

```bash
curl "https://<host>/api/v1/stops?city=Seattle&stopType=bus&limit=2"
```

```json
{
  "data": [
    { "id": "stp_5b06b5a4ea28a3cb", "name": "16th Street & Frederic Way", "city": "Portland",
      "latitude": 45.5111, "longitude": -122.6966, "stop_type": "bus", "zone": "1",
      "created_at": "2026-04-08T05:25:46.818Z" }
  ],
  "meta": { "total": 301, "limit": 2, "offset": 0, "hasMore": true, "nextCursor": "eyJ..." }
}
```

Filters: `city` (exact), `stopType` (enum), `zone` (exact), `name` (substring). Sort fields: `name`, `city`,
`zone`, `latitude`, `longitude`, `created_at` (default `name` asc).

**`GET /api/v1/stops/:id`** — one stop, or `404` if unknown, `400` if `:id` isn't a well-formed `stp_...` id.

**`POST /api/v1/stops`** — create a stop.

```bash
curl -X POST "https://<host>/api/v1/stops" \
  -H "Content-Type: application/json" \
  -d '{"name":"5th Ave & Pine St","city":"Seattle","latitude":47.611,"longitude":-122.337,"stop_type":"bus","zone":"1"}'
```

Returns `201` with the created stop, `422` with the offending field(s) named if validation fails, or `409` if
`(name, city)` already exists.

### Routes

**`GET /api/v1/routes`**

```bash
curl "https://<host>/api/v1/routes?mode=metro&minFare=5&sort=base_fare&order=desc&limit=5"
```

```json
{
  "data": [
    { "id": "rte_4d7113fc1c609843", "code": "G776", "name": "Hazle Valley to Quigley Ramp", "mode": "bus",
      "city": "Boston", "distance_km": 41.9, "base_fare": 22.21, "operator": "CityLink Transit",
      "active": true, "stop_count": 6, "created_at": "2026-05-31T08:31:40.895Z" }
  ],
  "meta": { "total": 300, "limit": 5, "offset": 0, "hasMore": true, "nextCursor": "eyJ..." }
}
```

Filters: `city`, `mode` (enum), `active` (`true`/`false`), `minFare`, `maxFare`. Sort fields: `code`, `name`,
`city`, `operator`, `distance_km`, `base_fare`, `created_at` (default `base_fare` asc).

**`GET /api/v1/routes/:id`** — one route (with `stop_count`), `404` if unknown.

**`GET /api/v1/routes/:id/stops`** — nested resource: the stops on this route, in order.

```bash
curl "https://<host>/api/v1/routes/rte_4d7113fc1c609843/stops?limit=2"
```

```json
{
  "data": [
    { "id": "stp_9aed6d0e84b59a08", "name": "Cole Land & Corwin Green", "city": "Boston",
      "latitude": 42.3354, "longitude": -71.0667, "stop_type": "rail", "zone": "1",
      "stop_order": 0, "created_at": "2025-10-30T11:39:22.875Z" }
  ],
  "meta": { "total": 6, "limit": 2, "offset": 0, "hasMore": true, "nextCursor": "eyJ..." }
}
```

`404` if the parent route doesn't exist. Filters: `stopType`, `zone`, `name`. Sort fields: `stop_order`
(default), `name`, `city`, `zone`.

**`POST /api/v1/routes`** — create a route. `201` on success, `422` on validation failure naming the field,
`409` if `code` already exists.

### Vehicles

**`GET /api/v1/vehicles`**

```bash
curl "https://<host>/api/v1/vehicles?status=active&vehicleType=metro&sort=capacity&order=desc"
```

Response rows denormalise `route_code` (the assigned route's code, or `null`). Filters: `status` (enum),
`vehicleType` (enum), `routeId` (exact). Sort fields: `registration`, `make`, `year`, `capacity`, `created_at`
(default `created_at` desc).

**`GET /api/v1/vehicles/:id`** — one vehicle, `404` if unknown.

**`POST /api/v1/vehicles`** — create a vehicle. `route_id` is optional but, if given, must reference an
existing route (`422 INVALID_REFERENCE` if not). `409` if `registration` already exists.

### Bookings

**`GET /api/v1/bookings`**

```bash
curl "https://<host>/api/v1/bookings?status=confirmed&travelDate=2026-11-15&sort=fare&order=desc"
```

```json
{
  "data": [
    { "id": "bkg_15dedd0cb442207a", "reference": "TVT-4CZ3H1", "passenger_name": "Guillermo Erdman",
      "email": "Guillermo.Erdman2@gmail.com", "route_id": "rte_20f45ac5591d2d15", "route_code": "T534",
      "route_name": "Skiles-Strosin Track to Hill Road", "route_mode": "metro",
      "from_stop_id": "stp_7a6dd05387c0f76f", "from_stop_name": "E Maple Street Transit Hub",
      "to_stop_id": "stp_1a76932a30b3fd2a", "to_stop_name": "Rodriguez Manors & Prospect Avenue",
      "seats": 1, "fare": 4.78, "status": "cancelled", "travel_date": "2026-09-26",
      "created_at": "2026-08-27T15:51:30.851Z" }
  ],
  "meta": { "total": 800, "limit": 1, "offset": 0, "hasMore": true, "nextCursor": "eyJ..." }
}
```

Rows denormalise route and stop names so a consumer never has to join client-side. Filters: `status` (enum),
`routeId`, `fromStopId`, `toStopId`, `travelDate` (exact `YYYY-MM-DD`), `minFare`, `maxFare`, `passenger`
(substring). Sort fields: `reference`, `passenger_name`, `fare`, `seats`, `travel_date`, `status`,
`created_at` (default `travel_date` asc).

**`GET /api/v1/bookings/:id`** — one booking, `404` if unknown.

**`POST /api/v1/bookings`** — create a booking. The server looks up the route's `base_fare` and computes
`fare = base_fare * seats`; it does not trust a client-supplied fare (there isn't one).

```bash
curl -X POST "https://<host>/api/v1/bookings" \
  -H "Content-Type: application/json" \
  -d '{"passenger_name":"Maya Lindholm","email":"maya@example.com","route_id":"rte_4d7113fc1c609843","from_stop_id":"stp_9aed6d0e84b59a08","to_stop_id":"stp_0fa4d289561a49f7","seats":2,"travel_date":"2026-11-15"}'
```

`201` with the created booking. `422 VALIDATION_ERROR` with `error.details.fields` naming every offending
field, e.g. requesting with an empty body:

```bash
curl -X POST "https://<host>/api/v1/bookings" -H "Content-Type: application/json" -d '{}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed: passenger_name: is required; email: is required; route_id: is required; from_stop_id: is required; to_stop_id: is required; travel_date: is required",
    "details": { "fields": ["passenger_name", "email", "route_id", "from_stop_id", "to_stop_id", "travel_date"] }
  }
}
```

`422 INVALID_REFERENCE` if `route_id`, `from_stop_id`, or `to_stop_id` don't resolve, or `from_stop_id` isn't
actually on `route_id`.

**`PATCH /api/v1/bookings/:id`** — partial update (`passenger_name`, `email`, `seats`, `status`,
`travel_date`; at least one required). Changing `seats` recomputes `fare`. `404` if the booking doesn't exist,
`422` if the body is empty or invalid.

```bash
curl -X PATCH "https://<host>/api/v1/bookings/bkg_15dedd0cb442207a" \
  -H "Content-Type: application/json" -d '{"seats":3,"status":"pending"}'
```

**`DELETE /api/v1/bookings/:id`** — `200` with `{"data":{"id":"...","deleted":true}}`, `404` if already
deleted or never existed.

### Everything else

- `GET /health` → `200 {"data":{"status":"ok","version":"v1","time":"..."}}`, outside `/api/v1` so it's
  never rate-limited or versioned.
- Unknown routes → `404 NOT_FOUND`.
- A disallowed method on a real, read-mostly path (e.g. `DELETE /routes/:id`) → `405 METHOD_NOT_ALLOWED` with
  an `Allow` header — never a `500`.

## Pagination, filtering, sorting

Every list endpoint supports both:

- **Offset paging** — `?limit=20&offset=40`. `limit` defaults to 20, clamps silently to 100 (it is *not*
  honoured above that — `?limit=5000` comes back as 100 rows), `offset` must be a non-negative integer or the
  request is rejected with `400`.
- **Cursor paging** — `?limit=20&cursor=<opaque>`. `meta.nextCursor` (present whenever `meta.hasMore` is
  true) is a base64url-encoded `{sortValue, id}` keyset pair, stable under concurrent inserts because it never
  re-derives a position from a row count. `offset` and `cursor` may not be combined (`400`).

`sort=<field>&order=asc|desc` — `sort` must be one of the field's documented sort fields or the request is
rejected with `400 INVALID_SORT` naming the allowed set; an invalid `order` is `400` too. Nothing ever falls
back to silently sorting by nothing.

Every list endpoint also takes at least two resource-specific filters (see each resource above); an unknown
enum value or a non-numeric value passed to a numeric filter is `400`, not silently ignored.

## Envelopes and status codes

Every successful list response:

```json
{ "data": [ /* rows */ ], "meta": { "total": 0, "limit": 20, "offset": 0, "hasMore": false } }
```

Every successful item response: `{ "data": { /* the object */ } }`.

Every error, at every endpoint:

```json
{ "error": { "code": "SOME_CODE", "message": "human-readable explanation" } }
```

Status codes used, and what they mean here: `200` read/update/delete ok, `201` created, `400` malformed
request (bad id, bad query param, malformed JSON, bad pagination), `404` no such resource, `405` real path,
wrong method, `409` unique-constraint conflict, `422` body failed schema validation or references a resource
that doesn't exist, `429` rate limited, `500` unexpected server error (never used to mask a client mistake —
every code path above is deliberately caught first).

## Rate limiting

Unauthenticated public APIs get scraped or abused quickly, so every `/api/v1/*` request is rate-limited per
IP: **100 requests / 60 seconds** by default. Both numbers live in `config.js` / the `RATE_LIMIT_*` env vars,
not hardcoded in the handler. Exceeding the limit returns:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 37
```

```json
{ "error": { "code": "RATE_LIMITED", "message": "Too many requests. Retry after 37 second(s)." } }
```

`/health` is intentionally outside the limiter so uptime checks never get throttled.

## Design decisions

Short version, resource-by-resource facts are documented inline above (identifiers, envelope shape, filters,
sort fields). For the fuller reasoning behind one specific choice — what happens when a caller asks for 5000
records in one request, and why — see [ANSWERS.md](ANSWERS.md).

- **Resources:** stops/routes/vehicles/bookings mirror a real transit operator's relationships (ordered
  route↔stop many-to-many, optional vehicle→route, booking→route + two stops).
- **Identifiers:** random `<prefix>_<16 hex>` tokens, not sequential integers, so the dataset can't be
  enumerated by counting, and a malformed id fails a cheap regex check before ever reaching the database.
- **Pagination:** both offset (`?limit&offset`) and cursor (`?limit&cursor`) are supported; `limit` clamps to
  100 rather than erroring — see [ANSWERS.md](ANSWERS.md) for why.
- **Envelope:** `{"data","meta"}` on success, `{"error":{"code","message"}}` on failure, identical everywhere.
- **Versioning:** `/api/v1/` from the first commit, so a `/v2/` can exist later without breaking `/v1/`
  clients.

## Local development

Requires Node ≥ 22 and a Postgres instance.

```bash
npm install
cp .env.example .env         # edit DATABASE_URL if not using the default local Postgres
npm run seed                 # idempotent — safe to re-run
npm run dev                  # http://localhost:8080
```

`npm test` (`scripts/verify.mjs`) runs an end-to-end black-box check against a running server — envelopes,
pagination, filtering, sorting, every documented status code, and the full booking create/read/update/delete
lifecycle. Point it at any base URL:

```bash
VERIFY_BASE_URL=http://localhost:8080 npm test
VERIFY_BASE_URL=https://<your-deployed-host> npm test
```

Postman and Insomnia collections/environments are checked in under `postman/` and `insomnia/` for manual
exploration.

## Deployment

This project currently runs locally only; it has not been deployed to a public host. The steps below are
what deploying would take, for reference:

1. Provision a managed Postgres instance (Railway, Render, Neon, Supabase — any of them).
2. Deploy this repo (Railway, Render, or Fly all work with zero config beyond `npm start`).
3. Set environment variables from `.env.example` on the host — at minimum `DATABASE_URL` (with
   `DATABASE_SSL=true` for a managed Postgres that requires TLS) and `NODE_ENV=production`.
4. The server creates its schema and seeds an empty database automatically on first boot
   (`initSchema()` + `ensureSeeded()` in `src/server.js`) — no manual migration step needed. To reseed
   deliberately later: `DATABASE_URL=<prod-url> npm run seed:reset` from a machine with network access to
   the database.
5. Confirm it answers from outside: `curl https://<host>/health` and `curl https://<host>/api/v1/routes?limit=1`
   from a different machine or `VERIFY_BASE_URL=https://<host> npm test`.

## Consumer app

`public/index.html` is a single-page, dependency-free client served by the same Express app at `/`. It calls
the live API directly from the browser (see the Network tab), and lets you:

- switch between the four resources,
- apply resource-specific filters (city, mode/type, status, fare range, travel date, …),
- change `sort`/`order`,
- page forward and back and see `meta.total` / current range update.

The "API base" field defaults to `window.location.origin`, so once this is deployed the consumer calls the
same public host it's served from — never `localhost` — and can also be pointed at any other deployment of
this API to smoke-test it from the browser.
