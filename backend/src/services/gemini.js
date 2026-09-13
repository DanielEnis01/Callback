// Gemini API — reasoning core.
// Receives signals from perception/speech/presage, drives the recruiter
// persona, and routes output to ElevenLabs (voice) + the data layer (logging).

import "dotenv/config";

import { GoogleGenAI } from "@google/genai";

const MODEL = "gemini-3.6-flash";

// Fixed persona for now — swap this out later for a prompt built from
// sessionContext (job posting, resume, etc.) once that plumbing exists.
const RECRUITER_SYSTEM_PROMPT =
  "You are a recruiter, ask questions like you are interviewing someone for a job. Keep the responses brief to around 300 characters";

let client;

function getClient() {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not set. Add it to backend/.env");
    }
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

// --- Dev/test tool ---------------------------------------------------
// Static-prompt sanity check: no perception/presage signals involved.
// Called by POST /api/services/gemini/test (see routes/services.js).
// history is an array of { role: "user" | "model", parts: [{ text }] }
// from previous turns, so multi-turn context is preserved between calls.
// systemContext is optional extra context (resume, job posting, etc.)
// that gets appended to the base recruiter prompt so Gemini can reference
// the candidate's actual background during the conversation.
export async function testRecruiterPrompt(message, history = [], systemContext = "") {
  const ai = getClient();

  const contents = [...history, { role: "user", parts: [{ text: message }] }];

  const fullSystemPrompt = systemContext
    ? `${RECRUITER_SYSTEM_PROMPT}\n\n--- Candidate Context ---\n${systemContext}`
    : RECRUITER_SYSTEM_PROMPT;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: {
      systemInstruction: fullSystemPrompt,
    },
  });

  return response.text;
}

// --- Production entry point -------------------------------------------
// Wired to Perception/Speech/Presage once those signal producers exist.
// Left unimplemented intentionally — the dev tool above is the stepping
// stone toward building this out.
export async function generateCoachResponse({ transcript, perceptionSignals, presageSignal, sessionContext }) {
  // TODO: call Gemini API with transcript + perceptionSignals + presageSignal + sessionContext
  throw new Error("gemini.generateCoachResponse not implemented");
}
