import * as backboardClient from "../integrations/backboard/backboardClient.js";
import { getSessionStore } from "./sessionStore.js";
import { buildMemoryRecords } from "./memoryRecords.js";

export function createBackboardService(client = backboardClient, repository) {
  const getStore = async () => repository || getSessionStore();
  const validateUser = (userId) => {
    if (typeof userId !== "string" || !userId.trim() || userId.length > 200) throw Object.assign(new Error("A valid userId is required"), { statusCode: 400 });
  };
  async function assistantFor(userId, create = false) {
    validateUser(userId);
    return (await getStore()).transaction(userId, async (state) => {
      if (!state.assistantId && create) {
        const assistant = await client.createUserAssistant(userId);
        if (!assistant?.assistant_id) throw new Error("Backboard did not return an assistant ID");
        state.assistantId = assistant.assistant_id;
      }
      return state.assistantId;
    });
  }
  function owned(memories, userId, { kind, excludeSessionId } = {}) {
    return memories.filter((memory) => memory.metadata?.userId === userId &&
      (!kind || memory.metadata.kind === kind) && (!excludeSessionId || memory.metadata.sessionId !== excludeSessionId));
  }
  async function listAll(assistantId) {
    const memories = [];
    for (let page = 1; page <= 100; page++) {
      const response = await client.listMemories(assistantId, { page, pageSize: 100 });
      const items = response.memories ?? [];
      memories.push(...items);
      if (page >= (response.total_pages ?? Math.ceil((response.total_count ?? items.length) / 100))) return memories;
    }
    throw new Error("Memory listing exceeded 10,000 records");
  }
  async function storeMemory({ userId, content, metadata }) {
    validateUser(userId);
    if (!content?.trim() || metadata?.userId !== userId || !["qa_pair", "session_note"].includes(metadata?.kind) || !metadata.externalId) {
      throw Object.assign(new Error("A structured, user-owned memory is required"), { statusCode: 400 });
    }
    const store = await getStore();
    const assistantId = await assistantFor(userId, true);
    const key = metadata.externalId;
    const receipt = await store.transaction(userId, (state) => state.records[key] ?? null);
    if (receipt?.id) return { id: receipt.id, status: "already_synced" };
    if (receipt?.pending) {
      // A timeout may have committed upstream. Never blindly POST a second copy.
      const prior = owned(await listAll(assistantId), userId).find((memory) => memory.metadata.externalId === key);
      if (!prior) return { status: "pending_reconciliation" };
      const id = prior.id || prior.memory_id;
      if (!id) return { status: "pending_reconciliation" };
      await store.transaction(userId, (state) => { state.records[key] = { id }; });
      return { id, status: "reconciled" };
    }
    const claimed = await store.transaction(userId, (state) => {
      if (state.records[key]) return false;
      state.records[key] = { pending: true, attemptedAt: new Date().toISOString() };
      return true;
    });
    if (!claimed) return { status: "pending_reconciliation" };
    try {
      const result = await client.addCoachingMemory(assistantId, content, metadata);
      const id = result?.id || result?.memory_id;
      if (!id) return { status: "pending_reconciliation" };
      await store.transaction(userId, (state) => { state.records[key] = { id }; });
      return { id, status: "stored" };
    } catch (error) {
      // Definitive rejection means no write; unknown outcomes need reconciliation.
      if ((error.status >= 400 && error.status < 500) || error.statusCode === 503) {
        await store.transaction(userId, (state) => { delete state.records[key]; });
      }
      throw error;
    }
  }
  async function retrieveMemory({ userId, query, kind = "qa_pair", excludeSessionId, limit = 10, weakOnly = false }) {
    validateUser(userId);
    if (typeof query !== "string" || !query.trim() || !Number.isInteger(limit) || limit < 1 || limit > backboardClient.MAX_MEMORY_SEARCH_RESULTS || !["qa_pair", "session_note"].includes(kind)) {
      throw Object.assign(new Error(`query, valid kind and limit (1–${backboardClient.MAX_MEMORY_SEARCH_RESULTS}) are required`), { statusCode: 400 });
    }
    const assistantId = await assistantFor(userId);
    if (!assistantId) return { memories: [] };
    // The public API documents query + limit, not metadata predicates.
    const response = await client.searchMemories(assistantId, query.slice(0, 2000), backboardClient.MAX_MEMORY_SEARCH_RESULTS);
    const memories = owned(response.memories ?? [], userId, { kind, excludeSessionId })
      .filter((memory) => !weakOnly || (Number.isFinite(memory.metadata.answerScores?.starScore) && memory.metadata.answerScores.starScore < 3));
    return { memories: memories.slice(0, limit), filtering: "client_after_tenant_search", candidates: response.memories?.length ?? 0 };
  }
  async function recentNotes(userId, limit = 3) {
    const assistantId = await assistantFor(userId);
    if (!assistantId) return [];
    return owned(await listAll(assistantId), userId, { kind: "session_note" })
      .sort((a, b) => (b.metadata.startedAt || "").localeCompare(a.metadata.startedAt || "")).slice(0, limit);
  }
  async function syncSession(userId, sessionId) {
    try {
      const store = await getStore();
      const session = await store.getSession(userId, sessionId);
      if (!session) return { status: "skipped", reason: "session_not_found" };
      if (session.memorySyncedAt) return { status: "already_synced", syncedAt: session.memorySyncedAt };
      const { records, reason } = buildMemoryRecords(session);
      if (!records.length) return { status: "skipped", reason };
      const results = [];
      for (const record of records) {
        const result = await storeMemory({ userId, ...record });
        results.push(result);
        if (!result.id) return { status: "pending_reconciliation", records: results };
      }
      const syncedAt = new Date().toISOString();
      await store.transaction(userId, (state) => { state.sessions[sessionId].memorySyncedAt = syncedAt; });
      return { status: "synced", count: records.length, syncedAt };
    } catch {
      return { status: "unavailable", reason: "Memory sync failed; the saved session is safe. Retry from developer tools." };
    }
  }
  return { storeMemory, retrieveMemory, recentNotes, syncSession };
}

export const { storeMemory, retrieveMemory, recentNotes, syncSession } = createBackboardService();
