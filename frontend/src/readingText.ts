/**
 * Bundled calibration reading passage. Keeping this local guarantees the
 * MediaPipe baseline flow never makes a network request.
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

export { fallbackQuotes };
