// Paid, opt-in direct-memory contract check. No documents or LLM generation.
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSessionStore } from "../src/services/sessionStore.js";
import { createBackboardService } from "../src/services/backboard.js";
import { deleteAssistant } from "../src/integrations/backboard/backboardClient.js";
import { checkCooldown, recordRun } from "./lib/apiGuard.js";
if (!process.env.BACKBOARD_API_KEY) throw new Error("Set BACKBOARD_API_KEY first.");
checkCooldown("memory-smoke");
recordRun("memory-smoke");
const userId = `smoke-${randomUUID()}`;
const store = createSessionStore();
const memory = createBackboardService(undefined, store);
try {
  const record = { userId, content: "Q: Tell me about a migration.\nA: I led a staged migration and reduced failures by 40%.",
    metadata: { userId, sessionId: randomUUID(), kind: "qa_pair", externalId: `${userId}:0`, questionIndex: 0, answerScores: { starScore: 4 } } };
  const written = await memory.storeMemory(record);
  assert.ok(written.id);
  assert.equal((await memory.storeMemory(record)).status, "already_synced");
  let result;
  for (let attempt = 0; attempt < 10; attempt++) {
    result = await memory.retrieveMemory({ userId, query: "migration failures" });
    if (result.memories.length) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(result.memories.some((item) => item.metadata.externalId === record.metadata.externalId));
  console.log("Live memory write, search, and retry passed.");
} finally {
  const assistantId = await store.transaction(userId, (state) => state.assistantId);
  if (assistantId) await deleteAssistant(assistantId);
}
