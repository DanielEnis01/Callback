import { Router } from "express";
import {
  logSessionMetrics,
  getSessionTrends,
  getRecentSessions,
  recordBaseline,
  recordResumeMetadata,
  recordJobPostingMetadata,
  getSessionMetricsWithBaselineDeltas,
} from "../services/tigerdata.js";

const router = Router();

// POST /api/sessions
// Saves end-of-session data into relational `sessions` and `session_metrics` hypertable.
router.post("/", async (req, res) => {
  try {
    const { sessionId, userId, metadata = {}, metrics = {}, createdAt } = req.body;

    if (!sessionId || !userId) {
      return res.status(400).json({
        error: "Missing required fields: 'sessionId' and 'userId' are mandatory.",
      });
    }

    const savedRecord = await logSessionMetrics({
      sessionId,
      userId,
      metadata,
      metrics,
      createdAt: createdAt ? new Date(createdAt) : new Date(),
    });

    return res.status(201).json({
      message: "Session stored in sessions and session_metrics hypertable.",
      session: savedRecord,
    });
  } catch (err) {
    console.error("Error saving session to TigerData:", err);
    return res.status(500).json({
      error: "Failed to store session metrics.",
      details: err.message,
    });
  }
});

// GET /api/sessions/trends/:userId
// Retrieves trend analysis, 5/10 rolling window averages, and formatted summary
router.get("/trends/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit, 10) || 5;

    const trends = await getSessionTrends({ userId, limit });
    return res.json(trends);
  } catch (err) {
    console.error("Error fetching session trends:", err);
    return res.status(500).json({
      error: "Failed to fetch session trends.",
      details: err.message,
    });
  }
});

// GET /api/sessions/deltas/:userId
// Retrieves session metrics paired with baseline deltas
router.get("/deltas/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit, 10) || 5;

    const deltas = await getSessionMetricsWithBaselineDeltas({ userId, limit });
    return res.json({ userId, count: deltas.length, deltas });
  } catch (err) {
    console.error("Error fetching baseline deltas:", err);
    return res.status(500).json({
      error: "Failed to fetch baseline deltas.",
      details: err.message,
    });
  }
});

// POST /api/sessions/baseline
// Records a versioned baseline calibration record
router.post("/baseline", async (req, res) => {
  try {
    const { baselineId, userId, baselineData = {}, capturedAt } = req.body;
    if (!baselineId || !userId) {
      return res.status(400).json({
        error: "Missing required fields: 'baselineId' and 'userId' are required.",
      });
    }

    const baseline = await recordBaseline({
      baselineId,
      userId,
      baselineData,
      capturedAt: capturedAt ? new Date(capturedAt) : new Date(),
    });

    return res.status(201).json({
      message: "Baseline recorded successfully.",
      baseline,
    });
  } catch (err) {
    console.error("Error recording baseline:", err);
    return res.status(500).json({
      error: "Failed to record baseline.",
      details: err.message,
    });
  }
});

// POST /api/sessions/resume
// Records resume metadata linked to Backboard document ID
router.post("/resume", async (req, res) => {
  try {
    const { resumeId, userId, filename, backboardDocumentId } = req.body;
    if (!resumeId || !userId || !filename) {
      return res.status(400).json({
        error: "Missing required fields: 'resumeId', 'userId', and 'filename' are required.",
      });
    }

    if (!filename.toLowerCase().endsWith(".pdf")) {
      return res.status(400).json({
        error: "Invalid file type: filename must end with .pdf",
      });
    }

    const resume = await recordResumeMetadata({
      resumeId,
      userId,
      filename,
      backboardDocumentId,
    });

    return res.status(201).json({
      message: "Resume metadata stored successfully.",
      resume,
    });
  } catch (err) {
    console.error("Error storing resume metadata:", err);
    return res.status(500).json({
      error: "Failed to store resume metadata.",
      details: err.message,
    });
  }
});

// POST /api/sessions/job-posting
// Records job posting metadata linked to Backboard document ID
router.post("/job-posting", async (req, res) => {
  try {
    const {
      jobPostingId,
      userId,
      jobTitle,
      companyName,
      filename,
      backboardDocumentId,
    } = req.body;

    if (!jobPostingId || !userId) {
      return res.status(400).json({
        error: "Missing required fields: 'jobPostingId' and 'userId' are required.",
      });
    }

    const jobPosting = await recordJobPostingMetadata({
      jobPostingId,
      userId,
      jobTitle,
      companyName,
      filename,
      backboardDocumentId,
    });

    return res.status(201).json({
      message: "Job posting metadata stored successfully.",
      jobPosting,
    });
  } catch (err) {
    console.error("Error storing job posting metadata:", err);
    return res.status(500).json({
      error: "Failed to store job posting metadata.",
      details: err.message,
    });
  }
});

// GET /api/sessions/user/:userId
// Retrieves recent session history for a user
router.get("/user/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit, 10) || 10;

    const sessions = await getRecentSessions({ userId, limit });
    return res.json({ userId, count: sessions.length, sessions });
  } catch (err) {
    console.error("Error fetching sessions for user:", err);
    return res.status(500).json({
      error: "Failed to fetch user sessions.",
      details: err.message,
    });
  }
});

export default router;
