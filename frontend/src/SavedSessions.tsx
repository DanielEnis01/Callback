import { useEffect, useState } from 'react';
import { dataRequest } from './dataApi';

type Session = { session_id: string; session_type: string; started_at: string; ended_at: string | null; duration_seconds: number | null };
export default function SavedSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState('');
  const [metrics, setMetrics] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    let current = true;
    setLoading(true); setError(''); setSessions([]); setSelected(''); setMetrics([]);
    dataRequest<{ records: Session[] }>(`/sessions?limit=25&offset=${offset}`)
      .then(data => { if (current) setSessions(data.records); })
      .catch(error => { if (current) setError(error.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [offset]);
  useEffect(() => {
    if (!selected) return;
    let current = true;
    setMetrics([]); setError('');
    dataRequest<{ records: Record<string, unknown>[] }>(`/session-metrics?sessionId=${encodeURIComponent(selected)}&limit=100`)
      .then(data => { if (current) setMetrics(data.records); })
      .catch(error => { if (current) setError(error.message); });
    return () => { current = false; };
  }, [selected]);
  return <section className="space-y-5">
    <h1 className="text-3xl font-bold">Saved sessions</h1>
    {error && <p role="alert" className="text-red-200">{error}</p>}
    {loading ? <p>Loading…</p> : !sessions.length ? <p>No saved sessions yet.</p> : sessions.map(session => <button key={session.session_id} onClick={() => setSelected(session.session_id)} className="block w-full border border-white/20 p-4 text-left">
      {new Date(session.started_at).toLocaleString()} · {session.session_type} · {session.ended_at ? `${Math.round(session.duration_seconds || 0)} seconds` : 'Open / interrupted'}
    </button>)}
    <div className="flex gap-4"><button disabled={!offset || loading} onClick={() => setOffset(offset - 25)}>Previous</button><button disabled={sessions.length < 25 || loading} onClick={() => setOffset(offset + 25)}>Next</button></div>
    {selected && <div><h2 className="text-xl">Latest 100 recorded samples</h2><p className="text-white/50 my-2">Only measured values are saved. Additional samples remain available through the paginated API.</p><pre className="overflow-auto border border-white/20 p-4 text-xs max-h-96">{JSON.stringify(metrics, null, 2)}</pre></div>}
  </section>;
}
