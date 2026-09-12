import '../config.js';
import { getApps, initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

export async function verifyFirebaseToken(token) {
  const app = getApps()[0] || initializeApp({
    credential: applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
  return getAuth(app).verifyIdToken(token, true);
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
