CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  partial_log JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS proofs (
  uuid TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  session_log JSONB NOT NULL,
  final_text TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  session_duration_ms DOUBLE PRECISION NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  score_breakdown JSONB NOT NULL,
  server_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signature TEXT NOT NULL
);
