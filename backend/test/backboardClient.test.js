import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createUserAssistant, addCoachingMemory, searchMemories, listMemories, updateMemory, deleteAssistant, BackboardError } from "../src/integrations/backboard/backboardClient.js";
const originalFetch = globalThis.fetch;
let calls;
beforeEach(() => {
  process.env.BACKBOARD_API_KEY = "test-key";
  process.env.BACKBOARD_MIN_INTERVAL_MS = "0";
  calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ id: "memory-1" }), { status: 200 }); };
});
afterEach(() => { globalThis.fetch = originalFetch; delete process.env.BACKBOARD_API_KEY; delete process.env.BACKBOARD_BASE_URL; delete process.env.BACKBOARD_MIN_INTERVAL_MS; });

test("assistant is created for language memory without document RAG instructions", async () => {
  await createUserAssistant("alice");
  assert.equal(calls[0].url, "https://app.backboard.io/api/assistants");
  assert.equal(JSON.parse(calls[0].options.body).name, "coach_alice");
  assert.doesNotMatch(JSON.parse(calls[0].options.body).system_prompt, /resume|RAG/);
  assert.equal(calls[0].options.headers["X-API-Key"], "test-key");
});
test("direct writes and updates preserve structured metadata, using documented endpoint shapes", async () => {
  const metadata = { kind: "qa_pair", externalId: "s:0", userId: "alice", answerScores: { starScore: 2 } };
  await addCoachingMemory("a/1", "Q: Why?\nA: Because.", metadata);
  assert.equal(calls[0].url, "https://app.backboard.io/api/assistants/a%2F1/memories");
  assert.deepEqual(JSON.parse(calls[0].options.body), { content: "Q: Why?\nA: Because.", metadata });
  await updateMemory("a/1", "m/1", "updated", metadata);
  assert.equal(calls[1].options.method, "PUT");
  assert.match(calls[1].url, /memories\/m%2F1$/);
});
test("retrieval requests query and limit; listing uses explicit pagination", async () => {
  await searchMemories("a", "delivery", 10);
  assert.deepEqual(JSON.parse(calls[0].options.body), { query: "delivery", limit: 10 });
  await listMemories("a", { page: 2, pageSize: 100 });
  assert.match(calls[1].url, /memories\?page=2&page_size=100$/);
});
test("search accepts Backboard's maximum of 50 and rejects larger requests before fetch", async () => {
  await searchMemories("a", "delivery", 50);
  assert.equal(JSON.parse(calls[0].options.body).limit, 50);
  for (const limit of [51, 100, 0, -1, 1.5, NaN]) {
    await assert.rejects(searchMemories("a", "delivery", limit), { statusCode: 400 });
  }
  assert.equal(calls.length, 1);
});
test("base URL is configurable and credentials are required before fetch", async () => {
  process.env.BACKBOARD_BASE_URL = "http://localhost:4000/api/";
  await searchMemories("a", "q");
  assert.match(calls[0].url, /^http:\/\/localhost:4000\/api\//);
  delete process.env.BACKBOARD_API_KEY;
  await assert.rejects(searchMemories("a", "q"), { statusCode: 503 });
  assert.equal(calls.length, 1);
});
test("HTTP rejection, transport timeout, and malformed JSON remain distinguishable", async () => {
  globalThis.fetch = async () => new Response("quota", { status: 429 });
  await assert.rejects(searchMemories("a", "q"), (error) => error instanceof BackboardError && error.status === 429);
  globalThis.fetch = async () => { throw new DOMException("timeout", "TimeoutError"); };
  await assert.rejects(searchMemories("a", "q"), { statusCode: 504 });
  globalThis.fetch = async () => new Response("not JSON");
  await assert.rejects(searchMemories("a", "q"), /invalid JSON/);
});
test("concurrent requests reserve different throttle slots", async () => {
  process.env.BACKBOARD_MIN_INTERVAL_MS = "25";
  const times = [];
  globalThis.fetch = async () => { times.push(Date.now()); return new Response("{}"); };
  await Promise.all([searchMemories("a", "one"), searchMemories("a", "two"), searchMemories("a", "three")]);
  assert.ok(times[1] - times[0] >= 20);
  assert.ok(times[2] - times[1] >= 20);
});
test("disposable assistant cleanup tolerates already deleted resources", async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  assert.equal(await deleteAssistant("disposable"), 404);
});
