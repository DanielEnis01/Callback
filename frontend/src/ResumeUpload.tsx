import { useEffect, useRef, useState } from "react";
import { FileText, Loader2, UploadCloud, X } from "lucide-react";
import { getReadyResume, getSavedResume, removeResume, retryResume, uploadResume, type ResumeDocument } from "./backboard";

export function ResumeUpload({ onReadyChange }: { onReadyChange?: (resume: ResumeDocument | null) => void }) {
  const [resume, setResume] = useState(getSavedResume);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  const readyCallback = useRef(onReadyChange);
  readyCallback.current = onReadyChange;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const updateProgress = (message: string) => { if (mounted.current) setProgress(message); };
  const run = async (operation: () => Promise<ResumeDocument | null>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setProgress("Preparing resume…");
    setError(null);
    readyCallback.current?.(null);
    try {
      const next = await operation();
      if (mounted.current) {
        setResume(next);
        readyCallback.current?.(next);
      }
    } catch (err) {
      if (mounted.current) {
        setResume(getSavedResume());
        readyCallback.current?.(getReadyResume());
        setError(err instanceof Error ? err.message : "Your resume could not be uploaded.");
      }
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const select = (file?: File) => {
    if (file) void run(() => uploadResume(file, updateProgress));
  };
  const ready = !busy && !!resume && resume.documentId === getReadyResume()?.documentId;

  return (
    <div className="flex flex-col gap-2">
      <input ref={input} type="file" accept="application/pdf,.pdf" aria-label="Upload resume" className="sr-only" disabled={busy}
        onChange={(event) => { select(event.target.files?.[0]); event.target.value = ""; }} />
      <button type="button" disabled={busy} onClick={() => input.current?.click()}
        onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); if (!busy) select(event.dataTransfer.files?.[0]); }}
        className={`flex min-h-32 flex-col items-center justify-center gap-2 border border-dashed px-5 py-6 text-center transition-colors disabled:cursor-wait ${dragging ? "border-white bg-white/10" : "border-white/30 bg-white/[0.02] hover:border-white/60"}`}>
        {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : resume ? <FileText className="h-6 w-6" /> : <UploadCloud className="h-6 w-6 text-white/65" />}
        <span className="text-[14px] text-white/85">{busy ? progress : resume?.name ?? "Drop your resume here, or click to browse"}</span>
        <span className="text-[12px] text-white/45">{resume ? `${Math.max(1, Math.round(resume.size / 1024))} KB · ${ready ? "Ready for interview prep" : "Processing not complete"}` : "PDF files up to 10 MB"}</span>
        {!busy && resume && <span className="text-[12px] text-white/40">Click to replace</span>}
      </button>
      <p className="text-[11px] text-white/40">Saved on this device and sent to Gemini for each interview’s questions.</p>
      {busy && <p role="status" className="sr-only">{progress}</p>}
      {error && <p role="alert" className="text-[12px] text-red-300">{error}</p>}
      {resume && !busy && <div className="flex gap-4 text-[12px]">
        {(error || !ready) && <button type="button" onClick={() => void run(() => retryResume(updateProgress))} className="underline underline-offset-4">Retry processing</button>}
        <button type="button" onClick={() => void run(async () => { updateProgress("Removing resume…"); await removeResume(); return null; })} className="flex items-center gap-1 text-white/50 hover:text-white">
          <X className="h-3.5 w-3.5" /> Remove resume
        </button>
      </div>}
    </div>
  );
}
