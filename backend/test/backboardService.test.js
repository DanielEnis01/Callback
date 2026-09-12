import test from "node:test";
import assert from "node:assert/strict";
import { createBackboardService } from "../src/services/backboard.js";

test("session completion sends only transcript/summary for Auto extraction on the existing assistant", async () => {
  const calls = [];
  // No database, document upload, or manual-memory methods are available.
  const service = createBackboardService({
    sendMessage: async (...args) => {
      calls.push(args);
      return { content: "Post-session feedback", thread_id: "summary-thread" };
    },
  });
  const result = await service.afterSessionEnds({
    assistantId: "user-assistant",
    sessionId: "session-1",
    transcriptText: "Candidate: I resolved the disagreement by listening.",
    summaryText: "The candidate lost the thread on a behavioral question.",
    trendSentence: "THIS TREND MUST NOT BE WRITTEN",
    rawSignals: { pulse: [90, 100] },
  });
  assert.equal(calls.length, 1);
  const [assistantId, text, options] = calls[0];
  assert.equal(assistantId, "user-assistant");
  assert.match(text, /Transcript:\nCandidate:/);
  assert.match(text, /Session summary:\nThe candidate/);
  assert.doesNotMatch(text, /THIS TREND|rawSignals|pulse/);
  assert.equal(options.memory, "Auto");
  assert.equal(options.threadId, undefined);
  assert.deepEqual(options.metadata, { session_id: "session-1", phase: "completed" });
  assert.equal(result.thread_id, "summary-thread");
});

test("next-session prep combines caller trends and practice focus with read-only memory/RAG", async () => {
  const service = createBackboardService({
    sendMessage: async (assistantId, text, options) => {
      assert.equal(assistantId, "same-user-assistant");
      assert.match(text, /Filler count is down 20%/);
      assert.match(text, /conflict-resolution questions/);
      assert.match(text, /uploaded job posting/);
      assert.match(text, /Do not show scores/);
      assert.doesNotMatch(text, /SHOULD NOT SEND/);
      assert.equal(options.memory, "Readonly");
      assert.equal(options.memoryResponseCitation, false);
      assert.equal(options.threadId, undefined);
      assert.ok(options.llmProvider);
      assert.ok(options.modelName);
      return { thread_id: "new-thread", content: "Tell me about a conflict." };
    },
  });
  const result = await service.startSession({
    assistantId: "same-user-assistant",
    trendSentence: "Filler count is down 20% over previous sessions.",
    practiceFocus: "conflict-resolution questions",
    transcriptText: "SHOULD NOT SEND",
    rawSignals: "SHOULD NOT SEND",
  });
  assert.equal(result.thread_id, "new-thread");
});

test("first-session preparation works without trends or history", async () => {
  const service = createBackboardService({
    sendMessage: async (_id, text, options) => {
      assert.doesNotMatch(text, /Prior-session trend context|undefined|null/);
      assert.equal(options.memory, "Readonly");
      return { content: "Tell me about yourself." };
    },
  });
  await service.startSession({ assistantId: "new-user-assistant" });
});

test("job posting setup uploads once and waits until the document is indexed", async () => {
  const calls = [];
  const service = createBackboardService({
    uploadDocument: async (id, buffer, filename, mimeType) => {
      calls.push("upload");
      assert.equal(id, "a1");
      assert.equal(buffer.toString(), "%PDF-1.4 test");
      assert.equal(filename, "role.pdf");
      assert.equal(mimeType, "application/pdf");
      return { document_id: "doc-1", status: "pending" };
    },
    waitForIndexed: async (id) => {
      calls.push("index");
      assert.equal(id, "doc-1");
      return { status: "indexed" };
    },
  });
  const result = await service.setupJobPosting({
    assistantId: "a1", pdfBuffer: Buffer.from("%PDF-1.4 test"), filename: "role.pdf",
  });
  assert.deepEqual(calls, ["upload", "index"]);
  assert.deepEqual(result, { document_id: "doc-1", status: "indexed" });
});

test("invalid lifecycle inputs fail before any API request", async () => {
  const service = createBackboardService({});
  const completed = { assistantId: "a", sessionId: "s", transcriptText: "answer", summaryText: "summary" };
  for (const key of Object.keys(completed)) {
    await assert.rejects(service.afterSessionEnds({ ...completed, [key]: " " }), { statusCode: 400 });
  }
  await assert.rejects(service.startSession({ assistantId: "" }), { statusCode: 400 });
  await assert.rejects(service.startSession({ assistantId: "a", trendSentence: {} }), { statusCode: 400 });
  await assert.rejects(service.setupJobPosting({ assistantId: "a", pdfBuffer: Buffer.from("not a PDF") }), { statusCode: 400 });
  await assert.rejects(service.createUserAssistant(""), { statusCode: 400 });
  await assert.rejects(service.retrieveMemory({ assistantId: "a", query: "pacing", limit: 0 }), { statusCode: 400 });
});

test("memory lookup only calls semantic search and never invokes generation", async () => {
  const service = createBackboardService({
    searchMemories: async (assistantId, query, limit) => {
      assert.deepEqual([assistantId, query, limit], ["a1", "pacing", 5]);
      return { memories: [{ content: "Pacing has improved." }] };
    },
  });
  assert.equal((await service.retrieveMemory({ assistantId: "a1", query: "pacing" })).memories.length, 1);
});

test("indexing errors propagate and do not report successful job setup", async () => {
  const service = createBackboardService({
    uploadDocument: async () => ({ document_id: "bad-doc" }),
    waitForIndexed: async () => { throw new Error("indexing failed"); },
  });
  await assert.rejects(service.setupJobPosting({ assistantId: "a", pdfBuffer: Buffer.from("%PDF-1.4 test") }), /indexing failed/);
});

test("resume upload sends the actual PDF and returns its ID before indexing", async () => {
  const bytes = Buffer.from("%PDF-1.4 candidate skills and experience");
  const service = createBackboardService({
    uploadDocument: async (id, buffer, filename, mimeType) => {
      assert.equal(id, "a1");
      assert.deepEqual(buffer, bytes);
      assert.equal(filename, "Alex Resume.pdf");
      assert.equal(mimeType, "application/pdf");
      return { document_id: "resume-1", status: "processing" };
    },
  });
  assert.deepEqual(await service.uploadResume({ assistantId: "a1", pdfBuffer: bytes, filename: "Alex Resume.pdf" }), {
    document_id: "resume-1", status: "processing",
  });
  await assert.rejects(service.uploadResume({ assistantId: "a1", pdfBuffer: Buffer.from("plain text") }), { statusCode: 400 });
});

test("session preparation waits for the resume and combines it with role, job, and past trends", async () => {
  const calls = [];
  const service = createBackboardService({
    waitForIndexed: async (id) => { calls.push(["index", id]); return { status: "indexed" }; },
    sendMessage: async (id, content, options) => {
      calls.push(["message", id]);
      assert.match(content, /Active resume document ID: resume-1/);
      assert.match(content, /Candidate name: Alex/);
      assert.match(content, /Target roles: Frontend engineer/);
      assert.match(content, /Build accessible applications/);
      assert.match(content, /Filler count decreased/);
      assert.equal(options.memory, "Readonly");
      assert.equal(options.metadata.resume_document_id, "resume-1");
      return { content: "Tell me about your React project.", thread_id: "t1" };
    },
  });
  await service.startSession({ assistantId: "a1", resumeDocumentId: "resume-1", candidateName: "Alex",
    targetRoles: "Frontend engineer", jobPosting: "Build accessible applications", trendSentence: "Filler count decreased" });
  assert.deepEqual(calls, [["index", "resume-1"], ["message", "a1"]]);
});

test("unusable resume prevents generation", async () => {
  const service = createBackboardService({ waitForIndexed: async () => { throw new Error("resume indexing failed"); } });
  await assert.rejects(service.startSession({ assistantId: "a1", resumeDocumentId: "resume-1" }), /indexing failed/);
});
