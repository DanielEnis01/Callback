// Which Gemini models does our key actually have, and which ones still
// answer? Free-tier quota is per-model-per-day, so when one model gets
// rate-limited (429 RESOURCE_EXHAUSTED) switching to a different model is
// a real fix, not a workaround -- but only if that model is actually
// available to the key. Guessing a model name that doesn't exist fails the
// same way as a bad key, so this checks both, live.
//
// Run:  npm run gemini:check
//
// Prints a table of candidate models with whether a real generateContent
// call through the same SDK the app uses succeeds. Never prints the key.
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY is not set in backend/.env');
  process.exit(1);
}
console.log(`Using GEMINI_API_KEY (length ${apiKey.length}), GEMINI_MODEL=${process.env.GEMINI_MODEL || '(unset)'}\n`);

// ── 1. What does this key even have access to? ───────────────────────────
let available = [];
try {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`);
  const data = await res.json();
  if (data.error) {
    console.error(`ListModels failed: ${data.error.code} ${data.error.message}`);
    process.exit(1);
  }
  available = (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace('models/', ''));
} catch (err) {
  console.error('ListModels request failed:', err.message);
  process.exit(1);
}

console.log(`${available.length} generateContent-capable models visible to this key:`);
for (const name of available) console.log('  ', name);

// ── 2. Which of the plausible chat models actually answer right now? ─────
// Only text chat models are worth probing, and each probe spends a request
// from that model's daily quota -- so this stays narrow on purpose.
const candidates = available
  .filter(n => /^gemini-[\d.]+-(flash|pro)/.test(n))
  .filter(n => !/(embedding|image|audio|tts|live|native|thinking|vision|learnlm)/i.test(n))
  .sort((a, b) => {
    // Cheapest/highest-quota first: lite variants, then flash, then pro.
    const rank = n => (/lite/.test(n) ? 0 : /flash/.test(n) ? 1 : 2);
    return rank(a) - rank(b) || a.localeCompare(b);
  })
  .slice(0, 8);

console.log(`\nProbing ${candidates.length} chat models with a 1-line prompt (each costs 1 request):\n`);
const ai = new GoogleGenAI({ apiKey });
const results = [];
for (const model of candidates) {
  const started = Date.now();
  try {
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: OK' }] }],
      config: { systemInstruction: 'You are a terse test harness.' },
    });
    const ms = Date.now() - started;
    results.push({ model, status: 'OK', ms, note: (response.text || '').trim().slice(0, 40) });
  } catch (err) {
    const ms = Date.now() - started;
    const msg = String(err.message || err);
    const quota = /RESOURCE_EXHAUSTED|429/.test(msg);
    const limit = msg.match(/limit:\s*(\d+)/)?.[1];
    results.push({
      model,
      status: quota ? 'QUOTA' : 'ERROR',
      ms,
      note: quota ? `daily limit ${limit ?? '?'} already spent` : msg.slice(0, 60),
    });
  }
}

console.log('model'.padEnd(34) + 'status'.padEnd(9) + 'ms'.padEnd(8) + 'note');
console.log('-'.repeat(96));
for (const r of results) {
  console.log(r.model.padEnd(34) + r.status.padEnd(9) + String(r.ms).padEnd(8) + r.note);
}

const working = results.filter(r => r.status === 'OK');
console.log(`\n${working.length}/${results.length} answered. Recommended GEMINI_MODEL: ${working[0]?.model ?? '(none answered)'}`);
