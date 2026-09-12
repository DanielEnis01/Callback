import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { createBackboardRouter } from "../src/routes/backboard.js";
import { createBackboardService } from "../src/services/backboard.js";
import { BackboardError } from "../src/integrations/backboard/backboardClient.js";

async function serve(t, service) {
  const app = express();
  app.use("/api/backboard", createBackboardRouter(service));
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  await once(server, "listening");
  return async (path, body, headers = { "Content-Type": "application/json" }, method = "POST") => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/backboard${path}`, {
      method, headers, body: Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, body: await res.text() };
  };
}

test("HTTP lifecycle preserves one assistant and does not forward live signals", async (t) => {
  const messages = [];
  const service = createBackboardService({
    createUserAssistant: async () => ({ assistant_id: "assistant-1" }),
    sendMessage: async (...args) => {
      messages.push(args);
      return { assistant_id: args[0], thread_id: `t-${messages.length}`, content: "Reply" };
    },
  });
  const post = await serve(t, service);
  const created = await post("/assistants", { userId: "user-1" });
  assert.equal(created.status, 201);
  assert.equal(JSON.parse(created.body).assistant_id, "assistant-1");
  const complete = await post("/assistants/assistant-1/sessions/complete", {
    sessionId: "session-1", transcriptText: "answer ".repeat(20000), summaryText: "Struggled with conflict questions.",
    trendSentence: "IGNORED", rawSignals: "IGNORED",
  });
  assert.equal(complete.status, 200); // accepts completed transcripts over 100 KB
  const start = await post("/assistants/assistant-1/sessions/start", {
    trendSentence: "Filler words decreased 20%.", rawSignals: "IGNORED",
  });
  assert.equal(start.status, 200);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map(([id]) => id), ["assistant-1", "assistant-1"]);
  assert.equal(messages[0][2].memory, "Auto");
  assert.equal(messages[1][2].memory, "Readonly");
  assert.match(messages[1][1], /Filler words decreased 20%/);
  for (const [, content] of messages) assert.doesNotMatch(content, /IGNORED/);
  assert.equal((await post("/assistants/assistant-1/messages", { content: "live answer" })).status, 404);
});

test("PDF setup accepts bytes and returns indexed status without reading server paths", async (t) => {
  const post = await serve(t, createBackboardService({
    uploadDocument: async () => ({ document_id: "d1", status: "pending" }),
    waitForIndexed: async () => ({ status: "indexed" }),
  }));
  const uploaded = await post("/assistants/a1/job-posting", Buffer.from("%PDF-1.4 test"), { "Content-Type": "application/pdf" });
  assert.equal(uploaded.status, 201);
  assert.equal(JSON.parse(uploaded.body).status, "indexed");
  assert.equal((await post("/assistants/a1/job-posting", { pdfFilePath: "/etc/passwd" })).status, 400);
});

test("invalid requests and upstream failures produce JSON errors", async (t) => {
  const post = await serve(t, createBackboardService({
    sendMessage: async () => { throw new BackboardError("private upstream account details", { status: 401 }); },
  }));
  const invalid = await post("/assistants/a1/sessions/complete", {});
  assert.equal(invalid.status, 400);
  assert.match(JSON.parse(invalid.body).error, /sessionId/);
  const malformed = await post("/assistants", "{");
  assert.equal(malformed.status, 400);
  assert.ok(JSON.parse(malformed.body).error);
  const upstream = await post("/assistants/a1/sessions/start", {});
  assert.equal(upstream.status, 502);
  assert.equal(JSON.parse(upstream.body).error, "Backboard request failed");
  assert.doesNotMatch(upstream.body, /private/);
});

test("resume HTTP flow accepts a PDF, reports indexing, grounds preparation, and removes the file", async (t) => {
  const calls = [];
  const post = await serve(t, createBackboardService({
    uploadDocument: async (id, buffer, filename, mimeType) => {
      assert.equal(id, "a1");
      assert.equal(buffer.toString(), "%PDF-1.4 resume bytes");
      assert.equal(filename, "My Resume.pdf");
      assert.equal(mimeType, "application/pdf");
      return { document_id: "resume-1", status: "pending" };
    },
    getDocumentStatus: async (id) => ({ document_id: id, status: "indexed" }),
    waitForIndexed: async (id) => { calls.push(id); return { status: "indexed" }; },
    sendMessage: async (_id, text) => { assert.match(text, /Active resume document ID: resume-1/); return { content: "Question", thread_id: "t1" }; },
    deleteDocument: async (id) => { calls.push(`delete:${id}`); return 204; },
  }));
  const upload = await post("/assistants/a1/resumes?filename=My%20Resume.pdf", Buffer.from("%PDF-1.4 resume bytes"), { "Content-Type": "application/pdf" });
  assert.equal(upload.status, 202);
  assert.equal(JSON.parse(upload.body).document_id, "resume-1");
  const indexed = await post("/documents/resume-1/status", undefined, {}, "GET");
  assert.equal(JSON.parse(indexed.body).status, "indexed");
  assert.equal((await post("/assistants/a1/sessions/start", { resumeDocumentId: "resume-1" })).status, 200);
  assert.equal((await post("/documents/resume-1", undefined, {}, "DELETE")).status, 204);
  assert.deepEqual(calls, ["resume-1", "delete:resume-1"]);
});
