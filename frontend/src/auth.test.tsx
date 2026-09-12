import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuthProvider from "./AuthContext";
import App from "./App";

const sdk = vi.hoisted(() => ({
  auth: { currentUser: null as null | { uid: string; displayName: string | null; email: string } },
  listener: null as null | ((user: unknown) => void),
  configured: true,
  persistence: vi.fn(), create: vi.fn(), login: vi.fn(), profile: vi.fn(), reset: vi.fn(), google: vi.fn(), logout: vi.fn(),
}));
vi.mock("./firebase", () => ({ getFirebaseAuth: () => sdk.auth, get firebaseConfigured() { return sdk.configured; } }));
vi.mock("./VoiceOrb", () => ({ VoiceOrb: () => <div aria-label="Voice animation" /> }));
vi.mock("firebase/auth", () => ({
  browserLocalPersistence: "local", browserSessionPersistence: "session",
  onAuthStateChanged: (_auth: unknown, listener: (user: unknown) => void) => {
    sdk.listener = listener;
    listener(sdk.auth.currentUser);
    return () => { sdk.listener = null; };
  },
  setPersistence: (...args: unknown[]) => sdk.persistence(...args),
  createUserWithEmailAndPassword: (...args: unknown[]) => sdk.create(...args),
  signInWithEmailAndPassword: (...args: unknown[]) => sdk.login(...args),
  updateProfile: (...args: unknown[]) => sdk.profile(...args),
  sendPasswordResetEmail: (...args: unknown[]) => sdk.reset(...args),
  signInWithPopup: (...args: unknown[]) => sdk.google(...args),
  signOut: (...args: unknown[]) => sdk.logout(...args),
  GoogleAuthProvider: class { setCustomParameters() {} },
}));

beforeEach(() => {
  vi.resetAllMocks();
  sdk.configured = true;
  sdk.auth.currentUser = null;
  sdk.create.mockImplementation(async (_auth, email) => {
    sdk.auth.currentUser = { uid: "test-user", email, displayName: null };
    sdk.listener?.(sdk.auth.currentUser);
    return { user: sdk.auth.currentUser };
  });
  sdk.profile.mockImplementation(async (user, profile) => Object.assign(user, profile));
  sdk.login.mockImplementation(async (_auth, email) => {
    sdk.auth.currentUser = { uid: "test-user", email, displayName: "luke_coach" };
    sdk.listener?.(sdk.auth.currentUser);
  });
  sdk.logout.mockImplementation(async () => { sdk.auth.currentUser = null; sdk.listener?.(null); });
});
afterEach(cleanup);

async function openLogin() {
  const user = userEvent.setup();
  render(<AuthProvider><App /></AuthProvider>);
  await user.click(await screen.findByRole("button", { name: "Start session" }));
  return user;
}
async function fillCredentials(user: ReturnType<typeof userEvent.setup>, password = "Secret12") {
  await user.type(screen.getByLabelText("Email address"), "luke@example.com");
  await user.type(screen.getByLabelText("Password", { exact: true }), password);
}

describe("Firebase account flow", () => {
  it("creates an account, saves its username, then allows access", async () => {
    const user = await openLogin();
    await user.click(screen.getByRole("button", { name: "Sign up" }));
    await user.type(screen.getByLabelText("Username"), "luke_coach");
    await fillCredentials(user);
    await user.click(screen.getByRole("button", { name: "Create account" }));
    await screen.findByRole("heading", { name: "Download Callback." });
    expect(sdk.create).toHaveBeenCalledWith(sdk.auth, "luke@example.com", "Secret12");
    expect(sdk.profile).toHaveBeenCalledWith(sdk.auth.currentUser, { displayName: "luke_coach" });
    expect(sdk.persistence).toHaveBeenCalledWith(sdk.auth, "session");
  });

  it("keeps failed credentials on the form and never unlocks downloads", async () => {
    sdk.login.mockRejectedValue({ code: "auth/invalid-credential" });
    const user = await openLogin();
    await fillCredentials(user);
    await user.click(screen.getByRole("button", { name: "Sign In" }));
    expect((await screen.findByRole("alert")).textContent).toContain("email or password is incorrect");
    expect(screen.queryByRole("heading", { name: "Download Callback." })).toBeNull();
  });

  it("honors persistence when signing in", async () => {
    const user = await openLogin();
    await fillCredentials(user);
    await user.click(screen.getByRole("checkbox", { name: "Keep me signed in" }));
    await user.click(screen.getByRole("button", { name: "Sign In" }));
    await screen.findByRole("heading", { name: "Download Callback." });
    expect(sdk.persistence).toHaveBeenCalledWith(sdk.auth, "local");
  });

  it("restores existing Firebase sessions", () => {
    sdk.auth.currentUser = { uid: "saved", displayName: "returning_user", email: "saved@example.com" };
    render(<AuthProvider><App /></AuthProvider>);
    expect(screen.getByRole("heading", { name: "Download Callback." })).toBeTruthy();
  });

  it("shows account details and signs out from settings", async () => {
    sdk.auth.currentUser = { uid: "saved", displayName: "returning_user", email: "saved@example.com" };
    const user = userEvent.setup();
    render(<AuthProvider><App /></AuthProvider>);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("heading", { name: "Account settings" })).toBeTruthy();
    expect(screen.getByText("saved@example.com")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Log out" }));
    await screen.findByRole("heading", { name: "Callback." });
    expect(sdk.logout).toHaveBeenCalledWith(sdk.auth);
  });

  it("sends a reset email without asking for a password", async () => {
    const user = await openLogin();
    await user.click(screen.getByRole("button", { name: "Reset password" }));
    await user.type(screen.getByLabelText("Email address"), "reset@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(sdk.reset).toHaveBeenCalledWith(sdk.auth, "reset@example.com");
    expect((await screen.findByRole("status")).textContent).toContain("If an account exists");
    expect(screen.queryByLabelText("Password", { exact: true })).toBeNull();
  });

  it("does not disclose unregistered reset addresses", async () => {
    sdk.reset.mockRejectedValue({ code: "auth/user-not-found" });
    const user = await openLogin();
    await user.click(screen.getByRole("button", { name: "Reset password" }));
    await user.type(screen.getByLabelText("Email address"), "unknown@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    expect((await screen.findByRole("status")).textContent).toContain("If an account exists");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the download page after Firebase authenticates a new account", async () => {
    sdk.profile.mockRejectedValueOnce({ code: "auth/network-request-failed" });
    const user = await openLogin();
    await user.click(screen.getByRole("button", { name: "Sign up" }));
    await user.type(screen.getByLabelText("Username"), "luke_coach");
    await fillCredentials(user);
    await user.click(screen.getByRole("button", { name: "Create account" }));
    await screen.findByRole("heading", { name: "Download Callback." });
    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(sdk.profile).toHaveBeenCalledTimes(1);
  });

  it("blocks duplicate submits while a new account is being created", async () => {
    let finishProfile!: () => void;
    sdk.profile.mockImplementation((user, profile) => new Promise<void>((resolve) => {
      finishProfile = () => { Object.assign(user, profile); resolve(); };
    }));
    const user = await openLogin();
    await user.click(screen.getByRole("button", { name: "Sign up" }));
    await user.type(screen.getByLabelText("Username"), "luke_coach");
    await fillCredentials(user);
    const submit = screen.getByRole("button", { name: "Create account" });
    await user.click(submit);
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(submit.closest("form")!);
    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading", { name: "Download Callback." })).toBeNull();
    await act(async () => finishProfile());
    await screen.findByRole("heading", { name: "Download Callback." });
  });

  it("handles canceled Google sign-in without bypassing authentication", async () => {
    sdk.google.mockRejectedValue({ code: "auth/popup-closed-by-user" });
    const user = await openLogin();
    await user.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect((await screen.findByRole("alert")).textContent).toContain("canceled");
    expect(screen.queryByRole("heading", { name: "Download Callback." })).toBeNull();
  });

  it("validates required fields and usernames", async () => {
    const user = await openLogin();
    await user.click(screen.getByRole("button", { name: "Sign up" }));
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(sdk.create).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Username"), "bad name");
    await fillCredentials(user);
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(sdk.create).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Username") as HTMLInputElement).validity.patternMismatch).toBe(true);
  });

  it("fails closed when Firebase is not configured", async () => {
    sdk.configured = false;
    await openLogin();
    expect((screen.getByRole("button", { name: "Sign In" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("coming soon");
    expect(sdk.login).not.toHaveBeenCalled();
  });

  it("removes access when Firebase reports a signed-out session", async () => {
    sdk.auth.currentUser = { uid: "saved", displayName: "returning_user", email: "saved@example.com" };
    render(<AuthProvider><App /></AuthProvider>);
    act(() => { sdk.auth.currentUser = null; sdk.listener?.(null); });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Callback." })).toBeTruthy());
  });
});

it.each([
  ["Abcdef1", "too short"],
  ["abcdef12", "missing uppercase"],
  ["ABCDEF12", "missing lowercase"],
  ["Abcdefgh", "missing number"],
])("rejects signup password %s (%s) before Firebase is called", async (password) => {
  const user = await openLogin();
  await user.click(screen.getByRole("button", { name: "Sign up" }));
  await user.type(screen.getByLabelText("Username"), "test_user");
  await fillCredentials(user, password);
  // Exercise the submit handler even if browser constraint validation is bypassed.
  fireEvent.submit(screen.getByRole("button", { name: "Create account" }).closest("form")!);
  expect((await screen.findByRole("alert")).textContent).toContain("at least 8 characters");
  expect(sdk.create).not.toHaveBeenCalled();
});

it("updates the checklist and toggles password visibility", async () => {
  const user = await openLogin();
  await user.click(screen.getByRole("button", { name: "Sign up" }));
  await user.type(screen.getByLabelText("Password"), "Abcdefg1");
  const checklist = screen.getByRole("list", { name: "Password requirements" });
  expect(checklist.textContent).not.toContain("Needed:");
  expect(checklist.textContent?.match(/Met:/g)).toHaveLength(4);
  await user.click(screen.getByRole("button", { name: "Show password" }));
  expect((screen.getByLabelText("Password") as HTMLInputElement).type).toBe("text");
  await user.click(screen.getByRole("button", { name: "Hide password" }));
  expect((screen.getByLabelText("Password") as HTMLInputElement).type).toBe("password");
});

it("does not apply new-account password rules to existing-user login", async () => {
  const user = await openLogin();
  await fillCredentials(user, "legacy");
  await user.click(screen.getByRole("button", { name: "Sign In" }));
  await screen.findByRole("heading", { name: "Download Callback." });
  expect(sdk.login).toHaveBeenCalledWith(sdk.auth, "luke@example.com", "legacy");
});
