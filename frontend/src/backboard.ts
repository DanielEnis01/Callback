import { getInterviewProfile, saveInterviewProfile } from "./baselineStore.ts";

export interface ResumeDocument {
  documentId: string;
  name: string;
  size: number;
  fingerprint: string;
  status: "pending" | "processing" | "indexed" | "error";
}

interface InterviewContext {
  userId: string;
  assistantId?: string;
  resume?: ResumeDocument;
  pendingResume?: ResumeDocument;
}

export interface PreparedInterview {
  content: string;
  thread_id: string;
  assistant_id?: string;
}

const STORAGE_KEY = "callback.backboard.v1";
const API_BASE = (import.meta.env?.VITE_API_BASE_URL || "http://localhost:3001").replace(/\/$/, "");
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;
let assistantRequest: Promise<string> | null = null;
let changingResume = false;

function readContext(): InterviewContext | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
}

function saveContext(context: InterviewContext) {
  // Fail visibly if persistence is unavailable: losing these IDs would create
  // another assistant or upload the same resume on the next visit.
  localStorage.setItem(STORAGE_KEY, JSON.stringify(context));
}

export function getSavedResume(): ResumeDocument | null {
  try {
    const context = readContext();
    return context?.pendingResume ?? context?.resume ?? null;
  } catch {
    return null;
  }
}

export function getReadyResume(): ResumeDocument | null {
  try {
    const context = readContext();
    return !context?.pendingResume && context?.resume?.status === "indexed" ? context.resume : null;
  } catch { return null; }
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/backboard${path}`, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(90000),
    });
  } catch {
    throw new Error("Cannot reach the interview service. Please try again.");
  }
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || "The interview service could not complete the request.");
  if (!data) throw new Error("The interview service returned an empty response.");
  return data;
}

async function ensureAssistant(): Promise<string> {
  const saved = readContext();
  if (saved?.assistantId) return saved.assistantId;
  if (!assistantRequest) {
    assistantRequest = (async () => {
      // Login is currently a mock. Keep one anonymous profile per browser/device
      // until the application's real account layer provides an authenticated ID.
      const context = saved ?? { userId: crypto.randomUUID() };
      saveContext(context);
      const assistant = await api<{ assistant_id: string }>("/assistants", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: context.userId }),
      });
      if (!assistant.assistant_id) throw new Error("The interview service did not create a profile.");
      saveContext({ ...context, assistantId: assistant.assistant_id });
      return assistant.assistant_id;
    })().finally(() => { assistantRequest = null; });
  }
  return assistantRequest;
}

export function validateResume(file: File): void {
  if (!(file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))) {
    throw new Error("Please choose a PDF resume.");
  }
  if (!file.size || file.size > MAX_RESUME_BYTES) throw new Error("Choose a nonempty PDF resume of at most 10 MB.");
}

async function finishPendingResume(onProgress: (message: string) => void): Promise<ResumeDocument> {
  const context = readContext();
  const pending = context?.pendingResume;
  if (!context || !pending) {
    if (context?.resume) return context.resume;
    throw new Error("Upload your resume before starting an interview.");
  }
  onProgress("Reading your resume…");
  const deadline = Date.now() + 90000;
  while (pending.status !== "indexed") {
    if (Date.now() >= deadline) throw new Error("Your resume is still processing. Choose Retry to check it again.");
    const result = await api<{ status: ResumeDocument["status"] }>(`/documents/${encodeURIComponent(pending.documentId)}/status`);
    pending.status = result.status;
    saveContext(context);
    if (pending.status === "error") throw new Error("This PDF could not be read. Upload a text-based PDF or choose another file.");
    if (pending.status !== "indexed") await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  // Keep the previous resume until its replacement is ready. A failed deletion
  // leaves the pending ID saved for retry and blocks starting with mixed resumes.
  if (context.resume && context.resume.documentId !== pending.documentId) {
    onProgress("Replacing your previous resume…");
    await api(`/documents/${encodeURIComponent(context.resume.documentId)}`, { method: "DELETE" });
  }
  context.resume = pending;
  delete context.pendingResume;
  saveContext(context);
  const profile = getInterviewProfile();
  if (profile) saveInterviewProfile({ ...profile, resume: { name: pending.name, size: pending.size, documentId: pending.documentId } });
  return pending;
}

export async function uploadResume(file: File, onProgress = (_message: string) => {}): Promise<ResumeDocument> {
  if (changingResume) throw new Error("A resume update is already in progress.");
  validateResume(file);
  changingResume = true;
  try {
    const bytes = await file.arrayBuffer();
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("Please choose a valid PDF resume.");
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    onProgress("Preparing your interview profile…");
    const assistantId = await ensureAssistant();
    const context = readContext()!;
    if (context.pendingResume && (context.pendingResume.fingerprint !== fingerprint || context.pendingResume.status === "error")) {
      await api(`/documents/${encodeURIComponent(context.pendingResume.documentId)}`, { method: "DELETE" });
      delete context.pendingResume;
      saveContext(context);
    }
    if (!context.pendingResume && context.resume?.fingerprint === fingerprint) return context.resume;
    if (!context.pendingResume) {
      onProgress("Uploading your resume…");
      const doc = await api<{ document_id: string; status: ResumeDocument["status"] }>(
        `/assistants/${encodeURIComponent(assistantId)}/resumes?filename=${encodeURIComponent(file.name)}`,
        { method: "POST", headers: { "Content-Type": "application/pdf" }, body: file },
      );
      if (!doc.document_id) throw new Error("The interview service did not return an upload ID.");
      context.pendingResume = { documentId: doc.document_id, name: file.name, size: file.size, fingerprint, status: doc.status };
      saveContext(context);
    }
    return await finishPendingResume(onProgress);
  } finally {
    changingResume = false;
  }
}

export async function retryResume(onProgress = (_message: string) => {}): Promise<ResumeDocument> {
  if (changingResume) throw new Error("A resume update is already in progress.");
  changingResume = true;
  try { return await finishPendingResume(onProgress); }
  finally { changingResume = false; }
}

export async function removeResume(): Promise<void> {
  if (changingResume) throw new Error("A resume update is already in progress.");
  changingResume = true;
  try {
    const context = readContext();
    if (!context) return;
    for (const key of ["pendingResume", "resume"] as const) {
      const resume = context[key];
      if (resume) {
        await api(`/documents/${encodeURIComponent(resume.documentId)}`, { method: "DELETE" });
        delete context[key];
        saveContext(context);
      }
    }
    const profile = getInterviewProfile();
    if (profile) saveInterviewProfile({ ...profile, resume: null });
  } finally { changingResume = false; }
}

export async function prepareInterview(): Promise<PreparedInterview> {
  if (changingResume) throw new Error("Wait for your resume upload to finish before starting.");
  const context = readContext();
  if (!context?.assistantId || !context.resume) throw new Error("Upload your resume in Settings or calibration before starting an interview.");
  if (context.pendingResume) throw new Error("Finish or remove the pending resume upload before starting an interview.");
  const profile = getInterviewProfile();
  const response = await api<PreparedInterview>(`/assistants/${encodeURIComponent(context.assistantId)}/sessions/start`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      resumeDocumentId: context.resume.documentId,
      candidateName: profile?.name?.trim() || undefined,
      targetRoles: profile?.targetRoles?.trim() || undefined,
      jobPosting: profile?.jobPosting?.trim() || undefined,
    }),
  });
  if (!response.content?.trim() || !response.thread_id) throw new Error("An opening question could not be prepared. Please try again.");
  return response;
}
