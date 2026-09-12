import { Router } from "express";
import { testRecruiterPrompt } from "../services/gemini.js";

const router = Router();

// Placeholder status endpoints — one per integration, wired up as each
// service module gets implemented.
const SERVICES = ["gemini", "elevenlabs", "presage", "tigerdata", "backboard"];

router.get("/", (_req, res) => {
  res.json({ services: SERVICES.map((name) => ({ name, status: "not_implemented" })) });
});

// Dev tool: POST { message, history? } -> { reply }
// Lets you test the static recruiter prompt directly, e.g.:
//   curl -X POST http://localhost:3001/api/services/gemini/test \
//     -H "Content-Type: application/json" \
//     -d '{"message":"Hi, I'\''m ready to start."}'
router.post("/gemini/test", async (req, res) => {
  const { message, history } = req.body ?? {};

  if (!message) {
    return res.status(400).json({ error: "message is required" });
  }

  try {
    const reply = await testRecruiterPrompt(message, history);
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
