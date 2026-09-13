import { useState } from "react";
import { VoiceOrb } from "./VoiceOrb";
import { Login } from "./Login";
import { Dashboard } from "./Dashboard";
import { BackboardDevPanel } from "./BackboardDevPanel";

export default function App() {
  const [view, setView] = useState<"hero" | "login" | "dashboard">("hero");
  const speaking = false;

  if (import.meta.env.DEV && new URLSearchParams(window.location.search).get("dev") === "backboard") {
    return <main className="min-h-screen bg-black p-8 text-white"><h1 className="text-2xl font-semibold">Callback developer tools</h1><p className="mt-2 text-sm text-white/45">Test interview memory without a camera, microphone, or login.</p><BackboardDevPanel initialOpen /></main>;
  }

  // Dashboard is a full-screen app on its own — no orb.
  if (view === "dashboard") {
    return <Dashboard onLogout={() => setView("hero")} />;
  }

  return (
    <div
      className="min-h-screen w-full flex flex-col lg:flex-row bg-black"
      style={{ fontFamily: "'Sora', sans-serif" }}
    >
      {/* Left — hero copy or login */}
      {view === "hero" ? (
        <div className="flex flex-col justify-between px-12 py-16 lg:w-[48%] lg:min-h-screen bg-black">
          {/* Spacer to preserve vertical rhythm */}
          <div />

          {/* Middle: headline + description */}
          <div className="flex flex-col gap-6">
            <h1
              className="text-[64px] leading-[1.02] font-800 text-white tracking-tight"
              style={{ fontWeight: 800 }}
            >
              Callback.
            </h1>
            <p className="text-[17px] leading-relaxed text-white/50 max-w-[380px]" style={{ fontWeight: 300 }}>
              Real time interview preparation to get your <span className="underline underline-offset-4">call back.</span> Our voiced AI recruiter tracks and remembers your gaze, posture, and filler words in real time.
            </p>

            <button
              onClick={() => setView("login")}
              className="mt-2 w-fit bg-white text-black text-[13px] font-semibold tracking-wide px-7 py-3.5 rounded-none transition-opacity active:opacity-70"
              style={{ letterSpacing: "0.04em" }}
            >
              Start session
            </button>
          </div>

          {/* Bottom: tagline */}
          <p className="text-[11px] uppercase tracking-[0.2em] text-white/20">
            Powered by Gemini
          </p>
        </div>
      ) : (
        <Login onSignIn={() => setView("dashboard")} />
      )}

      {/* Right — voice orb */}
      <div className="relative flex-1 flex items-center justify-center bg-black lg:min-h-screen overflow-hidden">
        <div className="w-[360px] h-[360px] lg:w-[440px] lg:h-[440px]">
          <VoiceOrb className="w-full h-full" speaking={speaking} />
        </div>
      </div>
    </div>
  );
}
