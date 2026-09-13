"""
Callback — Speech analysis service (Python).

Fills in the "Speech agent" half of python/README.md's placeholder: static,
rule-based checks over the interview transcript (STAR-method structure,
quantified results, filler words, disfluency -- repeated words, unfinished
thoughts, tangents -- and job-posting topic relevance). This is deliberately NOT an LLM — it's
fast, deterministic, and free, so it runs on every session without an API
call. Its structured output is then handed to Gemini (see
backend/src/services/gemini.js's generateTranscriptAnalysis) alongside the
raw transcript for the dynamic/qualitative half of the analysis — Gemini
reasons in prose, this script verifies concrete rules Gemini could
plausibly miss or be inconsistent about (did they quantify the result? did
they actually cover all four STAR components? how many filler words?).

No third-party dependencies on purpose — this needs to run on the
candidate's machine via a plain `python3 analysis_service.py`, and pip
installs aren't guaranteed to have network access in every environment
this app runs in. Everything here is stdlib: http.server + re.

Run:
    python3 python/analysis_service.py
Env:
    ANALYSIS_SERVICE_PORT (default 5055)

Endpoints:
    GET  /health                        -> {"status": "ok"}
    POST /analyze  {"transcript": [...]} -> see analyze_transcript() below
"""

import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("ANALYSIS_SERVICE_PORT", "5055"))

# ── STAR-method cue words ────────────────────────────────────────────────────
# Deliberately broad, lightly-weighted keyword/phrase heuristics rather than
# real NLP — good enough to flag "this answer never described an outcome" or
# "no concrete action verbs here", not meant to be a precise classifier.
SITUATION_CUES = [
    r"\bwhen i\b", r"\bat my (?:previous|last|prior)\b", r"\bwe were\b", r"\bthe situation\b",
    r"\bworking (?:at|on|for)\b", r"\bmy team\b", r"\bat the time\b", r"\bback (?:in|when)\b",
    r"\bwe (?:had|needed|faced)\b", r"\bthere was\b",
]
TASK_CUES = [
    r"\bmy (?:job|role|responsibility|goal) was\b", r"\bi was (?:asked|tasked|responsible)\b",
    r"\bwe needed to\b", r"\bthe (?:goal|objective|challenge) was\b", r"\bi (?:had|needed) to\b",
    r"\bmy task\b",
]
ACTION_CUES = [
    r"\bi (?:decided|implemented|led|built|created|designed|developed|proposed|organized|"
    r"launched|wrote|coded|debugged|negotiated|coordinated|analyzed|refactored|automated|"
    r"presented|collaborated|reached out|prioritized|delegated)\b",
    r"\bfirst,? i\b", r"\bthen i\b", r"\bso i\b",
]
RESULT_CUES = [
    r"\bas a result\b", r"\bwhich (?:led to|resulted in|caused|meant)\b", r"\bresulting in\b",
    r"\bthe outcome\b", r"\bultimately\b", r"\bin the end\b", r"\bwe (?:achieved|delivered|shipped)\b",
    r"\bi (?:achieved|delivered|improved|reduced|increased|saved|grew|cut)\b",
]

# ── Quantification (numbers that actually mean something, not just any digit) ──
QUANT_PATTERNS = [
    r"\d+(\.\d+)?\s?%",                       # 30%, 12.5 %
    r"[$€£]\s?\d[\d,]*(\.\d+)?",              # $10,000 / £250
    r"\b\d+[\d,]*\s?(?:x|times)\b",           # 3x, 10 times
    r"\b\d+[\d,]*\s?(?:users|customers|people|clients|engineers|hours|days|weeks|months|"
    r"dollars|requests|tickets|leads|conversions|followers|views|points)\b",
    r"\bfrom\s+\d[\d,]*\s+to\s+\d[\d,]*\b",   # "from 20 to 80"
]

# ── Filler words ──────────────────────────────────────────────────────────────
FILLER_WORDS = ["um", "uh", "uhh", "umm", "like", "you know", "sort of", "kind of",
                "basically", "actually", "i mean", "literally", "right?"]

RAMBLING_WORD_COUNT = 180   # above this, flag as possibly unfocused/rambling
UNDERDEVELOPED_WORD_COUNT = 12  # below this, flag as likely underdeveloped

# ── Topic relevance (staying on topic) ───────────────────────────────────────
# Deliberately the same spirit as the STAR/quantification checks above: a
# cheap, deterministic keyword-overlap heuristic, not real NLP relevance
# scoring. Only computed when a job posting was actually provided -- with
# nothing to compare against there is no honest relevance number to give,
# so the field is simply omitted rather than guessed at (same "absent, not
# zero" rule the rest of this app follows).
TOPIC_STOPWORDS = {
    "the", "and", "for", "with", "that", "this", "from", "have", "will",
    "your", "you", "are", "was", "were", "our", "their", "about", "into",
    "than", "then", "them", "they", "these", "those", "which", "while",
    "such", "some", "more", "most", "other", "over", "under", "also",
    "able", "including", "please", "role", "job", "work",
    "years", "year", "experience", "team", "company",
}
# Mentioning this many role-relevant keywords in a single answer counts as
# fully "on topic" (relevance caps at 10) -- an arbitrary but documented
# threshold, same tuning approach as RAMBLING_WORD_COUNT above.
TOPIC_RELEVANCE_KEYWORD_TARGET = 3


def _keyword_set(text: str) -> set:
    words = re.findall(r"[A-Za-z][A-Za-z'+#.]{3,}", (text or "").lower())
    return {w for w in words if w not in TOPIC_STOPWORDS}


def _topic_relevance_score(answer_lower, job_keywords):
    if not job_keywords:
        return None
    answer_keywords = _keyword_set(answer_lower)
    shared = len(answer_keywords & job_keywords)
    return round(min(1.0, shared / TOPIC_RELEVANCE_KEYWORD_TARGET) * 10, 2)


# ── Disfluency: the "stutter" signals that actually survive transcription ────
# Acoustic stuttering mostly doesn't reach the transcript (speech-to-text
# smooths it), but the disfluency it produces in the TEXT does, and those
# patterns are what an interviewer actually notices:
#   1. repeated words       -- "I I think", "we we built"
#   2. unfinished thoughts  -- sentences that dangle on a conjunction or
#                              trail off instead of landing
#   3. tangents             -- audible self-correction / derailment
# All three are deterministic regex checks in the same spirit as the
# STAR/filler-word rules above -- no LLM call, runs on every session.

# "had had" and "that that" are legitimately grammatical in English; every
# other immediate repeat (including emphatic "very very") is worth flagging
# for interview delivery.
GRAMMATICAL_DOUBLES = {"had", "that"}
REPEATED_WORD_RE = re.compile(r"\b([A-Za-z']+)\s+\1\b", re.IGNORECASE)

# A sentence ending on one of these reads as a thought that ran out of road
# rather than one that landed. Deliberately punctuation-independent: STT
# output can't be relied on for consistent terminal punctuation, so "no
# period at the end" is NOT treated as unfinished on its own.
#
# Kept deliberately CONSERVATIVE -- only words that essentially never end a
# complete declarative sentence. A false "you trailed off there" is much
# more corrosive to trust in the score than a missed one, so near-misses
# are left out on purpose: "it" ("we shipped it"), "was"/"is" ("I wondered
# what it was"), "that" ("I didn't know that"), "when" ("I don't know
# when") and most prepositions that can legitimately end a question all
# stay OUT of this set.
DANGLING_WORDS = {
    "and", "but", "so", "or", "because",
    "to", "of", "into", "from",
    "the", "a", "an", "my", "our", "their",
    "which", "if", "like", "kind", "sort", "i",
}
# Sentence terminators, kept as a capturing split so a visible trail-off
# ("I was going to say...") can be told apart from an ordinary full stop.
# A single hyphen is excluded on purpose -- it appears inside words.
TERMINATOR_RE = re.compile(r"(\.{3,}|…|—|--|[.!?]+)")
# Which of those terminators mean "the thought trailed off" rather than
# "the sentence ended". Checked explicitly because "..." is also a perfectly
# valid match for a run of ordinary full stops.
TRAILOFF_RE = re.compile(r"\A(?:\.{3,}|…|—|--)\Z")

# Audible derailment: the speaker noticing (or signalling) that they've
# wandered. Catching the marker is far more reliable than trying to infer
# a topic change from the text itself.
TANGENT_MARKERS = [
    r"\banyway\b", r"\banyways\b", r"\bwhere was i\b", r"\bwhat was the question\b",
    r"\b(?:getting|going|back) back to\b", r"\bi digress\b", r"\bside ?note\b",
    r"\bi'?m rambling\b", r"\bi'?m going off\b", r"\boff ?topic\b",
    r"\blong story short\b", r"\bto be honest,? i forgot\b",
    r"\blet me start over\b", r"\bactually,? wait\b", r"\bsorry,? i (?:lost|forgot)\b",
    r"\bwhat i (?:mean|meant) is\b", r"\bif that makes sense\b",
]

# Per-answer rates at/above which the fluency score bottoms out. Same
# tuning approach as RAMBLING_WORD_COUNT -- arbitrary but documented, and
# meant to move once there's real usage data behind them.
REPETITIONS_PER_ANSWER_FLOOR = 3
UNFINISHED_PER_ANSWER_FLOOR = 2


def _count_repeated_words(text):
    """Immediately repeated words, e.g. "I I think" or "we we built"."""
    return sum(1 for match in REPEATED_WORD_RE.finditer(text or "")
               if match.group(1).lower() not in GRAMMATICAL_DOUBLES)


def _count_unfinished(text):
    """Sentences that dangle on a conjunction/article or visibly trail off.

    Splitting keeps the terminator so "...", an em dash or "--" counts as a
    trail-off on its own, while an ordinary "." falls through to the
    dangling-last-word check. Each sentence contributes at most once, so
    "and so anyway..." isn't double-counted.
    """
    parts = TERMINATOR_RE.split(text or "")
    count = 0
    # A capturing split yields [segment, terminator, segment, terminator, ..., segment].
    for i in range(0, len(parts), 2):
        segment = parts[i].strip()
        if not segment:
            continue
        terminator = parts[i + 1] if i + 1 < len(parts) else ""
        if terminator and TRAILOFF_RE.match(terminator):
            count += 1
            continue
        words = re.findall(r"[A-Za-z']+", segment)
        if words and words[-1].lower() in DANGLING_WORDS:
            count += 1
    return count


def _count_tangents(text_lower):
    return sum(len(re.findall(p, text_lower)) for p in TANGENT_MARKERS)


# ── Delivery quality: ownership, hedging, depth, specificity ─────────────────
# The remaining transcript-side traits on the Results tab. All countable,
# all deterministic, all things an interviewer reacts to without naming.

# "I shipped it" vs "we shipped it": interviewers are listening for what
# YOU did. Neither is wrong -- collaboration matters -- but an answer that
# never says "I" makes individual contribution impossible to assess.
FIRST_PERSON_SINGULAR = re.compile(r"\b(?:i|i'?m|i'?ve|i'?ll|i'?d|me|my|mine|myself)\b", re.IGNORECASE)
FIRST_PERSON_PLURAL = re.compile(r"\b(?:we|we'?re|we'?ve|we'?ll|we'?d|us|our|ours|ourselves)\b", re.IGNORECASE)

# Hedges drain authority from an otherwise strong answer.
HEDGE_PATTERNS = [
    r"\bi think\b", r"\bi guess\b", r"\bi believe\b", r"\bmaybe\b", r"\bprobably\b",
    r"\bperhaps\b", r"\bsort of\b", r"\bkind of\b", r"\bi'?m not sure\b",
    r"\bor something\b", r"\bi would say\b", r"\bpretty much\b", r"\bmore or less\b",
    r"\bhopefully\b", r"\bi mean\b", r"\bif i remember\b", r"\bi don'?t know\b",
]

# Concrete detail: real numbers, and mid-sentence capitalised words, which
# in speech-to-text output are overwhelmingly names of companies, products,
# tools and technologies -- the specifics that make an answer credible.
NUMBER_RE = re.compile(r"\b\d[\d,.]*\b")
PROPER_NOUN_RE = re.compile(r"(?<!^)(?<![.!?]\s)\b[A-Z][A-Za-z0-9+#.]{1,}\b")

# Answer length band. Below the floor an answer is too thin to show
# anything; above the ceiling it has stopped being an answer. Both ends are
# scored, in opposite directions, so "too short" and "too long" are
# distinguishable rather than collapsing into one vague "length" number.
IDEAL_WORD_FLOOR = 60
IDEAL_WORD_CEILING = 170


def _ownership_counts(text):
    return len(FIRST_PERSON_SINGULAR.findall(text or "")), len(FIRST_PERSON_PLURAL.findall(text or ""))


def _count_hedges(text_lower):
    return sum(len(re.findall(p, text_lower)) for p in HEDGE_PATTERNS)


def _count_specifics(text):
    return len(NUMBER_RE.findall(text or "")) + len(PROPER_NOUN_RE.findall(text or ""))


def _vocabulary_richness(words):
    """Type-token ratio: how much of the answer is distinct vocabulary."""
    if len(words) < 10:
        return None
    return round(len({w.lower() for w in words}) / len(words), 3)


# ── Non-answers ─────────────────────────────────────────────────────────────
# The single most consequential thing that can happen in an interview, and
# nothing upstream was catching it: the candidate saying, in effect, "I
# don't know, skip it." An answer can score well on every other signal here
# -- concise, fluent, no filler -- while conceding the question outright,
# so this is tracked on its own rather than folded into any of them.
NON_ANSWER_PATTERNS = [
    r"\bi (?:have )?no (?:fucking |freaking |damn )?(?:clue|idea)\b",
    r"\bi (?:really )?do ?n'?t know\b",
    r"\bidk\b",
    r"\bno idea\b",
    r"\bnot sure what (?:that|this|you) (?:means?|mean)\b",
    r"\bdo ?n'?t know what (?:that|this) means\b",
    r"\bi ca ?n'?t (?:really )?answer\b",
    r"\bca ?n'?t answer (?:that|this)\b",
    r"\bi'?ll (?:just )?skip\b",
    r"\b(?:let'?s |can we )?skip (?:that|this|it)\b",
    r"\bpass on (?:that|this)\b",
    r"\bi'?ve never (?:done|used|worked with|heard)\b",
    r"\bi do ?n'?t (?:have|know) (?:any )?experience\b",
    r"\bi do ?n'?t know what to say\b",
    r"\bnever heard of (?:that|it)\b",
    # Deflection without admitting ignorance. A real session answered one
    # question with "Can you move on to the next question, please?" and
    # another with "Skip", and both scored as clean answers -- the existing
    # patterns all required the words "don't know" or "skip THAT".
    r"\b(?:can|could|will) (?:you|we) (?:please )?(?:just )?move on\b",
    r"\bmove on to the next (?:question|one)\b",
    r"\b(?:can|could) (?:you|we) (?:please )?go to the next (?:question|one)\b",
    r"\bnext question,? please\b",
    r"\bi'?d rather not (?:answer|say)\b",
    r"\b(?:let'?s |can we )?come back to (?:that|this) (?:one )?later\b",
]

# A bare deflection is the whole answer, not a phrase inside one: "Skip."
# means something very different from "we didn't skip testing". Matched
# against the entire answer so it can never fire mid-sentence.
BARE_DEFLECTIONS = {
    "skip", "skip it", "skip this", "skip that", "pass", "next",
    "next question", "no comment", "nothing", "n/a", "na",
}


def _count_non_answers(text_lower):
    count = sum(1 for p in NON_ANSWER_PATTERNS if re.search(p, text_lower))
    if _strip_for_bare_match(text_lower) in BARE_DEFLECTIONS:
        count += 1
    return count


def _strip_for_bare_match(text_lower):
    """Whole answer, minus trailing punctuation and surrounding whitespace."""
    return re.sub(r"[\s.!?,;:]+$", "", text_lower.strip())


def _count_matches(patterns, text_lower):
    return sum(1 for p in patterns if re.search(p, text_lower))


def _count_filler_words(text_lower):
    counts = {}
    total = 0
    for phrase in FILLER_WORDS:
        pattern = r"\b" + re.escape(phrase) + r"\b"
        n = len(re.findall(pattern, text_lower))
        if n:
            counts[phrase] = n
            total += n
    return counts, total


def analyze_answer(text: str, index: int, job_keywords=None) -> dict:
    text = text or ""
    lower = text.lower()
    words = re.findall(r"[A-Za-z']+", text)
    word_count = len(words)

    star = {
        "situation": _count_matches(SITUATION_CUES, lower) > 0,
        "task": _count_matches(TASK_CUES, lower) > 0,
        "action": _count_matches(ACTION_CUES, lower) > 0,
        "result": _count_matches(RESULT_CUES, lower) > 0,
    }
    star_score = sum(1 for v in star.values() if v)

    quantified = _count_matches(QUANT_PATTERNS, lower) > 0
    filler_counts, filler_total = _count_filler_words(lower)
    topic_relevance = _topic_relevance_score(lower, job_keywords) if job_keywords else None
    repeated_words = _count_repeated_words(text)
    unfinished = _count_unfinished(text)
    tangents = _count_tangents(lower)
    singular, plural = _ownership_counts(text)
    hedges = _count_hedges(lower)
    specifics = _count_specifics(text)
    vocabulary = _vocabulary_richness(words)
    non_answer_markers = _count_non_answers(lower)

    flags = []
    if not star["situation"] and not star["task"]:
        flags.append("no_context_setup")
    if not star["action"]:
        flags.append("no_clear_action")
    if not star["result"]:
        flags.append("missing_result")
    if not quantified:
        flags.append("no_quantification")
    if word_count >= RAMBLING_WORD_COUNT:
        flags.append("possibly_rambling")
    if 0 < word_count < UNDERDEVELOPED_WORD_COUNT:
        flags.append("underdeveloped")
    if filler_total >= 5:
        flags.append("heavy_filler_words")
    if topic_relevance is not None and topic_relevance <= 2:
        flags.append("possibly_off_topic")
    if repeated_words >= 2:
        flags.append("repeated_words")
    if unfinished >= 1:
        flags.append("unfinished_thought")
    if tangents >= 1:
        flags.append("tangent")
    if non_answer_markers >= 1:
        flags.append("non_answer")

    return {
        "index": index,
        "wordCount": word_count,
        "star": star,
        "starScore": star_score,
        "quantified": quantified,
        "fillerWords": {**filler_counts, "total": filler_total},
        "topicRelevance": topic_relevance,
        "repeatedWords": repeated_words,
        "unfinishedSentences": unfinished,
        "tangents": tangents,
        "firstPersonSingular": singular,
        "firstPersonPlural": plural,
        "hedges": hedges,
        "specifics": specifics,
        "vocabularyRichness": vocabulary,
        "nonAnswerMarkers": non_answer_markers,
        "conceded": non_answer_markers >= 1,
        "flags": flags,
    }


def analyze_transcript(transcript: list, job_posting=None) -> dict:
    """
    transcript: list of {"role": "user"|"model", "parts": [{"text": "..."}]}
    (same ConversationTurn shape used across the frontend/backend already).
    Only "user" turns (the candidate's answers) are scored — "model" turns
    are the recruiter's questions and aren't subject to STAR/filler checks.

    job_posting: optional free-text job posting for this session (see
    sessions.job_posting_text / job_postings). When present, each answer
    also gets a keyword-overlap "staying on topic" score -- see
    _topic_relevance_score. Omitted entirely when no job posting was given,
    same as every other signal this service can't honestly compute.
    """
    job_keywords = _keyword_set(job_posting) if job_posting else None

    answers = []
    idx = 0
    for turn in transcript or []:
        if turn.get("role") != "user":
            continue
        parts = turn.get("parts") or []
        text = "".join(p.get("text", "") for p in parts if isinstance(p, dict))
        answers.append(analyze_answer(text, idx, job_keywords))
        idx += 1

    total = len(answers)
    if total == 0:
        summary = {
            "totalAnswers": 0, "avgStarScore": 0, "quantifiedRate": 0,
            "totalFillerWords": 0, "fillerWordsPerAnswer": 0,
            "totalRepeatedWords": 0, "repeatedWordsPerAnswer": 0,
            "totalUnfinishedSentences": 0, "unfinishedPerAnswer": 0,
            "totalTangents": 0, "tangentsPerAnswer": 0,
            "hedgesPerAnswer": 0, "specificsPerAnswer": 0, "avgWordCount": 0,
            "nonAnswerRate": 0, "concededAnswers": [],
            "situationRate": 0, "actionRate": 0, "resultRate": 0,
            "flaggedAnswers": [],
        }
    else:
        avg_star = sum(a["starScore"] for a in answers) / total
        quant_rate = sum(1 for a in answers if a["quantified"]) / total
        total_filler = sum(a["fillerWords"]["total"] for a in answers)
        summary = {
            "totalAnswers": total,
            "avgStarScore": round(avg_star, 2),
            "quantifiedRate": round(quant_rate, 2),
            "totalFillerWords": total_filler,
            "fillerWordsPerAnswer": round(total_filler / total, 2),
            "totalRepeatedWords": sum(a["repeatedWords"] for a in answers),
            "repeatedWordsPerAnswer": round(sum(a["repeatedWords"] for a in answers) / total, 2),
            "totalUnfinishedSentences": sum(a["unfinishedSentences"] for a in answers),
            "unfinishedPerAnswer": round(sum(a["unfinishedSentences"] for a in answers) / total, 2),
            "totalTangents": sum(a["tangents"] for a in answers),
            "tangentsPerAnswer": round(sum(a["tangents"] for a in answers) / total, 2),
            "hedgesPerAnswer": round(sum(a["hedges"] for a in answers) / total, 2),
            "specificsPerAnswer": round(sum(a["specifics"] for a in answers) / total, 2),
            "avgWordCount": round(sum(a["wordCount"] for a in answers) / total, 1),
            # Share of STAR components covered, each on its own, so "never
            # sets up context" and "never states an outcome" are separable
            # instead of both just lowering one blended STAR number.
            # Share of questions the candidate effectively declined to answer.
            "nonAnswerRate": round(sum(1 for a in answers if a["conceded"]) / total, 2),
            "concededAnswers": [a["index"] for a in answers if a["conceded"]],
            "situationRate": round(sum(1 for a in answers if a["star"]["situation"] or a["star"]["task"]) / total, 2),
            "actionRate": round(sum(1 for a in answers if a["star"]["action"]) / total, 2),
            "resultRate": round(sum(1 for a in answers if a["star"]["result"]) / total, 2),
            "flaggedAnswers": [a["index"] for a in answers if a["flags"]],
        }
        # Ownership only means something once someone actually used a
        # first-person pronoun; with none at all there is no ratio to report.
        owned = sum(a["firstPersonSingular"] for a in answers)
        shared = sum(a["firstPersonPlural"] for a in answers)
        if owned + shared > 0:
            summary["ownershipRate"] = round(owned / (owned + shared), 2)
        vocab = [a["vocabularyRichness"] for a in answers if a["vocabularyRichness"] is not None]
        if vocab:
            summary["vocabularyRichness"] = round(sum(vocab) / len(vocab), 3)
        relevance_scores = [a["topicRelevance"] for a in answers if a["topicRelevance"] is not None]
        if relevance_scores:
            summary["avgTopicRelevance"] = round(sum(relevance_scores) / len(relevance_scores), 2)

    return {"answers": answers, "summary": summary}


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"status": "ok"})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/analyze":
            self._send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw or b"{}")
        except (ValueError, json.JSONDecodeError) as err:
            self._send_json(400, {"error": f"invalid JSON body: {err}"})
            return

        transcript = body.get("transcript")
        if not isinstance(transcript, list):
            self._send_json(400, {"error": "transcript (array) is required"})
            return
        job_posting = body.get("jobPosting")
        if job_posting is not None and not isinstance(job_posting, str):
            self._send_json(400, {"error": "jobPosting, if present, must be a string"})
            return

        try:
            result = analyze_transcript(transcript, job_posting)
            self._send_json(200, result)
        except Exception as err:  # keep the service alive on any single bad request
            self._send_json(500, {"error": str(err)})

    def log_message(self, fmt, *args):
        print(f"[analysis_service] {self.address_string()} - {fmt % args}")


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Callback analysis service listening on http://127.0.0.1:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
