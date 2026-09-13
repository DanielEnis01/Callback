import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";

vi.mock("./VoiceOrb", () => ({ VoiceOrb: () => <div aria-label="Voice animation" /> }));
// Independent of whatever real keys happen to be in .env: this test locks
// in the fallback for a checkout with no Firebase project configured yet.
vi.mock("./firebase", () => ({ firebaseConfigured: false, getFirebaseAuth: () => ({}) }));

afterEach(() => {
  vi.restoreAllMocks();
});

it("falls back to the practice dashboard when Firebase isn't configured", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "Your coaching profile" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Sign In" })).toBeNull();
});
