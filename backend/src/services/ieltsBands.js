/**
 * ieltsBands.js
 * The arithmetic of IELTS band scores, in one place so the marking screen,
 * the results stored on a session and the Google Sheet row always agree.
 *
 *   - A Writing task is marked on four criteria, each a whole band 0-9:
 *     Task Achievement (Task 1) or Task Response (Task 2), Coherence and
 *     Cohesion, Lexical Resource, and Grammatical Range and Accuracy. The
 *     task band is their average, to the nearest half band.
 *   - The Writing band weights Task 2 twice as heavily as Task 1.
 *   - The overall band is the average of the four skills, to the nearest
 *     half band, with a quarter rounding up (6.25 -> 6.5, 6.75 -> 7).
 *
 * The official conversion is not published in more detail than that, so
 * the screen labels the results as a centre's estimate and the teacher can
 * override any of them.
 */

const CRITERIA = ["task", "coherence", "lexical", "grammar"];

/** Nearest half band, a quarter rounding up. */
function toHalfBand(value) {
  return Math.round(value * 2) / 2;
}

function isBand(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 9 && Math.round(value * 2) === value * 2;
}

/** The band for one Writing task from its four criteria, or null if any is missing. */
function taskBand(criteria) {
  const values = CRITERIA.map((c) => criteria?.[c]);
  if (!values.every(isBand)) return null;
  return toHalfBand(values.reduce((a, b) => a + b, 0) / values.length);
}

/** The Writing band from the task bands (Task 2 counts double). */
function writingBand(task1, task2) {
  if (isBand(task1) && isBand(task2)) return toHalfBand((task1 + 2 * task2) / 3);
  if (isBand(task2)) return task2;
  if (isBand(task1)) return task1;
  return null;
}

/** The overall band, once all four skills have one; otherwise null. */
function overallBand({ reading, listening, writing, speaking }) {
  const skills = [reading, listening, writing, speaking];
  if (!skills.every(isBand)) return null;
  return toHalfBand(skills.reduce((a, b) => a + b, 0) / 4);
}

module.exports = { CRITERIA, toHalfBand, isBand, taskBand, writingBand, overallBand };
