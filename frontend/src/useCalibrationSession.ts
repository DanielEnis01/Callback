import { useEffect, useRef, useState } from "react";
import { SmartSpectraSDK, breathingMetrics, faceMetrics } from "@smartspectra/node-sdk/renderer";
import { decodeMetrics } from "@smartspectra/node-sdk/messages";

// Requested individually below (not via the cardioMetrics bundle) so we can
// skip ARTERIAL_PRESSURE_TRACE (16) and EDA_TRACE. Both need the SDK's
// encrypted on-device model cache; when that model load fails partway
// through a session, the native engine drops into a permanently broken
// "not in a valid state" loop and silently drops every frame after that
// point, which reads as "lost you, can't get back in frame" no matter how
// still you hold. Pulse rate + HRV (15, 17) are the only cardio fields this
// app actually reads, so there's no reason to request 16 at all.
const PULSE_RATE_METRIC = 15;
const HRV_METRIC = 17;

// Same Presage wiring as usePresageSession.ts (see that file for why the
// /renderer + /messages subpaths specifically). This is a separate hook
// rather than reusing usePresageSession because calibration needs things
// the interview session doesn't: raw per-sample readings to average into a
// baseline, and a live face bounding box to gate on before recording
// starts. Only one of these two hooks is ever mounted at a time (they
// belong to different screens), so there's no conflict running the native
// SDK.

export type CalibrationStatus = "idle" | "starting" | "running" | "error";

export interface FaceBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface CalibrationSample {
  t: number;
  pulse?: number;
  breathingRate?: number;
  breathingAmplitude?: number;
  hrvRmssd?: number;
  hrvSdnn?: number;
  hrvMeanNn?: number;
  baevsky?: number;
  eda?: number;
  micromotionSeat?: number;
  micromotionKnees?: number;
  blinkDetected?: boolean;
}

const RENDER_INTERVAL_MS = 200;
// Landmark updates don't land on every single metrics message — plenty of
// messages carry only blink/talk updates with an empty landmarks array.
// Treating "no landmarks in this message" as "face lost" made the
// readiness checklist flicker on/off many times a second. Instead, hold
// the last-known-good face box for this long before actually calling it
// lost, so a real disappearance still reads as lost quickly but a normal
// gap between landmark updates doesn't.
const FACE_HOLD_MS = 600;

function last<T>(arr: T[] | undefined | null): T | undefined {
  return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : undefined;
}

/**
 * Normalizes a landmark point set into a 0..1 bounding box. Presage's
 * landmarks are expected to already be normalized to the frame (MediaPipe
 * convention), but if a build ever hands back pixel coordinates instead,
 * dividing by the reported video size keeps this from silently producing a
 * box that's off by 100x.
 */
function boundingBoxOf(points: Array<{ x?: number | null; y?: number | null }>, videoW: number, videoH: number): FaceBox | null {
  if (!points.length) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    const x = p.x ?? 0;
    const y = p.y ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const looksNormalized = maxX <= 1.5 && maxY <= 1.5;
  if (!looksNormalized && videoW > 0 && videoH > 0) {
    minX /= videoW; maxX /= videoW; minY /= videoH; maxY /= videoH;
  }
  return { minX, maxX, minY, maxY };
}

export function useCalibrationSession(active: boolean, recording: boolean, videoSize: { width: number; height: number }) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<CalibrationStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [faceBox, setFaceBox] = useState<FaceBox | null>(null);

  const samplesRef = useRef<CalibrationSample[]>([]);
  const recordingRef = useRef(recording);
  const videoSizeRef = useRef(videoSize);
  const lastFaceBoxRef = useRef<FaceBox | null>(null);
  const lastFaceSeenAtRef = useRef(0);
  const lastBlinkDetectedRef = useRef(false);

  useEffect(() => {
    recordingRef.current = recording;
    if (recording) samplesRef.current = [];
  }, [recording]);

  useEffect(() => {
    videoSizeRef.current = videoSize;
  }, [videoSize]);

  useEffect(() => {
    if (!active) {
      setStream(null);
      setStatus("idle");
      setFaceBox(null);
      return;
    }

    const apiKey = import.meta.env.VITE_SMARTSPECTRA_API_KEY as string | undefined;
    if (!apiKey) {
      setStatus("error");
      setError("Missing VITE_SMARTSPECTRA_API_KEY — add it to frontend/.env");
      return;
    }

    let sdk: SmartSpectraSDK;
    try {
      sdk = new SmartSpectraSDK({
        apiKey,
        requestedMetrics: [...breathingMetrics, PULSE_RATE_METRIC, HRV_METRIC, ...faceMetrics],
      });
    } catch (err) {
      console.error("Failed to construct SmartSpectraSDK for calibration:", err);
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    let cancelled = false;

    sdk.on("streamAvailable", (s) => {
      if (cancelled) return;
      setStream(s);
    });

    sdk.on("processingStatus", (code) => {
      if (cancelled) return;
      if (code === 3) setStatus("running");
      else if (code === 5) setStatus("error");
    });

    sdk.on("metrics", (buf) => {
      if (cancelled) return;
      let metrics: any;
      try {
        metrics = decodeMetrics(buf);
      } catch (err) {
        console.error("Failed to decode calibration metrics:", err);
        return;
      }
      if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(metrics)) return;

      // Live face box, used by the readiness check — cheap to compute every
      // message; the render-interval below throttles how often it hits state.
      const landmarks = last<any>(metrics?.face?.landmarks);
      const { width, height } = videoSizeRef.current;
      const points = (landmarks?.value ?? []) as any[];
      if (points.length > 0) {
        const box = boundingBoxOf(points, width, height);
        if (box) {
          lastFaceBoxRef.current = box;
          lastFaceSeenAtRef.current = Date.now();
        }
      }

      const blink = last<any>(metrics?.face?.blinking);
      const blinkDetected = !!blink?.detected;
      const blinkEdge = blinkDetected && !lastBlinkDetectedRef.current;
      lastBlinkDetectedRef.current = blinkDetected;

      if (recordingRef.current) {
        const hrv = last<any>(metrics?.cardio?.hrv);
        const pulse = last<any>(metrics?.cardio?.pulseRate);
        const breathRate = last<any>(metrics?.breathing?.rate);
        const breathAmp = last<any>(metrics?.breathing?.amplitude);
        const eda = last<any>(metrics?.eda?.trace);
        const seat = last<any>(metrics?.micromotion?.glutes);
        const knees = last<any>(metrics?.micromotion?.knees);

        samplesRef.current.push({
          t: Date.now(),
          pulse: pulse?.value ?? undefined,
          breathingRate: breathRate?.value ?? undefined,
          breathingAmplitude: breathAmp?.value ?? undefined,
          hrvRmssd: hrv?.rmssd ?? undefined,
          hrvSdnn: hrv?.sdnn ?? undefined,
          hrvMeanNn: hrv?.meanNn ?? undefined,
          baevsky: hrv?.baevsky ?? undefined,
          eda: eda?.value ?? undefined,
          micromotionSeat: seat?.value ?? undefined,
          micromotionKnees: knees?.value ?? undefined,
          blinkDetected: blinkEdge,
        });
      }
    });

    sdk.on("error", (code, message) => {
      if (cancelled) return;
      console.error("SmartSpectra calibration error:", code, message);
      setStatus("error");
      setError(message);
    });

    const renderInterval = setInterval(() => {
      const freshEnough = Date.now() - lastFaceSeenAtRef.current < FACE_HOLD_MS;
      setFaceBox(freshEnough ? lastFaceBoxRef.current : null);
    }, RENDER_INTERVAL_MS);

    setStatus("starting");
    sdk.start().catch((err) => {
      if (cancelled) return;
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    });

    return () => {
      cancelled = true;
      clearInterval(renderInterval);
      sdk.stop().catch(() => {});
      sdk.destroy();
    };
  }, [active]);

  return { stream, status, error, faceBox, samplesRef };
}
