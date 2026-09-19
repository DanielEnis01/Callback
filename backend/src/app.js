import './config.js';
import cors from 'cors';
import express from 'express';
import { authenticate } from './middleware/auth.js';
import { createDocumentsRouter } from './routes/documents.js';
import { createDataRouter } from './routes/data.js';
import { createServicesRouter } from './routes/services.js';
import { createAnalyticsRouter } from './routes/analytics.js';
import ttsRouter from './routes/tts.js';
import sttRouter from './routes/stt.js';
import { errorHandler, asyncRoute } from './errors.js';
import { tigerDb } from './services/tigerdata.js';

export function createApp({ db = tigerDb, verifyToken } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // The packaged Electron app used to load the built UI over file://, which
  // Chromium reports as the literal Origin header "null" (not the string
  // "file://") -- "null" stays in the default list below for that reason,
  // and so any already-installed copy of an older build keeps working.
  //
  // Since v1.0.0-ci18, main.cjs instead serves the app to itself over
  // http://localhost:<port> (a real origin, needed to fix Google sign-in --
  // signInWithPopup's authorized-domains check has nothing that file://
  // can match). That port is OS-assigned per launch, so it can't be put in
  // a fixed allowlist -- every request from the desktop app started
  // failing outright with "Failed to fetch" the moment ci18 shipped,
  // because the CORS check rejected an Origin it had never seen before.
  // A regex covering any localhost/127.0.0.1 origin, at any port, replaces
  // the fixed list for that case. This is a smaller security trade than it
  // looks: every /api route is protected by a Bearer Firebase ID token,
  // not a cookie, so a request that clears CORS here still can't do
  // anything without a token it was never handed -- CORS is just the
  // preflight gate, not the auth.
  const configuredOrigins = (process.env.FRONTEND_ORIGIN || 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:8444,http://localhost:8444,null').split(',').map(s => s.trim());
  const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  app.use(cors({
    origin(origin, callback) {
      // No Origin header (curl, server-to-server calls, some native HTTP
      // clients) isn't a browser CORS scenario at all -- always allow.
      if (!origin) return callback(null, true);
      if (configuredOrigins.includes(origin) || LOCAL_ORIGIN_RE.test(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} is not allowed.`));
    },
    exposedHeaders: ['X-Content-SHA256', 'Content-Disposition'],
  }));
  app.get('/health', asyncRoute(async (_req, res) => {
    try { await db.query('SELECT 1'); res.json({ status: 'ok', database: 'connected' }); }
    catch { res.status(503).json({ status: 'unavailable', database: 'disconnected' }); }
  }));
  app.use('/api', authenticate(verifyToken), (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  app.use('/api/documents', createDocumentsRouter(db));
  app.use('/api/data', createDataRouter(db));
  // Gemini (recruiter reasoning) + ElevenLabs (TTS/STT) for the live voice
  // conversation loop -- see useConversation.ts on the frontend. Behind the
  // same Firebase auth as everything else under /api.
  app.use('/api/services', createServicesRouter(db));
  app.use('/api/analytics', createAnalyticsRouter(db));
  app.use('/api/tts', ttsRouter);
  app.use('/api/stt', sttRouter);
  app.use((_req, res) => res.status(404).json({ error: 'Route not found.' }));
  app.use(errorHandler);
  return app;
}
