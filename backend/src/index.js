import './config.js';
import { createApp } from './app.js';
import { initTigerData, tigerDb } from './services/tigerdata.js';
import { startAnalysisService, stopAnalysisService } from './services/pythonAnalysis.js';
import { verifyModelChain } from './services/gemini.js';
const port = Number(process.env.PORT || 3001);
// Render (and most hosts) route inbound traffic to 0.0.0.0, not 127.0.0.1 --
// a loopback-only bind looks "alive" in local dev but is unreachable once
// deployed. Set HOST=0.0.0.0 in the hosting platform's env vars; local dev
// keeps the safer loopback-only default.
const host = process.env.HOST || '127.0.0.1';
try {
  if (!process.env.FIREBASE_PROJECT_ID) throw new Error('Set FIREBASE_PROJECT_ID and server Firebase credentials in backend/.env.');
  await initTigerData();
  // Best-effort: the Python speech-analysis service (STAR method /
  // quantification / filler-word checks) is optional infrastructure, not
  // required for the rest of the API — startAnalysisService() logs a
  // warning and leaves it stopped rather than failing backend startup if
  // python3 isn't available.
  startAnalysisService();
  // Validate the Gemini model names now, not three questions into someone's
  // interview. Best-effort: an unreachable ListModels endpoint just skips it.
  void verifyModelChain().catch(() => {});
  const server = createApp().listen(port, host, () => console.log(`Tiger Data API listening on http://${host}:${port}`));
  const shutdown = () => {
    stopAnalysisService();
    server.close(() => tigerDb.end().then(() => process.exit(0)));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  console.error('Backend startup failed:', error.message);
  await tigerDb.end();
  process.exitCode = 1;
}
