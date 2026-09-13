import { useEffect, useRef, useState, FC } from "react";
import { X, FileText, UploadCloud, Briefcase, ArrowRight, Target } from "lucide-react";
import { getInterviewProfile, saveSessionContext, type InterviewProfile } from "./baselineStore";

interface SessionSetupProps {
  onStart: () => void;
  onCancel: () => void;
  /** Pre-fills the weakness picker below -- set when this gate was opened via
   * a "Practice this" click on the Results dashboard (see Dashboard.tsx's
   * pendingTargetWeakness). May be free text from an AI-identified weakness
   * that isn't one of MOCK_WEAKNESSES, so it's injected as an extra option
   * rather than requiring an exact match against the mock list. */
  initialWeakness?: string | null;
}

/**
 * Gate shown before every session (not just the first): pick which resume
 * this session is for, paste the job posting being practiced for, and
 * optionally pick a single weakness to target, then start. All three get
 * saved as this session's SessionContext — the resume and job posting
 * Backboard's RAG layer will eventually be pointed at, once there's a
 * backend to hand them to (see baselineStore.ts's SessionContext for the
 * shape). The weakness dropdown is mock data (MOCK_WEAKNESSES below)
 * standing in for a real per-user tracked list that doesn't exist yet, and
 * is deliberately single-select so the AI has one clear goal per session
 * instead of splitting focus across several.
 *
 * This collects the (resume, job posting, weakness) tuple fresh for every
 * session. The role being practiced for can change from session to session,
 * while the interview compares live vitals with the average-adult reference.
 */
// Mock stand-in for a real per-user weakness list, which will eventually
// come from tracked feedback across past sessions. Picking from here just
// primes the interviewer AI on what to probe for before it starts asking
// questions — it's not the only source of feedback for the session.
const MOCK_WEAKNESSES = [
  "Rambling / unfocused answers",
  "Weak eye contact",
  "Excessive filler words",
  "Rushing through answers",
  "Vague STAR examples",
  "Fidgeting / posture shifts",
  "Weak closing statements",
  "Not quantifying impact",
  "Overly technical jargon",
  "Trailing off / low vocal energy",
];

export const SessionSetup: FC<SessionSetupProps> = ({ onStart, onCancel, initialWeakness }) => {
  // getInterviewProfile() is async (it may hit the Tiger Data backend
  // instead of localStorage — see baselineStore.ts), so load it once on
  // mount rather than reading it synchronously.
  const [profile, setProfile] = useState<InterviewProfile | null>(null);
  useEffect(() => {
    let current = true;
    getInterviewProfile().then((p) => {
      if (current) setProfile(p);
    });
    return () => {
      current = false;
    };
  }, []);

  const [sessionResumeFile, setSessionResumeFile] = useState<File | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [draggingResume, setDraggingResume] = useState(false);
  const [jobPosting, setJobPosting] = useState("");
  const [selectedWeakness, setSelectedWeakness] = useState(initialWeakness || "");
  // Custom weaknesses (e.g. Gemini-identified, not in MOCK_WEAKNESSES) are
  // still selectable -- injected as a one-off extra option below.
  const weaknessOptions = selectedWeakness && !MOCK_WEAKNESSES.includes(selectedWeakness)
    ? [selectedWeakness, ...MOCK_WEAKNESSES]
    : MOCK_WEAKNESSES;
  const resumeInputRef = useRef<HTMLInputElement>(null);

  const selectResume = (file: File | undefined) => {
    if (!file) return;
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      setResumeError("Please choose a PDF resume.");
      return;
    }
    setSessionResumeFile(file);
    setResumeError(null);
  };

  // Reuse a previously saved profile resume when available; picking a new
  // file here only overrides it for this session.
  const effectiveResume = sessionResumeFile
    ? { name: sessionResumeFile.name, size: sessionResumeFile.size }
    : profile?.resume ?? null;
  const usingProfileResume = !sessionResumeFile && !!profile?.resume;
  const resumeSize = (bytes: number) =>
    bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

  const canStart = !!effectiveResume && jobPosting.trim().length > 0;


  return (
    <div
      className="h-screen w-full flex flex-col bg-black text-white overflow-hidden"
      style={{ fontFamily: "'Sora', sans-serif" }}
    >
      <header className="h-14 shrink-0 flex items-center justify-between border-b border-white/12 px-6">
        <div className="flex items-center gap-3 text-[13px]">
          <span className="font-800 tracking-tight text-[16px]" style={{ fontWeight: 800 }}>Callback.</span>
          <span className="text-white/25">/</span>
          <span className="text-white/60">Start session</span>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-8 sm:px-8">
        <form
          className="mx-auto flex w-full max-w-2xl flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (!effectiveResume) return;
            saveSessionContext({
              setAt: new Date().toISOString(),
              resume: effectiveResume,
              jobPosting: jobPosting.trim(),
              targetWeakness: selectedWeakness,
            });
            onStart();
          }}
        >
          <div>
            <p className="text-[11px] uppercase tracking-[0.16em] text-white/40">Before this session</p>
            <h1 className="mt-2 text-[32px] font-800 tracking-tight" style={{ fontWeight: 800 }}>
              What are you practicing for?
            </h1>
            <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-white/60" style={{ fontWeight: 300 }}>
              Confirm the resume and paste the job posting for this session. The job posting is required — it's
              what the AI uses to ask questions relevant to the specific role, not just your general background.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-white/80">Resume <span className="text-white/40">*</span></span>
            <input
              ref={resumeInputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="sr-only"
              onChange={(event) => selectResume(event.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => resumeInputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setDraggingResume(true);
              }}
              onDragLeave={() => setDraggingResume(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDraggingResume(false);
                selectResume(event.dataTransfer.files?.[0]);
              }}
              className={`flex min-h-32 flex-col items-center justify-center gap-2 border border-dashed px-5 py-6 text-center transition-colors ${
                draggingResume ? "border-white bg-white/10" : "border-white/30 bg-white/[0.02] hover:border-white/60"
              }`}
            >
              {effectiveResume ? (
                <>
                  <FileText className="h-6 w-6 text-white" strokeWidth={1.6} />
                  <span className="text-[14px] text-white">{effectiveResume.name}</span>
                  <span className="text-[12px] text-white/45">
                    PDF · {resumeSize(effectiveResume.size)} ·{" "}
                    {usingProfileResume ? "From calibration · click to use a different one" : "Click to replace"}
                  </span>
                </>
              ) : (
                <>
                  <UploadCloud className="h-6 w-6 text-white/65" strokeWidth={1.6} />
                  <span className="text-[14px] text-white/85">Drop a resume here, or click to browse</span>
                  <span className="text-[12px] text-white/40">
                    PDF files only — you haven&apos;t calibrated with one yet, so pick one for this session
                  </span>
                </>
              )}
            </button>
            {resumeError && <span className="text-[12px] text-red-300">{resumeError}</span>}
          </div>

          <label className="flex flex-col gap-2">
            <span className="flex items-center gap-2 text-[13px] text-white/80">
              <Briefcase className="h-3.5 w-3.5" strokeWidth={1.6} /> Job posting{" "}
              <span className="text-white/40">*</span>
            </span>
            <textarea
              value={jobPosting}
              onChange={(event) => setJobPosting(event.target.value)}
              rows={8}
              placeholder="Paste the job posting you're practicing for. Required — this is what the interviewer AI uses to ask relevant questions. It's used for this session only and won't affect your calibration profile."
              className="resize-y border border-white/20 bg-transparent px-3 py-3 text-[14px] leading-relaxed text-white outline-none placeholder:text-white/25 focus:border-white/60"
            />
            {!jobPosting.trim() && (
              <span className="text-[12px] text-white/40">Paste a job posting to continue.</span>
            )}
          </label>

          <label className="flex flex-col gap-2">
            <span className="flex items-center gap-2 text-[13px] text-white/80">
              <Target className="h-3.5 w-3.5" strokeWidth={1.6} /> Specific weakness to target{" "}
              <span className="text-white/40">
                {initialWeakness ? "Pre-filled from \"Practice this\" · change it if you'd rather focus elsewhere" : "Optional · pick one so the session stays focused"}
              </span>
            </span>
            <select
              value={selectedWeakness}
              onChange={(event) => setSelectedWeakness(event.target.value)}
              className="border border-white/20 bg-black px-3 py-2.5 text-[14px] text-white outline-none focus:border-white/60"
            >
              <option value="">No specific weakness — general practice</option>
              {weaknessOptions.map((weakness) => (
                <option key={weakness} value={weakness}>
                  {weakness}
                </option>
              ))}
            </select>
            <span className="text-[12px] text-white/40">
              The AI will use this to shape its questions before the session starts.
            </span>
          </label>

          <div className="flex items-center justify-between gap-3 pt-1">
            <button
              type="button"
              onClick={onCancel}
              className="flex h-11 items-center gap-2 border border-white/20 px-4 text-[13px] font-semibold text-white transition-colors hover:border-white/50"
            >
              <X className="h-4 w-4" strokeWidth={1.8} /> Cancel
            </button>
            <button
              type="submit"
              disabled={!canStart}
              className="flex h-11 items-center gap-2 bg-white px-5 text-[13px] font-semibold text-black transition-opacity disabled:cursor-not-allowed disabled:opacity-30 active:opacity-70"
            >
              Start session <ArrowRight className="h-4 w-4" strokeWidth={2} />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default SessionSetup;
