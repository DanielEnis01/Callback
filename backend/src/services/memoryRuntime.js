import { getSessionStore } from "./sessionStore.js";
import { createBackboardService } from "./backboard.js";
import { createInterviewService } from "./interview.js";
import { generateInterviewJson } from "./gemini.js";

let runtime;
export async function getMemoryRuntime() {
  if (!runtime) runtime = (async () => {
    const store = await getSessionStore();
    const memory = createBackboardService(undefined, store);
    return { mode: "live", store, memory, interview: createInterviewService({ store, memory, generateJson: generateInterviewJson, generationSource: "gemini" }) };
  })();
  return runtime;
}

export function requireUser(req, res, next) {
  // A verified Firebase middleware provides req.user.
  const userId = req.user?.userId;
  if (typeof userId !== "string" || !userId.trim() || userId.length > 128) return res.status(401).json({ error: "Authentication required." });
  req.user = { ...req.user, userId };
  next();
}
