import { Router } from "express";
import { testRecruiterPrompt } from "../services/gemini.js";
import { synthesizeSpeech } from "../services/elevenlabs.js";
import { getMemoryRuntime, requireUser } from "../services/memoryRuntime.js";
import { validatePlan } from "../services/interview.js";

const router = Router();

const interviewRoute = (fn) => [requireUser, (req, res, next) => Promise.resolve().then(async () => fn(req, res, await getMemoryRuntime(req))).catch(next)];
router.post("/sessions", ...interviewRoute(async (req, res, { interview }) => {
  res.status(201).json(await interview.createSession(req.user.userId, req.body));
}));
router.patch("/sessions/:sessionId/plan", ...interviewRoute(async (req, res, { interview, store }) => {
  const session = await interview.getSession(req.user.userId, req.params.sessionId);
  if (session.interviewPlan) return res.status(409).json({ error: "The saved plan is immutable" });
  const plan = validatePlan(req.body?.questions).map(({ repeatOf: _repeat, ...question }) => question);
  await store.transaction(req.user.userId, (state) => {
    if (state.sessions[session.sessionId].interviewPlan) throw Object.assign(new Error("The saved plan is immutable"), { statusCode: 409 });
    state.sessions[session.sessionId].interviewPlan = plan;
  });
  res.json({ questions: plan });
}));
router.post("/gemini/interview-plan", ...interviewRoute(async (req, res, { interview }) => {
  res.json(await interview.planSession(req.user.userId, req.body?.sessionId, req.body?.resumePdf));
}));
router.post("/analysis/transcript", ...interviewRoute(async (req, res, { interview }) => {
  res.json(await interview.analyzeSession(req.user.userId, req.body?.sessionId, req.body?.transcript));
}));
router.post("/gemini/interview-turn", ...interviewRoute(async (req, res, { interview }) => {
  if (typeof req.body?.message !== "string" || !req.body.message.trim() || req.body.message.length > 20000) return res.status(400).json({ error: "message is required (up to 20,000 characters)" });
  const turn = await interview.interviewTurn(req.user.userId, req.body.sessionId, req.body);
  let audio = null;
  if (req.body.speak !== false) {
    try {
      const stream = await synthesizeSpeech({ text: turn.text });
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      audio = Buffer.concat(chunks).toString("base64");
    } catch { /* Keep the text turn and transcript when voice is unavailable. */ }
  }
  res.json({ ...turn, audio });
}));

// Placeholder status endpoints — one per integration, wired up as each
// service module gets implemented.
const SERVICES = ["gemini", "presage", "tigerdata", "backboard"];

router.get("/", (_req, res) => {
  res.json({ services: SERVICES.map((name) => ({
    name,
    status: name === "backboard"
      ? process.env.BACKBOARD_API_KEY?.trim() ? "configured" : "not_configured"
      : "not_implemented",
  })) });
});

// Dev tool: POST { message, history? } -> { reply }
// Lets you test the static recruiter prompt directly, e.g.:
//   curl -X POST http://localhost:3001/api/services/gemini/test \
//     -H "Content-Type: application/json" \
//     -d '{"message":"Hi, I'\''m ready to start."}'
router.post("/gemini/test", async (req, res) => {
  const { message, history, systemContext } = req.body ?? {};

  if (!message) {
    return res.status(400).json({ error: "message is required" });
  }

  try {
    const reply = await testRecruiterPrompt(message, history, systemContext);
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Connector: POST { message, history?, voiceId? } -> { text, audio }
// Gets the recruiter's reply from Gemini, then hands the plain text
// straight to ElevenLabs. This is the join point between the two —
// synthesizeSpeech() is implemented, so this route works end-to-end
// with zero further glue code needed.
//
// Returns JSON: { text: string, audio: string (base64 mp3) }
router.post("/gemini/speak", async (req, res) => {
  const { message, history, voiceId, systemContext } = req.body ?? {};

  if (!message) {
    return res.status(400).json({ error: "message is required" });
  }

  try {
    // Step 1: Gemini generates the recruiter reply.
    const text = await testRecruiterPrompt(message, history, systemContext);

    // Step 2: ElevenLabs synthesizes the reply.
    // synthesizeSpeech() returns a Node.js Readable stream of audio/mpeg
    // chunks — collect them into a single buffer so we can embed the
    // audio as base64 in the JSON response.
    const audioStream = await synthesizeSpeech({ text, voiceId });
    const chunks = [];
    for await (const chunk of audioStream) {
      chunks.push(chunk);
    }
    const audio = Buffer.concat(chunks).toString("base64");

    res.json({ text, audio });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.use((error, _req, res, _next) => {
  res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Interview service unavailable" });
});

export default router;
