import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";

// Once Firebase is configured, an unauthenticated visitor lands on the
// hero screen (with the shader orb aside), then clicks through to sign
// in — never straight into the dashboard. Firebase itself is mocked so
// this doesn't depend on real network access or on whatever project
// happens to be in .env.
vi.mock("./VoiceOrb", () => ({ VoiceOrb: () => <div aria-label="Voice animation" /> }));
vi.mock("./firebase", () => ({ firebaseConfigured: true, getFirebaseAuth: () => ({}) }));
vi.mock("firebase/auth", () => ({
  browserLocalPersistence: {},
  browserSessionPersistence: {},
  createUserWithEmailAndPassword: vi.fn(),
  GoogleAuthProvider: vi.fn(() => ({ setCustomParameters: vi.fn() })),
  onAuthStateChanged: (_auth: unknown, onNext: (user: null) => void) => {
    onNext(null);
    return () => {};
  },
  sendPasswordResetEmail: vi.fn(),
  setPersistence: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
  updateProfile: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

it("opens on the hero screen, then Start session leads to sign-in — never straight to the dashboard", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "Callback." })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Your coaching profile" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Start session" }));

  expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Your coaching profile" })).toBeNull();
});
