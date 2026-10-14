# PostgreSQL Store Integration

```js
import { PostgresTrackingStore } from './postgres-store.mjs';

// client is already connected and dedicated to this store instance.
const store = await PostgresTrackingStore.create({ client, now: () => Date.now() });
const devices = await store.devices('owner');
```

Creation installs `postgres-schema.sql` transactionally. All existing store
methods return promises with the original result shapes and error statuses.
Await every store method and every `db.exec`, `db.prepare(...).get/all/run`
operation. `prepare` itself is synchronous. `get` returns undefined for no row;
`run` returns `{changes}`. The caller owns the connected client: `store.close()`
drains pending work but does not call `client.end()` or `client.release()`.
Do not share the client with another store or issue queries directly on it while
store work is in progress. Do not wrap store calls in caller-managed transactions.

Public store calls run in transactions, serialized on the dedicated client.
Nested calls join the same transaction. A common PostgreSQL advisory transaction
lock serializes store operations across instances, protecting ingestion,
geofence transitions, link rotation, offline alerts, and command deduplication.
This deliberately favors correctness over parallel throughput. Direct adapter
queries are serialized locally but do not take the advisory lock; use
`await store.db.transaction(async () => { ... })` for compound adapter mutations
that must coordinate with store operations. Always await all work inside it.

The schema uses unquoted PostgreSQL identifiers. The adapter maps known folded
column names back to existing camel-case row keys and safely converts BIGINT
results to JavaScript numbers. Internal identity `rowid` columns preserve
insertion ordering for driver links, commands, and relay history and are omitted
from returned rows. Position IDs are persistent identity values; rolled-back or
duplicate inserts can leave gaps, which cursor pagination supports.

SQL must already be PostgreSQL-compatible. The adapter supports positional `?`
parameters outside SQL literals/comments, or native `$n` parameters, but not both
in one statement. Question-mark JSON operators and backslash-escaped E-string
literals are outside the compatibility grammar; use ordinary SQL strings and
bound values. There is no general SQLite dialect translation. Two exact legacy
relay statements have explicit handling: the existing relay bootstrap DDL is a
no-op because creation already installs those tables, and the existing
`INSERT OR REPLACE INTO relay_installations VALUES (?,?,?)` is an explicit
PostgreSQL upsert. Existing bridge updates and relay reads/updates otherwise run
directly through this adapter after callers are made asynchronous.

The schema includes `sessions(hash,role,tenantId,name,email,expiresAt)` and
`rate_limits(key,count,resetAt)` for parent-owned lifecycle wiring. Generation
tokens or additional session metadata require the parent to extend its schema
or use a separate table. Expiry cleanup is owned by that lifecycle code.

No local tests were run. Real PostgreSQL CI validation is still required before
deployment; no mock-database tests or package changes are included here.
