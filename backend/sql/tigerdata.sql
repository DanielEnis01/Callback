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
  -- Free-text job posting pasted into Session Setup for this specific
  -- session. Distinct from job_posting_id (a saved PDF job_postings
  -- record) -- most sessions just paste text ad hoc without uploading a
  -- PDF, so this is the primary place job-posting context for a session
  -- lives.
  job_posting_text TEXT,
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
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS job_posting_text TEXT;
-- The five planned questions for this session, as generated by
-- gemini.js's generateInterviewPlan. Persisted because the answers in the
-- transcript are meaningless without the questions they answer -- that
-- pairing is the unit Backboard stores and retrieves against.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS interview_plan JSONB
  CHECK (interview_plan IS NULL OR jsonb_typeof(interview_plan) = 'array');

-- The role this session was practising for, e.g. "Software Engineering
-- Intern at Lyft". Extracted by Gemini while it builds the question plan
-- (it has to read the posting anyway) rather than guessed from the text:
-- taking the posting's first line gave headings like "At Lyft, our purpose
-- is to serve and connect..." as the job title.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS position_label TEXT;
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
  nervousness_score DOUBLE PRECISION CHECK (nervousness_score BETWEEN 0 AND 100),
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
ALTER TABLE session_metrics ADD COLUMN IF NOT EXISTS nervousness_score DOUBLE PRECISION
  CHECK (nervousness_score BETWEEN 0 AND 100);
CREATE INDEX IF NOT EXISTS idx_metrics_user_recorded ON session_metrics(user_id, recorded_at DESC);

-- Per-session analysis, computed once (on demand, replaceable) from that
-- session's own session_metrics rows plus the user's calibrated baseline
-- and their own recent session history. Not an AI-generated summary and not
-- a fabricated score: signal_averages are plain AVG()s of recorded samples,
-- baseline_deltas/trend compare those to real stored numbers, and
-- overall_score is just the fraction of compared signals that came out
-- better. Absent signals are simply absent from the JSON, never zero-filled.
CREATE TABLE IF NOT EXISTS session_results (
  session_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
  signal_averages JSONB NOT NULL CHECK (jsonb_typeof(signal_averages) = 'object'),
  baseline_deltas JSONB NOT NULL CHECK (jsonb_typeof(baseline_deltas) = 'object'),
  trend JSONB NOT NULL CHECK (jsonb_typeof(trend) = 'object'),
  strengths JSONB NOT NULL CHECK (jsonb_typeof(strengths) = 'array'),
  weaknesses JSONB NOT NULL CHECK (jsonb_typeof(weaknesses) = 'array'),
  overall_score DOUBLE PRECISION CHECK (overall_score BETWEEN 0 AND 100),
  FOREIGN KEY (session_id, user_id) REFERENCES sessions(session_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_results_user_computed ON session_results(user_id, computed_at DESC);

-- AI transcript analysis: the language/content half of session analysis,
-- distinct from session_results above (which is purely the non-AI
-- biometric comparison against baseline/recent sessions). static_signals
-- is python/analysis_service.py's rule-based STAR-method/quantification/
-- filler-word output over the transcript -- always present. The ai_*
-- columns are Gemini's qualitative pass (see gemini.js's
-- generateTranscriptAnalysis) and are NULL together with a populated
-- ai_error when that stage failed (e.g. quota exhaustion) -- the static
-- half is still worth keeping in that case.
CREATE TABLE IF NOT EXISTS session_ai_analysis (
  session_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  static_signals JSONB NOT NULL CHECK (jsonb_typeof(static_signals) = 'object'),
  ai_strengths JSONB CHECK (ai_strengths IS NULL OR jsonb_typeof(ai_strengths) = 'array'),
  ai_weaknesses JSONB CHECK (ai_weaknesses IS NULL OR jsonb_typeof(ai_weaknesses) = 'array'),
  ai_summary TEXT,
  overall_score DOUBLE PRECISION CHECK (overall_score IS NULL OR overall_score BETWEEN 0 AND 100),
  ai_error TEXT,
  FOREIGN KEY (session_id, user_id) REFERENCES sessions(session_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_ai_analysis_user_computed ON session_ai_analysis(user_id, computed_at DESC);
-- Full transcript for this session, exactly as sent to /analysis/transcript.
-- Previously this only lived in memory on the frontend for the duration of
-- the session -- nothing persisted it, so a past session's "view transcript"
-- had nothing to show. Stored alongside the analysis that was already
-- computed from it (rather than a new table) since they're always written
-- together. Nullable/best-effort like everything else in this table.
ALTER TABLE session_ai_analysis ADD COLUMN IF NOT EXISTS transcript JSONB
  CHECK (transcript IS NULL OR jsonb_typeof(transcript) = 'array');
-- When this session's language was pushed to Backboard (see
-- services/backboard.js). NULL means never synced; the sync is idempotent
-- and best-effort, so this is a fast skip rather than a lock.
ALTER TABLE session_ai_analysis ADD COLUMN IF NOT EXISTS memory_synced_at TIMESTAMPTZ;

-- Short human title for the session, written by the same Gemini pass that
-- produces the summary (it has already read the whole transcript). The
-- Results header previously fell back to the job posting's opening line,
-- which produced titles like "At Lyft, our purpose is to serve and connect".
ALTER TABLE session_ai_analysis ADD COLUMN IF NOT EXISTS session_title TEXT;
-- Qualitative before/after against earlier sessions, written by the analysis
-- pass from semantically-matched prior answers (see backboard.js). Empty when
-- there is no history to compare against.
ALTER TABLE session_ai_analysis ADD COLUMN IF NOT EXISTS progress_notes JSONB
  CHECK (progress_notes IS NULL OR jsonb_typeof(progress_notes) = 'array');

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

-- Denormalized copy of sessions.session_type onto every session_metrics
-- row, kept in sync by a trigger rather than requiring every metrics
-- writer to know/pass it. Exists purely so the per-day continuous
-- aggregate below (session_metrics_daily, see sql/continuous_aggregates.sql)
-- can group by mode without joining a hypertable to a plain table inside
-- the aggregate definition.
ALTER TABLE session_metrics ADD COLUMN IF NOT EXISTS session_type TEXT;
CREATE OR REPLACE FUNCTION callback_session_metrics_denormalize() RETURNS trigger AS $$
BEGIN
  IF NEW.session_type IS NULL THEN
    SELECT s.session_type INTO NEW.session_type FROM sessions s WHERE s.session_id = NEW.session_id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'callback_session_metrics_denormalize') THEN
    CREATE TRIGGER callback_session_metrics_denormalize BEFORE INSERT ON session_metrics
    FOR EACH ROW EXECUTE FUNCTION callback_session_metrics_denormalize();
  END IF;
END $$;
-- Backfill existing rows written before this trigger existed.
UPDATE session_metrics m SET session_type = s.session_type
FROM sessions s WHERE s.session_id = m.session_id AND m.session_type IS NULL;

-- User-set (or system-suggested) targets for a specific weakness signal,
-- e.g. "get filler-word rate under 2/min". Progress and achievement are
-- computed on read (analytics.js) by comparing the rolling average for
-- signal_key against target_value in the given direction -- this table
-- only stores the target itself and when/if it was ever hit.
CREATE TABLE IF NOT EXISTS goals (
  goal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  signal_key TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('below', 'above')),
  target_value DOUBLE PRECISION NOT NULL,
  session_type TEXT CHECK (session_type IN ('interview', 'focus')),
  source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'system')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  achieved_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE
);
-- Goals are now always "reach X out of 10 within N sessions" against a
-- universal trait (see TRAIT_CATALOG), never "get this raw number under X".
-- Every trait is already normalised so that higher is better, which makes a
-- "get under" direction meaningless. signal_key holds the trait key;
-- direction stays for the older rows but new goals are always 'above'.
ALTER TABLE goals ADD COLUMN IF NOT EXISTS target_sessions INTEGER
  CHECK (target_sessions IS NULL OR target_sessions > 0);
CREATE INDEX IF NOT EXISTS idx_goals_user_active ON goals(user_id, active, created_at DESC);
-- Only one active goal per (signal, mode) at a time; mode NULL means "any mode".
CREATE UNIQUE INDEX IF NOT EXISTS one_active_goal_per_signal ON goals(user_id, signal_key, COALESCE(session_type, ''))
  WHERE active;

-- ── Backboard semantic memory ───────────────────────────────────────────
-- One Backboard assistant per user, holding only that user's memories.
-- Cross-user retrieval would be a serious leak, so tenancy is enforced by
-- the assistant boundary AND re-checked on every read (see backboard.js).
CREATE TABLE IF NOT EXISTS backboard_assistants (
  user_id      TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  assistant_id TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency receipts, one row per memory record we have written or are
-- writing. external_id is deterministic ("<sessionId>:<questionIndex>" or
-- "<sessionId>:note") so a retry can never duplicate a memory.
--
-- metadata is mirrored here on purpose. Backboard's search endpoint returns
-- id/content/score but NO metadata, and the vendor's answer to that is to
-- page through every memory the user owns on every single search. Keeping a
-- local copy turns that crawl into a join.
CREATE TABLE IF NOT EXISTS backboard_memories (
  user_id      TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  external_id  TEXT NOT NULL,
  session_id   UUID,
  kind         TEXT CHECK (kind IN ('qa_pair', 'session_note')),
  memory_id    TEXT,
  metadata     JSONB,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stored_at    TIMESTAMPTZ,
  PRIMARY KEY (user_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_backboard_memories_lookup ON backboard_memories(user_id, kind, session_id);
CREATE INDEX IF NOT EXISTS idx_backboard_memories_memory_id ON backboard_memories(user_id, memory_id);
