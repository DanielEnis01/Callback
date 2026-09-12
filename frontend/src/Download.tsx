import { FC } from "react";

const AppleIcon = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M16.4 12.6c0-2.2 1.8-3.3 1.9-3.4-1-1.5-2.6-1.7-3.2-1.7-1.4-.1-2.6.8-3.3.8-.7 0-1.7-.8-2.8-.8-1.5 0-2.8.8-3.6 2.2-1.5 2.6-.4 6.5 1.1 8.6.7 1 1.6 2.2 2.7 2.2 1.1 0 1.5-.7 2.8-.7 1.3 0 1.6.7 2.8.7 1.1 0 1.9-1 2.6-2 .8-1.2 1.2-2.3 1.2-2.4-.1 0-2.2-.9-2.2-3.3ZM14.3 6c.6-.7 1-1.7.9-2.7-.9 0-1.9.6-2.5 1.3-.5.6-1 1.6-.9 2.6 1 .1 1.9-.5 2.5-1.2Z" />
  </svg>
);

const WindowsIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M3 5.4 10.4 4.4v6.6H3V5.4Zm0 13.2 7.4 1v-6.5H3v5.5Zm8.3 1.1L21 21V13h-9.7v6.7Zm0-15.4V11H21V3l-9.7 1.3Z" />
  </svg>
);

export const Download: FC = () => {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-12 lg:h-screen bg-black overflow-hidden">
      <div className="flex w-full max-w-[560px] flex-col items-center gap-10 text-center">
        <div className="flex flex-col gap-3">
          <h1 className="text-[44px] leading-[1.05] font-800 text-white tracking-tight" style={{ fontWeight: 800 }}>
            Download Callback.
          </h1>
          <p className="text-[16px] text-white/50 max-w-[420px] mx-auto" style={{ fontWeight: 300 }}>
            Install the desktop app to run your interview sessions with real time gaze, posture, and filler tracking.
          </p>
        </div>

        <div className="grid w-full grid-cols-1 gap-4 sm:grid-cols-2">
          <a href="#" className="group flex flex-col items-center gap-3 border border-white/15 px-6 py-8 rounded-none text-white transition-colors hover:border-white/50">
            <AppleIcon />
            <span className="text-[15px] font-semibold">Download for macOS</span>
            <span className="text-[12px] text-white/40">Universal · Apple Silicon & Intel</span>
          </a>

          <a href="#" className="group flex flex-col items-center gap-3 border border-white/15 px-6 py-8 rounded-none text-white transition-colors hover:border-white/50">
            <WindowsIcon />
            <span className="text-[15px] font-semibold">Download for Windows</span>
            <span className="text-[12px] text-white/40">Windows 10 & 11 · 64-bit</span>
          </a>
        </div>

        <p className="text-[12px] text-white/30">By downloading you agree to our terms and privacy policy.</p>
      </div>
    </div>
  );
};

export default Download;
