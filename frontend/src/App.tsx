import { useState } from "react";
import { VoiceOrb } from "./VoiceOrb";
import Login from "./Login";
import Download from "./Download";
import { Dashboard } from "./Dashboard";
import Account from "./Account";
import Documents from "./Documents";
import { useAuth } from "./AuthContext";
import { authErrorMessage } from "./auth-errors";

export default function App() {
  const { user, loading, busy, logOut } = useAuth();
  const [view, setView] = useState<"hero" | "login">("hero");
  const [accountView, setAccountView] = useState<"home" | "settings" | "documents" | "practice">("home");
  const [logOutError, setLogOutError] = useState("");

  if (loading) {
    return <main className="min-h-screen bg-black text-white/60 flex items-center justify-center" role="status">Loading your account…</main>;
  }

  // Firebase identity is shared by the browser and Electron practice app.
  if (user) {
    async function handleLogOut() {
      setLogOutError("");
      try {
        await logOut();
      } catch (error) {
        setLogOutError(authErrorMessage(error));
      }
    }

    if (accountView === "practice") return <Dashboard key={user.uid} onLogout={() => setAccountView("home")} />;

    return (
      <div className="min-h-screen w-full bg-black font-sans text-white">
        <header className="flex h-16 items-center border-b border-white/15 px-6 sm:px-12">
          <nav className="mx-auto flex w-full max-w-6xl items-center justify-between" aria-label="Account navigation">
            <button type="button" onClick={() => setAccountView("home")} className="text-[24px] font-extrabold tracking-tight text-white">Callback.</button>
            <div className="flex items-center gap-5 text-[14px]">
              <button type="button" onClick={() => setAccountView("home")} aria-current={accountView === "home" ? "page" : undefined} className={`transition-colors ${accountView === "home" ? "text-white" : "text-white/50 hover:text-white"}`}>Home</button>
              <button type="button" onClick={() => setAccountView("documents")} aria-current={accountView === "documents" ? "page" : undefined} className={`transition-colors ${accountView === "documents" ? "text-white" : "text-white/50 hover:text-white"}`}>Documents</button>
              <button type="button" onClick={() => setAccountView("settings")} aria-current={accountView === "settings" ? "page" : undefined} className={`transition-colors ${accountView === "settings" ? "text-white" : "text-white/50 hover:text-white"}`}>Settings</button>
            </div>
          </nav>
        </header>
        <div className="flex min-h-[calc(100vh-4rem)]">
          {accountView === "home" ? <div className="relative flex flex-1"><Download /><button className="absolute bottom-10 left-1/2 -translate-x-1/2 border border-white/50 px-5 py-2 text-sm" onClick={() => setAccountView("practice")}>Open practice app</button></div> : accountView === "documents" ? <Documents key={user.uid} /> : <Account email={user.email} displayName={user.displayName} busy={busy} error={logOutError} onLogOut={handleLogOut} />}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full flex flex-col lg:flex-row bg-black font-sans">
      {view === "hero" ? (
        <main className="flex flex-col justify-between px-6 py-12 sm:px-12 lg:w-[48%] lg:min-h-screen bg-black">
          <div />
          <div className="flex flex-col gap-6">
            <h1 className="text-[64px] leading-[1.02] font-extrabold text-white tracking-tight">Callback.</h1>
            <p className="text-[17px] leading-relaxed text-white/50 max-w-[380px] font-light">
              Real time interview preparation to get your <span className="underline underline-offset-4">call back.</span> Our voiced AI recruiter tracks and remembers your gaze, posture, and filler words in real time.
            </p>
            <button onClick={() => setView("login")} className="mt-2 w-fit bg-white text-black text-[13px] font-semibold tracking-wide px-7 py-3.5 transition-opacity active:opacity-70">
              Start session
            </button>
          </div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-white/20">Powered by Gemini</p>
        </main>
      ) : <Login />}
      <aside aria-hidden="true" className="relative flex-1 flex items-center justify-center bg-black lg:min-h-screen overflow-hidden">
        <div className="w-[min(90vw,360px)] h-[min(90vw,360px)] lg:w-[440px] lg:h-[440px]">
          <VoiceOrb className="w-full h-full" speaking={false} />
        </div>
      </aside>
    </div>
  );
}
