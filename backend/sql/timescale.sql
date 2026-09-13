-- Requires TimescaleDB to be enabled on the Tiger Data service.
SELECT create_hypertable('session_metrics', 'recorded_at', if_not_exists => TRUE, migrate_data => TRUE);
-- Last-5/10-session averages and baseline deltas are computed on read: time
-- buckets do not represent an exact number of sessions. No invented scoring rules.
