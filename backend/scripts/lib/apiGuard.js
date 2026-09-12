// lib/apiGuard.js
//
// smokeTest.js and backboardExample.js both run a near-identical real-API
// round trip (create assistant -> upload transcript -> wait for index ->
// write memory -> retrieve), so it's easy to burn credits twice in a row by
// running both, e.g. while following the README's run order or re-running
// after a failure. This guard uses ONE shared lock file so either script
// running blocks the other (and itself) for a cooldown window.
//
// Override with BACKBOARD_API_FORCE=1. Adjust the window with
// BACKBOARD_API_COOLDOWN_MS (defaults to 30 minutes).

import fs from "node:fs";

const LOCK_PATH = new URL("../../.backboard-real-api-lock.json", import.meta.url);
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

function getCooldownMs() {
  const raw = process.env.BACKBOARD_API_COOLDOWN_MS;
  const parsed = Number(raw);
  return raw && Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_COOLDOWN_MS;
}

/**
 * Call at the very start of a script's main(), before any real API call.
 * Exits the process (via throwing) if another real-API run happened too
 * recently. No-ops if BACKBOARD_API_FORCE=1 is set.
 */
function checkCooldown(scriptName) {
  if (process.env.BACKBOARD_API_FORCE === "1") return;
  if (!fs.existsSync(LOCK_PATH)) return;

  let lastRun, lastScript;
  try {
    ({ lastRun, lastScript } = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")));
  } catch {
    return; // corrupt/unreadable lock file — don't block on it
  }
  if (typeof lastRun !== "number" || !Number.isFinite(lastRun)) return;

  const cooldownMs = getCooldownMs();
  const elapsed = Date.now() - lastRun;
  if (elapsed < cooldownMs) {
    const remainingMin = Math.ceil((cooldownMs - elapsed) / 60000);
    const elapsedMin = Math.round(elapsed / 60000);
    const who = lastScript && lastScript !== scriptName ? ` (by ${lastScript})` : "";
    throw new Error(
      `A real Backboard API run happened ${elapsedMin}m ago${who}. ${scriptName} hits the same ` +
        `API and would spend more credits on largely the same flow. Wait ${remainingMin}m, or set ` +
        `BACKBOARD_API_FORCE=1 to override.`
    );
  }
}

/**
 * Call right after checkCooldown() passes, before doing real work — so an
 * attempt that fails partway still counts against the cooldown, since it
 * already spent tokens/credits.
 */
function recordRun(scriptName) {
  fs.writeFileSync(LOCK_PATH, JSON.stringify({ lastRun: Date.now(), lastScript: scriptName }, null, 2));
}

export { checkCooldown, recordRun };
