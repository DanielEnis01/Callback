import express from 'express';
import { Router } from 'express';
import { synthesizeSpeech } from '../services/elevenlabs.js';

const router = Router();
router.use(express.json({ limit: '256kb' }));

/**
 * POST /api/tts/speak
 * Body: { text: string, voiceId?: string }
 *
 * Streams ElevenLabs audio/mpeg directly to the client so playback can begin
 * before synthesis is complete. useTTS/useConversation read the response
 * body and feed it to an AudioContext.
 */
router.post('/speak', async (req, res) => {
  const { text, voiceId } = req.body ?? {};
  if (!text || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: "Missing or empty 'text' field." });
  }

  try {
    const audioStream = await synthesizeSpeech({ text: text.trim(), voiceId });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    audioStream.pipe(res);
    audioStream.on('error', (err) => {
      console.error('[TTS] Stream error:', err);
      if (!res.headersSent) res.status(502).json({ error: 'Audio stream error.' });
      else res.destroy(err);
    });
  } catch (err) {
    console.error('[TTS] synthesizeSpeech failed:', err);
    res.status(500).json({ error: err.message ?? 'TTS synthesis failed.' });
  }
});

export default router;
