# Waypoint local preview

GPS-first responsive web prototype with vehicle selection, interactive OpenStreetMap map, search/status filters, sample route playback, alerts, CSV exports, and vehicle document records with optional PDF/image attachments.

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
