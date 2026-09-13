import express from 'express';
import { Router } from 'express';
import { transcribeAudio } from '../services/stt.js';

const router = Router();
// Base64-encoded audio clips are ~33% larger than the raw bytes; a few
// seconds of webm/opus speech comfortably fits well under this.
router.use(express.json({ limit: '10mb' }));

/**
 * POST /api/stt/transcribe
 * Body JSON: { audio: string (base64), mimeType: string }
 *
 * Decodes the base64 audio, sends it to ElevenLabs Scribe, and returns the
 * transcript as plain text JSON. The frontend sends base64 (not multipart)
 * to keep things simple — for typical short speech clips the overhead is
 * negligible.
 *
 * Returns: { text: string }
 */
router.post('/transcribe', async (req, res) => {
  const { audio, mimeType } = req.body ?? {};
  if (!audio || typeof audio !== 'string') {
    return res.status(400).json({ error: "Missing 'audio' field (base64 string)." });
  }
  if (!mimeType || typeof mimeType !== 'string') {
    return res.status(400).json({ error: "Missing 'mimeType' field." });
  }

  let audioBuffer;
  try {
    audioBuffer = Buffer.from(audio, 'base64');
  } catch {
    return res.status(400).json({ error: "Invalid base64 in 'audio' field." });
  }

  try {
    const text = await transcribeAudio({ audioBuffer, mimeType });
    res.json({ text });
  } catch (err) {
    console.error('[STT] transcribeAudio failed:', err);
    res.status(500).json({ error: err.message ?? 'Transcription failed.' });
  }
});

export default router;
