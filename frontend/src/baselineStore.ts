/**
 * Local, per-device stand-in for a real "save the user's calibration
 * baseline" backend call. There's no accounts/database yet, so this just
 * persists to localStorage — swap `saveBaseline`/`getBaseline` for a real
 * API call once there's a backend + per-user auth; the `Baseline` shape
 * below is what should move over unchanged.
 */

import type { MediaPipeBaseline } from "./useMediaPipe";

export interface Baseline {
  /** ISO timestamp of when calibration finished. */
  capturedAt: string;
  /** How many metrics samples the average below was computed from. */
  sampleCount: number;

  restingPulseBpm: number | null;
  breathingRatePerMin: number | null;
  breathingAmplitude: number | null;
  blinkRatePerMin: number | null;

  hrv: {
    rmssd: number | null;
    sdnn: number | null;
    meanNn: number | null;
  };
  baevsky: number | null;
  stressLabel: "Low" | "Moderate" | "High" | null;

  edaMicroSiemens: number | null;
  microMotion: {
    seat: number | null;
    knees: number | null;
  };

  /** MediaPipe calibration baselines — null if models failed to load. */
  mediaPipe: MediaPipeBaseline | null;
}

/** Context collected once during calibration for tailoring later interview
 *  practice. Job postings are NOT part of this — those are per-session (see
 *  SessionContext below) since a person interviews for different roles
 *  across sessions but only calibrates/uploads a base resume once. */
export interface InterviewProfile {
  name: string;
  targetRoles: string;
  resume: {
    name: string;
    size: number;
  };
}

/**
 * Context collected each time a session is started: which resume to use
 * (defaults to the calibration profile's, but a person can swap in a
 * different one for a specific session), the job posting being practiced
 * for, and an optional weakness to target. All three are what Backboard's
 * RAG layer will be pointed at once it exists — this is just the frontend
 * plumbing for that; there's no backend/document store yet, so only resume
 * metadata is kept, same as InterviewProfile.
 */
export interface SessionContext {
  /** ISO timestamp of when this session's context was set. */
  setAt: string;
  resume: {
    name: string;
    size: number;
  };
  jobPosting: string;
  /** Optional — a single weakness the person wants this session's
   *  questions to target, picked from their stored weakness list (mock
   *  data for now, see MOCK_WEAKNESSES in SessionSetup.tsx — this will
   *  come from real per-user tracked weaknesses once that exists). Empty
   *  string when none picked. Kept to one at a time on purpose, so the
   *  interviewer AI stays focused on a single goal for the session instead
   *  of splitting attention across several. */
  targetWeakness: string;
}

const STORAGE_KEY = "callback.baseline.v1";
const PROFILE_STORAGE_KEY = "callback.interview-profile.v1";
const SESSION_CONTEXT_STORAGE_KEY = "callback.session-context.v1";

export function saveBaseline(baseline: Baseline): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(baseline));
    return true;
  } catch (err) {
    console.error("Failed to save calibration baseline:", err);
    return false;
  }
}

export function getBaseline(): Baseline | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Baseline) : null;
  } catch (err) {
    console.error("Failed to read calibration baseline:", err);
    return null;
  }
}

export function clearBaseline(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

// The browser keeps the selected PDF only for the active session. Persist
// its metadata and the text context here; a backend/secure file store can
// later replace this with actual resume parsing and retention.
export function saveInterviewProfile(profile: InterviewProfile): void {
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch (err) {
    console.error("Failed to save interview profile:", err);
  }
}

export function getInterviewProfile(): InterviewProfile | null {
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as InterviewProfile) : null;
  } catch (err) {
    console.error("Failed to read interview profile:", err);
    return null;
  }
}

// Set on the pre-session context screen (pick a resume, paste the job
// posting) right before a session starts. Same local-only stand-in as
// everything else here — swap for a real per-session backend record (and
// actual resume/job-posting text handed to Backboard's RAG layer) once
// that exists.
export function saveSessionContext(context: SessionContext): void {
  try {
    localStorage.setItem(SESSION_CONTEXT_STORAGE_KEY, JSON.stringify(context));
  } catch (err) {
    console.error("Failed to save session context:", err);
  }
}

export function getSessionContext(): SessionContext | null {
  try {
    const raw = localStorage.getItem(SESSION_CONTEXT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SessionContext) : null;
  } catch (err) {
    console.error("Failed to read session context:", err);
    return null;
  }
}
