-- Millisecond timestamps and flags retain the TrackingStore JSON contract.
-- Unquoted names support the existing modules; the adapter restores camel case.
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, uniqueId TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL, driver TEXT NOT NULL, tokenHash TEXT, createdAt BIGINT NOT NULL,
  lastSeen BIGINT, traccarId BIGINT, cursor BIGINT, bridgeStatus TEXT,
  offlineSeconds DOUBLE PRECISION NOT NULL, speedLimit DOUBLE PRECISION NOT NULL,
  offlineAlert INTEGER NOT NULL DEFAULT 0, tenantId TEXT NOT NULL DEFAULT 'owner'
);
CREATE TABLE IF NOT EXISTS positions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  deviceId TEXT NOT NULL REFERENCES devices(id), eventId TEXT NOT NULL,
  recordedAt BIGINT NOT NULL, receivedAt BIGINT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL, longitude DOUBLE PRECISION NOT NULL,
  speed DOUBLE PRECISION NOT NULL, heading DOUBLE PRECISION, accuracy DOUBLE PRECISION,
  ignition INTEGER, battery DOUBLE PRECISION, satellites DOUBLE PRECISION,
  UNIQUE(deviceId,eventId)
);
CREATE INDEX IF NOT EXISTS position_time ON positions(deviceId,recordedAt,id);
CREATE INDEX IF NOT EXISTS devices_tenant ON devices(tenantId,createdAt);
CREATE TABLE IF NOT EXISTS fences (id TEXT PRIMARY KEY,name TEXT NOT NULL,latitude DOUBLE PRECISION NOT NULL,longitude DOUBLE PRECISION NOT NULL,radius DOUBLE PRECISION NOT NULL,tenantId TEXT NOT NULL DEFAULT 'owner');
CREATE TABLE IF NOT EXISTS fence_state (deviceId TEXT NOT NULL REFERENCES devices(id),fenceId TEXT NOT NULL REFERENCES fences(id) ON DELETE CASCADE,inside INTEGER,PRIMARY KEY(deviceId,fenceId));
CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY,deviceId TEXT NOT NULL REFERENCES devices(id),type TEXT NOT NULL,message TEXT NOT NULL,createdAt BIGINT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY,deviceId TEXT NOT NULL REFERENCES devices(id),status TEXT NOT NULL,detail TEXT NOT NULL,createdAt BIGINT NOT NULL,updatedAt BIGINT NOT NULL,rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE);
CREATE INDEX IF NOT EXISTS commands_device_time ON commands(deviceId,createdAt,rowid);
CREATE TABLE IF NOT EXISTS driver_links (hash TEXT PRIMARY KEY,deviceId TEXT NOT NULL REFERENCES devices(id),expiresAt BIGINT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,code TEXT,rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE);
CREATE INDEX IF NOT EXISTS driver_links_device ON driver_links(deviceId,rowid);
CREATE TABLE IF NOT EXISTS driver_sessions (hash TEXT PRIMARY KEY,linkHash TEXT NOT NULL REFERENCES driver_links(hash),expiresAt BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,salt TEXT NOT NULL,passwordHash TEXT NOT NULL,createdAt BIGINT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS admins (email TEXT PRIMARY KEY,salt TEXT NOT NULL,passwordHash TEXT NOT NULL,createdAt BIGINT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS workspace_data (tenantId TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,updatedAt BIGINT NOT NULL,PRIMARY KEY(tenantId,key));
CREATE TABLE IF NOT EXISTS relay_installations (deviceId TEXT PRIMARY KEY REFERENCES devices(id),verifiedAt BIGINT NOT NULL,installer TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS relay_commands (id TEXT PRIMARY KEY,deviceId TEXT NOT NULL REFERENCES devices(id),action TEXT NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,createdAt BIGINT NOT NULL,status TEXT NOT NULL,detail TEXT NOT NULL,rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE);
CREATE INDEX IF NOT EXISTS relay_commands_device_time ON relay_commands(deviceId,createdAt,rowid);
-- Parent lifecycle code owns expiry cleanup and authentication policy.
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY,role TEXT NOT NULL,tenantId TEXT NOT NULL,name TEXT NOT NULL,email TEXT,expiresAt BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expiresAt);
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY,count INTEGER NOT NULL,resetAt BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(resetAt);
CREATE TABLE IF NOT EXISTS cloud_sessions (key TEXT PRIMARY KEY,value JSONB NOT NULL,expiresAt BIGINT);
CREATE INDEX IF NOT EXISTS cloud_sessions_expiry ON cloud_sessions(expiresAt);
CREATE TABLE IF NOT EXISTS gateway_state (id INTEGER PRIMARY KEY CHECK(id=1),connected BOOLEAN NOT NULL,lastSync BIGINT NOT NULL,error TEXT);
