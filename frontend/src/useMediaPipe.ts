import { useEffect, useRef, useState, useCallback } from "react";

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

  // Pose — derived from PoseLandmarker's normalized + world landmarks
  shoulderTiltDeg: number | null;   // shoulder line vs horizontal
  torsoLeanDeg: number | null;     // forward/back lean (shoulders→hips vs vertical)
  /** Normalized distance between shoulders — proxy for camera distance. */
  shoulderDistance: number | null;

  // Movement / Fidget — rolling landmark displacement
  /** Total landmark displacement per second over ~3s window. */
  poseMovementRate: number | null;

  status: "loading" | "ready" | "error";
  error: string | null;
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

// Gaze thresholds — intentionally generous; this is a heuristic, not eye tracking.
const YAW_THRESHOLD_DEG = 15;
const PITCH_THRESHOLD_DEG = 12;

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
  lookingAtCamera: true, lookingAwaySince: null,
  shoulderTiltDeg: null, torsoLeanDeg: null, shoulderDistance: null,
  poseMovementRate: null,
  status: "loading", error: null,
};

// ── Build baseline from calibration samples ──────────────────────────

export function buildMediaPipeBaseline(samples: MediaPipeSample[]): MediaPipeBaseline | null {
  const valid = samples.filter(
    (s) => s.headYaw != null && s.shoulderTiltDeg != null,
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
 * Runs MediaPipe Face Landmarker and Pose Landmarker on the Presage
 * camera stream. Shares the same MediaStream — does NOT call getUserMedia.
 *
 * @param active  Mount/unmount the pipeline (tie to session lifecycle).
 * @param stream  The MediaStream from Presage's `streamAvailable` event.
 * @param collectSamples  When true, pushes every reading into samplesRef
 *                        (used during calibration recording).
 */
export function useMediaPipe(
  active: boolean,
  videoRef: React.RefObject<HTMLVideoElement>,
  collectSamples = false,
) {
  const [data, setData] = useState<MediaPipeData>(DEFAULT);
  const samplesRef = useRef<MediaPipeSample[]>([]);
  const collectRef = useRef(collectSamples);

  useEffect(() => { collectRef.current = collectSamples; }, [collectSamples]);

  // Reset samples when collection starts.
  useEffect(() => {
    if (collectSamples) samplesRef.current = [];
  }, [collectSamples]);

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
    const video = videoRef.current;

    // Ring buffer for fidget detection.
    const movementBuf: number[] = [];

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
                // (existing posture extraction)
                const lm = pr.landmarks[0] as LandmarkXYZ[];
                const ls = lm[11], rs = lm[12];
                const lh = lm[23], rh = lm[24];

                latest.shoulderTiltDeg = shoulderTilt(ls, rs);
                latest.shoulderDistance = landmarkDist(ls, rs);

                if (pr.worldLandmarks?.length && pr.worldLandmarks[0].length >= 25) {
                  const wl = pr.worldLandmarks[0] as LandmarkXYZ[];
                  latest.torsoLeanDeg = torsoLean(wl[11], wl[12], wl[23], wl[24]);
                } else {
                  latest.torsoLeanDeg = torsoLean(ls, rs, lh, rh);
                }

                const keyNow: LandmarkXYZ[] = [lm[0], ls, rs, lh, rh];
                if (prevKeyLandmarks) {
                  let disp = 0;
                  for (let i = 0; i < keyNow.length; i++) {
                    const dx = keyNow[i].x - prevKeyLandmarks[i].x;
                    const dy = keyNow[i].y - prevKeyLandmarks[i].y;
                    disp += Math.sqrt(dx * dx + dy * dy);
                  }
                  movementBuf.push(disp);
                  if (movementBuf.length > MOVEMENT_BUFFER_LEN) movementBuf.shift();
                  const avgDisp = movementBuf.reduce((a, b) => a + b, 0) / movementBuf.length;
                  latest.poseMovementRate = avgDisp * (1000 / POSE_MIN_INTERVAL_MS);
                }
                prevKeyLandmarks = keyNow.map((l) => ({ x: l.x, y: l.y, z: l.z }));
              } else {
                 // console.log("[MediaPipe] No pose detected in this frame");
              }
            } catch (err) {
              console.warn("[MediaPipe] Pose detect error:", err);
            }
          }

          // ── Collect calibration sample ─────────────────────
          if (collectRef.current) {
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
          errorMsg: errorString,
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
