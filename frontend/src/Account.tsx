interface AccountProps {
  email: string | null;
  displayName: string | null;
  busy: boolean;
  error: string;
  onLogOut: () => void;
}

function initials(name: string | null, email: string | null) {
  if (name) return name.slice(0, 2).toUpperCase();
  if (email) return email.slice(0, 2).toUpperCase();
  return "CB";
}

export default function Account({ email, displayName, busy, error, onLogOut }: AccountProps) {
  return (
    <main className="flex-1 px-6 py-12 sm:px-12 lg:px-16 lg:py-14">
      <div className="mx-auto w-full max-w-5xl">
        <h1 className="text-[42px] leading-tight font-extrabold tracking-tight text-white">Account settings</h1>
        <p className="mt-2 text-[16px] text-white/50">Manage your Callback account.</p>

        <section className="mt-9 border border-white/15 p-7 sm:p-8" aria-labelledby="account-heading">
          <h2 id="account-heading" className="text-[14px] font-semibold uppercase tracking-[0.18em] text-white/45">Account</h2>
          <div className="mt-6 flex flex-wrap items-center gap-4">
            <div aria-hidden="true" className="flex h-14 w-14 items-center justify-center border border-white/20 text-[17px] font-semibold text-white">
              {initials(displayName, email)}
            </div>
            <div>
              {displayName && <p className="text-[18px] font-semibold text-white">{displayName}</p>}
              <p className="text-[15px] text-white/55">{email || "No email address available"}</p>
            </div>
          </div>
        </section>

        {error && <p role="alert" className="mt-5 border border-red-400/30 bg-red-400/10 p-3 text-[13px] text-red-200">{error}</p>}
        <button type="button" disabled={busy} onClick={onLogOut} className="mt-8 border border-white/25 px-6 py-3 text-[14px] font-semibold text-white transition-colors hover:border-white/60 disabled:cursor-not-allowed disabled:opacity-40">
          {busy ? "Logging out…" : "Log out"}
        </button>
      </div>
    </main>
  );
}
