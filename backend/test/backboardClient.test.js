// backboardClient.test.js
// Run: npm test
// Mocks global.fetch so these run instantly, offline, and don't touch your API credits.
// Use these to check your request shapes (URL, method, body, headers) are correct.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

process.env.BACKBOARD_API_KEY = "test-key";
// These tests mock fetch and don't touch the real API, so disable the client's
// inter-request throttle (default 250ms) or every test file run gets slow.
process.env.BACKBOARD_MIN_INTERVAL_MS = "0";

// Configuration is read at call time, after the test environment has been set.
import {
  createUserAssistant,
  uploadDocument,
  uploadTranscript,
  uploadJobPosting,
  waitForIndexed,
  addCoachingMemory,
  searchMemories,
  sendMessage,
  deleteAssistant,
  deleteDocument,
} from "../src/integrations/backboard/backboardClient.js";

function mockFetchOnce(responseBody, { ok = true, status = 200 } = {}) {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok,
      status,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    };
  };
  return calls;
}

test("createUserAssistant posts to /assistants with name and system_prompt", async () => {
  const calls = mockFetchOnce({ assistant_id: "abc123", name: "coach_user1" });

  const result = await createUserAssistant("user1");

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, "https://app.backboard.io/api/assistants");
  assert.strictEqual(calls[0].options.method, "POST");
  assert.strictEqual(calls[0].options.headers["X-API-Key"], "test-key");

  const body = JSON.parse(calls[0].options.body);
  assert.strictEqual(body.name, "coach_user1");
  assert.ok(body.system_prompt.length > 0);

  assert.strictEqual(result.assistant_id, "abc123");
});

test("uploadDocument sends multipart form to /assistants/{id}/documents", async () => {
  const calls = mockFetchOnce({ document_id: "doc1", status: "pending" });

  const result = await uploadDocument("abc123", Buffer.from("hi"), "test.txt", "text/plain");

  assert.strictEqual(calls[0].url, "https://app.backboard.io/api/assistants/abc123/documents");
  assert.strictEqual(calls[0].options.method, "POST");
  // Must NOT set Content-Type manually — fetch needs to set the multipart boundary itself
  assert.strictEqual(calls[0].options.headers["Content-Type"], undefined);
  assert.ok(calls[0].options.body instanceof FormData);

  assert.strictEqual(result.document_id, "doc1");
});

test("uploadTranscript wraps text as a .txt document via uploadDocument", async () => {
  const calls = mockFetchOnce({ document_id: "doc1", status: "pending" });

  const result = await uploadTranscript("abc123", "some transcript text", "test.txt");

  assert.strictEqual(calls[0].url, "https://app.backboard.io/api/assistants/abc123/documents");
  assert.ok(calls[0].options.body instanceof FormData);
  assert.strictEqual(result.document_id, "doc1");
});

test("uploadJobPosting reads a real file from disk and uploads it as application/pdf", async () => {
  const tmpPath = path.join(os.tmpdir(), `job-posting-test-${Date.now()}.pdf`);
  fs.writeFileSync(tmpPath, "%PDF-1.4 fake pdf bytes for test");

  try {
    const calls = mockFetchOnce({ document_id: "doc-job", status: "pending" });

    const result = await uploadJobPosting("abc123", tmpPath);

    assert.strictEqual(calls[0].url, "https://app.backboard.io/api/assistants/abc123/documents");
    assert.ok(calls[0].options.body instanceof FormData);
    assert.strictEqual(result.document_id, "doc-job");
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test("waitForIndexed polls until status is indexed", async () => {
  let callCount = 0;
  global.fetch = async () => {
    callCount++;
    const status = callCount < 3 ? "processing" : "indexed";
    return {
      ok: true,
      status: 200,
      json: async () => ({ document_id: "doc1", status, chunk_count: 4 }),
    };
  };

  const result = await waitForIndexed("doc1", { intervalMs: 10, timeoutMs: 5000 });

  assert.strictEqual(result.status, "indexed");
  assert.strictEqual(callCount, 3);
});

test("waitForIndexed throws on error status", async () => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: "error", status_message: "bad file" }),
  });

  await assert.rejects(
    () => waitForIndexed("doc1", { intervalMs: 10, timeoutMs: 5000 }),
    /bad file/
  );
});

test("waitForIndexed throws on timeout", async () => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: "processing" }),
  });

  await assert.rejects(
    () => waitForIndexed("doc1", { intervalMs: 10, timeoutMs: 50 }),
    /did not index within/
  );
});

test("addCoachingMemory posts content and metadata to /assistants/{id}/memories", async () => {
  const calls = mockFetchOnce({ memory_id: "mem1" }, { status: 201 });

  await addCoachingMemory("abc123", "candidate improved pacing", { week: 2 });

  assert.strictEqual(calls[0].url, "https://app.backboard.io/api/assistants/abc123/memories");
  const body = JSON.parse(calls[0].options.body);
  assert.strictEqual(body.content, "candidate improved pacing");
  assert.deepStrictEqual(body.metadata, { week: 2 });
});

test("searchMemories posts query/limit to /assistants/{id}/memories/search", async () => {
  const calls = mockFetchOnce({
    memories: [{ id: "mem1", content: "candidate improved pacing", score: 0.87 }],
  });

  const result = await searchMemories("abc123", "pacing feedback", 5);

  assert.strictEqual(calls[0].url, "https://app.backboard.io/api/assistants/abc123/memories/search");
  assert.strictEqual(calls[0].options.method, "POST");
  const body = JSON.parse(calls[0].options.body);
  assert.strictEqual(body.query, "pacing feedback");
  assert.strictEqual(body.limit, 5);

  assert.strictEqual(result.memories.length, 1);
  assert.strictEqual(result.memories[0].content, "candidate improved pacing");
});

test("sendMessage requests memory:Auto and passes assistant_id by default", async () => {
  const calls = mockFetchOnce({
    content: "Last time you rushed through this...",
    retrieved_files_count: 1,
    retrieved_memories: [{ content: "filler words up" }],
  });

  const result = await sendMessage("abc123", "prep the next question");

  assert.strictEqual(calls[0].url, "https://app.backboard.io/api/threads/messages");
  const body = JSON.parse(calls[0].options.body);
  assert.strictEqual(body.assistant_id, "abc123");
  assert.strictEqual(body.memory, "Auto");
  assert.strictEqual(body.memory_response_citation, true);
  assert.strictEqual(body.thread_id, undefined);
  assert.strictEqual(body.llm_provider, undefined);
  assert.strictEqual(body.model_name, undefined);

  assert.ok(result.content.length > 0);
  assert.strictEqual(result.retrieved_files_count, 1);
});

test("sendMessage passes threadId, llmProvider and modelName when given", async () => {
  const calls = mockFetchOnce({ content: "next question..." });

  await sendMessage("abc123", "candidate's answer", {
    threadId: "thread-1",
    llmProvider: "google",
    modelName: "gemini-2.5-flash",
  });

  const body = JSON.parse(calls[0].options.body);
  assert.strictEqual(body.thread_id, "thread-1");
  assert.strictEqual(body.llm_provider, "google");
  assert.strictEqual(body.model_name, "gemini-2.5-flash");
});

test("bbFetch throws a readable error on non-ok response", async () => {
  mockFetchOnce({ error: "invalid api key" }, { ok: false, status: 401 });

  await assert.rejects(
    () => createUserAssistant("user1"),
    /401/
  );
});

test("deleteAssistant sends DELETE to /assistants/{id} with API key", async () => {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 204, text: async () => "" };
  };

  const status = await deleteAssistant("abc123");

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, "https://app.backboard.io/api/assistants/abc123");
  assert.strictEqual(calls[0].options.method, "DELETE");
  assert.strictEqual(calls[0].options.headers["X-API-Key"], "test-key");
  assert.strictEqual(status, 204);
});

test("deleteAssistant treats 404 (already gone) as success, not an error", async () => {
  global.fetch = async () => ({ ok: false, status: 404, text: async () => "not found" });

  const status = await deleteAssistant("already-deleted");

  assert.strictEqual(status, 404);
});

test("deleteAssistant throws a readable error on other failures", async () => {
  global.fetch = async () => ({ ok: false, status: 500, text: async () => "server error" });

  await assert.rejects(
    () => deleteAssistant("abc123"),
    /500/
  );
});

test("missing credentials fail before fetch and credentials are read at call time", async (t) => {
  t.after(() => { process.env.BACKBOARD_API_KEY = "test-key"; });
  const calls = mockFetchOnce({ assistant_id: "a1" });
  delete process.env.BACKBOARD_API_KEY;
  await assert.rejects(createUserAssistant("u1"), { statusCode: 503 });
  assert.equal(calls.length, 0);
  process.env.BACKBOARD_API_KEY = "replacement-key";
  await createUserAssistant("u1");
  assert.equal(calls[0].options.headers["X-API-Key"], "replacement-key");
});

test("Readonly preparation preserves metadata and disables visible memory citations", async () => {
  const calls = mockFetchOnce({ content: "Opening question", thread_id: "t1" });
  await sendMessage("a1", "Prior trends", {
    memory: "Readonly", memoryResponseCitation: false, metadata: { phase: "preparation" },
  });
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.memory, "Readonly");
  assert.equal(body.memory_response_citation, false);
  assert.deepEqual(body.metadata, { phase: "preparation" });
});

test("concurrent calls respect separate throttle slots", async (t) => {
  process.env.BACKBOARD_MIN_INTERVAL_MS = "30";
  t.after(() => { process.env.BACKBOARD_MIN_INTERVAL_MS = "0"; });
  const times = [];
  global.fetch = async () => {
    times.push(Date.now());
    return { ok: true, status: 200, json: async () => ({ memories: [] }) };
  };
  await Promise.all([1, 2, 3].map(() => searchMemories("a1", "pacing")));
  assert.equal(times.length, 3);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 25);
});

test("network timeouts and malformed JSON surface as upstream errors", async () => {
  global.fetch = async () => { throw new DOMException("timed out", "TimeoutError"); };
  await assert.rejects(createUserAssistant("u1"), { statusCode: 504 });
  global.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad JSON"); } });
  await assert.rejects(createUserAssistant("u1"), { statusCode: 502 });
});

test("HTTP success with a failed generation is still an error", async () => {
  mockFetchOnce({ status: "FAILED", content: null });
  await assert.rejects(sendMessage("a1", "question"), /message generation failed/);
});

test("document deletion uses the document endpoint and tolerates an already removed file", async () => {
  const calls = mockFetchOnce({ document_id: "resume-1" });
  assert.equal(await deleteDocument("resume-1"), 200);
  assert.equal(calls[0].url, "https://app.backboard.io/api/documents/resume-1");
  assert.equal(calls[0].options.method, "DELETE");
  mockFetchOnce({}, { ok: false, status: 404 });
  assert.equal(await deleteDocument("resume-1"), 404);
});
