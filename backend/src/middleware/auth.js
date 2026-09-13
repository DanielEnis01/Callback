import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

export async function authenticate(req, res, next) {
  const header = req.get("Authorization");
  if (!header) return next();
  if (!header.startsWith("Bearer ") || !process.env.FIREBASE_PROJECT_ID) return res.status(401).json({ error: "Firebase authentication is not configured or the token is invalid" });
  try {
    const app = getApps()[0] || initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID });
    const token = await getAuth(app).verifyIdToken(header.slice(7));
    req.user = { userId: token.uid };
    next();
  } catch { res.status(401).json({ error: "Invalid or expired Firebase ID token" }); }
}
