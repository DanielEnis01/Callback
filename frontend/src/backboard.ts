import { getInterviewProfile, getSessionContext, saveInterviewProfile } from "./baselineStore.ts";

export interface ResumeDocument {
  documentId: string;
  name: string;
  size: number;
  fingerprint: string;
  status: "pending" | "processing" | "indexed" | "error";
}
export interface PlanQuestion {
  text: string;
  type: "behavioral" | "resume" | "job_posting";
  focus: string;
  repeatOf?: { sessionId: string; askedAt: string };
}
export interface InterviewSession {
  sessionId: string;
  startedAt: string;
  interviewPlan: PlanQuestion[] | null;
  transcript: { role: "user" | "model"; parts: { text: string }[]; questionIndex?: number; isClarifying?: boolean }[];
  memorySyncedAt: string | null;
  analysis: null | {
    summary: string; strengths: string[]; weaknesses: string[]; source: string;
    progressNotes: { questionIndex: number; priorSessionId: string; note: string }[];
    staticSignals: { answers: { wordCount: number; starScore: number; quantified: boolean }[] };
  };
}
export interface PreparedInterview { content: string; thread_id: string; questions: PlanQuestion[]; source: string }
export const API_BASE = (import.meta.env?.VITE_API_BASE_URL || "http://localhost:3001").replace(/\/$/, "");
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;
const RESUME_KEY = "callback.resume.local.v1";
let sessionPdf: File | null = null;
let authTokenProvider: (() => Promise<string | null>) | undefined;
let authenticatedUserId: string | null = null;
export const setAuthTokenProvider = (provider: () => Promise<string | null>, userId: string | null) => {
  authTokenProvider = provider; authenticatedUserId = userId;
  if (typeof window !== "undefined") window.dispatchEvent(new Event("callback-analysis-saved"));
};
const resultKey = () => authenticatedUserId ? `callback.latest-analysis:firebase:${authenticatedUserId}`
  : import.meta.env?.DEV ? `callback.latest-analysis:${getDevUser()}:${getMemoryMode()}` : null;
export function getDevUser() {
  let id = localStorage.getItem("callback.dev.user");
  if (!id) { id = `dev-${crypto.randomUUID()}`; localStorage.setItem("callback.dev.user", id); }
  return id;
}
export function getMemoryMode() { return localStorage.getItem("callback.memory.mode") || "mock"; }
export async function interviewHeaders() {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (import.meta.env?.DEV) {
    headers["X-Callback-Dev-User"] = getDevUser();
    headers["X-Callback-Memory-Mode"] = getMemoryMode();
  }
  const token = await authTokenProvider?.();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
export async function callbackApi<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const response = await fetch(`${API_BASE}/api${path}`, { method, headers: await interviewHeaders(),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

// PDFs stay on this device and are sent directly to Gemini with each new plan.
// Backboard never receives a document or a full job posting.
async function pdfStore(operation: "get" | "put" | "delete", file?: File): Promise<File | null> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open("callback-resume", 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore("files");
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction("files", operation === "get" ? "readonly" : "readwrite");
      const files = tx.objectStore("files");
      const request = operation === "get" ? files.get("resume") : operation === "put" ? files.put(file, "resume") : files.delete("resume");
      tx.oncomplete = () => { db.close(); resolve(operation === "get" ? request.result || null : file || null); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}
export function getSavedResume(): ResumeDocument | null {
  try { return JSON.parse(localStorage.getItem(RESUME_KEY) || "null"); } catch { return null; }
}
export const getReadyResume = getSavedResume;
export async function validateResume(file: File) {
  if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") throw new Error("Please choose a PDF resume.");
  if (file.size > MAX_RESUME_BYTES) throw new Error("Choose a PDF of at most 10 MB.");
  if (new TextDecoder().decode((await file.arrayBuffer()).slice(0, 5)) !== "%PDF-") throw new Error("Please choose a valid PDF resume.");
}
export async function setSessionResume(file: File | null) {
  if (file) await validateResume(file);
  sessionPdf = file;
}
export async function uploadResume(file: File, onProgress = (_message: string) => {}): Promise<ResumeDocument> {
  await validateResume(file);
  onProgress("Saving your resume on this device…");
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  await pdfStore("put", file);
  const resume: ResumeDocument = { documentId: `local:${fingerprint}`, name: file.name, size: file.size, fingerprint, status: "indexed" };
  localStorage.setItem(RESUME_KEY, JSON.stringify(resume));
  const profile = getInterviewProfile();
  if (profile) saveInterviewProfile({ ...profile, resume });
  return resume;
}
export async function retryResume(_onProgress = (_message: string) => {}): Promise<ResumeDocument> {
  const resume = getSavedResume();
  if (!resume || !await pdfStore("get")) throw new Error("Select your PDF again to save it on this device.");
  return resume;
}
export async function removeResume(): Promise<void> {
  await pdfStore("delete");
  localStorage.removeItem(RESUME_KEY);
  sessionPdf = null;
  const profile = getInterviewProfile();
  if (profile) saveInterviewProfile({ ...profile, resume: null });
}
async function resumeBase64() {
  const saved = getReadyResume();
  const file = sessionPdf || (saved ? await pdfStore("get") : null);
  if (saved && !file) throw new Error("Your saved PDF is no longer on this device. Select it again in Settings.");
  if (!file) return undefined;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
export async function prepareInterview(): Promise<PreparedInterview> {
  const profile = getInterviewProfile();
  const context = getSessionContext();
  const session = await callbackApi<InterviewSession>("/services/sessions", {
    jobPostingText: context?.jobPosting || profile?.jobPosting || "",
    positionLabel: profile?.targetRoles || "", targetedWeakness: context?.targetWeakness || null,
  });
  const plan = await callbackApi<{ questions: PlanQuestion[]; source: string }>("/services/gemini/interview-plan", { sessionId: session.sessionId, resumePdf: await resumeBase64() });
  return { content: plan.questions[0].text, thread_id: session.sessionId, ...plan };
}
export async function completeInterview(sessionId: string, transcript: InterviewSession["transcript"]) {
  const result = await callbackApi<{ session: InterviewSession; memory: { status: string } }>("/services/analysis/transcript", { sessionId, transcript });
  const key = resultKey();
  if (key) localStorage.setItem(key, JSON.stringify(result.session));
  if (typeof window !== "undefined") window.dispatchEvent(new Event("callback-analysis-saved"));
  return result;
}
export function getLatestAnalysis(): InterviewSession | null {
  try { const key = resultKey(); return key ? JSON.parse(localStorage.getItem(key) || "null") : null; } catch { return null; }
}
