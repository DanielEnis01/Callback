import express from 'express';
import { asyncRoute, HttpError } from '../errors.js';
import { requireUuid } from './documents.js';
import {
  getOverview, getSessionDashboard, getSessionTranscript, getSignalTrend, getTraitTrend, getTargetingEffectiveness,
  listGoals, createGoal, deactivateGoal, SIGNAL_CATALOG, TRAIT_CATALOG,
} from '../services/analytics.js';

function parseSessionType(value) {
  if (value === undefined) return undefined;
  if (!['interview', 'focus'].includes(value)) throw new HttpError(400, 'sessionType must be "interview" or "focus".');
  return value;
}

// Cross-session analytics for the Dashboard (all-time overview + goals +
// long-range trends) and Results (per-session dashboard) tabs. Read-only
// except goals, which the user manages directly. See analytics.js for the
// actual queries -- nothing here computes anything itself.
export function createAnalyticsRouter(db) {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  router.get('/signals', asyncRoute(async (_req, res) => {
    res.json(Object.entries(SIGNAL_CATALOG).map(([key, cat]) => ({ key, label: cat.label, unit: cat.unit, better: cat.better })));
  }));

  router.get('/overview', asyncRoute(async (req, res) => {
    const result = await getOverview(db, { userId: req.user.userId, sessionType: parseSessionType(req.query.sessionType) });
    res.json(result);
  }));

  router.get('/sessions/:sessionId/dashboard', asyncRoute(async (req, res) => {
    const result = await getSessionDashboard(db, { sessionId: requireUuid(req.params.sessionId), userId: req.user.userId });
    res.json(result);
  }));

  router.get('/sessions/:sessionId/transcript', asyncRoute(async (req, res) => {
    const result = await getSessionTranscript(db, { sessionId: requireUuid(req.params.sessionId), userId: req.user.userId });
    res.json(result);
  }));

  router.get('/trait-trends/:traitKey', asyncRoute(async (req, res) => {
    if (!TRAIT_CATALOG[req.params.traitKey]) throw new HttpError(404, `Unknown trait: ${req.params.traitKey}`);
    const sinceDays = req.query.sinceDays !== undefined ? Number(req.query.sinceDays) : undefined;
    if (sinceDays !== undefined && (!Number.isFinite(sinceDays) || sinceDays <= 0 || sinceDays > 3650)) {
      throw new HttpError(400, 'sinceDays must be between 1 and 3650.');
    }
    res.json(await getTraitTrend(db, {
      userId: req.user.userId, traitKey: req.params.traitKey,
      sessionType: parseSessionType(req.query.sessionType), sinceDays,
    }));
  }));

  router.get('/traits', asyncRoute(async (_req, res) => {
    res.json(Object.entries(TRAIT_CATALOG).map(([key, trait]) => ({ key, label: trait.label, description: trait.description })));
  }));

  router.get('/trends/:signalKey', asyncRoute(async (req, res) => {
    if (!SIGNAL_CATALOG[req.params.signalKey]) throw new HttpError(404, `Unknown signal: ${req.params.signalKey}`);
    const sinceDays = req.query.sinceDays !== undefined ? Number(req.query.sinceDays) : undefined;
    if (sinceDays !== undefined && (!Number.isFinite(sinceDays) || sinceDays <= 0 || sinceDays > 3650)) throw new HttpError(400, 'sinceDays must be between 1 and 3650.');
    const result = await getSignalTrend(db, {
      userId: req.user.userId, signalKey: req.params.signalKey,
      sessionType: parseSessionType(req.query.sessionType), sinceDays,
    });
    res.json(result);
  }));

  router.get('/targeting/:weakness', asyncRoute(async (req, res) => {
    const result = await getTargetingEffectiveness(db, {
      userId: req.user.userId, weakness: decodeURIComponent(req.params.weakness),
      sessionType: parseSessionType(req.query.sessionType),
    });
    res.json(result);
  }));

  router.get('/goals', asyncRoute(async (req, res) => {
    res.json(await listGoals(db, { userId: req.user.userId }));
  }));

  router.post('/goals', asyncRoute(async (req, res) => {
    const body = req.body || {};
    const result = await createGoal(db, {
      userId: req.user.userId,
      traitKey: body.traitKey ?? body.signalKey,
      targetValue: body.targetValue,
      targetSessions: body.targetSessions,
      sessionType: body.sessionType ?? null,
    });
    res.status(201).json(result);
  }));

  router.delete('/goals/:goalId', asyncRoute(async (req, res) => {
    const result = await deactivateGoal(db, { userId: req.user.userId, goalId: requireUuid(req.params.goalId) });
    res.json(result);
  }));

  return router;
}
