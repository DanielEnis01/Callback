// Persistence for the AI transcript-analysis pipeline (python/analysis_service.py's
// static STAR/quantification/filler-word signals + Gemini's qualitative pass — see
// gemini.js's generateTranscriptAnalysis). Deliberately separate from
// sessionAnalysis.js's session_results table: that one is the non-AI biometric
// comparison against baseline/recent sessions, this is the language/content side.
// Safe to call more than once for the same session -- replaces the previous result.
import { HttpError } from '../errors.js';

// node-postgres only auto-serializes plain OBJECTS to JSON for jsonb columns
// (see pg's lib/utils.js prepareValue -> prepareObject). A top-level JS
// ARRAY takes a different path (arrayString) that produces a Postgres
// array-literal ('{"a","b"}'), not a JSON array ('["a","b"]") -- which then
// fails jsonb's own input parser ("invalid input syntax for type json").
// ai_strengths/ai_weaknesses are plain string arrays, so they must be
// JSON.stringify'd explicitly; staticSignals is a plain object so it would
// serialize correctly either way, but stringifying everything bound for a
// jsonb column here removes the ambiguity for future columns/edits.
const toJsonbParam = (value) => (value === null || value === undefined ? null : JSON.stringify(value));

export async function saveTranscriptAnalysis(db, { sessionId, userId, staticSignals, aiAnalysis, aiError, transcript }) {
  const owned = await db.query('SELECT 1 FROM sessions WHERE session_id = $1 AND user_id = $2', [sessionId, userId]);
  if (!owned.rows.length) throw new HttpError(404, 'Session not found.');

  const result = await db.query(
    `INSERT INTO session_ai_analysis (session_id, user_id, static_signals, ai_strengths, ai_weaknesses, ai_summary, overall_score, ai_error, transcript, session_title, progress_notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (session_id) DO UPDATE SET
       computed_at = NOW(), static_signals = EXCLUDED.static_signals, ai_strengths = EXCLUDED.ai_strengths,
       ai_weaknesses = EXCLUDED.ai_weaknesses, ai_summary = EXCLUDED.ai_summary,
       overall_score = EXCLUDED.overall_score, ai_error = EXCLUDED.ai_error,
       transcript = COALESCE(EXCLUDED.transcript, session_ai_analysis.transcript),
       session_title = COALESCE(EXCLUDED.session_title, session_ai_analysis.session_title),
       progress_notes = COALESCE(EXCLUDED.progress_notes, session_ai_analysis.progress_notes)
     RETURNING *`,
    [
      sessionId, userId, toJsonbParam(staticSignals),
      toJsonbParam(aiAnalysis?.strengths ?? null), toJsonbParam(aiAnalysis?.weaknesses ?? null), toJsonbParam(aiAnalysis?.summary ?? null),
      aiAnalysis?.overallScore ?? null, aiError ?? null, toJsonbParam(transcript ?? null),
      aiAnalysis?.title ?? null, toJsonbParam(aiAnalysis?.progressNotes ?? null),
    ],
  );
  return result.rows[0];
}

export async function getTranscriptAnalysis(db, { sessionId, userId }) {
  const result = await db.query('SELECT * FROM session_ai_analysis WHERE session_id = $1 AND user_id = $2', [sessionId, userId]);
  return result.rows[0] || null;
}
