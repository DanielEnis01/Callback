# Callback demo and judging plan

This plan is based on the current implementation in the repository. Replace the bracketed team-name placeholder before presenting.

## Timing decision

The written rubric adds up to **3:30** (0:30 intro + 2:00 demo + 0:30 technical + 0:30 impact), while the live-judging note allows only **2:00 for the presentation/demo + 1:00 Q&A**. Use the 3:30 script for any recorded or rubric-length submission. Use the 2:00 runbook for live judging.

Do not attempt the full four-question interview on stage. A normal session is intentionally longer than the judging window. In the full walkthrough, demonstrate two short questions and then switch to a pre-completed session. In the strict two-minute judging slot, demonstrate one question and use prepared screens to prove the rest of the loop.

## Full 3:30 presentation script

### 0:00–0:30 — Intro

> We’re **[MEMBER NAMES]**, and this is **Callback**, built for HackRice’s Work and Productivity track. Callback is an interview-preparation app that uses an immersive AI recruiter to improve your skills. Your responses and body language are tracked and formulated into strengths and weaknesses. Unlike a one-time interview score, Callback carries those results from session to session, shows how your traits are changing, and uses your weak areas to personalize what you practise next.

### 0:30–2:30 — Demo

**0:30–0:45 — Begin at the heart of Callback**

> This dashboard is the heart of Callback. Each tile is a communication trait, accumulated as an average across completed sessions. The arrows show which traits moved most in my latest interview compared with my own history.

Action: start on a populated Dashboard. Point to the overall coaching profile, two trait tiles, and one movement arrow. Do not open every trait.

**0:45–1:45 — Start a generic interview and prove the voice loop**

> To improve, I launch our live AI recruiter. I’m starting generically so Callback can measure my natural performance. Gemini grounds four questions in my résumé and role, ElevenLabs handles voice, and Presage plus MediaPipe measure delivery.

Action: click **Start new session**. Keep the résumé and job posting pre-filled, leave the weakness blank, pass the preflight check, and enter the interview. Let the recruiter audibly ask question one. Give a rehearsed 8–10 second answer. Let it ask question two, then give a second 8–10 second answer. Switch to a fully completed saved session as soon as the second answer is accepted.

Prepared answer one:

> Our interview plan originally took almost eight seconds to load. I moved that request to run alongside the greeting, removing the dead air before the first question.

Prepared answer two:

> I owned the orchestration layer, tested each integration independently, and added graceful fallbacks so one provider outage would not erase the interview.

**1:45–2:10 — Break down a completed session**

> I’ll switch to a completed interview. We show the role and composite score, then a rating, critique, and concrete fix for each answer. The transcript and body-language signals become strengths, ranked weaknesses, and up to 23 traits. Missing signals stay missing—they are never guessed.

Action: open the prepared Results session. Point, in order, to the role/composite, one per-question critique and fix, the strength list, the ranked weakness list, and the lowest trait. Do not read every result.

#### Results page talk track

Use this **25-second judging version**:

> This is a completed session. At the top is the role and overall score. Every question receives its own rating, a specific critique, and a concrete fix—not just a generic summary. Below, Callback separates what went well from what I should practise next. This weak trait becomes actionable: I can click **Practice this** and make it the focus of my next interview.

Point in this exact order:

1. **Role and composite score** — point once; do not explain the formula here.
2. **One question’s rating** — establish that feedback is answer-specific.
3. **The red critique** — identify the problem.
4. **The green Action/Result fix** — emphasize that the app tells the user what to change.
5. **Top weakness and Practice this** — this is the most important click in the Results page.

If you have **45–60 seconds**, use this fuller version:

> This is the completed-session Results page. At the top, Callback identifies the role, session, and overall score out of ten. The per-question breakdown preserves each question, rates the answer, explains what was weak, and gives a concrete Action and Result fix. The transcript is also available for evidence. Next, Callback separates session-specific weaknesses from strengths. Skill Development compares this session with my all-time average, while Since Last Time explains how a repeated answer changed. Finally, every available trait is shown from weakest to strongest. The key action is **Practice this**: instead of leaving me with a score, Callback turns a measured weakness into the goal of my next interview.

For the expanded version, continue pointing to:

6. **What went well** — prove that the feedback is balanced.
7. **Skill Development** — point out “this session” versus “your usual average.”
8. **Since Last Time** — use only if the prepared session contains a progress note.
9. **All traits measured this session** — mention that they are ordered weakest first and missing signals are omitted.

Skip during the timed demo:

- Do not open the full transcript unless a judge asks how feedback is grounded.
- Do not read all four question critiques.
- Do not define all 23 traits.
- Do not spend time explaining the composite formula before showing **Practice this**.
- Do not scroll without speaking; the presenter should name the next section before the driver moves.

**2:10–2:25 — Turn the weakness into a targeted session**

> Callback found **[PRESELECTED WEAKNESS]** was weak. **Practice this** sends that trait, its current score, my résumé, role, and relevant Backboard memories into the next plan. Gemini now asks scoped questions and can deliberately revisit a story I struggled with.

Action: click **Practice this**. On Session Setup, point to the pre-filled target and click **Start session**. Show a prepared targeted question or the **Revisiting** badge. Do not answer another full question.

**2:25–2:30 — Finish with progress and stored history**

> Trends plots the trait across stored sessions: Tiger Data tracks the score, and Backboard remembers how my answer changed.

Action: open the prepared Trends chart, point to the per-session data points, and finish on the upward or changing line.

### 2:30–3:00 — Technical design and implementation

> The Electron client captures camera and microphone signals and sends authenticated requests to a Node and Express orchestrator. The backend coordinates Gemini for planning, conversation, and review; ElevenLabs for speech in both directions; and a deterministic Python service for transcript signals. Tiger Data owns structured metrics and time-series trends, while Backboard owns semantic memory. Each integration degrades independently, so one third-party outage does not erase the session or fabricate a score.

Action: show the detailed architecture diagram.

### 3:00–3:30 — Impact

> Callback turns interview practice from generic repetition into a measurable training loop. A candidate can see whether clearer structure, steadier delivery, or stronger examples are actually improving over time—and practise privately before a real opportunity. Next, we’d validate the scoring with career coaches, add consent-first data retention controls, support more interview formats, and use real longitudinal outcomes to calibrate which signals predict better interviews.

## Live judging: exact 2:00 runbook

The presenter speaks continuously while a second teammate drives. If presenting solo, memorize the click order and use keyboard shortcuts to switch views.

### Before the timer

- Have Callback signed in, camera and microphone permissions granted, and the backend already running.
- Start on a populated Dashboard with stable cumulative trait averages and visible movement arrows.
- Keep a completed Results session ready with a clear per-question critique, at least one weak trait, and history in Trends.
- Keep a targeted Session Setup or interview ready with the weakness pre-filled and a **Revisiting** example available.
- Keep the detailed architecture diagram open in a separate full-screen window for Q&A.
- Close notifications, hide developer tools, connect power, disable sleep, and confirm audio output.
- Rehearse one 8–10 second answer; never improvise a six-minute interview.

### 0:00–0:18 — Elevator pitch

Say:

> We’re **[MEMBER NAMES]**, and this is Callback, an interview-preparation app for HackRice’s Work and Productivity track. Our AI recruiter tracks your responses and body language, formulates strengths and weaknesses, and uses each session to improve the next.

Show: populated Dashboard.

### 0:18–0:38 — Dashboard: the heart of Callback

Say:

> This is the heart of Callback. Every trait is a cumulative average across completed sessions, while the arrows show what moved most in my latest interview against my own history.

Do: point to the overall profile, two traits, and one arrow. Click **Start new session**. Session Setup must already be filled; immediately click **Start session** and pass preflight.

### 0:38–1:03 — Generic live recruiter

Say before the recruiter speaks:

> I’m starting generically so Callback can measure me naturally. Gemini grounds four questions in my résumé and role, ElevenLabs handles speech, and Presage plus MediaPipe track delivery.

Do: let one question play aloud and give the rehearsed 8–10 second answer. As soon as the recruiter acknowledges it, switch directly to the prepared completed Results session. Two live questions do not fit safely in the two-minute judging slot.

### 1:03–1:30 — Results breakdown

Say:

> Here is a completed interview: role, composite score, and a rating, critique, and concrete fix for each answer. Transcript and body-language signals become strengths, ranked weaknesses, and up to 23 normalized traits. Missing signals are never guessed.

Do: point to the composite, one question critique/fix, one strength, and the top weakness. Click **Practice this**.

### 1:30–1:47 — Targeted practice and memory

Say:

> That weakness now targets my next session. Gemini combines its current score with my résumé, role, and similar past answers from Backboard, then asks scoped questions and revisits stories I struggled with.

Do: show the pre-filled target and a prepared targeted question or **Revisiting** badge. Do not wait for another generated question on stage.

### 1:47–2:00 — Trends and stored progress

Say:

> Trends plots the trait across stored sessions. Tiger Data tracks how the score changed; Backboard remembers how my answer changed. Every interview makes the next one smarter.

Do: finish on the populated trait trend chart.

Stop. Do not use the Q&A minute to finish the demo.

## Recommended screen choreography

1. Start on the populated **Dashboard** and call it “the heart of Callback.”
2. Explain cumulative trait averages and the most-recent-session movement arrows.
3. Start a generic session and show one audible recruiter exchange in the two-minute version, or two in the longer version.
4. Switch to a **pre-completed Results** session; never wait for four questions or live analysis.
5. Walk one vertical slice of Results: composite → one critique/fix → one strength → one weakness.
6. Click **Practice this**, then show the pre-filled target and a prepared scoped question or **Revisiting** badge.
7. Finish on one populated **Trends** chart and mention stored session history.
8. Keep the architecture diagram for Q&A unless the rubric explicitly gives a separate technical-design segment.

## Demo recovery lines

- If audio or transcription stalls: “The live speech provider is delayed, so I’ll show the completed result from the same workflow.” Switch immediately to Results.
- If a camera signal is unavailable: “Callback never replaces missing measurements with zero or a guess; that signal remains absent while the rest of the session continues.”
- If Gemini is slow: “The app runs the interview plan in parallel with the greeting and has a model fallback chain; I’ll show the saved completed session.”
- If Backboard is unavailable: “Memory is an enhancement, not a dependency—the interview and numerical scoring still complete.”
- If storage is retrying: “Samples queue locally and retry; the user is warned before leaving.”

## One-minute Q&A cheat sheet

**What is technically novel?**

> We join multimodal measurement with a persistent coaching loop. The key is not one score; it is using the prior result to design the next interview and then measuring the change.

**Why Tiger Data and Backboard?**

> They answer different questions. Tiger Data handles structured metrics and time-series change. Backboard retrieves semantically similar past answers and coaching notes. Numbers and language need different retrieval models.

**How accurate are the signals?**

> They are coaching indicators, not diagnoses or lie detection. We baseline visual measures to the user, use deterministic transcript rules where appropriate, and omit any signal that was not recorded rather than guessing.

**What happens when an API fails?**

> Integrations degrade independently. The Python/static analysis can survive a Gemini failure, the interview can run without memory, and missing signals remain absent. A third-party outage should not erase the user’s session.

**How do you protect user data?**

> Every API route verifies a Firebase ID token and scopes reads and writes to that user. Backend secrets never enter the Electron bundle, and recalled user speech is delimited and escaped before it reaches a prompt.

**Why is this better than practising with a general chatbot?**

> A chatbot can simulate questions. Callback also grounds them in the résumé and job, measures delivery and answer structure, tracks trends, and automatically targets the next session at a demonstrated weakness.

## Claims that are safe to make

- The implemented interview plan contains exactly four questions.
- A generic plan normally uses one behavioral question, two résumé questions, and one job-posting question.
- The résumé is passed to Gemini as the original PDF when available.
- ElevenLabs handles speech-to-text and recruiter text-to-speech.
- Presage and MediaPipe provide camera-derived coaching signals.
- The Python service uses deterministic transcript checks; it is not another language model.
- Tiger Data stores structured session data, metrics, results, trends, and PDFs.
- Backboard stores and retrieves semantic memories of answers and session notes.
- The app can compute up to 23 traits, but it does not zero-fill unrecorded signals.
- Firebase authentication is verified server-side.

## Avoid saying

- Do not call the visual or stress signals medical-grade, diagnostic, or lie detection.
- Do not claim the score predicts hiring outcomes; that validation is future work.
- Do not claim every session always shows all 23 traits; traits require their underlying measurements.
- Do not describe the full interview as a two-minute experience; only the judging walkthrough is two minutes.
- Do not say the product has five planned questions. Some stale comments say five, but the current service enforces four.
