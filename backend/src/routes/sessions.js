import { Router } from "express";
import {
  logSessionMetrics,
  getSessionTrends,
  getRecentSessions,
} from "../services/tigerdata.js";

const router = Router();

// POST /api/sessions
// Saves end-of-session numeric summary into TigerData hypertable.
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
      message: "Session metrics successfully stored in TigerData hypertable.",
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
// Retrieves trend analysis and a natural-language summary ready for Backboard/Gemini
router.get("/trends/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit, 10) || 5;

    const trends = await getSessionTrends({ userId, limit });
    return res.json(trends);
  } catch (err) {
    console.error("Error fetching session trends from TigerData:", err);
    return res.status(500).json({
      error: "Failed to fetch session trends.",
      details: err.message,
    });
  }
});

// GET /api/sessions/user/:userId
// Retrieves recent raw session records for a given user
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

