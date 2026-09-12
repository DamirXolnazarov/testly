/**
 * services/satAnswerMatch.js
 *
 * Grading a SAT Math "grid-in" (student-produced response) answer isn't a
 * plain string comparison the way gap-fill is — the real grid only accepts
 * digits, a decimal point, a slash, and a minus sign, but mathematically
 * equivalent entries must all be marked correct: "3/4", ".75", and "0.75"
 * are the same answer. A plain normalize()-and-compare (what grader.js does
 * for every other question type) would wrongly mark two of those three
 * wrong.
 *
 * This is a deliberately simplified version of the real grid-in rules (no
 * mixed-number handling, no explicit rounding-tolerance windows for
 * repeating decimals) — it covers the overwhelmingly common cases
 * (whole numbers, simple decimals, simple fractions, negative values) with
 * real numeric equivalence rather than string matching, which is the part
 * that actually matters for not unfairly marking a correct answer wrong.
 */

// Parses a grid-in-style string into a plain number, or null if it isn't a
// valid grid-in entry (letters, malformed fractions, empty, etc.) — that
// null return matters as much as the parsed value: an unparseable answer
// should never accidentally compare as numerically equal to anything via
// NaN-related coercion bugs, so every caller must treat null explicitly as
// "no valid number here" rather than let a falsy check paper over it.
function parseGridInValue(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "") return null;

  // Fraction form: optional leading minus, digits, slash, digits.
  const fractionMatch = s.match(/^(-?\d+)\/(\d+)$/);
  if (fractionMatch) {
    const numerator = Number(fractionMatch[1]);
    const denominator = Number(fractionMatch[2]);
    if (denominator === 0) return null; // division by zero is never a valid grid-in entry
    return numerator / denominator;
  }

  // Plain number form: optional minus, digits, optional decimal part.
  // (Also accepts a leading "." with no leading 0, e.g. ".75" — a real
  // grid-in entry, and Number() already parses that correctly.)
  if (/^-?(\d+\.?\d*|\.\d+)$/.test(s)) {
    return Number(s);
  }

  return null;
}

/**
 * @param {string} given - what the student typed
 * @param {string} answer - the accepted answer from the exam definition
 * @returns {boolean}
 */
function isGridInCorrect(given, answer) {
  const givenValue = parseGridInValue(given);
  const answerValue = parseGridInValue(answer);
  if (givenValue === null || answerValue === null) return false;
  // Small epsilon for floating-point comparison (e.g. 1/3 parsed from a
  // fraction vs a decimal approximation the student typed) — real grid-in
  // entries only allow a handful of digits, so this tolerance is generous
  // enough to cover legitimate rounding without accepting genuinely
  // different values as equal.
  return Math.abs(givenValue - answerValue) < 1e-9;
}

module.exports = { isGridInCorrect, parseGridInValue };
