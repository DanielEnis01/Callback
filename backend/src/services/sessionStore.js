import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// The local adapter is deliberately single-process and development-only.
// Postgres serializes each user's mutations with a transaction advisory lock.
export function createSessionStore({ filename, pool } = {}) {
  let queue = Promise.resolve();
  const blank = () => ({ sessions: {}, assistantId: null, records: {} });
  async function transaction(userId, fn) {
    if (pool) {
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [userId]);
        const { rows } = await db.query("SELECT state FROM callback_memory_users WHERE user_id = $1", [userId]);
        const state = rows[0]?.state ?? blank();
        const saved = await db.query(`SELECT s.*, a.transcript, a.analysis, a.memory_synced_at
          FROM sessions s LEFT JOIN session_ai_analysis a USING(session_id) WHERE s.user_id=$1`, [userId]);
        state.sessions = Object.fromEntries(saved.rows.map((row) => [row.session_id, {
          ...state.sessionExtras?.[row.session_id], sessionId: row.session_id, userId,
          startedAt: new Date(row.started_at).toISOString(), jobPostingText: row.job_posting_text,
          positionLabel: row.position_label, sessionType: row.session_type, targetedWeakness: row.targeted_weakness,
          interviewPlan: row.interview_plan, transcript: row.transcript || [],
          analysis: row.analysis?.source ? row.analysis : null,
          memorySyncedAt: row.memory_synced_at ? new Date(row.memory_synced_at).toISOString() : null,
        }]));
        const result = await fn(state);
        const { sessions, ...userState } = state;
        userState.sessionExtras = Object.fromEntries(Object.values(sessions).map((session) => [session.sessionId, {
          seedVersion: session.seedVersion, seedIndex: session.seedIndex, analysisStartedAt: session.analysisStartedAt,
        }]));
        await db.query("INSERT INTO callback_memory_users(user_id,state) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET state=EXCLUDED.state", [userId, userState]);
        for (const session of Object.values(state.sessions)) {
          await db.query(`INSERT INTO sessions(session_id,user_id,started_at,job_posting_text,position_label,session_type,targeted_weakness,interview_plan)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(session_id) DO UPDATE SET interview_plan=EXCLUDED.interview_plan,
            started_at=EXCLUDED.started_at, job_posting_text=EXCLUDED.job_posting_text, position_label=EXCLUDED.position_label,
            session_type=EXCLUDED.session_type, targeted_weakness=EXCLUDED.targeted_weakness`,
          [session.sessionId, userId, session.startedAt, session.jobPostingText, session.positionLabel, session.sessionType, session.targetedWeakness, JSON.stringify(session.interviewPlan)]);
          await db.query(`INSERT INTO session_ai_analysis(session_id,transcript,static_signals,analysis,memory_synced_at)
            VALUES($1,$2,$3,$4,$5) ON CONFLICT(session_id) DO UPDATE SET transcript=EXCLUDED.transcript,static_signals=EXCLUDED.static_signals,analysis=EXCLUDED.analysis,memory_synced_at=EXCLUDED.memory_synced_at`,
          [session.sessionId, JSON.stringify(session.transcript), session.analysis?.staticSignals || {}, session.analysis || {}, session.memorySyncedAt]);
        }
        await db.query("COMMIT");
        return structuredClone(result);
      } catch (error) { await db.query("ROLLBACK"); throw error; }
      finally { db.release(); }
    }
    const operation = queue.catch(() => {}).then(async () => {
      let data = {};
      if (filename) {
        try { data = JSON.parse(await readFile(filename, "utf8")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      } else data = memory;
      const key = `user:${userId}`;
      const state = structuredClone(data[key] ?? blank());
      const result = await fn(state);
      data[key] = state;
      if (filename) {
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(`${filename}.tmp`, JSON.stringify(data), { mode: 0o600 });
        await rename(`${filename}.tmp`, filename);
      } else memory = data;
      return structuredClone(result);
    });
    queue = operation;
    return operation;
  }
  let memory = {};
  return {
    transaction,
    getSession: (userId, id) => transaction(userId, (state) => Object.hasOwn(state.sessions, id) ? state.sessions[id] : null),
    listSessions: (userId) => transaction(userId, (state) => Object.values(state.sessions).sort((a, b) => b.startedAt.localeCompare(a.startedAt))),
  };
}

let defaultStore;
export async function getSessionStore() {
  if (!defaultStore) defaultStore = (async () => {
    if (process.env.DATABASE_URL) {
      const { Pool } = await import("pg");
      return createSessionStore({ pool: new Pool({ connectionString: process.env.DATABASE_URL }) });
    }
    if (process.env.NODE_ENV === "production") throw Object.assign(new Error("DATABASE_URL is required"), { statusCode: 503 });
    return createSessionStore({ filename: process.env.CALLBACK_DATA_FILE || new URL("../../.data/sessions.json", import.meta.url).pathname });
  })();
  return defaultStore;
}
