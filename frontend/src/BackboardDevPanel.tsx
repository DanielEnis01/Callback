import { useRef, useState } from "react";
import { Terminal, X } from "lucide-react";
import { callbackApi, completeInterview, getDevUser, getMemoryMode, type InterviewSession, type PlanQuestion } from "./backboard";

const inputClass = "w-full border border-white/20 bg-black px-3 py-2 text-sm text-white outline-none focus:border-white/60";
export function BackboardDevPanel({ initialOpen = false }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [mode, setMode] = useState(getMemoryMode);
  const [user, setUser] = useState(getDevUser);
  const [query, setQuery] = useState("Software engineer conflict resolution migration delivery");
  const [sessionId, setSessionId] = useState("");
  const [sessions, setSessions] = useState<InterviewSession[]>([]);
  const [plan, setPlan] = useState<PlanQuestion[]>([]);
  const [draft, setDraft] = useState("[]");
  const [output, setOutput] = useState("Choose a mode, then seed history or create a new interview. Mock mode is local and uses no API credits.");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  if (!import.meta.env.DEV) return null;
  async function refreshSessions() {
    const result = await callbackApi<{ sessions: InterviewSession[] }>("/backboard/sessions");
    setSessions(result.sessions);
    return result;
  }
  async function run(label: string, action: () => Promise<unknown>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setOutput(`${label}…`);
    try { setOutput(JSON.stringify(await action(), null, 2)); }
    catch (error) { setOutput(`${label} failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const button = (label: string, action: () => Promise<unknown>, disabled = false) => <button type="button" disabled={busy || disabled} onClick={() => void run(label, action)} className="border border-white/20 px-3 py-2 text-xs text-white/85 hover:bg-white/10 disabled:opacity-30">{label}</button>;
  return <div className="fixed bottom-4 left-4 z-[9999] text-white" style={{ fontFamily: "'Sora', sans-serif" }}>
    {!open && <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-2 border border-white/25 bg-zinc-900 px-4 py-3 text-xs"><Terminal size={15} /> Backboard dev tools</button>}
    {open && <section aria-label="Backboard developer tools" className="flex max-h-[90vh] w-[min(960px,calc(100vw-32px))] flex-col border border-white/20 bg-zinc-950 shadow-2xl">
      <header className="flex items-center justify-between border-b border-white/15 p-4"><div><h2 className="text-base">Backboard memory lab</h2><p className="mt-1 text-xs text-white/45">Q&A records · planner callbacks · qualitative progress</p></div><button aria-label="Close developer tools" onClick={() => setOpen(false)}><X size={18} /></button></header>
      <div className="overflow-y-auto p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-white/50">Memory mode<select aria-label="Memory mode" disabled={busy} className={`${inputClass} mt-1`} value={mode} onChange={(e) => { setMode(e.target.value); localStorage.setItem("callback.memory.mode", e.target.value); setSessionId(""); setSessions([]); setPlan([]); setOutput("Mode changed. Refresh sessions to inspect this store."); }}>
            <option value="mock">Mock — no API calls</option><option value="live">Live Backboard + Gemini — uses API credits</option><option value="outage">Simulated Backboard outage</option><option value="empty">Empty retrieval / first-session behavior</option>
          </select></label>
          <label className="text-xs text-white/50">Development user<input aria-label="Development user" disabled={busy} className={`${inputClass} mt-1`} value={user} onChange={(e) => { setUser(e.target.value); localStorage.setItem("callback.dev.user", e.target.value); setSessionId(""); setSessions([]); setPlan([]); }} /></label>
        </div>
        <p className="my-3 text-xs text-white/45">{mode === "live" ? "Live mode writes synthetic history to your development user's own Backboard assistant. Resume PDFs go only to Gemini. Requires backend API keys." : "Mock, empty, and outage modes share a separate local test store. Switch users to check isolation. Mock search uses word overlap; test semantic relevance in live mode."}</p>
        <div className="flex flex-wrap gap-2">
          {button("Check status", () => callbackApi("/backboard/status"))}
          {button("Seed 3 past sessions", async () => { const result = await callbackApi("/backboard/dev/seed", {}); await refreshSessions(); return result; })}
          {button("Refresh sessions", refreshSessions)}
          {button("Use fresh test user", async () => { const id = `dev-${crypto.randomUUID()}`; localStorage.setItem("callback.dev.user", id); setUser(id); setSessions([]); setSessionId(""); setPlan([]); return { userId: id }; })}
        </div>
        <label className="mt-4 block text-xs text-white/50">Search / current job posting<textarea aria-label="Memory search query" className={`${inputClass} mt-1`} value={query} onChange={(e) => setQuery(e.target.value)} rows={2} /></label>
        <div className="mt-2 flex flex-wrap gap-2">
          {button("Search Q&A", () => callbackApi("/backboard/memories/search", { query, kind: "qa_pair", limit: 10 }))}
          {button("Find weak answers", () => callbackApi("/backboard/memories/search", { query, kind: "qa_pair", weakOnly: true, limit: 10 }))}
          {button("Inspect planner context", () => callbackApi("/backboard/dev/planner-context", { query }))}
          {button("Create next interview", async () => {
            const session = await callbackApi<InterviewSession>("/services/sessions", { jobPostingText: query });
            setSessionId(session.sessionId);
            const result = await callbackApi<{ questions: PlanQuestion[] }>("/services/gemini/interview-plan", { sessionId: session.sessionId });
            setPlan(result.questions);
            setDraft(JSON.stringify(result.questions.flatMap((q, questionIndex) => [
              { role: "model", parts: [{ text: q.text }], questionIndex, isClarifying: false },
              { role: "user", parts: [{ text: "When our team needed a migration, I led the project and built a staged rollout. We reduced failures by 40% and delivered in six weeks." }], questionIndex, isClarifying: false },
            ]), null, 2));
            await refreshSessions(); return result;
          })}
        </div>
        {!!plan.length && <ol className="mt-4 space-y-2 border border-white/15 p-3 text-sm">{plan.map((q, i) => <li key={i}><span className="text-white/70">{i + 1}. {q.text}</span>{q.repeatOf && <p className="mt-1 text-xs text-amber-200">You struggled with this one on {new Date(q.repeatOf.askedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} — let’s try again.</p>}</li>)}</ol>}
        <label className="mt-4 block text-xs text-white/50">Saved session<select aria-label="Saved session" className={`${inputClass} mt-1`} value={sessionId} onChange={(e) => { setSessionId(e.target.value); const session = sessions.find((s) => s.sessionId === e.target.value); if (session) { setPlan(session.interviewPlan || []); setDraft(JSON.stringify(session.transcript, null, 2)); } }}><option value="">Select a session</option>{sessions.map((s) => <option key={s.sessionId} value={s.sessionId}>{new Date(s.startedAt).toLocaleString()} · {s.sessionId.slice(0, 8)} · {s.memorySyncedAt ? "synced" : "unsynced"}</option>)}</select></label>
        <div className="mt-2 flex flex-wrap gap-2">
          {button("Preview exact memory payload", () => callbackApi(`/backboard/sessions/${sessionId}/preview`), !sessionId)}
          {button("Retry sync / check idempotency", async () => { const result = await callbackApi(`/backboard/sessions/${sessionId}/sync`, {}); await refreshSessions(); return result; }, !sessionId)}
          {button("Compare answers + save", async () => { const result = await completeInterview(sessionId, JSON.parse(draft)); await refreshSessions(); return result; }, !sessionId)}
        </div>
        <details className="mt-3 text-xs text-white/60"><summary className="cursor-pointer">Edit transcript JSON (questionIndex + isClarifying)</summary><textarea aria-label="Transcript JSON" className={`${inputClass} mt-2 font-mono`} rows={9} value={draft} onChange={(e) => setDraft(e.target.value)} /></details>
        <div className="mt-4 flex justify-between text-xs text-white/45"><span>{busy ? "Working…" : "Response / diagnostics"}</span><button onClick={() => { const url = URL.createObjectURL(new Blob([output], { type: "application/json" })); const a = document.createElement("a"); a.href = url; a.download = "callback-memory-debug.json"; a.click(); URL.revokeObjectURL(url); }}>Download response</button></div>
        <pre aria-live="polite" className="mt-2 max-h-80 overflow-auto border border-white/15 bg-black p-3 font-mono text-xs leading-relaxed text-emerald-200 whitespace-pre-wrap break-words">{output}</pre>
      </div>
    </section>}
  </div>;
}
