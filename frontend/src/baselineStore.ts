import { dataRequest } from "./dataApi";

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

// raw_data preserves every measured calibration field alongside queryable columns.
export async function saveBaseline(baseline: Baseline, baselineId = crypto.randomUUID()): Promise<void> {
  await dataRequest('/baselines', {
    baseline_id: baselineId, captured_at: baseline.capturedAt,
    baseline_stress_index: baseline.baevsky, baseline_pulse: baseline.restingPulseBpm,
    baseline_breathing_rate: baseline.breathingRatePerMin, baseline_blink_rate: baseline.blinkRatePerMin,
    baseline_fidget_score: baseline.microMotion.seat, baseline_eda: baseline.edaMicroSiemens,
    baseline_breathing_amplitude: baseline.breathingAmplitude, raw_data: baseline,
  });
}
export async function getBaseline(): Promise<Baseline | null> {
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
  await dataRequest('/profile', profile, 'PATCH');
}
export function getInterviewProfile(): Promise<InterviewProfile | null> {
  return dataRequest('/interview-profile');
}
