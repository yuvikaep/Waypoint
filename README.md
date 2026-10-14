# Waypoint GPS workspace

Live fleet tracking for GT06-family, Teltonika, and optional mobile GPS. Includes customer workspaces, persistent locations, heartbeat/fix freshness, maps, recorded routes, geofences, alerts, documents, and an e-way register.

The customer app is [Waypoint on Vercel](https://waypoint-eta-pied.vercel.app/?live=1). Its API and Traccar gateway currently run on Oracle and are separate from localhost. `npm run dev` is a development preview only. Live tracking, route history, devices, geofences, alerts, Documents, E-way bills, Profile, and Settings share one navigation shell. [Customer login](https://waypoint-eta-pied.vercel.app/?live=1&auth=customer), [sign-up](https://waypoint-eta-pied.vercel.app/?live=1&auth=signup), and [admin login](https://waypoint-eta-pied.vercel.app/?live=1&auth=admin) are separate screens. Drivers use separate vehicle links.

The production site does not expose demo mode. Customer accounts, fleet data, documents, e-way register entries, and display preferences are stored on the cloud server and scoped to each workspace. Document and bill attachments are limited to 2 MB each. The e-way register is manual; it does not create or modify government records.

Mobile sharing sends a heartbeat every 30 seconds while the driver page is running; the fleet view refreshes every three seconds. Browsers may pause background or locked-screen pages. Hardware heartbeat frequency must be configured on the tracker. Driver links stay fixed until explicitly regenerated or disabled. See [GPS-SETUP.md](GPS-SETUP.md) for setup and deployment boundaries and the cloud-only diagnostic command.

Production readiness is checked on the Oracle VM with `scripts/cloud-check.mjs`, which distinguishes registered devices from actual packets and fixes received by cloud Traccar. After the fresh-data reset, customers must register their devices again; no historical local fix is treated as a cloud heartbeat.

The customer frontend is hosted on Vercel at `https://waypoint-eta-pied.vercel.app`. Vercel rewrites `/api/gps/*` to the existing Oracle API; `GPS_FRONTEND_ORIGIN` permits only the configured Vercel origin. This keeps browser sessions on the Vercel hostname. The current API and persistent database still run on Oracle, alongside the TCP gateway; moving the API to Vercel serverless requires a separately provisioned durable database. Systemd restarts failed services; `waypoint-health.timer` checks local services every 30 seconds and restarts them after three consecutive failures. Resource limits bound Node and Traccar memory on the small VM, and persistent journal logs retain recovery evidence. These controls do not provide redundant hosting or guaranteed uptime.

Cloud reset is deliberately manual: stop Waypoint, retain a temporary rollback snapshot, then run `scripts/reset-cloud-data.mjs` on the VM with `WAYPOINT_RESET=DELETE_ALL_OLD_DATA`, `WAYPOINT_ADMIN_EMAIL`, `WAYPOINT_URL`, and the private gateway environment. The generated admin login is saved in owner-only `server/private/admin-login.txt`. Remove old gateway history/logs and temporary snapshots after confirming the fresh deployment. Never commit credentials.

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
