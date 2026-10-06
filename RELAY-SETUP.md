# Starter Relay Controls

Relay controls are implemented but disabled by default. No physical tracker or
vehicle relay has been tested. Do not enable this on a vehicle until a qualified
installer has commissioned and verified it in a controlled, parked test.

## Scope

- Model profiles: GT06, GT06N, FMB920, FMB125, FMC920, FMC130.
- Only a starter-inhibit circuit is supported. Do not use fuel-pump or ignition
  cut-off wiring with this feature. It must not stop an already-running engine.
- Teltonika uses the gateway's engineStop/engineResume mapping to DOUT1; custom
  outputs, inverted polarity, and arbitrary SMS commands are not exposed.
- GT06 clones vary. Gateway protocol settings and command polarity must be
  verified on the exact unit, not assumed from its label.
- Mobile GPS cannot control a relay. Other hardware models are not certified
  merely because Traccar can track their locations.

## Commissioning

1. Confirm starter-only wiring, physical ignition sensing, and output polarity
   against manufacturer documentation with the installer. Do not rely on
   inferred ignition from movement for commissioning.
2. Verify the gateway's command mapping and device-side safeguards in a
   controlled installation test outside this application.
3. In Devices -> Relay -> Installer verification, record the verification
   reference and confirm the wiring/polarity. Admin key re-entry is required.
4. Only after verification, set `GPS_RELAY_ENABLED=true` on the server and
   restart it. This is a global deployment switch, not a per-driver permission.
5. Devices -> Relay requires the exact IMEI, an operation reason, and admin key
   re-entry for each command. No driver-link access is permitted.

## Safety And Delivery

The server requires a heartbeat and GPS fix no older than 30 seconds. Inhibit
also requires two or more fixes spanning at least 30 seconds in the last minute,
all with ignition OFF, speed at most 1 km/h, reported accuracy greater than zero
and at most 50 metres, and positions within 15 metres of the latest fix. Trackers
without trustworthy accuracy or ignition telemetry remain blocked.

The connected gateway must identify the expected device IMEI and protocol, show
it online, and advertise both engineStop and engineResume. Safety is rechecked
after capability lookup. Commands use Traccar 6.16's `noQueue: true`, with no SMS
fallback or automatic retry. Do not use an older/unverified gateway version.
Firmware behavior and network latency are not substitutes for safe wiring.

Requests use idempotency IDs, a per-device lock and a 60-second cooldown. Audit
history is retained separately from location pings. A successful gateway response
is **sent-unverified**, never proof that a physical relay changed. A timeout is
**unknown**; inspect the gateway and vehicle before issuing any new operation.
No automatic physical-state readback is implemented. Disabling application
access does not restore a relay that is already inhibited.

GET `/api/gps/devices/:id/relay` returns status/history. PUT records or removes
installation verification. POST requests `inhibit` or `restore`. All endpoints
require a workspace session; PUT/POST additionally require `adminKey` in the body.
There are no individual customer roles yet; the audit actor is workspace-admin.

## References

- [Traccar supported devices](https://www.traccar.org/devices/)
- [Traccar 6.16 GT06 encoder](https://github.com/traccar/traccar/blob/v6.16.0/src/main/java/org/traccar/protocol/Gt06ProtocolEncoder.java)
- [Traccar 6.16 Teltonika encoder](https://github.com/traccar/traccar/blob/v6.16.0/src/main/java/org/traccar/protocol/TeltonikaProtocolEncoder.java)
- [Traccar no-queue behavior](https://github.com/traccar/traccar/blob/v6.16.0/src/main/java/org/traccar/database/CommandsManager.java)
- [Teltonika DOUT commands](https://wiki.teltonika-gps.com/view/FMB_setdigout)
