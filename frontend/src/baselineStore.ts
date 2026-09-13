import { dataRequest } from "./dataApi";

import type { MediaPipeBaseline } from "./useMediaPipe";

export interface Baseline {
  capturedAt: string;
  sampleCount: number;
  restingPulseBpm: number | null;
  breathingRatePerMin: number | null;
  breathingAmplitude: number | null;
  blinkRatePerMin: number | null;
  hrv: { rmssd: number | null; sdnn: number | null; meanNn: number | null };
  baevsky: number | null;
  stressLabel: "Low" | "Moderate" | "High" | null;
  edaMicroSiemens: number | null;
  microMotion: { seat: number | null; knees: number | null };

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
  resume: { name: string; size: number };
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

const baselineKey = "callback.static.baseline.v1";
const profileKey = "callback.static.interview-profile.v1";
// Session context has no backend record yet (see the doc comment above), so
// it stays local-only regardless of remoteStorageEnabled — no key change
// needed here if/when that lands.
const sessionContextKey = "callback.session-context.v1";

/** Enable only when Firebase login and the authenticated Tiger Data API are live. */
export const remoteStorageEnabled = import.meta.env.VITE_ENABLE_REMOTE_STORAGE === "true";

function read<T>(key: string): T | null {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

export async function saveBaseline(baseline: Baseline, baselineId = crypto.randomUUID()): Promise<void> {
  if (!remoteStorageEnabled) return write(baselineKey, baseline);
  await dataRequest('/baselines', {
    baseline_id: baselineId, captured_at: baseline.capturedAt,
    baseline_stress_index: baseline.baevsky, baseline_pulse: baseline.restingPulseBpm,
    baseline_breathing_rate: baseline.breathingRatePerMin, baseline_blink_rate: baseline.blinkRatePerMin,
    baseline_fidget_score: baseline.microMotion.seat, baseline_eda: baseline.edaMicroSiemens,
    baseline_breathing_amplitude: baseline.breathingAmplitude, raw_data: baseline,
  });
}

export async function getBaseline(): Promise<Baseline | null> {
  if (!remoteStorageEnabled) return read<Baseline>(baselineKey);
  const result = await dataRequest<{ records: Array<Record<string, any>> }>('/baselines?limit=1');
  const row = result.records[0];
  if (!row) return null;
  if (row.raw_data?.capturedAt && row.raw_data?.hrv && row.raw_data?.microMotion) return row.raw_data as Baseline;
  return {
    capturedAt: row.captured_at, sampleCount: 0, restingPulseBpm: row.baseline_pulse,
    breathingRatePerMin: row.baseline_breathing_rate, breathingAmplitude: row.baseline_breathing_amplitude,
    blinkRatePerMin: row.baseline_blink_rate, baevsky: row.baseline_stress_index,
    stressLabel: row.baseline_stress_index == null ? null : row.baseline_stress_index < 100 ? 'Low' : row.baseline_stress_index < 300 ? 'Moderate' : 'High',
    hrv: { rmssd: null, sdnn: null, meanNn: null }, edaMicroSiemens: row.baseline_eda,
    microMotion: { seat: row.baseline_fidget_score, knees: null },
    mediaPipe: null,
  };
}

export async function saveInterviewProfile(profile: InterviewProfile): Promise<void> {
  if (!remoteStorageEnabled) return write(profileKey, profile);
  await dataRequest('/profile', profile, 'PATCH');
}

export async function getInterviewProfile(): Promise<InterviewProfile | null> {
  if (!remoteStorageEnabled) return read<InterviewProfile>(profileKey);
  return dataRequest('/interview-profile');
}

// Set on the pre-session context screen (pick a resume, paste the job
// posting) right before a session starts. Same local-only stand-in as
// everything else here — swap for a real per-session backend record (and
// actual resume/job-posting text handed to Backboard's RAG layer) once
// that exists.
export function saveSessionContext(context: SessionContext): void {
  try {
    write(sessionContextKey, context);
  } catch (err) {
    console.error("Failed to save session context:", err);
  }
}

export function getSessionContext(): SessionContext | null {
  return read<SessionContext>(sessionContextKey);
}
