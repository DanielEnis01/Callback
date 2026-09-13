// ElevenLabs — voices the recruiter persona and Focus Mode nudges.
//
// Uses the /v1/text-to-speech/{voice_id}/stream endpoint so the caller can
// start piping audio to the client before the full synthesis is complete.
// Set USE_MOCK_TTS=true in .env to skip the API and return a minimal silent
// MP3 frame instead — handy for testing the audio pipeline without burning quota.

const ELEVENLABS_BASE = "https://api.elevenlabs.io";

/** Minimal valid 1-frame silent MP3 (≈26 bytes), base64 encoded. */
const SILENT_MP3_B64 =
  "//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA" +
  "gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/**
 * Synthesize speech via ElevenLabs streaming TTS.
 *
 * @param {{ text: string, voiceId?: string }} options
 * @returns {Promise<NodeJS.ReadableStream>} A readable stream of audio/mpeg data.
 */
export async function synthesizeSpeech({ text, voiceId }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const resolvedVoiceId = voiceId ?? process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set in the environment.");
  if (!resolvedVoiceId) throw new Error("ELEVENLABS_VOICE_ID is not set (and no voiceId was passed).");

  // Mock mode — skip the API entirely.
  if (process.env.USE_MOCK_TTS === "true") {
    console.log("[ElevenLabs] USE_MOCK_TTS=true — returning silent audio for:", text);
    const buf = Buffer.from(SILENT_MP3_B64, "base64");
    // Return a minimal fake readable stream so the route handler stays identical.
    const { Readable } = await import("node:stream");
    return Readable.from([buf]);
  }

  const url = `${ELEVENLABS_BASE}/v1/text-to-speech/${resolvedVoiceId}/stream`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_turbo_v2_5", // lowest-latency model
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.75,
        style: 0.0,
        use_speaker_boost: true,
      },
      // Stream as soon as the first chunk is ready.
      optimize_streaming_latency: 3,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ElevenLabs TTS error ${response.status}: ${body}`);
  }

  // response.body is a WHATWG ReadableStream. Convert to a Node.js stream
  // so we can pipe it to an Express response.
  const { Readable } = await import("node:stream");
  return Readable.fromWeb(response.body);
}
