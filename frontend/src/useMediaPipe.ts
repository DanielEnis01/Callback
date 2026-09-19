import { useEffect, useRef, useState } from "react";

// ── Types ────────────────────────────────────────────────────────────
// The @mediapipe/tasks-vision package exports these at the top level.
// We import them dynamically at runtime to avoid pulling WASM into the
// initial bundle, but declare the shapes we need here for type safety.

export interface MediaPipeData {
  // Face / Gaze — derived from FaceLandmarker's facial transformation matrix
  headYaw: number | null;       // degrees — negative = looking left
  headPitch: number | null;     // degrees — negative = looking down
  headRoll: number | null;      // degrees
  /** Heuristic: |yaw| < 15° && |pitch| < 12° */
  lookingAtCamera: boolean;
  /** Epoch ms when lookingAtCamera first went false, null if currently looking. */
  lookingAwaySince: number | null;
  /** Normalized face bounds from the locally running Face Landmarker. */
  faceBox: MediaPipeFaceBox | null;

  // Pose — derived from PoseLandmarker's normalized + world landmarks
  shoulderTiltDeg: number | null;   // shoulder line vs horizontal
  torsoLeanDeg: number | null;     // forward/back lean (shoulders→hips vs vertical)
  /** Normalized distance between shoulders — proxy for camera distance. */
  shoulderDistance: number | null;
  /** Normalized (0..1) midpoint of the shoulders — the torso-center point
   *  posture-shift detection tracks. Null until a full pose is seen. */
  midShoulderX: number | null;
  midShoulderY: number | null;

  // Movement / Fidget — rolling TORSO-ONLY landmark displacement (shoulders
  // + hips; deliberately excludes the nose/head so turning your head does
  // not register as body movement). Expressed in shoulder-widths/sec so
  // it's meaningful at any camera distance.
  /** Torso movement rate over the last ~3s, in shoulder-widths/sec. */
  poseMovementRate: number | null;
  /** True while sustained torso movement reads as active fidgeting/swaying
   *  right now — this is the "is their body language unprofessional at
   *  this moment" flag, distinct from the lagging shift count below. */
  isFidgeting: boolean;
  /** Epoch ms when isFidgeting last went true, null while settled. */
  fidgetingSince: number | null;

  // Posture shifts — a *discrete* change in where the torso sits in frame
  // (leaning back and staying, a hard jerk/shake), not head rotation and
  // not single-frame landmark jitter. This is a lagging COUNT — good for
  // an end-of-session "N shifts" stat — not a live signal; use
  // isFidgeting for "are they currently swaying/fidgeting". See the
  // POSTURE_*/FIDGET_* constants below for the exact thresholds.
  /** Running count of discrete posture shifts detected this session. */
  postureShiftCount: number;
  /** True while a just-detected shift is still "fresh" (within its cooldown window) — good for a brief UI flash. */
  postureShiftDetected: boolean;

  status: "loading" | "ready" | "error";
  error: string | null;
}

export interface MediaPipeFaceBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Raw snapshot captured during calibration for baseline averaging. */
export interface MediaPipeSample {
  t: number;
  headYaw: number | null;
  headPitch: number | null;
  headRoll: number | null;
  shoulderTiltDeg: number | null;
  torsoLeanDeg: number | null;
  shoulderDistance: number | null;
  poseMovementRate: number | null;
}

/** Averaged calibration reference values. */
export interface MediaPipeBaseline {
  neutralHeadYaw: number;
  neutralHeadPitch: number;
  neutralHeadRoll: number;
  neutralShoulderTilt: number;
  neutralTorsoLean: number;
  neutralShoulderDistance: number;
  restingMovementRate: number;
}

// ── Constants ────────────────────────────────────────────────────────

const FACE_MIN_INTERVAL_MS = 83;   // ~12 FPS
const POSE_MIN_INTERVAL_MS = 125;  // ~8 FPS

// Gaze thresholds — a heuristic on head pose, not real eye tracking.
//
// These were originally set generously (15/12) because they only drove a
// live UI badge, where false "looking away" flashes are annoying. They now
// also feed the recorded Eye Contact trait, and at those angles a session
// spent deliberately looking off-camera still scored 9.2/10 — a person
// reading a second screen or their own preview window typically sits around
// 10-20 degrees off axis, inside the old yaw window. Tightened to roughly
// where a viewer stops reading it as "looking at me".
//
// This is the tuning knob for that trait: raise these to be more forgiving,
// lower them to be stricter.
const YAW_THRESHOLD_DEG = 10;
const PITCH_THRESHOLD_DEG = 8;

// ── Posture-shift thresholds ─────────────────────────────────────────
// The old (Gemini) version compared the current frame's shoulder-tilt
// ANGLE against a reference captured once, ever, from the first frame —
// noisy (two points, a couple of pixels of landmark jitter swings it
// several degrees) and the reference never adapted, so it fired
// constantly regardless of whether the person actually moved.
//
// Two kinds of "posture shift" both need to count, and they look
// different in the landmark stream:
//   1. A FAST, LARGE movement — a jerk, a shake, a violent sway — shows
//      up as a big jump between two consecutive pose reads (~125ms
//      apart). This has to be checked on the RAW (unsmoothed) position,
//      because smoothing it first is exactly what makes a quick jerk
//      invisible: an EMA only tracks a fraction of a sudden jump each
//      tick, so a jerk that snaps back before the smoothed value catches
//      up never crosses any threshold. This is why the previous revision
//      of this fix — smoothed-position drift only — stayed at zero for a
//      genuinely violent jerk.
//   2. A SLOW, DELIBERATE repositioning — leaning back and staying there
//      — has no single big frame-to-frame jump, so it needs the
//      sustained-drift-from-home check on the SMOOTHED position instead.
// Both funnel into the same counter/cooldown so one continuous movement
// (of either kind) counts once, not many times.
/** EMA smoothing applied to the live torso-center position each frame —
 *  used only for the slow/sustained-drift check, never for jerk detection. */
const TORSO_SMOOTHING_ALPHA = 0.3;
/** Single-tick (~125ms) raw torso displacement, as a fraction of shoulder
 *  width, that counts as an immediate "violent" movement — a jerk, shake,
 *  or hard sway. No sustain required; the magnitude alone is the signal. */
const POSTURE_JERK_THRESHOLD = 0.45;
/** How far the SMOOTHED torso center has to drift from "home", as a
 *  fraction of shoulder width, to count as a slow/deliberate posture
 *  change. Lower than the jerk threshold because it's already filtered
 *  by both the EMA and the sustain requirement below. */
const POSTURE_DRIFT_THRESHOLD = 0.50;
/** Drift has to stay past POSTURE_DRIFT_THRESHOLD this long before it
 *  counts, so a single misdetected frame can't register as a shift. */
const POSTURE_SHIFT_SUSTAIN_MS = 800;
/** Minimum gap between counted shifts, so one continuous sway/lean/shake
 *  registers once instead of repeatedly while it's happening. */
const POSTURE_SHIFT_COOLDOWN_MS = 3000;
/** Slow EMA that lets "home" follow gradual, sub-threshold repositioning
 *  (settling into a chair over minutes) so a long session doesn't end up
 *  permanently "drifted" relative to a stale reference. Deliberately much
 *  slower than TORSO_SMOOTHING_ALPHA so a genuine sudden shift is still
 *  caught before home catches up to it. */
const POSTURE_HOME_DRIFT_ALPHA = 0.015;

// ── Fidgeting / restlessness (continuous, not a counted event) ───────
// postureShiftCount above answers "how many times did they noticeably
// change position" — a lagging tally, good for an end-of-session stat.
// It does NOT answer "are they swaying/fidgeting RIGHT NOW", because
// swaying is oscillatory: it moves away from home and back, repeatedly,
// often without ever sitting still long enough (or displacing far
// enough in one shot) to cross the shift thresholds. The signal that
// actually is continuous, on-the-fly restlessness is activity LEVEL:
// poseMovementRate (torso-only landmark displacement, ~3s smoothed),
// expressed as shoulder-widths of movement per second. An adaptive,
// self-calibrating floor was tried first but overcomplicated it — a
// fixed cutoff, picked from watching the live numbers, does the job.
/** Rate (shoulder-widths/sec) at/above which we call it fidgeting. */
const FIDGET_ON_THRESHOLD = 1.5;
/** Must drop back under this (lower than the on-threshold) before we
 *  call it settled again — the gap is what prevents flicker. */
const FIDGET_OFF_THRESHOLD = 1.2;

// We host the WASM and models locally so we don't rely on CDNs which
// might be blocked by ad-blockers or security policies, causing Event(error).
const WASM_BASE = "/wasm";
const FACE_MODEL = "/models/face_landmarker.task";
const POSE_MODEL = "/models/pose_landmarker_lite.task";

// Ring buffer length for fidget detection — at ~8 FPS this is ~3 seconds.
const MOVEMENT_BUFFER_LEN = 24;

// ── Helpers ──────────────────────────────────────────────────────────

const DEG = 180 / Math.PI;

/**
 * Decompose a 4×4 column-major matrix (MediaPipe's format) into
 * intrinsic Tait–Bryan angles: yaw (Y), pitch (X), roll (Z).
 */
function eulerFromMatrix(m: Float32Array | number[]): { yaw: number; pitch: number; roll: number } {
  // Column-major layout:
  //   m[0] m[4] m[8]  m[12]
  //   m[1] m[5] m[9]  m[13]
  //   m[2] m[6] m[10] m[14]
  //   m[3] m[7] m[11] m[15]
  const r00 = m[0], r01 = m[4], r02 = m[8];
  const r10 = m[1], r11 = m[5], r12 = m[9];
  const r20 = m[2], r21 = m[6], r22 = m[10];

  const sy = Math.sqrt(r00 * r00 + r10 * r10);
  const singular = sy < 1e-6;

  let pitch: number, yaw: number, roll: number;
  if (!singular) {
    pitch = Math.atan2(-r20, sy) * DEG;
    yaw   = Math.atan2(r10, r00) * DEG;
    roll  = Math.atan2(r21, r22) * DEG;
  } else {
    pitch = Math.atan2(-r20, sy) * DEG;
    yaw   = Math.atan2(-r02, r11) * DEG;
    roll  = 0;
  }
  return { yaw, pitch, roll };
}

interface LandmarkXYZ { x: number; y: number; z: number }

function shoulderTilt(left: LandmarkXYZ, right: LandmarkXYZ): number {
  return Math.atan2(right.y - left.y, right.x - left.x) * DEG;
}

function torsoLean(
  leftShoulder: LandmarkXYZ, rightShoulder: LandmarkXYZ,
  leftHip: LandmarkXYZ, rightHip: LandmarkXYZ,
): number {
  const smx = (leftShoulder.x + rightShoulder.x) / 2;
  const smy = (leftShoulder.y + rightShoulder.y) / 2;
  const smz = (leftShoulder.z + rightShoulder.z) / 2;
  const hmx = (leftHip.x + rightHip.x) / 2;
  const hmy = (leftHip.y + rightHip.y) / 2;
  const hmz = (leftHip.z + rightHip.z) / 2;
  // Angle of the torso vector from vertical (Y axis in world coords).
  const dx = smx - hmx;
  const dy = smy - hmy;
  const dz = smz - hmz;
  const lenXZ = Math.sqrt(dx * dx + dz * dz);
  return Math.atan2(lenXZ, Math.abs(dy)) * DEG;
}

function landmarkDist(a: LandmarkXYZ, b: LandmarkXYZ): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// ── Default state ────────────────────────────────────────────────────

const DEFAULT: MediaPipeData = {
  headYaw: null, headPitch: null, headRoll: null,
  lookingAtCamera: true, lookingAwaySince: null, faceBox: null,
  shoulderTiltDeg: null, torsoLeanDeg: null, shoulderDistance: null,
  midShoulderX: null, midShoulderY: null,
  poseMovementRate: null, isFidgeting: false, fidgetingSince: null,
  postureShiftCount: 0, postureShiftDetected: false,
  status: "loading", error: null,
};

// ── Build baseline from calibration samples ──────────────────────────

export function buildMediaPipeBaseline(samples: MediaPipeSample[]): MediaPipeBaseline | null {
  const valid = samples.filter(
    (s) => [s.headYaw, s.headPitch, s.headRoll, s.shoulderTiltDeg,
      s.torsoLeanDeg, s.shoulderDistance, s.poseMovementRate]
      .every((value) => typeof value === "number" && Number.isFinite(value)),
  );
  if (valid.length < 5) return null;

  const avg = (fn: (s: MediaPipeSample) => number | null) => {
    const vals = valid.map(fn).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };

  return {
    neutralHeadYaw: avg((s) => s.headYaw),
    neutralHeadPitch: avg((s) => s.headPitch),
    neutralHeadRoll: avg((s) => s.headRoll),
    neutralShoulderTilt: avg((s) => s.shoulderTiltDeg),
    neutralTorsoLean: avg((s) => s.torsoLeanDeg),
    neutralShoulderDistance: avg((s) => s.shoulderDistance),
    restingMovementRate: avg((s) => s.poseMovementRate),
  };
}

// ── Hook ─────────────────────────────────────────────────────────────

/**
 * Runs MediaPipe Face Landmarker and Pose Landmarker directly against the
 * supplied video element. The model assets and WASM runtime are bundled in
 * `public/`, so inference stays on this device and makes no API calls.
 *
 * @param active  Mount/unmount the pipeline (tie to session lifecycle).
 * @param collectSamples  When true, pushes every reading into samplesRef
 *                        (used during calibration recording).
 */
export function useMediaPipe(
  active: boolean,
  videoRef: React.RefObject<HTMLVideoElement | null>,
  collectSamples = false,
) {
  const [data, setData] = useState<MediaPipeData>(DEFAULT);
  const samplesRef = useRef<MediaPipeSample[]>([]);
  const collectRef = useRef(collectSamples);

  useEffect(() => { collectRef.current = collectSamples; }, [collectSamples]);

  // Pausing collection must preserve the readings already collected.
  useEffect(() => {
    samplesRef.current = [];
  }, [active]);

  useEffect(() => {
    if (!active) {
      setData({ ...DEFAULT });
      return;
    }

    let cancelled = false;
    let faceLandmarker: any = null;
    let poseLandmarker: any = null;
    let rafId: number;
    let renderIntervalId: number;

    // Mutable latest values — written in the rAF loop, read by the
    // render interval so React only re-renders at a sane rate.
    const latest: MediaPipeData = { ...DEFAULT };
    let lookingAwayStart: number | null = null;
    // Ring buffer for fidget/movement-rate detection (torso landmarks only).
    const movementBuf: number[] = [];

    // Posture-shift state — see the POSTURE_* constants for what these mean.
    let rawTorsoPrev: { x: number; y: number } | null = null;   // last raw reading, for jerk detection
    let smoothedTorso: { x: number; y: number } | null = null;  // EMA, for sustained-drift detection
    let homeTorso: { x: number; y: number } | null = null;
    let driftExceededSince: number | null = null;
    let lastShiftAt = 0;
    let postureShiftCount = 0;



    async function init() {
      console.log("[MediaPipe] init started", { active });
      try {
        const vision = await import("@mediapipe/tasks-vision");
        const { FaceLandmarker, PoseLandmarker, FilesetResolver } = vision;

        if (cancelled) return;
        console.log("[MediaPipe] Resolving WASM fileset...");

        const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
        if (cancelled) return;
        console.log("[MediaPipe] Fileset resolved. Loading models...");

        const [face, pose] = await Promise.all([
          FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: FACE_MODEL, delegate: "GPU" },
            runningMode: "VIDEO",
            numFaces: 1,
            outputFacialTransformationMatrixes: true,
            outputFaceBlendshapes: false,
          }),
          PoseLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: POSE_MODEL, delegate: "GPU" },
            runningMode: "VIDEO",
            numPoses: 1,
          }),
        ]);

        if (cancelled) { face.close(); pose.close(); return; }
        console.log("[MediaPipe] Models loaded successfully.");

        faceLandmarker = face;
        poseLandmarker = pose;

        latest.status = "ready";
        setData({ ...latest });

        let lastFaceTs = 0;
        let lastPoseTs = 0;
        let lastValidFaceTs = 0;
        let lastCollectedPoseTs = 0;
        let lastValidPoseTs = 0;
        let prevKeyLandmarks: LandmarkXYZ[] | null = null;

        function loop() {
          if (cancelled) return;
          const video = videoRef.current;
          if (!video || !faceLandmarker || !poseLandmarker) {
            rafId = requestAnimationFrame(loop);
            return;
          }
          if (video.readyState < 2) { rafId = requestAnimationFrame(loop); return; }

          const now = Date.now();
          const timestamp = performance.now();

          // ── Face Landmarker ────────────────────────────────
          if (now - lastFaceTs >= FACE_MIN_INTERVAL_MS) {
            lastFaceTs = now;
            try {
              const fr = faceLandmarker.detectForVideo(video, timestamp);
              if (fr.facialTransformationMatrixes?.length) {
                lastValidFaceTs = now;
                const landmarks = fr.faceLandmarks?.[0] as LandmarkXYZ[] | undefined;
                if (landmarks?.length) {
                  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                  for (const point of landmarks) {
                    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
                    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
                  }
                  latest.faceBox = { minX, maxX, minY, maxY };
                }
                const mat = fr.facialTransformationMatrixes[0].data;
                const { yaw, pitch, roll } = eulerFromMatrix(mat);
                latest.headYaw = yaw;
                latest.headPitch = pitch;
                latest.headRoll = roll;
                const looking = Math.abs(yaw) < YAW_THRESHOLD_DEG && Math.abs(pitch) < PITCH_THRESHOLD_DEG;
                latest.lookingAtCamera = looking;
                if (looking) {
                  lookingAwayStart = null;
                  latest.lookingAwaySince = null;
                } else {
                  if (lookingAwayStart == null) lookingAwayStart = Date.now();
                  latest.lookingAwaySince = lookingAwayStart;
                }
              } else {
                 lastValidFaceTs = 0;
                 latest.faceBox = null;
                 latest.headYaw = null;
                 latest.headPitch = null;
                 latest.headRoll = null;
                 latest.lookingAtCamera = false;
                 if (lookingAwayStart == null) lookingAwayStart = Date.now();
                 latest.lookingAwaySince = lookingAwayStart;
              }
            } catch (err) {
              console.warn("[MediaPipe] Face detect error:", err);
            }
          }

          // ── Pose Landmarker ────────────────────────────────
          if (now - lastPoseTs >= POSE_MIN_INTERVAL_MS) {
            lastPoseTs = now;
            try {
              const pr = poseLandmarker.detectForVideo(video, timestamp);
              if (pr.landmarks?.length && pr.landmarks[0].length >= 25) {
                lastValidPoseTs = now;
                // (existing posture extraction)
                const lm = pr.landmarks[0] as LandmarkXYZ[];
                const ls = lm[11], rs = lm[12];
                const lh = lm[23], rh = lm[24];

                latest.shoulderTiltDeg = shoulderTilt(ls, rs);
                latest.shoulderDistance = landmarkDist(ls, rs);
                // Guarded shoulder width — used to normalize every
                // distance-based signal below (movement rate, jerk, drift)
                // to shoulder-widths so thresholds mean the same thing
                // whether the person is close to or far from the camera.
                const shoulderWidth = latest.shoulderDistance > 0.01 ? latest.shoulderDistance : 0.01;

                if (pr.worldLandmarks?.length && pr.worldLandmarks[0].length >= 25) {
                  const wl = pr.worldLandmarks[0] as LandmarkXYZ[];
                  latest.torsoLeanDeg = torsoLean(wl[11], wl[12], wl[23], wl[24]);
                } else {
                  latest.torsoLeanDeg = torsoLean(ls, rs, lh, rh);
                }

                // Torso-only landmark set — deliberately no nose/head point,
                // so turning your head doesn't register as body movement.
                const keyNow: LandmarkXYZ[] = [ls, rs, lh, rh];
                if (prevKeyLandmarks) {
                  let disp = 0;
                  for (let i = 0; i < keyNow.length; i++) {
                    const dx = keyNow[i].x - prevKeyLandmarks[i].x;
                    const dy = keyNow[i].y - prevKeyLandmarks[i].y;
                    disp += Math.sqrt(dx * dx + dy * dy);
                  }
                  movementBuf.push(disp / shoulderWidth);
                  if (movementBuf.length > MOVEMENT_BUFFER_LEN) movementBuf.shift();
                  const avgDisp = movementBuf.reduce((a, b) => a + b, 0) / movementBuf.length;
                  // Shoulder-widths of torso movement per second.
                  const rate = avgDisp * (1000 / POSE_MIN_INTERVAL_MS);
                  latest.poseMovementRate = rate;

                  // Fidgeting/swaying — a CONTINUOUS state, not a counted
                  // event: hysteresis (two different thresholds) so it
                  // doesn't flicker right at the boundary between
                  // "settled" and "restless".
                  const wasFidgeting = latest.isFidgeting;
                  if (!wasFidgeting && rate >= FIDGET_ON_THRESHOLD) {
                    latest.isFidgeting = true;
                    latest.fidgetingSince = now;
                  } else if (wasFidgeting && rate < FIDGET_OFF_THRESHOLD) {
                    latest.isFidgeting = false;
                    latest.fidgetingSince = null;
                  }
                }
                prevKeyLandmarks = keyNow.map((l) => ({ x: l.x, y: l.y, z: l.z }));

                // ── Posture-shift detection ──────────────────────
                // Track the torso center (midpoint of shoulders+hips) in
                // normalized frame coordinates. Two independent checks feed
                // the same counter/cooldown — see the POSTURE_* constants
                // up top for why both exist: a smoothed "did you drift and
                // stay" check alone misses fast jerks/shakes, because
                // smoothing a sudden snap-and-return never lets the
                // smoothed value catch up far enough to cross a threshold.
                const torsoNow = {
                  x: (ls.x + rs.x + lh.x + rh.x) / 4,
                  y: (ls.y + rs.y + lh.y + rh.y) / 4,
                };
                latest.midShoulderX = (ls.x + rs.x) / 2;
                latest.midShoulderY = (ls.y + rs.y) / 2;

                const offCooldown = now - lastShiftAt >= POSTURE_SHIFT_COOLDOWN_MS;
                let shiftNow = false;

                // 1) Jerk check — raw, unsmoothed frame-to-frame jump. Big
                //    enough on its own, no sustain needed: a violent shake
                //    is unambiguous the instant it happens.
                if (rawTorsoPrev) {
                  const jdx = torsoNow.x - rawTorsoPrev.x;
                  const jdy = torsoNow.y - rawTorsoPrev.y;
                  const jerkRatio = Math.sqrt(jdx * jdx + jdy * jdy) / shoulderWidth;
                  if (jerkRatio > POSTURE_JERK_THRESHOLD && offCooldown) {
                    shiftNow = true;
                  }
                }
                rawTorsoPrev = torsoNow;

                // 2) Sustained-drift check — smoothed position vs. "home",
                //    for slower, deliberate repositioning that never
                //    produces one big single-frame jump.
                smoothedTorso = smoothedTorso
                  ? {
                      x: smoothedTorso.x + (torsoNow.x - smoothedTorso.x) * TORSO_SMOOTHING_ALPHA,
                      y: smoothedTorso.y + (torsoNow.y - smoothedTorso.y) * TORSO_SMOOTHING_ALPHA,
                    }
                  : { ...torsoNow };
                if (!homeTorso) homeTorso = { ...smoothedTorso };

                const driftDx = smoothedTorso.x - homeTorso.x;
                const driftDy = smoothedTorso.y - homeTorso.y;
                const driftRatio = Math.sqrt(driftDx * driftDx + driftDy * driftDy) / shoulderWidth;

                if (driftRatio > POSTURE_DRIFT_THRESHOLD) {
                  if (driftExceededSince == null) driftExceededSince = now;
                  if (now - driftExceededSince >= POSTURE_SHIFT_SUSTAIN_MS && offCooldown) {
                    shiftNow = true;
                  }
                } else {
                  driftExceededSince = null;
                  // Let "home" slowly follow gradual, sub-threshold
                  // repositioning (e.g. settling into a chair) so a long
                  // session doesn't stay permanently "drifted" against a
                  // stale reference. Much slower than the smoothing above,
                  // so a real sudden shift is still caught first.
                  homeTorso = {
                    x: homeTorso.x + driftDx * POSTURE_HOME_DRIFT_ALPHA,
                    y: homeTorso.y + driftDy * POSTURE_HOME_DRIFT_ALPHA,
                  };
                }

                if (shiftNow) {
                  postureShiftCount++;
                  lastShiftAt = now;
                  // Wherever they ended up becomes the new "home" so
                  // holding the new pose doesn't keep re-triggering.
                  homeTorso = { ...smoothedTorso };
                  driftExceededSince = null;
                }
                latest.postureShiftCount = postureShiftCount;
                latest.postureShiftDetected = lastShiftAt > 0 && now - lastShiftAt < POSTURE_SHIFT_COOLDOWN_MS;
              } else {
                 lastValidPoseTs = 0;
                 latest.shoulderTiltDeg = null;
                 latest.torsoLeanDeg = null;
                 latest.shoulderDistance = null;
                 latest.midShoulderX = null;
                 latest.midShoulderY = null;
                 latest.poseMovementRate = null;
                 latest.isFidgeting = false;
                 latest.fidgetingSince = null;
              }
            } catch (err) {
              console.warn("[MediaPipe] Pose detect error:", err);
            }
          }

          // ── Collect calibration sample ─────────────────────
          if (collectRef.current && lastValidPoseTs > lastCollectedPoseTs &&
              lastValidFaceTs > 0 && now - lastValidFaceTs < 500) {
            lastCollectedPoseTs = lastValidPoseTs;
            samplesRef.current.push({
              t: Date.now(),
              headYaw: latest.headYaw,
              headPitch: latest.headPitch,
              headRoll: latest.headRoll,
              shoulderTiltDeg: latest.shoulderTiltDeg,
              torsoLeanDeg: latest.torsoLeanDeg,
              shoulderDistance: latest.shoulderDistance,
              poseMovementRate: latest.poseMovementRate,
            });
          }

          rafId = requestAnimationFrame(loop);
        }

        rafId = requestAnimationFrame(loop);

        // Throttled React state updates — 4 FPS is plenty for the UI.
        renderIntervalId = window.setInterval(() => {
          if (cancelled) return;
          setData({ ...latest });
        }, 250);

      } catch (err: any) {
        if (cancelled) return;
        console.error("MediaPipe init failed:", err);
        
        let errorString = String(err);
        if (err && typeof err === "object" && "type" in err) {
          errorString = `Event(${err.type}) on ${err.target?.src || err.target?.href || "unknown"}`;
        }

        setData({
          ...DEFAULT,
          status: "error",
          error: errorString,
        });
      }
    }

    init();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      window.clearInterval(renderIntervalId);
      faceLandmarker?.close();
      poseLandmarker?.close();
    };
  }, [active]);

  return { ...data, samplesRef };
}
