export type MetricValues = Record<string, number | string | Record<string, number>>;
type Writer = (path: string, body: unknown, method?: string) => Promise<unknown>;

/** Per-session context captured at Session Setup, carried through to the
 * /sessions row this recorder creates -- see SessionSetup.tsx's
 * SessionContext (jobPosting/targetWeakness) and Dashboard.tsx's
 * pendingTargetWeakness ("Practice this"). Everything here is optional so
 * existing callers (and static/no-context sessions) keep working. */
export interface SessionCreateContext {
  /** Always "interview" -- focus mode was removed. Still sent because
   * sessions.session_type is NOT NULL with a CHECK constraint. */
  sessionType?: "interview";
  targetedWeakness?: string;
  jobPostingText?: string;
  jobPostingId?: string;
}

/** Ordered, retryable writes. IDs/timestamps survive retries after lost responses. */
export class SessionRecorder {
  readonly id = crypto.randomUUID();
  readonly startedAt = new Date().toISOString();
  private created = false;
  private queue: MetricValues[] = [];
  private inFlight: Promise<void> | null = null;
  private endedAt: string | null = null;
  private lastTimestamp = 0;
  constructor(private write: Writer, private context: SessionCreateContext = {}) {}
  get pending() { return this.queue.length; }
  enqueue(metrics: MetricValues) {
    if (!Object.keys(metrics).length) return;
    if (this.queue.length >= 3600) throw new Error('An hour of samples is waiting to save. Reconnect and retry before continuing.');
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    this.queue.push({ ...metrics, session_id: this.id, recorded_at: new Date(this.lastTimestamp).toISOString() });
  }
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.drain().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  private async drain() {
    if (!this.created) {
      const { sessionType = 'interview', targetedWeakness, jobPostingText, jobPostingId } = this.context;
      await this.write('/sessions', {
        session_id: this.id,
        session_type: sessionType,
        started_at: this.startedAt,
        ...(targetedWeakness ? { targeted_weakness: targetedWeakness } : {}),
        ...(jobPostingText ? { job_posting_text: jobPostingText } : {}),
        ...(jobPostingId ? { job_posting_id: jobPostingId } : {}),
      });
      this.created = true;
    }
    while (this.queue.length) {
      await this.write('/session-metrics', this.queue[0]);
      this.queue.shift();
    }
  }
  async finish() {
    this.endedAt ??= new Date().toISOString();
    await this.flush();
    await this.write(`/sessions/${this.id}`, { ended_at: this.endedAt }, 'PATCH');
  }
}

const names: Record<number, string> = { 1: 'angry', 2: 'contempt', 3: 'disgust', 4: 'fear', 5: 'happy', 6: 'neutral', 7: 'sad', 8: 'surprise' };
const last = (items: any) => Array.isArray(items) ? items.at(-1) : undefined;
/** Map only fields actually present in a decoded SDK message. No fabricated zeros. */
export function presageMetrics(message: any): MetricValues {
  const out: MetricValues = {};
  const number = (key: string, value: unknown) => { if (typeof value === 'number' && Number.isFinite(value)) out[key] = value; };
  const hrv = last(message?.cardio?.hrv);
  number('stress_index_baevsky', hrv?.baevsky);
  number('rmssd', hrv?.rmssd); number('sdnn', hrv?.sdnn); number('mean_nn', hrv?.meanNn);
  number('pulse_rate', last(message?.cardio?.pulseRate)?.value);
  number('breathing_rate', last(message?.breathing?.rate)?.value);
  number('breathing_amplitude', last(message?.breathing?.amplitude)?.value);
  number('eda_level', last(message?.eda?.trace)?.value);
  number('fidget_score_seat', last(message?.micromotion?.glutes)?.value);
  number('fidget_score_knee', last(message?.micromotion?.knees)?.value);
  const scores: Record<string, number> = {};
  for (const score of last(message?.face?.expression)?.scores || []) {
    if (names[score.type] && typeof score.confidence === 'number' && Number.isFinite(score.confidence)) scores[names[score.type]] = score.confidence;
  }
  if (Object.keys(scores).length) {
    out.emotion_breakdown = scores;
    out.dominant_emotion = Object.keys(scores).reduce((a, b) => scores[a] > scores[b] ? a : b);
  }
  return out;
}
