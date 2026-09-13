import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createBackboardRouter } from "../src/routes/backboard.js";
import { createSessionStore } from "../src/services/sessionStore.js";
import { createBackboardService } from "../src/services/backboard.js";
import { createInterviewService } from "../src/services/interview.js";
import { createMockBackboardClient, mockGenerateJson } from "../src/services/memoryDev.js";

async function withServer(fn) {
  const store = createSessionStore();
  const memory = createBackboardService(createMockBackboardClient(store), store);
  const runtime = { store, memory, mode: "mock", interview: createInterviewService({ store, memory, generateJson: mockGenerateJson }) };
  const app = express();
  app.use("/api/backboard", createBackboardRouter(async () => runtime));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const request = async (path, body, user = "alice") => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/backboard${path}`, {
        method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...(user ? { "X-Callback-Dev-User": user } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json().catch(() => null) };
    };
    await fn(request, runtime);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test("developer HTTP tools seed once, inspect exact payloads, retry sync, and isolate users", async () => {
  process.env.CALLBACK_DEV_TOOLS = "1";
  process.env.NODE_ENV = "development";
  await withServer(async (request) => {
    assert.equal((await request("/status", undefined, null)).status, 401);
    assert.equal((await request("/dev/seed", {})).data.seeded, true);
    assert.equal((await request("/dev/seed", {})).data.seeded, false);
    const sessions = (await request("/sessions")).data.sessions;
    assert.equal(sessions.length, 3);
    const id = sessions[0].sessionId;
    assert.equal((await request(`/sessions/${id}/preview`)).data.records.length, 6);
    assert.equal((await request(`/sessions/${id}/sync`, {})).data.status, "already_synced");
    assert.equal((await request(`/sessions/${id}/preview`, undefined, "bob")).status, 404);
    assert.equal((await request("/memories/search", { query: "migration", userId: "alice", assistantId: "ignored" }, "bob")).data.memories.length, 0);
    assert.equal((await request("/memories/search", { query: "migration", limit: 50 })).status, 200);
    assert.equal((await request("/memories/search", { query: "migration", limit: 51 })).status, 400);
    assert.equal((await request("/assistants", { userId: "alice" })).status, 404);
  });
});

test("production ignores development identity headers even when the opt-in flag is set", async () => {
  process.env.NODE_ENV = "production";
  process.env.CALLBACK_DEV_TOOLS = "1";
  await withServer(async (request) => {
    assert.equal((await request("/status")).status, 401);
    assert.equal((await request("/dev/seed", {})).status, 401);
  });
  delete process.env.CALLBACK_DEV_TOOLS;
  delete process.env.NODE_ENV;
});
