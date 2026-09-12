import { useEffect, useState, useRef, FC } from "react";
import {
  Video,
  VideoOff,
  PhoneOff,
  ChevronDown,
  ChevronUp,
  Activity,
  GripHorizontal,
  Send,
  Volume2,
  VolumeX,
  RotateCcw,
  Sparkles,
  AlertCircle,
  X,
} from "lucide-react";
import { VoiceOrb } from "./VoiceOrb";
import { CameraFeed } from "./CameraFeed";
import { usePresageSession } from "./usePresageSession";

interface SessionMeetingProps {
  onEnd: () => void;
}

type Turn = {
  role: "user" | "model";
  parts: [{ text: string }];
};

export const SessionMeeting: FC<SessionMeetingProps> = ({ onEnd }) => {
  const [camOff, setCamOff] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [aiSpeaking, setAiSpeaking] = useState(false);
  const [minimized, setMinimized] = useState(false);

  // ── Floating Draggable GUI Box State for Testing Gemini + TTS ─────
  const [guiOpen, setGuiOpen] = useState(true);
  const [guiMinimized, setGuiMinimized] = useState(false);
  const [guiPos, setGuiPos] = useState({ x: 24, y: 72 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ startX: 0, startY: 0, posX: 24, posY: 72 });

  const [candidateInput, setCandidateInput] = useState("");
  const [history, setHistory] = useState<Turn[]>([]);
  const [latestReply, setLatestReply] = useState<string>(
    "Ready to test. Send a message to start interviewing."
  );
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [ttsMuted, setTtsMuted] = useState(false);

  // Real perception signal from the Presage SmartSpectra SDK
  const { stream, emotion, stress, pulseBpm, status, error, validationHint } =
    usePresageSession(!camOff);

  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (error) console.error("Presage session error:", error);
  }, [error]);

  // ── Text-to-Speech (TTS) Engine ─────────────────────────────────
  const speak = (text: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    if (ttsMuted) return;

    const cleanText = text.replace(/[*_#`]/g, "").trim();
    if (!cleanText) return;

    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    const voices = window.speechSynthesis.getVoices();
    const recruiterVoice =
      voices.find(
        (v) =>
          v.lang.startsWith("en") &&
          (v.name.includes("Natural") ||
            v.name.includes("Google") ||
            v.name.includes("Samantha") ||
            v.name.includes("Daniel") ||
            v.name.includes("Alex"))
      ) || voices.find((v) => v.lang.startsWith("en"));

    if (recruiterVoice) utterance.voice = recruiterVoice;

    utterance.onstart = () => setAiSpeaking(true);
    utterance.onend = () => setAiSpeaking(false);
    utterance.onerror = () => setAiSpeaking(false);

    window.speechSynthesis.speak(utterance);
  };

  // ── Send to Gemini API ──────────────────────────────────────────
  const sendToGemini = async (userMessage: string) => {
    if (!userMessage.trim() || loading) return;
    setLoading(true);
    setErrorMsg(null);

    const message = userMessage.trim();
    setCandidateInput("");

    try {
      const res = await fetch("/api/services/gemini/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          history,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Gemini API error");
      }

      const reply = data.reply || "Thank you. Let's continue.";
      setLatestReply(reply);

      // Speak via TTS (which animates the VoiceOrb via aiSpeaking)
      speak(reply);

      // Preserve multi-turn history
      setHistory((prev) => [
        ...prev,
        { role: "user", parts: [{ text: message }] },
        { role: "model", parts: [{ text: reply }] },
      ]);
    } catch (err: any) {
      console.error("Gemini Test Error:", err);
      setErrorMsg(err.message);
      setLatestReply(`[Error: ${err.message}]`);
    } finally {
      setLoading(false);
    }
  };

  // ── Draggable Window Logic ───────────────────────────────────────
  const handleMouseDown = (e: React.MouseEvent) => {
    // Only drag from header, not input/button clicks
    if ((e.target as HTMLElement).closest("button, input")) return;
    setIsDragging(true);
    dragStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      posX: guiPos.x,
      posY: guiPos.y,
    };
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartRef.current.startX;
      const dy = e.clientY - dragStartRef.current.startY;
      setGuiPos({
        x: Math.max(10, Math.min(window.innerWidth - 380, dragStartRef.current.posX + dx)),
        y: Math.max(10, Math.min(window.innerHeight - 180, dragStartRef.current.posY + dy)),
      });
    };

    const handleMouseUp = () => setIsDragging(false);

    if (isDragging) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging]);

  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(
    elapsed % 60
  ).padStart(2, "0")}`;

  const pending = status === "error" ? "Unavailable" : validationHint ?? "—";

  const metrics = [
    { label: "Emotion", value: emotion ?? pending },
    { label: "Pulse", value: pulseBpm ? `${pulseBpm} bpm` : pending },
    { label: "Fillers", value: "—" },
    { label: "Pace", value: "—" },
    { label: "Stress", value: stress ?? pending },
  ];

  return (
    <div
      className="h-screen w-full flex flex-col bg-black text-white overflow-hidden relative select-none"
      style={{ fontFamily: "'Sora', sans-serif" }}
    >
      {/* Top bar (Exact Original) */}
      <header className="h-14 shrink-0 flex items-center justify-between border-b border-white/12 px-6">
        <div className="flex items-center gap-3 text-[13px]">
          <span className="font-800 tracking-tight text-[16px]" style={{ fontWeight: 800 }}>
            Callback.
          </span>
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

      {/* Stage (Exact Original Layout 1.9fr : 1fr) */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1.9fr_1fr] gap-4 p-4">
        {/* Left — user camera (Exact Original) */}
        <div className="relative border border-white/12 bg-white/[0.02] overflow-hidden flex items-center justify-center">
          {camOff ? (
            <div className="flex flex-col items-center gap-3 text-white/40">
              <div
                className="h-20 w-20 border border-white/25 flex items-center justify-center text-[24px] font-800"
                style={{ fontWeight: 800 }}
              >
                JD
              </div>
              <span className="text-[13px]">Camera off</span>
            </div>
          ) : stream ? (
            <CameraFeed stream={stream} />
          ) : (
            <div className="flex flex-col items-center gap-2 text-white/25 px-6 text-center">
              <span className="text-[12px] uppercase tracking-[0.16em]">
                {status === "error" ? "Presage session failed" : `Presage: ${status}`}
              </span>
              {error && (
                <span className="text-[11px] normal-case text-white/35 max-w-sm">
                  {error}
                </span>
              )}
            </div>
          )}
          <span className="absolute bottom-3 left-3 text-[13px] text-white/80 bg-black/40 px-2 py-1">
            You
          </span>
          {!camOff && (
            <span className="absolute top-3 left-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-white/45">
              <span className="h-2 w-2 bg-white" /> Live
            </span>
          )}
          <button
            onClick={() => setCamOff((c) => !c)}
            aria-label={camOff ? "Start video" : "Stop video"}
            className="absolute bottom-3 right-3 flex h-9 w-9 items-center justify-center border border-white/20 bg-black/40 text-white transition-colors hover:border-white/50"
          >
            {camOff ? (
              <VideoOff className="h-[16px] w-[16px]" strokeWidth={1.6} />
            ) : (
              <Video className="h-[16px] w-[16px]" strokeWidth={1.6} />
            )}
          </button>
        </div>

        {/* Right — AI recruiter orb (Exact Original) */}
        <div className="relative border border-white/12 bg-white/[0.02] overflow-hidden flex items-center justify-center">
          <div className="w-[75%] max-w-[320px] aspect-square">
            <VoiceOrb className="w-full h-full" speaking={aiSpeaking} />
          </div>
          <span className="absolute bottom-3 left-3 text-[13px] text-white/80 bg-black/40 px-2 py-1">
            Callback Recruiter
          </span>
          <span className="absolute top-3 left-3 text-[11px] uppercase tracking-[0.14em] text-white/45">
            {aiSpeaking ? "Speaking" : "Listening"}
          </span>
        </div>
      </div>

      {/* Live monitoring panel (Exact Original) */}
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
                  <span className="text-[10px] uppercase tracking-[0.12em] text-white/35">
                    {m.label}
                  </span>
                  <span className="text-[14px] leading-tight truncate">
                    {m.value}
                  </span>
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
          onClick={onEnd}
          className="shrink-0 flex items-center gap-2 bg-white text-black text-[13px] font-semibold px-5 h-11 rounded-none transition-opacity active:opacity-70"
        >
          <PhoneOff className="h-[16px] w-[16px]" strokeWidth={1.8} />
          End session
        </button>
      </footer>

      {/* ── Movable GUI Box: Gemini Recruiter TTS Test Tool ────────── */}
      {guiOpen ? (
        <div
          style={{ left: `${guiPos.x}px`, top: `${guiPos.y}px` }}
          className={`absolute z-50 w-[360px] bg-black/90 border border-white/20 shadow-2xl backdrop-blur-md transition-shadow ${
            isDragging ? "cursor-grabbing ring-1 ring-white/50" : ""
          }`}
        >
          {/* Draggable Header */}
          <div
            onMouseDown={handleMouseDown}
            className="h-10 border-b border-white/15 px-3 flex items-center justify-between cursor-grab bg-white/[0.04] select-none"
          >
            <div className="flex items-center gap-2 text-[12px] font-semibold text-white/90">
              <GripHorizontal className="h-4 w-4 text-white/40" />
              <span>Gemini Recruiter (TTS Test)</span>
            </div>

            <div className="flex items-center gap-1">
              <button
                onClick={() => setGuiMinimized(!guiMinimized)}
                title={guiMinimized ? "Expand" : "Minimize"}
                className="h-6 w-6 flex items-center justify-center text-white/50 hover:text-white"
              >
                {guiMinimized ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronUp className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                onClick={() => setGuiOpen(false)}
                title="Close"
                className="h-6 w-6 flex items-center justify-center text-white/50 hover:text-white"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Collapsible Content */}
          {!guiMinimized && (
            <div className="p-3.5 flex flex-col gap-3">
              {/* Status & Audio Controls */}
              <div className="flex items-center justify-between text-[11px] text-white/50">
                <span className="flex items-center gap-1.5">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      loading
                        ? "bg-amber-400 animate-pulse"
                        : aiSpeaking
                        ? "bg-emerald-400 animate-pulse"
                        : "bg-white/30"
                    }`}
                  />
                  {loading
                    ? "Thinking..."
                    : aiSpeaking
                    ? "VoiceOrb Speaking (TTS)"
                    : "Listening"}
                </span>

                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => speak(latestReply)}
                    disabled={loading || !latestReply}
                    title="Replay Voice"
                    className="flex items-center gap-1 text-[10px] border border-white/15 bg-white/5 px-2 py-0.5 text-white/80 hover:text-white hover:border-white/40 transition-colors"
                  >
                    <RotateCcw className="h-2.5 w-2.5" /> Replay
                  </button>
                  <button
                    onClick={() => {
                      if (!ttsMuted) {
                        window.speechSynthesis?.cancel();
                        setAiSpeaking(false);
                      }
                      setTtsMuted(!ttsMuted);
                    }}
                    title={ttsMuted ? "Unmute TTS" : "Mute TTS"}
                    className="h-6 w-6 flex items-center justify-center border border-white/15 bg-white/5 text-white/70 hover:text-white"
                  >
                    {ttsMuted ? (
                      <VolumeX className="h-3 w-3 text-red-400" />
                    ) : (
                      <Volume2 className="h-3 w-3" />
                    )}
                  </button>
                </div>
              </div>

              {/* Recruiter Response Card */}
              <div className="border border-white/15 bg-black/60 p-2.5 max-h-[120px] overflow-y-auto text-[12px] leading-relaxed text-white/90">
                <div className="text-[10px] uppercase tracking-wider text-white/40 mb-1 font-semibold flex items-center justify-between">
                  <span>Recruiter Output</span>
                  <span className="text-[9px] text-white/30">
                    Turns: {Math.floor(history.length / 2)}
                  </span>
                </div>
                {loading ? (
                  <span className="text-white/40 italic animate-pulse">
                    Gemini recruiter generating response...
                  </span>
                ) : (
                  latestReply
                )}
              </div>

              {/* Quick Sample Prompts */}
              <div className="flex flex-wrap gap-1.5">
                {[
                  "Hi, I'm ready to interview.",
                  "Ask me a behavioral question.",
                  "Why should we hire you?",
                ].map((prompt, i) => (
                  <button
                    key={i}
                    onClick={() => sendToGemini(prompt)}
                    disabled={loading}
                    className="text-[10px] border border-white/15 bg-white/[0.03] px-2 py-0.5 text-white/60 hover:text-white hover:border-white/40 transition-colors disabled:opacity-40"
                  >
                    {prompt}
                  </button>
                ))}
              </div>

              {/* Input Form */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  sendToGemini(candidateInput);
                }}
                className="flex gap-1.5"
              >
                <input
                  type="text"
                  value={candidateInput}
                  onChange={(e) => setCandidateInput(e.target.value)}
                  placeholder="Type message to recruiter..."
                  disabled={loading}
                  className="flex-1 h-9 border border-white/20 bg-white/[0.04] px-2.5 text-[12px] text-white placeholder-white/30 focus:outline-none focus:border-white/50"
                />
                <button
                  type="submit"
                  disabled={loading || !candidateInput.trim()}
                  className="bg-white text-black px-3 h-9 text-[12px] font-semibold flex items-center justify-center disabled:opacity-40 hover:bg-white/90 transition-opacity"
                >
                  <Send className="h-3 w-3" />
                </button>
              </form>

              {errorMsg && (
                <div className="text-[10px] text-amber-300 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3 shrink-0" />
                  <span className="truncate">{errorMsg}</span>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        /* Floating Button to re-open GUI if closed */
        <button
          onClick={() => setGuiOpen(true)}
          className="absolute top-16 left-6 z-50 flex items-center gap-1.5 border border-white/30 bg-black/80 backdrop-blur-sm px-3 py-1.5 text-[12px] text-white shadow-lg hover:border-white/60 transition-colors"
        >
          <Sparkles className="h-3.5 w-3.5" />
          <span>Open Gemini Recruiter Test GUI</span>
        </button>
      )}
    </div>
  );
};

export default SessionMeeting;
