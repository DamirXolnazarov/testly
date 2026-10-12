/**
 * examGenerator.js
 * Writes exam content with an LLM (via llmClient.js), one self-contained
 * unit at a time: a single IELTS reading passage, a single listening part,
 * the writing tasks, or a single SAT module. examBuilder.js decides which
 * units an exam needs, runs them in parallel, and assembles the result.
 *
 * Units are small on purpose. A whole 40-question section in one request
 * is slow, gives the admin nothing to watch while it runs, and has to be
 * thrown away entirely when one question is malformed; a passage-sized unit
 * can be checked, repaired, or rewritten on its own.
 *
 * Every unit goes through the same loop (writeChecked):
 *   1. Ask the model for JSON in the exact shape docs/exam-json-schema.md
 *      describes.
 *   2. Check it — examValidator.validateExam() (the same check a
 *      human-authored exam gets) plus the unit's own checks for things the
 *      validator can't know: the right question numbers, an mcq answer that
 *      is actually one of its options, a passage that is long enough.
 *   3. If anything fails, ask again with the exact error list so the model
 *      repairs its own mistakes. Throws after MAX_ATTEMPTS — an exam with a
 *      broken answer key is a bug, not a soft failure.
 *
 * Reading passages and SAT modules then get an answer-key check
 * (checkAnswerKey): the model answers the questions without seeing the key,
 * and any question where it disagrees with the key is sent back to be
 * fixed. A disagreement usually means the question is ambiguous or the key
 * is wrong, which is the failure that matters most in a mock exam.
 */

const { generateJson } = require("./llmClient");
const { Anthropic } = require("./claudeClient");
const { validateExam } = require("./examValidator");
const { synthesizeAudio } = require("./ttsService");
const { generateMapImage } = require("./mapImageService");
const { uploadBuffer } = require("./storageService");
const { renderChartSvg } = require("./chartSvg");
const { parseGridInValue, isGridInCorrect } = require("./satAnswerMatch");
const { normalize } = require("./grader");
const crypto = require("crypto");

const MAX_ATTEMPTS = 3; // 1 writing attempt + 2 repair attempts

// How many questions each IELTS reading passage carries (13 + 13 + 14 = 40).
const READING_COUNTS = [13, 13, 14];
const LISTENING_QUESTIONS_PER_PART = 10;

// Digital SAT module sizes and timings.
const SAT_SPEC = {
  "reading-writing": { questions: 27, durationMinutes: 32, label: "Reading and Writing" },
  math: { questions: 22, durationMinutes: 35, label: "Math" },
};

const JSON_ONLY_RULE =
  "Respond with ONLY a single valid JSON object — no markdown fences, no " +
  "commentary before or after. The JSON must be directly parseable by JSON.parse().";

/** Map questions need an image model; without one the writer is simply not offered that type. */
function imagesAvailable() {
  return !!process.env.OPENAI_API_KEY;
}

function audioAvailable() {
  return !!process.env.ELEVENLABS_API_KEY && !!process.env.ELEVENLABS_VOICE_ID_DEFAULT;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Calls the model, runs `check` on the result, and retries with the error
 * list appended when the check fails. `postProcess` runs before the check
 * (e.g. turning map point labels into a real image + coordinates, which the
 * validator requires).
 * @param {Object} opts
 * @param {string} opts.label - names the unit in error messages
 * @param {(value: any) => string[]} opts.check - returns problems, empty when fine
 */
async function writeChecked({ label, system, prompt, check, postProcess, maxTokens, effort }) {
  let errors = [];
  let currentPrompt = prompt;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const value = await generateJson({ system, prompt: currentPrompt, maxTokens, effort });
      if (postProcess) await postProcess(value);
      errors = check(value);
      if (errors.length === 0) return value;
    } catch (e) {
      // A rejected key or a rate limit won't be fixed by asking again with
      // a repair prompt — surface it as it is.
      if (e instanceof Anthropic.APIError) throw e;
      errors = [`generation error: ${e.message}`];
    }

    currentPrompt =
      `${prompt}\n\n---\nYour previous attempt had these exact problems:\n` +
      `${errors.slice(0, 25).map((e) => `- ${e}`).join("\n")}\n\n` +
      `Return a corrected, complete JSON object that fixes every one of them. ` +
      `Output the full JSON again, not a diff.`;
  }

  throw new Error(`${label} failed its checks after ${MAX_ATTEMPTS} attempts: ${errors.slice(0, 4).join("; ")}`);
}

/** Runs one section through the same validator a hand-written exam gets. */
function validatorErrors(section, testType) {
  const { errors } = validateExam({ title: "generation-check", testType, sections: [section] });
  return errors;
}

function wordCount(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function ieltsLevel(difficulty) {
  if (difficulty === "easy") return "easier than a typical paper, pitched at candidates around band 4.5-5.5";
  if (difficulty === "hard") return "demanding, pitched at candidates around band 7-8";
  return "typical of a real paper, pitched at candidates around band 6-6.5";
}

function notesBlock(notes) {
  return notes && notes.trim() ? `\nThe test moderator also asked for this — follow it:\n${notes.trim()}\n` : "";
}

// ---------------------------------------------------------------------------
// IELTS Reading — one passage per call
// ---------------------------------------------------------------------------

// Which task types each passage position leans on, so three independently
// written passages still add up to a paper with the variety of a real one.
const READING_TASK_PLANS = [
  ["tfng", "gap-fill", "table"],
  ["matching", "mcq", "gap-fill"],
  ["mcq", "tfng-yes-no", "matching", "gap-fill"],
];

const READING_TASK_SHAPES = {
  tfng:
    `"tfng" — factual statements: { "id", "n", "type": "tfng", "prompt", "answer": "TRUE" | "FALSE" | "NOT GIVEN" }. ` +
    `Use all three answers across the group; a NOT GIVEN statement must be on-topic but genuinely unsupported.`,
  "tfng-yes-no":
    `"tfng" with "variant": "yes-no" — the writer's views or claims: { "id", "n", "type": "tfng", "variant": "yes-no", ` +
    `"prompt", "answer": "YES" | "NO" | "NOT GIVEN" }.`,
  mcq:
    `"mcq" — { "id", "n", "type": "mcq", "prompt", "options": [exactly 4 different strings], "answer": the exact text of ` +
    `the correct option }. Exactly one option may be defensible. Do not put letters in front of the option text.`,
  "gap-fill":
    `"gap-fill" — sentence or summary completion: { "id", "n", "type": "gap-fill", "before": text before the blank, ` +
    `"after": text after the blank, "answer": string or array of accepted spellings }. The answer must be words taken ` +
    `from the passage, within the word limit you state in the group instructions (e.g. NO MORE THAN TWO WORDS).`,
  matching:
    `"matching" — matching headings, matching information to paragraphs, matching features, or sentence endings: ` +
    `{ "id", "n", "type": "matching", "prompt", "options": [the shared bank], "answer": the LETTER of the correct ` +
    `option }. Every question in the group repeats the same "options" array in the same order. Letters are A, B, C… ` +
    `in options order, and "answer" is that letter, never the option text. Do not put letters in front of the option ` +
    `text. For matching headings add "optionLetters": ["i","ii","iii",…] to every question and answer with the ` +
    `numeral. Offer more options than questions.`,
  table:
    `"table" — table completion, one question object holding several blanks: { "id", "n": the first blank's number, ` +
    `"type": "table", "table": { "headers": [...], "rows": [[...], ...] }, "gaps": [{ "id", "n", "cellMarker", ` +
    `"answer" }] }. Each blank is a cell whose whole text is a placeholder like "___GAP9___", and that exact string is ` +
    `the gap's "cellMarker". Each gap counts as one question and has its own "n".`,
  map:
    `"map" — diagram labelling, one question object holding several numbered points: { "id", "n": the first point's ` +
    `number, "type": "map", "imageUrl": null, "scene": one sentence describing the diagram to draw, "points": ` +
    `[{ "id", "n", "label": what this marker points at, "answer" }] }. Leave "imageUrl" null and give no coordinates; ` +
    `the image is drawn afterwards. Each point counts as one question. Use at most 4 points.`,
};

/**
 * Writes one reading passage with its questions.
 * @param {Object} opts
 * @param {number} opts.index - 0-based passage position
 * @param {number} opts.startN - first question number
 * @param {number} opts.count - how many questions this passage carries
 * @param {string} [opts.topic]
 * @param {"academic"|"general"} [opts.variant]
 * @returns {Promise<Object>} a reading part
 */
async function writeReadingPart({ index, startN, count, topic, difficulty, variant, notes }) {
  const system =
    `You are an experienced IELTS ${variant === "general" ? "General Training" : "Academic"} Reading item writer. ` +
    `You write original passages and questions to the standard of a published practice paper, and every question ` +
    `you write has exactly one defensible answer that the passage itself settles. ${JSON_ONLY_RULE}`;

  const part = await writeChecked({
    label: `Reading passage ${index + 1}`,
    system,
    prompt: buildReadingPartPrompt({ index, startN, count, topic, difficulty, variant, notes }),
    check: (p) => readingPartErrors(p, startN, count),
    postProcess: async (p) => {
      p.id = `r-part${index + 1}`;
      assignReadingIds(p, index);
      await resolveMapImages(p);
    },
    maxTokens: 32000,
  });
  return part;
}

function buildReadingPartPrompt({ index, startN, count, topic, difficulty, variant, notes }) {
  const endN = startN + count - 1;
  const plan = [...(READING_TASK_PLANS[index] || READING_TASK_PLANS[2])];
  if (index === 1 && imagesAvailable()) plan.push("map");

  const passageBrief =
    variant === "general"
      ? [
          `a set of two or three short everyday texts (notices, advertisements, timetables, leaflets) of 600-750 words in total, as in Section 1 of the General Training paper`,
          `one or two workplace texts (job descriptions, staff guidelines, training materials) of 650-800 words in total, as in Section 2`,
          `one longer general-interest article of 750-900 words, as in Section 3`,
        ][index] || `one general-interest article of 750-900 words`
      : `one original ${["accessible, descriptive", "more detailed, analytical", "the most demanding, argument-driven"][index] || "analytical"} academic article of 750-900 words in 6-8 paragraphs, the kind found in a journal, textbook or serious magazine, written for an educated non-specialist`;

  return `Write Reading Passage ${index + 1} of an IELTS ${variant === "general" ? "General Training" : "Academic"} Reading paper, with questions ${startN}-${endN}.

Topic: ${topic || "choose a fresh, specific subject yourself — not a topic every practice book already uses"}.
Level: ${ieltsLevel(difficulty)}.
${notesBlock(notes)}
The passage: ${passageBrief}. It must be your own writing, factually sound, and must not ask the candidate for outside knowledge. When a task refers to paragraphs by letter, start each paragraph string with its letter and two spaces ("A  The first…").

The questions: exactly ${count}, numbered ${startN} to ${endN} with no gaps, in two to four groups of different task types, following the order of the passage the way a real paper does. Choose the task types from this list — these are the only ones the test interface can show:

${plan.map((type) => `- ${READING_TASK_SHAPES[type]}`).join("\n")}

Return this JSON shape:

{
  "title": "READING PASSAGE ${index + 1}",
  "passage": ["the article's headline", "paragraph…", "paragraph…"],
  "instructionsTitle": "Questions ${startN}-${endN}",
  "instructions": "one or two sentences telling the candidate which questions use which task",
  "questions": [ ... ]
}

Put "groupTitle" (e.g. "Questions ${startN}-${startN + 4}") and "groupInstructions" (the rubric a real paper prints, including any word limit) on the first question of every group. Every question, gap and point needs its "answer". The "id" values are reassigned afterwards, so any unique strings will do.

${JSON_ONLY_RULE}`;
}

/** Deterministic ids: student answers are stored by question id, so two
 * independently written passages must never reuse one. */
function assignReadingIds(part, index) {
  (part.questions || []).forEach((q, qi) => {
    if (q.type === "table") {
      q.id = `r-p${index + 1}-table${qi + 1}`;
      (q.gaps || []).forEach((g) => { g.id = `r${g.n}`; });
    } else if (q.type === "map") {
      q.id = `r-p${index + 1}-map${qi + 1}`;
      (q.points || []).forEach((pt) => { pt.id = `r${pt.n}`; });
    } else {
      q.id = `r${q.n}`;
    }
  });
}

/** Every question number a reading part answers, in order (table gaps and map points included). */
function readingNumbers(part) {
  const ns = [];
  for (const q of part.questions || []) {
    if (q.type === "table") (q.gaps || []).forEach((g) => ns.push(g.n));
    else if (q.type === "map") (q.points || []).forEach((pt) => ns.push(pt.n));
    else ns.push(q.n);
  }
  return ns;
}

function numberRangeErrors(ns, startN, count, what) {
  const expected = Array.from({ length: count }, (_, i) => startN + i);
  const got = [...ns].sort((a, b) => a - b);
  if (got.length === expected.length && got.every((n, i) => n === expected[i])) return [];
  return [
    `${what} must be numbered exactly ${startN}-${startN + count - 1} (${count} questions, each number once); ` +
    `got ${got.length}: ${got.join(", ")}.`,
  ];
}

function matchingLetters(q) {
  if (Array.isArray(q.optionLetters) && q.optionLetters.length) return q.optionLetters.map(String);
  return (q.options || []).map((_, i) => String.fromCharCode(65 + i));
}

function readingPartErrors(part, startN, count) {
  const errors = validatorErrors({ type: "reading", durationMinutes: 20, parts: [part] }, "ielts");
  if (errors.length) return errors;

  errors.push(...numberRangeErrors(readingNumbers(part), startN, count, "Questions"));
  const words = wordCount((part.passage || []).join(" "));
  if (words < 550) errors.push(`The passage is only ${words} words — it needs to be at least 600.`);

  for (const q of part.questions) {
    if (q.type === "mcq") {
      if (new Set(q.options).size !== q.options.length) errors.push(`Question ${q.n}: mcq options must all be different.`);
      if (!q.options.includes(q.answer)) errors.push(`Question ${q.n}: mcq "answer" must be the exact text of one of its options.`);
    }
    if (q.type === "matching" && !matchingLetters(q).includes(String(q.answer))) {
      errors.push(`Question ${q.n}: matching "answer" must be one of the letters ${matchingLetters(q).join(", ")}, not the option text.`);
    }
    if (q.type === "gap-fill" && !normalize(Array.isArray(q.answer) ? q.answer[0] : q.answer)) {
      errors.push(`Question ${q.n}: gap-fill answer is empty.`);
    }
  }
  return errors;
}

/** Turns each map question's scene + point labels into a real generated
 * image with vision-verified pin coordinates (mapImageService). No-op when
 * the part has no map question. */
async function resolveMapImages(part) {
  const mapQuestions = (part.questions || []).filter((q) => q.type === "map" && !q.imageUrl);
  await Promise.all(
    mapQuestions.map(async (q) => {
      if (!Array.isArray(q.points) || q.points.length === 0) return;
      const { imageUrl, points: resolvedPoints } = await generateMapImage({
        sceneDescription: q.scene || "a simple labeled diagram",
        points: q.points.map((p) => ({ n: p.n, label: p.label || p.answer || `marker ${p.n}` })),
      });
      q.imageUrl = imageUrl;
      const byN = new Map(resolvedPoints.map((p) => [p.n, p]));
      q.points = q.points.map((p) => {
        const resolved = byN.get(p.n);
        return resolved ? { ...p, x: resolved.x, y: resolved.y } : p;
      });
      delete q.scene; // only needed to draw the image, not part of the schema
    })
  );
}

// ---------------------------------------------------------------------------
// IELTS Listening — one part per call
// ---------------------------------------------------------------------------

const LISTENING_PART_BRIEFS = [
  "Part 1: a conversation between two people in an everyday situation — a booking, an enquiry, filling in a form. Names, numbers, dates, prices and addresses are spelled out or repeated the way they are in the real test.",
  "Part 2: one person speaking in an everyday setting — a guide, a local radio item, a talk about facilities or an event.",
  "Part 3: a discussion between two or three people in an education or training setting — students planning an assignment, a tutorial.",
  "Part 4: one lecturer giving a talk on an academic subject, organised under clear headings.",
];

/**
 * Writes one listening part: a spoken script plus note-completion questions.
 * Audio is recorded separately (recordListeningAudio) so a failed recording
 * never throws away a good script.
 */
async function writeListeningPart({ index, startN, count = LISTENING_QUESTIONS_PER_PART, topic, difficulty, notes }) {
  const system =
    "You are an experienced IELTS Listening item writer. You write scripts that sound like real people talking, " +
    "and note-completion questions whose answers are heard word for word in the recording, in order. " + JSON_ONLY_RULE;

  return writeChecked({
    label: `Listening part ${index + 1}`,
    system,
    prompt: buildListeningPartPrompt({ index, startN, count, topic, difficulty, notes }),
    check: (p) => listeningPartErrors(p, startN, count),
    postProcess: (p) => {
      p.id = `l-part${index + 1}`;
      p.audioUrl = null;
    },
    maxTokens: 24000,
  });
}

function buildListeningPartPrompt({ index, startN, count, topic, difficulty, notes }) {
  const endN = startN + count - 1;
  return `Write Part ${index + 1} of an IELTS Listening test, with questions ${startN}-${endN}.

${LISTENING_PART_BRIEFS[index] || LISTENING_PART_BRIEFS[3]}
Scenario: ${topic || "choose a specific, believable scenario yourself"}.
Level: ${ieltsLevel(difficulty)}.
${notesBlock(notes)}
The script: 750-900 words of natural spoken English. It will be turned into audio by a text-to-speech voice, so write only what is said aloud — no stage directions, no sound effects, no bracketed notes. For a conversation, start each turn on its own line with the speaker's name and a colon ("Receptionist: Good morning…"). Begin with the short introduction a real recording has ("You will hear…"). Each answer is said clearly once, in question order, with at least one plausible distractor near some of them.

The questions: exactly ${count} blanks, numbered ${startN} to ${endN} with no gaps, as a set of notes or a form the candidate completes while listening. This is the only task type the test interface can show for listening.

Return this JSON shape:

{
  "title": "Part ${index + 1} — a short title for the scenario",
  "instructions": "Complete the notes below. Write ONE WORD AND/OR A NUMBER for each answer.",
  "transcript": "the full script",
  "items": [
    {
      "label": "a heading for this group of notes",
      "lines": [
        { "pre": "text before the blank", "n": ${startN}, "post": "text after the blank", "answer": "word" },
        { "pre": "-", "text": "a line of notes with no blank" }
      ]
    }
  ]
}

A line with "n" is a blank and needs "answer"; a line with only "text" is plain context. "answer" is a string, or an array when more than one written form should be accepted (["7", "seven"]). Answers must fit the word limit in "instructions" and must be exactly what is heard.

${JSON_ONLY_RULE}`;
}

function listeningNumbers(part) {
  const ns = [];
  for (const item of part.items || []) {
    for (const line of item.lines || []) if (line.n !== undefined) ns.push(line.n);
  }
  return ns;
}

function listeningPartErrors(part, startN, count) {
  const errors = validatorErrors({ type: "listening", durationMinutes: 8, parts: [part] }, "ielts");
  if (errors.length) return errors;
  errors.push(...numberRangeErrors(listeningNumbers(part), startN, count, "Blanks"));
  const words = wordCount(part.transcript);
  if (words < 600) errors.push(`The script is only ${words} words — it needs to be at least 700 so the recording runs a realistic length.`);
  if (/[\[\(][^\]\)]{0,40}(pause|music|sound|laugh|beep|tone)[^\]\)]{0,40}[\]\)]/i.test(part.transcript || "")) {
    errors.push("The script contains stage directions or sound effects in brackets — remove them; only spoken words belong in it.");
  }
  return errors;
}

/** What actually gets sent to the voice: the script with the "Name:" turn
 * labels removed, since a text-to-speech voice would read them aloud. */
function spokenText(transcript) {
  return String(transcript || "")
    .split("\n")
    .map((line) => line.replace(/^\s*[A-Z][\w .'-]{0,28}:\s+/, ""))
    .join("\n")
    .trim();
}

/** Picks a distinct default voice per part so the four parts don't all
 * sound identical. Override with ELEVENLABS_VOICE_ID_PARTn. */
function pickVoiceId(part) {
  const idx = part.id?.match(/(\d+)/)?.[1] || "1";
  return process.env[`ELEVENLABS_VOICE_ID_PART${idx}`] || process.env.ELEVENLABS_VOICE_ID_DEFAULT;
}

/** Records one listening part's script and writes the hosted URL onto it.
 * Throws if the recording fails; the caller decides whether that fails the
 * build or becomes a warning. Returns the estimated length in seconds. */
async function recordListeningAudio(part) {
  const { audioUrl, durationSeconds } = await synthesizeAudio({
    script: spokenText(part.transcript),
    voiceId: pickVoiceId(part),
  });
  part.audioUrl = audioUrl;
  return durationSeconds || 0;
}

// ---------------------------------------------------------------------------
// IELTS Writing
// ---------------------------------------------------------------------------

/**
 * Writes Task 1 + Task 2. Academic Task 1 comes with chart data, which is
 * drawn as a real image (chartSvg.js) so the candidate has something to
 * describe; General Training Task 1 is a letter and has no chart.
 * @returns {Promise<{ section: Object, warnings: string[] }>}
 */
async function writeWritingSection({ topics = [], difficulty, variant, notes }) {
  const general = variant === "general";
  const system =
    `You are an experienced IELTS ${general ? "General Training" : "Academic"} Writing item writer. ` +
    `Your tasks read exactly like the ones on a real paper. ${JSON_ONLY_RULE}`;

  const task1 = general
    ? `Task 1 is a letter: a short situation, then "Write a letter to…" with three bullet points the letter must cover. No chart.`
    : `Task 1 describes one chart or table. Also return its data as "chart" so the image can be drawn:
  { "type": "bar" | "line" | "table", "title", "xLabel", "yLabel", "categories": [3-8 labels], "series": [{ "name", "values": [one number per category] }] }
  Use 1-4 series with realistic, interesting figures (a clear trend, a contrast, an exception). The prompt names what the chart shows and ends "Summarise the information by selecting and reporting the main features, and make comparisons where relevant."`;

  const raw = await writeChecked({
    label: "Writing tasks",
    system,
    prompt: `Write the two tasks of an IELTS ${general ? "General Training" : "Academic"} Writing paper.

${task1}
Task 1 subject: ${topics[0] || "your choice"}.

Task 2 is an essay question — opinion, discussion, problem-solution or advantages-disadvantages — in the usual wording, ending with the instruction to give reasons and relevant examples.
Task 2 subject: ${topics[1] || "your choice, unrelated to Task 1"}.

Level: ${ieltsLevel(difficulty)}.
${notesBlock(notes)}
Return this JSON shape:

{
  "task1": { "prompt": "…"${general ? "" : `, "chart": { … }`} },
  "task2": { "prompt": "…" }
}

${JSON_ONLY_RULE}`,
    check: (value) => {
      const errors = [];
      if (!value?.task1?.prompt) errors.push("task1.prompt is missing.");
      if (!value?.task2?.prompt) errors.push("task2.prompt is missing.");
      if (!general) errors.push(...chartErrors(value?.task1?.chart));
      return errors;
    },
    maxTokens: 12000,
    effort: "medium",
  });

  const warnings = [];
  const task1Part = {
    id: "w-task1",
    instructions: "You should spend about 20 minutes on this task. Write at least 150 words.",
    prompt: raw.task1.prompt,
    minWords: 150,
  };
  if (!general) {
    try {
      const svg = renderChartSvg(raw.task1.chart);
      const hash = crypto.createHash("sha256").update(svg).digest("hex").slice(0, 24);
      task1Part.chartImageUrl = await uploadBuffer({
        path: `charts/${hash}.svg`,
        buffer: Buffer.from(svg, "utf8"),
        contentType: "image/svg+xml",
      });
    } catch (e) {
      // Without the image the candidate still needs the figures, so fall
      // back to printing them under the prompt.
      task1Part.prompt = `${raw.task1.prompt}\n\n${chartAsText(raw.task1.chart)}`;
      warnings.push(`Writing Task 1: the chart image couldn't be saved (${e.message}), so its figures are printed as text under the prompt instead.`);
    }
  }

  const section = {
    type: "writing",
    durationMinutes: 60,
    parts: [
      task1Part,
      {
        id: "w-task2",
        instructions: "You should spend about 40 minutes on this task. Write at least 250 words.",
        prompt: raw.task2.prompt,
        minWords: 250,
      },
    ],
  };
  const errors = validatorErrors(section, "ielts");
  if (errors.length) throw new Error(`Writing tasks failed validation: ${errors.join("; ")}`);
  return { section, warnings };
}

function chartErrors(chart) {
  if (!chart || typeof chart !== "object") return ["task1.chart is missing."];
  const errors = [];
  if (!["bar", "line", "table"].includes(chart.type)) errors.push(`task1.chart.type must be "bar", "line" or "table".`);
  if (!Array.isArray(chart.categories) || chart.categories.length < 2 || chart.categories.length > 10) {
    errors.push("task1.chart.categories must list 2-10 labels.");
  }
  if (!Array.isArray(chart.series) || chart.series.length < 1 || chart.series.length > 5) {
    errors.push("task1.chart.series must hold 1-5 series.");
  } else {
    chart.series.forEach((s, i) => {
      const ok = Array.isArray(s.values) && s.values.length === (chart.categories || []).length &&
        s.values.every((v) => typeof v === "number" && Number.isFinite(v));
      if (!s.name || !ok) errors.push(`task1.chart.series[${i}] needs a name and one number per category.`);
    });
  }
  return errors;
}

function chartAsText(chart) {
  const header = [chart.xLabel || "", ...chart.series.map((s) => s.name)].join(" | ");
  const rows = chart.categories.map((c, i) => [c, ...chart.series.map((s) => s.values[i])].join(" | "));
  return [chart.title, header, ...rows].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// SAT — one module per call
// ---------------------------------------------------------------------------

const SAT_MODULE_BRIEFS = {
  module1: "Module 1, which every student sees: a spread of difficulty from easy to hard, weighted to the middle.",
  easy: "the EASIER Module 2, given to students who scored lower on Module 1: mostly easy and medium questions, no very hard ones.",
  hard: "the HARDER Module 2, given to students who scored higher on Module 1: mostly medium and hard questions, including several of the hardest the test offers.",
};

const SAT_CONTENT = {
  "reading-writing": `Every question has its own short passage (25-150 words; one may be a pair of short texts, one or two may be a set of bulleted notes) and exactly four answer options. Order the questions the way the real test does, grouped by skill:
1. Craft and Structure (about 28%): words in context, text structure and purpose, cross-text connections.
2. Information and Ideas (about 26%): central ideas and details, command of evidence (textual and quantitative), inferences.
3. Standard English Conventions (about 26%): boundaries, form, structure and sense.
4. Expression of Ideas (about 20%): transitions, rhetorical synthesis from notes.
Passages are original and cover literature, history and social studies, the humanities and science. For a quantitative-evidence question, give the data as a small plain-text table inside the passage — the test interface cannot show graphics.`,
  math: `About three quarters of the questions are multiple choice with exactly four options; the rest are student-produced responses ("grid-in"), spread through the module. Cover the four domains in roughly the real proportions: Algebra (about 35%), Advanced Math (about 35%), Problem-Solving and Data Analysis (about 15%), Geometry and Trigonometry (about 15%). Order by rising difficulty.
The test interface shows plain text only: no figures, no diagrams, no rendered formulas. Describe every shape or graph fully in words, give data as a plain-text table, and write maths in plain text a student can read at a glance — x^2, sqrt(x), (3x + 1)/(x - 2), <=, pi. A calculator is allowed throughout.
A grid-in answer is a string holding one positive or negative number as an integer, a decimal, or a fraction ("12", "-3", ".75", "7/2") — no units, no symbols, no words.`,
};

/**
 * Writes one SAT module.
 * @param {Object} opts
 * @param {"reading-writing"|"math"} opts.sectionType
 * @param {"module1"|"module2"} opts.stage
 * @param {"easy"|"hard"} [opts.variant] - which Module 2
 * @param {string[]} [opts.topics] - focus areas the moderator asked for
 * @returns {Promise<Object>} a module, as docs/exam-json-schema.md describes
 */
async function writeSatModule({ sectionType, stage, variant, difficulty, topics = [], notes }) {
  const spec = SAT_SPEC[sectionType];
  const moduleId = `${sectionType === "math" ? "math" : "rw"}-${stage === "module1" ? "m1" : `m2-${variant}`}`;
  const brief = SAT_MODULE_BRIEFS[stage === "module1" ? "module1" : variant];
  const overall =
    difficulty === "easy" ? "This whole test is meant as a gentler practice paper — shift every module a step easier than the real thing."
    : difficulty === "hard" ? "This whole test is meant as a stretch paper — shift every module a step harder than the real thing."
    : "Match the difficulty of the real digital SAT.";

  const system =
    `You are an experienced digital SAT ${spec.label} item writer. You write original questions in the style and ` +
    `difficulty of the real test, each with exactly one correct answer and three wrong answers that tempt for a ` +
    `specific reason. You work every question through before you set its answer. ${JSON_ONLY_RULE}`;

  const mod = await writeChecked({
    label: `SAT ${spec.label} ${stage === "module1" ? "Module 1" : `Module 2 (${variant})`}`,
    system,
    prompt: `Write one module of the digital SAT ${spec.label} section: ${brief}

${overall}
${topics.length ? `The moderator wants extra weight on: ${topics.join("; ")}. Keep the module a complete, balanced paper all the same.` : ""}
${notesBlock(notes)}
Exactly ${spec.questions} questions, numbered 1 to ${spec.questions}.

${SAT_CONTENT[sectionType]}

Return this JSON shape:

{
  "questions": [
    ${sectionType === "math"
      ? `{ "n": 1, "type": "mcq", "prompt": "…", "options": ["…", "…", "…", "…"], "answer": "the exact text of the correct option" },
    { "n": 2, "type": "grid-in", "prompt": "…", "answer": "7/2" }`
      : `{ "n": 1, "type": "mcq", "passage": "…", "prompt": "…", "options": ["…", "…", "…", "…"], "answer": "the exact text of the correct option" }`}
  ]
}

Do not put letters in front of the option text. Spread the correct answers evenly across the four positions.

${JSON_ONLY_RULE}`,
    check: (value) => satModuleErrors(shapeSatModule(value, { moduleId, stage, variant, spec }), sectionType, spec),
    maxTokens: 48000,
  });

  return shapeSatModule(mod, { moduleId, stage, variant, spec });
}

function shapeSatModule(value, { moduleId, stage, variant, spec }) {
  const questions = (Array.isArray(value?.questions) ? value.questions : []).map((q, i) => ({
    ...q,
    id: `${moduleId}-q${i + 1}`,
    n: i + 1,
  }));
  return {
    id: moduleId,
    stage,
    ...(stage === "module2" ? { difficulty: variant } : {}),
    durationMinutes: spec.durationMinutes,
    questions,
  };
}

function satModuleErrors(mod, sectionType, spec) {
  const errors = [];
  if (mod.questions.length !== spec.questions) {
    errors.push(`The module must have exactly ${spec.questions} questions; got ${mod.questions.length}.`);
  }
  mod.questions.forEach((q) => {
    const where = `Question ${q.n}`;
    if (!["mcq", "grid-in"].includes(q.type)) return errors.push(`${where}: type must be "mcq" or "grid-in".`);
    if (!q.prompt) errors.push(`${where}: missing prompt.`);
    if (sectionType === "reading-writing") {
      if (q.type !== "mcq") errors.push(`${where}: Reading and Writing questions are all multiple choice.`);
      if (!q.passage || wordCount(q.passage) < 15) errors.push(`${where}: needs its own passage.`);
    }
    if (q.type === "mcq") {
      if (!Array.isArray(q.options) || q.options.length !== 4) return errors.push(`${where}: needs exactly 4 options.`);
      if (new Set(q.options).size !== 4) errors.push(`${where}: the 4 options must all be different.`);
      if (!q.options.includes(q.answer)) errors.push(`${where}: "answer" must be the exact text of one of its options.`);
    } else if (parseGridInValue(q.answer) === null) {
      errors.push(`${where}: grid-in "answer" must be a string holding a single number like "12", "-3", ".75" or "7/2" (got ${JSON.stringify(q.answer)}).`);
    }
  });
  return errors;
}

// ---------------------------------------------------------------------------
// Answer-key check
// ---------------------------------------------------------------------------

/** The questions of a reading part or SAT module that have a closed answer
 * (a choice or a number) — the ones an independent solve can be compared
 * against exactly. Free-text blanks are left out: two correct readers can
 * word those differently. */
function checkableQuestions(unit) {
  return (unit.questions || []).filter((q) =>
    q.type === "mcq" || q.type === "tfng" || q.type === "matching" || q.type === "grid-in"
  );
}

function sameAnswer(q, given) {
  if (given === undefined || given === null) return false;
  if (q.type === "grid-in") return isGridInCorrect(String(given), String(q.answer));
  return normalize(given) === normalize(q.answer);
}

function questionForSolver(q) {
  const { answer, id, groupTitle, groupInstructions, ...rest } = q;
  return rest;
}

/**
 * Has the model answer a unit's closed questions without the key, then asks
 * it to fix any question where its answer and the key disagree.
 * Mutates `unit.questions` in place when a fix passes `recheck`.
 *
 * @param {Object} opts
 * @param {Object} opts.unit - a reading part or a SAT module
 * @param {string} opts.kind - e.g. "IELTS Academic Reading" or "digital SAT Math"
 * @param {string} [opts.context] - text the questions depend on (the reading passage)
 * @param {(unit: Object) => string[]} opts.recheck - the unit's structural checks
 * @returns {Promise<{ checked: number, disputed: number[], fixed: number[], unresolved: number[] }>}
 */
async function checkAnswerKey({ unit, kind, context, recheck }) {
  const questions = checkableQuestions(unit);
  const result = { checked: questions.length, disputed: [], fixed: [], unresolved: [] };
  if (questions.length === 0) return result;

  const solved = await generateJson({
    system:
      `You are a top-scoring ${kind} candidate checking a practice paper. Answer every question carefully and ` +
      `independently. ${JSON_ONLY_RULE}`,
    prompt: `${context ? `Read this text:\n\n${context}\n\n` : ""}Answer these questions:

${JSON.stringify(questions.map(questionForSolver), null, 1)}

For "mcq" give the exact text of the option you choose. For "tfng" give TRUE, FALSE or NOT GIVEN (YES, NO or NOT GIVEN when "variant" is "yes-no"). For "matching" give the letter of the option (A, B, C… in the order listed, or the "optionLetters" value when present). For "grid-in" give a single number as a string. If a question has no single defensible answer, give "AMBIGUOUS".

Return {"answers": {"<n>": "<your answer>", ...}} with one entry per question number.

${JSON_ONLY_RULE}`,
    maxTokens: 32000,
  });

  const answers = solved?.answers || {};
  const disputed = questions.filter((q) => !sameAnswer(q, answers[String(q.n)]));
  result.disputed = disputed.map((q) => q.n);
  if (disputed.length === 0) return result;

  // One repair round: the writer sees both answers and either corrects the
  // key or rewrites the question so only one answer stands.
  try {
    const repaired = await generateJson({
      system:
        `You are a senior ${kind} item writer reviewing questions whose answer key was challenged. ${JSON_ONLY_RULE}`,
      prompt: `${context ? `The text these questions are based on:\n\n${context}\n\n` : ""}A strong candidate answered the questions below differently from the answer key. For each one, work it through again and decide who is right. If the key is wrong, correct "answer". If the question is ambiguous or flawed, rewrite the question and its options so exactly one answer is defensible${context ? " from the text" : ""}, and set "answer" to it. If the key was right and the question is sound, return it unchanged.

${JSON.stringify(disputed.map((q) => ({ question: q, candidateAnswer: answers[String(q.n)] ?? null })), null, 1)}

Keep every question's "n", "id" and "type" exactly as they are, and keep the same fields. Return {"questions": [ ...the full corrected question objects, one per question above... ]}.

${JSON_ONLY_RULE}`,
      maxTokens: 32000,
    });

    const byN = new Map((repaired?.questions || []).map((q) => [q.n, q]));
    const candidate = {
      ...unit,
      questions: unit.questions.map((q) => {
        const fix = byN.get(q.n);
        if (!fix || !result.disputed.includes(q.n)) return q;
        return { ...q, ...fix, id: q.id, n: q.n, type: q.type };
      }),
    };
    if (recheck(candidate).length === 0) {
      unit.questions = candidate.questions;
      result.fixed = result.disputed.filter((n) => byN.has(n));
    }
  } catch (e) {
    if (e instanceof Anthropic.APIError) throw e;
  }
  result.unresolved = result.disputed.filter((n) => !result.fixed.includes(n));
  return result;
}

/** Answer-key check for one reading part. */
function checkReadingPart(part, { variant, startN, count }) {
  return checkAnswerKey({
    unit: part,
    kind: `IELTS ${variant === "general" ? "General Training" : "Academic"} Reading`,
    context: (part.passage || []).join("\n\n"),
    recheck: (p) => readingPartErrors(p, startN, count),
  });
}

/** Answer-key check for one SAT module. */
function checkSatModule(mod, sectionType) {
  const spec = SAT_SPEC[sectionType];
  return checkAnswerKey({
    unit: mod,
    kind: `digital SAT ${spec.label}`,
    recheck: (m) => satModuleErrors(m, sectionType, spec),
  });
}

// ---------------------------------------------------------------------------
// Rewriting one unit of an existing exam
// ---------------------------------------------------------------------------

/**
 * Rewrites one existing unit (a reading part, listening part, writing part
 * or SAT module) according to the moderator's instructions, keeping its id
 * and question numbers so the rest of the exam still fits around it.
 *
 * @param {Object} opts
 * @param {Object} opts.unit - the current unit JSON
 * @param {string} opts.kind - what it is, for the prompt ("IELTS Reading passage 2", …)
 * @param {string} opts.shapeNotes - the rules of the unit's JSON shape
 * @param {string} opts.instructions - what the moderator wants changed
 * @param {(unit: Object) => string[]} opts.check
 * @param {(unit: Object) => void|Promise<void>} [opts.postProcess]
 */
async function rewriteUnit({ unit, kind, shapeNotes, instructions, check, postProcess }) {
  return writeChecked({
    label: `Rewrite of ${kind}`,
    system:
      `You are an experienced exam item writer revising part of a mock exam for a test moderator. You make the ` +
      `change they ask for and leave everything else as it is. ${JSON_ONLY_RULE}`,
    prompt: `This is ${kind} as it currently stands:

${JSON.stringify(unit, null, 1)}

The moderator wants this change:
${instructions}

Rules of this JSON shape:
${shapeNotes}

Keep the same top-level fields, the same "id", and the same question numbers. Where the change affects a passage or script, update the questions and answers that depend on it so every answer is still correct. Return the complete revised JSON object.

${JSON_ONLY_RULE}`,
    check,
    postProcess,
    maxTokens: 48000,
  });
}

module.exports = {
  READING_COUNTS,
  LISTENING_QUESTIONS_PER_PART,
  SAT_SPEC,
  READING_TASK_SHAPES,
  imagesAvailable,
  audioAvailable,
  writeReadingPart,
  checkReadingPart,
  readingPartErrors,
  readingNumbers,
  assignReadingIds,
  resolveMapImages,
  writeListeningPart,
  listeningPartErrors,
  listeningNumbers,
  recordListeningAudio,
  writeWritingSection,
  writeSatModule,
  checkSatModule,
  satModuleErrors,
  rewriteUnit,
  validatorErrors,
};
