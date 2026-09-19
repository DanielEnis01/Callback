// Turns one session's raw session_metrics rows into a stored, honest
// comparison against (a) the user's calibrated baseline and (b) their own
// recent sessions. No AI call, no invented scoring rules: every number here
// is either a plain average of recorded samples or a plain percent delta
// between two of those averages. A signal that was never recorded simply
// does not appear — it is never treated as 0.
import { HttpError } from '../errors.js';

// Which session_metrics columns are eligible for strength/weakness scoring,
// which direction counts as "better", and (where one exists) which
// baselines column it's compared against. Signals with no baseline field
// still get scored against the user's own recent-session trend.
// 'lower' / 'higher': that direction is better. 'closer': smaller distance
// from baseline is better (used for signals with no inherent good direction).
export const SCORED_SIGNALS = {
  nervousness_score: { better: 'lower', baselineField: null },
  stress_index_baevsky: { better: 'lower', baselineField: 'baseline_stress_index' },
  pulse_rate: { better: 'lower', baselineField: 'baseline_pulse' },
  breathing_rate: { better: 'lower', baselineField: 'baseline_breathing_rate' },
  breathing_amplitude: { better: 'closer', baselineField: 'baseline_breathing_amplitude' },
  fidget_score_seat: { better: 'lower', baselineField: 'baseline_fidget_score' },
  fidget_score_knee: { better: 'lower', baselineField: null },
  eda_level: { better: 'lower', baselineField: 'baseline_eda' },
  rmssd: { better: 'higher', baselineField: null },
  sdnn: { better: 'higher', baselineField: null },
  // Populated by the on-device MediaPipe pipeline in SessionMeeting.tsx.
  posture_stability_score: { better: 'higher', baselineField: null },
  gaze_away_seconds: { better: 'lower', baselineField: null },
};

const FLAT_THRESHOLD_PCT = 5; // deltas smaller than this read as "about the same", not better/worse

const LABELS = {
  nervousness_score: 'visible nervousness proxy',
  stress_index_baevsky: 'stress index', pulse_rate: 'pulse rate', breathing_rate: 'breathing rate',
  breathing_amplitude: 'breathing amplitude', fidget_score_seat: 'seat fidgeting', fidget_score_knee: 'knee fidgeting',
  eda_level: 'skin conductance', rmssd: 'HRV (RMSSD)', sdnn: 'HRV (SDNN)',
  posture_stability_score: 'posture stability', gaze_away_seconds: 'time looking away',
};

function round(n, digits = 1) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// direction of `value` vs `reference` for a signal whose "better" is given.
// Returns { deltaPct, direction } or null if reference is 0 (delta undefined).
function compare(value, reference, better) {
  if (reference === 0) return null;
  if (better === 'closer') {
    const deltaPct = (Math.abs(value - reference) / Math.abs(reference)) * 100;
    return { deltaPct: round(deltaPct), direction: deltaPct <= FLAT_THRESHOLD_PCT ? 'flat' : 'worse' };
  }
  const rawPct = ((value - reference) / Math.abs(reference)) * 100;
  const improved = better === 'lower' ? rawPct < 0 : rawPct > 0;
  const direction = Math.abs(rawPct) <= FLAT_THRESHOLD_PCT ? 'flat' : improved ? 'better' : 'worse';
  return { deltaPct: round(rawPct), direction };
}

/**
 * Compute and store the analysis for one session. Safe to call more than
 * once for the same session (e.g. re-run after more samples arrive) —
 * replaces the previous result rather than duplicating it.
 */
export async function computeSessionAnalysis(db, { sessionId, userId }) {
  const session = await db.query('SELECT 1 FROM sessions WHERE session_id = $1 AND user_id = $2', [sessionId, userId]);
  if (!session.rows.length) throw new HttpError(404, 'Session not found.');

  const signalCols = Object.keys(SCORED_SIGNALS);
  const avgSelect = signalCols.map(c => `AVG(${c}) AS ${c}`).join(', ');
  const countResult = await db.query(
    `SELECT count(*) AS sample_count, ${avgSelect} FROM session_metrics WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId],
  );
  const row = countResult.rows[0];
  const sampleCount = Number(row.sample_count);
  if (sampleCount === 0) throw new HttpError(400, 'No recorded signals for this session yet.');

  const signalAverages = {};
  for (const col of signalCols) {
    if (row[col] !== null) signalAverages[col] = round(Number(row[col]), 3);
  }

  const baselineResult = await db.query(
    'SELECT * FROM baselines WHERE user_id = $1 ORDER BY captured_at DESC LIMIT 1',
    [userId],
  );
  const baseline = baselineResult.rows[0] || null;

  const priorResult = await db.query(
    `SELECT signal_averages FROM session_results WHERE user_id = $1 AND session_id <> $2 ORDER BY computed_at DESC LIMIT 5`,
    [userId, sessionId],
  );
  const priorAverages = {};
  for (const col of signalCols) {
    const values = priorResult.rows.map(r => r.signal_averages?.[col]).filter(v => typeof v === 'number');
    if (values.length) priorAverages[col] = values.reduce((a, b) => a + b, 0) / values.length;
  }

  const baselineDeltas = {};
  const trend = {};
  for (const [signal, value] of Object.entries(signalAverages)) {
    const { better, baselineField } = SCORED_SIGNALS[signal];
    if (baselineField && baseline?.[baselineField] != null) {
      const result = compare(value, Number(baseline[baselineField]), better);
      if (result) baselineDeltas[signal] = result;
    }
    if (priorAverages[signal] !== undefined) {
      const result = compare(value, priorAverages[signal], better);
      if (result) trend[signal] = result;
    }
  }

  // A signal is a strength/weakness candidate if either comparison agrees;
  // baseline wins when both exist since it's the more meaningful reference.
  const verdicts = [];
  for (const signal of Object.keys(signalAverages)) {
    const source = baselineDeltas[signal] ? { ...baselineDeltas[signal], via: 'baseline' } : trend[signal] ? { ...trend[signal], via: 'trend' } : null;
    if (source && source.direction !== 'flat') verdicts.push({ signal, ...source });
  }
  verdicts.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
  const describe = v => `${LABELS[v.signal] || v.signal} ${v.direction === 'better' ? 'improved' : 'declined'} ${Math.abs(v.deltaPct)}% vs your ${v.via === 'baseline' ? 'calibrated baseline' : 'recent sessions'}.`;
  const strengths = verdicts.filter(v => v.direction === 'better').slice(0, 3).map(v => ({ signal: v.signal, detail: describe(v) }));
  const weaknesses = verdicts.filter(v => v.direction === 'worse').slice(0, 3).map(v => ({ signal: v.signal, detail: describe(v) }));

  const compared = verdicts.length;
  const overallScore = compared ? round((verdicts.filter(v => v.direction === 'better').length / compared) * 100, 0) : null;

  const result = await db.query(
    `INSERT INTO session_results (session_id, user_id, sample_count, signal_averages, baseline_deltas, trend, strengths, weaknesses, overall_score)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (session_id) DO UPDATE SET
       computed_at = NOW(), sample_count = EXCLUDED.sample_count, signal_averages = EXCLUDED.signal_averages,
       baseline_deltas = EXCLUDED.baseline_deltas, trend = EXCLUDED.trend, strengths = EXCLUDED.strengths,
       weaknesses = EXCLUDED.weaknesses, overall_score = EXCLUDED.overall_score
     RETURNING *`,
    [sessionId, userId, sampleCount, JSON.stringify(signalAverages), JSON.stringify(baselineDeltas), JSON.stringify(trend), JSON.stringify(strengths), JSON.stringify(weaknesses), overallScore],
  );
  return result.rows[0];
}
