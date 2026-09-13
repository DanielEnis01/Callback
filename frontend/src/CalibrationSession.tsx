import { useEffect, useMemo, useRef, useState, FC } from "react";
import { Check, X, Sun, ScanFace, AlignVerticalSpaceAround, Loader2 } from "lucide-react";
import { CameraFeed } from "./CameraFeed";
import { useCalibrationSession, type CalibrationSample } from "./useCalibrationSession";
import { getInterviewProfile, saveBaseline, saveInterviewProfile, type Baseline } from "./baselineStore";
import { fetchReadingText, fallbackQuotes } from "./readingText";
import { ResumeUpload } from "./ResumeUpload";
import { getReadyResume } from "./backboard";
import { useMediaPipe, buildMediaPipeBaseline } from "./useMediaPipe";

interface CalibrationSessionProps {
  onDone: () => void;
  onCancel: () => void;
}

type Phase = "profile" | "intro" | "checking" | "recording" | "done";

const RECORDING_SECONDS = 40;
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
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
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

export const CalibrationSession: FC<CalibrationSessionProps> = ({ onDone, onCancel }) => {
  const [phase, setPhase] = useState<Phase>("intro");
  const [elapsed, setElapsed] = useState(0);
  const [holdMs, setHoldMs] = useState(0);
  const [brightness, setBrightness] = useState<number | null>(null);
  const [name, setName] = useState(() => getInterviewProfile()?.name ?? "");
  const [targetRoles, setTargetRoles] = useState(() => getInterviewProfile()?.targetRoles ?? "");
  const [resume, setResume] = useState(getReadyResume);
  const [readingInstructionsOpen, setReadingInstructionsOpen] = useState(false);
  const [gazeCalibrationOpen, setGazeCalibrationOpen] = useState(false);
  const [gazeCalibrationDone, setGazeCalibrationDone] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 });

  const profileReady = name.trim().length > 0 && targetRoles.trim().length > 0 && !!resume;

  // Reading passage — a list of generic filler quotes, fetched fresh each
  // time with a bundled offline fallback (see readingText.ts) so
  // calibration never blocks on network. It remains a native scroll area,
  // letting the person control their own reading pace throughout the scan.
  const [quotes, setQuotes] = useState<string[]>(fallbackQuotes());
  useEffect(() => {
    let cancelled = false;
    fetchReadingText().then((list) => {
      if (!cancelled) setQuotes(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const cameraActive = phase === "checking" || phase === "recording";
  // Do not collect baseline samples or advance the clock while the reading
  // instructions or gaze calibration are in front of the passage.
  const recording = phase === "recording" && !readingInstructionsOpen && !gazeCalibrationOpen;
  const { stream, status, error, faceBox, samplesRef } = useCalibrationSession(cameraActive, recording, videoSize);

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
  // "Chest in frame" isn't something the SDK reports directly, so this
  // approximates it from the face box: as long as the chin sits comfortably
  // above the bottom of the frame (with the face not filling the whole
  // picture), there should be room for shoulders/chest below it. Ask the
  // person to sit back a bit if this keeps failing.
  const framedOk =
    faceOk &&
    faceBox!.minY > 0.03 &&
    faceBox!.maxY < 0.6 &&
    faceBox!.maxY - faceBox!.minY < 0.6 &&
    faceBox!.maxY - faceBox!.minY > 0.1;

  const allReady = faceOk && lightingOk && framedOk;

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
      setGazeCalibrationOpen(true);
      setPhase("recording");
    }
  }, [phase, holdMs]);

  // Recording clock — pauses (doesn't advance, doesn't reset) while the
  // face has been missing for longer than the grace period, so a brief
  // look-away doesn't quietly poison the average with empty samples.
  const faceLostSinceRef = useRef<number | null>(null);
  const [facePausedForTooLong, setFacePausedForTooLong] = useState(false);
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
    if (phase !== "recording" || readingInstructionsOpen || facePausedForTooLong) return;
    const t = setInterval(() => setElapsed((e) => Math.min(e + 1, RECORDING_SECONDS)), 1000);
    return () => clearInterval(t);
  }, [phase, readingInstructionsOpen, facePausedForTooLong]);

  useEffect(() => {
    if (phase === "recording" && elapsed >= RECORDING_SECONDS) {
      const baseline = buildBaseline(samplesRef.current, RECORDING_SECONDS * 1000);
      // Attach MediaPipe baselines (neutral head angles, shoulder tilt, etc.).
      baseline.mediaPipe = buildMediaPipeBaseline(mediaPipeSamplesRef.current);
      saveBaseline(baseline);
      setPhase("done");
    }
  }, [phase, elapsed, samplesRef, mediaPipeSamplesRef]);

  const pct = Math.round((elapsed / RECORDING_SECONDS) * 100);
  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  const holdPct = Math.min(100, Math.round((holdMs / HOLD_STEADY_MS) * 100));

  const checklist = useMemo(
    () => [
      { label: "Lighting", ok: lightingOk, icon: Sun, hint: brightness == null ? "Reading…" : brightness < MIN_BRIGHTNESS ? "Too dark" : "Too bright" },
      { label: "Face visible", ok: faceOk, icon: ScanFace, hint: "Look at the camera" },
      { label: "Framing", ok: framedOk && faceOk, icon: AlignVerticalSpaceAround, hint: "Sit back so your shoulders show" },
    ],
    [lightingOk, faceOk, framedOk, brightness],
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
            <span className="tabular-nums">{clock} / 00:40</span>
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 bg-white" /> {readingInstructionsOpen ? "Ready to begin" : facePausedForTooLong ? "Paused" : "Measuring baseline"}
            </span>
          </div>
        )}
      </header>

      {phase === "profile" && (
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-8 sm:px-8">
          <form
            className="mx-auto flex w-full max-w-2xl flex-col gap-6"
            onSubmit={(event) => {
              event.preventDefault();
              if (!profileReady || !resume) return;
              saveInterviewProfile({
                name: name.trim(),
                targetRoles: targetRoles.trim(),
                resume: { name: resume.name, size: resume.size, documentId: resume.documentId },
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
              <ResumeUpload onReadyChange={setResume} />
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
              This is calibration — you'll read a few simple phrases out loud while we measure your resting
              pulse, breathing, and stress level. There's no right answer, nothing to perform; we just need a
              calm reading of you specifically so future sessions can be scored against your own baseline
              instead of a generic average.
            </p>
            <p className="text-[15px] leading-relaxed text-white/60" style={{ fontWeight: 300 }}>
              First we'll open your camera and check the lighting, your face, and framing. Once that looks
              good and holds steady for a couple seconds, a 40-second reading starts automatically.
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

          <div className="shrink-0 grid grid-cols-1 sm:grid-cols-3 gap-px bg-white/12 border border-white/12">
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

            {/* Reading passage — scroll at a comfortable pace while recording */}
            <div className="shrink-0 border border-white/12 p-5">
              <span className="text-[11px] uppercase tracking-[0.16em] text-white/40">
                Read aloud and scroll at your own pace until the timer completes
              </span>
              <div className="relative mt-2 h-48">
                <div className="calibration-reading-passage h-full overflow-y-auto pr-1" tabIndex={0}>
                  <ul className="space-y-4">
                    {quotes.map((q, i) => (
                      <li key={i} className="text-[19px] leading-relaxed text-white/85" style={{ fontWeight: 300 }}>
                        {q}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="pointer-events-none absolute inset-x-0 top-0 h-4 bg-gradient-to-b from-black to-transparent" />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-gradient-to-t from-black to-transparent" />
              </div>
            </div>

            {/* Gaze calibration step — "look directly at the camera" */}
            {gazeCalibrationOpen && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80 p-6">
                <div className="w-full max-w-lg border border-white/20 bg-black p-6 shadow-2xl">
                  <div className="flex items-center gap-3 mb-2">
                    <ScanFace className="h-5 w-5 text-white/60" strokeWidth={1.6} />
                    <p className="text-[11px] uppercase tracking-[0.16em] text-white/40">Posture baseline</p>
                  </div>
                  <h2 className="mt-2 text-[24px] font-800 tracking-tight" style={{ fontWeight: 800 }}>
                    Hold your natural posture.
                  </h2>
                  <p className="mt-4 text-[15px] leading-relaxed text-white/70" style={{ fontWeight: 300 }}>
                    Sit comfortably and face your screen. This sets your neutral posture baseline so we can track shifts and fidgeting during the interview.
                  </p>
                  <p className="mt-3 text-[14px] leading-relaxed text-white/50" style={{ fontWeight: 300 }}>
                    {mediaPipe.status === "error"
                      ? <span className="text-red-400">Error: {mediaPipe.error}</span>
                      : mediaPipe.status === "loading"
                        ? "Loading perception models…"
                        : mediaPipe.lookingAtCamera
                          ? gazeCalibrationDone ? "✓ Posture baseline captured" : "Great — hold steady for a moment…"
                          : "Please look at your screen"}
                  </p>
                  <button
                    onClick={() => {
                      setGazeCalibrationOpen(false);
                      setGazeCalibrationDone(true);
                      setReadingInstructionsOpen(true);
                    }}
                    disabled={mediaPipe.status === "loading"}
                    className="mt-6 h-11 bg-white px-5 text-[13px] font-semibold text-black transition-opacity active:opacity-70 disabled:opacity-40"
                  >
                    Continue
                  </button>
                </div>
              </div>
            )}

            {/* Reading instructions modal */}
            {readingInstructionsOpen && !gazeCalibrationOpen && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80 p-6">
                <div className="w-full max-w-lg border border-white/20 bg-black p-6 shadow-2xl">
                  <p className="text-[11px] uppercase tracking-[0.16em] text-white/40">Before you begin</p>
                  <h2 className="mt-2 text-[24px] font-800 tracking-tight" style={{ fontWeight: 800 }}>
                    Read at your own pace.
                  </h2>
                  <p className="mt-4 text-[15px] leading-relaxed text-white/70" style={{ fontWeight: 300 }}>
                    For this section, please read the quotes aloud until the progress bar is complete.
                  </p>
                  <p className="mt-3 text-[15px] leading-relaxed text-white/70" style={{ fontWeight: 300 }}>
                    Keep your camera in the exact position used during the framing check, and stay in that same position while you read so we can capture an accurate baseline.
                  </p>
                  <button
                    onClick={() => setReadingInstructionsOpen(false)}
                    className="mt-6 h-11 bg-white px-5 text-[13px] font-semibold text-black transition-opacity active:opacity-70"
                  >
                    Begin reading
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Bottom bar */}
          <footer className="h-20 shrink-0 flex items-center gap-4 border-t border-white/12 px-6">
            <div className="flex-1 flex items-center gap-3">
              <div className="h-1.5 flex-1 max-w-md bg-white/12">
                <div className="h-full bg-white transition-all duration-500" style={{ width: `${pct}%` }} />
              </div>
              <span className="text-[12px] text-white/45 tabular-nums">{pct}%</span>
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
