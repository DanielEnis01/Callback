import { Router, json, raw } from "express";
import * as backboard from "../services/backboard.js";
import { synthesizeSpeech } from "../services/elevenlabs.js";
import { BackboardError } from "../integrations/backboard/backboardClient.js";

// Export a factory so the HTTP contract can be verified without paid API calls.
export function createBackboardRouter(service = backboard) {
  const router = Router();
  router.use(json({ limit: "2mb" }));
  const handle = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  router.post("/assistants", handle(async (req, res) => {
    res.status(201).json(await service.createUserAssistant(req.body?.userId));
  }));

  router.post("/assistants/:assistantId/job-posting", raw({ type: "application/pdf", limit: "10mb" }), handle(async (req, res) => {
    res.status(201).json(await service.setupJobPosting({
      assistantId: req.params.assistantId,
      pdfBuffer: req.body,
      filename: "job-posting.pdf",
    }));
  }));

  router.post("/assistants/:assistantId/resumes", raw({ type: "application/pdf", limit: "10mb" }), handle(async (req, res) => {
    res.status(202).json(await service.uploadResume({
      assistantId: req.params.assistantId,
      pdfBuffer: req.body,
      filename: req.query.filename,
    }));
  }));

  router.get("/documents/:documentId/status", handle(async (req, res) => {
    res.json(await service.getDocumentStatus(req.params.documentId));
  }));

  router.delete("/documents/:documentId", handle(async (req, res) => {
    await service.deleteDocument(req.params.documentId);
    res.sendStatus(204);
  }));

  router.post("/assistants/:assistantId/sessions/complete", handle(async (req, res) => {
    res.json(await service.afterSessionEnds({
      assistantId: req.params.assistantId,
      sessionId: req.body?.sessionId,
      transcriptText: req.body?.transcriptText,
      summaryText: req.body?.summaryText,
    }));
  }));

  router.post("/assistants/:assistantId/sessions/start", handle(async (req, res) => {
    res.json(await service.startSession({
      assistantId: req.params.assistantId,
      trendSentence: req.body?.trendSentence,
      practiceFocus: req.body?.practiceFocus,
      resumeDocumentId: req.body?.resumeDocumentId,
      candidateName: req.body?.candidateName,
      targetRoles: req.body?.targetRoles,
      jobPosting: req.body?.jobPosting,
    }));
  }));

  router.post("/assistants/:assistantId/sessions/tts", handle(async (req, res) => {
    const { text, voiceId } = req.body ?? {};
    const audio = await synthesizeSpeech({ text, voiceId });
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(audio);
  }));

  router.post("/assistants/:assistantId/memories/search", handle(async (req, res) => {
    res.json(await service.retrieveMemory({
      assistantId: req.params.assistantId,
      query: req.body?.query,
      limit: req.body?.limit,
    }));
  }));

  router.use((error, _req, res, _next) => {
    const status = error.statusCode || error.status || 500;
    // Upstream response bodies can contain account details; keep them server-side.
    const message = error instanceof BackboardError
      ? status === 504 ? "Backboard request timed out" : "Backboard request failed"
      : status < 500 || status === 503 ? error.message : "Backboard integration failed";
    res.status(status).json({ error: message });
  });

  return router;
}

export default createBackboardRouter();
