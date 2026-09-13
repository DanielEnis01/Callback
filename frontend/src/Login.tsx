import { useState, type FormEvent } from "react";
import { useAuth } from "./AuthContext";
import { authErrorMessage } from "./auth-errors";
import { firebaseConfigured } from "./firebase";
import { isValidPassword, passwordPattern, passwordPolicyMessage, passwordRequirements } from "./password-policy";

type Mode = "signin" | "signup" | "reset";
const inputClass = "w-full bg-white/[0.04] border border-white/15 text-white text-[clamp(15px,1.15vw,17px)] placeholder:text-white/30 px-[clamp(16px,1.25vw,20px)] py-[clamp(12px,1.05vw,15px)] rounded-none outline-none transition-colors focus:border-white/60 disabled:opacity-50";

export default function Login() {
  const auth = useAuth();
  const [showPassword, setShowPassword] = useState(false);
  const [keepSignedIn, setKeepSignedIn] = useState(false);
  const [mode, setMode] = useState<Mode>("signin");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const needsUsername = Boolean(auth.user && !auth.user.displayName);
  const unavailable = !firebaseConfigured || Boolean(auth.initializationError);

  function switchMode(next: Mode) {
    setMode(next);
    setError("");
    setNotice("");
    setPassword("");
    setShowPassword(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (auth.busy || unavailable) return;
    setError("");
    setNotice("");
    if ((mode === "signup" || needsUsername) && !/^[a-zA-Z0-9_]{3,30}$/.test(username.trim())) {
      setError("Use 3–30 letters, numbers, or underscores for your username.");
      return;
    }
    if (mode === "signup" && !needsUsername && !isValidPassword(password)) {
      setError(passwordPolicyMessage);
      return;
    }
    try {
      if (needsUsername) await auth.saveUsername(username);
      else if (mode === "signup") await auth.signUp(username, email, password, keepSignedIn);
      else if (mode === "signin") await auth.signIn(email, password, keepSignedIn);
      else {
        await auth.resetPassword(email);
        setNotice("If an account exists for this email, you’ll receive a password reset link. Check your inbox and spam folder.");
      }
    } catch (err) {
      if (mode === "reset" && typeof err === "object" && err && "code" in err && err.code === "auth/user-not-found") {
        setNotice("If an account exists for this email, you’ll receive a password reset link. Check your inbox and spam folder.");
      } else setError(authErrorMessage(err));
    }
  }

  async function googleSignIn() {
    setError("");
    setNotice("");
    try { await auth.signInGoogle(keepSignedIn); }
    catch (err) { setError(authErrorMessage(err)); }
  }

  return (
    <main className="flex flex-col justify-center px-6 py-12 sm:px-12 lg:w-[45%] lg:min-h-screen bg-black">
      <form className="flex flex-col gap-[clamp(16px,1.3vw,20px)] max-w-[min(100%,480px)] w-full mx-auto lg:mx-0" onSubmit={submit} aria-busy={auth.busy}>
        <h1 className="text-[clamp(34px,3.1vw,46px)] leading-tight text-white tracking-tight font-extrabold">
          {needsUsername ? "Your username" : mode === "signin" ? "Sign in" : mode === "signup" ? "Sign up" : "Reset password"}
        </h1>
        <p className="text-[clamp(13px,1.05vw,16px)] leading-relaxed text-white/50 mb-2">
          {needsUsername ? "Your account is ready. Save a username to continue." : mode === "signup" ? "Create your account. Get ready for your next callback." : mode === "reset" ? "Enter your email and we’ll send you a reset link." : "Welcome back. Let’s get you interview ready."}
        </p>
        {unavailable && <p role="status" className="border border-white/15 p-3 text-[13px] leading-relaxed text-white/65">{auth.initializationError || "Account access is coming soon. Please try again later."}</p>}
        {error && <p role="alert" className="border border-red-400/30 bg-red-400/10 p-3 text-[13px] leading-relaxed text-red-200">{error}</p>}
        {notice && <p role="status" className="border border-emerald-400/30 bg-emerald-400/10 p-3 text-[13px] leading-relaxed text-emerald-200">{notice}</p>}
        <fieldset disabled={auth.busy} className="flex flex-col gap-4 min-w-0">
          {(mode === "signup" || needsUsername) && <div className="flex flex-col gap-1.5">
            <label htmlFor="username" className="text-[clamp(13px,1.05vw,15px)] text-white/70">Username</label>
            <input id="username" name="username" type="text" autoComplete="username" required minLength={3} maxLength={30} pattern="[a-zA-Z0-9_]{3,30}" title="3–30 letters, numbers, or underscores" placeholder="Choose a username" value={username} onChange={(e) => setUsername(e.target.value)} className={inputClass} aria-describedby="username-hint" />
            <span id="username-hint" className="text-[11px] text-white/40">3–30 letters, numbers, or underscores.</span>
          </div>}
          {!needsUsername && <label className="flex flex-col gap-1.5">
            <span className="text-[clamp(13px,1.05vw,15px)] text-white/70">Email address</span>
            <input name="email" type="email" autoComplete="email" required placeholder="Enter your email address" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
          </label>}
          {!needsUsername && mode !== "reset" && <div className="flex flex-col gap-1.5">
            <label htmlFor="password" className="text-[clamp(13px,1.05vw,15px)] text-white/70">Password</label>
            <div className="relative">
              <input id="password" name="password" type={showPassword ? "text" : "password"} autoComplete={mode === "signup" ? "new-password" : "current-password"} required minLength={mode === "signup" ? 8 : undefined} pattern={mode === "signup" ? passwordPattern : undefined} title={mode === "signup" ? passwordPolicyMessage : undefined} placeholder={mode === "signup" ? "Create a password" : "Enter your password"} value={password} onChange={(e) => setPassword(e.target.value)} className={`${inputClass} pr-14`} aria-describedby={mode === "signup" ? "password-hint" : undefined} />
              <button type="button" aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-white/50 hover:text-white">{showPassword ? "Hide" : "Show"}</button>
            </div>
            {mode === "signup" && <ul id="password-hint" aria-label="Password requirements" className="grid gap-1.5 mt-1 text-[11px]">
              {passwordRequirements.map((requirement) => {
                const met = requirement.test(password);
                return <li key={requirement.id} className={`flex items-center gap-2 ${met ? "text-emerald-300" : "text-white/45"}`}>
                  <span aria-hidden="true">{met ? "✓" : "○"}</span>
                  <span className="sr-only">{met ? "Met: " : "Needed: "}</span>{requirement.label}
                </li>;
              })}
            </ul>}
          </div>}
          {!needsUsername && mode !== "reset" && <div className="flex flex-wrap items-center justify-between gap-3 text-[12px]">
            <label className="flex items-center gap-2.5 text-white/70 cursor-pointer">
              <input type="checkbox" checked={keepSignedIn} onChange={(e) => setKeepSignedIn(e.target.checked)} className="h-4 w-4 accent-white" />
              Keep me signed in
            </label>
            {mode === "signin" && <button type="button" onClick={() => switchMode("reset")} className="text-white/50 underline underline-offset-4 hover:text-white/80">Reset password</button>}
          </div>}
          <button type="submit" disabled={unavailable || auth.busy} className="mt-1 w-full bg-white text-black text-[clamp(14px,1.1vw,16px)] font-semibold tracking-wide px-7 py-[clamp(12px,1.1vw,16px)] transition-opacity active:opacity-70 disabled:opacity-40 disabled:cursor-not-allowed">
            {auth.busy ? "Please wait…" : needsUsername ? "Save username" : mode === "signin" ? "Sign In" : mode === "signup" ? "Create account" : "Send reset link"}
          </button>
          {!needsUsername && mode !== "reset" && <>
            <div className="flex items-center gap-4"><span className="h-px flex-1 bg-white/12" /><span className="text-[12px] text-white/35">Or continue with</span><span className="h-px flex-1 bg-white/12" /></div>
            <button type="button" onClick={googleSignIn} disabled={unavailable || auth.busy} className="w-full flex items-center justify-center gap-3 border border-white/15 text-white text-[clamp(14px,1.1vw,16px)] font-medium px-7 py-[clamp(12px,1.1vw,16px)] transition-colors hover:border-white/40 disabled:opacity-40 disabled:cursor-not-allowed">
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#4285F4" d="M21.8 12.2c0-.7-.1-1.4-.2-2.1H12v3.9h5.5a4.7 4.7 0 0 1-2 3.1v2.6h3.3c1.9-1.8 3-4.4 3-7.5Z" />
                <path fill="#34A853" d="M12 22c2.7 0 4.9-.9 6.5-2.4l-3.3-2.6c-.9.6-2 1-3.2 1a5.6 5.6 0 0 1-5.2-3.9H3.4v2.7A9.9 9.9 0 0 0 12 22Z" />
                <path fill="#FBBC05" d="M6.8 14.1a5.9 5.9 0 0 1 0-3.8V7.6H3.4a9.9 9.9 0 0 0 0 8.8l3.4-2.3Z" />
                <path fill="#EA4335" d="M12 6.5c1.5 0 2.8.5 3.8 1.5l2.9-2.9A9.9 9.9 0 0 0 12 2a9.9 9.9 0 0 0-8.6 5l3.4 2.7A5.6 5.6 0 0 1 12 6.5Z" />
              </svg>
              Continue with Google
            </button>
          </>}
          {!needsUsername ? <p className="text-[13px] text-white/50 text-center">
            {mode === "signin" ? "Don't have an account? " : mode === "signup" ? "Already have an account? " : "Remember your password? "}
            <button type="button" onClick={() => switchMode(mode === "signin" ? "signup" : "signin")} className="text-white underline underline-offset-4">{mode === "signin" ? "Sign up" : "Sign in"}</button>
          </p> : <button type="button" onClick={async () => { try { await auth.logOut(); } catch (err) { setError(authErrorMessage(err)); } }} className="text-[13px] text-white/50 underline underline-offset-4">Sign out</button>}
        </fieldset>
      </form>
    </main>
  );
}
