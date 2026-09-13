-- Long-range per-signal trend view. This is the one place continuous
-- aggregates actually earn their keep over a plain table: the Dashboard
-- tab's full-history, zoomable trend charts need daily averages across
-- months of session_metrics without re-scanning every raw sample on every
-- request. Rolling 5-10 session views (Results tab) stay simple on-read
-- AVG()s over the last N rows -- a continuous aggregate bucketed by time
-- doesn't line up with "last N sessions" anyway.
--
-- Applied outside the main tigerdata.sql transaction (see initTigerData in
-- tigerdata.js) and tolerated as best-effort: continuous aggregates need
-- TimescaleDB's background-worker features, which may not be enabled on
-- every Tiger Data plan/tier, and creating one can't always run inside an
-- open transaction block. If this fails, analytics.js's long-range trend
-- query falls back to querying session_metrics directly (see
-- getSignalTrend's tryContinuousAggregate flag).
CREATE MATERIALIZED VIEW IF NOT EXISTS session_metrics_daily
WITH (timescaledb.continuous) AS
SELECT
  user_id,
  session_type,
  time_bucket('1 day', recorded_at) AS day,
  avg(filler_word_rate) AS filler_word_rate,
  avg(gaze_away_seconds) AS gaze_away_seconds,
  avg(stress_index_baevsky) AS stress_index_baevsky,
  avg(pulse_rate) AS pulse_rate,
  avg(breathing_rate) AS breathing_rate,
  avg(fidget_score_seat) AS fidget_score_seat,
  avg(fidget_score_knee) AS fidget_score_knee,
  avg((fidget_score_seat + fidget_score_knee) / 2.0) AS fidget_score,
  avg(consistency_confidence_score) AS consistency_confidence_score,
  avg(overall_session_score) AS overall_session_score,
  count(*) AS sample_count
FROM session_metrics
GROUP BY user_id, session_type, day
WITH NO DATA;

SELECT add_continuous_aggregate_policy('session_metrics_daily',
  start_offset => INTERVAL '5 years', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE);
