import { createSessionStore, getSessionStore } from "./sessionStore.js";
import { createBackboardService } from "./backboard.js";
import { createInterviewService } from "./interview.js";
import { createMockBackboardClient, mockGenerateJson } from "./memoryDev.js";
import { generateInterviewJson } from "./gemini.js";

export const devToolsEnabled = () => process.env.NODE_ENV !== "production" && process.env.CALLBACK_DEV_TOOLS === "1";
let mockStore;
const runtimes = new Map();
export async function getMemoryRuntime(req) {
  const requested = req.get("X-Callback-Memory-Mode") || process.env.BACKBOARD_MODE || "live";
  const mode = devToolsEnabled() && ["mock", "outage", "empty"].includes(requested) ? requested : "live";
  if (!runtimes.has(mode)) runtimes.set(mode, (async () => {
    const store = mode === "live" ? await getSessionStore() : (mockStore ||= createSessionStore({ filename: process.env.CALLBACK_MOCK_DATA_FILE || new URL("../../.data/mock-sessions.json", import.meta.url).pathname }));
    const memory = createBackboardService(mode === "live" ? undefined : createMockBackboardClient(store, mode), store);
    return { mode, store, memory, interview: createInterviewService({ store, memory, generateJson: mode === "live" ? generateInterviewJson : mockGenerateJson, generationSource: mode === "live" ? "gemini" : "mock" }) };
  })());
  return runtimes.get(mode);
}

export function requireUser(req, res, next) {
  // A verified Firebase middleware can provide req.user. Never trust a body uid
  // or a caller-supplied assistant ID. Dev identities require explicit opt-in.
  const userId = req.user?.userId || (devToolsEnabled() ? req.get("X-Callback-Dev-User") : null);
  if (typeof userId !== "string" || !userId.trim() || userId.length > 128) return res.status(401).json({ error: "Authentication required. For local testing use npm run dev and the Backboard dev tools." });
  req.user = { ...req.user, userId };
  next();
}
