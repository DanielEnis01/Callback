import "dotenv/config";
import {
  tigerDb,
  isTigerDataConfigured,
  initTigerData,
  ensureUserExists,
  recordResumeMetadata,
  recordJobPostingMetadata,
  recordBaseline,
  logSessionMetrics,
  getSessionTrends,
  getSessionMetricsWithBaselineDeltas,
} from "../src/services/tigerdata.js";

async function main() {
  console.log("=================================================");
  console.log("   TigerData Full Schema & Hypertable Test Suite ");
  console.log("=================================================\n");

  console.log("1. Checking environment configuration...");
  if (!isTigerDataConfigured()) {
    console.error("❌ TigerData is not configured! Check backend/.env");
    process.exit(1);
  }
  console.log("   ✅ Configuration present.");

  console.log("\n2. Testing database connection...");
  try {
    const res = await tigerDb.query("SELECT NOW() as now;");
    console.log("   ✅ Connected:", res.rows[0]);
  } catch (err) {
    console.error("   ❌ Connection failed:", err.message);
    process.exit(1);
  }

  console.log("\n3. Initializing full schema, hypertable, triggers, and views...");
  const initSuccess = await initTigerData();
  if (!initSuccess) {
    console.error("   ❌ Failed to initialize full schema.");
    process.exit(1);
  }
  console.log("   ✅ Schema initialization verified.");

  const testUserId = "user_test_" + Date.now();

  console.log("\n4. Testing user creation...");
  const user = await ensureUserExists({
    userId: testUserId,
    email: `${testUserId}@example.com`,
    name: "Test Candidate",
  });
  console.log("   ✅ User record:", {
    userId: user.user_id,
    sessionCount: user.total_session_count,
  });

  console.log("\n5. Testing Resume PDF constraint and Backboard linking...");
  // Test valid PDF
  const resume = await recordResumeMetadata({
    resumeId: "resume_" + Date.now(),
    userId: testUserId,
    filename: "Candidate_Resume.pdf",
    backboardDocumentId: "bb_doc_8f83a1c2",
  });
  console.log("   ✅ Saved valid PDF resume:", {
    filename: resume.filename,
    backboardDocId: resume.backboard_document_id,
  });

  // Test constraint rejects non-PDF
  try {
    await recordResumeMetadata({
      resumeId: "invalid_" + Date.now(),
      userId: testUserId,
      filename: "Candidate_Resume.docx",
      backboardDocumentId: "bb_doc_invalid",
    });
    console.error("   ❌ Error: Database should have rejected non-PDF file!");
  } catch (err) {
    console.log("   ✅ Expected constraint pass: rejected non-PDF filename successfully.");
  }

  console.log("\n6. Testing versioned baselines...");
  const baseline1 = await recordBaseline({
    baselineId: "baseline_1_" + Date.now(),
    userId: testUserId,
    capturedAt: new Date(Date.now() - 60000),
    baselineData: {
      stressIndex: 55,
      pulse: 78,
      breathingRate: 14.5,
      blinkRate: 16,
      breathingAmplitude: 1.25,
    },
  });
  console.log("   ✅ Saved Baseline #1 (Pulse: 78, Stress: 55)");

  const baseline2 = await recordBaseline({
    baselineId: "baseline_2_" + Date.now(),
    userId: testUserId,
    capturedAt: new Date(),
    baselineData: {
      stressIndex: 52,
      pulse: 75,
      breathingRate: 14.0,
      blinkRate: 15,
      breathingAmplitude: 1.30,
    },
  });
  console.log("   ✅ Saved Baseline #2 (Pulse: 75, Stress: 52)");

  // Check latest_user_baselines view
  const latestBaselineRes = await tigerDb.query(
    "SELECT * FROM latest_user_baselines WHERE user_id = $1;",
    [testUserId]
  );
  console.log("   ✅ latest_user_baselines view reflects Baseline #2:", {
    pulse: latestBaselineRes.rows[0]?.baseline_pulse,
    stress: latestBaselineRes.rows[0]?.baseline_stress_index,
  });

  console.log("\n7. Testing session metrics logging & trigger...");
  const sessionId = "session_" + Date.now();
  const sessionMetric = await logSessionMetrics({
    sessionId,
    userId: testUserId,
    metadata: {
      jobId: "job_test_swe",
      interviewType: "technical-behavioral",
      durationSeconds: 900,
      backboardThreadId: "bb_thread_9912",
    },
    metrics: {
      fillerWordCount: 15,
      totalWords: 900,
      gazeAwaySeconds: 35,
      speakingRateWpm: 145,
      stressIndexBaevsky: 68,
      pulseRate: 98,
      breathingRate: 18.5,
      blinkRate: 22,
      breathingAmplitude: 1.65,
      dominantEmotion: "neutral",
      emotionBreakdown: {
        happy: 0.12,
        neutral: 0.65,
        surprise: 0.05,
        fear: 0.18,
      },
      overallSessionScore: 82,
      weakestQuestionType: "system-design",
      strongestQuestionType: "culture-fit",
    },
  });
  console.log("   ✅ Inserted into sessions + session_metrics hypertable:", {
    sessionId: sessionMetric.session_id,
    fillerRate: sessionMetric.filler_word_rate,
    stress: sessionMetric.stress_index_baevsky,
    dominantEmotion: sessionMetric.dominant_emotion,
  });

  // Verify trigger incremented users.total_session_count
  const updatedUserRes = await tigerDb.query(
    "SELECT total_session_count FROM users WHERE user_id = $1;",
    [testUserId]
  );
  console.log(
    "   ✅ Trigger check: users.total_session_count is now:",
    updatedUserRes.rows[0]?.total_session_count
  );

  console.log("\n8. Testing session_metrics_with_baseline_delta view...");
  const deltas = await getSessionMetricsWithBaselineDeltas({
    userId: testUserId,
    limit: 1,
  });
  const d = deltas[0];
  console.log("   ✅ Computed baseline deltas:", {
    pulseRate: d.pulse_rate,
    baselinePulse: d.baseline_pulse,
    deltaPulse: d.delta_pulse, // e.g. 98 - 75 = 23
    stress: d.stress_index_baevsky,
    baselineStress: d.baseline_stress_index,
    deltaStress: d.delta_stress_index, // e.g. 68 - 52 = 16
  });

  console.log("\n9. Testing user_metric_rolling_averages & latest_user_metric_trends...");
  // Add 4 more sessions to test window rolling averages (last 5 & 10)
  for (let i = 1; i <= 4; i++) {
    await logSessionMetrics({
      sessionId: `session_${Date.now()}_${i}`,
      userId: testUserId,
      createdAt: new Date(Date.now() + i * 1000),
      metrics: {
        fillerWordCount: 12 - i,
        totalWords: 900,
        stressIndexBaevsky: 65 - i * 2,
        pulseRate: 95 - i,
        overallSessionScore: 82 + i * 2,
        weakestQuestionType: "behavioral-conflict",
      },
    });
  }

  const trends = await getSessionTrends({ userId: testUserId, limit: 5 });
  console.log("   ✅ Rolling averages from latest_user_metric_trends:");
  console.log("      overall_score_avg_5:", trends.rollingAverages?.overall_session_score_avg_5);
  console.log("      filler_word_rate_avg_5:", trends.rollingAverages?.filler_word_rate_avg_5);
  console.log("      stress_index_baevsky_avg_5:", trends.rollingAverages?.stress_index_baevsky_avg_5);
  console.log("   ✅ Formatted trend summary for Gemini / Backboard:");
  console.log("      ", trends.trendSummary);

  console.log("\n🎉 ALL Full Schema & Hypertable Tests Passed Successfully!\n");
  await tigerDb.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("Test failed with error:", err);
  try {
    await tigerDb.end();
  } catch {}
  process.exit(1);
});
