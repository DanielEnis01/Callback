import { derivePosition } from "./analytics.js";

export function groupAnswers(transcript = [], plan = []) {
  const grouped = new Map();
  let ordinal = 0;
  for (const turn of transcript) {
    if (turn.role !== "user") continue;
    const text = turn.parts?.map((part) => part.text || "").join(" ").trim();
    if (!text) continue;
    const index = turn.questionIndex;
    if (Number.isInteger(index) && index >= 0 && index < plan.length) {
      const answer = grouped.get(index) ?? { questionIndex: index, answerText: "", clarifierCount: 0, ordinals: [] };
      answer.answerText += `${answer.answerText ? "\n" : ""}${text}`;
      answer.clarifierCount += turn.isClarifying === true ? 1 : 0;
      answer.ordinals.push(ordinal);
      grouped.set(index, answer);
    }
    ordinal++;
  }
  return [...grouped.values()].sort((a, b) => a.questionIndex - b.questionIndex);
}

const numericKeys = ["wordCount", "starScore", "topicRelevance", "repeatedWords", "unfinishedSentences", "tangents", "hedges", "specifics", "vocabularyRichness"];
export function safeScores(input = {}) {
  const result = {};
  for (const key of numericKeys) if (Number.isFinite(input[key])) result[key] = input[key];
  if (typeof input.quantified === "boolean") result.quantified = input.quantified;
  if (Number.isFinite(input.fillerWords?.total)) result.fillerWords = { total: input.fillerWords.total };
  if (input.star) result.star = Object.fromEntries(["situation", "task", "action", "result"].filter((key) => typeof input.star[key] === "boolean").map((key) => [key, input.star[key]]));
  if (Array.isArray(input.flags)) result.flags = input.flags.filter((flag) => typeof flag === "string").slice(0, 20);
  return result;
}

export function buildMemoryRecords(session) {
  const plan = session.interviewPlan;
  if (!Array.isArray(plan) || !plan.length) return { records: [], reason: "missing_plan" };
  const answers = groupAnswers(session.transcript, plan);
  if (answers.length < 2) return { records: [], reason: "fewer_than_two_answers" };
  if (!session.analysis) return { records: [], reason: "missing_analysis" };
  const analysis = session.analysis;
  const common = { userId: session.userId, sessionId: session.sessionId, positionLabel: derivePosition(session), targetedWeakness: session.targetedWeakness || null };
  const records = answers.map((answer) => {
    const question = plan[answer.questionIndex];
    // Static analysis in this implementation scores grouped answers. Imported
    // turn-based signals use the first answer ordinal, never the plan position.
    const scoreIndex = analysis.staticSignals?.answerUnit === "question"
      ? answers.indexOf(answer) : answer.ordinals[0];
    return {
      content: `Q: ${question.text}\nA: ${answer.answerText}`,
      metadata: {
        ...common, kind: "qa_pair", externalId: `${session.sessionId}:${answer.questionIndex}`,
        askedAt: session.startedAt, questionIndex: answer.questionIndex,
        questionText: question.text, questionType: question.type, questionFocus: question.focus,
        answerText: answer.answerText, clarifierCount: answer.clarifierCount,
        jobPostingExcerpt: (session.jobPostingText || "").slice(0, 500), sessionType: session.sessionType,
        answerScores: safeScores(analysis.staticSignals?.answers?.[scoreIndex]),
        sessionCompositeScore: analysis.compositeScore ?? null,
      },
    };
  });
  records.push({
    content: `${analysis.summary || "Interview practice completed."}\nStrengths: ${(analysis.strengths || []).join("; ")}\nWeaknesses: ${(analysis.weaknesses || []).join("; ")}`,
    metadata: { ...common, kind: "session_note", externalId: `${session.sessionId}:note`, startedAt: session.startedAt,
      compositeScore: analysis.compositeScore ?? null,
      traitScores: Object.fromEntries(Object.entries(analysis.traitScores || {}).filter(([, value]) => Number.isFinite(value)).slice(0, 22)),
    },
  });
  return { records, reason: null };
}

export function isWeakAnswer(memory) {
  const score = memory.metadata?.answerScores;
  return !!score && ((Number.isFinite(score.starScore) && score.starScore < 3) || (score.flags?.length ?? 0) > 0);
}

// Encode delimiters as well as JSON quotes: retrieved speech cannot close the
// data block. The system prompt separately states that this is untrusted data.
export function memoryPrompt(value) {
  return `<past_session_data>\n${JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")}\n</past_session_data>`;
}
