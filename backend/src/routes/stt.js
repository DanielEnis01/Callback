import { Router } from "express";
import { transcribeAudio } from "../services/stt.js";

const router = Router();

/**
 * POST /api/stt/transcribe
 * Body JSON: { audio: string (base64), mimeType: string }
 *
 * Decodes the base64 audio, sends it to ElevenLabs Scribe, and returns
 * the transcript as plain text JSON.
 *
 * The frontend sends base64 (not multipart) to keep things simple — for
 * typical short speech clips (1-10 seconds of webm/opus) the overhead
 * is negligible.
 *
 * Returns: { text: string }
 */
router.post("/transcribe", async (req, res) => {
  const { audio, mimeType } = req.body ?? {};

  if (!audio || typeof audio !== "string") {
    return res.status(400).json({ error: "Missing 'audio' field (base64 string)." });
  }
  if (!mimeType || typeof mimeType !== "string") {
    return res.status(400).json({ error: "Missing 'mimeType' field." });
  }

  let audioBuffer;
  try {
    audioBuffer = Buffer.from(audio, "base64");
  } catch {
    return res.status(400).json({ error: "Invalid base64 in 'audio' field." });
  }

  console.log(`[STT] Transcribing ${(audioBuffer.length / 1024).toFixed(1)} KB of ${mimeType}`);

  try {
    const text = await transcribeAudio({ audioBuffer, mimeType });
    console.log(`[STT] Result: "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`);
    res.json({ text });
  } catch (err) {
    console.error("[STT] transcribeAudio failed:", err);
    res.status(500).json({ error: err.message ?? "Transcription failed." });
  }
});

export default router;
