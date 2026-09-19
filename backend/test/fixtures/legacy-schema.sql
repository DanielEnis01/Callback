-- TigerData (TimescaleDB / PostgreSQL) Schema for Callback

-- 1. Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- 2. Users Table
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    total_session_count INTEGER NOT NULL DEFAULT 0
);

-- 3. Resumes Table
-- Stores metadata only; binary PDF and parsed chunks live in Backboard.
CREATE TABLE IF NOT EXISTS resumes (
    resume_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    filename TEXT NOT NULL CHECK (lower(filename) LIKE '%.pdf'),
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    backboard_document_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_resumes_user_id ON resumes(user_id);

-- 4. Job Postings Table
-- Stores metadata only; job posting text and RAG content live in Backboard.
CREATE TABLE IF NOT EXISTS job_postings (
    job_posting_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    job_title TEXT,
    company_name TEXT,
    filename TEXT,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    backboard_document_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_job_postings_user_id ON job_postings(user_id);

-- 5. Baselines Table
-- Versioned by captured_at so each user can have sequential baselines (Baseline #1, #2, etc.)
CREATE TABLE IF NOT EXISTS baselines (
    baseline_id TEXT PRIMARY KEY,
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
    baseline_inhale_exhale_ratio DOUBLE PRECISION,
    raw_data JSONB
);

CREATE INDEX IF NOT EXISTS idx_baselines_user_captured ON baselines(user_id, captured_at DESC);

-- 6. Sessions Table
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    job_posting_id TEXT REFERENCES job_postings(job_posting_id) ON DELETE SET NULL,
    interview_type TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    duration_seconds INTEGER DEFAULT 0,
    status TEXT DEFAULT 'completed',
    backboard_thread_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_time ON sessions(user_id, started_at DESC);

-- 7. Trigger: Automatically increment users.total_session_count
CREATE OR REPLACE FUNCTION update_user_session_count()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE users 
    SET total_session_count = total_session_count + 1 
    WHERE user_id = NEW.user_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_increment_session_count ON sessions;
CREATE TRIGGER trg_increment_session_count
AFTER INSERT ON sessions
FOR EACH ROW
EXECUTE FUNCTION update_user_session_count();

-- 8. Session Metrics Hypertable
-- Stores high-granularity or end-of-session measurement records.
CREATE TABLE IF NOT EXISTS session_metrics (
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    session_id TEXT NOT NULL,
    user_id TEXT NOT NULL,

    -- Speech
    filler_word_count INTEGER DEFAULT 0,
    filler_word_rate DOUBLE PRECISION DEFAULT 0.0,
    speaking_rate_wpm DOUBLE PRECISION,
    pause_frequency DOUBLE PRECISION,
    avg_pause_duration DOUBLE PRECISION,
    topic_relevance_score DOUBLE PRECISION,

    -- Perception
    gaze_away_seconds DOUBLE PRECISION DEFAULT 0.0,
    posture_stability_score DOUBLE PRECISION,

    -- Legacy camera-vitals provider fields
    dominant_emotion TEXT,
    emotion_breakdown JSONB,
    stress_index_baevsky DOUBLE PRECISION,
    rmssd DOUBLE PRECISION,
    sdnn DOUBLE PRECISION,
    mean_nn DOUBLE PRECISION,
    pulse_rate DOUBLE PRECISION,
    breathing_rate DOUBLE PRECISION,
    blink_rate DOUBLE PRECISION,

    -- Additional legacy camera-vitals fields
    apnea_event_count INTEGER DEFAULT 0,
    fidget_score_seat DOUBLE PRECISION,
    fidget_score_knee DOUBLE PRECISION,
    eda_level DOUBLE PRECISION,
    arterial_pressure_relative DOUBLE PRECISION,
    breathing_upper_lower_ratio DOUBLE PRECISION,
    inhale_exhale_ratio DOUBLE PRECISION,
    respiratory_line_length DOUBLE PRECISION,
    breathing_amplitude DOUBLE PRECISION,

    -- Computed
    consistency_confidence_score DOUBLE PRECISION,
    overall_session_score DOUBLE PRECISION,
    weakest_question_type TEXT,
    strongest_question_type TEXT,
    raw_metrics JSONB,

    PRIMARY KEY (recorded_at, session_id)
);

CREATE INDEX IF NOT EXISTS idx_session_metrics_user_time 
    ON session_metrics (user_id, recorded_at DESC);

-- Convert session_metrics to Timescale hypertable
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'create_hypertable'
    ) THEN
        PERFORM create_hypertable('session_metrics', 'recorded_at', if_not_exists => TRUE);
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Hypertable conversion note: %', SQLERRM;
END $$;

-- 9. View: latest_user_baselines
CREATE OR REPLACE VIEW latest_user_baselines AS
SELECT DISTINCT ON (user_id)
    user_id,
    baseline_id,
    captured_at,
    baseline_stress_index,
    baseline_pulse,
    baseline_breathing_rate,
    baseline_blink_rate,
    baseline_fidget_score,
    baseline_eda,
    baseline_arterial_pressure,
    baseline_breathing_amplitude,
    baseline_inhale_exhale_ratio
FROM baselines
ORDER BY user_id, captured_at DESC;

-- 10. View: session_metrics_with_baseline_delta
CREATE OR REPLACE VIEW session_metrics_with_baseline_delta AS
SELECT 
    m.recorded_at,
    m.session_id,
    m.user_id,
    m.overall_session_score,
    m.filler_word_count,
    m.filler_word_rate,
    m.gaze_away_seconds,
    m.pulse_rate,
    b.baseline_pulse,
    ROUND((m.pulse_rate - b.baseline_pulse)::numeric, 2) AS delta_pulse,
    m.stress_index_baevsky,
    b.baseline_stress_index,
    ROUND((m.stress_index_baevsky - b.baseline_stress_index)::numeric, 2) AS delta_stress_index,
    m.breathing_rate,
    b.baseline_breathing_rate,
    ROUND((m.breathing_rate - b.baseline_breathing_rate)::numeric, 2) AS delta_breathing_rate,
    m.blink_rate,
    b.baseline_blink_rate,
    ROUND((m.blink_rate - b.baseline_blink_rate)::numeric, 2) AS delta_blink_rate,
    m.breathing_amplitude,
    b.baseline_breathing_amplitude,
    ROUND((m.breathing_amplitude - b.baseline_breathing_amplitude)::numeric, 4) AS delta_breathing_amplitude,
    m.dominant_emotion,
    m.emotion_breakdown,
    m.weakest_question_type,
    m.strongest_question_type
FROM session_metrics m
LEFT JOIN latest_user_baselines b ON m.user_id = b.user_id;

-- 11. View: user_metric_rolling_averages (last 5 & 10 sessions)
CREATE OR REPLACE VIEW user_metric_rolling_averages AS
SELECT 
    recorded_at,
    session_id,
    user_id,
    overall_session_score,
    ROUND(AVG(overall_session_score) OVER (
        PARTITION BY user_id 
        ORDER BY recorded_at 
        ROWS BETWEEN 4 PRECEDING AND CURRENT ROW
    )::numeric, 2) AS overall_session_score_avg_5,
    ROUND(AVG(overall_session_score) OVER (
        PARTITION BY user_id 
        ORDER BY recorded_at 
        ROWS BETWEEN 9 PRECEDING AND CURRENT ROW
    )::numeric, 2) AS overall_session_score_avg_10,

    filler_word_rate,
    ROUND(AVG(filler_word_rate) OVER (
        PARTITION BY user_id 
        ORDER BY recorded_at 
        ROWS BETWEEN 4 PRECEDING AND CURRENT ROW
    )::numeric, 3) AS filler_word_rate_avg_5,
    ROUND(AVG(filler_word_rate) OVER (
        PARTITION BY user_id 
        ORDER BY recorded_at 
        ROWS BETWEEN 9 PRECEDING AND CURRENT ROW
    )::numeric, 3) AS filler_word_rate_avg_10,

    stress_index_baevsky,
    ROUND(AVG(stress_index_baevsky) OVER (
        PARTITION BY user_id 
        ORDER BY recorded_at 
        ROWS BETWEEN 4 PRECEDING AND CURRENT ROW
    )::numeric, 2) AS stress_index_baevsky_avg_5,
    ROUND(AVG(stress_index_baevsky) OVER (
        PARTITION BY user_id 
        ORDER BY recorded_at 
        ROWS BETWEEN 9 PRECEDING AND CURRENT ROW
    )::numeric, 2) AS stress_index_baevsky_avg_10,

    pulse_rate,
    ROUND(AVG(pulse_rate) OVER (
        PARTITION BY user_id 
        ORDER BY recorded_at 
        ROWS BETWEEN 4 PRECEDING AND CURRENT ROW
    )::numeric, 1) AS pulse_rate_avg_5,
    ROUND(AVG(pulse_rate) OVER (
        PARTITION BY user_id 
        ORDER BY recorded_at 
        ROWS BETWEEN 9 PRECEDING AND CURRENT ROW
    )::numeric, 1) AS pulse_rate_avg_10,

    ROW_NUMBER() OVER (
        PARTITION BY user_id 
        ORDER BY recorded_at DESC
    ) AS row_num
FROM session_metrics;

-- 12. View: latest_user_metric_trends
CREATE OR REPLACE VIEW latest_user_metric_trends AS
SELECT 
    user_id,
    recorded_at AS last_session_at,
    session_id AS last_session_id,
    overall_session_score_avg_5,
    overall_session_score_avg_10,
    filler_word_rate_avg_5,
    filler_word_rate_avg_10,
    stress_index_baevsky_avg_5,
    stress_index_baevsky_avg_10,
    pulse_rate_avg_5,
    pulse_rate_avg_10
FROM user_metric_rolling_averages
WHERE row_num = 1;
