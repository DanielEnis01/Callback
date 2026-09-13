import express from 'express';
import crypto from 'node:crypto';
import { asyncRoute, HttpError } from '../errors.js';
import { ensureUser } from '../services/tigerdata.js';
import { pagination, requireUuid } from './documents.js';
import { computeSessionAnalysis } from '../services/sessionAnalysis.js';
import { getTranscriptAnalysis } from '../services/transcriptAnalysisStore.js';

const baselineFields = 'baseline_stress_index baseline_pulse baseline_breathing_rate baseline_blink_rate baseline_fidget_score baseline_eda baseline_arterial_pressure baseline_breathing_amplitude baseline_inhale_exhale_ratio'.split(' ');
const metricFields = 'filler_word_count filler_word_rate speaking_rate_wpm pause_frequency avg_pause_duration topic_relevance_score gaze_away_seconds posture_stability_score dominant_emotion emotion_breakdown stress_index_baevsky rmssd sdnn mean_nn pulse_rate breathing_rate blink_rate apnea_event_count fidget_score_seat fidget_score_knee eda_level arterial_pressure_relative breathing_upper_lower_ratio inhale_exhale_ratio respiratory_line_length breathing_amplitude consistency_confidence_score overall_session_score'.split(' ');
const resources = {
  resumes: { table: 'resumes', order: 'uploaded_at DESC, resume_id' },
  'job-postings': { table: 'job_postings', order: 'uploaded_at DESC, job_posting_id' },
  baselines: { table: 'baselines', order: 'captured_at DESC, baseline_id', fields: ['baseline_id', 'captured_at', 'raw_data', ...baselineFields] },
  sessions: { table: 'sessions', order: 'started_at DESC, session_id', fields: ['session_id', 'job_posting_id', 'session_type', 'targeted_weakness', 'job_posting_text', 'started_at', 'ended_at'] },
  'session-metrics': { table: 'session_metrics', order: 'recorded_at DESC, session_id', fields: ['session_id', 'recorded_at', ...metricFields] },
  // No `fields`: this skips the generic POST route below. Results are only
  // ever written by computeSessionAnalysis, via POST /sessions/:id/analyze.
  'session-results': { table: 'session_results', order: 'computed_at DESC, session_id' },
};
function validateFields(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length) throw new HttpError(400, 'Send a nonempty JSON object.');
  for (const [key, value] of Object.entries(body)) {
    if (!fields.includes(key)) throw new HttpError(400, `Unknown or read-only field: ${key}`);
    if (value === null) continue;
    if (key.endsWith('_id')) { requireUuid(value); continue; }
    if (key.endsWith('_at')) {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new HttpError(400, `Use an ISO timestamp with timezone for ${key}.`);
    } else if (['session_type', 'targeted_weakness', 'dominant_emotion'].includes(key)) {
      if (typeof value !== 'string' || value.length > 500) throw new HttpError(400, `${key} must be text of at most 500 characters.`);
    } else if (key === 'job_posting_text') {
      // A pasted job posting, not a short label -- allow a real posting's
      // worth of text (still well under the route's 256kb JSON body cap).
      if (typeof value !== 'string' || value.length > 20000) throw new HttpError(400, `${key} must be text of at most 20000 characters.`);
    } else if (key === 'raw_data') {
      if (typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'raw_data must be an object.');
    } else if (key === 'emotion_breakdown') {
      if (typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new HttpError(400, 'emotion_breakdown must map emotion names to numeric values.');
    } else if (typeof value !== 'number' || !Number.isFinite(value) || (key.endsWith('_count') && !Number.isInteger(value))) throw new HttpError(400, `${key} must be a finite${key.endsWith('_count') ? ' integer' : ''} number.`);
  }
}
export function createDataRouter(db) {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));
  router.get('/profile', asyncRoute(async (req, res) => {
    await ensureUser(db, req.user);
    const result = await db.query('SELECT * FROM user_summary WHERE user_id = $1', [req.user.userId]);
    res.json(result.rows[0]);
  }));
  router.patch('/profile', asyncRoute(async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['name', 'targetRoles', 'jobPosting', 'resume'].includes(k)) || typeof body.name !== 'string' || typeof body.targetRoles !== 'string' || (body.jobPosting !== undefined && body.jobPosting !== null && typeof body.jobPosting !== 'string')) throw new HttpError(400, 'Invalid interview profile.');
    await ensureUser(db, req.user);
    await db.query('UPDATE users SET interview_profile = $1 WHERE user_id = $2', [body, req.user.userId]);
    res.json(body);
  }));
  router.get('/interview-profile', asyncRoute(async (req, res) => {
    const result = await db.query('SELECT interview_profile FROM users WHERE user_id = $1', [req.user.userId]);
    res.json(result.rows[0]?.interview_profile || null);
  }));
  // Sessions get a dedicated GET (below) that also carries each session's
  // overall_score -- the Sessions tab needs that column and it doesn't live
  // on the sessions table itself (see session_results / sessionAnalysis.js).
  router.get('/sessions', asyncRoute(async (req, res) => {
    const page = pagination(req.query);
    const result = await db.query(
      `SELECT s.*, sr.overall_score
       FROM sessions s LEFT JOIN session_results sr ON sr.session_id = s.session_id
       WHERE s.user_id = $1 ORDER BY s.started_at DESC, s.session_id LIMIT $2 OFFSET $3`,
      [req.user.userId, page.limit, page.offset],
    );
    res.json({ records: result.rows, ...page });
  }));
  for (const [path, spec] of Object.entries(resources)) {
    if (path !== 'sessions') router.get(`/${path}`, asyncRoute(async (req, res) => {
      const page = pagination(req.query);
      const values = [req.user.userId, page.limit, page.offset];
      let filter = '';
      if (path === 'session-metrics' && req.query.sessionId !== undefined) { values.push(requireUuid(req.query.sessionId)); filter = ' AND session_id = $4'; }
      const result = await db.query(`SELECT * FROM ${spec.table} WHERE user_id = $1${filter} ORDER BY ${spec.order} LIMIT $2 OFFSET $3`, values);
      res.json({ records: result.rows, ...page });
    }));
    if (!spec.fields) continue;
    router.post(`/${path}`, asyncRoute(async (req, res) => {
      validateFields(req.body, spec.fields);
      const idKey = spec.table === 'baselines' ? 'baseline_id' : spec.table === 'sessions' ? 'session_id' : null;
      const keys = Object.keys(req.body).filter(k => k !== idKey);
      if (path === 'sessions' && !['interview', 'focus'].includes(req.body.session_type)) throw new HttpError(400, 'Choose interview or focus.');
      if (path === 'session-metrics' && !req.body.session_id) throw new HttpError(400, 'session_id is required.');
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await ensureUser(client, req.user);
        if (req.body.job_posting_id) {
          const owned = await client.query('SELECT 1 FROM job_postings WHERE job_posting_id = $1 AND user_id = $2', [req.body.job_posting_id, req.user.userId]);
          if (!owned.rows.length) throw new HttpError(400, 'Job posting is unavailable.');
        }
        if (path === 'session-metrics') {
          const owned = await client.query('SELECT 1 FROM sessions WHERE session_id = $1 AND user_id = $2', [req.body.session_id, req.user.userId]);
          if (!owned.rows.length) throw new HttpError(400, 'Session is unavailable.');
        }
        const generatedId = spec.table === 'baselines' ? ['baseline_id', req.body.baseline_id || crypto.randomUUID()]
          : spec.table === 'sessions' ? ['session_id', req.body.session_id || crypto.randomUUID()] : null;
        const insertKeys = generatedId ? [generatedId[0], 'user_id', ...keys] : ['user_id', ...keys];
        const values = generatedId ? [generatedId[1], req.user.userId, ...keys.map(k => req.body[k])] : [req.user.userId, ...keys.map(k => req.body[k])];
        const result = await client.query(`INSERT INTO ${spec.table} (${insertKeys.join(', ')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT DO NOTHING RETURNING *`, values);
        let record = result.rows[0];
        if (!record) {
          const replay = generatedId
            ? await client.query(`SELECT * FROM ${spec.table} WHERE ${generatedId[0]} = $1 AND user_id = $2`, [generatedId[1], req.user.userId])
            : await client.query('SELECT * FROM session_metrics WHERE session_id = $1 AND recorded_at = $2 AND user_id = $3', [req.body.session_id, req.body.recorded_at, req.user.userId]);
          record = replay.rows[0];
          if (!record) throw new HttpError(409, 'Record ID is unavailable.');
        }
        await client.query('COMMIT');
        res.status(result.rows.length ? 201 : 200).json(record);
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }));
  }
  router.patch('/sessions/:sessionId', asyncRoute(async (req, res) => {
    validateFields(req.body, ['ended_at']);
    if (!req.body.ended_at) throw new HttpError(400, 'ended_at is required.');
    const result = await db.query('UPDATE sessions SET ended_at = $1 WHERE session_id = $2 AND user_id = $3 RETURNING *', [req.body.ended_at, requireUuid(req.params.sessionId), req.user.userId]);
    if (!result.rows[0]) throw new HttpError(404, 'Session not found.');
    res.json(result.rows[0]);
  }));
  // Computes (or recomputes) this session's stored comparison against the
  // user's baseline and their own recent sessions. See sessionAnalysis.js —
  // nothing here is AI-generated or invented, only averages and deltas of
  // real recorded values.
  router.post('/sessions/:sessionId/analyze', asyncRoute(async (req, res) => {
    const result = await computeSessionAnalysis(db, { sessionId: requireUuid(req.params.sessionId), userId: req.user.userId });
    res.json(result);
  }));
  // The AI half of session analysis (STAR/quantification/filler-word static
  // signals + Gemini's qualitative pass) -- see services.js's POST
  // /api/services/analysis/transcript, which is what actually computes and
  // stores this. Read-only here, same as session-results above. Returns
  // null (not 404) when nothing has been computed for this session yet, so
  // the summary view can just check for a null result rather than catch.
  router.get('/sessions/:sessionId/ai-analysis', asyncRoute(async (req, res) => {
    const result = await getTranscriptAnalysis(db, { sessionId: requireUuid(req.params.sessionId), userId: req.user.userId });
    res.json(result);
  }));
  return router;
}
