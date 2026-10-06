# Waypoint GPS workspace

Live fleet tracking for GT06, Teltonika FMB920, and optional mobile GPS. Includes authenticated device registration, persistent locations, heartbeat/fix freshness, on-demand ping status, map follow, recorded routes, CSV export, geofences, and alerts. Existing browser-stored documents and e-way billing remain available.

Run `npm run dev` and open `http://127.0.0.1:5173` for the real workspace. Live tracking, route history, devices, geofences, alerts, Documents, E-way bills, Profile and Settings share one navigation shell. The local Vite preview signs in same-origin loopback requests automatically; the production backend still requires the generated key in `server/private/admin-token`. Driver sharing remains a separate link without an admin login.

Use `/?demo=1` explicitly for sample vehicles and simulated tracking. Demo edits use separate browser storage and do not contact the GPS or billing backend. Profile and display preferences currently persist only in this browser; they are not customer accounts. Separate customer authentication and tenant isolation are not implemented yet.

Mobile sharing sends a heartbeat every 30 seconds while the driver page is running; the fleet view refreshes every three seconds. Browsers may pause background or locked-screen pages. Hardware heartbeat frequency must be configured on the tracker. Driver links stay fixed until explicitly regenerated or disabled. See [GPS-SETUP.md](GPS-SETUP.md) for setup and deployment boundaries.

Validation: `npm test`, `npm run build`, and `npm run test:gateway` (requires the local Traccar gateway). No physical trackers or SIMs have been connected during development.

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
