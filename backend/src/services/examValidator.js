/**
 * examValidator.js
 * Validates an exam JSON payload against the shape in docs/exam-json-schema.md
 * *before* it's stored — the alternative is a malformed question (missing
 * type, a matching question with no options, a gap-fill with no `answer`)
 * silently getting saved and only surfacing when a student hits it mid-test,
 * which is a much worse place to discover it.
 *
 * No external schema library — the shape is small and stable enough that a
 * hand-rolled walker gives better error messages ("part 2, question q7:
 * matching needs options[]") than a generic ajv dump would.
 */

const QUESTION_TYPES = ["mcq", "tfng", "gap-fill", "matching", "table", "map"];
const SECTION_TYPES = ["reading", "listening", "writing"];

/** @returns {{ valid: boolean, errors: string[] }} */
function validateExam(exam) {
  const errors = [];

  if (!exam || typeof exam !== "object") {
    return { valid: false, errors: ["Exam must be a JSON object."] };
  }
  if (!exam.title || typeof exam.title !== "string") {
    errors.push("Missing or invalid `title` (string).");
  }
  if (!Array.isArray(exam.sections) || exam.sections.length === 0) {
    errors.push("`sections` must be a non-empty array.");
    return { valid: false, errors }; // nothing else to check without sections
  }

  exam.sections.forEach((section, si) => {
    const loc = `sections[${si}]`;
    if (!SECTION_TYPES.includes(section.type)) {
      errors.push(`${loc}: type must be one of ${SECTION_TYPES.join(", ")} (got "${section.type}").`);
      return; // can't validate parts meaningfully without knowing the type
    }
    if (!Array.isArray(section.parts) || section.parts.length === 0) {
      errors.push(`${loc} (${section.type}): parts must be a non-empty array.`);
      return;
    }
    section.parts.forEach((part, pi) => validatePart(part, `${loc}.parts[${pi}]`, section.type, errors));
  });

  return { valid: errors.length === 0, errors };
}

function validatePart(part, loc, sectionType, errors) {
  if (!part.id) errors.push(`${loc}: missing id.`);

  if (sectionType === "reading") {
    if (!part.title) errors.push(`${loc}: reading part needs a title.`);
    if (!Array.isArray(part.passage) || part.passage.length === 0) {
      errors.push(`${loc}: reading part needs a non-empty passage[] array of paragraphs.`);
    }
    if (!Array.isArray(part.questions) || part.questions.length === 0) {
      errors.push(`${loc}: reading part needs a non-empty questions[] array.`);
    } else {
      const seenN = new Set();
      part.questions.forEach((q, qi) => {
        validateQuestion(q, `${loc}.questions[${qi}]`, errors);
        if (q.n !== undefined) {
          if (seenN.has(q.n)) errors.push(`${loc}.questions[${qi}]: duplicate question number ${q.n} within this part.`);
          seenN.add(q.n);
        }
      });
    }
  }

  if (sectionType === "listening") {
    if (!part.title) errors.push(`${loc}: listening part needs a title.`);
    if (!Array.isArray(part.items) || part.items.length === 0) {
      errors.push(`${loc}: listening part needs a non-empty items[] array.`);
    } else {
      const seenN = new Set();
      part.items.forEach((item, ii) => {
        if (!Array.isArray(item.lines)) {
          errors.push(`${loc}.items[${ii}]: needs a lines[] array.`);
          return;
        }
        item.lines.forEach((line, li) => {
          if (line.n === undefined) return; // static text lines (no blank) are fine without n
          if (seenN.has(line.n)) errors.push(`${loc}.items[${ii}].lines[${li}]: duplicate question number ${line.n} within this part.`);
          seenN.add(line.n);
          if (line.answer === undefined) {
            errors.push(`${loc}.items[${ii}].lines[${li}] (n=${line.n}): missing answer — needed for auto-grading.`);
          }
        });
      });
    }
    // audioUrl is allowed to be null pre-TTS-generation — not required here.
  }

  if (sectionType === "writing") {
    if (!part.prompt) errors.push(`${loc}: writing part needs a prompt.`);
    if (!part.instructions) errors.push(`${loc}: writing part needs instructions.`);
    if (part.minWords !== undefined && typeof part.minWords !== "number") {
      errors.push(`${loc}: minWords must be a number if present.`);
    }
  }
}

function validateQuestion(q, loc, errors) {
  if (!q.id) errors.push(`${loc}: missing id.`);
  if (q.n === undefined || typeof q.n !== "number") errors.push(`${loc}: missing numeric n (question number).`);
  if (!QUESTION_TYPES.includes(q.type)) {
    errors.push(`${loc}: type must be one of ${QUESTION_TYPES.join(", ")} (got "${q.type}").`);
    return;
  }
  // answer key presence — required for auto-gradable types, since grader.js
  // (buildAnswerKey) silently skips questions with no `answer` rather than
  // erroring, which would otherwise let an ungraded question through unnoticed.
  const autoGradable = ["mcq", "tfng", "gap-fill"];
  if (autoGradable.includes(q.type) && q.answer === undefined) {
    errors.push(`${loc}: type "${q.type}" needs an \`answer\` field for auto-grading.`);
  }

  switch (q.type) {
    case "mcq":
      if (!Array.isArray(q.options) || q.options.length < 2) errors.push(`${loc}: mcq needs options[] with at least 2 choices.`);
      if (!q.prompt) errors.push(`${loc}: mcq needs a prompt.`);
      break;
    case "tfng":
      if (!q.prompt) errors.push(`${loc}: tfng needs a prompt.`);
      if (q.answer !== undefined && !["TRUE", "FALSE", "NOT GIVEN"].includes(q.answer)) {
        errors.push(`${loc}: tfng answer must be TRUE, FALSE, or NOT GIVEN (got "${q.answer}").`);
      }
      break;
    case "gap-fill":
      if (q.before === undefined && q.after === undefined) {
        errors.push(`${loc}: gap-fill needs at least a before or after text fragment.`);
      }
      break;
    case "matching":
      if (!Array.isArray(q.options) || q.options.length < 2) errors.push(`${loc}: matching needs options[] with at least 2 entries.`);
      if (!q.prompt) errors.push(`${loc}: matching needs a prompt.`);
      break;
    case "table":
      if (!q.table || !Array.isArray(q.table.headers) || !Array.isArray(q.table.rows)) {
        errors.push(`${loc}: table needs a table.headers[] and table.rows[].`);
      }
      if (!Array.isArray(q.gaps) || q.gaps.length === 0) {
        errors.push(`${loc}: table question needs a gaps[] array describing which cells are fillable.`);
      } else {
        if (q.table) {
          // every gap's cellMarker should actually appear in some row — catches
          // the easy typo of "___GAP8___" vs "___GAP_8___" that would otherwise
          // silently render as static text instead of an input.
          const allCells = q.table.rows.flat();
          q.gaps.forEach((g) => {
            if (!allCells.includes(g.cellMarker)) {
              errors.push(`${loc}: gap "${g.cellMarker}" doesn't match any cell in table.rows.`);
            }
          });
        }
        // Each gap needs its own answer for grading — grader.js reads
        // gap.answer per gap, not a single answer on the question itself.
        q.gaps.forEach((g, gi) => {
          if (!g.id) errors.push(`${loc}.gaps[${gi}]: missing id.`);
          if (g.n === undefined) errors.push(`${loc}.gaps[${gi}]: missing numeric n (question number).`);
          if (g.answer === undefined) errors.push(`${loc}.gaps[${gi}] (n=${g.n}): missing answer — needed for auto-grading.`);
        });
      }
      break;
    case "map":
      if (!q.imageUrl) errors.push(`${loc}: map needs an imageUrl.`);
      if (!Array.isArray(q.points) || q.points.length === 0) {
        errors.push(`${loc}: map needs a non-empty points[] array.`);
      } else {
        // Each point needs its own answer for grading — grader.js reads
        // point.answer per pin, not a single answer on the question itself.
        q.points.forEach((pt, pi) => {
          if (!pt.id) errors.push(`${loc}.points[${pi}]: missing id.`);
          if (pt.n === undefined) errors.push(`${loc}.points[${pi}]: missing numeric n (question number).`);
          if (pt.x === undefined || pt.y === undefined) errors.push(`${loc}.points[${pi}] (n=${pt.n}): needs x and y (0-100, % position on the image).`);
          if (pt.answer === undefined) errors.push(`${loc}.points[${pi}] (n=${pt.n}): missing answer — needed for auto-grading.`);
        });
      }
      break;
  }
}

module.exports = { validateExam };