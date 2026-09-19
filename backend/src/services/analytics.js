// Cross-session analytics: everything the Dashboard (all-time/overview),
// Results (per-session dashboard), and the "Practice this" targeting loop
// need. Companion to sessionAnalysis.js (per-session biometric comparison,
// stored in session_results) and transcriptAnalysisStore.js (per-session AI
// transcript analysis, stored in session_ai_analysis) -- this module reads
// both plus the raw session_metrics/sessions tables and never invents a
// number: a signal with no recorded samples is simply omitted, exactly like
// the rest of this codebase.
import { HttpError } from '../errors.js';

function round(n, digits = 1) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// Percent change from `from` to `to`, undefined if `from` is 0 (no % base).
function pctChange(from, to) {
  if (from === 0 || from === null || from === undefined || to === null || to === undefined) return null;
  return round(((to - from) / Math.abs(from)) * 100);
}

// ── Signal catalog ───────────────────────────────────────────────────────
// One entry per signal shown anywhere on the dashboards. `better` is the
// direction that counts as improvement ('lower' | 'higher' | 'closer' —
// 'closer' means "closer to your calm baseline is better", used for
// signals whose baseline deviation is the point, like Baevsky stress or
// breathing rate). `source` says where a per-session value for this signal
// comes from:
//   'metrics'      — AVG(column) over that session's session_metrics rows
//   'metrics_avg2' — AVG of two session_metrics columns averaged together
//   'ai_static'    — a field out of session_ai_analysis.static_signals.summary
//   'session_score'— session_results.overall_score (already a composite)
export const SIGNAL_CATALOG = {
  filler_word_rate: {
    label: 'Filler-word rate', unit: '/answer', better: 'lower',
    source: 'ai_static', path: 'fillerWordsPerAnswer',
    describe: (v) => `${v} filler words per answer on average`,
  },
  gaze_away_seconds: {
    label: 'Gaze-away time', unit: 's/session', better: 'lower',
    source: 'metrics', column: 'gaze_away_seconds', baselineField: null,
    describe: (v) => `Looking away from camera ${v}s per session on average`,
  },
  nervousness_score: {
    label: 'Nervousness proxy', unit: '/100', better: 'lower',
    source: 'metrics', column: 'nervousness_score', baselineField: null,
    describe: (v) => `Visible nervousness cues averaging ${v}/100`,
  },
  stress_index_baevsky: {
    label: 'Stress index (Baevsky)', unit: '', better: 'closer', baselineFraming: true,
    source: 'metrics', column: 'stress_index_baevsky', baselineField: 'baseline_stress_index',
    describe: (v) => `Stress index averaging ${v}`,
  },
  breathing_rate: {
    label: 'Pulse/breathing irregularity', unit: '', better: 'closer', baselineFraming: true,
    source: 'metrics', column: 'breathing_rate', baselineField: 'baseline_breathing_rate',
    describe: (v) => `Breathing rate averaging ${v}/min`,
  },
  fidget_score: {
    label: 'Fidget score', unit: '', better: 'lower', baselineFraming: true,
    source: 'metrics_avg2', columns: ['fidget_score_seat', 'fidget_score_knee'], baselineField: 'baseline_fidget_score',
    describe: (v) => `Seat + knee fidget score averaging ${v}`,
  },
  consistency_confidence_score: {
    label: 'Consistency / confidence', unit: '/100', better: 'higher',
    source: 'session_score',
    describe: (v) => `Consistency/confidence composite of ${v}/100`,
  },
  star_score: {
    label: 'STAR structure', unit: '/4', better: 'higher',
    source: 'ai_static', path: 'avgStarScore',
    describe: (v) => `Averaging ${v}/4 STAR components per answer`,
  },
  quantified_rate: {
    label: 'Quantified results', unit: '%', better: 'higher', scale: 100,
    source: 'ai_static', path: 'quantifiedRate',
    describe: (v) => `${v}% of answers included a quantified result`,
  },
  pulse_rate: {
    label: 'Pulse rate', unit: 'bpm', better: 'lower', baselineFraming: true,
    source: 'metrics', column: 'pulse_rate', baselineField: 'baseline_pulse',
    describe: (v) => `Pulse rate averaging ${v} bpm`,
  },
  // Keyword-overlap "staying on topic" score from python/analysis_service.py
  // (see _topic_relevance_score) -- only present on sessions where a job
  // posting was actually pasted at Session Setup, since there's nothing to
  // compare against otherwise. Already 0-10, unlike the other ai_static
  // signals, so no extra scale/transform here.
  topic_relevance: {
    label: 'Staying on topic', unit: '/10', better: 'higher',
    source: 'ai_static', path: 'avgTopicRelevance',
    describe: (v) => `Averaging ${v}/10 on staying relevant to the role`,
  },
  // Disfluency signals from python/analysis_service.py -- the textual half
  // of "stuttering", which is what actually survives speech-to-text (see
  // that file's disfluency section for the detectors themselves).
  word_repetition_rate: {
    label: 'Repeated words', unit: '/answer', better: 'lower',
    source: 'ai_static', path: 'repeatedWordsPerAnswer',
    describe: (v) => `${v} immediately-repeated words per answer ("I I think")`,
  },
  unfinished_rate: {
    label: 'Unfinished thoughts', unit: '/answer', better: 'lower',
    source: 'ai_static', path: 'unfinishedPerAnswer',
    describe: (v) => `${v} sentences per answer that trailed off instead of landing`,
  },
  tangent_rate: {
    label: 'Tangents', unit: '/answer', better: 'lower',
    source: 'ai_static', path: 'tangentsPerAnswer',
    describe: (v) => `${v} audible tangents per answer ("anyway...", "where was I")`,
  },
  // Delivery quality, also from the static transcript pass.
  non_answer_rate: {
    label: 'Questions conceded', unit: '%', better: 'lower', scale: 100,
    source: 'ai_static', path: 'nonAnswerRate',
    describe: (v) => `${v}% of questions were answered with "I don't know" or similar`,
  },
  ownership_rate: {
    label: 'First-person ownership', unit: '', better: 'higher',
    source: 'ai_static', path: 'ownershipRate',
    describe: (v) => `${Math.round(v * 100)}% of your first-person language was "I" rather than "we"`,
  },
  hedge_rate: {
    label: 'Hedging language', unit: '/answer', better: 'lower',
    source: 'ai_static', path: 'hedgesPerAnswer',
    describe: (v) => `${v} hedges per answer ("I think", "maybe", "sort of")`,
  },
  specificity_rate: {
    label: 'Concrete details', unit: '/answer', better: 'higher',
    source: 'ai_static', path: 'specificsPerAnswer',
    describe: (v) => `${v} concrete details per answer (names, tools, numbers)`,
  },
  answer_length: {
    label: 'Answer length', unit: 'words', better: 'higher',
    source: 'ai_static', path: 'avgWordCount',
    describe: (v) => `Averaging ${v} words per answer`,
  },
  vocabulary_richness: {
    label: 'Vocabulary range', unit: '', better: 'higher',
    source: 'ai_static', path: 'vocabularyRichness',
    describe: (v) => `${Math.round(v * 100)}% of the words you used were distinct`,
  },
  situation_rate: {
    label: 'Context set', unit: '%', better: 'higher', scale: 100,
    source: 'ai_static', path: 'situationRate',
    describe: (v) => `${v}% of answers set up the situation`,
  },
  action_rate: {
    label: 'Actions described', unit: '%', better: 'higher', scale: 100,
    source: 'ai_static', path: 'actionRate',
    describe: (v) => `${v}% of answers described what you actually did`,
  },
  result_rate: {
    label: 'Outcomes stated', unit: '%', better: 'higher', scale: 100,
    source: 'ai_static', path: 'resultRate',
    describe: (v) => `${v}% of answers ended on an outcome`,
  },
  // Biometric signals that had columns but no catalog entry until now.
  rmssd: {
    label: 'HRV (RMSSD)', unit: 'ms', better: 'higher',
    source: 'metrics', column: 'rmssd', baselineField: null,
    describe: (v) => `Heart-rate variability averaging ${v}ms`,
  },
  posture_stability_score: {
    label: 'Posture stability', unit: '/10', better: 'higher',
    source: 'metrics', column: 'posture_stability_score', baselineField: null,
    describe: (v) => `Posture stability averaging ${v}/10`,
  },
  negative_emotion_share: {
    label: 'Negative expression', unit: '%', better: 'lower', scale: 100,
    source: 'metrics_expr', column: 'negative_emotion_share',
    describe: (v) => `Showing a negative expression ${v}% of the session`,
  },
  positive_emotion_share: {
    label: 'Composed expression', unit: '%', better: 'higher', scale: 100,
    source: 'metrics_expr', column: 'positive_emotion_share',
    describe: (v) => `Reading as calm or positive ${v}% of the session`,
  },
};

// Best-effort plain-language weakness -> trackable signal, so "Practice
// this" sessions can show a real before/after (see getTargetingEffectiveness).
// A weakness with no entry here still targets fine, it just can't show a
// numeric before/after -- never fabricated.
export const WEAKNESS_SIGNAL_HINTS = {
  'excessive filler words': 'filler_word_rate',
  'weak eye contact': 'gaze_away_seconds',
  'fidgeting / posture shifts': 'posture_stability_score',
  'composure': 'nervousness_score',
  'vague star examples': 'star_score',
  'not quantifying impact': 'quantified_rate',
};
function hintedSignalFor(weakness) {
  if (!weakness) return null;
  return WEAKNESS_SIGNAL_HINTS[weakness.trim().toLowerCase()] || null;
}

// ── Per-session value extraction ─────────────────────────────────────────

// ── Universal trait scoring (0-10, one decimal) ──────────────────────────
// A second, coarser layer on top of SIGNAL_CATALOG: instead of raw units
// (bpm, seconds, %), every trait here is normalized onto one consistent
// 0-10 "goodness" scale so sessions and traits can be compared directly --
// the Results tab's per-session composite score and "most changed since
// your average" callouts, and the Dashboard tab's all-time trait profile.
// The normalization thresholds below are heuristic, documented estimates
// -- the same spirit as this app's existing STAR/rambling/filler-word
// thresholds, not clinical cutoffs -- and are meant to be tuned over time.
// A trait whose underlying signal(s) weren't recorded for a session is
// simply absent from that session, never scored as a fabricated 0.
function clampScore(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  return round(Math.max(0, Math.min(10, n)), 1);
}

export const TRAIT_CATALOG = {
  verbal_clarity: {
    label: 'Verbal Clarity',
    description: 'How free your answers were of filler words ("um", "like", "you know"...).',
    signals: ['filler_word_rate'],
    compute: ({ filler_word_rate }) => (filler_word_rate == null ? null
      // 0 fillers/answer -> 10, 8+ fillers/answer -> 0.
      : clampScore(10 - (filler_word_rate / 8) * 10)),
  },
  body_language: {
    label: 'Body Language',
    description: 'How still and settled your posture remained.',
    signals: ['posture_stability_score'],
    compute: ({ posture_stability_score }) => (posture_stability_score == null ? null
      : clampScore(posture_stability_score)),
  },
  eye_contact: {
    label: 'Eye Contact',
    description: 'Fraction of the session spent looking at the camera vs. away from it.',
    signals: ['gaze_away_seconds'],
    compute: ({ gaze_away_seconds }) => (gaze_away_seconds == null ? null
      // gaze_away_seconds is a per-session average of 0/1 samples -- the
      // fraction of the session spent not looking at the camera. 0% away
      // -> 10, 50%+ away -> 0.
      : clampScore(10 - (gaze_away_seconds / 0.5) * 10)),
  },
  composure: {
    label: 'Composure',
    description: 'A coaching estimate from visible gaze, head movement, posture shifts, and fidgeting—not a medical stress reading.',
    signals: ['nervousness_score'],
    compute: ({ nervousness_score }) => (nervousness_score == null ? null
      : clampScore(10 - nervousness_score / 10)),
  },
  speech_fluency: {
    label: 'Speech Fluency',
    description: 'Repeated words ("I I think") and thoughts that trailed off instead of landing.',
    signals: ['word_repetition_rate', 'unfinished_rate'],
    compute: ({ word_repetition_rate, unfinished_rate }) => {
      // Two independent disfluency penalties, each worth up to half the
      // score: 3+ repeated words per answer, or 2+ unfinished thoughts per
      // answer, each cost the full 5 points. Scored whenever at least one
      // of the two was measured -- with only one, it carries the whole
      // scale rather than being silently halved by a missing half.
      const penalties = [];
      if (word_repetition_rate != null) penalties.push(Math.min(1, word_repetition_rate / 3));
      if (unfinished_rate != null) penalties.push(Math.min(1, unfinished_rate / 2));
      if (!penalties.length) return null;
      const penalty = penalties.reduce((a, b) => a + b, 0) / penalties.length;
      return clampScore(10 - penalty * 10);
    },
  },
  topic_focus: {
    label: 'Staying on Topic',
    description: 'How close your answers stayed to the role, and how often you audibly went off on a tangent.',
    signals: ['topic_relevance', 'tangent_rate'],
    compute: ({ topic_relevance, tangent_rate }) => {
      // Relevance needs a job posting to compare against; tangent markers
      // don't, so a session with no posting still gets a focus score from
      // the tangent half alone rather than dropping the trait entirely.
      const tangentPenalty = tangent_rate == null ? null : Math.min(1, tangent_rate / 2) * 10;
      if (topic_relevance == null && tangentPenalty == null) return null;
      if (topic_relevance == null) return clampScore(10 - tangentPenalty);
      if (tangentPenalty == null) return clampScore(topic_relevance);
      // Both available: relevance sets the ceiling, tangents pull it down.
      return clampScore(topic_relevance - tangentPenalty / 2);
    },
  },
  answer_structure: {
    label: 'Answer Structure',
    description: 'How consistently your answers covered Situation/Task/Action/Result.',
    signals: ['star_score'],
    compute: ({ star_score }) => (star_score == null ? null : clampScore(star_score * 2.5)),
  },
  quantifying_impact: {
    label: 'Quantifying Impact',
    description: 'How often your answers backed up a claim with a concrete number.',
    signals: ['quantified_rate'],
    compute: ({ quantified_rate }) => (quantified_rate == null ? null : clampScore(quantified_rate / 10)),
  },

  // ── What you said, in more detail ──────────────────────────────────────
  preparedness: {
    label: 'Preparedness',
    description: 'Whether you could actually answer the questions, or conceded them with "I don\'t know".',
    signals: ['non_answer_rate'],
    // Conceding a third of the questions floors this. Nothing else in the
    // catalog captures it -- an answer can be fluent, concise and filler-free
    // while still giving the interviewer nothing.
    compute: ({ non_answer_rate }) => (non_answer_rate == null ? null
      : clampScore(10 - (non_answer_rate / 33) * 10)),
  },
  ownership_language: {
    label: 'Ownership Language',
    description: 'Whether you said "I did" or hid behind "we did" when describing your own work.',
    signals: ['ownership_rate'],
    // Peak at ~70% "I": all-"we" makes your contribution unassessable, but
    // 100% "I" reads as unable to credit a team, so both ends come down.
    compute: ({ ownership_rate }) => (ownership_rate == null ? null
      : clampScore(10 - (Math.abs(ownership_rate - 0.7) / 0.7) * 10)),
  },
  assertiveness: {
    label: 'Assertiveness',
    description: 'How free your answers were of hedging ("I think", "maybe", "sort of").',
    signals: ['hedge_rate'],
    compute: ({ hedge_rate }) => (hedge_rate == null ? null : clampScore(10 - (hedge_rate / 5) * 10)),
  },
  specificity: {
    label: 'Specificity',
    description: 'Concrete names, tools and figures rather than generalities.',
    signals: ['specificity_rate'],
    compute: ({ specificity_rate }) => (specificity_rate == null ? null : clampScore((specificity_rate / 4) * 10)),
  },
  answer_depth: {
    label: 'Answer Depth',
    description: 'Whether your answers were developed enough to show anything.',
    signals: ['answer_length'],
    // Only the short end: 60+ words is a fully developed answer. Going long
    // is Conciseness's problem, not this one.
    compute: ({ answer_length }) => (answer_length == null ? null : clampScore((answer_length / 60) * 10)),
  },
  conciseness: {
    label: 'Conciseness',
    description: 'Whether you landed the answer or kept going past the point.',
    signals: ['answer_length'],
    compute: ({ answer_length }) => (answer_length == null ? null
      : clampScore(10 - (Math.max(0, answer_length - 170) / 170) * 10)),
  },
  vocabulary_range: {
    label: 'Vocabulary Range',
    description: 'How much distinct vocabulary you drew on versus repeating the same words.',
    signals: ['vocabulary_richness'],
    // Spoken type-token ratio realistically runs ~0.3-0.7.
    compute: ({ vocabulary_richness }) => (vocabulary_richness == null ? null
      : clampScore(((vocabulary_richness - 0.3) / 0.4) * 10)),
  },
  context_setting: {
    label: 'Context Setting',
    description: 'How often you set up the situation before diving into what you did.',
    signals: ['situation_rate'],
    compute: ({ situation_rate }) => (situation_rate == null ? null : clampScore(situation_rate / 10)),
  },
  action_detail: {
    label: 'Action Detail',
    description: 'How often you described the specific actions you took.',
    signals: ['action_rate'],
    compute: ({ action_rate }) => (action_rate == null ? null : clampScore(action_rate / 10)),
  },
  outcome_focus: {
    label: 'Outcome Focus',
    description: 'How often your answers ended on a result rather than trailing off mid-story.',
    signals: ['result_rate'],
    compute: ({ result_rate }) => (result_rate == null ? null : clampScore(result_rate / 10)),
  },

  // ── What your body did while you said it ──────────────────────────────
  posture_stability: {
    label: 'Posture Stability',
    description: 'How settled your torso stayed, separate from seat/knee fidgeting.',
    signals: ['posture_stability_score'],
    compute: ({ posture_stability_score }) => (posture_stability_score == null ? null
      : clampScore(posture_stability_score)),
  },
  emotional_steadiness: {
    label: 'Emotional Steadiness',
    description: 'How little of the session your expression read as tense, anxious or unhappy.',
    signals: ['negative_emotion_share'],
    // Half the session visibly negative is the floor.
    compute: ({ negative_emotion_share }) => (negative_emotion_share == null ? null
      : clampScore(10 - (negative_emotion_share / 50) * 10)),
  },
  positive_presence: {
    label: 'Positive Presence',
    description: 'How much of the session you read as composed, open or positive.',
    signals: ['positive_emotion_share'],
    compute: ({ positive_emotion_share }) => (positive_emotion_share == null ? null
      : clampScore(positive_emotion_share / 10)),
  },
  breathing_steadiness: {
    label: 'Breathing Steadiness',
    description: 'How close your breathing stayed to a relaxed rate.',
    signals: ['breathing_rate'],
    // Relaxed adult breathing sits near 15/min; drifting either way (racing
    // or holding your breath) is the signal, so distance is what's scored.
    compute: ({ breathing_rate }) => (breathing_rate == null ? null
      : clampScore(10 - (Math.abs(breathing_rate - 15) / 8) * 10)),
  },
  stress_recovery: {
    label: 'Stress Recovery',
    description: 'Heart-rate variability — how well your body settled between questions.',
    signals: ['rmssd'],
    // RMSSD under ~10ms reads as sustained strain; ~70ms+ is well recovered.
    compute: ({ rmssd }) => (rmssd == null ? null : clampScore(((rmssd - 10) / 60) * 10)),
  },
};

// Raw per-session signal values for one session, pulled out of the
// { signalKey: [{sessionId,startedAt,value}] } series buildSignalSeries
// produces -- { signalKey: value }.
function rawValuesForSession(series, sessionId) {
  const out = {};
  for (const key of Object.keys(series)) {
    const point = series[key].find(p => p.sessionId === sessionId);
    if (point) out[key] = point.value;
  }
  return out;
}

// Every trait's 0-10 score for one session, keyed by trait key. Traits
// whose underlying signal(s) weren't recorded that session are omitted.
function traitValuesForSession(series, sessionId) {
  const raw = rawValuesForSession(series, sessionId);
  const out = {};
  for (const [key, trait] of Object.entries(TRAIT_CATALOG)) {
    const value = trait.compute(raw);
    if (value != null) out[key] = value;
  }
  return out;
}

// Trait scores for every session in sessionRows, chronological --
// { traitKey: [{ sessionId, startedAt, value }] }, the same shape
// buildSignalSeries uses for raw signals so it can be consumed the same way
// (all-time averages, "top N most changed", etc).
function traitSeriesForSessions(series, sessionRows) {
  const out = {};
  for (const key of Object.keys(TRAIT_CATALOG)) out[key] = [];
  for (const row of sessionRows) {
    const values = traitValuesForSession(series, row.session_id);
    for (const [key, value] of Object.entries(values)) {
      out[key].push({ sessionId: row.session_id, startedAt: row.started_at, value });
    }
  }
  return out;
}

// ── Per-session value extraction ─────────────────────────────────────────
// Loads one value per session (most recent `limit` sessions, chronological
// order) for a given catalog signal. This is deliberately session-level,
// not time-bucketed -- "rolling average over the last 5-10 sessions" per
// the product spec means the recent-session trend line, not a smoothed
// window function.
async function loadSessionRows(db, { userId, sessionType, limit }) {
  const values = [userId];
  let filter = '';
  if (sessionType) { values.push(sessionType); filter = ' AND s.session_type = $2'; }
  values.push(limit);
  const result = await db.query(
    `SELECT s.session_id, s.started_at, s.session_type, s.targeted_weakness, s.job_posting_text, s.job_posting_id
     FROM sessions s WHERE s.user_id = $1${filter} AND s.ended_at IS NOT NULL
     ORDER BY s.started_at DESC LIMIT $${values.length}`,
    values,
  );
  return result.rows.reverse(); // chronological
}

// dominant_emotion is a label, not a number, so the two expression-sourced
// signals above are computed as the share of samples carrying a negative vs.
// a composed expression. CASE returns NULL (not 0) for unlabelled samples so
// AVG skips them -- a session where the face model never reported anything
// has no emotion share at all rather than a fabricated 0%.
const NEGATIVE_EMOTIONS = ['angry', 'contempt', 'disgust', 'fear', 'sad'];
const POSITIVE_EMOTIONS = ['happy', 'neutral', 'surprise'];
const emotionShareSelect = (label, emotions) =>
  `AVG(CASE WHEN dominant_emotion IS NULL THEN NULL WHEN dominant_emotion IN (${emotions.map(e => `'${e}'`).join(', ')}) THEN 1.0 ELSE 0.0 END) AS ${label}`;

async function loadMetricsAverages(db, { userId, sessionIds, columns }) {
  if (!sessionIds.length) return {};
  const avgSelect = [
    ...columns.map(c => `AVG(${c}) AS ${c}`),
    emotionShareSelect('negative_emotion_share', NEGATIVE_EMOTIONS),
    emotionShareSelect('positive_emotion_share', POSITIVE_EMOTIONS),
  ].join(', ');
  const result = await db.query(
    `SELECT session_id, ${avgSelect} FROM session_metrics WHERE user_id = $1 AND session_id = ANY($2::uuid[]) GROUP BY session_id`,
    [userId, sessionIds],
  );
  const bySession = {};
  for (const row of result.rows) bySession[row.session_id] = row;
  return bySession;
}

async function loadAiStatic(db, { userId, sessionIds }) {
  if (!sessionIds.length) return {};
  const result = await db.query(
    `SELECT session_id, static_signals, overall_score FROM session_ai_analysis WHERE user_id = $1 AND session_id = ANY($2::uuid[])`,
    [userId, sessionIds],
  );
  const bySession = {};
  for (const row of result.rows) bySession[row.session_id] = row;
  return bySession;
}

async function loadSessionScores(db, { userId, sessionIds }) {
  if (!sessionIds.length) return {};
  const result = await db.query(
    `SELECT session_id, overall_score FROM session_results WHERE user_id = $1 AND session_id = ANY($2::uuid[])`,
    [userId, sessionIds],
  );
  const bySession = {};
  for (const row of result.rows) bySession[row.session_id] = row.overall_score;
  return bySession;
}

const metricsColumns = [...new Set(Object.values(SIGNAL_CATALOG)
  .flatMap(s => s.source === 'metrics' ? [s.column] : s.source === 'metrics_avg2' ? s.columns : []))];

// Builds { signalKey: [{ sessionId, startedAt, value }] } for every session
// in `sessionRows`, for every catalog signal that has data. Signals never
// touched during a session are simply absent from that session's point,
// not zero-filled.
async function buildSignalSeries(db, { userId, sessionRows }) {
  const sessionIds = sessionRows.map(r => r.session_id);
  const [metricsBySession, aiBySession, scoreBySession] = await Promise.all([
    loadMetricsAverages(db, { userId, sessionIds, columns: metricsColumns }),
    loadAiStatic(db, { userId, sessionIds }),
    loadSessionScores(db, { userId, sessionIds }),
  ]);
  const series = {};
  for (const key of Object.keys(SIGNAL_CATALOG)) series[key] = [];
  for (const row of sessionRows) {
    const m = metricsBySession[row.session_id];
    const ai = aiBySession[row.session_id];
    const point = (value) => ({ sessionId: row.session_id, startedAt: row.started_at, value: round(value, 2) });
    if (m) {
      if (m.gaze_away_seconds !== null && m.gaze_away_seconds !== undefined) series.gaze_away_seconds.push(point(Number(m.gaze_away_seconds)));
      if (m.nervousness_score !== null && m.nervousness_score !== undefined) series.nervousness_score.push(point(Number(m.nervousness_score)));
      if (m.stress_index_baevsky !== null && m.stress_index_baevsky !== undefined) series.stress_index_baevsky.push(point(Number(m.stress_index_baevsky)));
      if (m.breathing_rate !== null && m.breathing_rate !== undefined) series.breathing_rate.push(point(Number(m.breathing_rate)));
      if (m.fidget_score_seat !== null && m.fidget_score_knee !== null && m.fidget_score_seat !== undefined && m.fidget_score_knee !== undefined) {
        series.fidget_score.push(point((Number(m.fidget_score_seat) + Number(m.fidget_score_knee)) / 2));
      }
    }
    if (ai?.static_signals?.summary) {
      const s = ai.static_signals.summary;
      if (typeof s.fillerWordsPerAnswer === 'number') series.filler_word_rate.push(point(s.fillerWordsPerAnswer));
      if (typeof s.avgStarScore === 'number') series.star_score.push(point(s.avgStarScore));
      if (typeof s.quantifiedRate === 'number') series.quantified_rate.push(point(s.quantifiedRate * 100));
      if (typeof s.avgTopicRelevance === 'number') series.topic_relevance.push(point(s.avgTopicRelevance));
      if (typeof s.repeatedWordsPerAnswer === 'number') series.word_repetition_rate.push(point(s.repeatedWordsPerAnswer));
      if (typeof s.unfinishedPerAnswer === 'number') series.unfinished_rate.push(point(s.unfinishedPerAnswer));
      if (typeof s.tangentsPerAnswer === 'number') series.tangent_rate.push(point(s.tangentsPerAnswer));
      if (typeof s.nonAnswerRate === 'number') series.non_answer_rate.push(point(s.nonAnswerRate * 100));
      if (typeof s.ownershipRate === 'number') series.ownership_rate.push(point(s.ownershipRate));
      if (typeof s.hedgesPerAnswer === 'number') series.hedge_rate.push(point(s.hedgesPerAnswer));
      if (typeof s.specificsPerAnswer === 'number') series.specificity_rate.push(point(s.specificsPerAnswer));
      if (typeof s.avgWordCount === 'number') series.answer_length.push(point(s.avgWordCount));
      if (typeof s.vocabularyRichness === 'number') series.vocabulary_richness.push(point(s.vocabularyRichness));
      if (typeof s.situationRate === 'number') series.situation_rate.push(point(s.situationRate * 100));
      if (typeof s.actionRate === 'number') series.action_rate.push(point(s.actionRate * 100));
      if (typeof s.resultRate === 'number') series.result_rate.push(point(s.resultRate * 100));
    }
    if (m) {
      const pushMetric = (key, column, scale = 1) => {
        if (m[column] !== null && m[column] !== undefined) series[key].push(point(Number(m[column]) * scale));
      };
      pushMetric('pulse_rate', 'pulse_rate');
      pushMetric('rmssd', 'rmssd');
      pushMetric('posture_stability_score', 'posture_stability_score');
      pushMetric('negative_emotion_share', 'negative_emotion_share', 100);
      pushMetric('positive_emotion_share', 'positive_emotion_share', 100);
    }
    const score = scoreBySession[row.session_id];
    if (score !== null && score !== undefined) series.consistency_confidence_score.push(point(Number(score)));
  }
  return series;
}

// Trend arrow/delta between the two most recent points of a series.
function sinceLastDelta(seriesPoints, better) {
  if (seriesPoints.length < 2) return null;
  const prev = seriesPoints[seriesPoints.length - 2].value;
  const latest = seriesPoints[seriesPoints.length - 1].value;
  const deltaPct = pctChange(prev, latest);
  if (deltaPct === null) return null;
  const improved = better === 'higher' ? deltaPct > 0 : better === 'lower' ? deltaPct < 0 : Math.abs(deltaPct) < Math.abs(pctChange(prev, prev) ?? 0);
  return { deltaPct, improved: better === 'closer' ? null : improved, latest, prev };
}

// Plain-language callout for one trait's session-vs-average delta, used by
// the Results tab's "skill development" section.
function describeTraitChange(label, sessionValue, avgValue, delta) {
  if (Math.abs(delta) < 0.3) return `${label} was about your usual ${avgValue}/10 this session.`;
  if (delta > 0) {
    return `${label} was ${sessionValue}/10 this session, well above your ${avgValue}/10 average — a strong showing.`;
  }
  return `${label} was ${sessionValue}/10 this session, well below your ${avgValue}/10 average — worth practicing.`;
}

// "Position applied for" shown at the top of the Results tab. Most sessions
// just paste free-text job posting content rather than uploading a saved
// posting (which does have a real title/company), so there's usually no
// clean role title to display -- this derives the best honest label
// available rather than requiring a new required field at Session Setup.
function derivePosition(session, jobPosting) {
  if (session.position_label) return session.position_label;
  if (jobPosting?.title) return jobPosting.title + (jobPosting.company ? ` at ${jobPosting.company}` : '');
  const text = jobPosting?.text;
  if (text) {
    const firstLine = text.split('\n').map(line => line.trim()).find(Boolean);
    if (firstLine) return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
  }
  return 'General interview practice';
}

// ── Results tab: per-session dashboard bundle ────────────────────────────
export async function getSessionDashboard(db, { sessionId, userId }) {
  const sessionResult = await db.query(
    `SELECT session_id, started_at, ended_at, session_type, targeted_weakness, job_posting_text, job_posting_id,
            position_label, duration_seconds
     FROM sessions WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId],
  );
  const session = sessionResult.rows[0];
  if (!session) throw new HttpError(404, 'Session not found.');

  const [recentRows, aiRow, resultRow, jobPosting] = await Promise.all([
    loadSessionRows(db, { userId, sessionType: session.session_type, limit: 10 }),
    db.query('SELECT * FROM session_ai_analysis WHERE session_id = $1 AND user_id = $2', [sessionId, userId]).then(r => r.rows[0] || null),
    db.query('SELECT * FROM session_results WHERE session_id = $1 AND user_id = $2', [sessionId, userId]).then(r => r.rows[0] || null),
    session.job_posting_id
      ? db.query('SELECT job_posting_id, title, company FROM job_postings WHERE job_posting_id = $1 AND user_id = $2', [session.job_posting_id, userId]).then(r => r.rows[0] || null)
      : Promise.resolve(null),
  ]);

  // Make sure this session is included in the recent-session window even
  // if it's still mid-flight or fell outside the naive LIMIT ordering.
  const rowsWithThis = recentRows.some(r => r.session_id === sessionId) ? recentRows : [...recentRows, session].sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
  const series = await buildSignalSeries(db, { userId, sessionRows: rowsWithThis });

  const totalSessionsResult = await db.query('SELECT count(*) FROM sessions WHERE user_id = $1 AND ended_at IS NOT NULL', [userId]);
  const totalSessions = Number(totalSessionsResult.rows[0].count);

  const charts = [];
  const rankedWeaknesses = [];
  const strengthsOut = [];
  for (const [key, cat] of Object.entries(SIGNAL_CATALOG)) {
    const points = series[key];
    if (!points.length) continue;
    const sinceLast = sinceLastDelta(points, cat.better);
    charts.push({
      key, label: cat.label, unit: cat.unit, better: cat.better,
      baselineFraming: Boolean(cat.baselineFraming),
      points: points.map(p => ({ startedAt: p.startedAt, value: p.value })),
      sinceLast,
    });
  }

  // Ranked weakness list: biometric verdicts from session_results.weaknesses
  // (already real comparisons against baseline/trend, see sessionAnalysis.js)
  // plus Gemini's qualitative weaknesses from this session's transcript
  // analysis. Each gets the matching signal's recent sparkline when one
  // exists via WEAKNESS_SIGNAL_HINTS or a direct catalog key match.
  const seen = new Set();
  const pushWeakness = (title, detail, signalKey) => {
    const dedupeKey = title.toLowerCase();
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    const points = signalKey ? series[signalKey] : null;
    rankedWeaknesses.push({
      title, detail,
      signalKey: signalKey || null,
      sparkline: points ? points.slice(-8).map(p => p.value) : [],
    });
  };
  for (const w of resultRow?.weaknesses || []) {
    const cat = SIGNAL_CATALOG[w.signal];
    pushWeakness(cat?.label || w.signal, w.detail, cat ? w.signal : null);
  }
  for (const w of aiRow?.ai_weaknesses || []) {
    pushWeakness(w, w, hintedSignalFor(w));
  }
  for (const s of resultRow?.strengths || []) {
    const cat = SIGNAL_CATALOG[s.signal];
    strengthsOut.push({ title: cat?.label || s.signal, detail: s.detail });
  }
  for (const s of aiRow?.ai_strengths || []) {
    strengthsOut.push({ title: s, detail: s });
  }

  // ── Universal trait composite + "skill development" ─────────────────────
  // Deliberately built over ALL of this user's ended sessions (not just the
  // last-10 chart window above) -- the composite score and "how does this
  // session compare to your average" callouts are meant to be honest
  // against your whole history, per the product spec ("my overall score
  // would be calculated average from my scores" across all sessions, not a
  // recency-biased window). A large-but-finite LIMIT (matching the pattern
  // already used for targeting/trend queries elsewhere in this file) is
  // "effectively all" without an unbounded query.
  const allRowsRaw = await loadSessionRows(db, { userId, sessionType: session.session_type, limit: 5000 });
  const allSessionRows = allRowsRaw.some(r => r.session_id === sessionId)
    ? allRowsRaw
    : [...allRowsRaw, session].sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
  const allSeries = await buildSignalSeries(db, { userId, sessionRows: allSessionRows });
  const traitSeriesAll = traitSeriesForSessions(allSeries, allSessionRows);
  const sessionTraits = traitValuesForSession(allSeries, sessionId);
  const traitValues = Object.values(sessionTraits);
  const compositeScore10 = traitValues.length ? round(traitValues.reduce((a, b) => a + b, 0) / traitValues.length, 1) : null;

  // Trend arrow: this session's composite vs. the immediately preceding
  // session's composite (both computed the same way), not the old
  // session_results.overall_score comparison.
  let scoreTrend = null;
  const sessionIdx = allSessionRows.findIndex(r => r.session_id === sessionId);
  if (sessionIdx > 0 && compositeScore10 != null) {
    const prevTraits = Object.values(traitValuesForSession(allSeries, allSessionRows[sessionIdx - 1].session_id));
    if (prevTraits.length) {
      const prevComposite = round(prevTraits.reduce((a, b) => a + b, 0) / prevTraits.length, 1);
      scoreTrend = compositeScore10 >= prevComposite ? 'up' : 'down';
    }
  }

  // Top 3 traits whose score this session moved the furthest from this
  // user's own all-time average for that trait (excluding this session) --
  // "stutter 2/10 vs. your usual 6/10" gets surfaced, "body language 6.1 vs.
  // your usual 6.0" doesn't. A trait needs at least one other scored
  // session to have an average to compare against.
  // Traits WITH history rank by how far they moved; traits measured for the
  // first time this session still get shown (ranked after, weakest first)
  // so this section fills its three slots whenever three traits were
  // measured at all, instead of collapsing to a single card the way it does
  // when almost nothing has history yet.
  const withHistory = [];
  const firstTime = [];
  for (const [key, sessionValue] of Object.entries(sessionTraits)) {
    const label = TRAIT_CATALOG[key].label;
    const priorPoints = (traitSeriesAll[key] || []).filter(p => p.sessionId !== sessionId);
    if (!priorPoints.length) {
      firstTime.push({
        key, label, sessionValue, avgValue: null, delta: null, direction: 'baseline',
        message: `${label} came in at ${sessionValue}/10. This is the first session it was measured, so there's no average to compare against yet.`,
      });
      continue;
    }
    const avgValue = round(priorPoints.reduce((a, p) => a + p.value, 0) / priorPoints.length, 1);
    const delta = round(sessionValue - avgValue, 1);
    withHistory.push({
      key, label, sessionValue, avgValue, delta,
      direction: delta >= 0 ? 'better' : 'worse',
      message: describeTraitChange(label, sessionValue, avgValue, delta),
    });
  }
  withHistory.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  firstTime.sort((a, b) => a.sessionValue - b.sessionValue);
  const skillDevelopment = [...withHistory, ...firstTime].slice(0, 3);

  // ── Trait-derived strengths and weaknesses ─────────────────────────────
  // The two original sources -- session_results (biometric verdicts, which
  // only exist once computeSessionAnalysis has run) and Gemini's qualitative
  // pass (which dies on a 503) -- can BOTH be empty, and when they are the
  // Results tab claims "no standout weaknesses detected" for a session that
  // plainly had them. The trait scores are computed from the same recorded
  // data either way, so they're a floor that always works.
  const LOW_TRAIT = 4;
  const HIGH_TRAIT = 8;
  const scored = Object.entries(sessionTraits)
    .map(([key, value]) => ({ key, value, cat: TRAIT_CATALOG[key] }));

  for (const { key, value, cat } of scored.filter(t => t.value <= LOW_TRAIT).sort((a, b) => a.value - b.value)) {
    // Conceding questions outranks everything else -- it's the most
    // consequential thing that can happen in an interview.
    const detail = key === 'preparedness'
      ? `You answered ${round(100 - (value / 10) * 100, 0)}% of questions with "I don't know" or similar. Even a partial answer beats conceding — say what you do know, then what you'd go find out.`
      : `${cat.description} Scored ${value}/10 this session.`;
    pushWeakness(cat.label, detail, null);
  }
  if (sessionTraits.preparedness != null && sessionTraits.preparedness <= LOW_TRAIT) {
    // Float it to the top of the list rather than leaving it in score order.
    const idx = rankedWeaknesses.findIndex(w => w.title === TRAIT_CATALOG.preparedness.label);
    if (idx > 0) rankedWeaknesses.unshift(...rankedWeaknesses.splice(idx, 1));
  }
  for (const { value, cat } of scored.filter(t => t.value >= HIGH_TRAIT).sort((a, b) => b.value - a.value)) {
    if (strengthsOut.some(existing => existing.title === cat.label)) continue;
    strengthsOut.push({ title: cat.label, detail: `${cat.description} Scored ${value}/10 this session.` });
  }

  const jobPostingOut = jobPosting || (session.job_posting_text ? { text: session.job_posting_text } : null);
  const position = derivePosition(session, jobPostingOut);

  return {
    session: { ...session, jobPosting: jobPostingOut },
    atAGlance: {
      compositeScore10, scoreTrend, totalSessions, position,
      // Written by the transcript-analysis pass; falls back to the role when
      // that pass hasn't run or failed.
      title: aiRow?.session_title || position,
      aiSummary: aiRow?.ai_summary || null, aiError: aiRow?.ai_error || null,
      // Backboard read path B: what changed in HOW they told the same story
      // versus an earlier session. Empty until a user has history.
      progressNotes: Array.isArray(aiRow?.progress_notes) ? aiRow.progress_notes : [],
    },
    charts,
    weaknesses: rankedWeaknesses.slice(0, 8),
    strengths: strengthsOut.slice(0, 6),
    traits: Object.entries(sessionTraits).map(([key, value]) => ({ key, label: TRAIT_CATALOG[key].label, value })),
    skillDevelopment,
  };
}

// ── Dashboard tab: all-time overview bundle ──────────────────────────────
/**
 * Resolve a practice target ("Answer Structure", or a raw trait key) to that
 * trait's current standing for this user, for the interview planner.
 *
 * The frontend sends the human label, because that's what the Practice this
 * button has in hand and what the rest of the weakness plumbing already
 * carries. Matching is on the label so nothing else has to change; an
 * unrecognised string (a free-text weakness from Gemini) simply returns null
 * and the planner treats it as a topic hint the way it always has.
 */
export async function getTraitStanding(db, { userId, weakness, sessionType }) {
  if (typeof weakness !== 'string' || !weakness.trim()) return null;
  const needle = weakness.trim().toLowerCase();
  const entry = Object.entries(TRAIT_CATALOG).find(
    ([key, cat]) => cat.label.toLowerCase() === needle || key === needle,
  );
  if (!entry) return null;
  const [traitKey, cat] = entry;

  const sessionsResult = await db.query(
    `SELECT session_id, started_at, ended_at, session_type, targeted_weakness, duration_seconds
     FROM sessions WHERE user_id = $1 AND ended_at IS NOT NULL ${sessionType ? 'AND session_type = $2' : ''}
     ORDER BY started_at ASC`,
    sessionType ? [userId, sessionType] : [userId],
  );
  if (!sessionsResult.rows.length) {
    return { traitKey, label: cat.label, description: cat.description, value: null, sampleCount: 0, latestValue: null };
  }
  const series = await buildSignalSeries(db, { userId, sessionRows: sessionsResult.rows });
  const points = traitSeriesForSessions(series, sessionsResult.rows)[traitKey] || [];
  if (!points.length) {
    return { traitKey, label: cat.label, description: cat.description, value: null, sampleCount: 0, latestValue: null };
  }
  return {
    traitKey,
    label: cat.label,
    description: cat.description,
    value: round(points.reduce((a, p) => a + p.value, 0) / points.length, 1),
    latestValue: points[points.length - 1].value,
    sampleCount: points.length,
  };
}

export async function getOverview(db, { userId, sessionType }) {
  const sessionsResult = await db.query(
    `SELECT session_id, started_at, ended_at, session_type, targeted_weakness, duration_seconds
     FROM sessions WHERE user_id = $1 AND ended_at IS NOT NULL ${sessionType ? 'AND session_type = $2' : ''}
     ORDER BY started_at ASC`,
    sessionType ? [userId, sessionType] : [userId],
  );
  const sessionRows = sessionsResult.rows;
  if (!sessionRows.length) {
    return { hasSessions: false };
  }

  const series = await buildSignalSeries(db, { userId, sessionRows });

  // All-time averages (full history, not a rolling window).
  const allTimeAverages = {};
  for (const [key, points] of Object.entries(series)) {
    if (points.length) allTimeAverages[key] = round(points.reduce((a, p) => a + p.value, 0) / points.length, 2);
  }

  // Universal trait profile (0-10) -- the Dashboard tab's full picture,
  // as opposed to Results' per-session top-3 "most changed" callouts. Every
  // tracked trait shows up here regardless of whether it moved recently.
  const traitSeries = traitSeriesForSessions(series, sessionRows);
  const traitAverages = {};
  for (const [key, points] of Object.entries(traitSeries)) {
    if (points.length) {
      traitAverages[key] = {
        label: TRAIT_CATALOG[key].label,
        description: TRAIT_CATALOG[key].description,
        value: round(points.reduce((a, p) => a + p.value, 0) / points.length, 1),
        sampleCount: points.length,
      };
    }
  }

  // Most-improved metric: compare the average of the first third of
  // sessions against the last third, pick the signal with the largest
  // improvement in its own "better" direction. Needs at least 4 points to
  // say anything meaningful about a trend.
  let mostImproved = null;
  for (const [key, points] of Object.entries(series)) {
    if (points.length < 4) continue;
    const cat = SIGNAL_CATALOG[key];
    const third = Math.max(1, Math.floor(points.length / 3));
    const early = points.slice(0, third).reduce((a, p) => a + p.value, 0) / third;
    const late = points.slice(-third).reduce((a, p) => a + p.value, 0) / third;
    const deltaPct = pctChange(early, late);
    if (deltaPct === null) continue;
    const improvement = cat.better === 'higher' ? deltaPct : cat.better === 'lower' ? -deltaPct : -Math.abs(pctChange(early, late));
    if (!mostImproved || improvement > mostImproved.improvement) {
      mostImproved = { signalKey: key, label: cat.label, improvement: round(improvement), deltaPct };
    }
  }

  // Best session ever, by the same trait composite the Results tab shows.
  // This used to read session_results.overall_score, which meant it was
  // empty for every session ever recorded -- computeSessionAnalysis was
  // never called outside the test suite, so that table had no rows. Scoring
  // off the trait composite works retroactively across the whole history.
  let bestSession = null;
  for (const row of sessionRows) {
    const values = Object.values(traitValuesForSession(series, row.session_id));
    if (!values.length) continue;
    const score10 = round(values.reduce((a, b) => a + b, 0) / values.length, 1);
    if (!bestSession || score10 > bestSession.score10) {
      bestSession = { sessionId: row.session_id, score10, startedAt: row.started_at };
    }
  }

  const totalSessions = sessionRows.length;
  const totalPracticeSeconds = sessionRows.reduce((a, r) => a + (Number(r.duration_seconds) || 0), 0);

  // Consistency/streak: sessions per week over the account's history, plus
  // the current run of consecutive weeks (ending this week) with >=1 session.
  const weekOf = (d) => { const dt = new Date(d); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day); dt.setUTCHours(0, 0, 0, 0); return dt.getTime(); };
  const weeksWithSessions = new Set(sessionRows.map(r => weekOf(r.started_at)));
  const firstWeek = weekOf(sessionRows[0].started_at);
  const lastWeek = weekOf(new Date());
  const totalWeeks = Math.max(1, Math.round((lastWeek - firstWeek) / (7 * 24 * 3600 * 1000)) + 1);
  const sessionsPerWeek = round(totalSessions / totalWeeks, 2);
  let streakWeeks = 0;
  for (let w = lastWeek; weeksWithSessions.has(w); w -= 7 * 24 * 3600 * 1000) streakWeeks += 1;

  // ── Arrows on the Dashboard's trait profile ────────────────────────────
  // The three traits that moved furthest in the MOST RECENT session, each
  // against that trait's own average across every earlier session. These
  // replace themselves wholesale every time a session finishes -- the point
  // is "what changed last time", not a running tally, so exactly three
  // arrows exist at any moment and they always describe one session.
  //
  // A trait with no prior sessions is skipped rather than shown as flat:
  // an arrow has to mean movement, and a first measurement has nothing to
  // have moved from.
  const latestSessionId = sessionRows[sessionRows.length - 1].session_id;
  const latestTraits = traitValuesForSession(series, latestSessionId);
  const movers = [];
  for (const [key, sessionValue] of Object.entries(latestTraits)) {
    const prior = (traitSeries[key] || []).filter(p => p.sessionId !== latestSessionId);
    if (!prior.length) continue;
    const avgValue = round(prior.reduce((a, p) => a + p.value, 0) / prior.length, 1);
    const delta = round(sessionValue - avgValue, 1);
    if (delta === 0) continue;
    movers.push({
      key,
      label: TRAIT_CATALOG[key].label,
      direction: delta > 0 ? 'better' : 'worse',
      delta,
      sessionValue,
      avgValue,
      message: describeTraitChange(TRAIT_CATALOG[key].label, sessionValue, avgValue, delta),
    });
  }
  movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const recentMovers = movers.slice(0, 3);

  const goals = await getGoalsWithProgress(db, { userId, sessionType, allTimeAverages, series, sessionRows });
  const targetedWeaknesses = [...new Set(sessionRows.map(r => r.targeted_weakness).filter(Boolean))];
  const targeting = await Promise.all(targetedWeaknesses.map(w => getTargetingEffectiveness(db, { userId, weakness: w, sessionType })));

  return {
    hasSessions: true,
    totalSessions,
    totalPracticeSeconds,
    allTimeAverages,
    traitAverages,
    recentMovers,
    mostImproved,
    bestSession,
    sessionsPerWeek,
    streakWeeks,
    goals,
    targeting: targeting.filter(Boolean),
  };
}

// ── Results tab: lazy-loaded full transcript ─────────────────────────────
// Kept out of getSessionDashboard's main payload (transcripts can be long)
// -- the Results tab only fetches this when the person actually expands the
// transcript panel. Null when no analysis has been run for this session yet
// (older sessions saved before transcript persistence existed will also
// come back null here, since there was nowhere for their transcript to go).
export async function getSessionTranscript(db, { sessionId, userId }) {
  const owned = await db.query('SELECT 1 FROM sessions WHERE session_id = $1 AND user_id = $2', [sessionId, userId]);
  if (!owned.rows.length) throw new HttpError(404, 'Session not found.');
  const result = await db.query(
    'SELECT transcript, computed_at FROM session_ai_analysis WHERE session_id = $1 AND user_id = $2',
    [sessionId, userId],
  );
  const row = result.rows[0];
  return { transcript: row?.transcript || null, computedAt: row?.computed_at || null };
}

// ── Long-range trend (Dashboard tab, zoomable) ───────────────────────────
// Uses the session_metrics_daily continuous aggregate for metrics-sourced
// signals when it exists (this is genuinely where it earns its keep --
// months of raw samples collapse to one row per user/mode/day). Falls back
// to the plain per-session series for signals it doesn't cover, or if the
// aggregate itself isn't available in this environment.
export async function getSignalTrend(db, { userId, signalKey, sessionType, sinceDays = 365 }) {
  const cat = SIGNAL_CATALOG[signalKey];
  if (!cat) throw new HttpError(404, `Unknown signal: ${signalKey}`);
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();

  if (cat.source === 'metrics' || cat.source === 'metrics_avg2') {
    const expr = cat.source === 'metrics' ? cat.column : `(${cat.columns[0]} + ${cat.columns[1]}) / 2.0`;
    try {
      const values = [userId, since];
      let filter = '';
      if (sessionType) { values.push(sessionType); filter = ' AND session_type = $3'; }
      const result = await db.query(
        `SELECT day, ${expr.includes('+') ? `(fidget_score_seat + fidget_score_knee) / 2.0 AS value` : `${cat.column} AS value`}
         FROM session_metrics_daily WHERE user_id = $1 AND day >= $2${filter} ORDER BY day ASC`,
        values,
      );
      return { source: 'continuous_aggregate', points: result.rows.filter(r => r.value !== null).map(r => ({ date: r.day, value: round(Number(r.value), 2) })) };
    } catch (error) {
      console.warn(`session_metrics_daily unavailable, falling back to raw session_metrics for ${signalKey}:`, error.message);
    }
    const values = [userId, since];
    let filter = '';
    if (sessionType) { values.push(sessionType); filter = ' AND m.session_type = $3'; }
    const result = await db.query(
      `SELECT date_trunc('day', recorded_at) AS day, ${cat.source === 'metrics' ? `AVG(${cat.column})` : `AVG((${cat.columns[0]} + ${cat.columns[1]}) / 2.0)`} AS value
       FROM session_metrics m WHERE user_id = $1 AND recorded_at >= $2${filter} GROUP BY day ORDER BY day ASC`,
      values,
    );
    return { source: 'raw', points: result.rows.filter(r => r.value !== null).map(r => ({ date: r.day, value: round(Number(r.value), 2) })) };
  }

  // AI/session-score-sourced signals: no hypertable to bucket, just the
  // full per-session series within the date range.
  const sessionRows = (await loadSessionRows(db, { userId, sessionType, limit: 1000 }))
    .filter(r => new Date(r.started_at) >= new Date(since));
  const series = await buildSignalSeries(db, { userId, sessionRows });
  return { source: 'per_session', points: series[signalKey].map(p => ({ date: p.startedAt, value: p.value })) };
}

// ── Trait development over time (Dashboard trend chart) ─────────────────
// The trend chart used to plot raw SIGNAL_CATALOG values, which meant
// switching series also switched units -- bpm, then seconds, then a
// percentage. Traits are all on the same 0-10 scale, so a trait trend is
// directly readable and comparable between traits.
export async function getTraitTrend(db, { userId, traitKey, sessionType, sinceDays = 3650 }) {
  const trait = TRAIT_CATALOG[traitKey];
  if (!trait) throw new HttpError(404, `Unknown trait: ${traitKey}`);
  const since = new Date(Date.now() - sinceDays * 86400000);

  const sessionRows = (await loadSessionRows(db, { userId, sessionType, limit: 5000 }))
    .filter(r => new Date(r.started_at) >= since);
  if (!sessionRows.length) return { key: traitKey, label: trait.label, description: trait.description, points: [] };

  const series = await buildSignalSeries(db, { userId, sessionRows });
  const points = traitSeriesForSessions(series, sessionRows)[traitKey] || [];
  return {
    key: traitKey,
    label: trait.label,
    description: trait.description,
    points: points.map(p => ({ sessionId: p.sessionId, date: p.startedAt, value: p.value })),
  };
}

// ── "Did targeting actually work?" ────────────────────────────────────────
export async function getTargetingEffectiveness(db, { userId, weakness, sessionType }) {
  if (!weakness) return null;
  const signalKey = hintedSignalFor(weakness);

  const firstTargeted = await db.query(
    `SELECT min(started_at) AS first_targeted_at, count(*) AS times_targeted
     FROM sessions WHERE user_id = $1 AND targeted_weakness = $2 AND ended_at IS NOT NULL ${sessionType ? 'AND session_type = $3' : ''}`,
    sessionType ? [userId, weakness, sessionType] : [userId, weakness],
  );
  const row = firstTargeted.rows[0];
  if (!row?.first_targeted_at) return null;

  const base = { weakness, timesTargeted: Number(row.times_targeted), firstTargetedAt: row.first_targeted_at, signalKey };
  if (!signalKey) return { ...base, trackable: false };

  const allRows = await loadSessionRows(db, { userId, sessionType, limit: 1000 });
  const series = await buildSignalSeries(db, { userId, sessionRows: allRows });
  const points = series[signalKey];
  const cutoff = new Date(row.first_targeted_at);
  const before = points.filter(p => new Date(p.startedAt) < cutoff).map(p => p.value);
  const since = points.filter(p => new Date(p.startedAt) >= cutoff).map(p => p.value);
  if (!before.length || !since.length) return { ...base, trackable: true, insufficientData: true };

  const avgBefore = round(before.reduce((a, b) => a + b, 0) / before.length, 2);
  const avgSince = round(since.reduce((a, b) => a + b, 0) / since.length, 2);
  const cat = SIGNAL_CATALOG[signalKey];
  const deltaPct = pctChange(avgBefore, avgSince);
  const improved = deltaPct === null ? null : (cat.better === 'higher' ? deltaPct > 0 : cat.better === 'lower' ? deltaPct < 0 : Math.abs(avgSince - avgBefore) < Math.abs(avgBefore));

  return { ...base, trackable: true, signalLabel: cat.label, avgBefore, avgSince, deltaPct, improved };
}

// ── Goals ─────────────────────────────────────────────────────────────────
export async function listGoals(db, { userId }) {
  const result = await db.query('SELECT * FROM goals WHERE user_id = $1 ORDER BY active DESC, created_at DESC', [userId]);
  return result.rows;
}

// Goals are always "reach X out of 10 within N sessions" against a trait.
// There is deliberately no direction: every trait is normalised so higher is
// better, which makes "get under" meaningless (nobody wants to lower their
// Eye Contact score). signal_key carries the trait key.
export async function createGoal(db, { userId, traitKey, targetValue, targetSessions, sessionType = null }) {
  if (!TRAIT_CATALOG[traitKey]) throw new HttpError(400, `Unknown trait: ${traitKey}`);
  if (typeof targetValue !== 'number' || !Number.isFinite(targetValue) || targetValue <= 0 || targetValue > 10) {
    throw new HttpError(400, 'targetValue must be a score between 0 and 10.');
  }
  if (targetSessions !== undefined && targetSessions !== null &&
      (!Number.isInteger(targetSessions) || targetSessions < 1 || targetSessions > 200)) {
    throw new HttpError(400, 'targetSessions must be a whole number of sessions between 1 and 200.');
  }
  const result = await db.query(
    `INSERT INTO goals (user_id, signal_key, direction, target_value, target_sessions, session_type)
     VALUES ($1, $2, 'above', $3, $4, $5)
     ON CONFLICT (user_id, signal_key, COALESCE(session_type, '')) WHERE active
     DO UPDATE SET target_value = EXCLUDED.target_value, target_sessions = EXCLUDED.target_sessions,
                   direction = 'above', created_at = NOW(), achieved_at = NULL
     RETURNING *`,
    [userId, traitKey, targetValue, targetSessions ?? null, sessionType],
  );
  return result.rows[0];
}

export async function deactivateGoal(db, { userId, goalId }) {
  const result = await db.query('UPDATE goals SET active = FALSE WHERE goal_id = $1 AND user_id = $2 RETURNING *', [goalId, userId]);
  if (!result.rows[0]) throw new HttpError(404, 'Goal not found.');
  return result.rows[0];
}

// Attaches live progress to each active goal and marks newly-achieved ones.
// Rolling average = last up-to-8-session average for that signal/mode, the
// same "recent trend" window used everywhere else on the Results tab.
async function getGoalsWithProgress(db, { userId, sessionType, allTimeAverages, series, sessionRows = [] }) {
  const goals = await db.query(
    `SELECT * FROM goals WHERE user_id = $1 AND active AND (session_type = $2 OR session_type IS NULL)`,
    [userId, sessionType || null],
  );
  const traitSeries = traitSeriesForSessions(series, sessionRows);
  const out = [];
  for (const goal of goals.rows) {
    const trait = TRAIT_CATALOG[goal.signal_key];
    const points = traitSeries[goal.signal_key] || [];
    // Sessions run since the goal was set -- the clock on "within N sessions".
    const sessionsUsed = sessionRows.filter(r => new Date(r.started_at) > new Date(goal.created_at)).length;
    const sessionsRemaining = goal.target_sessions == null ? null : Math.max(0, goal.target_sessions - sessionsUsed);
    const base = {
      ...goal,
      label: trait?.label ?? goal.signal_key,
      description: trait?.description ?? null,
      sessionsUsed,
      sessionsRemaining,
      expired: sessionsRemaining === 0,
    };

    const recent = points.slice(-8);
    if (!recent.length) { out.push({ ...base, current: null, progressPct: null }); continue; }
    const current = round(recent.reduce((a, p) => a + p.value, 0) / recent.length, 1);
    const achieved = current >= goal.target_value;
    if (achieved && !goal.achieved_at) {
      await db.query('UPDATE goals SET achieved_at = NOW() WHERE goal_id = $1', [goal.goal_id]);
      base.achieved_at = new Date().toISOString();
    }
    // Measured from where the trait stood when the goal was set, so progress
    // reflects movement since committing to it rather than absolute score.
    const atCreation = points.find(p => new Date(p.startedAt) <= new Date(goal.created_at))?.value ?? points[0]?.value ?? current;
    const span = Math.max(0.1, goal.target_value - atCreation);
    const progressPct = Math.max(0, Math.min(100, round(((current - atCreation) / span) * 100, 0)));
    out.push({ ...base, current, progressPct, achieved });
  }
  return out;
}
