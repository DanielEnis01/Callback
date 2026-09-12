/**
 * Filler text for the calibration reading passage — content doesn't matter
 * for the measurement, it just needs to be a longer list of natural things
 * to read aloud continuously for ~40s. Pulled from DummyJSON's free,
 * keyless quotes endpoint (https://dummyjson.com/quotes) for variety each
 * time; falls back to a bundled set of public-domain proverbs if the fetch
 * fails or there's no network (e.g. offline demo), so calibration never
 * blocks on it. Returned as a list (one entry per quote) rather than one
 * giant string so the UI can render — and let people scroll through —
 * distinct items instead of a single wall of text.
 */

const FALLBACK_QUOTES = [
  "The early bird catches the worm.",
  "Actions speak louder than words.",
  "A journey of a thousand miles begins with a single step.",
  "Well begun is half done.",
  "Practice makes perfect.",
  "Where there is a will, there is a way.",
  "Slow and steady wins the race.",
  "A stitch in time saves nine.",
  "Fortune favors the bold.",
  "Every cloud has a silver lining.",
  "Honesty is the best policy.",
  "Knowledge is power.",
  "Time and tide wait for no one.",
  "Calm seas never made a skilled sailor.",
  "Little strokes fell great oaks.",
  "The pen is mightier than the sword.",
  "Better late than never.",
  "Birds of a feather flock together.",
  "Don't count your chickens before they hatch.",
  "Absence makes the heart grow fonder.",
  "All that glitters is not gold.",
  "The grass is always greener on the other side.",
  "When in Rome, do as the Romans do.",
  "You can't judge a book by its cover.",
  "Necessity is the mother of invention.",
  "A picture is worth a thousand words.",
  "Rome wasn't built in a day.",
  "The squeaky wheel gets the grease.",
  "Two wrongs don't make a right.",
  "Where there's smoke, there's fire.",
];

function fallbackQuotes(): string[] {
  return FALLBACK_QUOTES;
}

export async function fetchReadingText(): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch("https://dummyjson.com/quotes?limit=40", { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`dummyjson responded ${res.status}`);
    const data = await res.json();
    const quotes: Array<{ quote?: string; author?: string }> = data?.quotes ?? [];
    const list = quotes
      .filter((q) => q.quote)
      .map((q) => `${q.quote}${q.author ? ` — ${q.author}` : ""}`);
    return list.length ? list : fallbackQuotes();
  } catch (err) {
    console.warn("Falling back to bundled reading text (quote fetch failed):", err);
    return fallbackQuotes();
  }
}

export { fallbackQuotes };
