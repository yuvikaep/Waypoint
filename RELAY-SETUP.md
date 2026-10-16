# Engine Relay (Engine Lock)

Relay control is off until `GPS_RELAY_ENABLED=true` is set on the server, and each vehicle
also needs a fitting record saved by an admin. Owners can then lock or unlock the engine from
the customer app (vehicle page → Engine lock, or the ⋮ menu).

## Scope

- Model profiles: GT06, GT06N, FMB920, FMB125, FMC920, FMC130. Phone tracking cannot drive a relay.
- Wiring is recorded per vehicle: **starter** (blocks the next start) or **fuel pump / ignition**
  (cuts the engine). A fuel / ignition relay can stop a running engine, so the server only ever
  sends a lock to a parked vehicle.
- GT06 clones vary. Test lock and unlock once on the parked vehicle before saving the record.

## Fitting

1. Fit the relay on the tracker's relay output (often the yellow wire) and on the chosen line.
2. Lock and unlock once on the parked vehicle and check the engine really stops / starts.
3. Admin console → Devices → vehicle → Engine relay → Relay fitting record: choose the wiring,
   tick the test (and, for fuel / ignition, the parked-only acknowledgement), enter the password.
4. Set `GPS_RELAY_ENABLED=true` on the server once (global switch).

## Safety And Delivery

Every command needs the vehicle number (or IMEI) typed again and the user's password. A lock is
refused unless all of these hold at the moment it is sent, and again after the gateway lookup:

- the tracker is online (heard from in the last 5 minutes) and connected to the gateway;
- the last ignition report is OFF, less than 5 minutes old, and the engine has been off for a minute;
- no packet in the last 3 minutes reports speed above 1 km/h, and the last GPS fix is stationary;
- recent fixes with usable accuracy are within 30 m of the last fix.

A parked GT06 that only sends heartbeats can be locked: its heartbeat carries the ignition state.
Unlock is allowed at any time. Commands use `noQueue: true`: nothing is queued for later, retried
or sent by SMS.

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
