import "dotenv/config";
import {
  tigerDb,
  isTigerDataConfigured,
  initTigerData,
  logSessionMetrics,
  getSessionTrends,
} from "../src/services/tigerdata.js";

async function main() {
  console.log("=========================================");
  console.log("   TigerData Connectivity & Flow Test    ");
  console.log("=========================================\n");

  console.log("1. Checking environment configuration...");
  console.log("   TIGER_DATA_HOST:", process.env.TIGER_DATA_HOST || "(not set)");
  console.log("   TIGER_DATA_PORT:", process.env.TIGER_DATA_PORT || "(not set)");
  console.log("   TIGER_DATA_USER:", process.env.TIGER_DATA_USER || "(not set)");
  console.log("   TIGER_DATA_DATABASE:", process.env.TIGER_DATA_DATABASE || "(not set)");
  console.log("   TIGER_DATA_PASSWORD:", process.env.TIGER_DATA_PASSWORD ? "[set]" : "(not set)");

  if (!isTigerDataConfigured()) {
    console.error(
      "\n❌ TigerData is not configured! Please create backend/.env with your credentials."
    );
    process.exit(1);
  }

  console.log("\n2. Testing direct connection with `SELECT NOW()`...");
  try {
    const res = await tigerDb.query("SELECT NOW() as now;");
    console.log("   ✅ TigerData connected:", res.rows[0]);
  } catch (err) {
    console.error("   ❌ Connection failed:", err.message);
    process.exit(1);
  }

  console.log("\n3. Ensuring table and hypertable exist...");
  const initSuccess = await initTigerData();
  if (!initSuccess) {
    console.error("   ❌ Failed to initialize schema.");
    process.exit(1);
  }
  console.log("   ✅ Hypertable check completed.");

  console.log("\n4. Testing sample session insert...");
  const testUserId = "test-user-" + Date.now();
  const testSessionId = "test-session-" + Date.now();

  try {
    const inserted = await logSessionMetrics({
      sessionId: testSessionId,
      userId: testUserId,
      metadata: {
        jobId: "demo-role",
        interviewType: "behavioral",
        durationSeconds: 600,
        backboardThreadId: "thread-test",
      },
      metrics: {
        fillerWordCount: 12,
        totalWords: 800,
        gazeAwaySeconds: 30,
        postureScore: 88,
        avgStressScore: 0.52,
        maxStressScore: 0.75,
        avgEngagementScore: 0.85,
        avgPulse: 80,
        minPulse: 72,
        maxPulse: 95,
        avgBreathingRate: 16.5,
        weakestQuestionType: "conflict-resolution",
        strongestQuestionType: "leadership",
      },
    });
    console.log("   ✅ Inserted test session:", {
      sessionId: inserted.session_id,
      fillerRate: inserted.filler_rate + "%",
      gazeAwayPercentage: inserted.gaze_away_percentage + "%",
    });

    console.log("\n5. Testing trend retrieval for the test user...");
    const trends = await getSessionTrends({ userId: testUserId, limit: 5 });
    console.log("   ✅ Retrieved trends:");
    console.log("   Trend Summary:", trends.trendSummary);

    console.log("\n🎉 All TigerData checks passed successfully!");
  } catch (err) {
    console.error("   ❌ Test insert/query failed:", err.message);
  } finally {
    await tigerDb.end();
    process.exit(0);
  }
}

main();

