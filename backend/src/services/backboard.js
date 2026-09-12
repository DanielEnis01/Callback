// Backboard — long-term conversational memory and retrieval.
// Past transcripts, coaching notes, "what went wrong last time" recall.

export async function retrieveMemory({ userId, query }) {
  // TODO: call Backboard retrieval API
  throw new Error("backboard.retrieveMemory not implemented");
}

export async function storeMemory({ userId, content, metadata }) {
  // TODO: call Backboard write/embedding API
  throw new Error("backboard.storeMemory not implemented");
}
