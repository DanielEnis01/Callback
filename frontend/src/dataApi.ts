import { getFirebaseAuth } from './firebase';

const base = (import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
// Render's free tier spins a web service down after ~15 minutes idle and
// cold-starts it on the next request -- which can take 30-60+ seconds
// (Node boot, DB pool connect, Firebase admin init). A tight timeout here
// means the FIRST request after any idle period reliably aborts before the
// backend ever gets to respond, even though the backend is perfectly
// healthy and the same request succeeds moments later once it's warm --
// exactly the "times out once, then works after you come back" pattern.
// 45s comfortably covers a cold start without leaving a truly-stuck
// request hanging forever.
const API_TIMEOUT_MS = 45000;

export async function apiRequest(path: string, options: RequestInit = {}) {
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new Error('Sign in before saving data.');
  const token = await user.getIdToken();
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(`${base}/api${path}`, { ...options, headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  } catch (err) {
    // AbortSignal.timeout()'s DOMException has a raw, confusing message
    // ("signal timed out") that gives no indication this is very likely a
    // cold-starting backend rather than an actual failure -- surface
    // something a user can act on instead.
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error('The server is taking longer than expected to respond -- it may be waking up from idle. Please try again in a moment.');
    }
    throw err;
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Storage request failed (${response.status}).`);
  }
  return response;
}
export async function dataRequest<T = Record<string, unknown>>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await apiRequest(`/data${path}`, body === undefined ? {} : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return response.json();
}
export async function uploadResume(file: File) {
  return (await apiRequest('/documents/pdfs', {
    method: 'POST', body: file,
    headers: { 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(file.name), 'X-Document-Kind': 'resume' },
  })).json();
}
export interface StoredResume {
  document_id: string;
  filename: string;
  file_size_bytes: number;
  uploaded_at: string;
}
export async function listResumes(): Promise<StoredResume[]> {
  const response = await apiRequest('/documents/pdfs?limit=50');
  const { documents } = (await response.json()) as { documents: Array<StoredResume & { kind: string }> };
  return documents.filter((doc) => doc.kind === 'resume');
}
export interface TranscriptAnalysis {
  staticSignals: {
    answers: Array<{
      index: number;
      wordCount: number;
      star: { situation: boolean; task: boolean; action: boolean; result: boolean };
      starScore: number;
      quantified: boolean;
      fillerWords: Record<string, number>;
      /** 0-10 keyword-overlap relevance vs. the job posting. Null when no posting was given. */
      topicRelevance: number | null;
      /** Immediately-repeated words in this answer ("I I think"). */
      repeatedWords: number;
      /** Sentences that trailed off instead of landing. */
      unfinishedSentences: number;
      /** Audible self-corrections / derailments ("anyway", "where was I"). */
      tangents: number;
      flags: string[];
    }>;
    summary: {
      totalAnswers: number;
      avgStarScore: number;
      quantifiedRate: number;
      totalFillerWords: number;
      fillerWordsPerAnswer: number;
      totalRepeatedWords: number;
      repeatedWordsPerAnswer: number;
      totalUnfinishedSentences: number;
      unfinishedPerAnswer: number;
      totalTangents: number;
      tangentsPerAnswer: number;
      /** Only present when a job posting was provided for the session. */
      avgTopicRelevance?: number;
      flaggedAnswers: number[];
    };
  };
  aiAnalysis: {
    strengths: string[];
    weaknesses: string[];
    summary: Array<{ question: string; rating: number; critique: string; fix: { action: string; result: string } }>;
    overallScore: number;
  } | null;
  aiError: string | null;
  /** True when sessionId was sent and the result was saved to session_ai_analysis. */
  persisted: boolean;
}

/** Row shape returned by GET /data/sessions/:sessionId/ai-analysis (see data.js). Null when nothing has been computed for that session yet. */
export interface StoredTranscriptAnalysis {
  session_id: string;
  computed_at: string;
  static_signals: TranscriptAnalysis['staticSignals'];
  ai_strengths: string[] | null;
  ai_weaknesses: string[] | null;
  ai_summary: Array<{ question: string; rating: number; critique: string; fix: { action: string; result: string } }> | null;
  overall_score: number | null;
  ai_error: string | null;
}

/**
 * Post-session transcript analysis: python/analysis_service.py's static
 * STAR-method/quantification/filler-word checks, then Gemini's qualitative
 * pass over the same transcript grounded in those checks (see
 * backend/src/routes/services.js's POST /analysis/transcript). No fixed
 * timeout via apiRequest() here — a real Gemini call plus the static pass
 * can run longer than apiRequest's 15s budget on a long transcript.
 */
export async function analyzeSessionTranscript(
  transcript: Array<{ role: 'user' | 'model'; parts: [{ text: string }] }>,
  jobPosting?: string,
  targetWeakness?: string,
  sessionId?: string
): Promise<TranscriptAnalysis> {
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new Error('Sign in before analyzing a session.');
  const token = await user.getIdToken();
  const response = await fetch(`${base}/api/services/analysis/transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ transcript, jobPosting, targetWeakness, sessionId }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Analysis request failed (${response.status}).`);
  }
  return response.json();
}

/**
 * Read back a previously-computed AI transcript analysis for one session
 * (see data.js's GET /sessions/:sessionId/ai-analysis) -- powers the
 * "Session summary" view in SavedSessions.tsx. Remote-storage mode only:
 * static/local-mode sessions never get sessionId sent to
 * analyzeSessionTranscript in the first place, so there's nothing to fetch.
 */
export async function getSessionAiAnalysis(sessionId: string): Promise<StoredTranscriptAnalysis | null> {
  return dataRequest<StoredTranscriptAnalysis | null>(`/sessions/${encodeURIComponent(sessionId)}/ai-analysis`);
}

export async function deleteResume(documentId: string): Promise<void> {
  await apiRequest(`/documents/pdfs/${documentId}`, { method: 'DELETE' });
}

// ── Cross-session analytics (Dashboard/Results/Sessions tabs) ────────────
// Thin typed wrappers over /api/analytics -- see backend/src/services/analytics.js
// for what each field actually means and how it's computed. Every number
// here traces back to real recorded session_metrics/session_ai_analysis/
// session_results rows; a signal with no data is simply absent, never 0.
async function analyticsRequest<T = unknown>(path: string): Promise<T> {
  const response = await apiRequest(`/analytics${path}`);
  return response.json();
}

export type SessionType = 'interview' | 'focus';

export interface SignalDescriptor {
  key: string;
  label: string;
  unit: string;
  better: 'lower' | 'higher' | 'closer';
}

export interface SignalPoint {
  startedAt: string;
  value: number;
}

export interface SinceLastDelta {
  deltaPct: number;
  improved: boolean | null;
  latest: number;
  prev: number;
}

export interface SessionSignalChart {
  key: string;
  label: string;
  unit: string;
  better: 'lower' | 'higher' | 'closer';
  baselineFraming: boolean;
  points: SignalPoint[];
  sinceLast: SinceLastDelta | null;
}

export interface RankedWeakness {
  title: string;
  detail: string;
  signalKey: string | null;
  sparkline: number[];
}

export interface SessionStrength {
  title: string;
  detail: string;
}

/** One universal trait's 0-10 score for this specific session. See
 * TRAIT_CATALOG in backend/src/services/analytics.js for how each is
 * normalized from the underlying signals. */
export interface SessionTrait {
  key: string;
  label: string;
  value: number;
}

/** One of the (up to 3) traits that moved furthest from this user's own
 * all-time average for that trait -- the Results tab's "skill development"
 * callouts. Not present for a trait with no prior sessions to compare against. */
export interface SkillDevelopmentEntry {
  key: string;
  label: string;
  sessionValue: number;
  /** Null when this trait was measured for the first time this session. */
  avgValue: number | null;
  delta: number | null;
  direction: 'better' | 'worse' | 'baseline';
  message: string;
}

export interface SessionDashboard {
  session: {
    session_id: string;
    started_at: string;
    ended_at: string | null;
    session_type: SessionType;
    targeted_weakness: string | null;
    job_posting_text: string | null;
    job_posting_id: string | null;
    duration_seconds: number | null;
    jobPosting: { job_posting_id?: string; title?: string; company?: string; text?: string } | null;
  };
  atAGlance: {
    compositeScore10: number | null;
    scoreTrend: 'up' | 'down' | null;
    totalSessions: number;
    /** Derived label for "position applied for" -- a saved job posting's
     * title/company, a snippet of the pasted job text, or a generic label
     * when neither is available. Never fabricated beyond what was given. */
    position: string;
    /** Short AI-written label for the session, falling back to `position`. */
    title: string;
    aiSummary: string | null;
    aiError: string | null;
    /** Qualitative comparisons against earlier sessions, written by the
     * analysis pass from semantic memory of what you said before. Empty
     * until you have history (or while memory is unconfigured). */
    progressNotes: { questionIndex: number | null; priorSessionId: string | null; note: string }[];
  };
  charts: SessionSignalChart[];
  weaknesses: RankedWeakness[];
  strengths: SessionStrength[];
  /** Every universal trait that had data this session -- see TRAIT_CATALOG. */
  traits: SessionTrait[];
  /** Top 3 traits (of `traits`) that moved furthest from this user's own
   * all-time average for that trait, most-changed first. */
  skillDevelopment: SkillDevelopmentEntry[];
}

/** GET /api/analytics/sessions/:sessionId/dashboard -- the Results tab bundle for one session. */
export async function getSessionDashboard(sessionId: string): Promise<SessionDashboard> {
  return analyticsRequest<SessionDashboard>(`/sessions/${encodeURIComponent(sessionId)}/dashboard`);
}

export interface TranscriptTurn {
  role: 'user' | 'model';
  parts: [{ text: string }];
}

/** GET /api/analytics/sessions/:sessionId/transcript -- lazy-loaded full
 * transcript for the Results tab's collapsible transcript panel. `transcript`
 * is null when nothing was ever persisted for this session (analysis never
 * ran, or it predates transcript persistence). */
export async function getSessionTranscript(sessionId: string): Promise<{ transcript: TranscriptTurn[] | null; computedAt: string | null }> {
  return analyticsRequest(`/sessions/${encodeURIComponent(sessionId)}/transcript`);
}

export interface TraitDescriptor {
  key: string;
  label: string;
  description: string;
}

/** GET /api/analytics/traits -- catalog metadata for every universal trait. */
export async function listTraits(): Promise<TraitDescriptor[]> {
  return analyticsRequest<TraitDescriptor[]>('/traits');
}

export interface Goal {
  goal_id: string;
  user_id: string;
  /** The trait this goal tracks (column is named signal_key for history). */
  signal_key: string;
  label: string;
  description: string | null;
  direction: 'above';
  /** Target score out of 10. */
  target_value: number;
  /** Deadline expressed in sessions, null for an open-ended goal. */
  target_sessions: number | null;
  sessionsUsed: number;
  sessionsRemaining: number | null;
  expired: boolean;
  session_type: SessionType | null;
  source: 'user' | 'system';
  created_at: string;
  achieved_at: string | null;
  active: boolean;
  current?: number | null;
  progressPct?: number | null;
  achieved?: boolean;
}

export interface TargetingEffectiveness {
  weakness: string;
  timesTargeted: number;
  firstTargetedAt: string;
  signalKey: string | null;
  trackable: boolean;
  insufficientData?: boolean;
  signalLabel?: string;
  avgBefore?: number;
  avgSince?: number;
  deltaPct?: number;
  improved?: boolean | null;
}

export interface OverviewEmpty {
  hasSessions: false;
}
export interface TraitAverage {
  label: string;
  /** What this trait actually measures -- shown when the tile is expanded. */
  description: string;
  value: number;
  sampleCount: number;
}

export interface OverviewData {
  hasSessions: true;
  totalSessions: number;
  totalPracticeSeconds: number;
  allTimeAverages: Record<string, number>;
  /** All-time average (0-10) for every universal trait that has data --
   * the Dashboard tab's full growth profile, as opposed to Results' 3
   * most-changed-this-session callouts. */
  traitAverages: Record<string, TraitAverage>;
  /** The three traits that moved furthest in the MOST RECENT session, each
   *  against that trait's average over every earlier session. Replaced
   *  wholesale after every session — it answers "what changed last time",
   *  not "what has changed overall". Empty until a second session exists. */
  recentMovers: {
    key: string;
    label: string;
    direction: "better" | "worse";
    delta: number;
    sessionValue: number;
    avgValue: number;
    message: string;
  }[];
  mostImproved: { signalKey: string; label: string; improvement: number; deltaPct: number } | null;
  bestSession: { sessionId: string; score10: number; startedAt: string } | null;
  sessionsPerWeek: number;
  streakWeeks: number;
  goals: Goal[];
  targeting: TargetingEffectiveness[];
}
export type Overview = OverviewEmpty | OverviewData;

/** GET /api/analytics/overview -- the Dashboard tab's all-time bundle. Pass sessionType to filter interview vs. focus. */
export async function getOverview(sessionType?: SessionType): Promise<Overview> {
  return analyticsRequest<Overview>(`/overview${sessionType ? `?sessionType=${sessionType}` : ''}`);
}

export interface SignalTrendPoint {
  date: string;
  value: number;
}
export interface SignalTrend {
  source: 'continuous_aggregate' | 'raw' | 'per_session';
  points: SignalTrendPoint[];
}

export interface TraitTrendPoint {
  /** The session this score came from -- one point per session. */
  sessionId: string;
  date: string;
  value: number;
}

export interface TraitTrend {
  key: string;
  label: string;
  description: string;
  points: TraitTrendPoint[];
}

/** GET /api/analytics/trait-trends/:traitKey -- one trait's 0-10 development over time. */
export async function getTraitTrend(traitKey: string, opts: { sessionType?: SessionType; sinceDays?: number } = {}): Promise<TraitTrend> {
  const params = new URLSearchParams();
  if (opts.sessionType) params.set('sessionType', opts.sessionType);
  if (opts.sinceDays) params.set('sinceDays', String(opts.sinceDays));
  const qs = params.toString();
  return analyticsRequest<TraitTrend>(`/trait-trends/${encodeURIComponent(traitKey)}${qs ? `?${qs}` : ''}`);
}

/** GET /api/analytics/trends/:signalKey -- full-history, zoomable long-range chart data (Dashboard tab). */
export async function getSignalTrend(signalKey: string, opts: { sessionType?: SessionType; sinceDays?: number } = {}): Promise<SignalTrend> {
  const params = new URLSearchParams();
  if (opts.sessionType) params.set('sessionType', opts.sessionType);
  if (opts.sinceDays) params.set('sinceDays', String(opts.sinceDays));
  const qs = params.toString();
  return analyticsRequest<SignalTrend>(`/trends/${encodeURIComponent(signalKey)}${qs ? `?${qs}` : ''}`);
}

/** GET /api/analytics/targeting/:weakness -- "did targeting actually work" before/after. Null if never targeted. */
export async function getTargetingEffectiveness(weakness: string, sessionType?: SessionType): Promise<TargetingEffectiveness | null> {
  return analyticsRequest<TargetingEffectiveness | null>(`/targeting/${encodeURIComponent(weakness)}${sessionType ? `?sessionType=${sessionType}` : ''}`);
}

export async function listGoals(): Promise<Goal[]> {
  return analyticsRequest<Goal[]>('/goals');
}

export async function createGoal(goal: { traitKey: string; targetValue: number; targetSessions?: number; sessionType?: SessionType }): Promise<Goal> {
  const response = await apiRequest('/analytics/goals', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(goal),
  });
  return response.json();
}

export async function deleteGoal(goalId: string): Promise<void> {
  await apiRequest(`/analytics/goals/${encodeURIComponent(goalId)}`, { method: 'DELETE' });
}

export async function listSignals(): Promise<SignalDescriptor[]> {
  return analyticsRequest<SignalDescriptor[]>('/signals');
}

export interface SessionRecord {
  session_id: string;
  job_posting_id: string | null;
  session_type: SessionType;
  targeted_weakness: string | null;
  job_posting_text: string | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  /** From session_results.overall_score (0-100), joined in by the backend's dedicated GET /sessions. Null until computeSessionAnalysis has run for that session. */
  overall_score: number | null;
}

/** GET /api/data/sessions -- the full session history (Sessions tab). */
export async function listSessions(opts: { limit?: number; offset?: number } = {}): Promise<{ records: SessionRecord[]; limit: number; offset: number }> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  const qs = params.toString();
  const response = await apiRequest(`/data/sessions${qs ? `?${qs}` : ''}`);
  return response.json();
}
