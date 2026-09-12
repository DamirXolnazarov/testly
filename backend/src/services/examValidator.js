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

const QUESTION_TYPES = ["mcq", "tfng", "gap-fill", "matching", "table", "map", "grid-in"];
const SECTION_TYPES = ["reading", "listening", "writing", "reading-writing", "math"];
// SAT-only section types — these use `modules` (module1 + two module2
// variants) instead of `parts`, since the digital SAT is module-adaptive.
// See satScoring.js for the routing/scoring logic this structure supports.
const SAT_SECTION_TYPES = ["reading-writing", "math"];

/** @returns {{ valid: boolean, errors: string[] }} */
function validateExam(exam) {
  const errors = [];

  if (!exam || typeof exam !== "object") {
    return { valid: false, errors: ["Exam must be a JSON object."] };
  }
  if (!exam.title || typeof exam.title !== "string") {
    errors.push("Missing or invalid `title` (string).");
  }
  // testType defaults to "ielts" for backward compatibility with every
  // exam created before SAT support existed — those never set this field.
  const testType = exam.testType || "ielts";
  if (!["ielts", "sat"].includes(testType)) {
    errors.push(`Invalid testType "${testType}" — must be "ielts" or "sat" (or omitted, which defaults to "ielts").`);
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
    if (SAT_SECTION_TYPES.includes(section.type) && testType !== "sat") {
      errors.push(`${loc}: type "${section.type}" is SAT-only — exam.testType must be "sat" to use it.`);
    }
    if (!SAT_SECTION_TYPES.includes(section.type) && testType === "sat") {
      errors.push(`${loc}: type "${section.type}" isn't valid for an SAT exam (testType: "sat") — use "reading-writing" or "math".`);
    }
    if (SAT_SECTION_TYPES.includes(section.type)) {
      validateSatSection(section, loc, errors);
      return; // SAT sections are validated entirely separately below — different shape (modules, not parts)
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

/**
 * Validates a SAT reading-writing/math section: `modules` instead of
 * `parts`, exactly one Module 1 and exactly one each of the two Module 2
 * difficulty variants, plus an optional `routing` threshold. See
 * satScoring.js for how this structure is actually used to route students
 * and compute a scaled score.
 */
function validateSatSection(section, loc, errors) {
  if (!Array.isArray(section.modules) || section.modules.length === 0) {
    errors.push(`${loc}: SAT section needs a non-empty modules[] array.`);
    return;
  }
  if (section.routing !== undefined) {
    if (typeof section.routing !== "object" || section.routing === null) {
      errors.push(`${loc}.routing: must be an object if present, e.g. { "threshold": 0.6 }.`);
    } else if (section.routing.threshold !== undefined) {
      const t = section.routing.threshold;
      if (typeof t !== "number" || t < 0 || t > 1) {
        errors.push(`${loc}.routing.threshold: must be a number between 0 and 1 (fraction of Module 1 correct required to route to the harder Module 2).`);
      }
    }
  }

  const module1s = section.modules.filter((m) => m.stage === "module1");
  const module2Easy = section.modules.filter((m) => m.stage === "module2" && m.difficulty === "easy");
  const module2Hard = section.modules.filter((m) => m.stage === "module2" && m.difficulty === "hard");
  if (module1s.length !== 1) {
    errors.push(`${loc}: needs exactly one module with stage:"module1" (found ${module1s.length}).`);
  }
  if (module2Easy.length !== 1) {
    errors.push(`${loc}: needs exactly one module with stage:"module2", difficulty:"easy" (found ${module2Easy.length}).`);
  }
  if (module2Hard.length !== 1) {
    errors.push(`${loc}: needs exactly one module with stage:"module2", difficulty:"hard" (found ${module2Hard.length}).`);
  }
  const otherModules = section.modules.filter((m) => {
    if (m.stage === "module1") return false;
    if (m.stage === "module2" && (m.difficulty === "easy" || m.difficulty === "hard")) return false;
    return true;
  });
  otherModules.forEach((m, i) => {
    errors.push(`${loc}.modules: every module needs stage:"module1", or stage:"module2" with difficulty:"easy"/"hard" (module at index ${section.modules.indexOf(m)} has stage="${m.stage}", difficulty="${m.difficulty}").`);
  });

  // Question numbers only need to be unique WITHIN each module here, not
  // across the whole section — unlike IELTS, a student only ever sees
  // Module 1 plus exactly ONE Module 2 variant, never both, so the easy and
  // hard Module 2 are free to reuse the same question numbers (they're
  // mutually exclusive content, e.g. both could have questions 28-54).
  section.modules.forEach((mod, mi) => {
    const modLoc = `${loc}.modules[${mi}]`;
    if (!mod.id) errors.push(`${modLoc}: missing id.`);
    if (!Array.isArray(mod.questions) || mod.questions.length === 0) {
      errors.push(`${modLoc}: needs a non-empty questions[] array.`);
      return;
    }
    const seenN = new Set();
    mod.questions.forEach((q, qi) => validateQuestion(q, `${modLoc}.questions[${qi}]`, errors, seenN));
  });
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
  const autoGradable = ["mcq", "tfng", "gap-fill", "grid-in"];
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
    case "grid-in":
      // SAT Math "student-produced response" — a numeric answer typed into
      // a small grid, no options. answer is a string (satAnswerMatch.js
      // handles numeric/fraction/decimal equivalence at grading time, e.g.
      // "3/4" == ".75" == "0.75"); prompt is required same as any question.
      if (!q.prompt) errors.push(`${loc}: grid-in needs a prompt.`);
      if (q.answer !== undefined && typeof q.answer !== "string") {
        errors.push(`${loc}: grid-in answer must be a string (e.g. "3/4" or "12").`);
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