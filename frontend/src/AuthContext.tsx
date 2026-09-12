import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  browserLocalPersistence, browserSessionPersistence, createUserWithEmailAndPassword,
  GoogleAuthProvider, onAuthStateChanged, sendPasswordResetEmail, setPersistence,
  signInWithEmailAndPassword, signInWithPopup, signOut, updateProfile, type User,
} from "firebase/auth";
import { firebaseConfigured, getFirebaseAuth } from "./firebase";
import { authErrorMessage } from "./auth-errors";
import { assertValidPassword } from "./password-policy";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  busy: boolean;
  initializationError: string;
  signIn: (email: string, password: string, remember: boolean) => Promise<void>;
  signUp: (username: string, email: string, password: string, remember: boolean) => Promise<void>;
  signInGoogle: (remember: boolean) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  saveUsername: (username: string) => Promise<void>;
  logOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export default function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<{ user: User | null }>({ user: null });
  const [loading, setLoading] = useState(firebaseConfigured);
  const [busy, setBusy] = useState(false);
  const [initializationError, setInitializationError] = useState("");
  const operationInProgress = useRef(false);

  useEffect(() => {
    if (!firebaseConfigured) return;
    try {
      return onAuthStateChanged(getFirebaseAuth(), (user) => {
        // Account creation signs in before the username has been saved.
        if (!operationInProgress.current) setSession({ user });
        setLoading(false);
      }, (error) => {
        setInitializationError(authErrorMessage(error));
        setLoading(false);
      });
    } catch (error) {
      setInitializationError(authErrorMessage(error));
      setLoading(false);
    }
  }, []);

  async function run(operation: () => Promise<unknown>) {
    if (operationInProgress.current) return;
    operationInProgress.current = true;
    setBusy(true);
    try {
      await operation();
    } finally {
      // Also publish partially created accounts so username saving can be retried.
      if (firebaseConfigured) {
        try { setSession({ user: getFirebaseAuth().currentUser }); } catch { /* Initialization error is shown by the form. */ }
      }
      operationInProgress.current = false;
      setBusy(false);
    }
  }

  async function rememberSession(remember: boolean) {
    await setPersistence(getFirebaseAuth(), remember ? browserLocalPersistence : browserSessionPersistence);
  }

  const value: AuthContextValue = {
    user: session.user, loading, busy, initializationError,
    signIn: (email, password, remember) => run(async () => {
      await rememberSession(remember);
      await signInWithEmailAndPassword(getFirebaseAuth(), email.trim(), password);
    }),
    signUp: (username, email, password, remember) => run(async () => {
      assertValidPassword(password);
      await rememberSession(remember);
      const credential = await createUserWithEmailAndPassword(getFirebaseAuth(), email.trim(), password);
      await updateProfile(credential.user, { displayName: username.trim() });
    }),
    signInGoogle: (remember) => run(async () => {
      await rememberSession(remember);
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithPopup(getFirebaseAuth(), provider);
    }),
    resetPassword: (email) => run(() => sendPasswordResetEmail(getFirebaseAuth(), email.trim())),
    saveUsername: (username) => run(async () => {
      const user = getFirebaseAuth().currentUser;
      if (!user) throw new Error("Please sign in again.");
      await updateProfile(user, { displayName: username.trim() });
    }),
    logOut: () => run(() => signOut(getFirebaseAuth())),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
