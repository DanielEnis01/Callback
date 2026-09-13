import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import services from "../src/routes/services.js";
import backboard from "../src/routes/backboard.js";

test("HTTP create → persisted plan → indexed turns → analysis → memory preview works without paid APIs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "callback-http-"));
  process.env.CALLBACK_MOCK_DATA_FILE = path.join(directory, "sessions.json");
  process.env.CALLBACK_DEV_TOOLS = "1";
  process.env.NODE_ENV = "development";
  const app = express();
  app.use(express.json());
  app.use("/api/services", services);
  app.use("/api/backboard", backboard);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const request = async (route, body, user = "http-user") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "X-Callback-Memory-Mode": "mock", "X-Callback-Dev-User": user },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const created = await request("/services/sessions", { jobPostingText: "Software engineer", rawSignals: { pulse: 99 }, email: "PRIVATE_EMAIL" });
    assert.equal(created.status, 201);
    const sessionId = created.body.sessionId;
    assert.doesNotMatch(JSON.stringify(created.body), /PRIVATE_EMAIL|pulse/);
    const planned = await request("/services/gemini/interview-plan", { sessionId });
    assert.equal(planned.body.questions.length, 5);
    let history = [{ role: "model", parts: [{ text: planned.body.questions[0].text }], questionIndex: 0, isClarifying: false }];
    for (let questionIndex = 0; questionIndex < 2; questionIndex++) {
      const message = "When our team needed a migration, I led the project and built a rollout. We reduced failures by 40%.";
      const turn = await request("/services/gemini/interview-turn", { sessionId, message, history, speak: false });
      assert.equal(turn.body.answeredQuestionIndex, questionIndex);
      history.push({ role: "user", parts: [{ text: message }], questionIndex, isClarifying: false });
      history.push({ role: "model", parts: [{ text: turn.body.text }], questionIndex: turn.body.askedQuestionIndex, isClarifying: turn.body.isClarifying });
    }
    const result = await request("/services/analysis/transcript", { sessionId, transcript: history });
    assert.equal(result.body.memory.status, "synced");
    assert.deepEqual(result.body.session.analysis.progressNotes, []);
    const preview = await request(`/backboard/sessions/${sessionId}/preview`);
    assert.equal(preview.body.records.length, 3);
    const retry = await request("/services/analysis/transcript", { sessionId, transcript: [] });
    assert.equal(retry.body.memory.status, "already_synced");
    assert.equal(retry.body.session.transcript.length, 5);
    assert.equal((await request("/services/gemini/interview-plan", { sessionId }, "other-user")).status, 404);
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
