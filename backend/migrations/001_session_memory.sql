BEGIN;
CREATE TABLE IF NOT EXISTS sessions (
  session_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  job_posting_text TEXT NOT NULL DEFAULT '',
  position_label TEXT NOT NULL DEFAULT 'Interview practice',
  session_type TEXT NOT NULL DEFAULT 'interview' CHECK (session_type IN ('interview', 'focus')),
  targeted_weakness TEXT
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS interview_plan JSONB
  CHECK (interview_plan IS NULL OR jsonb_typeof(interview_plan) = 'array');
CREATE INDEX IF NOT EXISTS sessions_user_started ON sessions(user_id, started_at DESC);
CREATE TABLE IF NOT EXISTS session_ai_analysis (
  session_id UUID PRIMARY KEY REFERENCES sessions(session_id),
  transcript JSONB NOT NULL DEFAULT '[]',
  static_signals JSONB NOT NULL DEFAULT '{}',
  analysis JSONB NOT NULL DEFAULT '{}'
);
ALTER TABLE session_ai_analysis ADD COLUMN IF NOT EXISTS memory_synced_at TIMESTAMPTZ;
-- User-owned state includes assistant mapping and durable per-record write receipts.
-- This also retains local development state when using the Postgres adapter.
CREATE TABLE IF NOT EXISTS callback_memory_users (
  user_id TEXT PRIMARY KEY,
  state JSONB NOT NULL
);
COMMIT;
