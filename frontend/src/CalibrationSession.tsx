import { useEffect, useMemo, useRef, useState, FC } from "react";
import { Check, X, Sun, ScanFace, AlignVerticalSpaceAround, Loader2, FileText, UploadCloud } from "lucide-react";
import { CalibrationDelayAlert } from "./CalibrationDelayAlert";
import { shouldShowCalibrationNotice } from "./calibrationNotice";
import { CameraFeed } from "./CameraFeed";
import { useCalibrationSession, type CalibrationSample } from "./useCalibrationSession";
import { saveBaseline, saveInterviewProfile, type Baseline } from "./baselineStore";
import { useMediaPipe, buildMediaPipeBaseline } from "./useMediaPipe";

interface CalibrationSessionProps {
  onDone: () => void;
  onCancel: () => void;
}

type Phase = "profile" | "intro" | "checking" | "recording" | "done";

const MIN_RECORDING_SECONDS = 25;
  // A few valid vital readings are enough for this short calibration. Optional
// signals such as EDA and micromotion may still be collected, but they must not
// hold the user in calibration for 35+ seconds while their models initialize.
const MIN_VALID_READINGS = 3;
// How long every readiness check has to hold true, back-to-back, before we
// trust it and start recording — short enough not to be annoying, long
// enough to filter out someone just passing through frame.
const HOLD_STEADY_MS = 2500;
// If we lose the face mid-recording for longer than this, pause the clock
// instead of quietly averaging in garbage samples.
const FACE_LOST_GRACE_MS = 1200;
const BRIGHTNESS_SAMPLE_MS = 300;
// 0-255 luma range we'll accept. Below this reads as "too dark to trust a
// pulse signal off the skin"; above reads as blown-out/overexposed.
const MIN_BRIGHTNESS = 55;
const MAX_BRIGHTNESS = 235;

function mean(values: number[]): number | null {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return null;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}

function stressLabelFor(baevsky: number): "Low" | "Moderate" | "High" {
  if (baevsky < 100) return "Low";
  if (baevsky < 300) return "Moderate";
  return "High";
}

function buildBaseline(samples: CalibrationSample[], recordedMs: number): Baseline {
  const pulses = samples.map((s) => s.pulse).filter((v): v is number => v != null);
  const breathRates = samples.map((s) => s.breathingRate).filter((v): v is number => v != null);
  const breathAmps = samples.map((s) => s.breathingAmplitude).filter((v): v is number => v != null);
  const rmssd = samples.map((s) => s.hrvRmssd).filter((v): v is number => v != null);
  const sdnn = samples.map((s) => s.hrvSdnn).filter((v): v is number => v != null);
  const meanNn = samples.map((s) => s.hrvMeanNn).filter((v): v is number => v != null);
  const baevskyVals = samples.map((s) => s.baevsky).filter((v): v is number => v != null);
  const eda = samples.map((s) => s.eda).filter((v): v is number => v != null);
  const seat = samples.map((s) => s.micromotionSeat).filter((v): v is number => v != null);
  const knees = samples.map((s) => s.micromotionKnees).filter((v): v is number => v != null);
  const blinkCount = samples.filter((s) => s.blinkDetected).length;
  const minutes = Math.max(recordedMs / 60000, 1 / 60);
  const avgBaevsky = mean(baevskyVals);

  return {
    capturedAt: new Date().toISOString(),
    sampleCount: samples.length,
    restingPulseBpm: pulses.length ? Math.round(mean(pulses)!) : null,
    breathingRatePerMin: breathRates.length ? Math.round(mean(breathRates)!) : null,
    breathingAmplitude: mean(breathAmps),
    blinkRatePerMin: Math.round(blinkCount / minutes),
    hrv: { rmssd: mean(rmssd), sdnn: mean(sdnn), meanNn: mean(meanNn) },
    baevsky: avgBaevsky,
    stressLabel: avgBaevsky != null ? stressLabelFor(avgBaevsky) : null,
    edaMicroSiemens: mean(eda),
    microMotion: { seat: mean(seat), knees: mean(knees) },
    mediaPipe: null, // filled in by CalibrationSession after buildMediaPipeBaseline
  };
}

function validCount(samples: CalibrationSample[], getValue: (sample: CalibrationSample) => number | undefined): number {
  return samples.reduce((count, sample) => count + (Number.isFinite(getValue(sample)) ? 1 : 0), 0);
}

function getBaselineReadiness(samples: CalibrationSample[]) {
  const stressReadings = Math.min(
    validCount(samples, (s) => s.hrvRmssd),
    validCount(samples, (s) => s.hrvSdnn),
    validCount(samples, (s) => s.hrvMeanNn),
    validCount(samples, (s) => s.baevsky),
  );
  const items = [
    { key: "pulse", label: "Heartbeat", count: validCount(samples, (s) => s.pulse) },
    { key: "breathing", label: "Breathing", count: Math.min(validCount(samples, (s) => s.breathingRate), validCount(samples, (s) => s.breathingAmplitude)) },
    { key: "stress", label: "Stress / HRV", count: stressReadings },
  ].map((item) => ({
    ...item,
    ready: item.count >= MIN_VALID_READINGS,
  }));

  return { items, ready: items.every((item) => item.ready) };
}

export const CalibrationSession: FC<CalibrationSessionProps> = ({ onDone, onCancel }) => {
  const [phase, setPhase] = useState<Phase>("intro");
  const [elapsed, setElapsed] = useState(0);
  const [waitingSeconds, setWaitingSeconds] = useState(0);
  const [facePausedForTooLong, setFacePausedForTooLong] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [holdMs, setHoldMs] = useState(0);
  const [brightness, setBrightness] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [targetRoles, setTargetRoles] = useState("");
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [draggingResume, setDraggingResume] = useState(false);
  const [readingInstructionsOpen, setReadingInstructionsOpen] = useState(false);
  const [sampleTick, setSampleTick] = useState(0);
  const [slowWarningDismissed, setSlowWarningDismissed] = useState(false);
  const completionStartedRef = useRef(false);
  const resumeInputRef = useRef<HTMLInputElement>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 });

  const selectResume = (file: File | undefined) => {
    if (!file) return;
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      setResumeFile(null);
      setResumeError("Please choose a PDF resume.");
      return;
    }
    setResumeFile(file);
    setResumeError(null);
  };

  const resumeSize = resumeFile
    ? resumeFile.size < 1024 * 1024
      ? `${Math.max(1, Math.round(resumeFile.size / 1024))} KB`
      : `${(resumeFile.size / (1024 * 1024)).toFixed(1)} MB`
    : null;
  const profileReady = name.trim().length > 0 && targetRoles.trim().length > 0 && !!resumeFile;

  const cameraActive = phase === "checking" || phase === "recording";
  // Do not collect baseline samples or advance the clock while the stillness
  // instructions are in front of the camera.
  const readingStarted = phase === "recording" && !readingInstructionsOpen;
  const recording = readingStarted && !facePausedForTooLong;
  const { stream, status, error, faceBox, samplesRef, validationHint, pipelineHint, cameraQualityHint, signalDiagnostics } = useCalibrationSession(cameraActive, recording, videoSize);

  // MediaPipe runs alongside Presage, tracking neutral head orientation
  // and resting posture to build the MediaPipeBaseline.
  const mediaPipe = useMediaPipe(cameraActive, videoRef, recording);
  const mediaPipeSamplesRef = mediaPipe.samplesRef;

  // Track the live video's intrinsic size so landmark coordinates can be
  // de-normalized if they ever arrive as pixels instead of 0..1.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onMeta = () => setVideoSize({ width: video.videoWidth, height: video.videoHeight });
    video.addEventListener("loadedmetadata", onMeta);
    return () => video.removeEventListener("loadedmetadata", onMeta);
  }, [stream]);

  // Lighting check: sample the live frame onto a tiny offscreen canvas and
  // read back average luma. Cheap enough to run a few times a second.
  useEffect(() => {
    if (!cameraActive) {
      setBrightness(null);
      return;
    }
    if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
    const canvas = canvasRef.current;
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const tick = () => {
      const video = videoRef.current;
      if (!video || !ctx || video.readyState < 2) return;
      ctx.drawImage(video, 0, 0, 32, 32);
      const { data } = ctx.getImageData(0, 0, 32, 32);
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      }
      setBrightness(sum / (data.length / 4));
    };

    const t = setInterval(tick, BRIGHTNESS_SAMPLE_MS);
    return () => clearInterval(t);
  }, [cameraActive]);

  const faceOk = !!faceBox;
  const lightingOk = brightness != null && brightness >= MIN_BRIGHTNESS && brightness <= MAX_BRIGHTNESS;
  // Require the face to leave room below it, then confirm MediaPipe can see
  // both shoulders in that space. This prevents a face-only framing from
  // passing when the upper chest is cropped out.
  const framedOk =
    faceOk &&
    faceBox!.minY > 0.03 &&
    faceBox!.maxY < 0.6 &&
    faceBox!.maxY - faceBox!.minY < 0.6 &&
    faceBox!.maxY - faceBox!.minY > 0.1;

  const upperChestOk =
    mediaPipe.status === "ready" &&
    faceOk &&
    mediaPipe.shoulderDistance != null &&
    mediaPipe.shoulderDistance > 0.08 &&
    mediaPipe.midShoulderY != null &&
    mediaPipe.midShoulderY > faceBox!.maxY &&
    mediaPipe.midShoulderY < 0.9;

  const allReady = faceOk && lightingOk && framedOk && upperChestOk;

  // Readiness hold timer — resets the instant any condition drops.
  useEffect(() => {
    if (phase !== "checking") return;
    if (!allReady) {
      setHoldMs(0);
      return;
    }
    const start = Date.now();
    const t = setInterval(() => setHoldMs(Date.now() - start), 100);
    return () => clearInterval(t);
  }, [phase, allReady]);

  useEffect(() => {
    if (phase === "checking" && holdMs >= HOLD_STEADY_MS) {
      setPhase("recording");
      setReadingInstructionsOpen(true);
    }
  }, [phase, holdMs]);

  // Recording clock — pauses (doesn't advance, doesn't reset) while the
  // face has been missing for longer than the grace period, so a brief
  // look-away doesn't quietly poison the average with empty samples.
  const faceLostSinceRef = useRef<number | null>(null);
  useEffect(() => {
    if (phase !== "recording") return;
    if (faceOk) {
      faceLostSinceRef.current = null;
      setFacePausedForTooLong(false);
      return;
    }
    if (faceLostSinceRef.current == null) faceLostSinceRef.current = Date.now();
    const id = setTimeout(() => setFacePausedForTooLong(true), FACE_LOST_GRACE_MS);
    return () => clearTimeout(id);
  }, [phase, faceOk]);

  useEffect(() => {
    if (!recording || status === "error") return;
    let previous = performance.now();
    const tick = () => {
      const now = performance.now();
      setElapsed((seconds) => seconds + (now - previous) / 1000);
      previous = now;
    };
    const t = setInterval(tick, 250);
    return () => { clearInterval(t); tick(); };
  }, [recording, status]);

  // Count the whole camera session, including setup, instructions, and face
  // loss. The alert must still fire if the SDK never reaches recording.
  useEffect(() => {
    if (!cameraActive) return;
    const startedAt = performance.now();
    setWaitingSeconds(0);
    setSlowWarningDismissed(false);
    const t = setInterval(() => setWaitingSeconds((performance.now() - startedAt) / 1000), 250);
    return () => clearInterval(t);
  }, [cameraActive]);

  // Re-render while the SDK and MediaPipe refs are filling in. Their samples
  // are intentionally stored in refs to avoid rendering once per camera frame.
  useEffect(() => {
    if (phase !== "recording") return;
    const t = setInterval(() => setSampleTick((tick) => tick + 1), 500);
    return () => clearInterval(t);
  }, [phase]);

  const baselineReadiness = useMemo(
    () => getBaselineReadiness(samplesRef.current),
    [sampleTick, samplesRef],
  );

  const missingSignals = baselineReadiness.items.filter((item) => !item.ready).map((item) => {
    let reason: string;
    {
      const keys = item.key === "stress" ? ["hrvRmssd", "hrvSdnn", "hrvMeanNn", "baevsky"]
        : item.key === "breathing" ? ["breathingRate", "breathingAmplitude"] : [item.key];
      const reported = keys.map((key) => signalDiagnostics[key]).filter(Boolean);
      reason = error || pipelineHint || (status === "error" ? "The SDK measurement engine reported an error. Cancel and restart calibration." : "") ||
        reported.find((message) => message.includes("unstable") || message.includes("invalid")) || reported[0] ||
        (item.key === "stress" ? "No complete HRV readings yet. Stress is calculated from heart-beat intervals and depends on a usable pulse signal."
          : item.key === "pulse" ? "No usable pulse readings yet. The camera pulse signal must pass the SDK's validation."
          : "Waiting for both breathing rate and amplitude readings. Keep your chest visible.");
      if (cameraQualityHint && !error) reason += ` Camera quality: ${cameraQualityHint}`;
      if (validationHint && !error) reason += ` Camera guidance: ${validationHint}`;
    }
    if (!readingStarted && !error && !pipelineHint) reason = "Baseline collection has not started. Complete the camera check and select Begin calibration. " + reason;
    return { label: item.label, reason };
  });
  const slowWarningOpen = shouldShowCalibrationNotice(cameraActive, waitingSeconds * 1000, missingSignals.length, slowWarningDismissed);

  useEffect(() => {
    if (
      phase === "recording" &&
      elapsed >= MIN_RECORDING_SECONDS &&
      baselineReadiness.ready &&
      !readingInstructionsOpen &&
      !facePausedForTooLong &&
      status === "running" &&
      !completionStartedRef.current
    ) {
      completionStartedRef.current = true;
      const baseline = buildBaseline(samplesRef.current, elapsed * 1000);
      // Posture is useful when available, but the 25-second vitals calibration
      // should not fail just because the optional local model is unavailable.
      baseline.mediaPipe = buildMediaPipeBaseline(mediaPipeSamplesRef.current);
      if (!saveBaseline(baseline)) {
        setSaveError("We collected your baseline, but could not save it on this device. Cancel and try again after freeing browser storage.");
        return;
      }
      setPhase("done");
    }
  }, [phase, elapsed, baselineReadiness.ready, readingInstructionsOpen, facePausedForTooLong, status, samplesRef, mediaPipeSamplesRef]);

  const pct = Math.min(baselineReadiness.ready ? 100 : 99, Math.round(
    Math.min(elapsed / MIN_RECORDING_SECONDS,
      baselineReadiness.items.filter((item) => item.ready).length / baselineReadiness.items.length) * 100));
  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`;
  const holdPct = Math.min(100, Math.round((holdMs / HOLD_STEADY_MS) * 100));

  const checklist = useMemo(
    () => [
      { label: "Lighting", ok: lightingOk, icon: Sun, hint: brightness == null ? "Reading…" : brightness < MIN_BRIGHTNESS ? "Too dark" : "Too bright" },
      { label: "Face visible", ok: faceOk, icon: ScanFace, hint: "Look at the camera" },
      { label: "Framing", ok: framedOk && faceOk, icon: AlignVerticalSpaceAround, hint: "Sit back so your shoulders show" },
      { label: "Upper chest", ok: upperChestOk, icon: AlignVerticalSpaceAround, hint: mediaPipe.status === "loading" ? "Loading posture check" : "Move back until both shoulders and upper chest show" },
    ],
    [lightingOk, faceOk, framedOk, upperChestOk, brightness, mediaPipe.status],
  );

  return (
    <div
      className="h-screen w-full flex flex-col bg-black text-white overflow-hidden"
      style={{ fontFamily: "'Sora', sans-serif" }}
    >
      {/* Top bar */}
      <header className="h-14 shrink-0 flex items-center justify-between border-b border-white/12 px-6">
        <div className="flex items-center gap-3 text-[13px]">
          <span className="font-800 tracking-tight text-[16px]" style={{ fontWeight: 800 }}>Callback.</span>
          <span className="text-white/25">/</span>
          <span className="text-white/60">Calibration</span>
        </div>
        {phase === "recording" && (
          <div className="flex items-center gap-4 text-[13px] text-white/50">
            <span className="tabular-nums">{clock} / 00:25</span>
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 bg-white" />
              {readingInstructionsOpen
                ? "Ready to begin"
                : facePausedForTooLong
                  ? "Paused"
                  : elapsed >= MIN_RECORDING_SECONDS && !baselineReadiness.ready
                    ? "Collecting remaining signals"
                    : "Measuring vitals"}
            </span>
          </div>
        )}
      </header>

      {cameraActive && (
        <div role="status" className="shrink-0 border-b border-white/12 px-6 py-2 text-xs text-white/65">
          Session time: {Math.floor(waitingSeconds / 60)}:{String(Math.floor(waitingSeconds % 60)).padStart(2, "0")}
          {" · "}{error || pipelineHint || cameraQualityHint || validationHint || (status === "error" ? "Measurement engine error — cancel and restart calibration." : "Waiting for camera measurements…")}
        </div>
      )}
      <CalibrationDelayAlert open={slowWarningOpen} missing={missingSignals}
        onDismiss={() => setSlowWarningDismissed(true)} onCancel={onCancel} />

      {phase === "profile" && (
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-8 sm:px-8">
          <form
            className="mx-auto flex w-full max-w-2xl flex-col gap-6"
            onSubmit={(event) => {
              event.preventDefault();
              if (!profileReady || !resumeFile) return;
              saveInterviewProfile({
                name: name.trim(),
                targetRoles: targetRoles.trim(),
                resume: { name: resumeFile.name, size: resumeFile.size },
              });
              setPhase("checking");
            }}
          >
            <div>
              <p className="text-[11px] uppercase tracking-[0.16em] text-white/40">Before calibration</p>
              <h1 className="mt-2 text-[32px] font-800 tracking-tight" style={{ fontWeight: 800 }}>
                Personalize your interview prep.
              </h1>
              <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-white/60" style={{ fontWeight: 300 }}>
                Tell us who you are and share your resume so future practice questions can be shaped around your
                background. You&apos;ll add a job posting each time you start a session.
              </p>
            </div>

            <label className="flex flex-col gap-2">
              <span className="text-[13px] text-white/80">Your name <span className="text-white/40">*</span></span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
                placeholder="e.g. Jordan Doe"
                className="h-11 border border-white/20 bg-transparent px-3 text-[14px] text-white outline-none placeholder:text-white/25 focus:border-white/60"
              />
            </label>

            <label className="flex flex-col gap-2">
              <span className="text-[13px] text-white/80">Internship roles you&apos;re targeting <span className="text-white/40">*</span></span>
              <input
                value={targetRoles}
                onChange={(event) => setTargetRoles(event.target.value)}
                placeholder="e.g. Software engineering, product management"
                className="h-11 border border-white/20 bg-transparent px-3 text-[14px] text-white outline-none placeholder:text-white/25 focus:border-white/60"
              />
              <span className="text-[11px] text-white/35">Separate multiple roles with commas.</span>
            </label>

            <div className="flex flex-col gap-2">
              <span className="text-[13px] text-white/80">Resume <span className="text-white/40">*</span></span>
              <input
                ref={resumeInputRef}
                type="file"
                accept="application/pdf,.pdf"
                className="sr-only"
                onChange={(event) => selectResume(event.target.files?.[0])}
              />
              <button
                type="button"
                onClick={() => resumeInputRef.current?.click()}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDraggingResume(true);
                }}
                onDragLeave={() => setDraggingResume(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDraggingResume(false);
                  selectResume(event.dataTransfer.files?.[0]);
                }}
                className={`flex min-h-32 flex-col items-center justify-center gap-2 border border-dashed px-5 py-6 text-center transition-colors ${
                  draggingResume ? "border-white bg-white/10" : "border-white/30 bg-white/[0.02] hover:border-white/60"
                }`}
              >
                {resumeFile ? (
                  <>
                    <FileText className="h-6 w-6 text-white" strokeWidth={1.6} />
                    <span className="text-[14px] text-white">{resumeFile.name}</span>
                    <span className="text-[12px] text-white/45">PDF · {resumeSize} · Click to replace</span>
                  </>
                ) : (
                  <>
                    <UploadCloud className="h-6 w-6 text-white/65" strokeWidth={1.6} />
                    <span className="text-[14px] text-white/85">Drop your resume here, or click to browse</span>
                    <span className="text-[12px] text-white/40">PDF files only</span>
                  </>
                )}
              </button>
              {resumeError && <span className="text-[12px] text-red-300">{resumeError}</span>}
            </div>

            <div className="flex items-center justify-between gap-3 pt-1">
              <button
                type="button"
                onClick={onCancel}
                className="flex h-11 items-center gap-2 border border-white/20 px-4 text-[13px] font-semibold text-white transition-colors hover:border-white/50"
              >
                <X className="h-4 w-4" strokeWidth={1.8} /> Cancel
              </button>
              <button
                type="submit"
                disabled={!profileReady}
                className="h-11 bg-white px-5 text-[13px] font-semibold text-black transition-opacity disabled:cursor-not-allowed disabled:opacity-30 active:opacity-70"
              >
                Continue to camera check
              </button>
            </div>
          </form>
        </div>
      )}

      {phase === "intro" && (
        <div className="flex-1 min-h-0 flex items-center justify-center p-8">
          <div className="max-w-lg flex flex-col gap-6">
            <h1 className="text-[32px] font-800 tracking-tight" style={{ fontWeight: 800 }}>
              Let's find your baseline.
            </h1>
            <p className="text-[15px] leading-relaxed text-white/60" style={{ fontWeight: 300 }}>
              This is a short calibration. We&apos;ll measure your resting pulse, breathing, and stress level so
              your interview feedback is compared with your own baseline instead of a generic average.
            </p>
            <p className="text-[15px] leading-relaxed text-white/60" style={{ fontWeight: 300 }}>
              First we&apos;ll check your lighting, face, and framing. Then stay still, breathe normally, and keep
              your face and shoulders visible for 25 seconds while we capture your vitals.
            </p>
            <div className="flex items-center gap-3 mt-2">
              <button
                onClick={onCancel}
                className="flex items-center gap-2 border border-white/20 text-white text-[13px] font-semibold px-4 h-11 rounded-none transition-colors hover:border-white/50"
              >
                <X className="h-4 w-4" strokeWidth={1.8} /> Cancel
              </button>
              <button
                onClick={() => setPhase("profile")}
                className="flex items-center gap-2 bg-white text-black text-[13px] font-semibold px-5 h-11 rounded-none transition-opacity active:opacity-70"
              >
                Begin calibration
              </button>
            </div>
          </div>
        </div>
      )}

      {phase === "checking" && (
        <div className="flex-1 min-h-0 flex flex-col gap-4 p-4">
          <div className="relative flex-1 min-h-0 border border-white/12 bg-white/[0.02] overflow-hidden flex items-center justify-center">
            {stream ? (
              <CameraFeed ref={videoRef} stream={stream} />
            ) : (
              <div className="flex flex-col items-center gap-2 text-white/25 px-6 text-center">
                <Loader2 className="h-6 w-6 animate-spin" strokeWidth={1.6} />
                <span className="text-[12px] uppercase tracking-[0.16em]">
                  {status === "error" ? "Camera failed to start" : "Starting camera…"}
                </span>
                {error && <span className="text-[11px] normal-case text-white/35 max-w-sm">{error}</span>}
              </div>
            )}
            <span className="absolute top-3 left-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-white/45">
              <span className="h-2 w-2 bg-white" /> Checking
            </span>

            {allReady && (
              <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/10">
                <div className="h-full bg-white transition-all duration-100" style={{ width: `${holdPct}%` }} />
              </div>
            )}
          </div>

          <div className="shrink-0 grid grid-cols-2 sm:grid-cols-4 gap-px bg-white/12 border border-white/12">
            {checklist.map((c) => (
              <div key={c.label} className="bg-black p-4 flex items-center gap-3">
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center border ${
                    c.ok ? "border-white bg-white text-black" : "border-white/25 text-white/40"
                  }`}
                >
                  {c.ok ? <Check className="h-4 w-4" strokeWidth={2.2} /> : <c.icon className="h-4 w-4" strokeWidth={1.6} />}
                </span>
                <div className="flex flex-col min-w-0">
                  <span className="text-[13px]">{c.label}</span>
                  <span className="text-[11px] text-white/40 truncate">{c.ok ? "Good" : c.hint}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="shrink-0 flex items-center justify-between">
            <span className="text-[12px] text-white/40">
              {allReady ? "Hold steady…" : "Waiting for lighting, face, and framing to look right."}
            </span>
            <button
              onClick={onCancel}
              className="flex items-center gap-2 border border-white/20 text-white text-[13px] font-semibold px-4 h-11 rounded-none transition-colors hover:border-white/50"
            >
              <X className="h-4 w-4" strokeWidth={1.8} /> Cancel
            </button>
          </div>
        </div>
      )}

      {phase === "recording" && (
        <>
          <div className="flex-1 min-h-0 flex flex-col gap-4 p-4">
            <div className="relative flex-1 min-h-0 border border-white/12 bg-white/[0.02] overflow-hidden flex items-center justify-center">
              {stream && <CameraFeed ref={videoRef} stream={stream} />}
              <span className="absolute bottom-3 left-3 text-[13px] text-white/80 bg-black/40 px-2 py-1">You</span>
              <span className="absolute top-3 left-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-white/45">
                <span className="h-2 w-2 bg-white" /> Calibrating
              </span>
              {facePausedForTooLong && (
                <div className="absolute inset-0 bg-black/70 flex items-center justify-center px-6 text-center">
                  <span className="text-[13px] text-white/80">
                    We lost sight of your face — get back in frame to keep going. The clock is paused.
                  </span>
                </div>
              )}
            </div>

            <div className="shrink-0 border border-white/12 p-5">
              <span className="text-[11px] uppercase tracking-[0.16em] text-white/40">
                Vitals calibration · 25 seconds
              </span>
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[
                  ["Stay still", "Keep your head and shoulders relaxed."],
                  ["Breathe normally", "Use your natural breathing rhythm."],
                  ["Stay well lit", "Keep your face clearly visible to the camera."],
                ].map(([title, detail]) => (
                  <div key={title} className="border border-white/12 px-3 py-3">
                    <p className="text-[13px] text-white">{title}</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-white/45">{detail}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="shrink-0 grid grid-cols-1 sm:grid-cols-3 gap-px bg-white/12 border border-white/12">
              {baselineReadiness.items.map((item) => (
                <div key={item.key} className="bg-black px-3 py-2 flex items-center justify-between gap-2">
                  <span className="text-[11px] text-white/65 truncate">{item.label}</span>
                  <span className={`shrink-0 text-[10px] tabular-nums ${item.ready ? "text-white" : "text-white/35"}`}>
                    {item.ready ? "Ready" : `${item.count}/${MIN_VALID_READINGS}`}
                  </span>
                </div>
              ))}
            </div>

            {/* Vitals instructions modal */}
            {readingInstructionsOpen && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80 p-6">
                <div className="w-full max-w-lg border border-white/20 bg-black p-6 shadow-2xl">
                  <p className="text-[11px] uppercase tracking-[0.16em] text-white/40">Vitals calibration</p>
                  <h2 className="mt-2 text-[24px] font-800 tracking-tight" style={{ fontWeight: 800 }}>
                    Stay still for 25 seconds.
                  </h2>
                  <p className="mt-4 text-[15px] leading-relaxed text-white/70" style={{ fontWeight: 300 }}>
                    Sit comfortably in a well-lit area, keep your face and shoulders in frame, and breathe
                    normally. You do not need to speak.
                  </p>
                  <p className="mt-3 text-[15px] leading-relaxed text-white/70" style={{ fontWeight: 300 }}>
                    Keep the camera in the same position used during the framing check so we can capture a
                    reliable personal baseline.
                  </p>
                  <button
                    onClick={() => setReadingInstructionsOpen(false)}
                    className="mt-6 h-11 bg-white px-5 text-[13px] font-semibold text-black transition-opacity active:opacity-70"
                  >
                    Begin calibration
                  </button>
                </div>
              </div>
            )}

          </div>

          {(error || mediaPipe.error || saveError) && (
            <p role="alert" className="shrink-0 px-6 py-2 text-[13px] text-red-300">
              Calibration cannot finish: {error || mediaPipe.error || saveError}.
              No completed baseline has been saved. Cancel and restart calibration after resolving this error.
            </p>
          )}
          {/* Bottom bar */}
          <footer className="h-20 shrink-0 flex items-center gap-4 border-t border-white/12 px-6">
            <div className="flex-1 flex items-center gap-3">
              <div className="h-1.5 flex-1 max-w-md bg-white/12">
                <div className="h-full bg-white transition-all duration-500" style={{ width: `${pct}%` }} />
              </div>
              <span className="text-[12px] text-white/45 tabular-nums">
                {elapsed < MIN_RECORDING_SECONDS ? `${pct}%` : baselineReadiness.ready ? "Ready" : "Collecting"}
              </span>
            </div>
            <button
              onClick={onCancel}
              className="flex items-center gap-2 border border-white/20 text-white text-[13px] font-semibold px-4 h-11 rounded-none transition-colors hover:border-white/50"
            >
              <X className="h-4 w-4" strokeWidth={1.8} /> Cancel
            </button>
          </footer>
        </>
      )}

      {phase === "done" && (
        <div className="flex-1 min-h-0 flex items-center justify-center p-8">
          <div className="max-w-md flex flex-col items-center text-center gap-5">
            <span className="flex h-14 w-14 items-center justify-center border border-white bg-white text-black">
              <Check className="h-6 w-6" strokeWidth={2.4} />
            </span>
            <h1 className="text-[26px] font-800 tracking-tight" style={{ fontWeight: 800 }}>
              Baseline captured.
            </h1>
            <p className="text-[14px] text-white/55" style={{ fontWeight: 300 }}>
              Saved on this device for now — once accounts are wired up this will move to your profile
              automatically.
            </p>
            <button
              onClick={onDone}
              className="mt-2 flex items-center gap-2 bg-white text-black text-[13px] font-semibold px-6 h-11 rounded-none transition-opacity active:opacity-70"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default CalibrationSession;
