import { randomUUID } from "node:crypto";
import { fallbackQuestions } from "./interview.js";

export function createMockBackboardClient(store, mode = "mock") {
  const fail = () => { if (mode === "outage") throw Object.assign(new Error("Simulated Backboard outage"), { statusCode: 503 }); };
  return {
    createUserAssistant: async () => { fail(); return { assistant_id: `mock-${randomUUID()}` }; },
    addCoachingMemory: async (assistantId, content, metadata) => {
      fail();
      const memory = { id: randomUUID(), content, metadata };
      await store.transaction(`mock:${assistantId}`, (state) => { state.records[memory.id] = memory; });
      return memory;
    },
    searchMemories: async (assistantId, query, limit) => {
      fail();
      const memories = await store.transaction(`mock:${assistantId}`, (state) => Object.values(state.records));
      const words = new Set(query.toLowerCase().match(/\w+/g));
      return { memories: mode === "empty" ? [] : memories.map((memory) => ({ ...memory,
        score: (memory.content.toLowerCase().match(/\w+/g) || []).filter((word) => words.has(word)).length,
      })).sort((a, b) => b.score - a.score).slice(0, limit) };
    },
    listMemories: async (assistantId, { page, pageSize }) => {
      fail();
      const memories = mode === "empty" ? [] : await store.transaction(`mock:${assistantId}`, (state) => Object.values(state.records));
      return { memories: memories.slice((page - 1) * pageSize, page * pageSize), total_count: memories.length, total_pages: Math.ceil(memories.length / pageSize) };
    },
  };
}

export async function mockGenerateJson(prompt) {
  if (prompt.includes("Create exactly five")) return { questions: structuredClone(fallbackQuestions) };
  if (prompt.includes("Act as a brief recruiter")) return {};
  const data = JSON.parse(prompt.split("<past_session_data>\n")[1].split("\n</past_session_data>")[0]);
  return { summary: "Development fixture analysis. Review answer structure, specific actions, and measurable outcomes.",
    strengths: ["Completed interview practice"], weaknesses: ["Make the outcome of each story explicit"],
    progressNotes: data.matches.filter((match) => match.priorAnswers.length).map((match) => ({
      questionIndex: match.questionIndex, priorSessionId: match.priorAnswers[0].metadata.sessionId,
      note: `Demo comparison: previously you said “${match.priorAnswers[0].metadata.answerText.slice(0, 110)}”; this time you said “${match.currentAnswer.slice(0, 110)}”.`,
    })),
  };
}

export async function seedHistory(userId, { store, interview, memory }) {
  const existing = (await store.listSessions(userId)).filter((session) => session.seedVersion === 1);
  const results = [];
  for (let day = 0; day < 3; day++) {
    const prior = existing.find((session) => session.seedIndex === day);
    if (prior) {
      const result = prior.analysis ? await memory.syncSession(userId, prior.sessionId) : (await interview.analyzeSession(userId, prior.sessionId, prior.transcript)).memory;
      results.push({ sessionId: prior.sessionId, ...result });
      continue;
    }
    const session = await interview.createSession(userId, { jobPostingText: "Software engineer\nBuild reliable services, collaborate across teams, and deliver measurable outcomes.", targetedWeakness: "Conflict resolution" });
    session.startedAt = new Date(Date.now() - (4 - day) * 86400000).toISOString();
    session.interviewPlan = structuredClone(fallbackQuestions);
    session.seedVersion = 1;
    session.seedIndex = day;
    session.transcript = fallbackQuestions.flatMap((question, index) => [
      { role: "model", parts: [{ text: question.text }], questionIndex: index, isClarifying: false },
      { role: "user", parts: [{ text: index === 0 ? "Um, we disagreed about the migration. I talked to someone and we eventually figured it out." : `When our team needed a safer migration, I led the project and built a staged rollout. We reduced failures by ${20 + day * 10}% and delivered in six weeks.` }], questionIndex: index, isClarifying: false },
    ]);
    await store.transaction(userId, (state) => { state.sessions[session.sessionId] = session; });
    results.push({ sessionId: session.sessionId, ...(await interview.analyzeSession(userId, session.sessionId, session.transcript)).memory });
  }
  return { seeded: existing.length < 3, sessions: results };
}
