import { useState, FC } from "react";

interface LoginProps {
  onSignIn: () => void;
}

export const Login: FC<LoginProps> = ({ onSignIn }) => {
  const [showPassword, setShowPassword] = useState(false);
  const [keepSignedIn, setKeepSignedIn] = useState(false);
  const [mode, setMode] = useState<"signin" | "signup">("signin");

  return (
    <div className="flex flex-col justify-center px-12 lg:w-[48%] lg:h-screen bg-black overflow-hidden">
      <form
        className="flex flex-col gap-4 max-w-[420px] w-full"
        onSubmit={(e) => {
          e.preventDefault();
          onSignIn();
        }}
      >
        <h1 className="text-[34px] leading-tight font-800 text-white tracking-tight" style={{ fontWeight: 800 }}>
          {mode === "signin" ? "Sign in" : "Sign up"}
        </h1>

        {/* Email */}
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] text-white/70">Email address</span>
          <input
            type="email"
            placeholder="Enter your email address"
            className="w-full bg-white/[0.04] border border-white/15 text-white text-[15px] placeholder:text-white/30 px-4 py-3 rounded-none outline-none transition-colors focus:border-white/50"
          />
        </label>

        {/* Password */}
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] text-white/70">Password</span>
          <div className="relative">
            <input
              type={showPassword ? "text" : "password"}
              placeholder="Enter your password"
              className="w-full bg-white/[0.04] border border-white/15 text-white text-[15px] placeholder:text-white/30 px-4 py-3 pr-12 rounded-none outline-none transition-colors focus:border-white/50"
            />
            <button
              type="button"
              aria-label={showPassword ? "Hide password" : "Show password"}
              onClick={() => setShowPassword((s) => !s)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 transition-colors hover:text-white/80"
            >
              {showPassword ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3l18 18" />
                  <path d="M10.6 5.1A9.9 9.9 0 0 1 12 5c6 0 10 7 10 7a17.7 17.7 0 0 1-3.4 4.1" />
                  <path d="M6.6 6.6A17.7 17.7 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 4.4-1" />
                  <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>
        </label>

        {/* Options row */}
        <div className="flex items-center justify-between text-[13px]">
          <button
            type="button"
            onClick={() => setKeepSignedIn((s) => !s)}
            className="flex items-center gap-2.5 text-white/70 transition-opacity active:opacity-70"
          >
            <span
              className="flex h-4 w-4 items-center justify-center border border-white/40"
              style={{ background: keepSignedIn ? "#ffffff" : "transparent" }}
            >
              {keepSignedIn && <span className="h-2 w-2 bg-black" />}
            </span>
            Keep me signed in
          </button>
          {mode === "signin" && (
            <a href="#" className="text-white/50 underline underline-offset-4 transition-colors hover:text-white/80">
              Reset password
            </a>
          )}
        </div>

        {/* Submit */}
        <button
          type="submit"
          className="mt-1 w-full bg-white text-black text-[14px] font-semibold tracking-wide px-7 py-3 rounded-none transition-opacity active:opacity-70"
          style={{ letterSpacing: "0.03em" }}
        >
          {mode === "signin" ? "Sign In" : "Create account"}
        </button>

        {/* Divider */}
        <div className="flex items-center gap-4">
          <span className="h-px flex-1 bg-white/12" />
          <span className="text-[12px] text-white/35">Or continue with</span>
          <span className="h-px flex-1 bg-white/12" />
        </div>

        {/* Google */}
        <button
          type="button"
          onClick={onSignIn}
          className="w-full flex items-center justify-center gap-3 border border-white/15 text-white text-[14px] font-medium px-7 py-3 rounded-none transition-colors hover:border-white/40"
        >
          <svg width="18" height="18" viewBox="0 0 24 24">
            <path fill="#EA4335" d="M12 10.2v3.9h5.5a4.7 4.7 0 0 1-2 3.1v2.6h3.3c1.9-1.8 3-4.4 3-7.5 0-.7-.1-1.4-.2-2.1H12Z" />
            <path fill="#4285F4" d="M21.8 12.2c0-.7-.1-1.4-.2-2.1H12v3.9h5.5a4.7 4.7 0 0 1-2 3.1v2.6h3.3c1.9-1.8 3-4.4 3-7.5Z" />
            <path fill="#34A853" d="M12 22c2.7 0 4.9-.9 6.5-2.4l-3.3-2.6c-.9.6-2 1-3.2 1a5.6 5.6 0 0 1-5.2-3.9H3.4v2.7A9.9 9.9 0 0 0 12 22Z" />
            <path fill="#FBBC05" d="M6.8 14.1a5.9 5.9 0 0 1 0-3.8V7.6H3.4a9.9 9.9 0 0 0 0 8.8l3.4-2.3Z" />
            <path fill="#EA4335" d="M12 6.5c1.5 0 2.8.5 3.8 1.5l2.9-2.9A9.9 9.9 0 0 0 12 2a9.9 9.9 0 0 0-8.6 5l3.4 2.7A5.6 5.6 0 0 1 12 6.5Z" />
          </svg>
          Continue with Google
        </button>

        {/* Switch mode */}
        <p className="text-[13px] text-white/50 text-center">
          {mode === "signin" ? "Don't have an account? " : "Already have an account? "}
          <button
            type="button"
            onClick={() => setMode((m) => (m === "signin" ? "signup" : "signin"))}
            className="text-white underline underline-offset-4 transition-opacity active:opacity-70"
          >
            {mode === "signin" ? "Sign up" : "Sign in"}
          </button>
        </p>
      </form>
    </div>
  );
};

export default Login;
