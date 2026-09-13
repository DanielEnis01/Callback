export const CALIBRATION_NOTICE_MS = 90_000;

export function shouldShowCalibrationNotice(
  active: boolean, elapsedMs: number, missingCount: number, dismissed: boolean,
): boolean {
  return active && elapsedMs >= CALIBRATION_NOTICE_MS && missingCount > 0 && !dismissed;
}
