import type { MetricValues } from "./sessionRecorder";

export type StoredSession = {
  session_id: string;
  session_type: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  metrics: MetricValues[];
};

const key = "callback.static.sessions.v1";

function read(): StoredSession[] {
  try { return JSON.parse(localStorage.getItem(key) || "[]") as StoredSession[]; }
  catch { return []; }
}

function write(sessions: StoredSession[]) {
  localStorage.setItem(key, JSON.stringify(sessions));
}

/** Local-only equivalent of the small session API used before Firebase exists. */
export async function staticDataRequest<T>(path: string, body?: any, method = "POST"): Promise<T> {
  const sessions = read();
  if (path === "/sessions" && method === "POST") {
    const existing = sessions.find(session => session.session_id === body.session_id);
    if (existing) return existing as T;
    const session: StoredSession = { ...body, ended_at: null, duration_seconds: null, metrics: [] };
    sessions.unshift(session); write(sessions); return session as T;
  }
  if (path === "/session-metrics" && method === "POST") {
    const session = sessions.find(item => item.session_id === body.session_id);
    if (!session) throw new Error("Start calibration before recording a session.");
    if (!session.metrics.some(item => item.recorded_at === body.recorded_at)) session.metrics.push(body);
    write(sessions); return body as T;
  }
  if (path.startsWith("/sessions/") && method === "PATCH") {
    const id = path.split("/").at(-1);
    const session = sessions.find(item => item.session_id === id);
    if (!session) throw new Error("Session is unavailable.");
    session.ended_at = body.ended_at;
    session.duration_seconds = Math.max(0, (Date.parse(body.ended_at) - Date.parse(session.started_at)) / 1000);
    write(sessions); return session as T;
  }
  throw new Error("This action is not available in static mode.");
}

export function getStaticSessions() { return read(); }
