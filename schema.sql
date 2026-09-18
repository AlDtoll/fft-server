-- FFT-3D multiplayer server schema

CREATE TABLE IF NOT EXISTS rooms (
  id          TEXT PRIMARY KEY,
  host_token  TEXT NOT NULL,
  guest_token TEXT,
  state_json  BLOB NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  phase       TEXT NOT NULL DEFAULT 'lobby'
);

CREATE INDEX IF NOT EXISTS idx_updated_at ON rooms (updated_at);
