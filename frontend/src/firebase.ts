import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const firebaseConfigured = Object.values(config).every(
  (value) => typeof value === "string" && value.trim() !== "",
);

let auth: Auth | undefined;

export function getFirebaseAuth(): Auth {
  if (!firebaseConfigured) {
    throw new Error("Authentication is not available yet. Please try again later.");
  }
  auth ??= getAuth(getApps().length ? getApp() : initializeApp(config));
  return auth;
}
