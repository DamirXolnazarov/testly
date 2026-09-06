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
    // Question numbers must be unique across the WHOLE section, not just
    // within one part — real IELTS numbering is continuous across parts
    // (e.g. Passage 1 is 1-13, Passage 2 continues at 14-26), and a
    // student's answers for a section are stored in one flat object keyed
    // purely by `n` (see ListeningModule/ReadingModule's `answers` state
    // and grader.js's buildAnswerKey). Two parts accidentally reusing the
    // same n wouldn't just be a cosmetic numbering mistake — they'd
    // silently share the same answer input and the same grading key,
    // corrupting both without either part failing on its own. This set is
    // shared across every part() call below for the section.
    const seenN = new Set();
    section.parts.forEach((part, pi) => validatePart(part, `${loc}.parts[${pi}]`, section.type, errors, seenN));
  });

  return { valid: errors.length === 0, errors };
}

/** Records `n` in the section-wide seenN set, pushing a duplicate error
 * (with the given location) if it's already been used anywhere else in
 * this section — including in a different part, and including nested
 * gaps[]/points[] numbers, not just a question's own top-level `n`. */
function checkDuplicateN(n, loc, errors, seenN) {
  if (n === undefined) return;
  if (seenN.has(n)) errors.push(`${loc}: duplicate question number ${n} elsewhere in this section.`);
  seenN.add(n);
}

function validatePart(part, loc, sectionType, errors, seenN) {
  if (!part.id) errors.push(`${loc}: missing id.`);

  if (sectionType === "reading") {
    if (!part.title) errors.push(`${loc}: reading part needs a title.`);
    if (!Array.isArray(part.passage) || part.passage.length === 0) {
      errors.push(`${loc}: reading part needs a non-empty passage[] array of paragraphs.`);
    }
    if (!Array.isArray(part.questions) || part.questions.length === 0) {
      errors.push(`${loc}: reading part needs a non-empty questions[] array.`);
    } else {
      part.questions.forEach((q, qi) => {
        validateQuestion(q, `${loc}.questions[${qi}]`, errors, seenN);
      });
    }
  }

  if (sectionType === "listening") {
    if (!part.title) errors.push(`${loc}: listening part needs a title.`);
    if (!Array.isArray(part.items) || part.items.length === 0) {
      errors.push(`${loc}: listening part needs a non-empty items[] array.`);
    } else {
      part.items.forEach((item, ii) => {
        if (!Array.isArray(item.lines)) {
          errors.push(`${loc}.items[${ii}]: needs a lines[] array.`);
          return;
        }
        // "Choose TWO/THREE letters, in either order" — see grader.js's
        // applyUnorderedGroups. The lines for these question numbers are
        // still required (they're what renders the input boxes) but don't
        // need their own `answer` — the group's `answers` set covers them.
        const group = item.unorderedGroup;
        if (group) {
          if (!Array.isArray(group.ns) || group.ns.length < 2) {
            errors.push(`${loc}.items[${ii}].unorderedGroup: needs an ns[] array with at least 2 question numbers.`);
          }
          if (!Array.isArray(group.answers) || group.answers.length !== (group.ns || []).length) {
            errors.push(`${loc}.items[${ii}].unorderedGroup: answers[] must be the same length as ns[].`);
          }
          const lineNs = new Set((item.lines || []).map((l) => l.n).filter((n) => n !== undefined));
          (group.ns || []).forEach((n) => {
            if (!lineNs.has(n)) errors.push(`${loc}.items[${ii}].unorderedGroup: n=${n} doesn't match any line in this item.`);
          });
        }
        item.lines.forEach((line, li) => {
          if (line.n === undefined) return; // static text lines (no blank) are fine without n
          checkDuplicateN(line.n, `${loc}.items[${ii}].lines[${li}]`, errors, seenN);
          if (group && group.ns && group.ns.includes(line.n)) return; // covered by the group's answers[] instead
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
    // Optional — a Task 1 prompt describing a chart/graph/table can attach
    // a real image (matched via zip upload same as map questions); Task 2
    // essay prompts simply never set this.
    if (part.chartImageUrl !== undefined && part.chartImageUrl !== null && typeof part.chartImageUrl !== "string") {
      errors.push(`${loc}: chartImageUrl must be a string URL if present.`);
    }
  }
}

function validateQuestion(q, loc, errors, seenN) {
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
  // table/map have their own nested per-gap/per-point numbers (checked in
  // their case blocks below) which are what actually appears as separate
  // numbered questions to the student — checking q.n here too would be
  // redundant at best and wrong at worst for a multi-gap/multi-point
  // question, where q.n is just a display label, not a real answer slot.
  if (!["table", "map"].includes(q.type)) {
    checkDuplicateN(q.n, loc, errors, seenN);
  }

  switch (q.type) {
    case "mcq":
      if (!Array.isArray(q.options) || q.options.length < 2) errors.push(`${loc}: mcq needs options[] with at least 2 choices.`);
      if (!q.prompt) errors.push(`${loc}: mcq needs a prompt.`);
      break;
    case "tfng": {
      if (!q.prompt) errors.push(`${loc}: tfng needs a prompt.`);
      // variant: "yes-no" is for writer's-views questions (Yes/No/Not Given);
      // default is factual True/False/Not Given. Both grade identically —
      // see the matching comment in IELTSCDReplica.jsx's QuestionRenderer.
      const allowed = q.variant === "yes-no" ? ["YES", "NO", "NOT GIVEN"] : ["TRUE", "FALSE", "NOT GIVEN"];
      if (q.answer !== undefined && !allowed.includes(q.answer)) {
        errors.push(`${loc}: tfng answer must be one of ${allowed.join(", ")} (got "${q.answer}")${q.variant ? ` for variant "${q.variant}"` : ""}.`);
      }
      break;
    }
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
          checkDuplicateN(g.n, `${loc}.gaps[${gi}]`, errors, seenN);
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
          checkDuplicateN(pt.n, `${loc}.points[${pi}]`, errors, seenN);
          if (pt.x === undefined || pt.y === undefined) errors.push(`${loc}.points[${pi}] (n=${pt.n}): needs x and y (0-100, % position on the image).`);
          if (pt.answer === undefined) errors.push(`${loc}.points[${pi}] (n=${pt.n}): missing answer — needed for auto-grading.`);
        });
      }
      break;
  }
}

module.exports = { validateExam };