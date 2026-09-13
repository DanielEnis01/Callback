// Client for the Python speech-analysis service (../../python/analysis_service.py).
// That script runs static, rule-based checks over the interview transcript —
// STAR-method coverage, quantified-result detection, filler-word counts —
// deliberately without an LLM (fast, free, deterministic). This module
// spawns it as a child process on backend startup so nobody has to remember
// to start it separately, and exposes analyzeTranscript() to call it.
//
// Its output is meant to be handed to Gemini alongside the raw transcript
// for the dynamic/qualitative half of the analysis — see gemini.js's
// generateTranscriptAnalysis and routes/services.js's POST /analysis/transcript.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.ANALYSIS_SERVICE_PORT || 5055);
const BASE_URL = process.env.ANALYSIS_SERVICE_URL || `http://127.0.0.1:${PORT}`;
const scriptPath = fileURLToPath(new URL('../../../python/analysis_service.py', import.meta.url));

let child;

/**
 * Spawn the Python analysis service as a child process. Best-effort: if
 * python3 isn't installed or the script fails to start, this logs a
 * warning and leaves analyzeTranscript() to fail per-request (with a clear
 * error) rather than crashing the whole Node backend over an optional
 * feature.
 */
export function startAnalysisService() {
  if (child) return;
  child = spawn('python3', [scriptPath], {
    env: { ...process.env, ANALYSIS_SERVICE_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (buf) => process.stdout.write(`[analysis] ${buf}`));
  child.stderr.on('data', (buf) => process.stderr.write(`[analysis] ${buf}`));
  child.on('error', (err) => {
    console.warn(
      `Speech analysis service failed to start (${err.message}). ` +
        'Install python3 (a plain stdlib script, no pip packages needed) to enable ' +
        'STAR-method/quantification/filler-word scoring — transcript analysis will ' +
        'error until then.'
    );
    child = undefined;
  });
  child.on('exit', (code, signal) => {
    if (code !== null && code !== 0) {
      console.warn(`Speech analysis service exited unexpectedly (code ${code}, signal ${signal}).`);
    }
    child = undefined;
  });
}

export function stopAnalysisService() {
  child?.kill();
  child = undefined;
}

/**
 * POST the transcript to the analysis service and return its structured
 * static-signals JSON (see analysis_service.py's analyze_transcript()).
 * Retries briefly since the child process may still be booting right after
 * backend startup — it's plain stdlib http.server so it starts in
 * milliseconds, but this avoids a race on the very first request.
 */
export async function analyzeTranscript(transcript, { jobPosting, retries = 5, retryDelayMs = 300 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, ...(jobPosting ? { jobPosting } : {}) }),
      });
      if (!res.ok) throw new Error(`analysis service responded ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw new Error(
    `Speech analysis service unreachable at ${BASE_URL} (${lastErr.message}). ` +
      'Make sure python3 is installed — see python/README.md.'
  );
}
