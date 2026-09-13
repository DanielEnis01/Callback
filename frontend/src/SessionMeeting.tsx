import { useEffect, useState, useRef, FC } from "react";
import { Video, VideoOff, PhoneOff, Activity, RotateCcw } from "lucide-react";
import { VoiceOrb } from "./VoiceOrb";
import { CameraFeed } from "./CameraFeed";
import { usePresageSession } from "./usePresageSession";
import { useMediaPipe } from "./useMediaPipe";
import { useConversation } from "./useConversation";
import { DevPanel } from "./DevPanel";

import { dataRequest, analyzeSessionTranscript } from "./dataApi";
import { SessionRecorder, type MetricValues } from "./sessionRecorder";
import { remoteStorageEnabled, getSessionContext } from "./baselineStore";
import { staticDataRequest } from "./staticSessionStore";

interface SessionMeetingProps {
  onEnd: () => void;
}

export const SessionMeeting: FC<SessionMeetingProps> = ({ onEnd }) => {
  const [camOff, setCamOff] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  // Captured once at mount: whatever Session Setup saved (job posting text
  // + targeted weakness, including one pre-filled via a "Practice this"
  // click on the Results dashboard -- see Dashboard.tsx). Read once here
  // rather than per-render since SessionRecorder is only constructed once.
  // Declared before the conversation hook because its id IS this session's
  // id, which the hook needs to save the interview plan's extracted role.
  const [recorder] = useState(() => {
    const context = getSessionContext();
    return new SessionRecorder(remoteStorageEnabled ? dataRequest : staticDataRequest, {
      targetedWeakness: context?.targetWeakness || undefined,
      jobPostingText: context?.jobPosting || undefined,
    });
  });

  // Live voice conversation loop (STT -> Gemini -> ElevenLabs TTS). Drives
  // the recruiter orb's animation and the mic-listening badge below.
  const conversation = useConversation(remoteStorageEnabled ? recorder.id : undefined);
  const windowMetrics = useRef<MetricValues>({});
  const endingRef = useRef(false);
  const [ending, setEnding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [storageStatus, setStorageStatus] = useState(remoteStorageEnabled ? 'Connecting to Tiger Data…' : 'Static mode: session data stays on this device.');
  const collect = (values: MetricValues) => { if (!endingRef.current) Object.assign(windowMetrics.current, values); };
  const captureWindow = () => {
    recorder.enqueue(windowMetrics.current);
    windowMetrics.current = {};
  };
  useEffect(() => {
    let current = true;
    const flush = () => recorder.flush().then(() => {
      if (current) { setStorageError(''); setStorageStatus(remoteStorageEnabled ? 'Saved to Tiger Data' : 'Saved on this device'); }
    }).catch(error => { if (current) setStorageError(error.message); });
    void flush();
    const timer = setInterval(() => {
      if (endingRef.current) return;
      try { captureWindow(); void flush(); }
      catch (error) { setStorageError((error as Error).message); setCamOff(true); }
    }, 1000);
    return () => { current = false; clearInterval(timer); };
  }, [recorder]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // The interview is a fixed four questions, so it ends itself: once the
  // recruiter has delivered its closing line, wrap up and go to results
  // rather than leaving the user sitting in a finished session wondering
  // whether to hit End.
  useEffect(() => {
    if (!conversation.interviewComplete || endingRef.current) return;
    void finishSession();
    // finishSession is stable enough for this one-shot transition; re-running
    // on every render would risk double-ending the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.interviewComplete]);
  async function finishSession() {
    if (saving) return;
    endingRef.current = true;
    setEnding(true); setSaving(true); setStorageError('');
    try {
      captureWindow();
      await recorder.finish();

      // Fire the post-session transcript analysis in the background — it's
      // a real Gemini call on top of the static STAR/quantification/filler
      // checks (see analyzeSessionTranscript / python/analysis_service.py),
      // so it can take several seconds and shouldn't hold up navigation.
      // Passing recorder.id lets the backend persist the result against this
      // session (see services.js's POST /analysis/transcript), so it shows
      // up later in the "Session summary" view in SavedSessions.tsx —
      // remote-storage mode only; recorder.id has no backend row to attach
      // to in static mode, so persistence there is a harmless no-op (server
      // returns persisted: false rather than erroring).
      // Read the transcript off the hook's ref, NOT `conversation.history`:
      // the awaits above (flushing metrics, closing the session row) give a
      // turn that lands mid-teardown time to miss the render this closure
      // captured, which silently saves a partial transcript.
      const transcript = conversation.getHistory();
      if (transcript.length > 0) {
        const sessionContext = getSessionContext();
        void analyzeSessionTranscript(
          transcript,
          sessionContext?.jobPosting,
          sessionContext?.targetWeakness,
          remoteStorageEnabled ? recorder.id : undefined
        )
          .then((analysis) => console.log('[Session analysis]', analysis))
          .catch((error) => console.error('[Session analysis] failed:', error));
      }

      onEnd();
    }
    catch (error) { setStorageError((error as Error).message); }
    finally { setSaving(false); }
  }

  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaPipe = useMediaPipe(!camOff, videoRef);

  const statsRef = useRef({
    // Sliding window of the last 60 frames (~15 seconds at 4fps)
    recentLookHistory: [] as boolean[],
  });

  // Eye contact — posture shifts/fidgeting are now tracked inside
  // useMediaPipe itself (see POSTURE_*/FIDGET_* constants there), so this
  // effect only has to track the eye-contact rolling window.
  //
  // This is also what feeds gaze_away_seconds into the per-second recorder
  // window (same `collect` Presage's metrics go through) -- previously
  // MediaPipe's gaze signal stayed UI-only and nothing about eye contact
  // was ever saved, so Results/Dashboard's "Eye contact" trait had no real
  // history to draw on. Recording a plain 0/1 per MediaPipe update (looking
  // vs. not, latest-value-wins within each 1s window, same fidelity as
  // every other per-second metric here) means the session average of this
  // column is a real fraction of time spent looking away -- not fabricated,
  // just finally persisted.
  useEffect(() => {
    if (mediaPipe.status !== "ready") return;

    // Maintain a sliding window of the last ~15 seconds of eye contact
    statsRef.current.recentLookHistory.push(mediaPipe.lookingAtCamera);
    if (statsRef.current.recentLookHistory.length > 60) {
      statsRef.current.recentLookHistory.shift();
    }
    collect({ gaze_away_seconds: mediaPipe.lookingAtCamera ? 0 : 1 });

    // Posture, same story as gaze above: useMediaPipe has always computed
    // torso movement live for the UI, but nothing persisted it, so the
    // Posture Stability trait had no history to draw on. Recorded as a
    // 0-10 stability score (not the raw rate) because that's what the
    // column means everywhere else -- see SCORED_SIGNALS in
    // sessionAnalysis.js, where posture_stability_score is "higher is
    // better". FIDGET_ON_THRESHOLD (1.5 shoulder-widths/sec) is the point
    // useMediaPipe itself calls active fidgeting, so that's the floor.
    if (mediaPipe.poseMovementRate != null) {
      const stability = 10 - Math.min(10, (mediaPipe.poseMovementRate / 1.5) * 10);
      collect({ posture_stability_score: Math.max(0, stability) });
    }
  }, [mediaPipe]);

  // Real perception signal from the Presage SmartSpectra SDK — it owns
  // camera acquisition itself (see the `stream` handed to CameraFeed
  // below), analyzing the live feed for expression + HRV-based stress.
  // Fillers/pace still need a speech pipeline that isn't wired up yet, so
  // those show as pending rather than invented numbers. `collect` feeds
  // Presage's per-sample metrics into the Tiger Data window recorder above;
  // MediaPipe's own signals (eye contact/posture) stay UI-only for now.
  const { stream, emotion, stress, pulseBpm, status, error, validationHint } = usePresageSession(!camOff && !ending, collect);

  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (error) console.error("Presage session error:", error);
  }, [error]);

  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;

  const pending = status === "error" ? "Unavailable" : validationHint ?? "—";
  // Stress/Baevsky specifically can never resolve, not just "not yet": the
  // HRV metric it depends on is deliberately excluded from requestedMetrics
  // in usePresageSession.ts (requesting it wedges the native SDK in this
  // environment -- see that file's comment). Reusing `pending` here would
  // show the validation hint forever, which reads as a stuck/broken tile
  // rather than an honest "this signal isn't available" -- so it gets its
  // own, permanent label instead of `pending`.
  const stressDisplay = status === "error" ? "Unavailable" : stress ?? "Not tracked";

  const recentHistory = statsRef.current.recentLookHistory;
  const eyeContactPct = recentHistory.length > 0 
    ? Math.round((recentHistory.filter(Boolean).length / recentHistory.length) * 100)
    : 100;

  const postureValue = mediaPipe.isFidgeting
    ? "Fidgeting"
    : mediaPipe.postureShiftCount > 0
      ? `Steady (${mediaPipe.postureShiftCount})`
      : "Steady";

  // Every live signal we can actually show, keyed by tile label.
  const ALL_METRICS: Record<string, { label: string; value: string }> = {
    Emotion: { label: "Emotion", value: emotion ?? pending },
    Pulse: { label: "Pulse", value: pulseBpm ? `${pulseBpm} bpm` : pending },
    "Eye Contact": { label: "Eye Contact", value: `${eyeContactPct}%` },
    Posture: { label: "Posture", value: postureValue },
    Stress: { label: "Stress", value: stressDisplay },
  };

  // Which live tiles actually speak to a given trait. Only the traits below
  // have a real-time signal behind them -- the verbal ones (Answer Structure,
  // Specificity, Outcome Focus...) are scored from the transcript after the
  // fact, so there is nothing honest to display live for them. Showing a
  // pulse readout while someone practises Answer Structure is noise wearing
  // the costume of feedback.
  const TRAIT_MONITORS: Record<string, string[]> = {
    "Eye Contact": ["Eye Contact"],
    "Posture Stability": ["Posture"],
    "Body Language": ["Posture", "Eye Contact"],
    Composure: ["Stress", "Emotion"],
    "Emotional Steadiness": ["Emotion", "Stress"],
    "Stress Recovery": ["Stress", "Pulse"],
    "Breathing Steadiness": ["Pulse"],
    "Positive Presence": ["Emotion"],
  };

  const practiceTarget = getSessionContext()?.targetWeakness ?? null;
  const trackedTiles = practiceTarget ? TRAIT_MONITORS[practiceTarget] ?? null : null;
  // No target at all (generic session) shows the full board, exactly as
  // before. A target WITH no live signal falls through to the STAR card.
  const metrics = practiceTarget
    ? (trackedTiles ?? []).map((key) => ALL_METRICS[key]).filter(Boolean)
    : Object.values(ALL_METRICS);

  // Question-type label for the footer's left rail. `questionIndex` counts
  // questions asked, so the one on the table is the previous slot.
  const QUESTION_TYPE_LABELS: Record<string, string> = {
    behavioral: "Behavioral",
    resume: "Resume grill",
    job_posting: "Job posting",
  };
  const plan = conversation.plan;
  const currentQuestion = plan[conversation.questionIndex - 1];
  const currentType = currentQuestion ? QUESTION_TYPE_LABELS[currentQuestion.type] ?? "Mixed" : "—";
  const planTypes = new Set(plan.map((q) => q.type));
  const sessionShape = plan.length === 0
    ? "Preparing"
    : planTypes.size > 1
      ? "Mixed"
      : QUESTION_TYPE_LABELS[[...planTypes][0]] ?? "Mixed";

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
          <span className="text-white/60">Interview session</span>
        </div>
        <div className="flex items-center gap-4 text-[13px] text-white/50">
          <span className="tabular-nums">{clock}</span>
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 bg-white" /> Recording
          </span>
        </div>
      </header>

      <div className="px-6 py-2 text-xs text-white/60" role={storageError ? 'alert' : 'status'}>
        {storageError ? `Storage: ${storageError} ${recorder.pending} samples waiting. Keep this window open; saves retry automatically until you end the session.` : storageStatus}
      </div>
      {/* Stage */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1.9fr_1fr] gap-4 p-4">
        {/* Left — user camera (mock) */}
        <div className="relative border border-white/12 bg-white/[0.02] overflow-hidden flex items-center justify-center">
          {camOff ? (
            <div className="flex flex-col items-center gap-3 text-white/40">
              <div className="h-20 w-20 border border-white/25 flex items-center justify-center text-[24px] font-800" style={{ fontWeight: 800 }}>
                JD
              </div>
              <span className="text-[13px]">Camera off</span>
            </div>
          ) : stream ? (
            <CameraFeed ref={videoRef} stream={stream} />
          ) : (
            <div className="flex flex-col items-center gap-2 text-white/25 px-6 text-center">
              <span className="text-[12px] uppercase tracking-[0.16em]">
                {status === "error" ? "Presage session failed" : `Presage: ${status}`}
              </span>
              {error && <span className="text-[11px] normal-case text-white/35 max-w-sm">{error}</span>}
            </div>
          )}
          <span className="absolute bottom-3 left-3 text-[13px] text-white/80 bg-black/40 px-2 py-1">You</span>
          {!camOff && (
            <span className="absolute top-3 left-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-white/45">
              <span className="h-2 w-2 bg-white" /> Live
            </span>
          )}

          {/* Mic status badge with live volume bar -- micLevel bars give real-time feedback */}
          {conversation.listening && (
            <span className="absolute top-3 right-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.12em] text-blue-400 bg-black/50 px-2 py-1">
              <span
                className="h-3 w-1 rounded-full bg-blue-400"
                style={{ transform: `scaleY(${0.3 + conversation.micLevel * 0.7})`, transition: "transform 0.05s" }}
              />
              <span
                className="h-3 w-1 rounded-full bg-blue-400"
                style={{ transform: `scaleY(${0.2 + conversation.micLevel * 0.8})`, transition: "transform 0.08s" }}
              />
              <span
                className="h-3 w-1 rounded-full bg-blue-400"
                style={{ transform: `scaleY(${0.4 + conversation.micLevel * 0.6})`, transition: "transform 0.06s" }}
              />
              Listening
            </span>
          )}

          {/* small camera toggle, tucked in corner so it doesn't obstruct */}
          <button
            onClick={() => setCamOff((c) => !c)}
            aria-label={camOff ? "Start video" : "Stop video"}
            className="absolute bottom-3 right-3 flex h-9 w-9 items-center justify-center border border-white/20 bg-black/40 text-white transition-colors hover:border-white/50"
          >
            {camOff ? <VideoOff className="h-[16px] w-[16px]" strokeWidth={1.6} /> : <Video className="h-[16px] w-[16px]" strokeWidth={1.6} />}
          </button>
        </div>

        {/* Right — AI recruiter orb */}
        <div className="relative border border-white/12 bg-white/[0.02] overflow-hidden flex items-center justify-center">
          <div className="w-[75%] max-w-[320px] aspect-square">
            {/* VoiceOrb driven by actual TTS playback state */}
            <VoiceOrb className="w-full h-full" speaking={conversation.aiSpeaking} />
          </div>
          <span className="absolute bottom-3 left-3 text-[13px] text-white/80 bg-black/40 px-2 py-1">
            Callback Recruiter
          </span>
          <span className="absolute top-3 left-3 text-[11px] uppercase tracking-[0.14em] text-white/45">
            {conversation.aiSpeaking ? "Speaking" : conversation.listening ? "Listening to you" : "Ready"}
          </span>

          {/* Re-ask badge: the planner deliberately brings back one question
              the user fumbled in an earlier session, so improvement on it is
              measurable. `questionIndex` counts questions ASKED, so the one
              currently on the table is the previous slot. */}
          {(() => {
            const current = conversation.plan[conversation.questionIndex - 1];
            if (!current?.repeatOf) return null;
            return (
              <span className="absolute top-3 right-3 flex items-center gap-1.5 border border-white/30 bg-black/50 px-2 py-1 text-[11px] uppercase tracking-[0.14em] text-white/70">
                <RotateCcw className="h-3 w-3" strokeWidth={1.8} /> Revisiting
              </span>
            );
          })()}

          {conversation.error && (
            <div
              className="absolute bottom-10 left-3 right-3 text-center px-3 py-1.5 text-[11px] text-red-400 leading-snug"
              style={{ background: "rgba(0,0,0,0.65)" }}
            >
              {conversation.error}
            </div>
          )}
        </div>
      </div>

      {/* Live monitoring panel.
          Fixed height (h-20) no matter what it contains: this footer sits
          under a flex column holding the camera and the orb, so any change
          in its height resizes them mid-interview. The three states below
          (tracked tiles / STAR card / full board) all render inside the
          same box. */}
      <footer className="h-20 shrink-0 border-t border-white/12 px-4 flex items-center gap-4">
        {/* Left rail: what KIND of question is on the table. */}
        <div className="shrink-0 w-40 flex flex-col justify-center border-r border-white/12 pr-4 h-full py-3">
          <span className="text-[10px] uppercase tracking-[0.12em] text-white/35">Question type</span>
          <span className="text-[14px] leading-tight truncate">{currentType}</span>
          <span className="text-[10px] text-white/25 truncate">Session: {sessionShape}</span>
        </div>

        <div className="flex-1 min-w-0 h-full flex items-center gap-2 py-3">
          {practiceTarget && trackedTiles === null ? (
            /* Practising something with no live signal behind it (a verbal
               trait, or free text like "STAR summary"). Rather than show
               unrelated biometrics, show the thing that actually helps in
               the moment — what a complete answer looks like. */
            <div className="flex-1 min-w-0 h-full border border-white/12 px-3 flex flex-col justify-center">
              <span className="text-[10px] uppercase tracking-[0.12em] text-white/35 truncate">
                Practising: {practiceTarget} · no live signal — structure every answer
              </span>
              <div className="mt-1 flex items-center gap-4 overflow-x-auto">
                {[
                  ["S", "Situation", "set the scene"],
                  ["T", "Task", "your responsibility"],
                  ["A", "Action", "what you did"],
                  ["R", "Result", "the outcome, with a number"],
                ].map(([letter, word, gloss]) => (
                  <span key={letter} className="flex items-baseline gap-1.5 whitespace-nowrap">
                    <span className="text-[15px] font-800 leading-none" style={{ fontWeight: 800 }}>{letter}</span>
                    <span className="text-[12px] text-white/70">{word}</span>
                    <span className="text-[11px] text-white/30">{gloss}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 pr-3 shrink-0 text-[11px] uppercase tracking-[0.14em] text-white/40">
                <Activity className="h-3.5 w-3.5" />
                {practiceTarget ? "Tracking" : "Live monitoring"}
              </div>
              <div
                className="grid gap-px bg-white/12 border border-white/12 flex-1 min-w-0"
                style={{ gridTemplateColumns: `repeat(${Math.max(metrics.length, 1)}, minmax(0, 1fr))` }}
              >
                {metrics.map((m) => (
                  <div key={m.label} className="bg-black px-3 py-1.5 flex flex-col justify-center">
                    <span className="text-[10px] uppercase tracking-[0.12em] text-white/35 truncate">{m.label}</span>
                    <span className="text-[14px] leading-tight truncate">{m.value}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <button
          onClick={finishSession}
          disabled={saving}
          className="shrink-0 flex items-center gap-2 bg-white text-black text-[13px] font-semibold px-5 h-11 rounded-none transition-opacity active:opacity-70"
        >
          <PhoneOff className="h-[16px] w-[16px]" strokeWidth={1.8} />
          {saving ? 'Saving…' : ending ? 'Retry save & finish' : 'End session'}
        </button>
      </footer>

      {/* Dev tools -- only visible in Vite dev mode */}
      <DevPanel conversation={conversation} />
    </div>
  );
};

export default SessionMeeting;
