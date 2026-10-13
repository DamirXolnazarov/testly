/**
 * paperImporter.js
 * Digitises an uploaded exam paper (a PDF) into a draft exam: a model reads
 * the PDF (pdfReader.js) and transcribes it into the same JSON an upload or
 * an AI build produces, which then goes through the same validator.
 *
 * Two passes over the paper:
 *   1. An outline — is it IELTS or SAT, what is it called, and which units
 *      does it contain (each reading passage, listening part, writing task
 *      or SAT module), with their question numbers and pages.
 *   2. One request per unit that transcribes that unit's text and questions
 *      and looks each answer up in the paper's answer key.
 *
 * What a transcription cannot carry is said out loud rather than papered
 * over, as warnings on the job: questions that depend on a figure (the
 * teacher adds the image in the test editor), listening parts (a paper has
 * no audio), and answers the model had to work out because the paper has
 * no key. Every imported exam is a draft for a teacher to check against
 * the original.
 *
 * Runs as a background job through examBuilder's job plumbing, so the
 * studio shows it in the same progress panel as a build.
 */

const store = require("./store");
const builder = require("./examBuilder");
const generator = require("./examGenerator");
const { readPdfJson } = require("./pdfReader");
const { validateExam } = require("./examValidator");
const { isProviderError, describeError } = require("./aiProvider");

const MAX_ATTEMPTS = 2;
const CONCURRENT_UNITS = 2; // each request uploads the whole PDF; be gentle with rate limits
const SECTION_NAMES = { reading: "Reading", listening: "Listening", writing: "Writing", "reading-writing": "Reading and Writing", math: "Math" };
const IELTS_SECTIONS = ["reading", "listening", "writing"];
const SAT_SECTIONS = ["reading-writing", "math"];

const SYSTEM =
  "You digitise printed exam papers for a test centre. You transcribe exactly what is printed — every word, number " +
  "and option, in order, without correcting, shortening or improving anything — into the JSON shape you are given. " +
  "Respond with ONLY a single valid JSON object.";

const ANSWER_RULE =
  `Take each answer from the paper's answer key and set "answersFrom" to "key". Only if the paper has no answer key ` +
  `for these questions, work each answer out carefully yourself and set "answersFrom" to "worked-out".`;

// ---------------------------------------------------------------------------
// Pass 1 — outline
// ---------------------------------------------------------------------------

async function readOutline(pdf) {
  const outline = await readPdfJson({
    pdf,
    system: SYSTEM,
    prompt: `Look through this whole document and describe what exam paper it is. Return this JSON shape:

{
  "testType": "sat" | "ielts" | "other",
  "title": "the paper's name as printed, or a short description if it has none",
  "units": [
    {
      "section": "reading-writing" | "math" | "reading" | "listening" | "writing",
      "label": "what the paper calls it, e.g. 'Reading and Writing, Module 1' or 'Reading Passage 2'",
      "role": "module1" | "module2" | "module2-easy" | "module2-hard" | null,
      "firstQuestion": 1,
      "lastQuestion": 27,
      "pages": "3-14"
    }
  ]
}

A unit is one SAT module, one IELTS reading passage with its questions, one IELTS listening part (or section), or one IELTS writing task. List every unit in the order it appears. "role" is for SAT modules only: "module1" for a first module, "module2" for a second module, or "module2-easy" / "module2-hard" if the paper prints both versions of a second module; null for everything else. For a writing task use 0 for both question numbers. Use "other" for "testType" if this is not a digital SAT or an IELTS paper.`,
  });

  const allowed = outline?.testType === "sat" ? SAT_SECTIONS : IELTS_SECTIONS;
  if (!["sat", "ielts"].includes(outline?.testType)) {
    throw new Error("This doesn't look like an IELTS or a digital SAT paper, which are the two kinds the studio can digitise.");
  }
  const units = (Array.isArray(outline.units) ? outline.units : []).filter((u) => allowed.includes(u?.section));
  if (units.length === 0) throw new Error("No reading, listening, writing or SAT module could be found in this PDF.");
  return { testType: outline.testType, title: String(outline.title || "").trim().slice(0, 120), units };
}

// ---------------------------------------------------------------------------
// Pass 2 — one unit at a time
// ---------------------------------------------------------------------------

/** Reads one unit, re-asking once with the problems listed when the result
 * doesn't pass its checks. */
async function readUnit({ pdf, label, prompt, check }) {
  let errors = [];
  let currentPrompt = prompt;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const value = await readPdfJson({ pdf, system: SYSTEM, prompt: currentPrompt });
      errors = check(value);
      if (errors.length === 0) return value;
    } catch (e) {
      if (isProviderError(e)) throw e;
      errors = [e.message];
    }
    currentPrompt =
      `${prompt}\n\n---\nYour previous attempt had these problems:\n${errors.slice(0, 20).map((e) => `- ${e}`).join("\n")}\n\n` +
      `Return the complete corrected JSON object.`;
  }
  throw new Error(`${label} couldn't be digitised cleanly: ${errors.slice(0, 3).join("; ")}`);
}

function where(unit) {
  const range = unit.lastQuestion ? `, questions ${unit.firstQuestion}-${unit.lastQuestion}` : "";
  return `"${unit.label}"${range}${unit.pages ? ` (around page ${unit.pages})` : ""}`;
}

function expectedCount(unit) {
  const count = Number(unit.lastQuestion) - Number(unit.firstQuestion) + 1;
  return Number.isInteger(count) && count > 0 ? count : null;
}

async function readSatModule(pdf, unit) {
  const math = unit.section === "math";
  const count = expectedCount(unit);
  const value = await readUnit({
    pdf,
    label: unit.label,
    prompt: `Transcribe one module of this digital SAT paper: ${where(unit)}.

Return this JSON shape, with every question of the module in order:

{
  "answersFrom": "key" | "worked-out",
  "questions": [
    { "n": 1, "type": "mcq", ${math ? "" : `"passage": "the text printed with the question", `}"prompt": "the question", "options": ["first option", "second", "third", "fourth"], "answerLetter": "B", "needsFigure": false, "figureNote": "" }${math ? `,
    { "n": 2, "type": "grid-in", "prompt": "the question", "answer": "7/2", "needsFigure": false, "figureNote": "" }` : ""}
  ]
}

- Options go in the printed order, without their A/B/C/D letters. "answerLetter" is the letter of the correct option.
- Leave out anything that is not part of the question itself: page headers and footers, "enter your answer" boxes, directions repeated on every page.
${math ? `- A question with no options (a student-produced response) is "grid-in"; its "answer" is one number as a string — an integer, a decimal or a fraction such as "12", "-3", ".75" or "7/2". If the key lists several accepted forms, give one.
- Write mathematics as plain text that reads unambiguously: x^2, sqrt(x), (3x + 1)/(x - 2), <=, >=, pi. Keep every number and symbol exactly as printed.
` : `- "passage" is everything the student reads before the question: the text, a pair of texts, or the bulleted notes. Keep its line breaks. Show a blank to be filled as ______.
`}- A table printed with a question is written out as plain text rows inside ${math ? `"prompt"` : `"passage"`}.
- If a question depends on a graph, diagram or picture that plain text cannot carry, set "needsFigure" to true and describe in "figureNote" exactly what the figure shows, so someone can find it in the original. Otherwise false and "".
- ${ANSWER_RULE}

${count ? `There should be ${count} questions.` : ""}`,
    check: (v) => {
      const questions = Array.isArray(v?.questions) ? v.questions : [];
      if (questions.length === 0) return ["No questions were returned."];
      const errors = count && questions.length !== count ? [`${count} questions were expected; ${questions.length} were returned.`] : [];
      questions.forEach((q, i) => {
        const at = `Question ${q?.n ?? i + 1}`;
        if (!q?.prompt) errors.push(`${at}: the question text is missing.`);
        if (q?.type === "mcq") {
          if (!Array.isArray(q.options) || q.options.length !== 4) errors.push(`${at}: needs its four options.`);
          else if (new Set(q.options).size !== 4) errors.push(`${at}: the four options must be different.`);
          if (!/^[A-D]$/.test(String(q.answerLetter || "").trim().toUpperCase())) errors.push(`${at}: "answerLetter" must be A, B, C or D.`);
        } else if (q?.type === "grid-in") {
          if (typeof q.answer !== "string" || !/^-?(\d+\/\d+|\d*\.?\d+)$/.test(q.answer.trim())) errors.push(`${at}: grid-in "answer" must be one number as a string, e.g. "12", ".75" or "7/2".`);
        } else errors.push(`${at}: "type" must be "mcq" or "grid-in".`);
        if (!math && q?.type !== "mcq") errors.push(`${at}: Reading and Writing questions are all multiple choice.`);
      });
      return errors;
    },
  });

  return {
    answersFrom: value.answersFrom,
    figures: value.questions.filter((q) => q.needsFigure).map((q, i) => q.n ?? i + 1),
    questions: value.questions.map((q) => {
      const question = { type: q.type, prompt: String(q.prompt).trim() };
      if (!math) question.passage = String(q.passage || "").trim();
      if (q.type === "mcq") {
        question.options = q.options.map((o) => String(o).trim());
        question.answer = question.options["ABCD".indexOf(String(q.answerLetter).trim().toUpperCase())];
      } else {
        question.answer = q.answer.trim();
      }
      if (q.needsFigure) question.figureNote = String(q.figureNote || "A figure printed with this question.").trim();
      return question;
    }),
  };
}

async function readReadingPart(pdf, unit) {
  const types = ["tfng", "tfng-yes-no", "mcq", "gap-fill", "matching", "table"];
  const part = await readUnit({
    pdf,
    label: unit.label,
    prompt: `Transcribe one reading passage of this IELTS paper with its questions: ${where(unit)}.

Return this JSON shape:

{
  "answersFrom": "key" | "worked-out",
  "title": "the passage's heading as printed, e.g. READING PASSAGE 1",
  "passage": ["the article's title", "first paragraph", "second paragraph"],
  "instructionsTitle": "e.g. Questions 1-13",
  "instructions": "one sentence saying which questions use which task",
  "questions": [ ... ]
}

"passage" holds the title and then each paragraph as its own string, word for word. If the paragraphs are lettered, start each with its letter and two spaces ("A  The first…").

Each question becomes one of these objects — they are the only task types the test interface can show, so fit every printed task to the closest one:

${types.map((t) => `- ${generator.READING_TASK_SHAPES[t]}`).join("\n")}

Sentence, summary, note, flow-chart and short-answer tasks are all "gap-fill". Keep the paper's own question numbers in "n". Put the heading and the rubric printed above each group of questions on the first question of the group as "groupTitle" and "groupInstructions". If a task relies on a diagram that text cannot carry, say so in that group's "groupInstructions".

${ANSWER_RULE} Give a gap-fill answer as an array when the key accepts more than one form.`,
    check: (p) => {
      const errors = generator.validatorErrors({ type: "reading", parts: [{ id: "check", ...p }] }, "ielts");
      if (errors.length) return errors;
      const count = expectedCount(unit);
      const got = generator.readingNumbers(p).length;
      return count && got !== count ? [`${count} questions were expected (${unit.firstQuestion}-${unit.lastQuestion}); ${got} were returned.`] : [];
    },
  });
  const { answersFrom, ...rest } = part;
  return { answersFrom, part: rest };
}

async function readListeningPart(pdf, unit) {
  const part = await readUnit({
    pdf,
    label: unit.label,
    prompt: `Transcribe the questions of one listening part of this IELTS paper: ${where(unit)}.

Return this JSON shape:

{
  "answersFrom": "key" | "worked-out",
  "title": "e.g. Part 1 — and the topic if the paper names one",
  "instructions": "the rubric printed above the questions",
  "transcript": "the recording's script, only if the paper prints one; otherwise an empty string",
  "items": [
    {
      "label": "the heading of this group of notes or questions",
      "lines": [
        { "pre": "text before the blank", "n": 1, "post": "text after the blank", "answer": "the answer" },
        { "pre": "-", "text": "a printed line that has no blank" }
      ]
    }
  ]
}

The test interface shows listening questions as lines with a blank to type into, so every question becomes a line with "n" (the paper's question number) and "answer". For a multiple-choice or matching question, put the question in "pre", list each option as its own line with no "n" ({ "pre": "A", "text": "the option" }), and make "answer" the correct letter. "answer" is a string, or an array when the key accepts more than one form.

${ANSWER_RULE}`,
    check: (p) => {
      const errors = generator.validatorErrors({ type: "listening", parts: [{ id: "check", ...p }] }, "ielts");
      if (errors.length) return errors;
      const count = expectedCount(unit);
      const got = generator.listeningNumbers(p).length;
      return count && got !== count ? [`${count} questions were expected (${unit.firstQuestion}-${unit.lastQuestion}); ${got} were returned.`] : [];
    },
  });
  const { answersFrom, ...rest } = part;
  return { answersFrom, part: { ...rest, transcript: String(rest.transcript || ""), audioUrl: null } };
}

async function readWritingTask(pdf, unit) {
  const task = await readUnit({
    pdf,
    label: unit.label,
    prompt: `Transcribe one writing task of this IELTS paper: ${where(unit)}.

Return this JSON shape:

{
  "instructions": "the timing and length lines, e.g. You should spend about 20 minutes on this task. Write at least 150 words.",
  "prompt": "the task itself, word for word",
  "minWords": 150,
  "needsFigure": true,
  "figureNote": "what the chart, graph, table or diagram printed with the task shows"
}

If the task comes with a table, write its figures out as plain text rows at the end of "prompt" and set "needsFigure" to false. Set "needsFigure" to true only for a chart, graph, map or diagram.`,
    check: (t) => (t?.prompt && t?.instructions ? [] : ["The task needs both its instructions and its prompt."]),
  });
  return {
    figure: task.needsFigure ? String(task.figureNote || "a chart or diagram") : null,
    part: { instructions: String(task.instructions).trim(), prompt: String(task.prompt).trim(), minWords: Number(task.minWords) || undefined },
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function assembleSat(units, results, job) {
  const sections = [];
  for (const type of SAT_SECTIONS) {
    const mine = units.map((u, i) => ({ unit: u, result: results[i] })).filter((x) => x.unit.section === type);
    if (mine.length === 0) continue;
    const byRole = (role) => mine.find((x) => x.unit.role === role);
    const first = byRole("module1") || mine[0];
    const second = byRole("module2") || mine.find((x) => x !== first && !String(x.unit.role || "").startsWith("module2-"));
    const easy = byRole("module2-easy") || second || first;
    const hard = byRole("module2-hard") || second || first;
    const name = SECTION_NAMES[type];
    if (easy === hard) {
      job.warnings.push(
        easy === first
          ? `${name}: the paper has only one module, so it is used for Module 1 and for both versions of Module 2.`
          : `${name}: the paper has one Module 2, so it is used for both the easier and the harder version.`
      );
    }
    const prefix = type === "math" ? "math" : "rw";
    const shape = (source, id, stage, difficulty) => ({
      id,
      stage,
      ...(difficulty ? { difficulty } : {}),
      durationMinutes: generator.SAT_SPEC[type].durationMinutes,
      questions: source.result.questions.map((q, i) => ({ ...q, id: `${id}-q${i + 1}`, n: i + 1 })),
    });
    sections.push({
      type,
      modules: [shape(first, `${prefix}-m1`, "module1"), shape(easy, `${prefix}-m2-easy`, "module2", "easy"), shape(hard, `${prefix}-m2-hard`, "module2", "hard")],
    });
  }
  return sections;
}

function assembleIelts(units, results, job) {
  const of = (type) => units.map((u, i) => ({ unit: u, result: results[i] })).filter((x) => x.unit.section === type);
  const sections = [];

  const reading = of("reading");
  if (reading.length) {
    const parts = reading.map(({ result }, i) => {
      const part = { id: `r-part${i + 1}`, ...result.part };
      generator.assignReadingIds(part, i);
      return part;
    });
    sections.push({ type: "reading", durationMinutes: reading.length >= 3 ? 60 : 20 * reading.length, parts });
  }

  const listening = of("listening");
  if (listening.length) {
    sections.push({
      type: "listening",
      durationMinutes: listening.length >= 4 ? 30 : Math.max(8, Math.round((30 * listening.length) / 4)),
      parts: listening.map(({ result }, i) => ({ id: `l-part${i + 1}`, ...result.part })),
    });
    job.warnings.push("Listening has no audio — a paper can't carry the recording. Upload it in the test editor before starting the test.");
  }

  const writing = of("writing");
  if (writing.length) {
    sections.push({
      type: "writing",
      durationMinutes: 60,
      parts: writing.map(({ result }, i) => ({ id: `w-task${i + 1}`, ...result.part, minWords: result.part.minWords || (i === 0 ? 150 : 250) })),
    });
    writing.forEach(({ result }, i) => {
      if (result.figure) job.warnings.push(`Writing Task ${i + 1} needs its image (${result.figure}). Add it in the test editor.`);
    });
  }
  return sections;
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

/**
 * Creates a placeholder exam and starts digitising the PDF in the background.
 * @param {Object} opts
 * @param {Buffer} opts.pdf
 * @param {string} opts.fileName
 * @param {string} opts.centerId
 * @returns {Promise<{ exam: Object, job: Object }>}
 */
async function startImport({ pdf, fileName, centerId }) {
  const baseName = String(fileName || "Imported paper").replace(/\.pdf$/i, "").slice(0, 100) || "Imported paper";
  const exam = await store.createExam({ title: baseName, sections: [], status: "generating", centerId });
  // The units aren't known until the paper has been read, so the job starts
  // with two steps and grows once the outline is in.
  const job = builder.createJob(exam.examId, "import", baseName, [
    { id: "outline", group: "Read", label: "Find out what the paper contains", hint: fileName || "" },
    { id: "assemble", group: "Finish", label: "Final check and save", hint: "" },
  ]);

  (async () => {
    try {
      const outline = await builder.runStep(job, "outline", () => readOutline(pdf));
      const unitSteps = outline.units.map((unit, i) => {
        const group = SECTION_NAMES[unit.section];
        // Papers usually print "Math — Module 1"; the group already says "Math".
        const label = String(unit.label || `Part ${i + 1}`).replace(new RegExp(`^${group}\\s*[—–:,-]*\\s*`, "i"), "") || group;
        return { id: `unit-${i}`, group, label, hint: "", status: "pending", detail: "" };
      });
      job.steps.splice(1, 0, ...unitSteps);
      job.title = outline.title || baseName;

      const results = new Array(outline.units.length);
      let next = 0;
      let failure = null;
      const worker = async () => {
        while (next < outline.units.length && !failure) {
          const i = next++;
          const unit = outline.units[i];
          try {
            results[i] = await builder.runStep(job, `unit-${i}`, (progress) => {
              progress("Transcribing");
              if (SAT_SECTIONS.includes(unit.section)) return readSatModule(pdf, unit);
              if (unit.section === "reading") return readReadingPart(pdf, unit);
              if (unit.section === "listening") return readListeningPart(pdf, unit);
              return readWritingTask(pdf, unit);
            });
          } catch (e) {
            failure = e;
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENT_UNITS }, worker));
      if (failure) throw failure;

      await builder.runStep(job, "assemble", async () => {
        outline.units.forEach((unit, i) => {
          if (results[i].figures?.length) {
            job.warnings.push(`${unit.label}: question${results[i].figures.length > 1 ? "s" : ""} ${results[i].figures.join(", ")} need${results[i].figures.length > 1 ? "" : "s"} a figure from the original. Add the image${results[i].figures.length > 1 ? "s" : ""} in the test editor.`);
          }
          if (results[i].answersFrom === "worked-out") {
            job.warnings.push(`${unit.label}: no answer key was found in the PDF, so the answers were worked out by AI. Check them.`);
          }
        });
        const sections = outline.testType === "sat" ? assembleSat(outline.units, results, job) : assembleIelts(outline.units, results, job);
        const title = outline.title || baseName;
        const { valid, errors } = validateExam({ title, testType: outline.testType, sections });
        if (!valid) throw new Error(`The digitised paper failed validation: ${errors.slice(0, 4).join("; ")}`);
        const saved = await store.updateExam(exam.examId, { title, testType: outline.testType, sections, status: "draft", generationError: null });
        if (!saved) throw new Error("The digitised paper couldn't be saved.");
      });
      job.notes.push("Digitised from the PDF as printed. Check it against the original before students sit it.");
      builder.finishJob(job, null);
    } catch (e) {
      console.error(`Paper import failed for ${exam.examId}`, e);
      const message = describeError(e);
      builder.finishJob(job, message);
      await store.updateExam(exam.examId, { status: "generation_failed", generationError: message }).catch(() => {});
    }
  })();

  return { exam, job };
}

module.exports = { startImport };
