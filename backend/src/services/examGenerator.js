/**
 * examGenerator.js
 * Calls an LLM (via llmClient.js) to generate a full IELTS mock exam
 * matching docs/exam-json-schema.md. Admin reviews/edits the output before
 * publishing (exams are always created with status "draft" — see store.js).
 *
 * Each of the three exported functions:
 *   1. Builds a section-specific prompt with the exact JSON shape spelled out
 *      (mirroring frontend/public/docs/sample-exam-template.json).
 *   2. Calls the LLM for JSON.
 *   3. Validates the result by embedding it in a throwaway exam and running
 *      it through examValidator.validateExam() — the same check a
 *      human-authored exam gets.
 *   4. If invalid, retries once with the validator's exact error list fed
 *      back into the prompt so the model can repair its own mistakes.
 *   5. Throws loudly (never returns silently-invalid content) if the repair
 *      attempt still fails — an exam with a missing answer key is a bug, not
 *      a soft failure, per the schema doc.
 *
 * Listening audio: once the listening section's JSON (script + items) is
 * generated, this calls ttsService.synthesizeAudio() per part and writes the
 * resulting URL into part.audioUrl directly — there is no separate
 * media-matching step for AI-generated exams, unlike the manual zip-upload
 * path, because the model already knows which script belongs to which part.
 */

const { generateJson } = require("./llmClient");
const { validateExam } = require("./examValidator");
const { synthesizeAudio } = require("./ttsService");
const { generateMapImage } = require("./mapImageService");

const MAX_ATTEMPTS = 2; // 1 generation attempt + 1 repair attempt

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Wraps a lone section in a throwaway exam shell so examValidator.validateExam()
 * (which validates a whole exam) can check just this one section. */
function validateSection(section) {
  return validateExam({ title: "generation-check", sections: [section] });
}

/** Calls the LLM, validates the returned section, and retries once with the
 * validator's error list appended to the prompt if the first attempt is invalid.
 * If postProcess is given, it runs on the raw LLM output (e.g. turning map-
 * question point labels into real generated images + verified coordinates)
 * BEFORE validation, since validation requires the fields postProcess adds. */
async function generateValidatedSection({ system, prompt, sectionKind, maxTokens, postProcess }) {
  let lastErrors = [];
  let currentPrompt = prompt;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let section, errors, valid;
    try {
      section = await generateJson({ system, prompt: currentPrompt, maxTokens });
      if (postProcess) await postProcess(section);
      ({ valid, errors } = validateSection(section));
      if (valid) return section;
    } catch (e) {
      errors = [`generation/post-processing error: ${e.message}`];
    }

    lastErrors = errors;
    if (attempt < MAX_ATTEMPTS) {
      currentPrompt =
        `${prompt}\n\n---\nYour previous attempt failed with these exact issues:\n` +
        `${errors.map((e) => `- ${e}`).join("\n")}\n\n` +
        `Return a corrected, complete JSON object that fixes every one of these ` +
        `issues. Output the full section JSON again, not a diff.`;
    }
  }

  throw new Error(
    `${sectionKind} generation failed validation after ${MAX_ATTEMPTS} attempts: ` +
    lastErrors.join("; ")
  );
}

const JSON_ONLY_RULE =
  "Respond with ONLY a single valid JSON object — no markdown fences, no " +
  "commentary before or after, no trailing explanation. The JSON must be " +
  "directly parseable by JSON.parse().";

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function generateReadingSection({ topic, difficulty }) {
  const system =
    "You are an expert IELTS Academic Reading test writer. You produce " +
    "exams that match a strict JSON contract exactly, including full, " +
    "well-formed answer keys for every question. " + JSON_ONLY_RULE;

  const prompt = buildReadingPrompt({ topic, difficulty });
  return generateValidatedSection({
    system,
    prompt,
    sectionKind: "Reading section",
    maxTokens: 8000,
    postProcess: resolveMapImages,
  });
}

/** Finds every map-type question in a reading section (imageUrl still null,
 * points carrying only text labels) and replaces it with a real generated
 * image + vision-verified x/y coordinates via mapImageService. Runs all map
 * questions in a section in parallel since each is an independent image call.
 * No-ops if the section has no map questions. */
async function resolveMapImages(section) {
  const mapQuestions = [];
  for (const part of section.parts || []) {
    for (const q of part.questions || []) {
      if (q.type === "map" && !q.imageUrl) mapQuestions.push(q);
    }
  }
  if (mapQuestions.length === 0) return;

  await Promise.all(
    mapQuestions.map(async (q) => {
      if (!Array.isArray(q.points) || q.points.length === 0) return;
      const { imageUrl, points: resolvedPoints } = await generateMapImage({
        sceneDescription: q.scene || "a simple labeled diagram",
        points: q.points.map((p) => ({ n: p.n, label: p.label || p.answer || `marker ${p.n}` })),
      });

      q.imageUrl = imageUrl;
      // Merge verified x/y back onto the original points, keeping id/answer
      // (the content the model wrote) but replacing coordinates with what
      // the vision pass actually observed in the generated image.
      const byN = new Map(resolvedPoints.map((p) => [p.n, p]));
      q.points = q.points.map((p) => {
        const resolved = byN.get(p.n);
        return resolved ? { ...p, x: resolved.x, y: resolved.y } : p;
      });
      delete q.scene; // not part of the schema, was only needed for image generation
    })
  );
}

function buildReadingPrompt({ topic, difficulty }) {
  return `Generate one IELTS Academic Reading section as JSON, matching this exact shape:

{
  "type": "reading",
  "durationMinutes": 60,
  "parts": [
    {
      "id": "r-part1",
      "title": "READING PASSAGE 1",
      "passage": ["Paragraph one...", "Paragraph two...", "..."],
      "instructionsTitle": "Questions 1-3",
      "instructions": "...",
      "questions": [ /* see question types below */ ]
    },
    { "id": "r-part2", ... },
    { "id": "r-part3", ... }
  ]
}

Requirements:
- Exactly 3 parts (r-part1, r-part2, r-part3), each with a genuine 500-800 word
  academic-style passage (4-6 paragraphs each) on the topic: "${topic || "a general academic subject of your choosing"}".
  Difficulty level: ${difficulty || "medium"} (IELTS band ${difficulty === "hard" ? "7-8" : difficulty === "easy" ? "4-5" : "5.5-6.5"} equivalent).
- Across all 3 parts combined, produce exactly 40 questions total, numbered
  1-40 continuously across parts (part 2 continues where part 1 left off, etc).
- Use a MIX of these question types across the exam (every type must appear
  at least once somewhere across the 3 parts):
  - "tfng": { "id", "n", "type": "tfng", "prompt", "answer": "TRUE"|"FALSE"|"NOT GIVEN" }
  - "mcq": { "id", "n", "type": "mcq", "prompt", "options": [4 strings], "answer": one of options, exact string match }
  - "gap-fill": { "id", "n", "type": "gap-fill", "before", "after", "answer": string or [string,...] of accepted variants }
  - "matching": { "id", "n", "type": "matching", "prompt", "options": [array of choice strings], "answer": one of options }
    (group consecutive matching questions with the SAME options array, same order)
  - "table": { "id", "n", "type": "table", "table": { "headers": [...], "rows": [[...]] },
    "gaps": [{ "id", "n", "cellMarker", "answer" }] } — cellMarker MUST be a literal
    placeholder string like "___GAP9___" that appears verbatim in one of table.rows.
  - "map": { "id", "n", "type": "map", "imageUrl": null,
    "scene": "one-sentence description of the overall setting to depict, e.g. \"a small university library, top-down floor plan\"",
    "points": [{ "id", "n", "label": "short description of what/where this marker points to, e.g. \"the main entrance\"", "answer" }] }
    (map/table/mcq/matching only render in reading parts, not listening — keep them here.
    Do NOT invent x/y coordinates or a real imageUrl — leave imageUrl null and give each
    point a "label" describing its location instead; the actual image and verified x/y
    positions are generated separately after your response.)
- EVERY question needs a unique "id" and a numeric "n" unique within its part,
  and EVERY question (and every table gap / map point) needs an "answer" —
  never omit an answer key.
- Optional but nice: "groupTitle" / "groupInstructions" on the first question
  of a new answer-type group (e.g. "Questions 5-6").

${JSON_ONLY_RULE}`;
}

// ---------------------------------------------------------------------------
// Listening
// ---------------------------------------------------------------------------

async function generateListeningSection({ topic, difficulty }) {
  const system =
    "You are an expert IELTS Listening test writer. You produce realistic " +
    "spoken-style scripts (natural dialogue/monologue, not written prose) " +
    "and matching fill-in-the-blank questions with a full answer key. " +
    JSON_ONLY_RULE;

  const prompt = buildListeningPrompt({ topic, difficulty });
  const section = await generateValidatedSection({
    system,
    prompt,
    sectionKind: "Listening section",
    maxTokens: 8000,
  });

  await attachListeningAudio(section);
  return section;
}

function buildListeningPrompt({ topic, difficulty }) {
  return `Generate one IELTS Listening section as JSON, matching this exact shape:

{
  "type": "listening",
  "durationMinutes": 30,
  "parts": [
    {
      "id": "l-part1",
      "title": "Short descriptive title of the scenario",
      "instructions": "Complete the notes. Write ONE WORD AND/OR A NUMBER for each answer.",
      "audioUrl": null,
      "transcript": "Full natural-sounding spoken script for this part...",
      "items": [
        {
          "label": "Optional section label:",
          "lines": [
            { "pre": "-", "n": 1, "post": "shape", "answer": "round" },
            { "pre": "-", "text": "medium size" },
            { "pre": "-", "n": 2, "post": "old", "answer": "5" }
          ]
        }
      ]
    },
    { "id": "l-part2", ... },
    { "id": "l-part3", ... },
    { "id": "l-part4", ... }
  ]
}

Requirements:
- Exactly 4 parts (l-part1..l-part4), following real IELTS Listening structure:
  - Part 1: everyday conversation between two speakers (e.g. booking, form-filling)
  - Part 2: monologue in an everyday social context (e.g. a talk about local facilities)
  - Part 3: conversation between up to 4 people in an educational/training context
  - Part 4: monologue on an academic subject (lecture-style)
  Topic to weave in where natural: "${topic || "everyday life and academic subjects"}".
  Difficulty: ${difficulty || "medium"}.
- Each part needs a full "transcript" (200-400 words) written as natural
  spoken dialogue or monologue with speaker labels where relevant — this is
  the script that will be converted to audio.
- Set "audioUrl" to null — it will be filled in separately after generation.
- Across all 4 parts combined, produce exactly 40 questions total (lines with
  an "n"), numbered 1-40 continuously across parts.
- A line with "n" renders an input box ("pre" text, blank, "post" text) and
  MUST have an "answer". A line without "n" (just "text") is static, non-answer
  context and does not need "post"/"answer".
- EVERY line that has "n" must have a matching "answer" — never omit one.
- Use ONLY the flat items[].lines[] shape above — do not use mcq/table/map
  question objects here, the Listening UI does not render those.

${JSON_ONLY_RULE}`;
}

/** Synthesizes audio for every listening part's transcript and writes the
 * resulting hosted URL directly into part.audioUrl. Runs parts in parallel
 * since each is an independent TTS call. Throws if any synthesis fails —
 * silently leaving audioUrl null would mean the exam falls back to the
 * 20-second simulated-playback mode instead of real audio, which is not
 * acceptable for an exam that's meant to ship with real audio. */
async function attachListeningAudio(section) {
  await Promise.all(
    (section.parts || []).map(async (part) => {
      if (!part.transcript) return;
      const { audioUrl } = await synthesizeAudio({ script: part.transcript, voiceId: pickVoiceId(part) });
      part.audioUrl = audioUrl;
    })
  );
}

/** Picks a distinct default voice per part index so the 4 parts don't all
 * sound identical. Override with ELEVENLABS_VOICE_ID_PARTn env vars if you
 * have specific cloned/library voices you prefer. */
function pickVoiceId(part) {
  const idx = part.id?.match(/(\d+)/)?.[1] || "1";
  return process.env[`ELEVENLABS_VOICE_ID_PART${idx}`] || process.env.ELEVENLABS_VOICE_ID_DEFAULT;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

async function generateWritingSection({ taskTypes }) {
  const system =
    "You are an expert IELTS Writing test writer. You produce realistic " +
    "Task 1 (data description) and Task 2 (essay) prompts. " + JSON_ONLY_RULE;

  const prompt = buildWritingPrompt({ taskTypes });
  return generateValidatedSection({ system, prompt, sectionKind: "Writing section", maxTokens: 2000 });
}

function buildWritingPrompt({ taskTypes }) {
  const wantsTask1 = !taskTypes || taskTypes.includes("task1");
  const wantsTask2 = !taskTypes || taskTypes.includes("task2");
  const parts = [];
  if (wantsTask1) {
    parts.push(
      `{ "id": "w-task1", "instructions": "You should spend about 20 minutes on this task. Write at least 150 words.", "prompt": "<describe a chart/graph/table/diagram to summarise>", "minWords": 150 }`
    );
  }
  if (wantsTask2) {
    parts.push(
      `{ "id": "w-task2", "instructions": "You should spend about 40 minutes on this task. Write at least 250 words.", "prompt": "<an opinion/discussion/problem-solution essay question>", "minWords": 250 }`
    );
  }

  return `Generate one IELTS Writing section as JSON, matching this exact shape:

{
  "type": "writing",
  "parts": [
    ${parts.join(",\n    ")}
  ]
}

Requirements:
- Task 1 prompt must describe a specific, plausible chart/graph/table/diagram
  (e.g. "The chart below shows..."), written the way real IELTS Task 1 prompts
  are worded — do not include actual image data, just the descriptive prompt text.
- Task 2 prompt must be a genuine opinion, discussion, or problem-solution
  essay question in real IELTS Task 2 style.
- Every part needs "id", "instructions", "prompt", and "minWords" (number).

${JSON_ONLY_RULE}`;
}

module.exports = { generateReadingSection, generateListeningSection, generateWritingSection };
