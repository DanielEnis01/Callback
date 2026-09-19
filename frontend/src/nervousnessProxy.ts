import { useEffect, useRef, useState } from "react";
import type { MediaPipeBaseline, MediaPipeData } from "./useMediaPipe";

export interface NervousnessComponents {
  movement: number;
  gazeInstability: number;
  headMovement: number;
  postureShift: number;
}

export interface NervousnessProxyState {
  /** 0 = few visible nervousness cues, 100 = many visible cues. */
  score: number | null;
  level: "Low" | "Moderate" | "Elevated" | null;
  status: "calibrating" | "ready" | "unavailable";
  components: NervousnessComponents | null;
}

export interface NervousnessFrame {
  poseMovementRate: number;
  baselineMovementRate?: number | null;
  lookAwayRatio: number;
  headMovementDegPerSecond: number;
  postureShiftRecent: boolean;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/**
 * Convert visible behavior into a 0..100 coaching proxy. This is deliberately
 * not an emotion classifier or medical stress estimate. Each input is produced
 * locally by MediaPipe and is normalized onto 0..1 before weighting.
 */
export function scoreNervousnessFrame(frame: NervousnessFrame): {
  score: number;
  components: NervousnessComponents;
} {
  const calmMovement = Math.max(0, frame.baselineMovementRate ?? 0.15);
  const movementSpan = Math.max(0.5, 1.5 - calmMovement);
  const components: NervousnessComponents = {
    // MediaPipe's existing fidget threshold is 1.5 shoulder-widths/sec.
    movement: clamp01((frame.poseMovementRate - calmMovement) / movementSpan),
    // Looking away for 60%+ of the rolling window saturates this component.
    gazeInstability: clamp01(frame.lookAwayRatio / 0.6),
    // Ignore normal small head adjustments; rapid repeated motion ramps up.
    headMovement: clamp01((frame.headMovementDegPerSecond - 4) / 30),
    postureShift: frame.postureShiftRecent ? 1 : 0,
  };

  const score = 100 * (
    components.movement * 0.5 +
    components.gazeInstability * 0.25 +
    components.headMovement * 0.15 +
    components.postureShift * 0.1
  );

  return { score: Math.round(clamp01(score / 100) * 100), components };
}

const DEFAULT_STATE: NervousnessProxyState = {
  score: null,
  level: null,
  status: "calibrating",
  components: null,
};

/**
 * Builds a smoothed nervousness proxy from the existing MediaPipe gaze and
 * posture stream. No frames or derived values leave the renderer.
 */
export function useNervousnessProxy(
  mediaPipe: MediaPipeData,
  baseline: MediaPipeBaseline | null | undefined,
): NervousnessProxyState {
  const [state, setState] = useState<NervousnessProxyState>(DEFAULT_STATE);
  const previousHead = useRef<{ yaw: number; pitch: number; roll: number; at: number } | null>(null);
  const gazeHistory = useRef<boolean[]>([]);
  const scoreHistory = useRef<number[]>([]);

  useEffect(() => {
    if (mediaPipe.status === "error") {
      previousHead.current = null;
      gazeHistory.current = [];
      scoreHistory.current = [];
      setState({ score: null, level: null, status: "unavailable", components: null });
      return;
    }

    const { headYaw, headPitch, headRoll, poseMovementRate } = mediaPipe;
    if (mediaPipe.status !== "ready") {
      previousHead.current = null;
      gazeHistory.current = [];
      scoreHistory.current = [];
      setState(DEFAULT_STATE);
      return;
    }
    if (mediaPipe.faceBox == null ||
        headYaw == null || headPitch == null || headRoll == null || poseMovementRate == null) {
      previousHead.current = null;
      setState((current) => current.status === "ready"
        ? { score: null, level: null, status: "calibrating", components: null }
        : current);
      return;
    }

    const now = Date.now();
    const previous = previousHead.current;
    const elapsedSeconds = previous ? Math.max(0.1, (now - previous.at) / 1000) : 0;
    const headMovementDegPerSecond = previous
      ? (Math.abs(headYaw - previous.yaw) + Math.abs(headPitch - previous.pitch) + Math.abs(headRoll - previous.roll)) / elapsedSeconds
      : 0;
    previousHead.current = { yaw: headYaw, pitch: headPitch, roll: headRoll, at: now };

    gazeHistory.current.push(mediaPipe.lookingAtCamera);
    if (gazeHistory.current.length > 40) gazeHistory.current.shift();
    const lookAwayRatio = gazeHistory.current.filter((looking) => !looking).length / gazeHistory.current.length;

    const frame = scoreNervousnessFrame({
      poseMovementRate,
      baselineMovementRate: baseline?.restingMovementRate,
      lookAwayRatio,
      headMovementDegPerSecond,
      postureShiftRecent: mediaPipe.postureShiftDetected,
    });
    scoreHistory.current.push(frame.score);
    if (scoreHistory.current.length > 20) scoreHistory.current.shift();

    if (scoreHistory.current.length < 8) {
      setState({ score: null, level: null, status: "calibrating", components: frame.components });
      return;
    }

    const score = Math.round(scoreHistory.current.reduce((sum, value) => sum + value, 0) / scoreHistory.current.length);
    setState({
      score,
      level: score < 30 ? "Low" : score < 60 ? "Moderate" : "Elevated",
      status: "ready",
      components: frame.components,
    });
  }, [
    mediaPipe.status,
    mediaPipe.faceBox,
    mediaPipe.headYaw,
    mediaPipe.headPitch,
    mediaPipe.headRoll,
    mediaPipe.poseMovementRate,
    mediaPipe.lookingAtCamera,
    mediaPipe.postureShiftDetected,
    baseline?.restingMovementRate,
  ]);

  return state;
}
