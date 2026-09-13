export type LiveMetricKey = "Emotion" | "Pulse" | "Eye Contact" | "Posture" | "Stress";

/**
 * Resolve both canonical trait labels from Results and the plain-language
 * weakness labels from Session Setup to the live signals that can honestly
 * help during an interview. Text-only skills intentionally return null so
 * the meeting can show its STAR reminder instead of unrelated biometrics.
 */
export function liveMonitorKeysForTarget(target: string | null | undefined): LiveMetricKey[] | null {
  if (!target?.trim()) return null;

  const normalized = target.trim().toLowerCase();

  if (normalized.includes("body language")) return ["Eye Contact", "Posture"];
  if (normalized.includes("eye contact")) return ["Eye Contact"];
  if (normalized.includes("fidget") || normalized.includes("posture")) return ["Posture"];

  const exact: Record<string, LiveMetricKey[]> = {
    composure: ["Stress", "Emotion"],
    "emotional steadiness": ["Emotion", "Stress"],
    "stress recovery": ["Stress", "Pulse"],
    "breathing steadiness": ["Pulse"],
    "positive presence": ["Emotion"],
  };

  return exact[normalized] ?? null;
}
