import { useCallback, useEffect, useRef, useState } from "react";
import { getFirebaseAuth } from "./firebase";
import { getSessionContext } from "./baselineStore";

// Matches the base-URL/auth pattern in dataApi.ts's apiRequest, but without
// its fixed 15s timeout -- a Gemini + ElevenLabs round trip (and this hook's
// own barge-in cancellation via AbortController) don't fit that budget well.
const apiBase = (import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
async function authedFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new Error("Sign in before starting a session.");
  const token = await user.getIdToken();
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${apiBase}/api${path}`, { ...options, headers });
}

// Best-effort fallback if the Gemini-generated opening line fails outright
// (e.g. GEMINI_API_KEY missing/invalid) — better than a silent, greeting-less
// session. The normal path replaces this with a line generated per-session
// from the job posting/weakness picked at session setup (see the mount
// effect below and gemini.js's generateOpeningLine).
const FALLBACK_OPENING_GREETING =
  "Hi! Welcome to your mock interview session. I'm your Callback recruiter. " +
  "Whenever you're ready, go ahead and tell me a little about yourself.";

// Used when the five-question plan couldn't be built. The greeting itself
// deliberately asks nothing (question one normally follows it), so without
// this the candidate would be greeted and then left in silence.
const UNSTRUCTURED_OPENING_QUESTION =
  "To get us started, tell me a little about yourself and what drew you to this role.";

// ── Voice Activity Detection thresholds ────────────────────────────────────────
/** RMS amplitude that counts as "speech started". Lower = more sensitive. */
const SPEECH_THRESHOLD = 0.012;
/** How long silence must last (ms) after speech before we send the clip. */
const SILENCE_AFTER_SPEECH_MS = 1400;
/** Minimum speech duration (ms) before we bother sending anything. */
const MIN_SPEECH_MS = 350;

export interface ConversationTurn {
  role: "user" | "model";
  parts: [{ text: string }];
  /** Which planned question this turn belongs to (0-4). Absent on the
   * opening greeting and on unstructured sessions with no plan. */
  questionIndex?: number;
  /** True when this turn was a clarifying follow-up rather than a new question. */
  isClarifying?: boolean;
}

export interface InterviewQuestion {
  type: "behavioral" | "resume" | "job_posting";
  text: string;
  focus: string;
  /** Set when this is a deliberate re-ask of a question the candidate
   * previously fumbled -- the sessionId it is being repeated from. */
  repeatOf?: string | null;
}

export interface ConversationControls {
  /** Mic is active and listening for speech. */
  listening: boolean;
  /** AI audio is currently playing. */
  aiSpeaking: boolean;
  /** Live volume level 0-1 (drives mic indicator animation). */
  micLevel: number;
  /** Full multi-turn history sent to Gemini on each turn. */
  history: ConversationTurn[];
  /**
   * The live transcript, read straight off the ref rather than React state.
   *
   * Anything saving the transcript MUST use this instead of `history`:
   * `history` is a snapshot of the render it was read in, and ending a
   * session is asynchronous (flushing metrics, closing out the session row),
   * so a turn that lands during those awaits is missing from the `history`
   * the closure captured -- which is exactly how a session ends up saved
   * with a partial transcript.
   */
  getHistory: () => ConversationTurn[];
  /** The five planned questions for this session, once they've loaded. */
  plan: InterviewQuestion[];
  /** How many of the planned questions have been asked so far. */
  questionIndex: number;
  /** True once the recruiter has closed out the interview -- the session should end. */
  interviewComplete: boolean;
  error: string | null;
  startListening: () => void;
  stopListening: () => void;
  /** Send any text through Gemini → TTS (used by DevPanel). */
  sendMessage: (text: string) => void;
  cancelAudio: () => void;
}

/**
 * useConversation — live voice conversation loop.
 *
 * STT: getUserMedia → MediaRecorder + Web Audio VAD (no Web Speech API / no
 *      Google cloud dependency — works fully offline except for ElevenLabs calls).
 *
 * Flow:
 *  1. Mount   → play opening greeting via ElevenLabs TTS
 *  2. Greeting ends → mic opens (getUserMedia)
 *  3. VAD detects speech → MediaRecorder starts
 *  4. VAD detects silence (1.4 s) → audio blob sent to POST /api/stt/transcribe
 *  5. ElevenLabs Scribe returns transcript → POST /api/services/gemini/speak
 *  6. Response { text, audio (base64) } → decode → play AudioContext
 *  7. Audio ends → VAD loop resumes → repeat from step 3
 */
export function useConversation(sessionId?: string): ConversationControls {
  const [listening, setListening] = useState(false);
  const [aiSpeaking, setAiSpeaking] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [history, setHistory] = useState<ConversationTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<InterviewQuestion[]>([]);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [interviewComplete, setInterviewComplete] = useState(false);

  // ── Mutable refs ─────────────────────────────────────────────────────────────
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const historyRef = useRef<ConversationTurn[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const shouldListenRef = useRef(false);
  const aiSpeakingRef = useRef(false);
  const greetingPlayedRef = useRef(false);
  const vadRafRef = useRef<number>(0);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speechStartTimeRef = useRef<number>(0);
  const isSpeakingRef = useRef(false); // VAD state: are we in a speech segment?
  const planRef = useRef<InterviewQuestion[]>([]);
  const questionIndexRef = useRef(0);
  const completeRef = useRef(false);
  const clarifyingRef = useRef(false);
  const sessionIdRef = useRef<string | undefined>(sessionId);
  sessionIdRef.current = sessionId;

  // "Latest ref" pattern — lets VAD poll callbacks call these without stale closures.
  const sendMessageRef = useRef<(text: string) => Promise<void>>(async () => {});

  historyRef.current = history;

  // ── AudioContext helpers ──────────────────────────────────────────────────────

  const getCtx = useCallback(async (): Promise<AudioContext> => {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new AudioContext();
    }
    const ctx = audioCtxRef.current;
    if (ctx.state === "suspended") {
      // An AudioContext created outside a user gesture starts suspended, and
      // resume() then stays PENDING FOREVER until the browser sees a gesture
      // -- it does not reject. Awaiting it bare meant the greeting sat
      // undelivered until the user clicked something (End Session being the
      // only button on screen), and because startListening() runs in the
      // finally of that same chain, the mic never opened either. Racing a
      // timeout keeps a blocked resume from taking the session down with it.
      await Promise.race([
        ctx.resume(),
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]);
    }
    return ctx;
  }, []);

  const cancelAudio = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    sourceNodeRef.current?.stop();
    sourceNodeRef.current = null;
    aiSpeakingRef.current = false;
    setAiSpeaking(false);
  }, []);

  const decodeAndPlay = useCallback(
    async (buf: ArrayBuffer, controller: AbortController): Promise<void> => {
      if (controller.signal.aborted) return;
      const ctx = await getCtx();
      const audioBuf = await ctx.decodeAudioData(buf);
      if (controller.signal.aborted) return;
      return new Promise((resolve) => {
        const src = ctx.createBufferSource();
        src.buffer = audioBuf;
        src.connect(ctx.destination);
        sourceNodeRef.current = src;
        src.onended = () => {
          sourceNodeRef.current = null;
          resolve();
        };
        src.start(0);
      });
    },
    [getCtx]
  );

  // Create the AudioContext as early as possible and resume it on the first
  // user interaction. The click that started the session usually counts, but
  // the context used to be created several awaits later -- long after that
  // activation was worth anything -- so it came up suspended and silent.
  useEffect(() => {
    const ctx = audioCtxRef.current ?? (audioCtxRef.current = new AudioContext());
    const unlock = () => { if (ctx.state === "suspended") void ctx.resume(); };
    unlock();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // ── VAD + MediaRecorder STT ───────────────────────────────────────────────────

  const stopVAD = useCallback(() => {
    cancelAnimationFrame(vadRafRef.current);
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    isSpeakingRef.current = false;
    setListening(false);
    setMicLevel(0);
  }, []);

  const stopListening = useCallback(() => {
    shouldListenRef.current = false;
    stopVAD();
    // Release the microphone so the OS indicator goes away.
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
  }, [stopVAD]);

  /** Send audio blob → ElevenLabs STT → transcript text */
  const transcribeBlob = useCallback(async (blob: Blob): Promise<string> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = (reader.result as string).split(",")[1];
        try {
          const res = await authedFetch("/stt/transcribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ audio: base64, mimeType: blob.type }),
          });
          if (!res.ok) {
            console.error("[STT] HTTP error", res.status);
            resolve("");
            return;
          }
          const { text } = await res.json();
          resolve(text ?? "");
        } catch (err) {
          console.error("[STT] fetch error:", err);
          resolve("");
        }
      };
      reader.readAsDataURL(blob);
    });
  }, []);

  /** Start VAD loop on the given mic stream + audio context analyser. */
  const startVAD = useCallback(
    (stream: MediaStream, analyser: AnalyserNode) => {
      const data = new Uint8Array(analyser.frequencyBinCount);
      isSpeakingRef.current = false;

      const finishSpeech = () => {
        if (!recorderRef.current || recorderRef.current.state === "inactive") return;
        isSpeakingRef.current = false;
        setListening(false);

        const mimeType = recorderRef.current.mimeType;
        recorderRef.current.onstop = async () => {
          const blob = new Blob(chunksRef.current, { type: mimeType });
          chunksRef.current = [];
          // Only transcribe if we have meaningful audio.
          if (blob.size < 1000) return;
          const text = await transcribeBlob(blob);
          if (text.trim() && shouldListenRef.current && !aiSpeakingRef.current) {
            void sendMessageRef.current(text.trim());
          } else if (shouldListenRef.current && !aiSpeakingRef.current) {
            // Nothing recognised — resume VAD immediately.
            startVAD(stream, analyser);
          }
        };
        recorderRef.current.stop();
        recorderRef.current = null;
      };

      const poll = () => {
        if (!shouldListenRef.current || aiSpeakingRef.current) {
          setMicLevel(0);
          vadRafRef.current = requestAnimationFrame(poll);
          return;
        }

        analyser.getByteTimeDomainData(data);
        // Compute RMS amplitude.
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const n = data[i] / 128 - 1;
          sum += n * n;
        }
        const rms = Math.sqrt(sum / data.length);
        setMicLevel(Math.min(rms / SPEECH_THRESHOLD, 1));

        if (rms > SPEECH_THRESHOLD) {
          if (!isSpeakingRef.current) {
            // Speech just started — begin recording.
            isSpeakingRef.current = true;
            speechStartTimeRef.current = Date.now();
            chunksRef.current = [];
            const rec = new MediaRecorder(stream);
            rec.ondataavailable = (e) => {
              if (e.data.size > 0) chunksRef.current.push(e.data);
            };
            rec.start(100);
            recorderRef.current = rec;
            setListening(true);
          }
          // Voice detected — reset the silence countdown.
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
          silenceTimerRef.current = setTimeout(() => {
            const elapsed = Date.now() - speechStartTimeRef.current;
            if (elapsed >= MIN_SPEECH_MS) {
              finishSpeech();
            } else {
              // Too short (cough/noise) — discard and keep listening.
              if (recorderRef.current && recorderRef.current.state !== "inactive") {
                recorderRef.current.onstop = null;
                recorderRef.current.stop();
                recorderRef.current = null;
              }
              chunksRef.current = [];
              isSpeakingRef.current = false;
              setListening(false);
            }
          }, SILENCE_AFTER_SPEECH_MS);
        }

        vadRafRef.current = requestAnimationFrame(poll);
      };

      vadRafRef.current = requestAnimationFrame(poll);
    },
    [transcribeBlob]
  );

  const startListening = useCallback(async () => {
    if (micStreamRef.current) return; // already open

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      micStreamRef.current = stream;

      const ctx = await getCtx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      // Note: do NOT connect analyser to destination — we don't want mic playback.

      shouldListenRef.current = true;
      startVAD(stream, analyser);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Mic] getUserMedia failed:", msg);
      setError(`Microphone access failed: ${msg}. Check System Settings → Privacy → Microphone.`);
    }
  }, [getCtx, startVAD]);

  // ── Gemini → TTS ─────────────────────────────────────────────────────────────

  useEffect(() => {
    sendMessageRef.current = async (text: string) => {
      if (!text.trim()) return;

      cancelAudio();
      stopVAD();
      setError(null);
      aiSpeakingRef.current = true;
      setAiSpeaking(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const sessionContext = getSessionContext();
        // Plan-driven turn when a plan loaded (the normal path); the
        // free-form /gemini/speak endpoint stays the fallback so a failed
        // plan fetch degrades to an unstructured conversation instead of
        // bricking the session.
        const usePlan = planRef.current.length > 0;
        const questionIndexBefore = questionIndexRef.current;
        const wasClarifying = clarifyingRef.current;
        const res = await authedFetch(usePlan ? "/services/gemini/interview-turn" : "/services/gemini/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            usePlan
              ? {
                  message: text,
                  history: historyRef.current,
                  plan: planRef.current,
                  questionIndex: questionIndexRef.current,
                  targetWeakness: sessionContext?.targetWeakness,
                }
              : {
                  message: text,
                  history: historyRef.current,
                  jobPosting: sessionContext?.jobPosting,
                  targetWeakness: sessionContext?.targetWeakness,
                }
          ),
          signal: controller.signal,
        });

        if (!res.ok) {
          const body = await res.text().catch(() => res.statusText);
          const hint = body.includes("GEMINI_API_KEY")
            ? "Add GEMINI_API_KEY to backend/.env and restart the server."
            : body;
          throw new Error(`Recruiter error (${res.status}): ${hint}`);
        }

        const { text: replyText, audio, state } = await res.json();
        if (controller.signal.aborted) return;
        if (state) {
          questionIndexRef.current = state.askedQuestionIndex ?? questionIndexRef.current;
          setQuestionIndex(questionIndexRef.current);
          clarifyingRef.current = Boolean(state.isClarifying);
          if (state.interviewComplete) {
            completeRef.current = true;
            // Surfaced only after the closing line finishes playing below,
            // so the session doesn't cut off mid-sentence.
          }
        }

        // Update multi-turn history.
        // questionIndex/isClarifying are stamped onto the turns themselves so
        // the saved transcript can be paired back to the plan later. The
        // answer belongs to whichever question was live when it was given --
        // i.e. the index BEFORE this turn possibly advanced it.
        const answeredIndex = Math.max(0, questionIndexBefore - 1);
        const next: ConversationTurn[] = [
          ...historyRef.current,
          { role: "user", parts: [{ text }], questionIndex: answeredIndex, isClarifying: wasClarifying },
          { role: "model", parts: [{ text: replyText }], questionIndex: questionIndexRef.current - 1, isClarifying: Boolean(state?.isClarifying) },
        ];
        historyRef.current = next;
        setHistory(next);

        // Decode base64 → play.
        const binary = atob(audio);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        await decodeAndPlay(bytes.buffer, controller);

        if (controller.signal.aborted) return;
        // The recruiter has finished its closing line -- let the session end.
        if (completeRef.current) setInterviewComplete(true);
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") return;
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[Conversation] sendMessage error:", msg);
        setError(msg);
      } finally {
        aiSpeakingRef.current = false;
        setAiSpeaking(false);
        // Re-open mic once AI finishes speaking.
        if (shouldListenRef.current && micStreamRef.current) {
          const ctx = audioCtxRef.current;
          if (ctx) {
            const source = ctx.createMediaStreamSource(micStreamRef.current);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            source.connect(analyser);
            setTimeout(() => startVAD(micStreamRef.current!, analyser), 300);
          }
        }
      }
    };
  });

  const sendMessage = useCallback((text: string) => {
    void sendMessageRef.current(text);
  }, []);

  // ── Mount: greeting → start loop ─────────────────────────────────────────────

  useEffect(() => {
    if (greetingPlayedRef.current) return;
    greetingPlayedRef.current = true;

    const run = async () => {
      await new Promise<void>((r) => setTimeout(r, 700));

      aiSpeakingRef.current = true;
      setAiSpeaking(true);

      const controller = new AbortController();
      abortRef.current = controller;

      const sessionContext = getSessionContext();

      const play = async (audioB64: string) => {
        const binary = atob(audioB64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        await decodeAndPlay(bytes.buffer, controller);
      };

      try {
        // Start the five-question plan but DO NOT await it yet. It is by far
        // the slowest call in the app -- a Gemini pass over the full job
        // posting plus the resume PDF -- and blocking the greeting behind it
        // is what left the session sitting in silence after "Start". The
        // greeting goes out immediately and its own playback covers most of
        // the plan's latency.
        const planPromise = (async (): Promise<InterviewQuestion[]> => {
          try {
            const planRes = await authedFetch("/services/gemini/interview-plan", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              // sessionId lets the backend store the extracted role on the
              // session, so Results shows "Software Engineering Intern at
              // Lyft" instead of the job posting's opening sentence.
              // targetWeakness drives practice mode: the backend resolves it
              // to a trait + current score and builds every question to
              // exercise that skill. See getTraitStanding in analytics.js.
              body: JSON.stringify({
                jobPosting: sessionContext?.jobPosting ?? "",
                sessionId: sessionIdRef.current,
                targetWeakness: sessionContext?.targetWeakness,
              }),
              signal: controller.signal,
            });
            if (planRes.ok) return (await planRes.json()).questions ?? [];
            console.warn("[Conversation] interview plan failed, falling back to unstructured:", planRes.status);
          } catch (planErr) {
            if (!(planErr instanceof Error && planErr.name === "AbortError")) {
              console.warn("[Conversation] interview plan failed, falling back to unstructured:", planErr);
            }
          }
          return [];
        })();

        // 1. Warm welcome, straight away. Deliberately asks nothing -- the
        //    first real question follows once the plan lands.
        const greetRes = await authedFetch("/services/gemini/greeting", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jobPosting: sessionContext?.jobPosting,
            targetWeakness: sessionContext?.targetWeakness,
          }),
          signal: controller.signal,
        });
        if (!greetRes.ok) {
          const body = await greetRes.text().catch(() => greetRes.statusText);
          throw new Error(`Recruiter greeting error (${greetRes.status}): ${body}`);
        }
        const { text: greetingText, audio: greetingAudio } = await greetRes.json();

        // Seed history with the opening line so later turns remember what was
        // already said instead of repeating themselves.
        historyRef.current = [{ role: "model", parts: [{ text: greetingText }] }];
        setHistory(historyRef.current);
        await play(greetingAudio);
        if (controller.signal.aborted) return;

        // 2. Plan should be ready by now -- ask question one.
        const questions = await planPromise;
        if (controller.signal.aborted) return;
        planRef.current = questions;
        setPlan(questions);

        if (questions.length > 0) {
          const firstRes = await authedFetch("/services/gemini/interview-turn", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              plan: questions,
              questionIndex: 0,
              alreadyGreeted: true,
              targetWeakness: sessionContext?.targetWeakness,
            }),
            signal: controller.signal,
          });
          if (!firstRes.ok) {
            const body = await firstRes.text().catch(() => firstRes.statusText);
            throw new Error(`First question error (${firstRes.status}): ${body}`);
          }
          const { text: questionText, audio: questionAudio, state } = await firstRes.json();
          questionIndexRef.current = state?.askedQuestionIndex ?? 1;
          setQuestionIndex(questionIndexRef.current);
          // Merged into the greeting turn rather than appended as a second
          // model turn, so the history Gemini sees keeps alternating roles
          // and the saved transcript reads as one opening from the recruiter.
          historyRef.current = [{ role: "model", parts: [{ text: `${greetingText} ${questionText}` }] }];
          setHistory(historyRef.current);
          await play(questionAudio);
        } else {
          // No plan -- the greeting asked nothing, so don't leave them in
          // silence waiting for a question that isn't coming.
          const fallbackRes = await authedFetch("/tts/speak", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: UNSTRUCTURED_OPENING_QUESTION }),
            signal: controller.signal,
          });
          historyRef.current = [{ role: "model", parts: [{ text: `${greetingText} ${UNSTRUCTURED_OPENING_QUESTION}` }] }];
          setHistory(historyRef.current);
          if (fallbackRes.ok) await decodeAndPlay(await fallbackRes.arrayBuffer(), controller);
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") return;
        console.error("[Conversation] Greeting error, falling back to static line:", err);
        setError(err instanceof Error ? err.message : String(err));
        // Best-effort fallback so the session isn't silently greeting-less.
        try {
          const fallbackController = new AbortController();
          abortRef.current = fallbackController;
          const res = await authedFetch("/tts/speak", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: FALLBACK_OPENING_GREETING }),
            signal: fallbackController.signal,
          });
          if (res.ok) {
            const buf = await res.arrayBuffer();
            await decodeAndPlay(buf, fallbackController);
          }
        } catch {
          // Give up silently — the mic still opens below either way.
        }
      } finally {
        aiSpeakingRef.current = false;
        setAiSpeaking(false);
        // Open the mic after the greeting finishes.
        await startListening();
      }
    };

    run();

    return () => {
      shouldListenRef.current = false;
      stopVAD();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      cancelAudio();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    listening,
    aiSpeaking,
    micLevel,
    history,
    getHistory: () => historyRef.current,
    plan,
    questionIndex,
    interviewComplete,
    error,
    startListening,
    stopListening,
    sendMessage,
    cancelAudio,
  };
}
