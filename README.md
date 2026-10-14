# Waypoint GPS workspace

Live fleet tracking for GT06-family, Teltonika, and optional mobile GPS. Includes customer workspaces, persistent locations, heartbeat/fix freshness, maps, recorded routes, geofences, alerts, documents, and an e-way register.

The customer app and serverless API run on [Waypoint on Vercel](https://waypoint-eta-pied.vercel.app/?live=1). PostgreSQL provisioned through Vercel Storage owns customer accounts, sessions, fleet registrations, GPS history, documents, e-way records and preferences. Private Vercel Blob owns attachments. Oracle runs only Traccar TCP reception and the GPS forwarding worker. Live tracking, route history, devices, geofences, alerts, Documents, E-way bills, Profile, and Settings share one navigation shell. [Customer login](https://waypoint-eta-pied.vercel.app/?live=1&auth=customer), [sign-up](https://waypoint-eta-pied.vercel.app/?live=1&auth=signup), and [admin login](https://waypoint-eta-pied.vercel.app/?live=1&auth=admin) are separate screens. Drivers use separate vehicle links.

The production site does not expose demo mode. Customer accounts, fleet data, documents, e-way register entries, and display preferences are stored on the cloud server and scoped to each workspace. Document and bill attachments are limited to 2 MB each. The e-way register is manual; it does not create or modify government records.

Mobile sharing sends a heartbeat every 30 seconds while the driver page is running; the fleet view refreshes every three seconds. Browsers may pause background or locked-screen pages. Hardware heartbeat frequency must be configured on the tracker. Driver links stay fixed until explicitly regenerated or disabled. See [GPS-SETUP.md](GPS-SETUP.md) for setup and deployment boundaries and the cloud-only diagnostic command.

Production readiness is checked on the Oracle VM with `scripts/cloud-check.mjs`, which distinguishes registered devices from actual packets and fixes received by cloud Traccar. After the fresh-data reset, customers must register their devices again; no historical local fix is treated as a cloud heartbeat.

Vercel serves `/api/gps/*` directly through `api/gps/[...path].mjs`; there is no Oracle API proxy. Login and saved workspace data remain available when the TCP gateway is offline. Set `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `WAYPOINT_SESSION_SECRET`, `GPS_GATEWAY_SECRET`, `WAYPOINT_ADMIN_EMAIL` and `WAYPOINT_ADMIN_PASSWORD` in Vercel. The last two bootstrap a distinct admin account only if it does not exist. Never expose these as frontend variables. `ops/waypoint-gateway.service` forwards acknowledged GPS batches from Oracle every ten seconds with durable cloud checkpoints. Oracle H2 is a reception/retry buffer, not the application database. Relay commands remain disabled by default; an authenticated command channel and installer verification are required separately. This single gateway does not guarantee uninterrupted tracker reception.

The migration starts with a fresh PostgreSQL database; no old account or position is copied into it. Customers sign up again and register devices by IMEI. Remove legacy Oracle SQLite data and old tracker registrations only after the approved reset. GitHub Cloud Checks runs the test suite with a disposable PostgreSQL service and builds the frontend without local app testing. Never commit credentials.

Relay controls: see [RELAY-SETUP.md](RELAY-SETUP.md). Starter-inhibit/restore is
default-disabled and requires installer verification and admin re-authentication.
No physical relay operation has been validated.

## Archived prototype notes

The notes below describe the previous demo and its browser document storage. Sample fleet positions and sample route playback have been replaced in the default live workspace.

## Run

```sh
npm install
npm run dev -- --port 5173
```

Open http://127.0.0.1:5173. Run `npm run build` for TypeScript validation and production assets.

## Preview boundaries

- Fleet, drivers, locations, alerts, and history are sample data. No GT06 connection exists yet.
- Mobile layout is responsive web, not a native Android/iOS app.
- Documents and small attachments persist in this browser's local storage. This is not production secure storage or a shared database.
- Expiry calculations use 8 September 2026, matching the demo dataset.
- Renewal schedules are illustrative. Push/SMS notifications, authentication, geofences, sharing, renewal history and GT06 ingestion remain backend work.
- Map tiles and fonts require internet access. Local app server binds to 127.0.0.1 only.
- Route playback uses an illustrative path, not a recorded or road-matched route.

## Verified

Production build and TypeScript checks; browser document creation and persistence across reload; vehicle search; route playback start; responsive layout at 320px without body overflow. File attachment handling is implemented but not browser-upload tested.

## GPS and document improvements

- Search, movement status, and SIM network filters apply to both the list and map; empty results clear selection.
- Selected vehicle has a highlighted marker, registration tooltip and focused map. Follow mode follows the selected marker.
- Explicitly labelled GPS simulation updates moving vehicles every three seconds. These are synthetic coordinates, not a GT06 feed or road-matched positions.
- Vehicle detail links directly to that vehicle's document folder. Documents filter by vehicle, type, status, and text. Supported attachments: PDF, PNG, JPEG, WebP, up to 2 MB, subject to browser storage capacity.
- Expiry now uses the current local date, replacing the original fixed demo date.
- Expired documents and those expiring within 30 days require individual acknowledgement before app access. Escape is blocked. Acknowledgements persist for the local calendar day, and changed warnings require acknowledgement again. The app rechecks on focus and every minute when no other dialog is open.
- This is a browser-only access gate for the demo workspace, not authenticated per-user enforcement. Production requires user identity, server-side access enforcement, acknowledgement audit records, and secure document storage.
- Browser verified: Escape/partial acknowledgement blocking, reload persistence, newly added expiry re-gating, combined GPS filters with matching marker counts, selection highlight, attachment upload/reload persistence, and combined document filters. Demo test records are labelled DEMO.
