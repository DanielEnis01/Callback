import { useState, FC, ElementType, ReactNode } from "react";
import {
  LayoutDashboard,
  FileBarChart,
  History,
  TrendingUp,
  SlidersHorizontal,
  Settings,
  LogOut,
  ArrowUpRight,
  ArrowDownRight,
  Plus,
  Target,
  ChevronRight,
  Mail,
  FileText,
  Briefcase,
  Upload,
  X,
  Check,
} from "lucide-react";
import { SessionMeeting } from "./SessionMeeting";
import { CalibrationSession } from "./CalibrationSession";
import { getBaseline } from "./baselineStore";

interface DashboardProps {
  onLogout: () => void;
}

type View = "dashboard" | "results" | "sessions" | "trends" | "settings" | "calibration";
type NavItem = { id: View; title: string; icon: ElementType };

const navGroups: { heading?: string; items: NavItem[] }[] = [
  {
    items: [
      { id: "dashboard", title: "Dashboard", icon: LayoutDashboard },
      { id: "results", title: "Results", icon: FileBarChart },
      { id: "sessions", title: "Sessions", icon: History },
      { id: "trends", title: "Trends", icon: TrendingUp },
      { id: "calibration", title: "Calibration", icon: SlidersHorizontal },
    ],
  },
];

const bottomItems: NavItem[] = [
  { id: "settings", title: "Settings", icon: Settings },
  { id: "dashboard", title: "Log out", icon: LogOut },
];

// ── Seeded demo data ──────────────────────────────────────────────
const stats = [
  { label: "Composite score", value: "78", unit: "/100", delta: "+6", up: true, base: "vs. last session" },
  { label: "Filler words", value: "3.1", unit: "/min", delta: "-2.4", up: true, base: "vs. baseline" },
  { label: "Eye contact", value: "82", unit: "%", delta: "+9", up: true, base: "vs. baseline" },
  { label: "Avg stress", value: "Moderate", unit: "", delta: "peak after Q3", up: false, base: "Baevsky index" },
];

const weaknesses = [
  { title: "Filler words cluster under pressure", detail: "14 fillers across your first two answers, dropping to 3 by the fourth — they spike when the question is unexpected.", metric: "filler-word count" },
  { title: "Eye contact drops mid-answer", detail: "Gaze left the camera for 22s during the salary question, right as your stress index peaked.", metric: "gaze-away · stress spike" },
  { title: "Restless posture", detail: "9 posture shifts in the last third of the session, reading as fidgeting rather than emphasis.", metric: "posture-shift count" },
];

const strengths = [
  { title: "Breathing held steady", detail: "Stayed within 10% of your baseline the entire session." },
  { title: "No long pauses", detail: "Zero pauses over 3s — answers stayed connected and confident." },
];

const questions = [
  { q: "Tell me about yourself.", time: "1:12", fillers: 2, eye: 91, note: "Strong, well-paced opening.", weak: false },
  { q: "Describe a conflict on a team.", time: "2:03", fillers: 6, eye: 78, note: "Lost the thread midway before recovering.", weak: false },
  { q: "What are your salary expectations?", time: "1:47", fillers: 8, eye: 61, note: "Eye contact dropped, wrapped up abruptly.", weak: true },
  { q: "Why this company?", time: "1:20", fillers: 3, eye: 88, note: "Focused and specific — best close.", weak: false },
];

const trend = [9.2, 7.8, 8.4, 6.1, 4.9, 3.1];

const sessions = [
  { id: 1, date: "Sept 12, 2026 · 5:19 AM", mode: "Interview", score: 78, weakness: "Eye contact under pressure" },
  { id: 2, date: "Sept 10, 2026 · 9:02 PM", mode: "Interview", score: 72, weakness: "Filler words in openings" },
  { id: 3, date: "Sept 8, 2026 · 8:41 PM", mode: "Focus", score: 69, weakness: "Slouching late in session" },
  { id: 4, date: "Sept 5, 2026 · 7:15 PM", mode: "Interview", score: 64, weakness: "Fast speaking pace" },
  { id: 5, date: "Sept 2, 2026 · 6:50 PM", mode: "Interview", score: 61, weakness: "Frequent long pauses" },
  { id: 6, date: "Aug 30, 2026 · 10:04 AM", mode: "Focus", score: 58, weakness: "Distraction events" },
];

const overallWeaknesses = [
  { title: "Frequent use of filler words", detail: "Averaging 6.4 fillers per minute across your last 5 sessions, heaviest in the opening minute of each answer.", freq: "5 of 6 sessions", metric: "filler-word count" },
  { title: "Posture drifts into slouching", detail: "Sustained slouching in the back half of your sessions; posture shifts climb the longer a session runs.", freq: "4 of 6 sessions", metric: "posture-shift count" },
  { title: "Eye contact breaks under pressure", detail: "Gaze consistently leaves the camera on compensation and conflict questions — the same categories each time.", freq: "3 of 6 sessions", metric: "gaze-away · stress" },
];

const Sparkline: FC<{ data: number[]; label?: string }> = ({ data }) => {
  const w = 460;
  const h = 120;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / (max - min || 1)) * (h - 16) - 8;
    return [x, y];
  });
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="block">
      <path d={line} fill="none" stroke="#ffffff" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      {pts.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r={i === pts.length - 1 ? 3.5 : 2} fill="#ffffff" opacity={i === pts.length - 1 ? 1 : 0.4} />
      ))}
    </svg>
  );
};

const SectionCard: FC<{ title: string; children: ReactNode; className?: string; right?: ReactNode }> = ({
  title,
  children,
  className = "",
  right,
}) => (
  <div className={`border border-white/12 p-5 ${className}`}>
    <div className="flex items-center justify-between mb-4">
      <h2 className="text-[13px] uppercase tracking-[0.16em] text-white/40">{title}</h2>
      {right}
    </div>
    {children}
  </div>
);

export const Dashboard: FC<DashboardProps> = ({ onLogout }) => {
  const [view, setView] = useState<View>("dashboard");
  const [inMeeting, setInMeeting] = useState(false);
  const [inCalibration, setInCalibration] = useState(false);

  if (inMeeting) {
    return <SessionMeeting onEnd={() => { setInMeeting(false); setView("results"); }} />;
  }

  if (inCalibration) {
    return (
      <CalibrationSession
        onDone={() => { setInCalibration(false); setView("calibration"); }}
        onCancel={() => setInCalibration(false)}
      />
    );
  }

  const breadcrumb =
    view === "dashboard" ? "Dashboard"
    : view === "results" ? "Results"
    : view === "sessions" ? "Sessions"
    : view === "settings" ? "Settings"
    : view === "calibration" ? "Calibration"
    : "Trends";

  return (
    <div
      className="h-screen w-full flex bg-black text-white overflow-hidden"
      style={{ fontFamily: "'Sora', sans-serif" }}
    >
      {/* Sidebar */}
      <aside className="hidden md:flex w-[240px] shrink-0 flex-col border-r border-white/12 px-4 py-6">
        <div className="px-1.5 text-[20px] font-800 tracking-tight" style={{ fontWeight: 800 }}>
          Callback.
        </div>

        <button
          onClick={() => setInMeeting(true)}
          aria-label="Start session"
          className="mt-6 flex h-10 w-full items-center justify-center bg-white text-black rounded-none transition-opacity active:opacity-70"
        >
          <Plus className="h-5 w-5" strokeWidth={2} />
        </button>

        <nav className="mt-6 flex flex-1 flex-col gap-6">
          {navGroups.map((group, gi) => (
            <div key={gi} className="flex flex-col gap-1">
              {group.heading && (
                <span className="px-2 mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/30">
                  {group.heading}
                </span>
              )}
              {group.items.map((item) => {
                const on = view === item.id;
                return (
                  <button
                    key={item.title}
                    onClick={() => setView(item.id)}
                    className={`group flex items-center gap-3 px-2.5 py-2 rounded-none text-[13px] transition-colors ${
                      on ? "bg-white/10 text-white" : "text-white/50 hover:text-white/90"
                    }`}
                  >
                    <item.icon className="h-[16px] w-[16px]" strokeWidth={1.6} />
                    {item.title}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-1 border-t border-white/12 pt-4">
          {bottomItems.map((item) => {
            const on = item.title === "Settings" && view === "settings";
            return (
            <button
              key={item.title}
              onClick={() => (item.title === "Log out" ? onLogout() : setView("settings"))}
              className={`flex items-center gap-3 px-2.5 py-2 rounded-none text-[13px] transition-colors ${
                on ? "bg-white/10 text-white" : "text-white/50 hover:text-white/90"
              }`}
            >
              <item.icon className="h-[16px] w-[16px]" strokeWidth={1.6} />
              {item.title}
            </button>
            );
          })}
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-14 shrink-0 flex items-center justify-between border-b border-white/12 px-6">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="text-white/40">Callback</span>
            <span className="text-white/25">/</span>
            <span className="text-white">{breadcrumb}</span>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={() => setView("settings")}
              className="h-8 w-8 border border-white/20 flex items-center justify-center text-[12px] font-semibold transition-colors hover:border-white/50"
            >
              JD
            </button>
          </div>
        </header>

        {view === "calibration" ? (
          <div className="flex-1 min-h-0 overflow-hidden px-6 py-6">
            <CalibrationView onRecalibrate={() => setInCalibration(true)} />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-6 py-8 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
            <div className="mx-auto max-w-5xl flex flex-col gap-6">
              {view === "dashboard" && <OverallView onStart={() => setInMeeting(true)} onViewSessions={() => setView("sessions")} />}
              {view === "results" && <ResultsView onViewSessions={() => setView("sessions")} />}
              {view === "sessions" && <SessionsView onOpen={() => setView("results")} />}
              {view === "trends" && <TrendsView />}
              {view === "settings" && <SettingsView onLogout={onLogout} />}
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

// ── Dashboard (overall, cross-session) ────────────────────────────
const OverallView: FC<{ onStart: () => void; onViewSessions: () => void }> = ({ onStart, onViewSessions }) => (
  <>
    <div className="flex items-end justify-between gap-4">
      <div>
        <h1 className="text-[30px] font-800 tracking-tight" style={{ fontWeight: 800 }}>Your coaching profile</h1>
        <p className="mt-1 text-[14px] text-white/45" style={{ fontWeight: 300 }}>
          Patterns Callback has learned across your last 6 sessions.
        </p>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <button
          onClick={onStart}
          className="flex items-center gap-2 bg-white text-black text-[13px] font-semibold px-5 h-11 rounded-none transition-opacity active:opacity-70"
        >
          <Plus className="h-4 w-4" strokeWidth={2} />
          Start new session
        </button>
        <button
          onClick={onStart}
          className="flex items-center gap-2 border border-white/20 text-white text-[13px] font-semibold px-5 h-11 rounded-none transition-colors hover:border-white/50"
        >
          <Target className="h-4 w-4" strokeWidth={1.8} />
          Target a weakness
        </button>
      </div>
    </div>

    <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-white/12 border border-white/12">
      {[
        { label: "Sessions", value: "6" },
        { label: "Avg score", value: "67" },
        { label: "Best score", value: "78" },
        { label: "Trend", value: "Improving" },
      ].map((s) => (
        <div key={s.label} className="bg-black p-4 flex flex-col gap-2">
          <span className="text-[11px] uppercase tracking-[0.14em] text-white/35">{s.label}</span>
          <span className="text-[26px] font-800 leading-none" style={{ fontWeight: 800 }}>{s.value}</span>
        </div>
      ))}
    </div>

    <SectionCard title="Recurring weaknesses">
      <ol className="flex flex-col divide-y divide-white/10">
        {overallWeaknesses.map((w, i) => (
          <li key={i} className="flex gap-4 py-4 first:pt-0 last:pb-0">
            <span className="text-[14px] font-800 text-white/30 w-5 shrink-0" style={{ fontWeight: 800 }}>{String(i + 1).padStart(2, "0")}</span>
            <div className="flex flex-col gap-1 flex-1">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[15px] font-medium">{w.title}</span>
                <span className="text-[11px] uppercase tracking-[0.12em] text-white/40 border border-white/15 px-2 py-0.5 shrink-0">{w.freq}</span>
              </div>
              <span className="text-[13px] text-white/50 leading-relaxed" style={{ fontWeight: 300 }}>{w.detail}</span>
              <span className="mt-0.5 text-[11px] uppercase tracking-[0.12em] text-white/30">{w.metric}</span>
            </div>
          </li>
        ))}
      </ol>
    </SectionCard>

    <SectionCard
      title="Recent sessions"
      right={
        <button onClick={onViewSessions} className="text-[12px] text-white/50 hover:text-white/90 transition-colors flex items-center gap-1">
          View all <ChevronRight className="h-3.5 w-3.5" />
        </button>
      }
    >
      <div className="flex flex-col divide-y divide-white/10">
        {sessions.slice(0, 3).map((s) => (
          <div key={s.id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
            <div className="flex flex-col">
              <span className="text-[14px]">{s.date}</span>
              <span className="text-[12px] text-white/40">{s.mode} · {s.weakness}</span>
            </div>
            <span className="text-[16px] font-800 tabular-nums" style={{ fontWeight: 800 }}>{s.score}</span>
          </div>
        ))}
      </div>
    </SectionCard>
  </>
);

// ── Sessions list ─────────────────────────────────────────────────
const SessionsView: FC<{ onOpen: () => void }> = ({ onOpen }) => (
  <>
    <div>
      <h1 className="text-[30px] font-800 tracking-tight" style={{ fontWeight: 800 }}>Sessions</h1>
      <p className="mt-1 text-[14px] text-white/45" style={{ fontWeight: 300 }}>
        Every session you've run. Open one to see its full results.
      </p>
    </div>

    <div className="border border-white/12">
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-6 px-5 py-3 text-[11px] uppercase tracking-[0.12em] text-white/30 border-b border-white/10">
        <span>Session</span>
        <span>Mode</span>
        <span className="text-right">Score</span>
        <span></span>
      </div>
      {sessions.map((s) => (
        <button
          key={s.id}
          onClick={onOpen}
          className="w-full grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-6 px-5 py-4 border-b border-white/10 last:border-b-0 text-left transition-colors hover:bg-white/[0.03]"
        >
          <div className="flex flex-col min-w-0">
            <span className="text-[14px]">{s.date}</span>
            <span className="text-[12px] text-white/40 truncate">Top weakness · {s.weakness}</span>
          </div>
          <span className="text-[13px] text-white/60">{s.mode}</span>
          <span className="text-[16px] font-800 tabular-nums text-right" style={{ fontWeight: 800 }}>{s.score}</span>
          <ChevronRight className="h-4 w-4 text-white/30" />
        </button>
      ))}
    </div>
  </>
);

// ── Trends ────────────────────────────────────────────────────────
const TrendsView: FC = () => (
  <>
    <div>
      <h1 className="text-[30px] font-800 tracking-tight" style={{ fontWeight: 800 }}>Trends</h1>
      <p className="mt-1 text-[14px] text-white/45" style={{ fontWeight: 300 }}>
        Your own metrics over time, measured against your first-session baseline.
      </p>
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <SectionCard title="Filler words / min" right={<span className="text-[12px] text-white/40">9.2 → 3.1</span>}>
        <Sparkline data={trend} />
      </SectionCard>
      <SectionCard title="Composite score" right={<span className="text-[12px] text-white/40">58 → 78</span>}>
        <Sparkline data={[58, 61, 64, 69, 72, 78]} />
      </SectionCard>
      <SectionCard title="Eye contact %" right={<span className="text-[12px] text-white/40">64 → 82</span>}>
        <Sparkline data={[64, 66, 71, 74, 79, 82]} />
      </SectionCard>
      <SectionCard title="Posture shifts / session" right={<span className="text-[12px] text-white/40">18 → 9</span>}>
        <Sparkline data={[18, 16, 15, 12, 11, 9]} />
      </SectionCard>
    </div>
  </>
);

// ── Calibration ───────────────────────────────────────────────────
// Seed/placeholder values shown before the person has ever run
// calibration. Once a real Baseline exists (see baselineStore.ts —
// captured by CalibrationSession) its numbers replace these below.
const seedHeadline = [
  { label: "Resting pulse", value: "68", unit: "bpm" },
  { label: "Breathing rate", value: "14", unit: "/min" },
  { label: "Blink rate", value: "17", unit: "/min" },
  { label: "Stress (Baevsky)", value: "42", unit: "· Low" },
];

function fmt(n: number | null | undefined, digits = 0): string | null {
  return n == null || Number.isNaN(n) ? null : n.toFixed(digits);
}

const CalibrationView: FC<{ onRecalibrate: () => void }> = ({ onRecalibrate }) => {
  const baseline = getBaseline();

  const headline = baseline
    ? [
        { label: "Resting pulse", value: fmt(baseline.restingPulseBpm) ?? "—", unit: "bpm" },
        { label: "Breathing rate", value: fmt(baseline.breathingRatePerMin) ?? "—", unit: "/min" },
        { label: "Blink rate", value: fmt(baseline.blinkRatePerMin) ?? "—", unit: "/min" },
        {
          label: "Stress (Baevsky)",
          value: fmt(baseline.baevsky) ?? "—",
          unit: baseline.stressLabel ? `· ${baseline.stressLabel}` : "",
        },
      ]
    : seedHeadline;

  const baselineGroups: { heading: string; rows: { label: string; value: string }[] }[] = baseline
    ? [
        {
          heading: "Heart rate variability",
          rows: [
            { label: "RMSSD", value: fmt(baseline.hrv.rmssd, 0) ? `${fmt(baseline.hrv.rmssd, 0)} ms` : "Not enough data" },
            { label: "SDNN", value: fmt(baseline.hrv.sdnn, 0) ? `${fmt(baseline.hrv.sdnn, 0)} ms` : "Not enough data" },
            { label: "Mean NN", value: fmt(baseline.hrv.meanNn, 0) ? `${fmt(baseline.hrv.meanNn, 0)} ms` : "Not enough data" },
          ],
        },
        {
          heading: "Breathing pattern",
          rows: [
            { label: "Rate", value: fmt(baseline.breathingRatePerMin) ? `${fmt(baseline.breathingRatePerMin)} /min` : "Not enough data" },
            { label: "Amplitude", value: fmt(baseline.breathingAmplitude, 2) ?? "Not enough data" },
          ],
        },
        {
          heading: "Motion & arousal",
          rows: [
            { label: "Seat micro-motion", value: fmt(baseline.microMotion.seat, 3) ?? "Not enough data" },
            { label: "Knee micro-motion", value: fmt(baseline.microMotion.knees, 3) ?? "Not enough data" },
            {
              label: "Skin conductance (EDA)",
              // The SDK needs 35s+ of continuous recording before it produces
              // a first EDA sample, so a 45s calibration often only gets a
              // couple — this is genuinely absent more often than not.
              value: fmt(baseline.edaMicroSiemens, 2) ? `${fmt(baseline.edaMicroSiemens, 2)} µS` : "Not enough data",
            },
          ],
        },
      ]
    : [
        {
          heading: "Heart rate variability",
          rows: [
            { label: "RMSSD", value: "48 ms" },
            { label: "SDNN", value: "62 ms" },
            { label: "Mean NN", value: "880 ms" },
          ],
        },
        {
          heading: "Breathing pattern",
          rows: [
            { label: "Rate", value: "14 /min" },
            { label: "Amplitude", value: "Normal" },
          ],
        },
        {
          heading: "Motion & arousal",
          rows: [
            { label: "Seat micro-motion", value: "Low" },
            { label: "Knee micro-motion", value: "Low" },
            { label: "Skin conductance (EDA)", value: "3.2 µS" },
          ],
        },
      ];

  const capturedLabel = baseline
    ? new Date(baseline.capturedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : null;

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 shrink-0">
        <div>
          <h1 className="text-[28px] font-800 tracking-tight" style={{ fontWeight: 800 }}>Baseline</h1>
          <p className="mt-1 text-[13px] text-white/45" style={{ fontWeight: 300 }}>
            {baseline
              ? `Your calm/resting values · captured ${capturedLabel}. Every session is scored as a deviation from these.`
              : "No calibration on file yet — these are placeholder values. Run calibration to capture your own."}
          </p>
        </div>
        <button
          onClick={onRecalibrate}
          className="flex items-center gap-2 bg-white text-black text-[13px] font-semibold px-5 h-11 rounded-none transition-opacity active:opacity-70 shrink-0"
        >
          <SlidersHorizontal className="h-4 w-4" strokeWidth={1.8} />
          {baseline ? "Recalibrate" : "Run calibration"}
        </button>
      </div>

      {/* Headline vitals */}
      <div className="mt-6 grid grid-cols-2 lg:grid-cols-4 gap-px bg-white/12 border border-white/12 shrink-0">
        {headline.map((s) => (
          <div key={s.label} className="bg-black p-4 flex flex-col gap-2">
            <span className="text-[11px] uppercase tracking-[0.14em] text-white/35">{s.label}</span>
            <div className="flex items-baseline gap-1">
              <span className="text-[26px] font-800 leading-none" style={{ fontWeight: 800 }}>{s.value}</span>
              <span className="text-[13px] text-white/40">{s.unit}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Detailed baseline groups */}
      <div className="mt-6 flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {baselineGroups.map((g) => (
          <div key={g.heading} className="border border-white/12 p-5 flex flex-col">
            <h2 className="text-[13px] uppercase tracking-[0.16em] text-white/40 mb-3">{g.heading}</h2>
            <div className="flex flex-col divide-y divide-white/10">
              {g.rows.map((r) => (
                <div key={r.label} className="flex items-center justify-between py-2.5 first:pt-0">
                  <span className="text-[13px] text-white/55">{r.label}</span>
                  <span className="text-[14px] tabular-nums">{r.value}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <p className="mt-5 text-[11px] text-white/25 leading-relaxed shrink-0">
        Baseline is stored only on this device for now (no accounts/database yet) to compare against your own
        future sessions. Indicators are heuristic estimates for coaching, not a clinical or certified measurement.
      </p>
    </div>
  );
};

// ── Settings (account) ────────────────────────────────────────────
const jobPositions = [
  "Software Engineer",
  "Product Manager",
  "Data Scientist",
  "UX Designer",
  "Consultant",
];

const SettingsView: FC<{ onLogout: () => void }> = ({ onLogout }) => {
  const [resumes, setResumes] = useState([
    { id: 1, name: "Jordan_Doe_Resume_2026.pdf", size: "182 KB" },
    { id: 2, name: "Jordan_Doe_SWE_tailored.pdf", size: "204 KB" },
  ]);
  const [position, setPosition] = useState("Software Engineer");

  return (
    <>
      <div>
        <h1 className="text-[30px] font-800 tracking-tight" style={{ fontWeight: 800 }}>Account settings</h1>
        <p className="mt-1 text-[14px] text-white/45" style={{ fontWeight: 300 }}>
          Manage your profile, resumes, and interview target.
        </p>
      </div>

      {/* Account */}
      <SectionCard title="Account">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 border border-white/20 flex items-center justify-center text-[13px] font-semibold">JD</div>
            <div className="flex flex-col">
              <span className="text-[15px]">Jordan Doe</span>
              <span className="flex items-center gap-1.5 text-[13px] text-white/45">
                <Mail className="h-3.5 w-3.5" /> jordan.doe@email.com
              </span>
            </div>
          </div>
          <button className="border border-white/20 text-[12px] px-4 h-9 rounded-none transition-colors hover:border-white/50">
            Change email
          </button>
        </div>
      </SectionCard>

      {/* Resumes */}
      <SectionCard
        title="Resumes"
        right={
          <button className="flex items-center gap-2 border border-white/20 text-[12px] px-3 h-8 rounded-none transition-colors hover:border-white/50">
            <Upload className="h-3.5 w-3.5" /> Upload
          </button>
        }
      >
        <div className="flex flex-col divide-y divide-white/10">
          {resumes.map((r) => (
            <div key={r.id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
              <div className="flex items-center gap-3 min-w-0">
                <FileText className="h-4 w-4 text-white/50 shrink-0" strokeWidth={1.6} />
                <span className="text-[14px] truncate">{r.name}</span>
                <span className="text-[12px] text-white/35 shrink-0">{r.size}</span>
              </div>
              <button
                onClick={() => setResumes((rs) => rs.filter((x) => x.id !== r.id))}
                aria-label="Remove resume"
                className="text-white/40 transition-colors hover:text-white"
              >
                <X className="h-4 w-4" strokeWidth={1.8} />
              </button>
            </div>
          ))}
          {resumes.length === 0 && (
            <p className="text-[13px] text-white/40 py-3">No resumes uploaded yet.</p>
          )}
        </div>
      </SectionCard>

      {/* Target position */}
      <SectionCard title="Target job position">
        <div className="flex items-center gap-2 mb-4 text-[13px] text-white/50">
          <Briefcase className="h-4 w-4" strokeWidth={1.6} />
          Callback tailors questions and feedback to this role.
        </div>
        <div className="flex flex-wrap gap-2">
          {jobPositions.map((p) => {
            const on = p === position;
            return (
              <button
                key={p}
                onClick={() => setPosition(p)}
                className={`flex items-center gap-2 text-[13px] px-4 h-9 rounded-none border transition-colors ${
                  on ? "bg-white text-black border-white" : "border-white/20 text-white/70 hover:border-white/50"
                }`}
              >
                {on && <Check className="h-3.5 w-3.5" strokeWidth={2} />}
                {p}
              </button>
            );
          })}
        </div>
      </SectionCard>

      <button
        onClick={onLogout}
        className="flex items-center gap-2 w-fit border border-white/20 text-[13px] font-semibold px-5 h-11 rounded-none transition-colors hover:border-white/50"
      >
        <LogOut className="h-4 w-4" strokeWidth={1.8} />
        Log out
      </button>
    </>
  );
};

// ── Results (single session) ──────────────────────────────────────
const ResultsView: FC<{ onViewSessions: () => void }> = ({ onViewSessions }) => (
  <>
    <div className="flex items-end justify-between">
      <div>
        <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-white/50 border border-white/15 px-2 py-0.5 mb-3">
          <span className="h-1.5 w-1.5 bg-white" /> Most recent session
        </span>
        <h1 className="text-[30px] font-800 tracking-tight" style={{ fontWeight: 800 }}>Interview session</h1>
        <p className="mt-1 text-[14px] text-white/45" style={{ fontWeight: 300 }}>Mock interview · 6:22 · Sept 12, 2026</p>
      </div>
      <div className="hidden sm:flex items-baseline gap-2 border border-white/12 px-5 py-3">
        <span className="text-[32px] font-800 leading-none" style={{ fontWeight: 800 }}>78</span>
        <span className="text-[14px] text-white/40">/100 · Strong</span>
      </div>
    </div>

    <button
      onClick={onViewSessions}
      className="flex items-center justify-between border border-white/12 px-5 py-3.5 text-left transition-colors hover:bg-white/[0.03]"
    >
      <span className="text-[13px] text-white/60">
        Looking for an earlier session? Browse your full history in <span className="text-white">Sessions</span>.
      </span>
      <ChevronRight className="h-4 w-4 text-white/40 shrink-0" />
    </button>

    <div className="border border-white/12 px-5 py-4 text-[15px] text-white/80" style={{ fontWeight: 300 }}>
      You came across as composed and prepared — steady breathing and specific answers — but tension around
      compensation pulled your eyes off-camera and stacked up filler words.
    </div>

    <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-white/12 border border-white/12">
      {stats.map((s) => (
        <div key={s.label} className="bg-black p-4 flex flex-col gap-2">
          <span className="text-[11px] uppercase tracking-[0.14em] text-white/35">{s.label}</span>
          <div className="flex items-baseline gap-1">
            <span className="text-[26px] font-800 leading-none" style={{ fontWeight: 800 }}>{s.value}</span>
            {s.unit && <span className="text-[13px] text-white/40">{s.unit}</span>}
          </div>
          <div className="flex items-center gap-1 text-[12px] text-white/50">
            {s.up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
            <span>{s.delta}</span>
            <span className="text-white/30">· {s.base}</span>
          </div>
        </div>
      ))}
    </div>

    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <SectionCard title="What to work on" className="lg:col-span-2">
        <ol className="flex flex-col divide-y divide-white/10">
          {weaknesses.map((w, i) => (
            <li key={i} className="flex gap-4 py-4 first:pt-0 last:pb-0">
              <span className="text-[14px] font-800 text-white/30 w-5 shrink-0" style={{ fontWeight: 800 }}>{String(i + 1).padStart(2, "0")}</span>
              <div className="flex flex-col gap-1">
                <span className="text-[15px] font-medium">{w.title}</span>
                <span className="text-[13px] text-white/50 leading-relaxed" style={{ fontWeight: 300 }}>{w.detail}</span>
                <span className="mt-0.5 text-[11px] uppercase tracking-[0.12em] text-white/30">{w.metric}</span>
              </div>
            </li>
          ))}
        </ol>
      </SectionCard>

      <SectionCard title="What went well">
        <div className="flex flex-col divide-y divide-white/10">
          {strengths.map((s, i) => (
            <div key={i} className="py-4 first:pt-0 last:pb-0 flex flex-col gap-1">
              <span className="text-[15px] font-medium">{s.title}</span>
              <span className="text-[13px] text-white/50 leading-relaxed" style={{ fontWeight: 300 }}>{s.detail}</span>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>

    <SectionCard title="Filler words / min — last 6 sessions" right={<span className="text-[12px] text-white/40">9.2 → 3.1</span>}>
      <Sparkline data={trend} />
    </SectionCard>

    <div className="border border-white/12">
      <h2 className="text-[13px] uppercase tracking-[0.16em] text-white/40 px-5 pt-5 pb-3">Per-question breakdown</h2>
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-6 px-5 pb-2 text-[11px] uppercase tracking-[0.12em] text-white/30 border-b border-white/10">
        <span>Question</span>
        <span className="text-right">Time</span>
        <span className="text-right">Fillers</span>
        <span className="text-right">Eye %</span>
      </div>
      {questions.map((row, i) => (
        <div key={i} className="grid grid-cols-[1fr_auto_auto_auto] gap-x-6 px-5 py-4 border-b border-white/10 last:border-b-0">
          <div className="flex flex-col gap-1 min-w-0">
            <span className="text-[14px] flex items-center gap-2">
              {row.q}
              {row.weak && <span className="text-[10px] uppercase tracking-[0.12em] border border-white/30 px-1.5 py-0.5 text-white/70">Revisit</span>}
            </span>
            <span className="text-[12px] text-white/45" style={{ fontWeight: 300 }}>{row.note}</span>
          </div>
          <span className="text-[14px] text-right tabular-nums">{row.time}</span>
          <span className="text-[14px] text-right tabular-nums">{row.fillers}</span>
          <span className="text-[14px] text-right tabular-nums">{row.eye}%</span>
        </div>
      ))}
    </div>

    <p className="text-[11px] text-white/25 leading-relaxed">
      Indicators are heuristic estimates for coaching, not a clinical or certified measurement. Trends are shown against
      your own first-session baseline.
    </p>
  </>
);

export default Dashboard;
