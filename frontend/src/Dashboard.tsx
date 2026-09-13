import { useState, useEffect, useRef, FC, ElementType, ReactNode, FormEvent } from "react";
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
  ChevronLeft,
  Mail,
  FileText,
  Briefcase,
  Upload,
  X,
  Check,
  Award,
  Flame,
  ChevronDown,
} from "lucide-react";
import { SessionMeeting } from "./SessionMeeting";
import { CalibrationSession } from "./CalibrationSession";
import { SessionSetup } from "./SessionSetup";
import { getBaseline, getInterviewProfile, remoteStorageEnabled, type Baseline } from "./baselineStore";
import { useAuth } from "./AuthContext";
import { Skeleton, SkeletonText, SkeletonCard, SkeletonStats, SkeletonChart, SkeletonRows } from "./Skeleton";
import {
  listResumes, uploadResume, deleteResume, type StoredResume,
  getOverview, getSessionDashboard, getSessionTranscript, getTraitTrend, listTraits, createGoal, deleteGoal,
  listSessions,
  type Overview, type SessionDashboard, type SessionRecord, type SessionType, type TraitDescriptor, type TraitTrend, type TraitTrendPoint, type TranscriptTurn,
} from "./dataApi";

interface DashboardProps {
  onLogout: () => void;
}

type View = "dashboard" | "results" | "sessions" | "trends" | "settings";
type NavItem = { id: View; title: string; icon: ElementType };

const navGroups: { heading?: string; items: NavItem[] }[] = [
  {
    items: [
      { id: "dashboard", title: "Dashboard", icon: LayoutDashboard },
      { id: "results", title: "Results", icon: FileBarChart },
      { id: "sessions", title: "Sessions", icon: History },
      { id: "trends", title: "Trends", icon: TrendingUp },
    ],
  },
];

const bottomItems: NavItem[] = [
  { id: "settings", title: "Settings", icon: Settings },
];

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
const ProgressBar: FC<{ pct: number | null }> = ({ pct }) => (
  <div className="h-1.5 w-full bg-white/10">
    <div className="h-full bg-white transition-[width]" style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }} />
  </div>
);

const Sparkline: FC<{ data: number[]; label?: string }> = ({ data }) => {
  if (!data.length) return <p className="text-[12px] text-white/30 py-4">Not enough data yet.</p>;
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

const HighlightedDetail: FC<{ text: string }> = ({ text }) => {
  const parts = text.split(/(improved|declined)\s+([0-9.]+%)/i);
  if (parts.length < 3) return <>{text}</>;
  
  return (
    <>
      {parts.map((part, i) => {
        if (i % 3 === 1) {
          return <span key={i}>{part} </span>;
        }
        if (i % 3 === 2) {
          const isBetter = parts[i - 1].toLowerCase() === "improved";
          return <span key={i} className={`font-semibold ${isBetter ? 'text-green-400' : 'text-red-400'}`}>{part}</span>;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
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
  const [inSessionSetup, setInSessionSetup] = useState(false);
  const [inMeeting, setInMeeting] = useState(false);
  const [inCalibration, setInCalibration] = useState(false);
  // Which session the Results tab is showing (null = most recent). Set by
  // clicking a row in Sessions -- see SessionsView's onOpen below.
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  // Set by a "Practice this" click on the Results dashboard's ranked
  // weakness list; read once by SessionSetup as its initialWeakness prop,
  // then cleared once the meeting actually starts.
  const [pendingTargetWeakness, setPendingTargetWeakness] = useState<string | null>(null);
  // Require calibration before the very first session; after that, every
  // session still goes through the SessionSetup gate below (resume/job
  // posting/weakness) rather than straight into the meeting.
  // Calibration is no longer a destination the user visits -- it is the first
  // few seconds of every session (SessionSetup -> preflight framing check ->
  // meeting). So starting a session always goes straight to the setup gate.
  const startSession = async () => {
    setInSessionSetup(true);
  };
  // "Practice this" from the Results dashboard's ranked weakness list --
  // pre-targets the next session at a specific weakness (see
  // SessionSetup's initialWeakness) instead of a blank general-practice gate.
  const practiceWeakness = (weakness: string) => {
    setPendingTargetWeakness(weakness);
    void startSession();
  };

  // Every session starts with a quick "what are you practicing for" gate —
  // confirm/replace the resume and paste this session's job posting —
  // before the meeting itself opens. See SessionSetup.tsx.
  if (inSessionSetup) {
    return (
      <SessionSetup
        initialWeakness={pendingTargetWeakness}
        onStart={() => { setInSessionSetup(false); setInCalibration(true); }}
        onCancel={() => { setInSessionSetup(false); setPendingTargetWeakness(null); }}
      />
    );
  }

  if (inMeeting) {
    return <SessionMeeting onEnd={() => { setInMeeting(false); setSelectedSessionId(null); setView("results"); }} />;
  }

  // Framing check, then straight into the interview.
  if (inCalibration) {
    return (
      <CalibrationSession
        preflight
        onDone={() => { setInCalibration(false); setInMeeting(true); setPendingTargetWeakness(null); }}
        onCancel={() => { setInCalibration(false); setPendingTargetWeakness(null); }}
      />
    );
  }

  const breadcrumb =
    view === "dashboard" ? "Dashboard"
    : view === "results" ? "Results"
    : view === "sessions" ? "Sessions"
    : view === "settings" ? "Settings"
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
          onClick={startSession}
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
            const on = view === item.id;
            return (
            <button
              key={item.title}
              onClick={() => setView(item.id)}
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

        {(
          <div className="flex-1 overflow-y-auto px-6 py-8 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
            <div className="mx-auto max-w-5xl flex flex-col gap-6">
              {view === "dashboard" && (
                <OverallView
                  onStart={startSession}
                  onViewSessions={() => setView("sessions")}
                  onOpenSession={(sessionId) => { setSelectedSessionId(sessionId); setView("results"); }}
                  onPracticeWeakness={practiceWeakness}
                />
              )}
              {view === "results" && (
                <ResultsView
                  sessionId={selectedSessionId}
                  onViewSessions={() => setView("sessions")}
                  onPracticeWeakness={practiceWeakness}
                />
              )}
              {view === "sessions" && (
                <SessionsView
                  onOpen={(sessionId) => { setSelectedSessionId(sessionId); setView("results"); }}
                />
              )}
              {view === "trends" && (
                <TrendsView onOpenSession={(sessionId) => { setSelectedSessionId(sessionId); setView("results"); }} />
              )}
              {view === "settings" && <SettingsView onLogout={onLogout} />}
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

// ── Dashboard (overall, cross-session) ────────────────────────────


const RecentSessionsList: FC = () => {
  const [rows, setRows] = useState<SessionRecord[] | null>(null);
  useEffect(() => {
    let current = true;
    listSessions({ limit: 20 })
      .then((res) => {
        if (!current) return;
        setRows(res.records.filter((r) => r.ended_at).slice(0, 3));
      })
      .catch(() => { if (current) setRows([]); });
    return () => { current = false; };
  }, []);

  if (rows === null) return <div className="py-3" role="status" aria-busy="true"><SkeletonRows rows={4} cols={3} /></div>;
  if (rows.length === 0) return <p className="text-[13px] text-white/40 py-3">No sessions yet.</p>;
  return (
    <div className="flex flex-col divide-y divide-white/10">
      {rows.map((s) => (
        <div key={s.session_id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
          <div className="flex flex-col">
            <span className="text-[14px]">{formatDate(s.started_at)}</span>
            <span className="text-[12px] text-white/40 capitalize">
              {s.targeted_weakness ? `Targeted: ${s.targeted_weakness}` : "Interview"}
            </span>
          </div>
          <span className="text-[16px] font-800 tabular-nums" style={{ fontWeight: 800 }}>
            {s.overall_score != null ? `${Math.round(s.overall_score / 10)}/10` : "—"}
          </span>
        </div>
      ))}
    </div>
  );
};

const OverallView: FC<{
  onStart: () => void;
  onViewSessions: () => void;
  onOpenSession: (sessionId: string) => void;
  onPracticeWeakness: (weakness: string) => void;
}> = ({ onStart, onViewSessions, onOpenSession, onPracticeWeakness }) => {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    getOverview()
      .then((data) => { if (current) setOverview(data); })
      .catch((err) => { if (current) setError(err instanceof Error ? err.message : "Couldn't load your stats."); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, []);

  const [traits, setTraits] = useState<TraitDescriptor[]>([]);
  const [trendTrait, setTrendTrait] = useState("");
  const [expandedTrait, setExpandedTrait] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    listTraits()
      .then((list) => { if (current) { setTraits(list); setTrendTrait((prev) => prev || list[0]?.key || ""); } })
      .catch(() => {});
    return () => { current = false; };
  }, []);

  const [trendRangeDays, setTrendRangeDays] = useState(90);
  const [trend, setTrend] = useState<TraitTrend | null>(null);
  const [trendLoading, setTrendLoading] = useState(false);
  useEffect(() => {
    if (!trendTrait || !overview?.hasSessions) return;
    let current = true;
    setTrendLoading(true);
    getTraitTrend(trendTrait, { sinceDays: trendRangeDays })
      .then((t) => { if (current) setTrend(t); })
      .catch(() => { if (current) setTrend(null); })
      .finally(() => { if (current) setTrendLoading(false); });
    return () => { current = false; };
  }, [trendTrait, trendRangeDays, overview?.hasSessions]);

  if (loading) {
    return (
      <div className="flex flex-col gap-6" role="status" aria-busy="true" aria-label="Loading your stats">
        <div>
          <h1 className="text-[30px] font-800 tracking-tight" style={{ fontWeight: 800 }}>Your coaching profile</h1>
          <Skeleton className="mt-3 h-[14px] w-64" />
        </div>
        <SkeletonStats count={4} />
        <SkeletonCard><SkeletonChart height={220} /></SkeletonCard>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <SkeletonCard /><SkeletonCard />
        </div>
      </div>
    );
  }

  if (error) return <p className="text-[14px] text-red-300">{error}</p>;

  if (!overview || !overview.hasSessions) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-6 py-28 text-center">
        <h1 className="max-w-lg text-[26px] font-800 tracking-tight leading-snug" style={{ fontWeight: 800 }}>
          Begin your first session to begin growing towards your call back.
        </h1>
        <button
          onClick={onStart}
          className="flex items-center gap-2 bg-white text-black text-[13px] font-semibold px-5 h-11 rounded-none transition-opacity active:opacity-70"
        >
          <Plus className="h-4 w-4" strokeWidth={2} /> Start your first session
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[30px] font-800 tracking-tight" style={{ fontWeight: 800 }}>Your coaching profile</h1>
          <p className="mt-1 text-[14px] text-white/45" style={{ fontWeight: 300 }}>
            All-time patterns across {overview.totalSessions} session{overview.totalSessions === 1 ? "" : "s"}.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={onStart}
            className="flex items-center gap-2 bg-white text-black text-[13px] font-semibold px-5 h-11 rounded-none transition-opacity active:opacity-70"
          >
            <Plus className="h-4 w-4" strokeWidth={2} /> Start new session
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-white/12 border border-white/12">
        {[
          { label: "Sessions", value: String(overview.totalSessions) },
          { label: "Practice time", value: formatDuration(overview.totalPracticeSeconds) },
          { label: "Best score", value: overview.bestSession ? `${overview.bestSession.score10}/10` : "—" },
          { label: "Streak", value: `${overview.streakWeeks} wk${overview.streakWeeks === 1 ? "" : "s"}` },
        ].map((s) => (
          <div key={s.label} className="bg-black p-4 flex flex-col gap-2">
            <span className="text-[11px] uppercase tracking-[0.14em] text-white/35">{s.label}</span>
            <span className="text-[26px] font-800 leading-none" style={{ fontWeight: 800 }}>{s.value}</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SectionCard title="Best session ever">
          {overview.bestSession ? (
            <button
              onClick={() => onOpenSession(overview.bestSession!.sessionId)}
              className="flex w-full items-center gap-4 text-left transition-opacity hover:opacity-80"
            >
              <Award className="h-8 w-8 text-white/70 shrink-0" strokeWidth={1.4} />
              <div className="flex flex-col min-w-0">
                <span className="text-[22px] font-800" style={{ fontWeight: 800 }}>{overview.bestSession.score10}/10</span>
                <span className="text-[13px] text-white/45">{formatDate(overview.bestSession.startedAt)}</span>
              </div>
              <ChevronRight className="h-4 w-4 text-white/40 shrink-0 ml-auto" />
            </button>
          ) : (
            <p className="text-[13px] text-white/40">Not enough scored sessions yet.</p>
          )}
        </SectionCard>
        <SectionCard title="Most-improved metric">
          {overview.mostImproved ? (
            <div className="flex items-center gap-4">
              <TrendingUp className="h-8 w-8 text-white/70" strokeWidth={1.4} />
              <div className="flex flex-col">
                <span className="text-[16px] font-medium">{overview.mostImproved.label}</span>
                <span className="text-[13px] text-white/45">Improved {Math.abs(overview.mostImproved.improvement)}% since your first sessions</span>
              </div>
            </div>
          ) : (
            <p className="text-[13px] text-white/40">Not enough history yet to tell.</p>
          )}
        </SectionCard>
      </div>

      {Object.keys(overview.traitAverages).length > 0 && (
        <SectionCard title="Your trait profile — all-time">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Object.entries(overview.traitAverages).map(([key, t]) => {
              const open = expandedTrait === key;
              // Only the last session's three biggest movers carry an arrow,
              // so the marks always describe one session and never accumulate.
              const moved = (overview.recentMovers ?? []).find((m) => m.key === key);
              return (
                // The card is a div wrapping a button, not a button itself:
                // the expanded state carries its own "Practice this" action,
                // and a button inside a button is invalid HTML that swallows
                // the inner click in some browsers.
                <div
                  key={key}
                  className={`border p-4 flex flex-col gap-2 transition-colors ${open ? "border-white/40" : "border-white/12 hover:border-white/25"}`}
                >
                <button
                  onClick={() => setExpandedTrait(open ? null : key)}
                  aria-expanded={open}
                  className="flex flex-col gap-2 text-left w-full"
                >
                  <div className="w-full flex items-baseline justify-between gap-2">
                    <span className="text-[13px] font-medium flex items-center gap-1.5 min-w-0">
                      <span className="truncate">{t.label}</span>
                      {moved && (moved.direction === "better"
                        ? <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-green-400" aria-label={`Up ${moved.delta} last session`} />
                        : <ArrowDownRight className="h-3.5 w-3.5 shrink-0 text-red-400" aria-label={`Down ${Math.abs(moved.delta)} last session`} />)}
                    </span>
                    <span className="text-[15px] font-800 tabular-nums" style={{ fontWeight: 800 }}>{t.value}/10</span>
                  </div>
                  <ProgressBar pct={t.value * 10} />
                  {open ? (
                    <span className="flex flex-col gap-2">
                      <span className="text-[12px] text-white/60 leading-relaxed" style={{ fontWeight: 300 }}>{t.description}</span>
                      {moved && (
                        <span
                          className={`text-[12px] leading-relaxed ${moved.direction === "better" ? "text-green-300/80" : "text-red-300/80"}`}
                          style={{ fontWeight: 300 }}
                        >
                          Last session: {moved.sessionValue}/10 vs. your usual {moved.avgValue}/10
                          {" "}({moved.delta > 0 ? "+" : ""}{moved.delta}). {moved.message}
                        </span>
                      )}
                    </span>
                  ) : moved ? (
                    <span className={`text-[11px] ${moved.direction === "better" ? "text-green-300/70" : "text-red-300/70"}`}>
                      {moved.direction === "better" ? "Up" : "Down"} {Math.abs(moved.delta)} last session
                    </span>
                  ) : (
                    <span className="text-[11px] text-white/30">{t.sampleCount} session{t.sampleCount === 1 ? "" : "s"} tracked</span>
                  )}
                </button>
                {open && (
                  <button
                    onClick={() => onPracticeWeakness(t.label)}
                    className="mt-1 self-start flex items-center gap-1.5 border border-white/25 text-white text-[12px] font-semibold px-3 h-8 rounded-none transition-colors hover:border-white/60"
                  >
                    <Target className="h-3.5 w-3.5" strokeWidth={1.8} /> Practice this
                  </button>
                )}
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-[11px] text-white/25 leading-relaxed">
            Click any trait to see what it measures. These are averaged across your whole history — a single session's
            results can look different if it broke from your usual pattern. Arrows mark the three traits that moved
            furthest in your most recent session, against their own average; they reset every time you finish a session.
          </p>
        </SectionCard>
      )}


      {overview.targeting.length > 0 && (
        <SectionCard title="Did targeting actually work?">
          <ul className="flex flex-col divide-y divide-white/10">
            {overview.targeting.map((t) => (
              <li key={t.weakness} className="flex flex-col gap-1 py-4 first:pt-0 last:pb-0">
                <span className="text-[14px] font-medium">{t.weakness}</span>
                {t.trackable && !t.insufficientData && t.avgBefore !== undefined ? (
                  <span className="text-[13px] text-white/60">
                    {t.signalLabel}: <span className="tabular-nums">{t.avgBefore}</span> before →{" "}
                    <span className="tabular-nums">{t.avgSince}</span> since targeting it
                    {t.improved != null && (
                      <span className={t.improved ? "text-white ml-2" : "text-white/50 ml-2"}>
                        {t.improved ? "· improved" : "· not yet improved"}
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="text-[13px] text-white/40">
                    Targeted {t.timesTargeted} session{t.timesTargeted === 1 ? "" : "s"} — not enough tracked signal to show a before/after yet.
                  </span>
                )}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <SectionCard
        title="Recent sessions"
        right={
          <button onClick={onViewSessions} className="text-[12px] text-white/50 hover:text-white/90 transition-colors flex items-center gap-1">
            View all <ChevronRight className="h-3.5 w-3.5" />
          </button>
        }
      >
        <RecentSessionsList />
      </SectionCard>
    </>
  );
};

// ── Sessions list ─────────────────────────────────────────────────
const SessionsView: FC<{ onOpen: (sessionId: string) => void }> = ({ onOpen }) => {
  const [records, setRecords] = useState<SessionRecord[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let current = true;
    listSessions({ limit: 100 }) // backend caps limit at 100 (see pagination() in documents.js)
      .then((res) => { if (current) setRecords(res.records.filter((r) => r.ended_at)); })
      .catch((err) => { if (current) setError(err instanceof Error ? err.message : "Couldn't load sessions."); });
    return () => { current = false; };
  }, []);

  return (
    <>
      <div>
        <h1 className="text-[30px] font-800 tracking-tight" style={{ fontWeight: 800 }}>Sessions</h1>
        <p className="mt-1 text-[14px] text-white/45" style={{ fontWeight: 300 }}>
          Every session you've run. Open one to see its full results.
        </p>
      </div>

      {error ? (
        <p className="text-[14px] text-red-300">{error}</p>
      ) : records === null ? (
        <div role="status" aria-busy="true" aria-label="Loading sessions"><SkeletonRows rows={6} cols={4} /></div>
      ) : records.length === 0 ? (
        <p className="text-[14px] text-white/40">No sessions yet.</p>
      ) : (
        <div className="border border-white/12">
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-6 px-5 py-3 text-[11px] uppercase tracking-[0.12em] text-white/30 border-b border-white/10">
            <span>Session</span>
            <span>Targeted</span>
            <span className="text-right">Score</span>
            <span></span>
          </div>
          {records.map((s) => (
            <button
              key={s.session_id}
              onClick={() => onOpen(s.session_id)}
              className="w-full grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-6 px-5 py-4 border-b border-white/10 last:border-b-0 text-left transition-colors hover:bg-white/[0.03]"
            >
              <div className="flex flex-col min-w-0">
                <span className="text-[14px]">{formatDate(s.started_at)}</span>
                <span className="text-[12px] text-white/40 truncate">
                  {s.targeted_weakness ? `Targeted · ${s.targeted_weakness}` : "General practice"}
                </span>
              </div>
              <span className="text-[13px] text-white/60">{s.targeted_weakness || "—"}</span>
              <span className="text-[16px] font-800 tabular-nums text-right" style={{ fontWeight: 800 }}>
                {s.overall_score != null ? `${Math.round(s.overall_score / 10)}/10` : "—"}
              </span>
              <ChevronRight className="h-4 w-4 text-white/30" />
            </button>
          ))}
        </div>
      )}
    </>
  );
};

// ── Trends ────────────────────────────────────────────────────────
// ── Trends (one trait, full page) ─────────────────────────────────────────
// Deliberately a single chart on its own page rather than a grid of small
// ones: every trait shares the same 0-10 scale, so one large plot the reader
// switches between beats four cramped ones they have to squint at.
const PLOT = { w: 1000, h: 420, left: 46, right: 22, top: 20, bottom: 40 };

const TraitChart: FC<{
  points: TraitTrendPoint[];
  onOpenSession: (sessionId: string) => void;
}> = ({ points, onOpenSession }) => {
  const [hover, setHover] = useState<number | null>(null);
  const innerW = PLOT.w - PLOT.left - PLOT.right;
  const innerH = PLOT.h - PLOT.top - PLOT.bottom;

  // Fixed 0-10 domain. Auto-scaling to the data would make a trait that only
  // ever moves between 8.8 and 9.2 look like a rollercoaster, and would stop
  // two traits being comparable at a glance.
  const x = (i: number) => (points.length === 1 ? PLOT.left + innerW / 2 : PLOT.left + (i / (points.length - 1)) * innerW);
  const y = (v: number) => PLOT.top + innerH - (Math.max(0, Math.min(10, v)) / 10) * innerH;

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = points.length > 1
    ? `${line} L${x(points.length - 1).toFixed(1)},${PLOT.top + innerH} L${x(0).toFixed(1)},${PLOT.top + innerH} Z`
    : "";

  const pick = (event: React.MouseEvent<SVGRectElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const svgX = PLOT.left + ratio * innerW;
    let nearest = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(x(i) - svgX) < Math.abs(x(nearest) - svgX)) nearest = i;
    }
    setHover(nearest);
  };

  const active = hover != null ? points[hover] : null;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${PLOT.w} ${PLOT.h}`} className="block w-full h-auto" role="img"
        aria-label={`Trait score across ${points.length} sessions, scored out of 10`}>
        {/* Recessive grid — present for reading values, never competing with the data. */}
        {[0, 2, 4, 6, 8, 10].map((tick) => (
          <g key={tick}>
            <line x1={PLOT.left} x2={PLOT.w - PLOT.right} y1={y(tick)} y2={y(tick)} stroke="#ffffff" strokeOpacity="0.08" strokeWidth="1" />
            <text x={PLOT.left - 12} y={y(tick) + 4} textAnchor="end" className="fill-white/35" style={{ fontSize: 13 }}>{tick}</text>
          </g>
        ))}

        {points.length > 1 && <path d={area} fill="#ffffff" fillOpacity="0.06" />}
        <path d={line} fill="none" stroke="#ffffff" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

        {/* Crosshair: the reader aims at a session, not at a 2px line. */}
        {active && (
          <line x1={x(hover!)} x2={x(hover!)} y1={PLOT.top} y2={PLOT.top + innerH}
            stroke="#ffffff" strokeOpacity="0.3" strokeWidth="1" />
        )}

        {points.map((p, i) => (
          <circle key={p.sessionId} cx={x(i)} cy={y(p.value)} r={hover === i ? 7 : 4.5}
            fill={hover === i ? "#ffffff" : "#000000"} stroke="#ffffff" strokeWidth="2" />
        ))}

        {/* Selective direct labels so the endpoints are readable without hovering. */}
        {points.length > 1 && [0, points.length - 1].map((i) => (
          <text key={`label-${i}`} x={x(i)} y={y(points[i].value) - 16} textAnchor={i === 0 ? "start" : "end"}
            className="fill-white/70" style={{ fontSize: 14, fontWeight: 700 }}>{points[i].value}</text>
        ))}

        <text x={PLOT.left} y={PLOT.h - 12} className="fill-white/35" style={{ fontSize: 13 }}>{formatDate(points[0].date)}</text>
        {points.length > 1 && (
          <text x={PLOT.w - PLOT.right} y={PLOT.h - 12} textAnchor="end" className="fill-white/35" style={{ fontSize: 13 }}>
            {formatDate(points[points.length - 1].date)}
          </text>
        )}

        <rect x={PLOT.left} y={PLOT.top} width={innerW} height={innerH} fill="transparent"
          onMouseMove={pick} onMouseLeave={() => setHover(null)}
          onClick={() => active && onOpenSession(active.sessionId)}
          style={{ cursor: active ? "pointer" : "default" }} />
      </svg>

      {active && (() => {
        // Scores cluster high, so a tooltip anchored above the point sits on
        // top of the card title most of the time. Flip it below the point
        // whenever the point is in the top quarter of the plot.
        const below = y(active.value) < PLOT.top + innerH * 0.25;
        return (
        <div
          className={`pointer-events-none absolute -translate-x-1/2 border border-white/25 bg-black px-3 py-2 whitespace-nowrap ${below ? "" : "-translate-y-full"}`}
          style={{
            left: `${(x(hover!) / PLOT.w) * 100}%`,
            top: `${(y(active.value) / PLOT.h) * 100}%`,
            marginTop: below ? 14 : -14,
          }}
        >
          {/* Value leads, label follows -- the reader already knows the trait. */}
          <div className="flex items-baseline gap-1">
            <span className="text-[18px] font-800 leading-none" style={{ fontWeight: 800 }}>{active.value}</span>
            <span className="text-[12px] text-white/40">/10</span>
          </div>
          <div className="mt-1 text-[12px] text-white/50">{formatDate(active.date)}</div>
          <div className="text-[11px] text-white/30">Session {hover! + 1} of {points.length} · click to open</div>
        </div>
        );
      })()}
    </div>
  );
};

const TrendsView: FC<{ onOpenSession: (sessionId: string) => void }> = ({ onOpenSession }) => {
  const [traits, setTraits] = useState<TraitDescriptor[]>([]);
  const [traitKey, setTraitKey] = useState("");
  const [rangeDays, setRangeDays] = useState(3650);
  const [trend, setTrend] = useState<TraitTrend | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let current = true;
    listTraits()
      .then((list) => { if (current) { setTraits(list); setTraitKey((prev) => prev || list[0]?.key || ""); } })
      .catch(() => { if (current) setError("Couldn't load the trait list."); });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    if (!traitKey) return;
    let current = true;
    setLoading(true);
    setError("");
    getTraitTrend(traitKey, { sinceDays: rangeDays })
      .then((t) => { if (current) setTrend(t); })
      .catch((err) => { if (current) setError(err instanceof Error ? err.message : "Couldn't load this trend."); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [traitKey, rangeDays]);

  const points = trend?.points ?? [];
  const delta = points.length > 1 ? Math.round((points[points.length - 1].value - points[0].value) * 10) / 10 : null;

  return (
    <>
      <div>
        <h1 className="text-[30px] font-800 tracking-tight" style={{ fontWeight: 800 }}>Trends</h1>
        <p className="mt-1 text-[14px] text-white/45" style={{ fontWeight: 300 }}>
          One trait at a time, scored out of 10, with a point for every session you've run.
        </p>
      </div>

      {/* Filters in a single row above the chart, range first. */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={traitKey}
          onChange={(e) => setTraitKey(e.target.value)}
          className="border border-white/20 bg-black px-3 py-2.5 text-[14px] text-white outline-none focus:border-white/60 min-w-[220px]"
        >
          {traits.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <div className="flex items-center gap-1">
          {[{ label: "30d", days: 30 }, { label: "90d", days: 90 }, { label: "1y", days: 365 }, { label: "All", days: 3650 }].map((r) => (
            <button
              key={r.label}
              onClick={() => setRangeDays(r.days)}
              className={`px-3 h-9 text-[12px] border transition-colors ${rangeDays === r.days ? "bg-white text-black border-white" : "border-white/20 text-white/60 hover:border-white/50"}`}
            >
              {r.label}
            </button>
          ))}
        </div>
        {delta != null && (
          <span className="text-[13px] text-white/45 ml-auto tabular-nums">
            {points[0].value} → {points[points.length - 1].value}
            <span className="text-white/30"> ({delta >= 0 ? "+" : ""}{delta})</span>
          </span>
        )}
      </div>

      {error && <p className="text-[13px] text-red-300">{error}</p>}

      <SectionCard title={trend?.label || "Trait"}>
        {/* Refetch holds the previous render rather than flashing a skeleton. */}
        <div className={loading ? "opacity-40 transition-opacity" : "transition-opacity"}>
          {points.length === 0 ? (
            <p className="text-[13px] text-white/40 py-16 text-center">
              {loading ? "" : "No sessions in this range have recorded this trait yet."}
            </p>
          ) : (
            <TraitChart points={points} onOpenSession={onOpenSession} />
          )}
        </div>
        {trend?.description && <p className="mt-4 text-[13px] text-white/50">{trend.description}</p>}
      </SectionCard>

      {points.length > 0 && (
        <SectionCard title={`Every session (${points.length})`}>
          {/* The table is what makes each value reachable without hovering. */}
          <div className="max-h-80 overflow-y-auto">
            {[...points].reverse().map((p, i) => (
              <button
                key={p.sessionId}
                onClick={() => onOpenSession(p.sessionId)}
                className="w-full flex items-center justify-between gap-4 py-2.5 border-b border-white/10 last:border-b-0 text-left transition-colors hover:bg-white/[0.03]"
              >
                <span className="text-[13px] text-white/50">{formatDate(p.date)}</span>
                <span className="flex items-center gap-3 shrink-0">
                  <span className="w-24"><ProgressBar pct={p.value * 10} /></span>
                  <span className="text-[13px] tabular-nums w-9 text-right">{p.value}</span>
                  <ChevronRight className="h-3.5 w-3.5 text-white/30" />
                </span>
                <span className="sr-only">Session {points.length - i}</span>
              </button>
            ))}
          </div>
        </SectionCard>
      )}
    </>
  );
};

function fmt(n: number | null | undefined, digits = 0): string | null {
  return n == null || Number.isNaN(n) ? null : n.toFixed(digits);
}

// Headline vitals before calibration has ever run. Deliberately blank rather
// than the plausible-looking numbers this used to seed ("68 bpm", "42 · Low")
// -- an uncalibrated user was being shown vitals nobody measured, which is
// exactly what the rest of the app refuses to do.
const seedHeadline: { label: string; value: string; unit: string }[] = [
  { label: "Resting pulse", value: "—", unit: "bpm" },
  { label: "Breathing rate", value: "—", unit: "/min" },
  { label: "Blink rate", value: "—", unit: "/min" },
  { label: "Stress (Baevsky)", value: "—", unit: "" },
];

const CalibrationView: FC<{ onRecalibrate: () => void }> = ({ onRecalibrate }) => {
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true;
    getBaseline().then(value => { if (current) setBaseline(value); })
      .catch(error => { if (current) setLoadError(error.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, []);
  if (!baseline) return <div className="p-8 text-white/60"><p role={loadError ? 'alert' : 'status'}>{loading ? 'Loading baseline…' : loadError || 'No saved calibration yet.'}</p><button className="mt-6 border p-3" onClick={onRecalibrate}>Calibrate</button></div>;

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
          heading: "Motion & stress",
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
          heading: "Motion & stress",
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
  const auth = useAuth();
  const [resumes, setResumes] = useState<StoredResume[]>([]);
  const [resumesLoading, setResumesLoading] = useState(remoteStorageEnabled);
  const [resumesError, setResumesError] = useState("");
  const [uploading, setUploading] = useState(false);
  // Fallback when there's no backend yet: the single resume captured during
  // calibration (baselineStore's local-only InterviewProfile), read-only.
  const [localResume, setLocalResume] = useState<{ name: string; size: number } | null>(null);
  const [position, setPosition] = useState("Software Engineer");
  const fileInputRef = useRef<HTMLInputElement>(null);

  function loadResumes() {
    setResumesLoading(true);
    setResumesError("");
    listResumes()
      .then(setResumes)
      .catch((err) => setResumesError(err instanceof Error ? err.message : "Couldn't load resumes."))
      .finally(() => setResumesLoading(false));
  }

  useEffect(() => {
    if (remoteStorageEnabled) {
      loadResumes();
      return;
    }
    let current = true;
    getInterviewProfile().then((profile) => {
      if (current) setLocalResume(profile?.resume ?? null);
    });
    return () => {
      current = false;
    };
  }, []);

  async function handleUpload(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setResumesError("");
    try {
      await uploadResume(file);
      loadResumes();
    } catch (err) {
      setResumesError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleRemove(documentId: string) {
    setResumesError("");
    try {
      await deleteResume(documentId);
      setResumes((rs) => rs.filter((r) => r.document_id !== documentId));
    } catch (err) {
      setResumesError(err instanceof Error ? err.message : "Couldn't remove resume.");
    }
  }

  const resumeSize = (bytes: number) =>
    bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

  const displayName = auth.user?.displayName || "Your account";
  const initials = (auth.user?.displayName || auth.user?.email || "?")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

  return (
    <>
      <div>
        <h1 className="text-[30px] font-800 tracking-tight" style={{ fontWeight: 800 }}>Account & Documents</h1>
        <p className="mt-1 text-[14px] text-white/45" style={{ fontWeight: 300 }}>
          Manage your profile, resumes, and interview target.
        </p>
      </div>

      {/* Account */}
      <SectionCard title="Account">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 border border-white/20 flex items-center justify-center text-[13px] font-semibold">{initials}</div>
            <div className="flex flex-col">
              <span className="text-[15px]">{displayName}</span>
              <span className="flex items-center gap-1.5 text-[13px] text-white/45">
                <Mail className="h-3.5 w-3.5" /> {auth.user?.email || "No email on file"}
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
          remoteStorageEnabled ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf,.pdf"
                className="sr-only"
                onChange={(e) => handleUpload(e.target.files?.[0])}
              />
              <button
                type="button"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 border border-white/20 text-[12px] px-3 h-8 rounded-none transition-colors hover:border-white/50 disabled:opacity-40"
              >
                <Upload className="h-3.5 w-3.5" /> {uploading ? "Uploading…" : "Upload"}
              </button>
            </>
          ) : undefined
        }
      >
        {resumesError && <p className="text-[13px] text-red-300 mb-2">{resumesError}</p>}
        <div className="flex flex-col divide-y divide-white/10">
          {remoteStorageEnabled ? (
            resumesLoading ? (
              <p className="text-[13px] text-white/40 py-3">Loading resumes…</p>
            ) : resumes.length === 0 ? (
              <p className="text-[13px] text-white/40 py-3">No resumes uploaded yet.</p>
            ) : (
              resumes.map((r) => (
                <div key={r.document_id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
                  <div className="flex items-center gap-3 min-w-0">
                    <FileText className="h-4 w-4 text-white/50 shrink-0" strokeWidth={1.6} />
                    <span className="text-[14px] truncate">{r.filename}</span>
                    <span className="text-[12px] text-white/35 shrink-0">{resumeSize(r.file_size_bytes)}</span>
                  </div>
                  <button
                    onClick={() => handleRemove(r.document_id)}
                    aria-label="Remove resume"
                    className="text-white/40 transition-colors hover:text-white"
                  >
                    <X className="h-4 w-4" strokeWidth={1.8} />
                  </button>
                </div>
              ))
            )
          ) : localResume ? (
            <div className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
              <div className="flex items-center gap-3 min-w-0">
                <FileText className="h-4 w-4 text-white/50 shrink-0" strokeWidth={1.6} />
                <span className="text-[14px] truncate">{localResume.name}</span>
                <span className="text-[12px] text-white/35 shrink-0">{resumeSize(localResume.size)}</span>
              </div>
              <span className="text-[12px] text-white/30">From calibration</span>
            </div>
          ) : (
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

// ── Results (single session — the post-session analysis dashboard) ───────
const ResultsView: FC<{
  sessionId: string | null;
  onViewSessions: () => void;
  onPracticeWeakness: (weakness: string) => void;
}> = ({ sessionId, onViewSessions, onPracticeWeakness }) => {
  const [resolvedId, setResolvedId] = useState<string | null>(sessionId);
  const [dashboard, setDashboard] = useState<SessionDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [noSessions, setNoSessions] = useState(false);

  // Transcript panel — collapsed by default (a full transcript can be a lot
  // of text), lazy-fetched the first time it's expanded rather than bundled
  // into the main dashboard payload.
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptTurn[] | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState("");

  // When no specific session was picked (came from the nav, not a Sessions
  // row click), fall back to the most recent one.
  useEffect(() => {
    let current = true;
    if (sessionId) { setResolvedId(sessionId); return; }
    listSessions({ limit: 1 })
      .then((res) => {
        if (!current) return;
        const latest = res.records.find((r) => r.ended_at);
        if (latest) setResolvedId(latest.session_id);
        else { setNoSessions(true); setLoading(false); }
      })
      .catch((err) => { if (current) { setError(err instanceof Error ? err.message : "Couldn't load sessions."); setLoading(false); } });
    return () => { current = false; };
  }, [sessionId]);

  useEffect(() => {
    if (!resolvedId) return;
    let current = true;
    let timeoutId: number | undefined;

    const fetchDashboard = () => {
      getSessionDashboard(resolvedId)
        .then((data) => {
          if (!current) return;
          setDashboard(data);
          // If the AI analysis is still processing (both null), poll every 3 seconds.
          if (!data.atAGlance.aiSummary && !data.atAGlance.aiError) {
            timeoutId = window.setTimeout(fetchDashboard, 3000);
          } else {
            setLoading(false);
          }
        })
        .catch((err) => {
          if (current) setError(err instanceof Error ? err.message : "Couldn't load this session's results.");
          setLoading(false);
        });
    };

    setLoading(true);
    setError("");
    fetchDashboard();

    return () => {
      current = false;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [resolvedId]);

  // Reset the transcript panel whenever the viewed session changes.
  useEffect(() => {
    setTranscriptOpen(false);
    setTranscript(null);
    setTranscriptError("");
  }, [resolvedId]);

  const toggleTranscript = () => {
    if (!resolvedId) return;
    if (transcriptOpen) { setTranscriptOpen(false); return; }
    setTranscriptOpen(true);
    if (transcript || transcriptLoading) return;
    setTranscriptLoading(true);
    setTranscriptError("");
    getSessionTranscript(resolvedId)
      .then((res) => setTranscript(res.transcript))
      .catch((err) => setTranscriptError(err instanceof Error ? err.message : "Couldn't load the transcript."))
      .finally(() => setTranscriptLoading(false));
  };

  if (noSessions) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-6 py-28 text-center">
        <h1 className="max-w-lg text-[26px] font-800 tracking-tight leading-snug" style={{ fontWeight: 800 }}>
          Run a session to see your first results dashboard here.
        </h1>
      </div>
    );
  }
  if (loading || !dashboard) {
    if (error) return <p className="text-[14px] text-red-300" role="alert">{error}</p>;
    return (
      <div className="flex flex-col gap-6" role="status" aria-busy="true" aria-label="Loading results">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-[30px] w-80" />
          <Skeleton className="h-[14px] w-52" />
        </div>
        <SkeletonStats count={3} />
        <SkeletonCard><SkeletonText lines={4} /></SkeletonCard>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <SkeletonCard /><SkeletonCard />
        </div>
        <SkeletonCard>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="border border-white/12 p-4 flex flex-col gap-3">
                <Skeleton delayMs={i * 90} className="h-[11px] w-20" />
                <Skeleton delayMs={i * 90 + 40} className="h-[24px] w-14" />
                <SkeletonText lines={2} />
              </div>
            ))}
          </div>
        </SkeletonCard>
      </div>
    );
  }
  if (error) return <p className="text-[14px] text-red-300">{error}</p>;

  const { session, atAGlance, weaknesses, strengths, skillDevelopment } = dashboard;

  return (
    <>
      {/* Top: composite score, position applied for, time of the conversation. */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-white/50 border border-white/15 px-2 py-0.5 mb-3">
            <span className="h-1.5 w-1.5 bg-white" /> {sessionId ? "Session" : "Most recent session"}
          </span>
          <h1 className="text-[30px] font-800 tracking-tight" style={{ fontWeight: 800 }}>
            {atAGlance.title}
          </h1>
          <p className="mt-1 text-[14px] text-white/45" style={{ fontWeight: 300 }}>
            {atAGlance.title !== atAGlance.position ? `${atAGlance.position} · ` : ""}
            {formatDate(session.started_at)}
            {session.duration_seconds != null ? ` · ${formatDuration(session.duration_seconds)}` : ""}
            {session.targeted_weakness ? ` · Targeted: ${session.targeted_weakness}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <div className="hidden sm:flex items-baseline gap-2 border border-white/12 px-5 py-3">
            <span className="text-[32px] font-800 leading-none" style={{ fontWeight: 800 }}>
              {atAGlance.compositeScore10 != null ? atAGlance.compositeScore10 : "—"}
            </span>
            <span className="text-[14px] text-white/40">/10</span>
            {atAGlance.scoreTrend && (
              atAGlance.scoreTrend === "up"
                ? <ArrowUpRight className="h-4 w-4 text-white/60" />
                : <ArrowDownRight className="h-4 w-4 text-white/60" />
            )}
          </div>
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

      {atAGlance.aiSummary && (
        <div className="border border-white/12 px-5 py-4 text-[15px] text-white/80" style={{ fontWeight: 300 }}>
          {(() => {
            try {
              const parsed = JSON.parse(atAGlance.aiSummary);
              if (Array.isArray(parsed)) {
                return (
                  <div className="space-y-4">
                    <span className="text-white/45 text-[13px] uppercase tracking-[0.1em] mb-2 block">Per-Question Breakdown</span>
                    {parsed.map((q, idx) => (
                      <div key={idx} className="bg-white/5 p-4 rounded">
                        <p className="font-semibold text-[15px] mb-2">{q.question} <span className="text-white/60 font-normal ml-2">Rating: {q.rating}/10</span></p>
                        <p className="text-red-400 text-sm mb-2"><span className="font-bold">Critique:</span> {q.critique}</p>
                        <div className="text-green-400 text-sm border-l-2 border-green-400/50 pl-3">
                          <p><span className="font-bold">Fix (Action):</span> {q.fix?.action}</p>
                          <p><span className="font-bold">Fix (Result):</span> {q.fix?.result}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              }
              return atAGlance.aiSummary;
            } catch (e) {
              return atAGlance.aiSummary;
            }
          })()}
        </div>
      )}
      {atAGlance.aiError && !atAGlance.aiSummary && (
        <div className="border border-white/12 px-5 py-4 text-[13px] text-white/50">
          The written summary couldn't be generated for this session
          {/^\{|\b(429|503|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand)\b/i.test(atAGlance.aiError)
            ? " — the AI service was temporarily overloaded or out of quota."
            : `: ${atAGlance.aiError}`}{" "}
          Everything below is measured from your own session data and is unaffected.
        </div>
      )}

      {/* Full transcript — collapsed by default, a lot of text when open. */}
      <div className="border border-white/12">
        <button
          onClick={toggleTranscript}
          className="flex w-full items-center justify-between px-5 py-3.5 text-left transition-colors hover:bg-white/[0.03]"
        >
          <span className="text-[13px] text-white/60">
            {transcriptOpen ? "Hide" : "View"} the full transcript from this session
          </span>
          {transcriptOpen
            ? <ChevronDown className="h-4 w-4 text-white/40 shrink-0" />
            : <ChevronRight className="h-4 w-4 text-white/40 shrink-0" />}
        </button>
        {transcriptOpen && (
          <div className="max-h-96 overflow-y-auto border-t border-white/12 px-5 py-4">
            {transcriptLoading && (
              <div className="flex flex-col gap-4" role="status" aria-busy="true" aria-label="Loading transcript">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className={i % 2 ? "pl-8" : ""}>
                    <Skeleton delayMs={i * 110} className="h-[11px] w-24 mb-2" />
                    <SkeletonText lines={i % 2 ? 2 : 3} />
                  </div>
                ))}
              </div>
            )}
            {transcriptError && <p className="text-[13px] text-red-300">{transcriptError}</p>}
            {!transcriptLoading && !transcriptError && (!transcript || transcript.length === 0) && (
              <p className="text-[13px] text-white/40">No transcript was saved for this session.</p>
            )}
            {!transcriptLoading && transcript && transcript.length > 0 && (
              <div className="flex flex-col gap-4">
                {transcript.map((turn, i) => (
                  <div key={i} className="flex flex-col gap-1">
                    <span className="text-[11px] uppercase tracking-[0.14em] text-white/35">
                      {turn.role === "user" ? "You" : "Recruiter"}
                    </span>
                    <p className="text-[14px] text-white/75 leading-relaxed" style={{ fontWeight: 300 }}>
                      {turn.parts.map((p) => p.text).join("")}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Purely session-based: what to work on / what went well right now. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <SectionCard title="What to work on — practice this next" className="lg:col-span-2">
          {weaknesses.length === 0 ? (
            <p className="text-[13px] text-white/40">No standout weaknesses detected in this session — nice work.</p>
          ) : (
            <ol className="flex flex-col divide-y divide-white/10">
              {weaknesses.map((w, i) => (
                <li key={i} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
                  <div className="flex gap-4">
                    <span className="text-[14px] font-800 text-white/30 w-5 shrink-0" style={{ fontWeight: 800 }}>
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <div className="flex flex-col gap-1 flex-1 min-w-0">
                      <span className="text-[15px] font-medium">{w.title}</span>
                      {w.detail && w.detail !== w.title && (
                        <span className="text-[13px] text-white/50 leading-relaxed" style={{ fontWeight: 300 }}>
                          <HighlightedDetail text={w.detail} />
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => onPracticeWeakness(w.title)}
                      className="flex items-center gap-1.5 shrink-0 self-start border border-white/25 text-white text-[12px] font-semibold px-3 h-8 rounded-none transition-colors hover:border-white/60"
                    >
                      <Target className="h-3.5 w-3.5" strokeWidth={1.8} /> Practice this
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </SectionCard>

        <SectionCard title="What went well">
          {strengths.length === 0 ? (
            <p className="text-[13px] text-white/40">Nothing stood out as a strength yet — check back after another session.</p>
          ) : (
            <div className="flex flex-col divide-y divide-white/10">
              {strengths.map((s, i) => (
                <div key={i} className="py-4 first:pt-0 last:pb-0 flex flex-col gap-1">
                  <span className="text-[15px] font-medium">{s.title}</span>
                  {s.detail !== s.title && (
                    <span className="text-[13px] text-white/50 leading-relaxed" style={{ fontWeight: 300 }}>
                      <HighlightedDetail text={s.detail} />
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      {/* Overall skill development: how this session compares to your
          personal average, across all universal traits — not just this
          session's own weaknesses above. */}
      <SectionCard title="Skill development — vs. your all-time average">
        {skillDevelopment.length === 0 ? (
          <p className="text-[13px] text-white/40">
            Not enough session history yet to compare this session against your average — check back after a few more sessions.
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {skillDevelopment.map((t) => (
              <div key={t.key} className="border border-white/12 p-4 flex flex-col gap-2">
                <span className="text-[11px] uppercase tracking-[0.14em] text-white/35">{t.label}</span>
                <div className="flex items-baseline gap-2">
                  <span className="text-[24px] font-800 leading-none" style={{ fontWeight: 800 }}>{t.sessionValue}</span>
                  <span className="text-[12px] text-white/40">/10 this session</span>
                  {t.direction === "baseline" ? null : t.direction === "worse"
                    ? <span className="text-red-400 flex items-center text-[13px] ml-2"><ArrowDownRight className="h-4 w-4 mr-0.5" />{t.avgValue ? Math.round(Math.abs((t.sessionValue - t.avgValue) / t.avgValue * 100)) : 0}%</span>
                    : <span className="text-green-400 flex items-center text-[13px] ml-2"><ArrowUpRight className="h-4 w-4 mr-0.5" />{t.avgValue ? Math.round(Math.abs((t.sessionValue - t.avgValue) / t.avgValue * 100)) : 0}%</span>}
                </div>
                <span className="text-[12px] text-white/40">
                  {t.avgValue != null ? `Your usual average: ${t.avgValue}/10` : "First session tracking this"}
                </span>
                <p className="text-[13px] text-white/60 leading-relaxed" style={{ fontWeight: 300 }}>{t.message}</p>
                <button
                  onClick={() => onPracticeWeakness(t.label)}
                  className="mt-1 self-start flex items-center gap-1.5 border border-white/25 text-white text-[12px] font-semibold px-3 h-8 rounded-none transition-colors hover:border-white/60"
                >
                  <Target className="h-3.5 w-3.5" strokeWidth={1.8} /> Practice this
                </button>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* Read path B: the qualitative twin of the numeric deltas above --
          what changed in how you told the same story since last time. */}
      {(atAGlance.progressNotes?.length ?? 0) > 0 && (
        <SectionCard title="Since last time">
          <div className="flex flex-col gap-3">
            {atAGlance.progressNotes.map((n, i) => (
              <div key={i} className="border-l-2 border-white/25 pl-4 py-1">
                <p className="text-[14px] text-white/75 leading-relaxed" style={{ fontWeight: 300 }}>{n.note}</p>
                {n.questionIndex != null && (
                  <span className="text-[11px] uppercase tracking-[0.14em] text-white/30">
                    Question {n.questionIndex + 1}
                  </span>
                )}
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {dashboard.traits.length > 0 && (
        <SectionCard title={`All traits measured this session (${dashboard.traits.length})`}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3">
            {/* No movement arrows here: this list is one session's absolute
                scores. Direction-of-travel lives on the Dashboard's trait
                profile, where there is a history to move against. */}
            {[...dashboard.traits].sort((a, b) => a.value - b.value).map((t) => {
              return (
                <div key={t.key} className="flex items-center gap-3">
                  <span className="text-[13px] text-white/70 flex-1 min-w-0 truncate">
                    {t.label}
                  </span>
                  <div className="w-20 shrink-0"><ProgressBar pct={t.value * 10} /></div>
                  <span
                    className={`text-[13px] tabular-nums w-9 text-right shrink-0 ${t.value <= 4 ? "text-white" : "text-white/45"}`}
                    style={t.value <= 4 ? { fontWeight: 800 } : undefined}
                  >
                    {t.value}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-[11px] text-white/25 leading-relaxed">
            Weakest first. Anything at or below 4/10 is highlighted and feeds the list above.
          </p>
        </SectionCard>
      )}

      <p className="text-[11px] text-white/25 leading-relaxed">
        Indicators are heuristic estimates for coaching, not a clinical or certified measurement. Traits and scores are
        powered by your own recorded sessions — a signal with no recorded data simply isn't shown.
      </p>
    </>
  );
};

export default Dashboard;
