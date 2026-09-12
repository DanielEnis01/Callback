import "dotenv/config";

// smokeTest.js
// Run: BACKBOARD_API_KEY=your_key npm run backboard:smoke
// Exercises the real write/read pipeline against the REAL API, in order,
// with logging and assertions at each step. Cleans up the test assistant
// and document at the end.
//
// Shares a cooldown with backboardExample.js (see lib/apiGuard.js) — running
// either script hits the real API and costs credits, so running both back to
// back is blocked by default. Override with BACKBOARD_API_FORCE=1.

import {
  createUserAssistant,
  afterSessionEnds,
  startSession,
  retrieveMemory,
} from "../src/services/backboard.js";
import { deleteAssistant } from "../src/integrations/backboard/backboardClient.js";

import { checkCooldown, recordRun } from "./lib/apiGuard.js";

const API_KEY = process.env.BACKBOARD_API_KEY;

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`OK: ${message}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!API_KEY) throw new Error("Set BACKBOARD_API_KEY before running this script.");

  checkCooldown("smokeTest.js");
  recordRun("smokeTest.js"); // record the attempt now — a failed run still spent tokens

  let assistantId;
  try {
    console.log("\n1. createUserAssistant");
    const assistant = await createUserAssistant("smoke-test-user");
    assistantId = assistant.assistant_id;
    assert(!!assistantId, "assistant_id returned");
    console.log("   assistant_id:", assistantId);

    console.log("\n2. Completed-session memory extraction (Auto)");
    const msgResponse = await afterSessionEnds({
      assistantId,
      sessionId: `smoke-${Date.now()}`,
      transcriptText: "Interviewer: Tell me about a conflict.\nCandidate: um, uh, there was, um, a disagreement. I often lose my train of thought on conflict questions and want to practice clearer answers.",
      summaryText: "The candidate struggled with filler words and pacing on a behavioral conflict question and wants more practice with structured answers.",
    });
    assert(!!msgResponse.content, "got a generated response");
    console.log("   content:", msgResponse.content);

    console.log("\n3. searchMemories (retrieval-only, no generation call)");
    // Auto-extraction is async and LLM-paraphrased, so: retry briefly rather
    // than assuming instant consistency, and don't assert exact wording —
    // just confirm something was actually extracted and is now searchable.
    let results;
    let foundAny = false;
    for (let attempt = 1; attempt <= 10 && !foundAny; attempt++) {
      results = await retrieveMemory({ assistantId, query: "filler words behavioral question pacing" });
      foundAny = Array.isArray(results.memories) && results.memories.length > 0;
      if (!foundAny) await sleep(1500);
    }
    assert(Array.isArray(results.memories), "memories array returned");
    console.log("   memories:", JSON.stringify(results.memories).slice(0, 300));
    assert(foundAny, "auto-extraction produced at least one searchable memory");

    console.log("\n4. Next-session preparation (Readonly)");
    const next = await startSession({
      assistantId,
      // Fixture supplied at the Backboard boundary; no database is involved.
      trendSentence: "Filler-word count decreased over the previous five sessions.",
      practiceFocus: "behavioral conflict questions",
    });
    assert(!!next.content, "got an opening interview question");
    assert(!!next.thread_id && next.thread_id !== msgResponse.thread_id, "new session has a separate thread");

    console.log("\nAll steps passed.");
  } finally {
    if (assistantId) {
      const status = await deleteAssistant(assistantId);
      console.log("Cleanup delete assistant ->", status);
    }
  }
}

main().catch((err) => {
  console.error("\nSMOKE TEST FAILED:", err.message);
  process.exitCode = 1;
});
