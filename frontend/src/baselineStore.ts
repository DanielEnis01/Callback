import { dataRequest } from "./dataApi";

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
}

export interface InterviewProfile {
  name: string;
  targetRoles: string;
  jobPosting: string | null;
  resume: { name: string; size: number };
}

const baselineKey = "callback.static.baseline.v1";
const profileKey = "callback.static.interview-profile.v1";

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
