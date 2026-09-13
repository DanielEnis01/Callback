// Backboard — semantic memory of what the user actually SAID, across sessions.
//
// Division of labour with Tiger Data: Postgres owns the numbers (23 traits,
// trends, composites, goals) and answers "how has this changed". Backboard
// owns the language and answers "what did he say last time someone asked
// about a team conflict" -- a similarity question Postgres cannot serve.
// Nothing numeric belongs here.
//
// Every call is best-effort. A memory outage must never cost a user their
// session, so failures degrade to "no memory" and the interview proceeds
// exactly as it did before this layer existed.
import * as client from '../integrations/backboard/backboardClient.js';
import { buildMemoryRecords, isWeakAnswer } from './memoryRecords.js';

export { isWeakAnswer };

const isConfigured = () => client.isBackboardConfigured();

function requireUserId(userId) {
  if (typeof userId !== 'string' || !userId.trim() || userId.length > 200) {
    throw Object.assign(new Error('A valid userId is required'), { statusCode: 400 });
  }
}

/** One assistant per user, created lazily on first write. */
async function assistantFor(db, userId, { create = false } = {}) {
  requireUserId(userId);
  const existing = await db.query('SELECT assistant_id FROM backboard_assistants WHERE user_id = $1', [userId]);
  if (existing.rows[0]) return existing.rows[0].assistant_id;
  if (!create) return null;

  const assistant = await client.createUserAssistant(userId);
  const assistantId = assistant?.assistant_id || assistant?.id;
  if (!assistantId) throw new Error('Backboard did not return an assistant ID');
  // Two concurrent syncs could both create one; first writer wins and the
  // loser's assistant is simply unused.
  const saved = await db.query(
    `INSERT INTO backboard_assistants (user_id, assistant_id) VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING RETURNING assistant_id`,
    [userId, assistantId],
  );
  if (saved.rows[0]) return saved.rows[0].assistant_id;
  const winner = await db.query('SELECT assistant_id FROM backboard_assistants WHERE user_id = $1', [userId]);
  return winner.rows[0]?.assistant_id ?? assistantId;
}

/**
 * Backboard's metadata is a remote store's index, not our record.
 *
 * We send a FLAT, scalar-only projection: nested objects (answerScores,
 * traitScores) are the most likely cause of the opaque 500 this endpoint
 * returns, and they buy us nothing remotely -- retrieveMemory hydrates from
 * the local backboard_memories mirror, which keeps the full structure. So
 * the rich metadata stays in Postgres and Backboard gets what it can index.
 */
function flattenMetadata(metadata) {
  const flat = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    if (value === null || value === undefined) continue;
    const type = typeof value;
    if (type === 'string') flat[key] = value.slice(0, 1000);
    else if (type === 'number' && Number.isFinite(value)) flat[key] = value;
    else if (type === 'boolean') flat[key] = value;
    // Objects and arrays are deliberately dropped, not stringified: a JSON
    // blob in a metadata field is not filterable and only adds payload.
  }
  return flat;
}

/**
 * Backboard's memory write returns one of three documented shapes: a memory
 * object ({id}), a batch ({memory_ids}), or -- when the write is queued --
 * an operation handle ({operation_id}). Only the first is what the vendor
 * guide assumed. Poll briefly for the third; the client's own 250ms throttle
 * already paces these, so this costs well under a second in the worst case.
 */
async function resolveMemoryId(result) {
  const direct = result?.id || result?.memory_id || result?.memory?.id
    || (Array.isArray(result?.memory_ids) ? result.memory_ids[0] : null);
  if (direct) return direct;

  const operationId = result?.operation_id || result?.operationId;
  if (!operationId) return null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const status = await client.getMemoryOperationStatus(operationId);
      const ids = status?.memory_ids;
      if (Array.isArray(ids) && ids[0]) return ids[0];
      if (status?.status && !['pending', 'processing', 'queued'].includes(String(status.status).toLowerCase())) return null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Write one memory, exactly once.
 *
 * The receipt row is claimed with ON CONFLICT DO NOTHING before the network
 * call, so a retry (or a second concurrent sync) can never write the same
 * record twice. A claim whose write then fails transiently is left in place
 * and reconciled on the next attempt rather than blindly re-sent.
 */
async function storeMemory(db, { userId, content, metadata }) {
  requireUserId(userId);
  if (!content?.trim() || metadata?.userId !== userId
      || !['qa_pair', 'session_note'].includes(metadata?.kind) || !metadata.externalId) {
    throw Object.assign(new Error('A structured, user-owned memory is required'), { statusCode: 400 });
  }

  const key = metadata.externalId;
  const existing = await db.query(
    'SELECT memory_id, stored_at FROM backboard_memories WHERE user_id = $1 AND external_id = $2', [userId, key],
  );
  // stored_at, not memory_id, is the "did this reach Backboard" signal: an
  // async write can succeed and hand back an operation id instead of a
  // memory id, and re-sending that would duplicate the memory.
  if (existing.rows[0]?.stored_at) return { status: 'already_synced', id: existing.rows[0].memory_id };

  if (!existing.rows[0]) {
    const claimed = await db.query(
      `INSERT INTO backboard_memories (user_id, external_id, session_id, kind, metadata)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, external_id) DO NOTHING RETURNING external_id`,
      [userId, key, metadata.sessionId ?? null, metadata.kind, JSON.stringify(metadata)],
    );
    if (!claimed.rows[0]) return { status: 'pending_reconciliation' };
  }

  const assistantId = await assistantFor(db, userId, { create: true });
  let result;
  try {
    result = await client.addCoachingMemory(assistantId, content, flattenMetadata(metadata));
  } catch (err) {
    // Last resort: the embedded content is what search actually matches on,
    // and every field we retrieve by lives in our own table. So rather than
    // lose the memory entirely to a metadata Backboard won't accept, write
    // it bare. A memory with no remote metadata is still fully usable here.
    if (err?.status >= 400) {
      console.warn(`[backboard] write rejected with metadata (${err.status}); retrying content-only.`);
      result = await client.addCoachingMemory(assistantId, content, {});
    } else {
      throw err;
    }
  }
  const memoryId = await resolveMemoryId(result);

  // A write with no resolvable id still happened -- stamping stored_at stops
  // a retry from duplicating it. Retrieval falls back to the metadata the
  // search endpoint returns for these, so they are not lost.
  await db.query(
    `UPDATE backboard_memories SET memory_id = $1, metadata = $2, stored_at = NOW()
     WHERE user_id = $3 AND external_id = $4`,
    [memoryId ?? null, JSON.stringify(metadata), userId, key],
  );
  return memoryId ? { status: 'stored', id: memoryId } : { status: 'stored_without_id' };
}

/**
 * Semantic search, scoped to one user.
 *
 * Backboard's search returns id/content/score but NO metadata. The vendor's
 * answer is to page through every memory the user owns on every search --
 * which the lifecycle calls once per plan plus once per answer, so a
 * five-answer session would trigger six full crawls. We mirror metadata into
 * backboard_memories at write time instead, making hydration a local join.
 */
async function retrieveMemory(db, { userId, query, kind = 'qa_pair', excludeSessionId, limit = 10, weakOnly = false }) {
  requireUserId(userId);
  if (typeof query !== 'string' || !query.trim()) {
    throw Object.assign(new Error('A query string is required'), { statusCode: 400 });
  }
  if (!isConfigured()) return { memories: [], reason: 'not_configured' };

  const assistantId = await assistantFor(db, userId);
  if (!assistantId) return { memories: [], reason: 'no_memories_yet' };

  const search = await client.searchMemories(assistantId, query.slice(0, 2000), client.MAX_MEMORY_SEARCH_RESULTS);
  const hits = search?.memories ?? [];
  if (!hits.length) return { memories: [] };

  const ids = hits.map((m) => m.id || m.memory_id).filter(Boolean);
  if (!ids.length) return { memories: [] };
  const local = await db.query(
    `SELECT memory_id, metadata FROM backboard_memories
     WHERE user_id = $1 AND memory_id = ANY($2::text[]) AND kind = $3
       ${excludeSessionId ? 'AND (session_id IS NULL OR session_id <> $4)' : ''}`,
    excludeSessionId ? [userId, ids, kind, excludeSessionId] : [userId, ids, kind],
  );
  const byId = new Map(local.rows.map((row) => [row.memory_id, row.metadata]));

  // Prefer the local mirror; fall back to whatever metadata search itself
  // returned, which covers memories whose id never came back to us (async
  // writes). The userId check below is the tenancy guard either way, and the
  // per-user assistant boundary sits in front of both.
  const memories = hits
    .map((hit) => ({ ...hit, metadata: byId.get(hit.id || hit.memory_id) ?? hit.metadata }))
    // A hit with no local row is either another tenant's or one we never
    // wrote. Dropping it is the tenancy backstop behind the assistant boundary.
    .filter((hit) => hit.metadata && hit.metadata.userId === userId)
    .filter((hit) => !weakOnly || isWeakAnswer(hit));

  return { memories: memories.slice(0, limit), candidates: hits.length };
}

/** Most recent coaching notes, newest first. Read locally -- these are
 *  chronological, not semantic, so there is nothing to search for. */
async function recentNotes(db, userId, limit = 3) {
  requireUserId(userId);
  if (!isConfigured()) return [];
  const result = await db.query(
    `SELECT metadata FROM backboard_memories
     WHERE user_id = $1 AND kind = 'session_note' AND stored_at IS NOT NULL
     ORDER BY stored_at DESC LIMIT $2`,
    [userId, Math.max(1, Math.min(limit, 10))],
  );
  return result.rows.map((row) => row.metadata).filter(Boolean);
}

/** Assembles the flat session shape buildMemoryRecords expects. This app
 *  keeps the pieces in three tables; the vendor guide assumed one object. */
async function loadSessionForMemory(db, { userId, sessionId }) {
  const result = await db.query(
    `SELECT s.session_id, s.user_id, s.started_at, s.targeted_weakness, s.job_posting_text,
            s.position_label, s.interview_plan,
            a.transcript, a.static_signals, a.ai_summary, a.ai_strengths, a.ai_weaknesses, a.memory_synced_at
     FROM sessions s
     LEFT JOIN session_ai_analysis a ON a.session_id = s.session_id AND a.user_id = s.user_id
     WHERE s.session_id = $1 AND s.user_id = $2`,
    [sessionId, userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    startedAt: row.started_at,
    targetedWeakness: row.targeted_weakness,
    jobPostingText: row.job_posting_text,
    positionLabel: row.position_label,
    interviewPlan: row.interview_plan,
    transcript: row.transcript,
    memorySyncedAt: row.memory_synced_at,
    analysis: row.static_signals
      ? {
          staticSignals: row.static_signals,
          summary: row.ai_summary,
          strengths: row.ai_strengths ?? [],
          weaknesses: row.ai_weaknesses ?? [],
        }
      : null,
  };
}

/** Push one completed session's language to Backboard. Idempotent, and
 *  swallows every failure -- the saved session is never at risk. */
async function syncSession(db, { userId, sessionId, compositeScore = null, traitScores = null }) {
  if (!isConfigured()) return { status: 'skipped', reason: 'not_configured' };
  try {
    const session = await loadSessionForMemory(db, { userId, sessionId });
    if (!session) return { status: 'skipped', reason: 'session_not_found' };
    if (session.memorySyncedAt) return { status: 'already_synced', syncedAt: session.memorySyncedAt };
    if (session.analysis) {
      session.analysis.compositeScore = compositeScore;
      session.analysis.traitScores = traitScores;
    }

    const { records, reason } = buildMemoryRecords(session);
    if (!records.length) return { status: 'skipped', reason };

    for (const record of records) {
      const result = await storeMemory(db, { userId, ...record });
      if (!result.id && result.status !== 'already_synced') {
        return { status: 'pending_reconciliation', reason: result.status };
      }
    }
    const syncedAt = new Date().toISOString();
    await db.query(
      'UPDATE session_ai_analysis SET memory_synced_at = $1 WHERE session_id = $2 AND user_id = $3',
      [syncedAt, sessionId, userId],
    );
    return { status: 'synced', count: records.length, syncedAt };
  } catch (error) {
    console.warn('[backboard] sync failed (session is safe):', error.message);
    return { status: 'unavailable', reason: 'Memory sync failed; the saved session is safe.' };
  }
}

export { assistantFor, storeMemory, retrieveMemory, recentNotes, syncSession, loadSessionForMemory, isConfigured };
