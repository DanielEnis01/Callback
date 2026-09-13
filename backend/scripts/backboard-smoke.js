// Backboard connectivity smoke test. Run from backend/:
//   node scripts/backboard-smoke.js
//
// Creates a throwaway assistant, writes one memory, searches for it, then
// deletes the assistant. Touches nothing in Postgres and leaves no residue.
import 'dotenv/config';
import * as client from '../src/integrations/backboard/backboardClient.js';

const log = (...args) => console.log(...args);

if (!client.isBackboardConfigured()) {
  console.error('BACKBOARD_API_KEY is not set in backend/.env — nothing to test.');
  process.exit(1);
}

let assistantId = null;
try {
  log('1/4  creating assistant…');
  const assistant = await client.createUserAssistant(`smoketest_${Date.now()}`);
  assistantId = assistant?.assistant_id || assistant?.id;
  log('     ->', assistantId ? `ok (${assistantId})` : `NO ID — raw: ${JSON.stringify(assistant)}`);
  if (!assistantId) process.exit(1);

  log('2/4  writing a memory…');
  const written = await client.addCoachingMemory(
    assistantId,
    'Q: Tell me about a time you handled a deadline slip.\nA: We cut scope to the two must-have flows and shipped on the original date.',
    { kind: 'qa_pair', userId: 'smoketest', externalId: 'smoketest:0' },
  );
  log('     -> raw response:', JSON.stringify(written));
  log('     -> id resolved as:', written?.id || written?.memory_id || (written?.memory_ids?.[0]) || `NONE (operation_id: ${written?.operation_id ?? 'absent'})`);

  log('3/4  searching…  (embedding may lag a moment)');
  await new Promise((r) => setTimeout(r, 2000));
  const search = await client.searchMemories(assistantId, 'missed deadline', 5);
  const hits = search?.memories ?? [];
  log(`     -> ${hits.length} hit(s)`);
  if (hits[0]) log('     -> first hit keys:', Object.keys(hits[0]).join(', '), '| metadata present:', Boolean(hits[0].metadata));
} catch (err) {
  console.error('FAILED:', err.message);
  process.exitCode = 1;
} finally {
  if (assistantId) {
    log('4/4  cleaning up…');
    try { await client.deleteAssistant(assistantId); log('     -> deleted'); }
    catch (err) { console.error('     -> cleanup failed, delete manually:', assistantId, err.message); }
  }
}
