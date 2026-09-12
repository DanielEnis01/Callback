import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";

vi.mock("./VoiceOrb", () => ({ VoiceOrb: () => <div aria-label="Voice animation" /> }));

afterEach(() => {
  vi.restoreAllMocks();
});

it("opens the practice dashboard without Firebase authentication", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "Your coaching profile" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Sign In" })).toBeNull();
});
