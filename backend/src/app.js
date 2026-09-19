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
  // The packaged Electron app loads the built UI over file://, which Chromium
  // reports as the literal Origin header "null" (not the string "file://") --
  // include it by default so a built app talking to a local backend works
  // out of the box; when hosting, add "null" to FRONTEND_ORIGIN too.
  const origins = (process.env.FRONTEND_ORIGIN || 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:8444,http://localhost:8444,null').split(',').map(s => s.trim());
  app.use(cors({ origin: origins, exposedHeaders: ['X-Content-SHA256', 'Content-Disposition'] }));
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
