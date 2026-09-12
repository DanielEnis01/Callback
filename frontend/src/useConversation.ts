import { useCallback, useEffect, useRef, useState } from "react";

const GEMINI_SPEAK_URL = "http://localhost:3001/api/services/gemini/speak";
const TTS_ONLY_URL = "http://localhost:3001/api/tts/speak";
const STT_URL = "http://localhost:3001/api/stt/transcribe";

const OPENING_GREETING =
  "Hi! Welcome to your mock interview session. I'm your Callback recruiter. " +
  "Whenever you're ready, go ahead and tell me a little about yourself.";

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
export function useConversation(): ConversationControls {
  const [listening, setListening] = useState(false);
  const [aiSpeaking, setAiSpeaking] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [history, setHistory] = useState<ConversationTurn[]>([]);
  const [error, setError] = useState<string | null>(null);

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
  const isSpeakingRef = useRef(false);    // VAD state: are we in a speech segment?

  // "Latest ref" pattern — lets VAD poll callbacks call these without stale closures.
  const sendMessageRef = useRef<(text: string) => Promise<void>>(async () => {});

  historyRef.current = history;

  // ── AudioContext helpers ──────────────────────────────────────────────────────

  const getCtx = useCallback(async (): Promise<AudioContext> => {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new AudioContext();
    }
    if (audioCtxRef.current.state === "suspended") {
      await audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
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
        src.onended = () => { sourceNodeRef.current = null; resolve(); };
        src.start(0);
      });
    },
    [getCtx]
  );

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
          const res = await fetch(STT_URL, {
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
          const n = (data[i] / 128) - 1;
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
        const res = await fetch(GEMINI_SPEAK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, history: historyRef.current }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const body = await res.text().catch(() => res.statusText);
          const hint = body.includes("GEMINI_API_KEY")
            ? "Add GEMINI_API_KEY to backend/.env and restart the server."
            : body;
          throw new Error(`Recruiter error (${res.status}): ${hint}`);
        }

        const { text: replyText, audio } = await res.json();
        if (controller.signal.aborted) return;

        // Update multi-turn history.
        const next: ConversationTurn[] = [
          ...historyRef.current,
          { role: "user", parts: [{ text }] },
          { role: "model", parts: [{ text: replyText }] },
        ];
        historyRef.current = next;
        setHistory(next);

        // Decode base64 → play.
        const binary = atob(audio);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        await decodeAndPlay(bytes.buffer, controller);

        if (controller.signal.aborted) return;
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

      try {
        const res = await fetch(TTS_ONLY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: OPENING_GREETING }),
          signal: controller.signal,
        });
        if (res.ok) {
          const buf = await res.arrayBuffer();
          await decodeAndPlay(buf, controller);
        }
      } catch (err: unknown) {
        if (!(err instanceof Error && err.name === "AbortError")) {
          console.error("[Conversation] Greeting error:", err);
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
    error,
    startListening,
    stopListening,
    sendMessage,
    cancelAudio,
  };
}
