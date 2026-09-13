import { useRef, useState, useCallback } from "react";
import { getFirebaseAuth } from "./firebase";

// Same base-URL/auth pattern as useConversation.ts's authedFetch.
const apiBase = (import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
async function authedFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new Error("Sign in before using text-to-speech.");
  const token = await user.getIdToken();
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${apiBase}/api${path}`, { ...options, headers });
}

export interface TTSControls {
  /** True while audio is actively playing. */
  speaking: boolean;
  /** Error message if the last speak() call failed. */
  error: string | null;
  /** Start streaming and playing the given text. Cancels any current playback. */
  speak: (text: string) => void;
  /** Stop current playback immediately. */
  cancel: () => void;
}

/**
 * useTTS — ElevenLabs live streaming TTS hook.
 *
 * Fetches audio/mpeg from the backend's /api/tts/speak endpoint and plays it
 * through an AudioContext. Sets `speaking = true` while audio plays and
 * resets it when playback ends.
 *
 * Usage:
 *   const { speak, cancel, speaking, error } = useTTS();
 *   speak("Welcome to your interview session.");
 */
export function useTTS(): TTSControls {
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs so cancel() always closes over the latest values without stale closures.
  const abortRef = useRef<AbortController | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);

  /** Stop any in-flight request and currently playing audio. */
  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;

    sourceNodeRef.current?.stop();
    sourceNodeRef.current = null;

    setSpeaking(false);
  }, []);

  const speak = useCallback(
    async (text: string) => {
      if (!text.trim()) return;

      // Cancel anything already playing.
      cancel();
      setError(null);

      const controller = new AbortController();
      abortRef.current = controller;

      // Lazily create (or reuse) the AudioContext. Browsers require a user gesture
      // before the AudioContext can produce sound — the "Start session" button
      // click is sufficient.
      if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
        audioCtxRef.current = new AudioContext();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") await ctx.resume();

      setSpeaking(true);

      try {
        const response = await authedFetch("/tts/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const msg = await response.text().catch(() => response.statusText);
          throw new Error(`TTS request failed (${response.status}): ${msg}`);
        }

        // Collect all chunks into a single ArrayBuffer, then decode + play.
        // For true streaming we would use a MediaSource/SourceBuffer pipeline,
        // but that requires codec negotiation that varies across Electron/Chrome
        // versions. Accumulate-then-decode is simpler and still starts quickly
        // because ElevenLabs streams fast enough that we receive the full audio
        // in ~0.5-1 s for most utterances.
        const arrayBuffer = await response.arrayBuffer();

        // Abort was called while we were fetching — discard silently.
        if (controller.signal.aborted) return;

        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

        if (controller.signal.aborted) return;

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);

        sourceNodeRef.current = source;

        source.onended = () => {
          if (abortRef.current === controller) {
            setSpeaking(false);
            sourceNodeRef.current = null;
          }
        };

        source.start(0);
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") return;
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[useTTS] Error:", msg);
        setError(msg);
        setSpeaking(false);
      }
    },
    [cancel]
  );

  return { speaking, error, speak, cancel };
}
