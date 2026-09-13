// Turns one completed session into the records Backboard stores.
//
// The retrievable unit is a question-and-answer PAIR, not the transcript
// blob: the question is what makes an answer searchable later ("we shipped
// in six weeks" means something different under a conflict question than a
// delivery one), so it is embedded in the content, not just the metadata.

/** Groups user turns back onto the planned question they answered.
 *  A clarified question produces several user turns; they concatenate into
 *  one answer and bump clarifierCount. */
export function groupAnswers(transcript = [], plan = []) {
  const grouped = new Map();
  for (const turn of transcript) {
    if (turn.role !== 'user') continue;
    const text = (turn.parts ?? []).map((part) => part.text || '').join(' ').trim();
    if (!text) continue;
    const index = turn.questionIndex;
    if (!Number.isInteger(index) || index < 0 || index >= plan.length) continue;
    const answer = grouped.get(index) ?? { questionIndex: index, answerText: '', clarifierCount: 0, turnOrdinals: [] };
    answer.answerText += `${answer.answerText ? '\n' : ''}${text}`;
    if (turn.isClarifying === true) answer.clarifierCount += 1;
    answer.turnOrdinals.push(grouped.size);
    grouped.set(index, answer);
  }
  return [...grouped.values()].sort((a, b) => a.questionIndex - b.questionIndex);
}

// Allowlist, so nothing unexpected from the analyzer leaks into memory
// metadata. Extended past the vendor list with this app's own signals.
const NUMERIC_KEYS = [
  'wordCount', 'starScore', 'topicRelevance', 'repeatedWords', 'unfinishedSentences',
  'tangents', 'hedges', 'specifics', 'vocabularyRichness', 'nonAnswerMarkers',
];

export function safeScores(input = {}) {
  const result = {};
  for (const key of NUMERIC_KEYS) if (Number.isFinite(input[key])) result[key] = input[key];
  if (typeof input.quantified === 'boolean') result.quantified = input.quantified;
  // Whether the candidate declined the question outright. The single most
  // consequential thing an answer can contain, and the vendor schema has no
  // concept of it.
  if (typeof input.conceded === 'boolean') result.conceded = input.conceded;
  if (Number.isFinite(input.fillerWords?.total)) result.fillerWords = { total: input.fillerWords.total };
  if (input.star) {
    result.star = Object.fromEntries(
      ['situation', 'task', 'action', 'result']
        .filter((key) => typeof input.star[key] === 'boolean')
        .map((key) => [key, input.star[key]]),
    );
  }
  if (Array.isArray(input.flags)) result.flags = input.flags.filter((f) => typeof f === 'string').slice(0, 20);
  return result;
}

/**
 * Is this a question worth re-asking?
 *
 * NOT the vendor's rule, which also returned true whenever `flags.length > 0`.
 * In this pipeline flags are near-universal -- `no_quantification` and
 * `missing_result` fire on most answers, and a real session logged
 * flaggedAnswers [0,1,2,3,4,5,6], every single one -- so that predicate marks
 * 100% of answers weak and makes the whole re-ask feature meaningless.
 *
 * Scored on evidence instead. Note starScore here is a 0-4 COUNT of STAR
 * components present (python/analysis_service.py), not the vendor's "1-5
 * rating": under half the components is the weak signal.
 */
export function isWeakAnswer(memory) {
  // Gemini's own rating is the most direct signal we have, when it exists:
  // it read the whole answer in context, which the static checks cannot.
  const rating = memory?.metadata?.aiRating;
  if (Number.isFinite(rating)) return rating < 6;

  const scores = memory?.metadata?.answerScores;
  if (!scores) return false;
  if (scores.conceded === true) return true;
  return Number.isFinite(scores.starScore) && scores.starScore < 2;
}

/**
 * Build every memory record for one session.
 *
 * `session` is the flat shape assembled by loadSessionForMemory (see
 * backboard.js) out of sessions + session_ai_analysis -- this app has no
 * single session row carrying all of it.
 */
/** The analysis summary is an array of per-question critiques (see
 *  generateTranscriptAnalysis); flatten it to prose for the stored note,
 *  while still tolerating the plain string it used to be. */
function summaryText(summary) {
  if (typeof summary === 'string' && summary.trim()) return summary.trim();
  if (Array.isArray(summary) && summary.length) {
    return summary
      .filter((item) => item && (item.question || item.critique))
      .map((item) => `${item.question ?? 'Question'}: ${item.critique ?? ''}`.trim())
      .join(' ');
  }
  return 'Interview practice completed.';
}

export function buildMemoryRecords(session) {
  const plan = session.interviewPlan;
  if (!Array.isArray(plan) || !plan.length) return { records: [], reason: 'missing_plan' };
  const answers = groupAnswers(session.transcript, plan);
  if (answers.length < 2) return { records: [], reason: 'fewer_than_two_answers' };
  if (!session.analysis) return { records: [], reason: 'missing_analysis' };

  const analysis = session.analysis;
  const common = {
    userId: session.userId,
    sessionId: session.sessionId,
    positionLabel: session.positionLabel || null,
    targetedWeakness: session.targetedWeakness || null,
  };

  const perAnswer = analysis.staticSignals?.answers ?? [];
  // Gemini's per-question critique, now that `summary` is an array of
  // {question, rating, critique, fix} objects indexed in question order.
  // This is the half a later session actually needs: the static signals say
  // an answer had no result clause, but the critique says WHY it landed
  // badly, in the same language the next analysis will be written in.
  const aiSummary = Array.isArray(analysis.summary) ? analysis.summary : [];
  const records = answers.map((answer, ordinal) => {
    const question = plan[answer.questionIndex];
    const critique = aiSummary[answer.questionIndex] ?? aiSummary[ordinal] ?? null;
    return {
      content: `Q: ${question.text}\nA: ${answer.answerText}`,
      metadata: {
        ...common,
        kind: 'qa_pair',
        externalId: `${session.sessionId}:${answer.questionIndex}`,
        askedAt: session.startedAt,
        questionIndex: answer.questionIndex,
        questionText: question.text,
        questionType: question.type,
        questionFocus: question.focus,
        answerText: answer.answerText,
        clarifierCount: answer.clarifierCount,
        jobPostingExcerpt: (session.jobPostingText || '').slice(0, 500),
        answerScores: safeScores(perAnswer[ordinal]),
        // Flat scalars on purpose -- these survive the flattening that the
        // Backboard write applies, so they are filterable remotely as well
        // as locally.
        aiRating: Number.isFinite(critique?.rating) ? critique.rating : null,
        aiCritique: typeof critique?.critique === 'string' ? critique.critique.slice(0, 600) : null,
        aiFixAction: typeof critique?.fix?.action === 'string' ? critique.fix.action.slice(0, 400) : null,
        // 0-10, matching every other score surface in this app (the vendor
        // schema annotates this 0-100).
        sessionCompositeScore: analysis.compositeScore ?? null,
      },
    };
  });

  records.push({
    content: [
      summaryText(analysis.summary),
      `Strengths: ${(analysis.strengths || []).join('; ') || 'none recorded'}`,
      `Weaknesses: ${(analysis.weaknesses || []).join('; ') || 'none recorded'}`,
    ].join('\n'),
    metadata: {
      ...common,
      kind: 'session_note',
      externalId: `${session.sessionId}:note`,
      startedAt: session.startedAt,
      // Duplicated out of `content` on purpose: recentNotes reads our local
      // mirror rather than fetching from Backboard, and the summary is the
      // only part of a note the planner actually uses.
      summaryText: summaryText(analysis.summary).slice(0, 1000),
      compositeScore: analysis.compositeScore ?? null,
      traitScores: Object.fromEntries(
        Object.entries(analysis.traitScores || {}).filter(([, v]) => Number.isFinite(v)).slice(0, 25),
      ),
    },
  });

  return { records, reason: null };
}

/**
 * Wrap retrieved memories for a prompt.
 *
 * Everything in here is the user's own past speech, which means it is data
 * that reaches a model -- angle brackets are escaped so retrieved text cannot
 * close the block and start issuing instructions. The prompt says the same
 * thing in words; this makes it structurally true.
 */
export function memoryPrompt(value) {
  const encoded = JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
  return `<past_session_data>\n${encoded}\n</past_session_data>`;
}
