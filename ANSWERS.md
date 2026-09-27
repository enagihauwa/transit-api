# Assignment write-ups

Answers to specific write-up prompts from the assignment, kept separate from [README.md](README.md) (which
is the API's own documentation) so each prompt's answer stays easy to find and submit on its own.

## Design decision: what happens when someone asks for 5000 records

> Write about one design decision and why you made it. Include the live URL and one curl command a reader
> can paste and run.

**Status:** the API is currently running locally only, at `http://localhost:8080` — it has not been deployed
to a public host (see [README.md § Deployment](README.md#deployment) for what that would take). The command
below is written to run against that local instance; swap the host for a public URL once one exists.

Every list endpoint clamps `limit` to a maximum of 100 instead of honouring whatever the caller asks for
(`config.pagination.maxLimit`, read in `readPagination()` in
[`src/lib/pagination.js`](src/lib/pagination.js)). `?limit=5000` doesn't error and it doesn't get rejected —
it silently comes back as 100 rows, with `meta.limit: 100` telling the caller exactly what happened:

```bash
curl -s "http://localhost:8080/api/v1/routes?limit=5000" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log('rows:', d.data.length, 'meta:', d.meta);"
```

```
rows: 100 meta: { total: 300, limit: 100, offset: 0, hasMore: true, nextCursor: '...' }
```

The alternative would be rejecting the request with `400`, but that punishes a caller who simply doesn't know
the ceiling yet — a first-time integrator, a script someone wrote against a different API's limits, or a
naive "just get everything" attempt — for a mistake that costs the API nothing to absorb gracefully. Clamping
instead of erroring means a request for too much data still succeeds, just capped, and the response tells the
caller where the cap is (`meta.limit`) so their *next* request can be correct.

The reason the cap exists at all is what an unbounded `limit` would actually do to a shared, unauthenticated
service: with no ceiling, `?limit=1000000` runs the same `COUNT(*)` and a page-sized `SELECT` against Postgres
regardless of who's asking, and a single request from one caller could tie up a connection out of the pool
(`max: 10` in [`src/db.js`](src/db.js)) for everyone else — the API has no accounts to rate-limit harder per
caller, only the IP-based limiter in front of it, so the query itself has to be the thing that can't be
abused. A fixed maximum turns "how much data comes back" from a caller-controlled variable into a
server-controlled constant, which is what makes the response time and the load on the database predictable
regardless of what shows up in a query string. The same instinct is why `offset` must be a non-negative
integer and an out-of-range `sort` field is rejected outright (`400`) rather than silently defaulting — a
malformed or hostile query parameter should never be able to change the *shape* of the work the server does,
only fail fast or get clamped to something the server already knows it can handle.
