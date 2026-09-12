import './config.js';
import { createApp } from './app.js';
import { initTigerData, tigerDb } from './services/tigerdata.js';
const port = Number(process.env.PORT || 3001);
try {
  if (!process.env.FIREBASE_PROJECT_ID) throw new Error('Set FIREBASE_PROJECT_ID and server Firebase credentials in backend/.env.');
  await initTigerData();
  const server = createApp().listen(port, '127.0.0.1', () => console.log(`Tiger Data API listening on http://127.0.0.1:${port}`));
  const shutdown = () => server.close(() => tigerDb.end().then(() => process.exit(0)));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  console.error('Backend startup failed:', error.message);
  await tigerDb.end();
  process.exitCode = 1;
}
