import { useEffect, useState } from 'react';
import { dataRequest, getSessionAiAnalysis, type StoredTranscriptAnalysis } from './dataApi';
import { remoteStorageEnabled } from './baselineStore';
import { getStaticSessions } from './staticSessionStore';

type Session = { session_id: string; session_type: string; started_at: string; ended_at: string | null; duration_seconds: number | null };

/**
 * Gemini/provider errors often arrive as raw JSON text embedded in
 * Error.message (e.g. ElevenLabs/Gemini SDK error bodies) -- shown as-is
 * this reads like a stack trace to a non-technical user. Best-effort
 * extraction of a human message field; falls back to the raw string when
 * it isn't JSON (e.g. a plain network error) so nothing is ever hidden.
 */
function friendlyErrorMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const message = parsed?.error?.message || parsed?.message;
    return typeof message === 'string' ? message : raw;
  } catch {
    return raw;
  }
}

/** overall_score (0-100) is the fraction of biometric signals that came out
 * better than baseline/recent trend -- see sessionAnalysis.js. This is a
 * different number from the AI analysis's overallScore below; both are
 * shown, labeled separately, rather than merged into one misleading figure. */
export default function SavedSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState('');
  const [metrics, setMetrics] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [showRaw, setShowRaw] = useState(false);

  // AI transcript analysis (STAR/quantification/filler signals + Gemini's
  // qualitative pass) for the selected session -- see SessionMeeting.tsx's
  // finishSession() for where this gets computed and saved.
  const [aiAnalysis, setAiAnalysis] = useState<StoredTranscriptAnalysis | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiFetchError, setAiFetchError] = useState('');

  useEffect(() => {
    let current = true;
    setLoading(true); setError(''); setSessions([]); setSelected(''); setMetrics([]);
    (remoteStorageEnabled
      ? dataRequest<{ records: Session[] }>(`/sessions?limit=25&offset=${offset}`)
      : Promise.resolve({ records: getStaticSessions().slice(offset, offset + 25) as Session[] }))
      .then(data => { if (current) setSessions(data.records); })
      .catch(error => { if (current) setError(error.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [offset]);

  useEffect(() => {
    if (!selected) return;
    let current = true;
    setMetrics([]); setError(''); setAiAnalysis(null); setAiFetchError(''); setShowRaw(false);
    (remoteStorageEnabled
      ? dataRequest<{ records: Record<string, unknown>[] }>(`/session-metrics?sessionId=${encodeURIComponent(selected)}&limit=100`)
      : Promise.resolve({ records: getStaticSessions().find(session => session.session_id === selected)?.metrics.slice(0, 100) || [] }))
      .then(data => { if (current) setMetrics(data.records); })
      .catch(error => { if (current) setError(error.message); });

    // Static/local-mode sessions never had a sessionId sent to the analysis
    // call in the first place (see SessionMeeting.tsx), so there's nothing
    // stored server-side to fetch back.
    if (remoteStorageEnabled) {
      setAiLoading(true);
      getSessionAiAnalysis(selected)
        .then(data => { if (current) setAiAnalysis(data); })
        .catch(error => { if (current) setAiFetchError(error.message); })
        .finally(() => { if (current) setAiLoading(false); });
    }
    return () => { current = false; };
  }, [selected]);

  return <section className="space-y-5">
    <h1 className="text-3xl font-bold">Saved sessions</h1>
    {error && <p role="alert" className="text-red-200">{error}</p>}
    {loading ? <p>Loading…</p> : !sessions.length ? <p>No saved sessions yet.</p> : sessions.map(session => <button key={session.session_id} onClick={() => setSelected(session.session_id)} className="block w-full border border-white/20 p-4 text-left">
      {new Date(session.started_at).toLocaleString()} · {session.ended_at ? `${Math.round(session.duration_seconds || 0)} seconds` : 'Open / interrupted'}
    </button>)}
    <div className="flex gap-4"><button disabled={!offset || loading} onClick={() => setOffset(offset - 25)}>Previous</button><button disabled={sessions.length < 25 || loading} onClick={() => setOffset(offset + 25)}>Next</button></div>

    {selected && <div className="space-y-6">
      <div>
        <h2 className="text-xl mb-2">Session summary</h2>
        {!remoteStorageEnabled ? (
          <p className="text-white/50">AI analysis is only saved in remote-storage mode. This session's data stays on this device.</p>
        ) : aiLoading ? (
          <p className="text-white/50">Loading analysis…</p>
        ) : aiFetchError ? (
          <p role="alert" className="text-red-200">{aiFetchError}</p>
        ) : !aiAnalysis ? (
          <p className="text-white/50">No AI analysis yet for this session. It's computed automatically when the session ends.</p>
        ) : (
          <div className="space-y-4 border border-white/20 p-4">
            <p className="text-white/40 text-xs">Computed {new Date(aiAnalysis.computed_at).toLocaleString()}</p>

            {aiAnalysis.overall_score != null && (
              <div>
                <span className="text-white/45 text-[13px] uppercase tracking-[0.1em]">Overall score</span>
                <p className="text-2xl font-bold">{Math.round(aiAnalysis.overall_score)} / 100</p>
              </div>
            )}

            {aiAnalysis.ai_summary && Array.isArray(aiAnalysis.ai_summary) ? (
              <div className="space-y-4">
                <span className="text-white/45 text-[13px] uppercase tracking-[0.1em]">Per-Question Summary</span>
                {aiAnalysis.ai_summary.map((q, idx) => (
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
            ) : aiAnalysis.ai_summary ? (
              <div>
                <span className="text-white/45 text-[13px] uppercase tracking-[0.1em]">Summary</span>
                <p className="mt-1 leading-relaxed">{typeof aiAnalysis.ai_summary === 'string' ? aiAnalysis.ai_summary : JSON.stringify(aiAnalysis.ai_summary)}</p>
              </div>
            ) : null}

            {!!aiAnalysis.ai_strengths?.length && (
              <div>
                <span className="text-white/45 text-[13px] uppercase tracking-[0.1em]">Strengths</span>
                <ul className="mt-1 list-disc list-inside space-y-1">
                  {aiAnalysis.ai_strengths.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </div>
            )}

            {!!aiAnalysis.ai_weaknesses?.length && (
              <div>
                <span className="text-white/45 text-[13px] uppercase tracking-[0.1em]">Weaknesses</span>
                <ul className="mt-1 list-disc list-inside space-y-1">
                  {aiAnalysis.ai_weaknesses.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}

            {aiAnalysis.ai_error && (
              <p className="text-amber-300 text-[13px]">
                The qualitative (Gemini) pass didn't complete for this session: {friendlyErrorMessage(aiAnalysis.ai_error)}. The static signals below are still accurate.
              </p>
            )}

            <div>
              <span className="text-white/45 text-[13px] uppercase tracking-[0.1em]">Static signals</span>
              <p className="mt-1 text-white/70 text-[14px]">
                {aiAnalysis.static_signals.summary.totalAnswers} answer{aiAnalysis.static_signals.summary.totalAnswers === 1 ? '' : 's'} analyzed ·
                {' '}avg STAR coverage {aiAnalysis.static_signals.summary.avgStarScore}/4 ·
                {' '}{Math.round(aiAnalysis.static_signals.summary.quantifiedRate * 100)}% quantified ·
                {' '}{aiAnalysis.static_signals.summary.fillerWordsPerAnswer} filler words/answer
              </p>
            </div>
          </div>
        )}
      </div>

      <div>
        <button onClick={() => setShowRaw(v => !v)} className="text-white/50 text-[13px] underline">
          {showRaw ? 'Hide' : 'Show'} raw recorded samples
        </button>
        {showRaw && <div className="mt-2">
          <h2 className="text-xl">Latest 100 recorded samples</h2>
          <p className="text-white/50 my-2">Only measured values are saved.{remoteStorageEnabled ? ' Additional samples remain available through the paginated API.' : ' Static mode keeps these on this device.'}</p>
          <pre className="overflow-auto border border-white/20 p-4 text-xs max-h-96">{JSON.stringify(metrics, null, 2)}</pre>
        </div>}
      </div>
    </div>}
  </section>;
}
