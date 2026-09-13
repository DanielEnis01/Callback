import assert from "node:assert/strict";
import { createSessionStore } from "../src/services/sessionStore.js";
import { createBackboardService } from "../src/services/backboard.js";
import { createInterviewService } from "../src/services/interview.js";
import { createMockBackboardClient, mockGenerateJson, seedHistory } from "../src/services/memoryDev.js";
const store = createSessionStore();
const memory = createBackboardService(createMockBackboardClient(store), store);
const interview = createInterviewService({ store, memory, generateJson: mockGenerateJson });
await seedHistory("demo-user", { store, memory, interview });
const session = await interview.createSession("demo-user", { jobPostingText: "Software engineer conflict resolution and delivery" });
const plan = await interview.planSession("demo-user", session.sessionId);
assert.equal(plan.questions.filter((question) => question.repeatOf).length, 1);
const transcript = plan.questions.flatMap((question, questionIndex) => [
  { role: "model", parts: [{ text: question.text }], questionIndex, isClarifying: false },
  { role: "user", parts: [{ text: "When our team needed a migration, I led the project and built a staged rollout. We reduced failures by 40% and delivered in six weeks." }], questionIndex, isClarifying: false },
]);
const analysis = await interview.analyzeSession("demo-user", session.sessionId, transcript);
assert.ok(analysis.session.analysis.progressNotes.length);
assert.equal((await memory.syncSession("demo-user", session.sessionId)).status, "already_synced");
assert.equal((await memory.retrieveMemory({ userId: "other-user", query: "migration" })).memories.length, 0);
console.log(JSON.stringify({ mode: "mock — no API calls", repeatedQuestion: plan.questions[0], progressNotes: analysis.session.analysis.progressNotes, sync: analysis.memory, isolation: "passed", retry: "no duplicates" }, null, 2));
