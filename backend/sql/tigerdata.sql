-- Original PDFs and all application records live in Tiger Data (PostgreSQL).
-- Safe to reapply to the original ZIP schema. Never drops existing data.
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_created_at TIMESTAMPTZ;
UPDATE users SET account_created_at = created_at WHERE account_created_at IS NULL;
ALTER TABLE users ALTER COLUMN account_created_at SET DEFAULT NOW();
ALTER TABLE users ALTER COLUMN account_created_at SET NOT NULL;

CREATE TABLE IF NOT EXISTS pdf_documents (
  document_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  filename TEXT NOT NULL CHECK (lower(filename) LIKE '%.pdf'),
  mime_type TEXT NOT NULL DEFAULT 'application/pdf' CHECK (mime_type = 'application/pdf'),
  file_size_bytes INTEGER NOT NULL CHECK (file_size_bytes > 0),
  sha256 CHAR(64) NOT NULL,
  pdf_data BYTEA NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pdf_documents_id_owner ON pdf_documents (document_id, user_id);
CREATE INDEX IF NOT EXISTS idx_pdf_documents_user_uploaded ON pdf_documents (user_id, uploaded_at DESC, document_id);
CREATE INDEX IF NOT EXISTS idx_pdf_documents_sha256 ON pdf_documents (sha256);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pdf_bytes_match_size' AND conrelid = 'pdf_documents'::regclass) THEN
    ALTER TABLE pdf_documents ADD CONSTRAINT pdf_bytes_match_size CHECK (octet_length(pdf_data) = file_size_bytes);
    ALTER TABLE pdf_documents ADD CONSTRAINT pdf_sha256_format CHECK (sha256 ~ '^[a-f0-9]{64}$');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS resumes (
  resume_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  document_id UUID NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (document_id, user_id) REFERENCES pdf_documents(document_id, user_id) ON DELETE CASCADE
);
-- Upgrade the earlier Tiger schema, whose IDs were TEXT and whose document
-- metadata pointed outside Tiger Data. Existing columns and rows are preserved.
ALTER TABLE resumes ADD COLUMN IF NOT EXISTS document_id UUID;
CREATE INDEX IF NOT EXISTS idx_resumes_user ON resumes(user_id, uploaded_at DESC);

CREATE TABLE IF NOT EXISTS job_postings (
  job_posting_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  document_id UUID NOT NULL UNIQUE,
  title TEXT,
  company TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (job_posting_id, user_id),
  FOREIGN KEY (document_id, user_id) REFERENCES pdf_documents(document_id, user_id) ON DELETE CASCADE
);
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS document_id UUID;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS company TEXT;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT FALSE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job_postings' AND column_name = 'job_title') THEN
    EXECUTE 'UPDATE job_postings SET title = job_title WHERE title IS NULL AND job_title IS NOT NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job_postings' AND column_name = 'company_name') THEN
    EXECUTE 'UPDATE job_postings SET company = company_name WHERE company IS NULL AND company_name IS NOT NULL';
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_postings_id_owner ON job_postings(job_posting_id, user_id);
CREATE INDEX IF NOT EXISTS idx_job_postings_user ON job_postings(user_id, uploaded_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_posting_per_user ON job_postings(user_id) WHERE active;

CREATE TABLE IF NOT EXISTS baselines (
  baseline_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  baseline_stress_index DOUBLE PRECISION,
  baseline_pulse DOUBLE PRECISION,
  baseline_breathing_rate DOUBLE PRECISION,
  baseline_blink_rate DOUBLE PRECISION,
  baseline_fidget_score DOUBLE PRECISION,
  baseline_eda DOUBLE PRECISION,
  baseline_arterial_pressure DOUBLE PRECISION,
  baseline_breathing_amplitude DOUBLE PRECISION,
  baseline_inhale_exhale_ratio DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS idx_baselines_user_captured ON baselines(user_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  job_posting_id UUID,
  session_type TEXT NOT NULL CHECK (session_type IN ('interview', 'focus')),
  targeted_weakness TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  duration_seconds DOUBLE PRECISION GENERATED ALWAYS AS (EXTRACT(EPOCH FROM ended_at - started_at)) STORED,
  UNIQUE (session_id, user_id),
  FOREIGN KEY (job_posting_id, user_id) REFERENCES job_postings(job_posting_id, user_id),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK (session_type = 'interview' OR job_posting_id IS NULL)
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_type TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS targeted_weakness TEXT;
DO $migration$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'interview_type') THEN
    EXECUTE $$UPDATE sessions
      SET session_type = CASE WHEN lower(interview_type) = 'focus' THEN 'focus' ELSE 'interview' END
      WHERE session_type IS NULL$$;
  END IF;
END $migration$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_id_owner ON sessions(session_id, user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_started ON sessions(user_id, started_at DESC);
-- Calculate this count instead of maintaining a counter that can drift.
CREATE OR REPLACE VIEW user_summary AS
SELECT u.user_id, u.email, u.name, u.created_at, u.account_created_at,
       (SELECT count(*) FROM sessions s WHERE s.user_id = u.user_id) AS total_session_count
FROM users u;

CREATE TABLE IF NOT EXISTS session_metrics (
  session_id UUID NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  filler_word_count INTEGER CHECK (filler_word_count >= 0),
  filler_word_rate DOUBLE PRECISION,
  speaking_rate_wpm DOUBLE PRECISION,
  pause_frequency DOUBLE PRECISION,
  avg_pause_duration DOUBLE PRECISION,
  topic_relevance_score DOUBLE PRECISION,
  gaze_away_seconds DOUBLE PRECISION,
  posture_stability_score DOUBLE PRECISION,
  dominant_emotion TEXT,
  emotion_breakdown JSONB CHECK (jsonb_typeof(emotion_breakdown) = 'object'),
  stress_index_baevsky DOUBLE PRECISION,
  rmssd DOUBLE PRECISION,
  sdnn DOUBLE PRECISION,
  mean_nn DOUBLE PRECISION,
  pulse_rate DOUBLE PRECISION,
  breathing_rate DOUBLE PRECISION,
  blink_rate DOUBLE PRECISION,
  apnea_event_count INTEGER CHECK (apnea_event_count >= 0),
  fidget_score_seat DOUBLE PRECISION,
  fidget_score_knee DOUBLE PRECISION,
  eda_level DOUBLE PRECISION,
  arterial_pressure_relative DOUBLE PRECISION,
  breathing_upper_lower_ratio DOUBLE PRECISION,
  inhale_exhale_ratio DOUBLE PRECISION,
  respiratory_line_length DOUBLE PRECISION,
  breathing_amplitude DOUBLE PRECISION,
  consistency_confidence_score DOUBLE PRECISION,
  overall_session_score DOUBLE PRECISION CHECK (overall_session_score BETWEEN 1 AND 10),
  PRIMARY KEY (session_id, recorded_at),
  FOREIGN KEY (session_id, user_id) REFERENCES sessions(session_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_metrics_user_recorded ON session_metrics(user_id, recorded_at DESC);

ALTER TABLE users ADD COLUMN IF NOT EXISTS interview_profile JSONB;
ALTER TABLE baselines ADD COLUMN IF NOT EXISTS raw_data JSONB;
-- Earlier Callback schemas used a writable integer duration. Keep it in sync
-- without changing IDs or dropping dependent views/data.
CREATE OR REPLACE FUNCTION callback_legacy_session_duration() RETURNS trigger AS $$
BEGIN
  IF NEW.ended_at IS NOT NULL AND NEW.ended_at < NEW.started_at THEN
    RAISE EXCEPTION 'Session end precedes start' USING ERRCODE = '23514';
  END IF;
  NEW.duration_seconds := EXTRACT(EPOCH FROM NEW.ended_at - NEW.started_at);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'duration_seconds' AND is_generated = 'NEVER') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'callback_session_duration') THEN
      CREATE TRIGGER callback_session_duration BEFORE INSERT OR UPDATE ON sessions
      FOR EACH ROW EXECUTE FUNCTION callback_legacy_session_duration();
    END IF;
  END IF;
END $$;
