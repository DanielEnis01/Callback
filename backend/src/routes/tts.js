import { Router } from "express";
import { synthesizeSpeech } from "../services/elevenlabs.js";

const router = Router();

/**
 * POST /api/tts/speak
 * Body: { text: string, voiceId?: string }
 *
 * Streams ElevenLabs audio/mpeg directly to the client so playback can begin
 * before synthesis is complete. The frontend's useTTS hook reads the
 * response body as a ReadableStream and feeds it to an AudioContext.
 */
router.post("/speak", async (req, res) => {
  const { text, voiceId } = req.body ?? {};

  if (!text || typeof text !== "string" || text.trim() === "") {
    return res.status(400).json({ error: "Missing or empty 'text' field." });
  }

  console.log(`[TTS] Synthesizing (${text.length} chars): "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`);

  try {
    const audioStream = await synthesizeSpeech({ text: text.trim(), voiceId });

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("Cache-Control", "no-cache");
    // Allow the frontend (Vite dev server or Electron renderer) to read the response.
    res.setHeader("Access-Control-Allow-Origin", "*");

    audioStream.pipe(res);

    audioStream.on("error", (err) => {
      console.error("[TTS] Stream error:", err);
      if (!res.headersSent) {
        res.status(502).json({ error: "Audio stream error." });
      } else {
        res.destroy(err);
      }
    });
  } catch (err) {
    console.error("[TTS] synthesizeSpeech failed:", err);
    res.status(500).json({ error: err.message ?? "TTS synthesis failed." });
  }
});

export default router;
