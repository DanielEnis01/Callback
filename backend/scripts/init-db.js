import { initTigerData, tigerDb } from '../src/services/tigerdata.js';
try { await initTigerData(); console.log('Tiger Data schema ready.'); }
catch (error) { console.error('Schema setup failed:', error.message); process.exitCode = 1; }
finally { await tigerDb.end(); }
