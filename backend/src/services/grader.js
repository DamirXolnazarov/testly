/**
 * grader.js
 * Auto-grades Reading & Listening against an exam's answer key.
 * Writing/Speaking are never auto-graded — band scores are entered manually
 * by the admin into the Google Sheet row (see docs/exam-json-schema.md).
 */

/** Normalize a raw answer for comparison: trim, lowercase, collapse spaces,
 * strip trailing punctuation. Keeps numbers/hyphens intact (e.g. "1911", "x-ray"). */
function normalize(raw) {
  if (raw === undefined || raw === null) return "";
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?'"]+$/g, "");
}

/** answerKey entry: string | string[] of accepted variants. */
function isCorrect(studentAnswer, answerKey) {
  const accepted = Array.isArray(answerKey) ? answerKey : [answerKey];
  const norm = normalize(studentAnswer);
  if (!norm) return false;
  return accepted.some((a) => normalize(a) === norm);
}

/**
 * Official-style band conversion table for a 40-question Reading/Listening
 * paper (Academic Reading table shown here; Listening uses the same shape,
 * General Training Reading differs slightly — swap the table via `variant`
 * once you have the exact center-specific conversion your admins want).
 * Table is [minCorrect, band] pairs, highest threshold first.
 */
const BAND_TABLE_40 = [
  [39, 9.0], [37, 8.5], [35, 8.0], [33, 7.5], [30, 7.0],
  [27, 6.5], [23, 6.0], [19, 5.5], [15, 5.0], [13, 4.5],
  [10, 4.0], [8, 3.5], [6, 3.0], [4, 2.5],
];

function scoreToBand(rawScore, totalQuestions, table = BAND_TABLE_40) {
  // Scale the table if the paper isn't exactly 40 questions.
  const scale = totalQuestions / 40;
  for (const [minCorrect, band] of table) {
    if (rawScore >= minCorrect * scale) return band;
  }
  return 1.0;
}

/**
 * Grades one section (reading or listening).
 * @param {Object} studentAnswers - the raw answers object for this section,
 *   as stored by the client (some values are flat, some nested — see
 *   buildAnswerKey's `path` on each entry, which tells us where to look).
 * @param {Array}  answerKey - flattened list of { id, n, answer, path } across all parts
 * @returns {{ rawScore, total, band, perQuestion: Array }}
 */
function gradeSection(studentAnswers, answerKey) {
  const perQuestion = answerKey.map((q) => {
    const given = getAtPath(studentAnswers, q.path || [q.id]);
    const correct = isCorrect(given, q.answer);
    return { id: q.id, n: q.n, given: given ?? null, correct };
  });
  const rawScore = perQuestion.filter((p) => p.correct).length;
  const total = answerKey.length;
  const band = scoreToBand(rawScore, total);
  return { rawScore, total, band, perQuestion };
}

/** Walks a nested-answers object by a path array, e.g. path ["q8","r9gap"]
 * looks up studentAnswers.q8.r9gap (how table-gap and map-point answers are
 * actually stored by the client — see QuestionRenderer's table/map cases and
 * MapQuestion's onChange in IELTSCDReplica.jsx / QuestionTypes.jsx). A
 * single-element path is just a flat top-level lookup, same as before. */
function getAtPath(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * Flattens an exam section into a single answer-key list, one entry per
 * auto-gradable question/sub-question, each carrying a `path` describing
 * exactly where to find the student's answer for it:
 *
 *   - reading mcq/tfng/gap-fill:  path = [question.id]                (flat)
 *   - reading table:              path = [question.id, gap.id]        (nested — one entry per gap)
 *   - reading/listening map:      path = [question.id, point.id]      (nested — one entry per pin)
 *   - listening item lines:       path = [line.n]                     (flat — matches how
 *                                   ListeningModule stores answers, keyed by question number)
 *
 * Matching questions are intentionally excluded — matching answers are
 * letters chosen from a shared bank, not free-text, and are graded the same
 * way as mcq (exact match against `answer`) via the flat case below, so no
 * special handling needed there beyond having an `answer` field.
 */
function buildAnswerKey(section) {
  const keys = [];

  for (const part of section.parts || []) {
    // Reading-style parts: questions[]
    for (const q of part.questions || []) {
      if (q.answer !== undefined) {
        keys.push({ id: q.id, n: q.n, answer: q.answer, path: [q.id] });
      }
      if (q.type === "table" && Array.isArray(q.gaps)) {
        for (const g of q.gaps) {
          if (g.answer !== undefined) {
            keys.push({ id: `${q.id}.${g.id}`, n: g.n, answer: g.answer, path: [q.id, g.id] });
          }
        }
      }
      if (q.type === "map" && Array.isArray(q.points)) {
        for (const pt of q.points) {
          if (pt.answer !== undefined) {
            keys.push({ id: `${q.id}.${pt.id}`, n: pt.n, answer: pt.answer, path: [q.id, pt.id] });
          }
        }
      }
    }
    // Listening-style parts: items[] with lines[]
    for (const item of part.items || []) {
      for (const line of item.lines || []) {
        if (line.n !== undefined && line.answer !== undefined) {
          keys.push({ id: String(line.n), n: line.n, answer: line.answer, path: [line.n] });
        }
      }
    }
  }

  return keys;
}

module.exports = { gradeSection, buildAnswerKey, normalize, isCorrect, scoreToBand };