import { Router, json } from "express";
import { getMemoryRuntime, requireUser, devToolsEnabled } from "../services/memoryRuntime.js";
import { buildMemoryRecords, memoryPrompt } from "../services/memoryRecords.js";
import { seedHistory } from "../services/memoryDev.js";

export function createBackboardRouter(runtimeFor = getMemoryRuntime) {
  const router = Router();
  router.use(json({ limit: "2mb" }), requireUser);
  const handle = (fn) => (req, res, next) => Promise.resolve().then(async () => fn(req, res, await runtimeFor(req))).catch(next);
  router.get("/status", handle(async (req, res, runtime) => {
    const state = await runtime.store.transaction(req.user.userId, (value) => ({ assistantId: value.assistantId, receipts: value.records }));
    res.json({ mode: runtime.mode, configured: runtime.mode !== "live" || !!process.env.BACKBOARD_API_KEY, persistence: runtime.mode === "live" && process.env.DATABASE_URL ? "postgres" : "local_file", ...state });
  }));
  router.post("/memories/search", handle(async (req, res, { memory }) => {
    const { query, kind, limit, excludeSessionId, weakOnly } = req.body || {};
    res.json(await memory.retrieveMemory({ userId: req.user.userId, query, kind, limit, excludeSessionId, weakOnly }));
  }));
  router.get("/sessions", handle(async (req, res, { store }) => {
    res.json({ sessions: await store.listSessions(req.user.userId) });
  }));
  router.get("/sessions/:sessionId/preview", handle(async (req, res, { interview }) => {
    const session = await interview.getSession(req.user.userId, req.params.sessionId);
    const payload = buildMemoryRecords(session);
    res.json({ ...payload, memorySyncedAt: session.memorySyncedAt });
  }));
  router.post("/sessions/:sessionId/sync", handle(async (req, res, { interview, memory }) => {
    await interview.getSession(req.user.userId, req.params.sessionId);
    res.json(await memory.syncSession(req.user.userId, req.params.sessionId));
  }));
  router.use("/dev", (_req, res, next) => devToolsEnabled() ? next() : res.sendStatus(404));
  router.post("/dev/seed", handle(async (req, res, runtime) => {
    res.json(await seedHistory(req.user.userId, runtime));
  }));
  router.post("/dev/planner-context", handle(async (req, res, { memory }) => {
    const [questions, notes] = await Promise.all([
      memory.retrieveMemory({ userId: req.user.userId, query: req.body?.query || "Software engineer", limit: 10 }), memory.recentNotes(req.user.userId),
    ]);
    res.json({ questions: questions.memories, notes, prompt: memoryPrompt({ questions: questions.memories, notes }) });
  }));
  router.use((error, _req, res, _next) => {
    const status = error.statusCode || 500;
    res.status(status).json({ error: status < 500 ? error.message : "Memory service unavailable. Saved sessions are retained." });
  });
  return router;
}
export default createBackboardRouter();
