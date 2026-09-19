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
