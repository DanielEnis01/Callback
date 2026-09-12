// Tiger Data (Postgres / TimescaleDB) — structured, time-ordered session metrics.
// Filler-word rate, gaze-away seconds, engagement/stress trend, pulse, vitals.

import pg from "pg";

const { Pool } = pg;

export function isTigerDataConfigured() {
  return Boolean(
    (process.env.TIGER_DATA_HOST && process.env.TIGER_DATA_PASSWORD) ||
    process.env.TIGERDATA_URL
  );
}

// Support both individual TIGER_DATA_* variables and TIGERDATA_URL
export const tigerDb = new Pool(
  process.env.TIGER_DATA_HOST
    ? {
        host: process.env.TIGER_DATA_HOST,
        port: Number(process.env.TIGER_DATA_PORT || 5432),
        user: process.env.TIGER_DATA_USER,
        password: process.env.TIGER_DATA_PASSWORD,
        database: process.env.TIGER_DATA_DATABASE || "tsdb",
        ssl: {
          rejectUnauthorized: false,
        },
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      }
    : process.env.TIGERDATA_URL
    ? {
        connectionString: process.env.TIGERDATA_URL,
        ssl: process.env.TIGERDATA_URL.includes("sslmode=disable")
          ? false
          : { rejectUnauthorized: false },
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      }
    : {}
);

tigerDb.on("error", (err) => {
  console.error("Unexpected error on idle TigerData PostgreSQL client", err);
});

export async function initTigerData() {
  if (!isTigerDataConfigured()) {
    console.warn(
      "TigerData configuration not found (set TIGER_DATA_HOST, TIGER_DATA_PORT, TIGER_DATA_USER, TIGER_DATA_PASSWORD, TIGER_DATA_DATABASE in backend/.env). Running without persistent database connection."
    );
    return false;
  }

  try {
    const connCheck = await tigerDb.query("SELECT NOW() as now;");
    console.log("TigerData connected:", connCheck.rows[0]);

    // Create table if not exists
    await tigerDb.query(`
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
    `);

    // Create index on user_id and created_at
    await tigerDb.query(`
      CREATE INDEX IF NOT EXISTS idx_interview_sessions_user_time 
      ON interview_sessions (user_id, created_at DESC);
    `);

    // Try converting to hypertable if TimescaleDB extension is present
    try {
      await tigerDb.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_proc WHERE proname = 'create_hypertable'
          ) THEN
            PERFORM create_hypertable('interview_sessions', 'created_at', if_not_exists => TRUE);
          END IF;
        EXCEPTION
          WHEN OTHERS THEN
            NULL;
        END $$;
      `);
    } catch (htErr) {
      // Hypertable conversion might already exist or not be supported
    }

    console.log("TigerData interview_sessions hypertable is ready");
    return true;
  } catch (err) {
    console.error("Failed to initialize TigerData database:", err.message);
    return false;
  }
}

export async function checkTigerDataHealth() {
  if (!isTigerDataConfigured()) {
    return {
      service: "tigerdata",
      status: "unconfigured",
      message:
        "TigerData environment variables (TIGER_DATA_HOST, TIGER_DATA_PASSWORD) are not set in backend/.env.",
    };
  }

  try {
    const res = await tigerDb.query(
      "SELECT NOW() as current_time, count(*) as count FROM interview_sessions;"
    );
    return {
      service: "tigerdata",
      status: "connected",
      message: "Successfully connected to TigerData hypertable.",
      totalSessionsRecorded: parseInt(res.rows[0]?.count || 0, 10),
      serverTime: res.rows[0]?.current_time,
    };
  } catch (err) {
    return {
      service: "tigerdata",
      status: "error",
      message: err.message,
    };
  }
}

export async function logSessionMetrics({
  sessionId,
  userId,
  metadata = {},
  metrics = {},
  createdAt = new Date(),
}) {
  if (!isTigerDataConfigured()) {
    throw new Error("TigerData is not configured (missing TIGER_DATA credentials).");
  }

  const {
    jobId = null,
    interviewType = null,
    durationSeconds = 0,
    backboardThreadId = null,
  } = metadata;

  const {
    fillerWordCount = 0,
    totalWords = 0,
    gazeAwaySeconds = 0,
    postureScore = null,
    avgStressScore = null,
    maxStressScore = null,
    avgEngagementScore = null,
    avgPulse = null,
    minPulse = null,
    maxPulse = null,
    avgBreathingRate = null,
    weakestQuestionType = null,
    strongestQuestionType = null,
    ...extraMetrics
  } = metrics;

  // Derive calculated rates
  const fillerRate =
    totalWords > 0
      ? Number(((fillerWordCount / totalWords) * 100).toFixed(2))
      : 0.0;

  const gazeAwayPercentage =
    durationSeconds > 0
      ? Number(((gazeAwaySeconds / durationSeconds) * 100).toFixed(2))
      : 0.0;

  const query = `
    INSERT INTO interview_sessions (
      session_id,
      user_id,
      created_at,
      job_id,
      interview_type,
      duration_seconds,
      backboard_thread_id,
      filler_word_count,
      total_words,
      filler_rate,
      gaze_away_seconds,
      gaze_away_percentage,
      posture_score,
      avg_stress_score,
      max_stress_score,
      avg_engagement_score,
      avg_pulse,
      min_pulse,
      max_pulse,
      avg_breathing_rate,
      weakest_question_type,
      strongest_question_type,
      raw_metrics
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
      $21, $22, $23
    )
    RETURNING *;
  `;

  const values = [
    sessionId,
    userId,
    createdAt,
    jobId,
    interviewType,
    durationSeconds,
    backboardThreadId,
    fillerWordCount,
    totalWords,
    fillerRate,
    gazeAwaySeconds,
    gazeAwayPercentage,
    postureScore,
    avgStressScore,
    maxStressScore,
    avgEngagementScore,
    avgPulse,
    minPulse,
    maxPulse,
    avgBreathingRate,
    weakestQuestionType,
    strongestQuestionType,
    JSON.stringify(extraMetrics),
  ];

  const result = await tigerDb.query(query, values);
  return result.rows[0];
}

export async function getRecentSessions({ userId, limit = 5 }) {
  if (!isTigerDataConfigured()) {
    throw new Error("TigerData is not configured (missing TIGER_DATA credentials).");
  }

  const query = `
    SELECT *
    FROM interview_sessions
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT $2;
  `;

  const result = await tigerDb.query(query, [userId, limit]);
  return result.rows;
}

export async function getSessionTrends({ userId, limit = 5 }) {
  const sessions = await getRecentSessions({ userId, limit });

  if (!sessions || sessions.length === 0) {
    return {
      userId,
      sessionCount: 0,
      trendSummary: "No previous interview session data available for this user.",
      recentSessions: [],
    };
  }

  if (sessions.length === 1) {
    const s = sessions[0];
    const weakInfo = s.weakest_question_type
      ? ` Weakest question type noted: ${s.weakest_question_type}.`
      : "";

    return {
      userId,
      sessionCount: 1,
      trendSummary: `Baseline established from 1 interview session: filler-word rate is ${s.filler_rate}%, average stress score is ${Number(s.avg_stress_score ?? 0).toFixed(2)}, engagement is ${Number(s.avg_engagement_score ?? 0).toFixed(2)}.${weakInfo}`,
      recentSessions: sessions,
    };
  }

  // sessions are in DESC order (latest first)
  const latest = sessions[0];
  const oldest = sessions[sessions.length - 1];

  // Calculate percentage improvements
  // For filler rate and stress: lower is better -> (oldest - latest) / oldest
  // For engagement: higher is better -> (latest - oldest) / oldest
  function calcImprovement(oldVal, newVal, lowerIsBetter = false) {
    const o = Number(oldVal ?? 0);
    const n = Number(newVal ?? 0);
    if (o === 0) return 0;
    const change = lowerIsBetter ? ((o - n) / o) * 100 : ((n - o) / o) * 100;
    return Math.round(change);
  }

  function formatImprovement(pct, metricName) {
    if (pct > 0) {
      return `${metricName} improved by ${pct}%`;
    } else if (pct < 0) {
      return `${metricName} worsened by ${Math.abs(pct)}%`;
    }
    return `${metricName} remained steady`;
  }

  const fillerChange = calcImprovement(
    oldest.filler_rate,
    latest.filler_rate,
    true
  );
  const stressChange = calcImprovement(
    oldest.avg_stress_score,
    latest.avg_stress_score,
    true
  );
  const engagementChange = calcImprovement(
    oldest.avg_engagement_score,
    latest.avg_engagement_score,
    false
  );

  // Weakest question type frequency
  const weakQuestionCounts = {};
  for (const s of sessions) {
    if (s.weakest_question_type) {
      weakQuestionCounts[s.weakest_question_type] =
        (weakQuestionCounts[s.weakest_question_type] || 0) + 1;
    }
  }

  let mostRepeatedWeak = null;
  let maxCount = 0;
  for (const [type, count] of Object.entries(weakQuestionCounts)) {
    if (count > maxCount) {
      mostRepeatedWeak = type;
      maxCount = count;
    }
  }

  const weakSummary = mostRepeatedWeak
    ? ` The most repeated weak question type was ${mostRepeatedWeak} (${maxCount} session${maxCount > 1 ? "s" : ""}).`
    : "";

  const trendSummary = `Across the last ${sessions.length} interview sessions, ${formatImprovement(
    fillerChange,
    "filler-word rate"
  )}, ${formatImprovement(stressChange, "average stress")}, ${formatImprovement(
    engagementChange,
    "engagement"
  )}.${weakSummary}`;

  return {
    userId,
    sessionCount: sessions.length,
    trendSummary,
    metrics: {
      fillerWordImprovementPercent: fillerChange,
      stressImprovementPercent: stressChange,
      engagementImprovementPercent: engagementChange,
      mostRepeatedWeakQuestionType: mostRepeatedWeak,
      mostRepeatedWeakCount: maxCount,
    },
    recentSessions: sessions,
  };
}
