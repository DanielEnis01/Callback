import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { initTigerData } from '../src/services/tigerdata.js';
import { saveTranscriptAnalysis } from '../src/services/transcriptAnalysisStore.js';

// Covers backend/src/services/analytics.js -- the cross-session bundles
// behind the Dashboard (all-time overview + goals + targeting) and Results
// (per-session dashboard) tabs. Uses PGlite with timescale disabled, same
// as storage.test.js, so the long-range trend endpoint is exercised on its
// plain-query fallback path rather than a real continuous aggregate.
let engine, folder, app;
const db = {
  async query(sql, values) {
    if (values) return engine.query(sql, values);
    const results = await engine.exec(sql);
    return results.at(-1) || { rows: [] };
  },
  async connect() { return { query: (...args) => db.query(...args), release() {} }; },
};
const auth = (call, who = 'alice') => call.set('Authorization', `Bearer ${who}`);

before(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'tigerdata-analytics-test-'));
  engine = new PGlite(folder);
  await initTigerData(db, { timescale: false });
  app = createApp({ db, verifyToken: async token => {
    if (!['alice', 'bob', 'carol'].includes(token)) throw new Error('Invalid token');
    return { uid: token, email: `${token}@example.com`, name: token };
  } });
});
after(async () => { if (engine) await engine.close(); if (folder) await fs.rm(folder, { recursive: true, force: true }); });

async function createSession({ who = 'alice', sessionType = 'interview', startedAt, endedAt, targetedWeakness, fillerWordsPerAnswer, avgStarScore }) {
  const created = await auth(request(app).post('/api/data/sessions'), who)
    .send({ session_type: sessionType, started_at: startedAt, ...(targetedWeakness ? { targeted_weakness: targetedWeakness } : {}) })
    .expect(201);
  const sessionId = created.body.session_id;
  if (endedAt) await auth(request(app).patch(`/api/data/sessions/${sessionId}`), who).send({ ended_at: endedAt }).expect(200);
  if (fillerWordsPerAnswer !== undefined) {
    await saveTranscriptAnalysis(db, {
      sessionId, userId: who,
      staticSignals: { answers: [], summary: { totalAnswers: 4, avgStarScore: avgStarScore ?? 3, quantifiedRate: 0.5, totalFillerWords: 0, fillerWordsPerAnswer, flaggedAnswers: [] } },
      aiAnalysis: null, aiError: null,
    });
  }
  return sessionId;
}

test('overview reports hasSessions: false for a user with no ended sessions', async () => {
  const response = await auth(request(app).get('/api/analytics/overview'), 'bob').expect(200);
  assert.deepEqual(response.body, { hasSessions: false });
});

test('GET /api/analytics/signals lists the tracked signal catalog', async () => {
  const response = await auth(request(app).get('/api/analytics/signals')).expect(200);
  assert.ok(response.body.some(s => s.key === 'filler_word_rate'));
  assert.ok(response.body.every(s => s.label && s.unit !== undefined && ['lower', 'higher', 'closer'].includes(s.better)));
});

test('computes all-time overview, most-improved metric, goals, and targeting effectiveness', async () => {
  const t0 = Date.parse('2026-09-01T10:00:00Z');
  const hour = 3600_000;
  // Two untargeted sessions, then three targeting "excessive filler words"
  // with a real, improving trend -- this is what getTargetingEffectiveness
  // and the most-improved-metric calculation should pick up on.
  await createSession({ startedAt: new Date(t0).toISOString(), endedAt: new Date(t0 + 600_000).toISOString(), fillerWordsPerAnswer: 8 });
  await createSession({ startedAt: new Date(t0 + hour).toISOString(), endedAt: new Date(t0 + hour + 600_000).toISOString(), fillerWordsPerAnswer: 7 });
  await createSession({ startedAt: new Date(t0 + 2 * hour).toISOString(), endedAt: new Date(t0 + 2 * hour + 600_000).toISOString(), targetedWeakness: 'Excessive filler words', fillerWordsPerAnswer: 6 });
  await createSession({ startedAt: new Date(t0 + 3 * hour).toISOString(), endedAt: new Date(t0 + 3 * hour + 600_000).toISOString(), targetedWeakness: 'Excessive filler words', fillerWordsPerAnswer: 3 });
  await createSession({ startedAt: new Date(t0 + 4 * hour).toISOString(), endedAt: new Date(t0 + 4 * hour + 600_000).toISOString(), targetedWeakness: 'Excessive filler words', fillerWordsPerAnswer: 2 });

  const overview = await auth(request(app).get('/api/analytics/overview')).expect(200);
  assert.equal(overview.body.hasSessions, true);
  assert.equal(overview.body.totalSessions, 5);
  assert.equal(overview.body.allTimeAverages.filler_word_rate, 5.2);
  assert.ok(overview.body.bestSession, 'best session should come from trait composites, not the empty session_results table');
  assert.ok(overview.body.bestSession.score10 > 0);
  assert.ok(overview.body.mostImproved, 'expected a most-improved metric with 5 data points');
  assert.equal(overview.body.mostImproved.signalKey, 'filler_word_rate');
  assert.ok(overview.body.mostImproved.improvement > 0, 'filler rate dropping should read as an improvement');

  const targeting = overview.body.targeting.find(t => t.weakness === 'Excessive filler words');
  assert.ok(targeting, 'expected a targeting-effectiveness entry for the targeted weakness');
  assert.equal(targeting.timesTargeted, 3);
  assert.equal(targeting.trackable, true);
  assert.equal(targeting.avgBefore, 7.5);
  assert.equal(Math.round(targeting.avgSince * 100) / 100, 3.67);
  assert.equal(targeting.improved, true);

  // Same thing, hit directly.
  const direct = await auth(request(app).get(`/api/analytics/targeting/${encodeURIComponent('Excessive filler words')}`)).expect(200);
  assert.equal(direct.body.avgBefore, 7.5);

  // A weakness with no numeric proxy still reports honestly instead of
  // fabricating a signal.
  await createSession({ startedAt: new Date(t0 + 5 * hour).toISOString(), endedAt: new Date(t0 + 5 * hour + 600_000).toISOString(), targetedWeakness: 'Weak closing statements' });
  const untrackable = await auth(request(app).get(`/api/analytics/targeting/${encodeURIComponent('Weak closing statements')}`)).expect(200);
  assert.equal(untrackable.body.trackable, false);

  // Goals: always "reach X out of 10", never "get under". Filler rates of
  // 8/7/6/3/2 per answer map to Verbal Clarity scores of 0/1.3/2.5/6.3/7.5,
  // so the rolling average is 3.5 and a target of 3 is already met -- this
  // exercises the achieved-on-read path.
  const goal = await auth(request(app).post('/api/analytics/goals'))
    .send({ traitKey: 'verbal_clarity', targetValue: 3, targetSessions: 10 }).expect(201);
  assert.equal(goal.body.direction, 'above', 'goals no longer have a "below" direction');
  assert.equal(goal.body.target_sessions, 10);

  // A target outside the 0-10 trait scale is rejected rather than stored.
  await auth(request(app).post('/api/analytics/goals'))
    .send({ traitKey: 'verbal_clarity', targetValue: 45 }).expect(400);
  await auth(request(app).post('/api/analytics/goals'))
    .send({ traitKey: 'not_a_real_trait', targetValue: 5 }).expect(400);
  const withGoal = await auth(request(app).get('/api/analytics/overview')).expect(200);
  const goalRow = withGoal.body.goals.find(g => g.goal_id === goal.body.goal_id);
  assert.ok(goalRow);
  assert.equal(goalRow.achieved, true);
  assert.ok(goalRow.achieved_at, 'achieving a goal should stamp achieved_at');
  assert.equal(goalRow.label, 'Verbal Clarity', 'goals report the trait they track');
  assert.equal(typeof goalRow.sessionsUsed, 'number');

  await auth(request(app).delete(`/api/analytics/goals/${goal.body.goal_id}`)).expect(200);
  const afterDelete = await auth(request(app).get('/api/analytics/overview')).expect(200);
  assert.equal(afterDelete.body.goals.some(g => g.goal_id === goal.body.goal_id), false);

  // Long-range trend endpoint: no continuous aggregate under PGlite, so this
  // exercises the per-session fallback path for an ai_static-sourced signal.
  const trend = await auth(request(app).get('/api/analytics/trends/filler_word_rate?sinceDays=3650')).expect(200);
  assert.equal(trend.body.source, 'per_session');
  assert.equal(trend.body.points.length, 5);

  // Unknown signal is rejected cleanly.
  await auth(request(app).get('/api/analytics/trends/not_a_real_signal')).expect(404);

});

test('session dashboard bundles at-a-glance, charts, ranked weaknesses and strengths', async () => {
  await auth(request(app).post('/api/data/baselines')).send({ baseline_pulse: 60, baseline_stress_index: 20 }).expect(201);
  const sessionId = await createSession({
    startedAt: '2026-09-02T10:00:00Z', endedAt: '2026-09-02T10:10:00Z',
    targetedWeakness: 'Excessive filler words', fillerWordsPerAnswer: 1, avgStarScore: 4,
  });
  await auth(request(app).post('/api/data/session-metrics')).send({ session_id: sessionId, recorded_at: '2026-09-02T10:00:10Z', pulse_rate: 90, stress_index_baevsky: 40, nervousness_score: 35 }).expect(201);
  await auth(request(app).post(`/api/data/sessions/${sessionId}/analyze`)).expect(200);

  const dashboard = await auth(request(app).get(`/api/analytics/sessions/${sessionId}/dashboard`)).expect(200);
  assert.equal(dashboard.body.session.session_id, sessionId);
  assert.equal(dashboard.body.session.targeted_weakness, 'Excessive filler words');
  assert.ok(dashboard.body.atAGlance.compositeScore10 != null);
  assert.ok(dashboard.body.charts.some(c => c.key === 'filler_word_rate'));
  assert.ok(dashboard.body.charts.some(c => c.key === 'stress_index_baevsky'));
  assert.ok(dashboard.body.charts.some(c => c.key === 'nervousness_score'));
  // pulse_rate at 90 vs. a baseline of 60 is a real recorded weakness from
  // computeSessionAnalysis -- not fabricated.
  assert.ok(dashboard.body.weaknesses.some(w => w.title.toLowerCase().includes('pulse')));

  await auth(request(app).get(`/api/analytics/sessions/${crypto.randomUUID()}/dashboard`)).expect(404);
});

test('scores Speech Fluency from transcript disfluency, and never zero-fills it when unmeasured', async () => {
  const who = 'bob';
  const t0 = Date.parse('2026-10-01T10:00:00Z');
  const hour = 3600_000;

  const disfluent = { repeatedWordsPerAnswer: 3, unfinishedPerAnswer: 2, tangentsPerAnswer: 2 };
  const clean = { repeatedWordsPerAnswer: 0, unfinishedPerAnswer: 0, tangentsPerAnswer: 0 };

  async function sessionWith(index, disfluency) {
    const created = await auth(request(app).post('/api/data/sessions'), who)
      .send({ session_type: 'interview', started_at: new Date(t0 + index * hour).toISOString() })
      .expect(201);
    const id = created.body.session_id;
    await auth(request(app).patch(`/api/data/sessions/${id}`), who)
      .send({ ended_at: new Date(t0 + index * hour + 600_000).toISOString() }).expect(200);
    await saveTranscriptAnalysis(db, {
      sessionId: id, userId: who,
      staticSignals: { answers: [], summary: { totalAnswers: 4, avgStarScore: 3, quantifiedRate: 0.5, totalFillerWords: 0, fillerWordsPerAnswer: 0, ...disfluency } },
      aiAnalysis: null, aiError: null,
    });
    return id;
  }

  // Three clean sessions establish the average, then one visibly disfluent one.
  for (let i = 0; i < 3; i++) await sessionWith(i, clean);
  const roughId = await sessionWith(3, disfluent);

  const dashboard = await auth(request(app).get(`/api/analytics/sessions/${roughId}/dashboard`), who).expect(200);
  const fluency = dashboard.body.traits.find(t => t.key === 'speech_fluency');
  assert.ok(fluency, 'expected a Speech Fluency trait for a session with disfluency data');
  // 3 repeats/answer and 2 unfinished/answer are both at the penalty floor.
  assert.equal(fluency.value, 0);

  // Tangents alone still score Staying on Topic even with no job posting to
  // compare relevance against -- 2 tangents/answer is the full penalty.
  const focus = dashboard.body.traits.find(t => t.key === 'topic_focus');
  assert.ok(focus, 'expected tangent markers alone to produce a focus score');
  assert.equal(focus.value, 0);

  // ...and it is the standout callout, since the prior sessions were clean.
  const callout = dashboard.body.skillDevelopment.find(t => t.key === 'speech_fluency');
  assert.ok(callout, 'expected Speech Fluency to be flagged as a big change');
  assert.equal(callout.avgValue, 10);
  assert.equal(callout.direction, 'worse');

  // A session whose analysis never recorded disfluency at all must not be
  // scored 0 for it -- the trait is simply absent (never zero-filled).
  const legacy = await auth(request(app).post('/api/data/sessions'), who)
    .send({ session_type: 'interview', started_at: new Date(t0 + 4 * hour).toISOString() }).expect(201);
  await auth(request(app).patch(`/api/data/sessions/${legacy.body.session_id}`), who)
    .send({ ended_at: new Date(t0 + 4 * hour + 600_000).toISOString() }).expect(200);
  await saveTranscriptAnalysis(db, {
    sessionId: legacy.body.session_id, userId: who,
    staticSignals: { answers: [], summary: { totalAnswers: 4, avgStarScore: 3, quantifiedRate: 0.5, totalFillerWords: 0, fillerWordsPerAnswer: 0 } },
    aiAnalysis: null, aiError: null,
  });
  const legacyDashboard = await auth(request(app).get(`/api/analytics/sessions/${legacy.body.session_id}/dashboard`), who).expect(200);
  assert.equal(legacyDashboard.body.traits.some(t => t.key === 'speech_fluency'), false);
  assert.equal(legacyDashboard.body.traits.some(t => t.key === 'topic_focus'), false);
});

test('GET /api/analytics/traits lists the universal trait catalog', async () => {
  const response = await auth(request(app).get('/api/analytics/traits')).expect(200);
  assert.ok(response.body.some(t => t.key === 'verbal_clarity'));
  assert.ok(response.body.every(t => t.label && t.description));
});

test('session dashboard derives a position label, a trait-based composite score, and skill-development callouts', async () => {
  const who = 'carol';
  const t0 = Date.parse('2026-09-05T09:00:00Z');
  const hour = 3600_000;

  // Five unremarkable sessions establish carol's personal average for
  // verbal_clarity (filler words) -- all around the same filler rate, so
  // her all-time average settles near 1 filler/answer (a high clarity score).
  const priorIds = [];
  for (let i = 0; i < 5; i++) {
    priorIds.push(await createSession({
      who, startedAt: new Date(t0 + i * hour).toISOString(), endedAt: new Date(t0 + i * hour + 600_000).toISOString(),
      fillerWordsPerAnswer: 1, avgStarScore: 3,
    }));
  }

  // A sixth session pasted a job posting and had a much higher filler rate
  // -- this is the one we inspect. Its position should be derived from the
  // job posting text (no saved job_postings row, no separate title field),
  // and its Verbal Clarity trait should be the standout skill-development
  // callout since it's far from her established average.
  const created = await auth(request(app).post('/api/data/sessions'), who)
    .send({
      session_type: 'interview',
      started_at: new Date(t0 + 5 * hour).toISOString(),
      job_posting_text: 'Senior Product Manager\nOwns the roadmap for our checkout experience.',
    })
    .expect(201);
  const sessionId = created.body.session_id;
  await auth(request(app).patch(`/api/data/sessions/${sessionId}`), who).send({ ended_at: new Date(t0 + 5 * hour + 600_000).toISOString() }).expect(200);
  await saveTranscriptAnalysis(db, {
    sessionId, userId: who,
    staticSignals: { answers: [], summary: { totalAnswers: 4, avgStarScore: 3, quantifiedRate: 0.5, totalFillerWords: 32, fillerWordsPerAnswer: 8, flaggedAnswers: [] } },
    aiAnalysis: null, aiError: null,
    transcript: [{ role: 'model', parts: [{ text: 'Tell me about yourself.' }] }, { role: 'user', parts: [{ text: 'Sure, so, um, like, I guess...' }] }],
  });

  const dashboard = await auth(request(app).get(`/api/analytics/sessions/${sessionId}/dashboard`), who).expect(200);
  assert.equal(dashboard.body.atAGlance.position, 'Senior Product Manager');
  assert.ok(dashboard.body.atAGlance.compositeScore10 != null, 'expected a trait-based composite even with no session_results row');
  assert.ok(dashboard.body.traits.some(t => t.key === 'verbal_clarity'));
  assert.ok(dashboard.body.skillDevelopment.length > 0, 'expected at least one skill-development callout');
  const verbalClarityCallout = dashboard.body.skillDevelopment.find(t => t.key === 'verbal_clarity');
  assert.ok(verbalClarityCallout, 'expected Verbal Clarity to stand out given the filler-word spike');
  assert.equal(verbalClarityCallout.direction, 'worse');

  // Lazy transcript endpoint returns exactly what was persisted.
  const transcript = await auth(request(app).get(`/api/analytics/sessions/${sessionId}/transcript`), who).expect(200);
  assert.equal(transcript.body.transcript.length, 2);
  assert.equal(transcript.body.transcript[1].parts[0].text, 'Sure, so, um, like, I guess...');

  // A session with no analysis ever run for it has no transcript to show.
  const bareId = priorIds[0];
  const bareTranscript = await auth(request(app).get(`/api/analytics/sessions/${bareId}/transcript`), who).expect(200);
  assert.equal(bareTranscript.body.transcript, null);

  // Dashboard-tab overview surfaces the same trait, averaged across all of
  // carol's sessions (including the spike), not just this one session.
  const overview = await auth(request(app).get('/api/analytics/overview'), who).expect(200);
  assert.ok(overview.body.traitAverages.verbal_clarity, 'expected an all-time Verbal Clarity average');
  assert.ok(overview.body.traitAverages.verbal_clarity.sampleCount >= 6);
});
