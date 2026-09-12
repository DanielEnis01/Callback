import test from "node:test";
import assert from "node:assert/strict";

process.env.ELEVENLABS_API_KEY = "test-key";
process.env.ELEVENLABS_VOICE_ID = "voice-123";

const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
});

const { synthesizeSpeech } = await import("../src/services/elevenlabs.js");

test("synthesizeSpeech posts text to the ElevenLabs API and returns audio bytes", async () => {
  let captured;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    };
  };

  const result = await synthesizeSpeech({ text: "Hello there", voiceId: "voice-123" });

  assert.ok(Buffer.isBuffer(result));
  assert.deepEqual(Array.from(result), [1, 2, 3]);
  assert.equal(captured.url, "https://api.elevenlabs.io/v1/text-to-speech/voice-123");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers["xi-api-key"], "test-key");

  const body = JSON.parse(captured.options.body);
  assert.equal(body.text, "Hello there");
  assert.equal(body.model_id, "eleven_multilingual_v2");
  assert.deepEqual(body.voice_settings, {
    stability: 0.5,
    similarity_boost: 0.75,
  });
});

test("synthesizeSpeech supports the legacy ELEVEN_LABS_API_KEY env name", async () => {
  delete process.env.ELEVENLABS_API_KEY;
  process.env.ELEVEN_LABS_API_KEY = "legacy-key";
  global.fetch = async (_url, options) => {
    assert.equal(options.headers["xi-api-key"], "legacy-key");
    return { ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer };
  };

  const result = await synthesizeSpeech({ text: "legacy", voiceId: "voice-123" });
  assert.deepEqual(Array.from(result), [9]);
  delete process.env.ELEVEN_LABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = "test-key";
});

test("synthesizeSpeech rejects missing config", async () => {
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVEN_LABS_API_KEY;
  await assert.rejects(() => synthesizeSpeech({ text: "hi" }), /ELEVENLABS_API_KEY/);
  process.env.ELEVENLABS_API_KEY = "test-key";
});
