// TigerData (PostgreSQL / TimescaleDB)
// Passive numeric ledger for Callback session metrics, user trends, baselines, and metadata.

import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
      "TigerData configuration not found (set TIGER_DATA_HOST, TIGER_DATA_PORT, etc. in backend/.env). Running without persistent database connection."
    );
    return false;
  }

  try {
    const connCheck = await tigerDb.query("SELECT NOW() as now;");
    console.log("TigerData connected:", connCheck.rows[0]);

    // Load and execute the full DDL schema from sql/tigerdata.sql
    const sqlPath = path.resolve(__dirname, "../../sql/tigerdata.sql");
    if (fs.existsSync(sqlPath)) {
      const sqlContent = fs.readFileSync(sqlPath, "utf-8");
      await tigerDb.query(sqlContent);
    } else {
      console.warn("SQL schema file not found at", sqlPath);
    }

    console.log("TigerData schema, views, and session_metrics hypertable are ready");
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
      "SELECT NOW() as current_time, (SELECT count(*) FROM sessions) as session_count, (SELECT count(*) FROM session_metrics) as metrics_count;"
    );
    return {
      service: "tigerdata",
      status: "connected",
      message: "Successfully connected to TigerData hypertable & views.",
      totalSessions: parseInt(res.rows[0]?.session_count || 0, 10),
      totalMetrics: parseInt(res.rows[0]?.metrics_count || 0, 10),
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

export async function ensureUserExists({ userId, email = null, name = null }) {
  if (!userId) throw new Error("userId is required");
  const query = `
    INSERT INTO users (user_id, email, name)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id) DO UPDATE 
    SET 
      email = COALESCE(EXCLUDED.email, users.email),
      name = COALESCE(EXCLUDED.name, users.name)
    RETURNING *;
  `;
  const res = await tigerDb.query(query, [userId, email, name]);
  return res.rows[0];
}

export async function recordResumeMetadata({
  resumeId,
  userId,
  filename,
  backboardDocumentId = null,
}) {
  if (!filename || !filename.toLowerCase().endsWith(".pdf")) {
    throw new Error("Filename must have a .pdf extension.");
  }
  await ensureUserExists({ userId });

  const query = `
    INSERT INTO resumes (resume_id, user_id, filename, backboard_document_id)
    VALUES ($1, $2, $3, $4)
    RETURNING *;
  `;
  const res = await tigerDb.query(query, [
    resumeId,
    userId,
    filename,
    backboardDocumentId,
  ]);
  return res.rows[0];
}

export async function recordJobPostingMetadata({
  jobPostingId,
  userId,
  jobTitle = null,
  companyName = null,
  filename = null,
  backboardDocumentId = null,
}) {
  await ensureUserExists({ userId });

  const query = `
    INSERT INTO job_postings (
      job_posting_id,
      user_id,
      job_title,
      company_name,
      filename,
      backboard_document_id
    ) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (job_posting_id) DO UPDATE
    SET 
      job_title = COALESCE(EXCLUDED.job_title, job_postings.job_title),
      company_name = COALESCE(EXCLUDED.company_name, job_postings.company_name),
      backboard_document_id = COALESCE(EXCLUDED.backboard_document_id, job_postings.backboard_document_id)
    RETURNING *;
  `;
  const res = await tigerDb.query(query, [
    jobPostingId,
    userId,
    jobTitle,
    companyName,
    filename,
    backboardDocumentId,
  ]);
  return res.rows[0];
}

export async function recordBaseline({
  baselineId,
  userId,
  baselineData = {},
  capturedAt = new Date(),
}) {
  await ensureUserExists({ userId });

  const {
    stressIndex = null,
    pulse = null,
    breathingRate = null,
    blinkRate = null,
    fidgetScore = null,
    eda = null,
    arterialPressure = null,
    breathingAmplitude = null,
    inhaleExhaleRatio = null,
    ...raw
  } = baselineData;

  const query = `
    INSERT INTO baselines (
      baseline_id,
      user_id,
      captured_at,
      baseline_stress_index,
      baseline_pulse,
      baseline_breathing_rate,
      baseline_blink_rate,
      baseline_fidget_score,
      baseline_eda,
      baseline_arterial_pressure,
      baseline_breathing_amplitude,
      baseline_inhale_exhale_ratio,
      raw_data
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING *;
  `;

  const values = [
    baselineId,
    userId,
    capturedAt,
    stressIndex,
    pulse,
    breathingRate,
    blinkRate,
    fidgetScore,
    eda,
    arterialPressure,
    breathingAmplitude,
    inhaleExhaleRatio,
    JSON.stringify(raw),
  ];

  const res = await tigerDb.query(query, values);
  return res.rows[0];
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

  // 1. Ensure user exists
  await ensureUserExists({ userId });

  // 2. Insert into relational sessions table (triggers users.total_session_count + 1)
  const {
    jobPostingId = null,
    jobId = null,
    interviewType = "general",
    durationSeconds = 0,
    backboardThreadId = null,
    status = "completed",
  } = metadata;

  const resolvedJobPostingId = jobPostingId || jobId;
  let validJobPostingId = null;

  if (resolvedJobPostingId) {
    // Upsert stub job posting if it doesn't exist yet to satisfy foreign key
    await tigerDb.query(
      `
        INSERT INTO job_postings (job_posting_id, user_id, job_title)
        VALUES ($1, $2, $3)
        ON CONFLICT (job_posting_id) DO NOTHING;
      `,
      [resolvedJobPostingId, userId, resolvedJobPostingId]
    );
    validJobPostingId = resolvedJobPostingId;
  }

  // Insert or ignore if session already exists
  await tigerDb.query(
    `
      INSERT INTO sessions (
        session_id,
        user_id,
        job_posting_id,
        interview_type,
        started_at,
        duration_seconds,
        status,
        backboard_thread_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (session_id) DO NOTHING;
    `,
    [
      sessionId,
      userId,
      validJobPostingId,
      interviewType,
      createdAt,
      durationSeconds,
      status,
      backboardThreadId,
    ]
  );

  // 3. Extract and compute session metrics
  const {
    fillerWordCount = 0,
    totalWords = 0,
    fillerWordRate = null,
    speakingRateWpm = null,
    pauseFrequency = null,
    avgPauseDuration = null,
    topicRelevanceScore = null,

    gazeAwaySeconds = 0,
    postureStabilityScore = null,
    postureScore = null,

    dominantEmotion = null,
    emotionBreakdown = null,
    stressIndexBaevsky = null,
    avgStressScore = null,
    rmssd = null,
    sdnn = null,
    meanNn = null,
    pulseRate = null,
    avgPulse = null,
    breathingRate = null,
    avgBreathingRate = null,
    blinkRate = null,

    apneaEventCount = 0,
    fidgetScoreSeat = null,
    fidgetScoreKnee = null,
    edaLevel = null,
    arterialPressureRelative = null,
    breathingUpperLowerRatio = null,
    inhaleExhaleRatio = null,
    respiratoryLineLength = null,
    breathingAmplitude = null,

    consistencyConfidenceScore = null,
    overallSessionScore = null,
    avgEngagementScore = null,
    weakestQuestionType = null,
    strongestQuestionType = null,
    ...extraMetrics
  } = metrics;

  // Resolved metrics with fallback support
  const resolvedFillerRate =
    fillerWordRate !== null
      ? fillerWordRate
      : totalWords > 0
      ? Number(((fillerWordCount / totalWords) * 100).toFixed(2))
      : 0.0;

  const resolvedStress =
    stressIndexBaevsky !== null ? stressIndexBaevsky : avgStressScore;
  const resolvedPulse = pulseRate !== null ? pulseRate : avgPulse;
  const resolvedBreathingRate =
    breathingRate !== null ? breathingRate : avgBreathingRate;
  const resolvedPosture =
    postureStabilityScore !== null ? postureStabilityScore : postureScore;
  const resolvedOverallScore =
    overallSessionScore !== null
      ? overallSessionScore
      : avgEngagementScore !== null
      ? Number((avgEngagementScore * 10).toFixed(1))
      : null;

  // 4. Insert into session_metrics hypertable
  const insertMetricQuery = `
    INSERT INTO session_metrics (
      recorded_at,
      session_id,
      user_id,

      filler_word_count,
      filler_word_rate,
      speaking_rate_wpm,
      pause_frequency,
      avg_pause_duration,
      topic_relevance_score,

      gaze_away_seconds,
      posture_stability_score,

      dominant_emotion,
      emotion_breakdown,
      stress_index_baevsky,
      rmssd,
      sdnn,
      mean_nn,
      pulse_rate,
      breathing_rate,
      blink_rate,

      apnea_event_count,
      fidget_score_seat,
      fidget_score_knee,
      eda_level,
      arterial_pressure_relative,
      breathing_upper_lower_ratio,
      inhale_exhale_ratio,
      respiratory_line_length,
      breathing_amplitude,

      consistency_confidence_score,
      overall_session_score,
      weakest_question_type,
      strongest_question_type,
      raw_metrics
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
      $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
      $31, $32, $33, $34
    )
    RETURNING *;
  `;

  const values = [
    createdAt,
    sessionId,
    userId,

    fillerWordCount,
    resolvedFillerRate,
    speakingRateWpm,
    pauseFrequency,
    avgPauseDuration,
    topicRelevanceScore,

    gazeAwaySeconds,
    resolvedPosture,

    dominantEmotion,
    emotionBreakdown ? JSON.stringify(emotionBreakdown) : null,
    resolvedStress,
    rmssd,
    sdnn,
    meanNn,
    resolvedPulse,
    resolvedBreathingRate,
    blinkRate,

    apneaEventCount,
    fidgetScoreSeat,
    fidgetScoreKnee,
    edaLevel,
    arterialPressureRelative,
    breathingUpperLowerRatio,
    inhaleExhaleRatio,
    respiratoryLineLength,
    breathingAmplitude,

    consistencyConfidenceScore,
    resolvedOverallScore,
    weakestQuestionType,
    strongestQuestionType,
    JSON.stringify(extraMetrics),
  ];

  const res = await tigerDb.query(insertMetricQuery, values);
  return res.rows[0];
}

export async function getRecentSessions({ userId, limit = 5 }) {
  if (!isTigerDataConfigured()) {
    throw new Error("TigerData is not configured (missing TIGER_DATA credentials).");
  }

  const query = `
    SELECT 
      s.session_id,
      s.user_id,
      s.job_posting_id,
      s.interview_type,
      s.started_at,
      s.duration_seconds,
      s.status,
      m.filler_word_count,
      m.filler_word_rate,
      m.gaze_away_seconds,
      m.stress_index_baevsky,
      m.pulse_rate,
      m.breathing_rate,
      m.overall_session_score,
      m.weakest_question_type,
      m.strongest_question_type,
      m.emotion_breakdown
    FROM sessions s
    LEFT JOIN session_metrics m ON s.session_id = m.session_id
    WHERE s.user_id = $1
    ORDER BY s.started_at DESC
    LIMIT $2;
  `;

  const result = await tigerDb.query(query, [userId, limit]);
  return result.rows;
}

export async function getSessionMetricsWithBaselineDeltas({ userId, limit = 5 }) {
  const query = `
    SELECT *
    FROM session_metrics_with_baseline_delta
    WHERE user_id = $1
    ORDER BY recorded_at DESC
    LIMIT $2;
  `;
  const result = await tigerDb.query(query, [userId, limit]);
  return result.rows;
}

export async function getSessionTrends({ userId, limit = 5 }) {
  const sessions = await getRecentSessions({ userId, limit });

  // Also query the rolling averages view
  let rolling = null;
  try {
    const rollingRes = await tigerDb.query(
      `SELECT * FROM latest_user_metric_trends WHERE user_id = $1;`,
      [userId]
    );
    rolling = rollingRes.rows[0] || null;
  } catch (err) {
    // view might be empty or fallback
  }

  if (!sessions || sessions.length === 0) {
    return {
      userId,
      sessionCount: 0,
      trendSummary: "No previous interview session data available for this user.",
      rollingAverages: null,
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
      trendSummary: `Baseline established from 1 interview session: filler-word rate is ${s.filler_word_rate}%, stress score is ${Number(s.stress_index_baevsky ?? 0).toFixed(2)}, overall score is ${Number(s.overall_session_score ?? 0).toFixed(2)}.${weakInfo}`,
      rollingAverages: rolling,
      recentSessions: sessions,
    };
  }

  // sessions are in DESC order (latest first)
  const latest = sessions[0];
  const oldest = sessions[sessions.length - 1];

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
    oldest.filler_word_rate,
    latest.filler_word_rate,
    true
  );
  const stressChange = calcImprovement(
    oldest.stress_index_baevsky,
    latest.stress_index_baevsky,
    true
  );
  const scoreChange = calcImprovement(
    oldest.overall_session_score,
    latest.overall_session_score,
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
    scoreChange,
    "overall score"
  )}.${weakSummary}`;

  return {
    userId,
    sessionCount: sessions.length,
    trendSummary,
    metrics: {
      fillerWordImprovementPercent: fillerChange,
      stressImprovementPercent: stressChange,
      scoreImprovementPercent: scoreChange,
      mostRepeatedWeakQuestionType: mostRepeatedWeak,
      mostRepeatedWeakCount: maxCount,
    },
    rollingAverages: rolling,
    recentSessions: sessions,
  };
}
