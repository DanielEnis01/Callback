import { useState } from "react";
import { VoiceOrb } from "./VoiceOrb";
import Login from "./Login";
import { Dashboard } from "./Dashboard";
import AuthProvider, { useAuth } from "./AuthContext";
import { firebaseConfigured } from "./firebase";

/**
 * Original hero → login shell (with the shader orb aside), restored after
 * an earlier commit ("Open desktop app directly to dashboard") temporarily
 * skipped straight to the practice dashboard for a demo. Now that Firebase
 * and Tiger Data are wired up, unauthenticated visitors go through this
 * again instead of the demo shortcut.
 */
function OrbAside() {
  return (
    // Side by side, the orb is anchored to the right edge rather than centred
    // in its column: centring left its ring ~149px off the right edge while
    // the copy sits 48px off the left, which reads as lopsided. pr-8 rather
    // than pr-12 because the orb's canvas carries ~14px of glow padding
    // inside the 440px box, so 32px of padding lands the VISIBLE ring at
    // ~48px -- an optical mirror of the text margin. Stacked (below lg) it
    // stays centred.
    <aside aria-hidden="true" className="relative flex-1 flex items-center justify-center lg:justify-end lg:pr-8 bg-black overflow-hidden">
      <div className="w-[min(90vw,360px)] h-[min(90vw,360px)] lg:w-[min(36vw,500px)] lg:h-[min(36vw,500px)]">
        <VoiceOrb className="w-full h-full" speaking={false} />
      </div>
    </aside>
  );
}

function Hero({ onStart }: { onStart: () => void }) {
  return (
    <main className="flex flex-col justify-between px-6 py-12 sm:px-12 lg:w-[45%] bg-black overflow-y-auto">
      <div />
      <div className="flex flex-col gap-[clamp(20px,1.8vw,30px)]">
        <h1 className="text-[clamp(56px,6.6vw,108px)] leading-[0.98] font-extrabold text-white tracking-tight">Callback.</h1>
        <p className="text-[clamp(16px,1.35vw,22px)] leading-relaxed text-white/50 max-w-[min(100%,30ch)] font-light">
          Real time interview preparation to get your <span className="underline underline-offset-4">call back.</span> Our voiced AI recruiter tracks and remembers your gaze, posture, and filler words in real time.
        </p>
        <button onClick={onStart} className="mt-2 w-fit bg-white text-black text-[clamp(13px,1.05vw,16px)] font-semibold tracking-wide px-[clamp(28px,2.6vw,40px)] py-[clamp(14px,1.3vw,20px)] transition-opacity active:opacity-70">
          Start session
        </button>
      </div>
      <p className="text-[11px] uppercase tracking-[0.2em] text-white/20">Powered by Gemini</p>
    </main>
  );
}

function AuthGate() {
  const auth = useAuth();
  const [view, setView] = useState<"hero" | "login">("hero");
  // Account creation signs the user in before they've picked a username;
  // Login renders that "save a username" step itself, so skip straight
  // past the hero once there's a signed-in-but-incomplete user.
  const needsUsername = Boolean(auth.user && !auth.user.displayName);

  return (
    <div className="h-screen w-full flex flex-col lg:flex-row bg-black font-sans overflow-hidden">
      {needsUsername || view === "login" ? <Login /> : <Hero onStart={() => setView("login")} />}
      <OrbAside />
    </div>
  );
}

function AppShell() {
  const auth = useAuth();

  if (!firebaseConfigured) return <Dashboard onLogout={() => undefined} />;
  if (auth.loading) return <div className="h-screen w-full bg-black" />;

  const needsUsername = Boolean(auth.user && !auth.user.displayName);
  if (!auth.user || needsUsername) return <AuthGate />;

  return <Dashboard onLogout={() => { auth.logOut(); }} />;
}

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}
