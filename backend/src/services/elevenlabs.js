// ElevenLabs — voices the recruiter persona and Focus Mode nudges.

const API_BASE = "https://api.elevenlabs.io/v1";

function getApiKey() {
  return process.env.ELEVENLABS_API_KEY?.trim() || process.env.ELEVEN_LABS_API_KEY?.trim();
}

function assertSpeechConfig() {
  const apiKey = getApiKey();
  if (!apiKey) {
    const error = new Error("ELEVENLABS_API_KEY is required to synthesize interview audio.");
    error.statusCode = 503;
    throw error;
  }
  return apiKey;
}

export async function synthesizeSpeech({ text, voiceId }) {
  const voice = voiceId || process.env.ELEVENLABS_VOICE_ID;
  if (typeof text !== "string" || !text.trim()) {
    const error = new Error("text must be a nonempty string");
    error.statusCode = 400;
    throw error;
  }
  if (!voice || typeof voice !== "string") {
    const error = new Error("voiceId is required");
    error.statusCode = 400;
    throw error;
  }

  assertSpeechConfig();

  const apiKey = assertSpeechConfig();

  const response = await fetch(`${API_BASE}/text-to-speech/${encodeURIComponent(voice)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify({
      text,
      model_id: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2",
      voice_settings: {
        stability: Number(process.env.ELEVENLABS_STABILITY ?? 0.5),
        similarity_boost: Number(process.env.ELEVENLABS_SIMILARITY_BOOST ?? 0.75),
      },
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    const error = new Error(`ElevenLabs TTS failed: ${response.status} ${bodyText}`);
    error.statusCode = response.status >= 500 ? 502 : 400;
    throw error;
  }

  const audioBytes = Buffer.from(await response.arrayBuffer());
  return audioBytes;
}
