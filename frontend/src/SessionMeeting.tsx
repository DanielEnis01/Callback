import { useEffect, useState, useRef, useMemo, FC } from "react";
import { Video, VideoOff, PhoneOff, ChevronDown, ChevronUp, Activity } from "lucide-react";
import { VoiceOrb } from "./VoiceOrb";
import { CameraFeed } from "./CameraFeed";
import { usePresageSession } from "./usePresageSession";
import { useMediaPipe } from "./useMediaPipe";
import { useConversation } from "./useConversation";
import { completeInterview, prepareInterview, type PreparedInterview } from "./backboard";
import { getInterviewProfile, getSessionContext } from "./baselineStore";

interface SessionMeetingProps {
  onEnd: () => void;
}

export const SessionMeeting: FC<SessionMeetingProps> = ({ onEnd }) => {
  const [camOff, setCamOff] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [minimized, setMinimized] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaPipe = useMediaPipe(!camOff, videoRef);

  const statsRef = useRef({
    // Sliding window of the last 60 frames (~15 seconds at 4fps)
    recentLookHistory: [] as boolean[],
  });

  // Eye contact — posture shifts/fidgeting are now tracked inside
  // useMediaPipe itself (see POSTURE_*/FIDGET_* constants there), so this
  // effect only has to track the eye-contact rolling window.
  useEffect(() => {
    if (mediaPipe.status !== "ready") return;

    // Maintain a sliding window of the last ~15 seconds of eye contact
    statsRef.current.recentLookHistory.push(mediaPipe.lookingAtCamera);
    if (statsRef.current.recentLookHistory.length > 60) {
      statsRef.current.recentLookHistory.shift();
    }
  }, [mediaPipe]);

  const { stream, emotion, stress, pulseBpm, status, error, validationHint } = usePresageSession(!camOff);

  // ── Build interview context for Gemini ─────────────────────────────────────
  const [openingMessage, setOpeningMessage] = useState<string | undefined>();
  const [prepared, setPrepared] = useState<PreparedInterview | null>(null);
  const [preparationError, setPreparationError] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const preparationRef = useRef<Promise<PreparedInterview> | null>(null);

  const systemContext = useMemo(() => {
    const profile = getInterviewProfile();
    const session = getSessionContext();
    const parts: string[] = [];
    if (profile?.name) parts.push(`Candidate name: ${profile.name}`);
    if (profile?.targetRoles) parts.push(`Target roles: ${profile.targetRoles}`);
    if (session?.jobPosting) parts.push(`Job posting:\n${session.jobPosting}`);
    if (session?.targetWeakness) parts.push(`Weakness to target this session: ${session.targetWeakness}`);
    if (profile?.resume) parts.push(`Resume uploaded: ${profile.resume.name}`);
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }, []);

  // Try to get a personalized opening question from Backboard
  useEffect(() => {
    let active = true;
    preparationRef.current ||= prepareInterview();
    preparationRef.current
      .then((prepared) => {
        if (!active) return;
        setPrepared(prepared);
        if (prepared.content?.trim()) {
          setOpeningMessage(prepared.content);
        }
      })
      .catch((err) => {
        if (active) setPreparationError(err instanceof Error ? err.message : "Interview preparation failed");
      });
    return () => { active = false; };
  }, []);

  // ── Voice conversation loop (STT → Gemini → ElevenLabs TTS) ─────────────────
  const conversation = useConversation({ systemContext, openingMessage, sessionId: prepared?.thread_id, enabled: !!prepared });
  const currentQuestionIndex = [...conversation.history].reverse().find((turn) => turn.role === "model")?.questionIndex ?? 0;
  const currentQuestion = prepared?.questions[currentQuestionIndex];
  const finish = async () => {
    if (ending) return;
    conversation.stopListening();
    conversation.cancelAudio();
    if (!prepared) { onEnd(); return; }
    setEnding(true);
    try {
      await completeInterview(prepared.thread_id, conversation.history);
      onEnd();
    } catch (error) {
      setPreparationError(error instanceof Error ? error.message : "Unable to save analysis. Please retry.");
      setEnding(false);
    }
  };

  // Session clock
  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (error) console.error("Presage session error:", error);
  }, [error]);

  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;

  const pending = status === "error" ? "Unavailable" : validationHint ?? "—";

  const recentHistory = statsRef.current.recentLookHistory;
  const eyeContactPct = recentHistory.length > 0
    ? Math.round((recentHistory.filter(Boolean).length / recentHistory.length) * 100)
    : 100;

  const metrics = [
    { label: "Emotion", value: emotion ?? pending },
    { label: "Pulse", value: pulseBpm ? `${pulseBpm} bpm` : pending },
    { label: "Eye Contact", value: `${eyeContactPct}%` },
    {
      label: "Posture",
      value: mediaPipe.isFidgeting
        ? "Fidgeting"
        : mediaPipe.postureShiftCount > 0
          ? `Steady (${mediaPipe.postureShiftCount})`
          : "Steady",
    },
    { label: "Stress", value: stress ?? pending },
  ];

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
      <div className="border-b border-white/12 px-6 py-3 text-sm" aria-live="polite">
        {preparationError ? <span className="text-red-300">{preparationError}</span> : prepared ? (
          <><p className="text-white/70">Question {currentQuestionIndex + 1} of 5 · {currentQuestion?.text}</p>
          {currentQuestion?.repeatOf && <p className="mt-1 text-amber-200">You struggled with this one on {new Date(currentQuestion.repeatOf.askedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} — let’s try again.</p>}</>
        ) : "Preparing your interview questions…"}
      </div>

      {/* Stage */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1.9fr_1fr] gap-4 p-4">
        {/* Left — user camera */}
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

          {/* Mic is recording — micLevel bars (in the badge above) give live feedback */}

          {/* Mic status badge with live volume bar */}
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

          {/* Camera toggle */}
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

          {/* TTS error */}
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

      {/* Live monitoring panel */}
      <footer className="shrink-0 border-t border-white/12 px-4 py-3 flex items-center gap-4">
        {minimized ? (
          <div className="flex-1 flex items-center gap-3 min-w-0">
            <span className="flex items-center gap-2 text-[12px] uppercase tracking-[0.14em] text-white/45">
              <Activity className="h-3.5 w-3.5" /> Live
            </span>
            <span className="text-[13px] truncate">
              <span className="text-white/45">Emotion</span> {emotion ?? "—"}
            </span>
            <button
              onClick={() => setMinimized(false)}
              className="ml-1 flex items-center gap-1 text-[12px] text-white/45 hover:text-white/90 transition-colors"
            >
              <ChevronUp className="h-3.5 w-3.5" /> Expand
            </button>
          </div>
        ) : (
          <div className="flex-1 min-w-0 flex items-center gap-2">
            <div className="flex items-center gap-2 pr-3 shrink-0 text-[11px] uppercase tracking-[0.14em] text-white/40">
              <Activity className="h-3.5 w-3.5" /> Live monitoring
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-px bg-white/12 border border-white/12 flex-1 min-w-0">
              {metrics.map((m) => (
                <div key={m.label} className="bg-black px-3 py-1.5 flex flex-col">
                  <span className="text-[10px] uppercase tracking-[0.12em] text-white/35">{m.label}</span>
                  <span className="text-[14px] leading-tight truncate">{m.value}</span>
                </div>
              ))}
            </div>
            <button
              onClick={() => setMinimized(true)}
              aria-label="Minimize monitoring"
              className="shrink-0 flex h-9 w-9 items-center justify-center border border-white/20 text-white/70 transition-colors hover:border-white/50"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          </div>
        )}

        <button
          onClick={() => void finish()}
          disabled={ending}
          className="shrink-0 flex items-center gap-2 bg-white text-black text-[13px] font-semibold px-5 h-11 rounded-none transition-opacity active:opacity-70"
        >
          <PhoneOff className="h-[16px] w-[16px]" strokeWidth={1.8} />
          {ending ? "Saving analysis…" : "End session"}
        </button>
      </footer>

    </div>
  );
};

export default SessionMeeting;
