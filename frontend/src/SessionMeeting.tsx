import { useEffect, useState, useRef, FC } from "react";
import { Video, VideoOff, PhoneOff, ChevronDown, ChevronUp, Activity } from "lucide-react";
import { VoiceOrb } from "./VoiceOrb";
import { CameraFeed } from "./CameraFeed";
import { usePresageSession } from "./usePresageSession";

import { dataRequest } from "./dataApi";
import { SessionRecorder, type MetricValues } from "./sessionRecorder";

interface SessionMeetingProps {
  onEnd: () => void;
}

export const SessionMeeting: FC<SessionMeetingProps> = ({ onEnd }) => {
  const [camOff, setCamOff] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [aiSpeaking, setAiSpeaking] = useState(true);
  const [minimized, setMinimized] = useState(false);

  const [recorder] = useState(() => new SessionRecorder(dataRequest));
  const windowMetrics = useRef<MetricValues>({});
  const endingRef = useRef(false);
  const [ending, setEnding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [storageStatus, setStorageStatus] = useState('Connecting to storage…');
  const collect = (values: MetricValues) => { if (!endingRef.current) Object.assign(windowMetrics.current, values); };
  const captureWindow = () => {
    recorder.enqueue(windowMetrics.current);
    windowMetrics.current = {};
  };
  useEffect(() => {
    let current = true;
    const flush = () => recorder.flush().then(() => {
      if (current) { setStorageError(''); setStorageStatus('Saved to Tiger Data'); }
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
  async function finishSession() {
    if (saving) return;
    endingRef.current = true;
    setEnding(true); setSaving(true); setStorageError('');
    try { captureWindow(); await recorder.finish(); onEnd(); }
    catch (error) { setStorageError((error as Error).message); }
    finally { setSaving(false); }
  }

  // Real perception signal from the Presage SmartSpectra SDK — it owns
  // camera acquisition itself (see the `stream` handed to CameraFeed
  // below), analyzing the live feed for expression + HRV-based stress.
  // Fillers/pace still need a speech pipeline that isn't wired up yet, so
  // those show as pending rather than invented numbers.
  const { stream, emotion, stress, pulseBpm, status, error, validationHint } = usePresageSession(!camOff && !ending, collect);

  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setAiSpeaking((s) => !s), 3200);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (error) console.error("Presage session error:", error);
  }, [error]);

  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;

  // Cardio/breathing/expression stay empty until the SDK's rPPG validation
  // phase completes (it needs a still, centered, well-lit face for a few
  // seconds) — show its hint instead of a bare dash while that's pending.
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
            <CameraFeed stream={stream} />
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
          onClick={finishSession}
          disabled={saving}
          className="shrink-0 flex items-center gap-2 bg-white text-black text-[13px] font-semibold px-5 h-11 rounded-none transition-opacity active:opacity-70"
        >
          <PhoneOff className="h-[16px] w-[16px]" strokeWidth={1.8} />
          {saving ? 'Saving…' : ending ? 'Retry save & finish' : 'End session'}
        </button>
      </footer>
    </div>
  );
};

export default SessionMeeting;
