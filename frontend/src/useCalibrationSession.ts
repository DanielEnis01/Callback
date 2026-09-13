import { useEffect, useRef, useState } from "react";
import {
  SmartSpectraSDK,
  breathingMetrics,
  faceMetrics,
  micromotionMetrics,
  edaMetrics,
} from "@smartspectra/node-sdk/renderer";
import { decodeMetrics } from "@smartspectra/node-sdk/messages";

// Requested individually below (not via the cardioMetrics bundle) so we can
// skip ARTERIAL_PRESSURE_TRACE (16), which this app does not use. EDA and
// micromotion are requested explicitly because calibration saves those
// signals as part of the complete baseline.
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

// Protobuf objects can expose default values through their prototype even
// when no value was sent. Only accept actual finite, reliable measurements.
export function measuredValue(record: any, field = "value", positive = false): number | undefined {
  if (!record || (Object.prototype.hasOwnProperty.call(record, "stable") && record.stable === false) || !Object.prototype.hasOwnProperty.call(record, field)) return undefined;
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) && (!positive || value > 0)
    ? value : undefined;
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
  const [validationHint, setValidationHint] = useState<string | null>(null);
  const [pipelineHint, setPipelineHint] = useState<string | null>(null);
  const [cameraQualityHint, setCameraQualityHint] = useState<string | null>(null);
  const [signalDiagnostics, setSignalDiagnostics] = useState<Record<string, string>>({});

  const samplesRef = useRef<CalibrationSample[]>([]);
  const recordingRef = useRef(recording);
  const videoSizeRef = useRef(videoSize);
  const lastFaceBoxRef = useRef<FaceBox | null>(null);
  const lastFaceSeenAtRef = useRef(0);
  const lastBlinkDetectedRef = useRef(false);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  useEffect(() => {
    videoSizeRef.current = videoSize;
  }, [videoSize]);

  useEffect(() => {
    samplesRef.current = [];
    lastFaceBoxRef.current = null;
    lastFaceSeenAtRef.current = 0;
    lastBlinkDetectedRef.current = false;
    setError(null);
    setValidationHint(null);
    setPipelineHint(null);
    setCameraQualityHint(null);
    setSignalDiagnostics({});
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
        requestedMetrics: [
          ...breathingMetrics,
          ...micromotionMetrics,
          ...edaMetrics,
          PULSE_RATE_METRIC,
          HRV_METRIC,
          ...faceMetrics,
        ],
      });
    } catch (err) {
      console.error("Failed to construct SmartSpectraSDK for calibration:", err);
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    let cancelled = false;
    let lastMetricsAt = Date.now();
    let rejectedFrameSince: number | null = null;
    let recoveryAttempts = 0;
    let recoveryInProgress = false;
    let recoveryStartedAt = 0;
    const diagnostics: Record<string, string> = {};

    const describeCamera = (s: MediaStream) => {
      const settings = s.getVideoTracks()[0]?.getSettings?.() ?? {};
      const width = settings.width ?? 0;
      const height = settings.height ?? 0;
      const fps = settings.frameRate ?? 0;
      if ((width > 0 && width < 640) || (height > 0 && height < 480)) {
        return `Camera resolution is ${width || "?"}×${height || "?"}; use at least 640×480 for reliable pulse and face readings.`;
      }
      if (fps > 0 && fps < 15) {
        return `Camera frame rate is ${Math.round(fps)} fps; use at least 15 fps for reliable pulse and motion readings.`;
      }
      return null;
    };

    const recoverSdk = async (reason: string) => {
      if (cancelled || recoveryInProgress) return;
      if (recoveryAttempts >= 1) {
        setStatus("error");
        setError(`SmartSpectra stopped accepting camera frames after an automatic restart. ${reason}`);
        setPipelineHint("The failure is inside the measurement engine, not a lighting or framing warning. Cancel calibration, fully quit Electron, and start it again.");
        return;
      }
      recoveryAttempts += 1;
      recoveryInProgress = true;
      recoveryStartedAt = Date.now();
      setStatus("starting");
      setError(null);
      setPipelineHint("The measurement engine stopped accepting frames. Restarting it and reacquiring the camera…");
      try {
        await sdk.reset();
        if (cancelled) return;
        lastMetricsAt = Date.now();
        rejectedFrameSince = null;
        await sdk.start();
        if (!cancelled) {
          setError(null);
          setPipelineHint("Measurement engine restarted. Waiting for validated readings…");
        }
      } catch (err) {
        if (!cancelled) {
          setStatus("error");
          setError(`SmartSpectra recovery failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        recoveryInProgress = false;
      }
    };
    const recordValue = (key: string, record: any, field = "value", positive = false) => {
      const value = measuredValue(record, field, positive);
      if (record) diagnostics[key] = value !== undefined
        ? "Readings are arriving; collecting enough valid samples."
        : Object.prototype.hasOwnProperty.call(record, "stable") && record.stable === false
          ? "The SDK is returning readings marked unstable. Hold still and follow the camera guidance."
          : "The SDK returned a missing or invalid value; waiting for usable readings.";
      return value;
    };
    const lastTimestamps = new Map<string, string>();
    // Some packets repeat the latest reading. Repeated timestamps must not
    // count as independent evidence toward the minimum sample count.
    const fresh = (key: string, readings: any) => {
      const record = last<any>(readings);
      if (!record) return undefined;
      const timestamp = record.timestamp?.toString();
      if (timestamp && timestamp !== "0") {
        if (lastTimestamps.get(key) === timestamp) return undefined;
        lastTimestamps.set(key, timestamp);
      }
      return record;
    };

    sdk.on("streamAvailable", (s) => {
      if (cancelled) return;
      setStream(s);
      setCameraQualityHint(describeCamera(s));
    });

    sdk.on("processingStatus", (code) => {
      if (cancelled) return;
      if (code === 3) setStatus("running");
      else if (code === 5 && !recoveryInProgress) {
        setPipelineHint("The measurement engine entered an error state. Waiting for its error details…");
      }
    });

    sdk.on("validationStatus", (_code, _timestamp, hint) => {
      if (!cancelled) setValidationHint(hint || null);
    });

    sdk.on("frameSentThrough", (sent) => {
      if (cancelled) return;
      if (sent) rejectedFrameSince = null;
      else if (rejectedFrameSince === null) rejectedFrameSince = Date.now();
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
      lastMetricsAt = Date.now();

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

      const blink = fresh("blink", metrics?.face?.blinking);
      const blinkDetected = blink ? !!blink.detected : lastBlinkDetectedRef.current;
      const blinkEdge = blinkDetected && !lastBlinkDetectedRef.current;
      lastBlinkDetectedRef.current = blinkDetected;

      if (recordingRef.current && Date.now() - lastFaceSeenAtRef.current < FACE_HOLD_MS) {
        const hrv = fresh("hrv", metrics?.cardio?.hrv);
        const pulse = fresh("pulse", metrics?.cardio?.pulseRate);
        const breathRate = fresh("breathRate", metrics?.breathing?.rate);
        const breathAmp = fresh("breathAmp", metrics?.breathing?.amplitude);
        const eda = fresh("eda", metrics?.eda?.trace);
        const seat = fresh("seat", metrics?.micromotion?.glutes);
        const knees = fresh("knees", metrics?.micromotion?.knees);

        samplesRef.current.push({
          t: Date.now(),
          pulse: recordValue("pulse", pulse, "value", true),
          breathingRate: recordValue("breathingRate", breathRate, "value", true),
          breathingAmplitude: recordValue("breathingAmplitude", breathAmp),
          hrvRmssd: recordValue("hrvRmssd", hrv, "rmssd"),
          hrvSdnn: recordValue("hrvSdnn", hrv, "sdnn"),
          hrvMeanNn: recordValue("hrvMeanNn", hrv, "meanNn", true),
          baevsky: recordValue("baevsky", hrv, "baevsky"),
          eda: recordValue("eda", eda),
          micromotionSeat: recordValue("seat", seat),
          micromotionKnees: recordValue("knees", knees),
          blinkDetected: blink ? blinkEdge : undefined,
        });
      }
    });

    sdk.on("error", (code, message, retryable) => {
      if (cancelled) return;
      console.error("SmartSpectra calibration error:", code, message);
      if ((code === 1 || retryable) && Date.now() - recoveryStartedAt > 5000) {
        void recoverSdk(message);
        return;
      }
      setStatus("error");
      setError(message);
    });

    const unsubscribeDiagnostics = window.__callbackSmartSpectraDiagnostics?.onMessage(({ message }) => {
      if (cancelled || !message.includes("dropped frame") || !message.toLowerCase().includes("valid state")) return;
      // Ignore the old graph's trailing frames while reset/start is settling.
      if (recoveryInProgress || Date.now() - recoveryStartedAt <= 5000) return;
      void recoverSdk("The native SDK remained in an invalid state while receiving camera frames.");
    });

    const renderInterval = setInterval(() => {
      const freshEnough = Date.now() - lastFaceSeenAtRef.current < FACE_HOLD_MS;
      setFaceBox(freshEnough ? lastFaceBoxRef.current : null);
      setSignalDiagnostics({ ...diagnostics });
      if (rejectedFrameSince !== null && Date.now() - rejectedFrameSince > 5000) {
        setPipelineHint("The measurement engine is rejecting camera frames. Cancel and restart calibration; check the terminal for the first SDK error.");
      } else if (Date.now() - lastMetricsAt > 15000) {
        setPipelineHint("No measurement data has arrived for 15 seconds. The SDK may still be initializing or may have stalled.");
      } else {
        setPipelineHint(null);
      }
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
      unsubscribeDiagnostics?.();
      sdk.stop().catch(() => {});
      sdk.destroy();
    };
  }, [active]);

  return { stream, status, error, faceBox, samplesRef, validationHint, pipelineHint, cameraQualityHint, signalDiagnostics };
}
