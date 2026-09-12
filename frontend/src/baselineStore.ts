/**
 * Local, per-device stand-in for a real "save the user's calibration
 * baseline" backend call. There's no accounts/database yet, so this just
 * persists to localStorage — swap `saveBaseline`/`getBaseline` for a real
 * API call once there's a backend + per-user auth; the `Baseline` shape
 * below is what should move over unchanged.
 */

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
}

/** Context collected before calibration for tailoring later interview practice. */
export interface InterviewProfile {
  name: string;
  targetRoles: string;
  jobPosting: string | null;
  resume: {
    name: string;
    size: number;
  };
}

const STORAGE_KEY = "callback.baseline.v1";
const PROFILE_STORAGE_KEY = "callback.interview-profile.v1";

export function saveBaseline(baseline: Baseline): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(baseline));
  } catch (err) {
    console.error("Failed to save calibration baseline:", err);
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
