// Gemini API — reasoning core.
// Receives signals from perception/speech/presage, drives the recruiter
// persona, and routes output to ElevenLabs (voice) + the data layer (logging).

export async function generateCoachResponse({ transcript, perceptionSignals, presageSignal, sessionContext }) {
  // TODO: call Gemini API with transcript + perceptionSignals + presageSignal + sessionContext
  throw new Error("gemini.generateCoachResponse not implemented");
}
