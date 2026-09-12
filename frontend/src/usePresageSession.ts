import { useEffect, useRef, useState } from "react";
import { SmartSpectraSDK, breathingMetrics, faceMetrics } from "@smartspectra/node-sdk/renderer";
import { presageMetrics, type MetricValues } from "./sessionRecorder";
import { decodeMetrics } from "@smartspectra/node-sdk/messages";

// Requested individually below (not via the cardioMetrics bundle) so we can
// skip ARTERIAL_PRESSURE_TRACE (16) and EDA_TRACE. Both need the SDK's
// encrypted on-device model cache; when that model load fails partway
// through a session, the native engine drops into a permanently broken
// "not in a valid state" loop and silently drops every frame after that
// point. Pulse rate + HRV (15, 17) are the only cardio fields this hook
// actually reads, so there's no reason to request 16 at all.
const PULSE_RATE_METRIC = 15;
const HRV_METRIC = 17;

// Ported from the working TestCamera prototype (../../TestCamera/renderer/renderer.js)
// rather than re-derived from docs — field names, smoothing, and the stress
// thresholds below all come from that proven, running implementation.
//
// Import note: `/renderer` and `/messages` are the two subpaths the SDK
// explicitly documents as safe for a bundled, contextIsolation renderer
// (this app's Vite/Electron setup) — importing straight from the package
// root pulls in its native `koffi` FFI loader, which can't be bundled into
// a browser-like context.

export interface PresageSession {
  stream: MediaStream | null;
  /** Dominant expression, smoothed across frames — e.g. "Happy", "Neutral". */
  emotion: string | null;
  emotionConfidence: number | null; // 0-100
  stress: "Low" | "Moderate" | "High" | null;
  baevsky: number | null;
  pulseBpm: number | null;
  breathingRate: number | null;
  status: "idle" | "starting" | "running" | "error";
  error: string | null;
  /** Latest calibration hint from the SDK's rPPG validation phase, e.g.
   * "Hold still and record." or "No face found." — cardio/breathing/
   * expression stay empty until validation completes, so show this instead
   * of a blank UI while it's in progress. */
  validationHint: string | null;
}

// presage.smartspectra.ExpressionType in the SDK's generated proto — the
// SDK reports this as a raw enum number, not a string.
const EXPRESSION_TYPE_NAMES: Record<number, string> = {
  0: "Unspecified",
  1: "Angry",
  2: "Contempt",
  3: "Disgust",
  4: "Fear",
  5: "Happy",
  6: "Neutral",
  7: "Sad",
  8: "Surprise",
};

// The model reclassifies every frame and jumps around a lot even when your
// expression isn't actually changing, so smooth with an EMA instead of
// rendering the raw per-frame value.
const EMOTION_SMOOTHING_ALPHA = 0.25;

// Render on a fixed clock instead of once per incoming message — face/HRV
// data can arrive 20-30x/sec, far faster than a person can read, and each
// decoded message only carries whatever changed on that tick.
const RENDER_INTERVAL_MS = 250;

function last<T>(arr: T[] | undefined | null): T | undefined {
  return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : undefined;
}

function stressLabelFor(baevsky: number): "Low" | "Moderate" | "High" {
  if (baevsky < 100) return "Low";
  if (baevsky < 300) return "Moderate";
  return "High";
}

const DEFAULT_STATE: PresageSession = {
  stream: null,
  emotion: null,
  emotionConfidence: null,
  stress: null,
  baevsky: null,
  pulseBpm: null,
  breathingRate: null,
  status: "idle",
  error: null,
  validationHint: null,
};

/**
 * Real-time focus/stress signal from the Presage SmartSpectra SDK — the
 * "Presage SDK" piece from the README, running through the sponsor's
 * actual API (SmartSpectra owns camera acquisition itself; see
 * CameraFeed's `stream` prop for how the picture reaches the screen).
 */
export function usePresageSession(active: boolean, onMetrics?: (metrics: MetricValues) => void): PresageSession {
  const metricsCallback = useRef(onMetrics);
  metricsCallback.current = onMetrics;
  const [state, setState] = useState<PresageSession>(DEFAULT_STATE);

  const smoothedScores = useRef<Record<string, number>>({});
  const latestRef = useRef<{ hrv: any; pulse: any; breath: any }>({ hrv: null, pulse: null, breath: null });

  useEffect(() => {
    if (!active) {
      setState(DEFAULT_STATE);
      return;
    }

    const apiKey = import.meta.env.VITE_SMARTSPECTRA_API_KEY as string | undefined;
    if (!apiKey) {
      setState({ ...DEFAULT_STATE, status: "error", error: "Missing VITE_SMARTSPECTRA_API_KEY — add it to frontend/.env" });
      return;
    }

    smoothedScores.current = {};
    latestRef.current = { hrv: null, pulse: null, breath: null };

    let sdk: SmartSpectraSDK;
    try {
      sdk = new SmartSpectraSDK({
        apiKey,
        requestedMetrics: [...breathingMetrics, PULSE_RATE_METRIC, HRV_METRIC, ...faceMetrics],
      });
    } catch (err) {
      // Most likely cause: window.__smartspectraBridge isn't installed —
      // check that electron/preload.cjs is actually loading
      // "@smartspectra/node-sdk/preload" and that main.cjs calls
      // bindSmartSpectraIpc(win). Surfacing this instead of letting it
      // throw during render, which would blank the whole screen.
      console.error("Failed to construct SmartSpectraSDK:", err);
      setState({ ...DEFAULT_STATE, status: "error", error: err instanceof Error ? err.message : String(err) });
      return;
    }

    let cancelled = false;

    sdk.on("streamAvailable", (stream) => {
      if (cancelled) return;
      setState((s) => ({ ...s, stream }));
    });

    sdk.on("processingStatus", (status) => {
      if (cancelled) return;
      // ProcessingStatus: kRunning = 3, kError = 5 (see the SDK's enum export
      // if these need to change — TestCamera pinned them the same way).
      if (status === 3) setState((s) => ({ ...s, status: "running" }));
      else if (status === 5) setState((s) => ({ ...s, status: "error" }));
    });

    // The SDK won't report cardio/breathing/expression until its rPPG
    // validation phase completes — it needs a still, centered, well-lit
    // face for a few seconds first. `hint` (e.g. "Hold still and record.",
    // "No face found.") is exactly what to show the person while that's
    // in progress, so surface it instead of leaving the UI blank.
    sdk.on("validationStatus", (_code, _ts, hint) => {
      if (cancelled) return;
      if (hint) setState((s) => ({ ...s, validationHint: hint }));
    });

    sdk.on("metrics", (buf) => {
      if (cancelled) return;
      let metrics: any;
      try {
        metrics = decodeMetrics(buf);
      } catch (err) {
        console.error("Failed to decode SmartSpectra metrics:", err);
        return;
      }
      if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(metrics)) return;

      metricsCallback.current?.(presageMetrics(metrics));
      const expression = last<any>(metrics?.face?.expression);
      if (expression?.scores?.length) {
        for (const s of expression.scores) {
          const name = EXPRESSION_TYPE_NAMES[s.type] ?? String(s.type);
          const prev = smoothedScores.current[name];
          smoothedScores.current[name] = prev == null ? s.confidence : prev + (s.confidence - prev) * EMOTION_SMOOTHING_ALPHA;
        }
      }

      const hrv = last(metrics?.cardio?.hrv);
      if (hrv) latestRef.current.hrv = hrv;
      const pulse = last(metrics?.cardio?.pulseRate);
      if (pulse) latestRef.current.pulse = pulse;
      const breath = last(metrics?.breathing?.rate);
      if (breath) latestRef.current.breath = breath;
    });

    sdk.on("error", (code, message) => {
      if (cancelled) return;
      console.error("SmartSpectra error:", code, message);
      setState((s) => ({ ...s, status: "error", error: message }));
    });

    const renderInterval = setInterval(() => {
      const entries = Object.entries(smoothedScores.current);
      const top = entries.length ? entries.reduce((a, b) => (b[1] > a[1] ? b : a)) : null;
      const { hrv, pulse, breath } = latestRef.current;

      setState((s) => ({
        ...s,
        emotion: top ? top[0] : s.emotion,
        emotionConfidence: top ? Math.round(top[1]) : s.emotionConfidence,
        baevsky: hrv ? hrv.baevsky : s.baevsky,
        stress: hrv ? stressLabelFor(hrv.baevsky) : s.stress,
        pulseBpm: pulse ? Math.round(pulse.value) : s.pulseBpm,
        breathingRate: breath ? Math.round(breath.value) : s.breathingRate,
      }));
    }, RENDER_INTERVAL_MS);

    setState((s) => ({ ...s, status: "starting" }));
    sdk.start().catch((err) => {
      if (cancelled) return;
      setState((s) => ({ ...s, status: "error", error: err instanceof Error ? err.message : String(err) }));
    });

    return () => {
      cancelled = true;
      clearInterval(renderInterval);
      sdk.stop().catch(() => {});
      sdk.destroy();
    };
  }, [active]);

  return state;
}
