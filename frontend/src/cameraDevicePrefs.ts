/**
 * Persists the user's preferred camera across sessions, per machine (this
 * is a local device preference, not account data -- the cameras attached
 * to one computer have nothing to do with another). Read by both
 * CameraPermissionStep (calibration) and CameraDeviceSetting (the Settings
 * page's "Camera" section) so a device picked in one place is what's
 * already selected the next time either one runs.
 */
const STORAGE_KEY = "callback:preferredCameraDeviceId";

export function getPreferredCameraDeviceId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can throw in a locked-down webview / private-browsing-style
    // context -- fall back to "no preference" rather than crash.
    return null;
  }
}

export function setPreferredCameraDeviceId(deviceId: string | null): void {
  try {
    if (deviceId) localStorage.setItem(STORAGE_KEY, deviceId);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best effort only -- losing the saved preference isn't worth surfacing.
  }
}
