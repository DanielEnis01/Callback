import express from 'express';
import { Router } from 'express';
import { testRecruiterPrompt, generateOpeningLine, generateTranscriptAnalysis, generateInterviewPlan, generateInterviewTurn } from '../services/gemini.js';
import { synthesizeSpeech } from '../services/elevenlabs.js';
import { analyzeTranscript } from '../services/pythonAnalysis.js';
import { saveTranscriptAnalysis } from '../services/transcriptAnalysisStore.js';
import { computeSessionAnalysis } from '../services/sessionAnalysis.js';
import { syncSession, retrieveMemory, recentNotes, isConfigured as backboardConfigured } from '../services/backboard.js';
import { groupAnswers } from '../services/memoryRecords.js';
import { getSessionDashboard, getTraitStanding } from '../services/analytics.js';

// Factory (like createDataRouter/createDocumentsRouter) so the transcript
// analysis route can persist its result against the caller's session --
// see transcriptAnalysisStore.js. `db` is only used by that one route;
// everything else here is stateless.
export function createServicesRouter(db) {
const router = Router();
router.use(express.json({ limit: '256kb' }));

// Placeholder status endpoints — one per integration, wired up as each
// service module gets implemented.
const SERVICES = ['gemini', 'elevenlabs', 'tigerdata', 'backboard'];

router.get('/', (_req, res) => {
  res.json({
    services: SERVICES.map((name) => ({
      name,
      status: name === 'backboard' ? (backboardConfigured() ? 'configured' : 'not_configured') : 'not_implemented',
    })),
  });
});

// Dev tool: POST { message, history? } -> { reply }
// Lets you test the static recruiter prompt directly.
router.post('/gemini/test', async (req, res) => {
  const { message, history } = req.body ?? {};
  if (!message) return res.status(400).json({ error: 'message is required' });
  try {
    const reply = await testRecruiterPrompt(message, history);
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Connector: POST { message, history?, voiceId? } -> { text, audio }
// Gets the recruiter's reply from Gemini, then hands the plain text
// straight to ElevenLabs. This is the join point between the two —
// synthesizeSpeech() is implemented, so this route works end-to-end
// with zero further glue code needed.
//
// Returns JSON: { text: string, audio: string (base64 mp3) }
router.post('/gemini/speak', async (req, res) => {
  const { message, history, voiceId, jobPosting, targetWeakness } = req.body ?? {};
  if (!message) return res.status(400).json({ error: 'message is required' });
  try {
    // Step 1: Gemini generates the recruiter reply, tailored to the job
    // posting/weakness for this session when the frontend sends them.
    const text = await testRecruiterPrompt(message, history, { jobPosting, targetWeakness });

    // Step 2: ElevenLabs synthesizes the reply. synthesizeSpeech() returns a
    // Node.js Readable stream of audio/mpeg chunks — collect them into a
    // single buffer so we can embed the audio as base64 in the JSON response.
    const audioStream = await synthesizeSpeech({ text, voiceId });
    const chunks = [];
    for await (const chunk of audioStream) chunks.push(chunk);
    const audio = Buffer.concat(chunks).toString('base64');

    res.json({ text, audio });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Opening line for a fresh session: POST { jobPosting?, targetWeakness?, voiceId? } -> { text, audio }
// Called once, before the candidate has said anything (see
// useConversation.ts's mount effect) so the recruiter AI speaks first,
// using only the job posting/weakness collected at session setup — there's
// no memory/Backboard yet, so no prior-session context is available.
router.post('/gemini/greeting', async (req, res) => {
  const { jobPosting, targetWeakness, voiceId } = req.body ?? {};
  try {
    const text = await generateOpeningLine({ jobPosting, targetWeakness });
    const audioStream = await synthesizeSpeech({ text, voiceId });
    const chunks = [];
    for await (const chunk of audioStream) chunks.push(chunk);
    const audio = Buffer.concat(chunks).toString('base64');
    res.json({ text, audio });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Interview plan: POST { jobPosting } -> { questions: [{ type, text, focus }] }
// Builds the five-question plan for a session before the conversation
// starts (see gemini.js's generateInterviewPlan). The resume isn't sent by
// the client -- the frontend only ever had its filename/size, never its
// contents -- so it's resolved here from the caller's most recently
// uploaded resume in Tiger Data and handed to Gemini as the original PDF.
// A missing resume is not an error: the plan degrades to job-posting and
// general-background questions rather than failing the session.
router.post('/gemini/interview-plan', async (req, res) => {
  const { jobPosting, targetWeakness } = req.body ?? {};
  if (!jobPosting || typeof jobPosting !== 'string') {
    return res.status(400).json({ error: 'jobPosting (string) is required' });
  }

  let resumePdf = null;
  try {
    const result = await db.query(
      `SELECT p.pdf_data FROM resumes r
       JOIN pdf_documents p ON p.document_id = r.document_id AND p.user_id = r.user_id
       WHERE r.user_id = $1 ORDER BY r.uploaded_at DESC LIMIT 1`,
      [req.user.userId],
    );
    resumePdf = result.rows[0]?.pdf_data ?? null;
  } catch (err) {
    console.warn('[interview-plan] could not load resume, continuing without it:', err.message);
  }

  // Practice mode: the user tapped "Practice this" on a specific trait, so
  // the plan should be built to exercise THAT trait rather than to survey the
  // role. Looking the score up here (rather than shipping it from the client)
  // keeps the number authoritative and means the button only has to send the
  // label it already has.
  let traitFocus = null;
  if (targetWeakness) {
    try {
      traitFocus = await getTraitStanding(db, { userId: req.user.userId, weakness: targetWeakness });
    } catch (err) {
      console.warn('[interview-plan] trait standing lookup skipped:', err.message);
    }
  }

  // Prior-session context. Retrieved semantically against this job posting,
  // so "questions like the ones this role will ask" surfaces even when the
  // wording is nothing alike -- the whole reason this isn't a SQL query.
  // Entirely best-effort: with no key, no history, or Backboard down, the
  // planner simply plans from scratch exactly as it did before.
  let priorMemory = null;
  try {
    // Same rule as the analysis route: the user is waiting to start their
    // interview, so memory gets a fixed budget and is dropped if it overruns.
    const budget = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('memory lookup exceeded its 7s budget')), 7000).unref?.());
    const [weak, all, notes] = await Promise.race([
      Promise.all([
        retrieveMemory(db, { userId: req.user.userId, query: jobPosting, kind: 'qa_pair', limit: 6, weakOnly: true }),
        retrieveMemory(db, { userId: req.user.userId, query: jobPosting, kind: 'qa_pair', limit: 12 }),
        recentNotes(db, req.user.userId, 3),
      ]),
      budget,
    ]);
    const weakIds = new Set(weak.memories.map((m) => m.metadata.externalId));
    const brief = (m) => ({
      sessionId: m.metadata.sessionId,
      question: m.metadata.questionText,
      focus: m.metadata.questionFocus,
      starScore: m.metadata.answerScores?.starScore ?? null,
      conceded: m.metadata.answerScores?.conceded ?? false,
      rating: m.metadata.aiRating ?? null,
      critique: m.metadata.aiCritique ?? null,
    });
    const weakQuestions = weak.memories.map(brief);
    const masteredQuestions = all.memories
      .filter((m) => !weakIds.has(m.metadata.externalId))
      .map(brief);
    if (weakQuestions.length || masteredQuestions.length || notes.length) {
      priorMemory = {
        weakQuestions,
        masteredQuestions,
        notes: notes.map((n) => ({ summary: n.summaryText ?? null, positionLabel: n.positionLabel, startedAt: n.startedAt })),
      };
    }
  } catch (err) {
    console.warn('[interview-plan] memory lookup skipped:', err.message);
  }

  try {
    const { role, questions } = await generateInterviewPlan({ jobPosting, resumePdf, memory: priorMemory, traitFocus, targetWeakness });
    if (req.body?.sessionId) {
      try {
        // The plan is persisted, not just the role: an answer is meaningless
        // without the question it answers, and that pairing is what Backboard
        // stores. Without this the transcript is a monologue.
        await db.query(
          'UPDATE sessions SET position_label = COALESCE($1, position_label), interview_plan = $2 WHERE session_id = $3 AND user_id = $4',
          [role, JSON.stringify(questions), req.body.sessionId, req.user.userId],
        );
      } catch (err) {
        console.warn('[interview-plan] could not save plan/role:', err.message);
      }
    }
    res.json({ role, questions, usedResume: Boolean(resumePdf) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One interview turn: POST { message?, history?, plan, questionIndex, targetWeakness?, voiceId? }
// -> { text, audio, state: { askedQuestionIndex, isClarifying, interviewComplete } }
//
// The structured sibling of /gemini/speak below: same Gemini -> ElevenLabs
// join, but driven by the question plan so the interview actually ends
// after four questions instead of running until the user closes it. Omit
// `message` for the opening turn (greeting + question 1).
router.post('/gemini/interview-turn', async (req, res) => {
  const { message, history, plan, questionIndex, alreadyGreeted, targetWeakness, voiceId } = req.body ?? {};
  if (!Array.isArray(plan) || plan.length === 0) {
    return res.status(400).json({ error: 'plan (non-empty array) is required' });
  }
  try {
    const turn = await generateInterviewTurn({
      message,
      history: Array.isArray(history) ? history : [],
      plan,
      questionIndex: Number.isInteger(questionIndex) ? questionIndex : 0,
      alreadyGreeted: Boolean(alreadyGreeted),
      sessionContext: { targetWeakness },
    });

    const audioStream = await synthesizeSpeech({ text: turn.reply, voiceId });
    const chunks = [];
    for await (const chunk of audioStream) chunks.push(chunk);
    const audio = Buffer.concat(chunks).toString('base64');

    res.json({
      text: turn.reply,
      audio,
      state: {
        askedQuestionIndex: turn.askedQuestionIndex,
        isClarifying: turn.isClarifying,
        interviewComplete: turn.interviewComplete,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Post-session transcript analysis: POST { transcript, jobPosting?, targetWeakness?, sessionId? }
// -> { staticSignals, aiAnalysis, aiError, persisted }
//
// Two stages:
//   1. staticSignals — python/analysis_service.py's rule-based checks
//      (STAR-method coverage, quantified-result detection, filler words).
//   2. aiAnalysis — Gemini's qualitative pass over the transcript, grounded
//      in those static signals (see gemini.js's generateTranscriptAnalysis).
//      Shape: { strengths: string[], weaknesses: string[], summary, overallScore }.
//
// When the frontend sends sessionId (SessionRecorder's client-generated id,
// already POSTed to /data/sessions at session start -- see
// sessionRecorder.ts), the result is also persisted to session_ai_analysis
// so it can be re-read later from the saved-sessions/summary view (see
// data.js's GET /sessions/:sessionId/ai-analysis). Persistence only makes
// sense in remote-storage mode, where that session row actually exists in
// Tiger Data -- static/local-mode sessions simply omit sessionId, and
// `persisted` comes back false rather than the request failing.
router.post('/analysis/transcript', async (req, res) => {
  const { transcript, jobPosting, targetWeakness, sessionId } = req.body ?? {};
  if (!Array.isArray(transcript)) return res.status(400).json({ error: 'transcript (array) is required' });

  // Stage 1: static rule-based signals (python/analysis_service.py). If this
  // fails the whole request fails -- there's nothing useful to return
  // without it, and Gemini's prompt leans on it.
  let staticSignals;
  try {
    console.log('[analysis/transcript] Starting static Python analysis...');
    staticSignals = await analyzeTranscript(transcript, { jobPosting });
    console.log('[analysis/transcript] Static analysis complete:', JSON.stringify(staticSignals, null, 2));
  } catch (err) {
    console.error('[analysis/transcript] Static analysis failed:', err.message);
    return res.status(500).json({ error: err.message });
  }

  // Stage 2: Gemini's qualitative pass. Kept separate from stage 1's error
  // handling on purpose -- a transient Gemini failure (quota exhaustion,
  // rate limiting) shouldn't throw away the static analysis that already
  // succeeded. Callers get a 200 with aiAnalysis: null and aiError set
  // instead, so the STAR/quantification/filler-word signals still reach
  // the dashboard even when the qualitative half is temporarily down.
  // Read path B: pull the nearest prior answer to each question the user
  // just answered, so Gemini can say what changed in HOW they tell a story
  // rather than only what today's score was. Entirely best-effort -- an
  // unconfigured or unreachable Backboard yields [] and the prompt simply
  // omits its PROGRESS COMPARISON section.
  // The planned questions, shared by the memory lookup below and by the
  // analysis prompt: without them Gemini invents questions that were never
  // asked (it produced a phantom "closing prompt" entry rated 0/10, which
  // pulled the whole session's score down).
  let plan = [];
  let priorAnswers = [];
  if (sessionId) {
    try {
      // Hard ceiling on the whole retrieval block. This sits directly in
      // front of the user waiting on their results, and Backboard is a
      // third-party network hop behind a 250ms throttle -- without a
      // deadline, one slow provider turns into a spinner that never ends.
      const deadline = Date.now() + 7000;
      const planRow = await db.query('SELECT interview_plan FROM sessions WHERE session_id = $1 AND user_id = $2', [sessionId, req.user.userId]);
      plan = planRow.rows[0]?.interview_plan ?? [];
      const answered = groupAnswers(transcript, plan);
      const seen = new Set();
      // Three searches is plenty to ground a progress note and keeps the
      // worst case bounded even when every one of them is slow.
      for (const answer of answered.slice(0, 3)) {
        if (Date.now() > deadline) { console.warn('[analysis/transcript] prior-answer retrieval hit its deadline'); break; }
        const question = plan[answer.questionIndex];
        const query = `${question?.text ?? ''}\n${answer.answerText}`.trim();
        if (!query) continue;
        const { memories } = await retrieveMemory(db, {
          userId: req.user.userId,
          query,
          kind: 'qa_pair',
          excludeSessionId: sessionId,
          limit: 2,
        });
        for (const memory of memories) {
          const key = memory.metadata?.sessionId + ':' + memory.metadata?.questionIndex;
          if (seen.has(key)) continue;
          seen.add(key);
          priorAnswers.push({
            forQuestionIndex: answer.questionIndex,
            priorSessionId: memory.metadata?.sessionId ?? null,
            askedAt: memory.metadata?.askedAt ?? null,
            questionText: memory.metadata?.questionText ?? null,
            answerText: memory.metadata?.answerText ?? memory.content ?? null,
            answerScores: memory.metadata?.answerScores ?? null,
            // What the coach told them about this answer last time. Lets the
            // new analysis say "you fixed the thing you were told to fix"
            // rather than only comparing raw numbers.
            priorRating: memory.metadata?.aiRating ?? null,
            priorCritique: memory.metadata?.aiCritique ?? null,
            priorAdvice: memory.metadata?.aiFixAction ?? null,
          });
        }
      }
      priorAnswers = priorAnswers.slice(0, 8);
    } catch (err) {
      console.warn('[analysis/transcript] prior-answer retrieval skipped:', err.message);
      priorAnswers = [];
    }
  }

  let aiAnalysis = null;
  let aiError = null;
  try {
    console.log('[analysis/transcript] Starting Gemini qualitative analysis...');
    aiAnalysis = await generateTranscriptAnalysis({
      transcript,
      staticSignals,
      sessionContext: { jobPosting, targetWeakness },
      priorAnswers,
      plan,
    });
    console.log('[analysis/transcript] Gemini analysis complete:', JSON.stringify(aiAnalysis, null, 2));
  } catch (err) {
    console.error('[analysis/transcript] Gemini analysis failed:', err.message);
    aiError = err.message;
  }

  // Persistence is also best-effort and separate from the two stages above:
  // a DB hiccup (or an unrecognized/static-mode sessionId) shouldn't discard
  // an analysis that already succeeded -- it's still returned either way.
  let persisted = false;
  if (sessionId) {
    try {
      await saveTranscriptAnalysis(db, { sessionId, userId: req.user.userId, staticSignals, aiAnalysis, aiError, transcript });
      persisted = true;
    } catch (err) {
      console.error('[analysis/transcript] persistence failed:', err.message);
    }

    // Biometric half of the analysis (session_results): compares this
    // session's recorded signals against the user's baseline and recent
    // sessions. Nothing used to trigger this outside the test suite, so the
    // table stayed empty in real use and half of every Results page's
    // strengths/weaknesses list was missing. Best-effort like everything
    // else here -- a session with too few samples to compare simply has no
    // biometric verdicts, which is not an error worth failing the request.
    try {
      await computeSessionAnalysis(db, { sessionId, userId: req.user.userId });
    } catch (err) {
      console.warn('[analysis/transcript] biometric session analysis skipped:', err.message);
    }

  }

  // Everything the user is waiting on is now durable, so answer immediately.
  res.json({ staticSignals, aiAnalysis, aiError, persisted });

  // Push this session's language to Backboard AFTER responding, deliberately
  // not awaited. It writes 6-9 memories, each a throttled network round trip;
  // awaiting it put a third-party provider's latency directly in front of the
  // Results tab, which is exactly the outage it was designed to survive.
  // Composite and trait scores are read back from the dashboard bundle so the
  // stored coaching note carries the same numbers Results shows.
  if (sessionId) {
    void (async () => {
      try {
        let compositeScore = null;
        let traitScores = null;
        try {
          const dashboard = await getSessionDashboard(db, { sessionId, userId: req.user.userId });
          compositeScore = dashboard.atAGlance.compositeScore10;
          traitScores = Object.fromEntries(dashboard.traits.map((t) => [t.key, t.value]));
        } catch (err) {
          console.warn('[analysis/transcript] could not attach scores to memory:', err.message);
        }
        const memory = await syncSession(db, { userId: req.user.userId, sessionId, compositeScore, traitScores });
        if (memory.status !== 'skipped') console.log('[backboard] session sync:', memory.status);
      } catch (err) {
        console.warn('[analysis/transcript] memory sync skipped:', err.message);
      }
    })();
  }
});

  return router;
}
