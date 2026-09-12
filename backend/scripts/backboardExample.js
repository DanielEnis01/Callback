// Paid example: npm run backboard:example -- /optional/path/to/job-posting.pdf
import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createUserAssistant, setupJobPosting, afterSessionEnds, startSession,
} from "../src/services/backboard.js";
import { deleteAssistant } from "../src/integrations/backboard/backboardClient.js";
import { checkCooldown, recordRun } from "./lib/apiGuard.js";

async function main() {
  if (!process.env.BACKBOARD_API_KEY?.trim()) throw new Error("Set BACKBOARD_API_KEY before running this script.");
  const pdfPath = process.argv[2];
  const pdfBuffer = pdfPath ? await readFile(pdfPath) : null;
  checkCooldown("backboardExample.js");
  recordRun("backboardExample.js");

  let assistantId;
  try {
    const assistant = await createUserAssistant("example-user");
    assistantId = assistant.assistant_id;
    if (pdfBuffer) {
      await setupJobPosting({ assistantId, pdfBuffer, filename: path.basename(pdfPath) });
    }

    // The caller has already finished the interview and derived its summary.
    const completed = await afterSessionEnds({
      assistantId,
      sessionId: "example-session",
      transcriptText: "Interviewer: Tell me about a conflict.\nCandidate: Um, we disagreed on the approach. I listened, then proposed a small experiment.",
      summaryText: "The candidate used filler words before explaining the resolution and could structure behavioral answers more clearly.",
    });
    console.log("Post-session feedback:", completed.content);

    // On the next session, another backend component supplies the SQL trend
    // as text. This Backboard-only example uses a fixed sentence.
    const next = await startSession({
      assistantId,
      trendSentence: "Filler-word count decreased over the previous five sessions.",
      practiceFocus: "structured behavioral answers",
    });
    console.log("Opening question:", next.content);
    console.log("Session thread:", next.thread_id);
    // There are no Backboard calls during the live interview.
  } finally {
    // Only disposable demo assistants are deleted. Real user assistants persist.
    if (assistantId) await deleteAssistant(assistantId);
  }
}

main().catch((error) => {
  console.error("EXAMPLE RUN FAILED:", error.message);
  process.exitCode = 1;
});
