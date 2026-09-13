// ElevenLabs Scribe — speech-to-text transcription.
// Accepts a raw audio buffer and its MIME type (e.g. "audio/webm") and
// returns the transcribed text string.

const ELEVENLABS_BASE = "https://api.elevenlabs.io";

/**
 * Transcribe an audio buffer using ElevenLabs Scribe v1.
 *
 * @param {{ audioBuffer: Buffer, mimeType: string }} options
 * @returns {Promise<string>} The transcribed text.
 */
export async function transcribeAudio({ audioBuffer, mimeType }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set.");

  const formData = new FormData();
  // ElevenLabs expects the file field with a filename extension that matches
  // the MIME type — "audio.webm" for webm, "audio.mp4" for mp4, etc.
  const ext = mimeType.split("/")[1]?.split(";")[0] ?? "webm";
  formData.append(
    "file",
    new Blob([audioBuffer], { type: mimeType }),
    `audio.${ext}`
  );
  formData.append("model_id", "scribe_v1");
  // Return only the plain text — no timestamps needed for our use case.
  formData.append("timestamps_granularity", "none");

  const response = await fetch(`${ELEVENLABS_BASE}/v1/speech-to-text`, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: formData,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ElevenLabs STT error ${response.status}: ${body}`);
  }

  const result = await response.json();
  // ElevenLabs Scribe returns { text, words?, ... }
  return (result.text ?? "").trim();
}
