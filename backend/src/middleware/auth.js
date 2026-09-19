import '../config.js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getApps, initializeApp, applicationDefault, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

// The Firebase Admin service account. It is what lets this backend verify
// the ID tokens the frontend sends.
//
// It used to be supplied only through GOOGLE_APPLICATION_CREDENTIALS, which
// Google's library resolves as an ABSOLUTE path. That pinned the whole
// backend to one person's laptop: every teammate had to edit .env to their
// own home directory before the app would start. The three sources below are
// tried in order so that nobody has to.
const DEFAULT_KEY_PATH = fileURLToPath(new URL('../../firebase-service-account.json', import.meta.url));

function resolveCredential() {
  // 1. Inline JSON. The only option that works on a host with no filesystem
  //    to put a key file on (Vultr, Render, Fly, a container), so it comes
  //    first -- set FIREBASE_SERVICE_ACCOUNT_JSON to the file's contents.
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (inline && inline.trim()) {
    try {
      return { credential: cert(JSON.parse(inline)), source: 'FIREBASE_SERVICE_ACCOUNT_JSON' };
    } catch (err) {
      throw new Error(`FIREBASE_SERVICE_ACCOUNT_JSON is set but is not valid JSON: ${err.message}`);
    }
  }

  // 2. An explicit path, if someone set one. Relative paths are resolved
  //    against this file rather than the process's working directory, so
  //    `FIREBASE_SERVICE_ACCOUNT_PATH=firebase-service-account.json` behaves
  //    the same whether you launch from backend/ or the repo root.
  const configured = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (configured && configured.trim()) {
    const path = configured.startsWith('/')
      ? configured
      : fileURLToPath(new URL(`../../${configured}`, import.meta.url));
    if (!existsSync(path)) {
      throw new Error(`Firebase service account not found at "${path}". Fix the path, or drop the key at backend/firebase-service-account.json and remove the setting.`);
    }
    return { credential: cert(JSON.parse(readFileSync(path, 'utf8'))), source: path };
  }

  // 3. The convention: backend/firebase-service-account.json. Nothing to
  //    configure -- clone the repo, drop the key in, run. This is the path
  //    .gitignore already excludes, so the key never gets committed.
  if (existsSync(DEFAULT_KEY_PATH)) {
    return { credential: cert(JSON.parse(readFileSync(DEFAULT_KEY_PATH, 'utf8'))), source: DEFAULT_KEY_PATH };
  }

  // 4. Whatever the ambient environment provides (gcloud login, GCE/Cloud
  //    Run metadata). Throws a clear error rather than a cryptic one if
  //    there is nothing there either.
  return { credential: applicationDefault(), source: 'application default credentials' };
}

export async function verifyFirebaseToken(token) {
  const app = getApps()[0] || (() => {
    const { credential, source } = resolveCredential();
    console.log(`[auth] Firebase credential loaded from ${source === 'FIREBASE_SERVICE_ACCOUNT_JSON' || source === 'application default credentials' ? source : 'backend/' + source.split('/backend/').pop()}`);
    return initializeApp({ credential, projectId: process.env.FIREBASE_PROJECT_ID });
  })();
  // verifyIdToken's 2nd arg (checkRevoked) was true, which makes Admin SDK
  // do an EXTRA network round trip to Google's Identity Toolkit on every
  // single authenticated request, on top of Render <-> Tiger Data latency
  // -- with the dashboard firing several requests per page load, that
  // extra hop was a real, measurable chunk of "everything feels slow."
  // Without it, verifyIdToken does local, fast cryptographic verification
  // against Google's public certs (cached after the first fetch) -- no
  // per-request network call at all. The tradeoff: a revoked/disabled
  // account's existing token keeps working until it naturally expires
  // (Firebase ID tokens expire after 1 hour) instead of being rejected
  // immediately. That's an acceptable trade for a personal interview-prep
  // app; revisit if this ever needs to lock out a compromised account
  // faster than an hour.
  return getAuth(app).verifyIdToken(token);
}

export function authenticate(verifyToken = verifyFirebaseToken) {
  return async (req, res, next) => {
    const match = /^Bearer (\S+)$/i.exec(req.get('authorization') || '');
    if (!match) return res.status(401).json({ error: 'Sign in to access your documents.' });
    try {
      const claims = await verifyToken(match[1]);
      if (!claims.uid) throw new Error('Missing identity');
      req.user = { userId: claims.uid, email: claims.email || null, name: claims.name || null };
      next();
    } catch {
      return res.status(401).json({ error: 'Your session could not be verified. Please sign in again.' });
    }
  };
}
