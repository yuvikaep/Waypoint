# Waypoint GPS

Waypoint now has a live fleet workspace backed by SQLite. It supports GT06 and
Teltonika FMB920 through Traccar, plus an optional authenticated mobile web sender.
No sample vehicles are inserted into the live fleet.

## Local startup

Requires Node 22.13 or newer (tested on 22.22.3). Docker Desktop is needed only for
the bundled Traccar gateway; an existing Traccar server can also be used.

```sh
npm install
npm run dev
```

Open `http://127.0.0.1:5173` for the no-login demo. Use `/?live=1` for actual tracking
and admin sign-in. The demo uses isolated browser storage and simulated data; its
mobile sender does not request real location permission. The launcher starts the web UI, GPS service on port
5180, and the existing e-way adapter on port 5174. Vite chooses another free port
if 5173 is occupied. E-way generation retains its original localhost:5173 origin
restriction and requires separately configured credentials.

The first GPS startup creates a random workspace access key in
`server/private/admin-token` (owner-only permissions). Enter that key at sign-in.
Alternatively set `GPS_ADMIN_TOKEN` to a random secret of at least 24 characters.
Sessions expire after 12 hours and on server restart. Sign-out invalidates the
session. Sender credentials cannot access the fleet API.

## Local hardware gateway

```sh
npm run gateway:up
npm run gateway:setup
# Restart npm run dev after setup.
```

The setup command only initializes a **new** gateway on localhost. It creates a
local administrator and a one-year API token. Credentials are saved in ignored,
owner-only files `server/private/gateway-admin.txt` and `gateway.env`. It refuses
to replace existing gateway credentials. The Traccar console is at
`http://127.0.0.1:8082`. The Compose service uses persistent named volumes.

For an existing gateway, set `TRACCAR_URL` (base URL without `/api`) and
`TRACCAR_TOKEN` in `.env`. The token's user needs device registration, position
history and command permissions for the intended fleet. Environment variables
override `.env`; `.env` overrides the generated local gateway environment.

Register the device in Waypoint using **Add device**. Hardware registrations are
matched to Traccar by IMEI; if absent they are created on the next synchronization.

| Model | Identifier | Device transport | Gateway port |
| --- | --- | --- | --- |
| GT06 | 15-digit IMEI | GT06 TCP | 5023 |
| FMB920 | 15-digit IMEI | Teltonika TCP | 5027 |
| Mobile browser | Vehicle-specific driver link | HTTPS JSON API | Web origin |

Set the hardware tracker server address to your gateway host and the port above.
Configure the SIM APN, reporting interval, and TCP transport using the manufacturer's
manual or Teltonika Configurator. GT06 SMS syntax varies by manufacturer, so there
is no universal SMS command included here.

The bundled gateway binds to loopback by default. SIM-connected trackers cannot
reach your Mac's `127.0.0.1`. On a reachable gateway host, explicitly set
`GPS_TRACKER_BIND=0.0.0.0`, allow the two tracker TCP ports through the firewall,
and configure a public IP/domain or private network routing. Keep port 8082 private
or behind authenticated HTTPS. This repository has **not** been deployed publicly.

## Mobile sender

1. Register a Mobile device with its vehicle name. An identifier and driver link
   are generated automatically; the driver never enters a token.
2. Copy/share the driver link. For an existing Mobile device, use Devices ->
   Connection -> Create driver link. Links have no automatic expiry. Opening the
   connection dialog retrieves the same link; regenerate requires confirmation.
   Replacing or disabling
   a link revokes all sessions created from it, including active senders.
3. The driver opens the link, sees the assigned vehicle, taps **Location shuru
   karein**, and allows the browser location permission. Opening a link alone does
   not request GPS or send location.
4. Keep the page open. **Sharing band karein** stops GPS watching and heartbeats.

The sender uses `watchPosition`, sends a heartbeat and polls for pings every 30 seconds, and requests
fresh fixes for queued pings. Browser background throttling and a locked screen
can interrupt sharing; this is not a native background-tracking app. HTTP works
on localhost for local testing; other origins require HTTPS. A localhost link
cannot reach a driver's phone. Driver links contain a random access code in the
URL fragment, which the page removes before exchanging it for a device-scoped
HttpOnly cookie. Sessions last up to 12 hours, survive service restarts, and do
not grant fleet access. Share a link only with its intended driver. The existing
Bearer sender API remains available for programmatic integrations; issuing a
driver link invalidates that device's old sender token.

## Fleet behavior

- API and mobile locations persist in `server/private/tracking.sqlite`.
- The UI polls every 3 seconds; the gateway synchronizes every 5 seconds.
- Heartbeat age and GPS-fix age are separate. Default offline threshold is 180
  seconds and can be chosen during registration. An online tracker with an old
  GPS fix shows **No GPS fix**. An uncontacted tracker shows **Waiting**.
- Moving means a fresh fix at 3 km/h or more. Traccar speed is converted from
  knots to km/h. Missing ignition, battery, or satellite fields remain unknown.
- Ping states include queued, dispatching, sent, answered (mobile), location
  received, unsupported, failed, and timed out. Hardware command capabilities are
  queried before sending `positionSingle`. No custom/immobilizer commands are sent.
  A new fix after a hardware request is not claimed as a protocol-level command ACK.
  Pings time out after two minutes; repeated active requests reuse the same command.
- Route history supports up to 31 days, paginates stored points, and exports CSV.
  Loading a hardware route also imports that range from Traccar, including delayed
  tracker uploads. If the gateway fails, the UI identifies the local-only result.
  The bridge backfills 15-minute windows from registration time after downtime.
- Routes break at gaps over 15 minutes. Playback advances one recorded fix every
  half-second; lines connect observations and are not road-matched navigation.
- Circular geofences apply to all registered vehicles. Alerts fire on observed
  entry/exit transitions, overspeed threshold crossings, disconnection and recovery.
  Offline checks run every five seconds. Alerts are acknowledged persistently.
  The UI shows the latest 200 alerts. Geofence alerts use incoming newer fixes;
  late history imports do not reconstruct old transitions behind the current fix.
- Existing documents and attachments remain in the browser's original storage.
  Vehicle choices include registered live vehicles and existing document vehicle
  references, preserving edit/renewal associations; e-way billing still requires the
  provider's credentials. GPS data is server-persisted, documents are not migrated.

## HTTP contract

All bodies are JSON objects; errors are `{ "error": "message" }` with a suitable
HTTP status. JSON requests are capped at 16 KB. Workspace endpoints require the
HttpOnly `waypoint_session` cookie. Cross-origin requests are rejected.

| Method | Path (under `/api/gps`) | Purpose |
| --- | --- | --- |
| GET | `/health` | Public liveness probe |
| POST | `/session` | Sign in with `{token}` |
| DELETE | `/session` | Invalidate current session |
| GET | `/state` | Fleet, latest fixes, gateway status, fences and alerts |
| POST | `/devices` | Register `{name,uniqueId,model,driver?,offlineSeconds?,speedLimit?}` |
| POST | `/devices/:id/token` | Replace mobile sender token; body `{}` |
| GET | `/devices/:id/driver-link` | Retrieve the existing active link, or null |
| POST | `/devices/:id/driver-link` | Create/reuse fixed link; `{regenerate:true}` explicitly replaces it; `expiresAt` is null |
| DELETE | `/devices/:id/driver-link` | Disable driver link and its sessions |
| POST | `/sender/join` | Exchange `{code}` for a device-scoped HttpOnly session |
| GET | `/sender/me` | Assigned vehicle name/driver and session expiry |
| POST | `/devices/:id/ping` | Request a fresh fix; body `{}` |
| GET | `/devices/:id/history?from=ISO&to=ISO&after=0` | Up to 2,000 points/page; continue with returned `next` until null |
| POST | `/fences` | Create `{name,latitude,longitude,radius}` in metres |
| DELETE | `/fences/:id` | Remove a fence, retaining past alerts |
| POST | `/alerts/:id/ack` | Acknowledge alert; body `{}` |
| POST | `/sender/position` | Submit device fix using Bearer sender token |
| POST | `/sender/heartbeat` | Body `{}`; returns queued commands |
| GET | `/sender/commands` | Read this sender's queued commands |

Sender position payload (coordinates are WGS84 decimal degrees):

```json
{
  "eventId": "sender-generated-unique-id",
  "recordedAt": "2026-10-05T08:00:00.000Z",
  "latitude": 18.52,
  "longitude": 73.85,
  "speed": 35,
  "heading": 90,
  "accuracy": 8,
  "ignition": true,
  "battery": 90,
  "satellites": 8
}
```

Driver-session requests include the assigned `deviceId` in position and heartbeat
bodies, preventing one browser tab from accidentally reporting for another vehicle
after a different driver link is opened. Bearer integrations remain device-scoped.

Use the current actual timestamp. Optional fields may be omitted/null (speed
defaults to zero). A sender should use km/h for speed, metres for accuracy, and
0-100 for battery percentage. Include `commandId` when answering a queued ping.
Duplicate `(device,eventId)` retries are accepted without duplicating history.
Older fixes are retained but cannot rewind the vehicle's current location.

## Verification

```sh
npm test
npm run build
npm run test:gateway
```

The gateway smoke test requires the local gateway and generated `gateway.env`.
It creates temporary test-only registrations, sends GT06 and Teltonika Codec 8
binary packets over TCP, checks login/AVL acknowledgements and imported positions,
then deletes only those test registrations. It uses an in-memory Waypoint database.
These are synthetic protocol tests, not a physical-device or SIM field test.

## Operating beyond localhost

`npm run build && npm start` serves the built UI and GPS API on port 5180. Set
`GPS_PUBLIC_ORIGIN` to the exact HTTPS origin when using a reverse proxy; this also
enables Secure session cookies. The separate e-way adapter requires its own proxy
route and existing setup. Use Node 22.13+ and persistent, backed-up storage for
`server/private/` and the gateway volumes. Location and alert retention is currently
unbounded. The workspace is a single-admin fleet, without multi-tenant roles.

The bundled Traccar container uses its default H2 database for local commissioning.
Use Traccar's documented PostgreSQL/MySQL configuration before production. Hardware
IMEIs identify trackers but are not cryptographic credentials; protect the gateway
network appropriately. Physical device setup, public networking, and field testing
are still required before relying on this system for an operational fleet.

Reference documentation:
- [Supported devices and ports](https://www.traccar.org/devices/)
- [Traccar API](https://www.traccar.org/traccar-api/)
- [Traccar Docker setup](https://www.traccar.org/docker/)
- [Browser geolocation requirements](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation/watchPosition)
