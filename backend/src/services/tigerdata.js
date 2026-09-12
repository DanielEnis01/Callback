// Tiger Data (Postgres/Timescale) — structured, time-ordered session metrics.
// Filler-word rate, gaze-away seconds, engagement/stress trend, Pomodoro logs.

export async function logSessionMetrics({ sessionId, metrics }) {
  // TODO: insert into hypertable
  throw new Error("tigerdata.logSessionMetrics not implemented");
}

export async function getSessionTrends({ userId }) {
  // TODO: query continuous aggregate for dashboard trend charts
  throw new Error("tigerdata.getSessionTrends not implemented");
}
