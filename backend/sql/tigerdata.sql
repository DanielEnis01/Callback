-- Tiger Data / Timescale Schema for Callback Session Metrics

-- Enable TimescaleDB extension if available
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- Table: interview_sessions
-- Stores per-session numeric metrics and summaries for fast trend aggregation.
CREATE TABLE IF NOT EXISTS interview_sessions (
    session_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    job_id TEXT,
    interview_type TEXT,
    duration_seconds INTEGER DEFAULT 0,
    backboard_thread_id TEXT,
    filler_word_count INTEGER DEFAULT 0,
    total_words INTEGER DEFAULT 0,
    filler_rate DOUBLE PRECISION DEFAULT 0.0,
    gaze_away_seconds INTEGER DEFAULT 0,
    gaze_away_percentage DOUBLE PRECISION DEFAULT 0.0,
    posture_score DOUBLE PRECISION,
    avg_stress_score DOUBLE PRECISION,
    max_stress_score DOUBLE PRECISION,
    avg_engagement_score DOUBLE PRECISION,
    avg_pulse DOUBLE PRECISION,
    min_pulse DOUBLE PRECISION,
    max_pulse DOUBLE PRECISION,
    avg_breathing_rate DOUBLE PRECISION,
    weakest_question_type TEXT,
    strongest_question_type TEXT,
    raw_metrics JSONB,
    PRIMARY KEY (created_at, session_id)
);

-- Index for fast user-specific historical lookups
CREATE INDEX IF NOT EXISTS idx_interview_sessions_user_time 
    ON interview_sessions (user_id, created_at DESC);

-- Convert to hypertable if TimescaleDB extension is present
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'create_hypertable'
    ) THEN
        PERFORM create_hypertable('interview_sessions', 'created_at', if_not_exists => TRUE);
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Hypertable conversion note: %', SQLERRM;
END $$;

