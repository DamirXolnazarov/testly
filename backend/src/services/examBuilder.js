/**
 * examBuilder.js
 * Turns an exam blueprint (what the AI Studio chat and the admin agree on)
 * into a real exam, and rewrites single parts of an exam afterwards.
 *
 * A blueprint is small and human-readable:
 *   {
 *     title, testType: "ielts" | "sat", difficulty: "easy" | "medium" | "hard",
 *     variant: "academic" | "general",            // IELTS only
 *     sections: [{ type, parts, topics: string[], notes }]
 *   }
 * `parts` is how many passages (reading, 1-3) or parts (listening, 1-4) to
 * write; SAT sections and IELTS writing are always full length.
 *
 * Building takes minutes (a dozen model calls, audio, answer-key checks),
 * so it runs as a background job: startBuild() returns at once and the UI
 * polls getJob() for step-by-step progress. Jobs live in memory — this is
 * a single-instance backend (same assumption as rateLimiter.js) and a job
 * is only interesting while it runs. If the process restarts mid-build the
 * job is gone; routes/ai.js notices the orphaned "generating" exam and
 * marks it failed so it never sits there forever.
 */

const store = require("./store");
const generator = require("./examGenerator");
const { validateExam } = require("./examValidator");
const { describeError } = require("./claudeClient");

const IELTS_SECTIONS = ["reading", "listening", "writing"];
const SAT_SECTIONS = ["reading-writing", "math"];
const MAX_PARTS = { reading: 3, listening: 4 };
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

const jobs = new Map(); // examId -> job

// ---------------------------------------------------------------------------
// Blueprint
// ---------------------------------------------------------------------------

/**
 * Checks and tidies a blueprint coming from the model or the browser.
 * @returns {{ blueprint: Object|null, errors: string[] }}
 */
function normalizeBlueprint(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") return { blueprint: null, errors: ["The blueprint must be an object."] };

  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 120) : "";
  if (title.length < 3) errors.push("title: give the exam a short title.");

  const testType = raw.testType;
  if (!["ielts", "sat"].includes(testType)) errors.push('testType must be "ielts" or "sat".');

  const difficulty = ["easy", "medium", "hard"].includes(raw.difficulty) ? raw.difficulty : "medium";
  const variant = raw.variant === "general" ? "general" : "academic";

  const allowed = testType === "sat" ? SAT_SECTIONS : IELTS_SECTIONS;
  const sections = [];
  if (!Array.isArray(raw.sections) || raw.sections.length === 0) {
    errors.push("sections: include at least one section.");
  } else {
    for (const s of raw.sections) {
      if (!s || !allowed.includes(s.type)) {
        if (testType) errors.push(`sections: "${s?.type}" isn't a ${testType.toUpperCase()} section — use ${allowed.join(", ")}.`);
        continue;
      }
      if (sections.some((x) => x.type === s.type)) {
        errors.push(`sections: "${s.type}" appears twice.`);
        continue;
      }
      const max = MAX_PARTS[s.type];
      const topics = (Array.isArray(s.topics) ? s.topics : [])
        .filter((t) => typeof t === "string" && t.trim())
        .map((t) => t.trim().slice(0, 160))
        .slice(0, 6);
      const section = {
        type: s.type,
        topics,
        notes: typeof s.notes === "string" ? s.notes.trim().slice(0, 800) : "",
      };
      if (max) {
        const parts = Number.isInteger(s.parts) && s.parts >= 1 ? Math.min(s.parts, max) : max;
        section.parts = parts;
        section.topics = topics.slice(0, parts);
      }
      sections.push(section);
    }
  }
  // Keep sections in the order students sit them.
  sections.sort((a, b) => allowed.indexOf(a.type) - allowed.indexOf(b.type));

  if (errors.length) return { blueprint: null, errors };
  const blueprint = { title, testType, difficulty, sections };
  if (testType === "ielts") blueprint.variant = variant;
  return { blueprint, errors: [] };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

function createJob(examId, kind, title, steps) {
  const job = {
    examId,
    kind,
    title,
    status: "running",
    steps: steps.map((s) => ({ ...s, status: "pending", detail: "" })),
    notes: [],
    warnings: [],
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(examId, job);
  return job;
}

function setStep(job, id, status, detail = "") {
  const step = job.steps.find((s) => s.id === id);
  if (step) Object.assign(step, { status, detail });
}

function finishJob(job, error) {
  job.status = error ? "failed" : "done";
  job.error = error || null;
  job.finishedAt = Date.now();
  job.steps.forEach((s) => {
    if (s.status === "running" || s.status === "pending") s.status = error ? "stopped" : "done";
  });
  setTimeout(() => {
    if (jobs.get(job.examId) === job) jobs.delete(job.examId);
  }, JOB_TTL_MS).unref();
}

function getJob(examId) {
  return jobs.get(examId) || null;
}

function isBusy(examId) {
  return jobs.get(examId)?.status === "running";
}

/** Runs a step's work, recording running/done/failed on the job. Rethrows. */
async function runStep(job, id, work) {
  setStep(job, id, "running", "Starting");
  try {
    const value = await work((detail) => setStep(job, id, "running", detail));
    setStep(job, id, "done");
    return value;
  } catch (e) {
    setStep(job, id, "failed", describeError(e));
    throw e;
  }
}

function keyCheckNote(job, label, check) {
  if (!check || check.checked === 0) return;
  if (check.fixed.length) {
    job.notes.push(`${label}: the answer-key check questioned ${check.disputed.length} of ${check.checked} closed questions and corrected ${check.fixed.length}.`);
  }
  if (check.unresolved.length) {
    job.warnings.push(`${label}: please look at question${check.unresolved.length > 1 ? "s" : ""} ${check.unresolved.join(", ")} — the answer-key check disagreed with the key and couldn't settle it.`);
  }
}

// ---------------------------------------------------------------------------
// Building a whole exam
// ---------------------------------------------------------------------------

function buildSteps(blueprint) {
  const steps = [];
  for (const section of blueprint.sections) {
    if (section.type === "reading") {
      for (let i = 0; i < section.parts; i++) {
        steps.push({ id: `reading-${i}`, group: "Reading", label: `Passage ${i + 1}`, hint: section.topics[i] || "" });
      }
    } else if (section.type === "listening") {
      for (let i = 0; i < section.parts; i++) {
        steps.push({ id: `listening-${i}`, group: "Listening", label: `Part ${i + 1}`, hint: section.topics[i] || "" });
      }
    } else if (section.type === "writing") {
      steps.push({ id: "writing", group: "Writing", label: "Task 1 and Task 2", hint: "" });
    } else {
      const group = generator.SAT_SPEC[section.type].label;
      steps.push({ id: `${section.type}-module1`, group, label: "Module 1", hint: "" });
      steps.push({ id: `${section.type}-easy`, group, label: "Module 2 · easier", hint: "" });
      steps.push({ id: `${section.type}-hard`, group, label: "Module 2 · harder", hint: "" });
    }
  }
  steps.push({ id: "assemble", group: "Finish", label: "Final check and save", hint: "" });
  return steps;
}

async function buildReadingSection(job, blueprint, section) {
  let startN = 1;
  const plans = Array.from({ length: section.parts }, (_, index) => {
    const plan = { index, startN, count: generator.READING_COUNTS[index] };
    startN += plan.count;
    return plan;
  });

  const parts = await Promise.all(
    plans.map(({ index, startN: first, count }) =>
      runStep(job, `reading-${index}`, async (progress) => {
        progress("Writing the passage and questions");
        const part = await generator.writeReadingPart({
          index, startN: first, count,
          topic: section.topics[index], difficulty: blueprint.difficulty, variant: blueprint.variant, notes: section.notes,
        });
        progress("Checking the answer key");
        const check = await generator.checkReadingPart(part, { variant: blueprint.variant, startN: first, count });
        keyCheckNote(job, `Reading passage ${index + 1}`, check);
        return part;
      })
    )
  );

  const built = { type: "reading", durationMinutes: 20 * section.parts, parts };
  if (blueprint.variant === "general") built.variant = "general";
  return built;
}

async function buildListeningSection(job, blueprint, section) {
  const perPart = generator.LISTENING_QUESTIONS_PER_PART;
  const parts = await Promise.all(
    Array.from({ length: section.parts }, (_, index) =>
      runStep(job, `listening-${index}`, async (progress) => {
        progress("Writing the script and questions");
        const part = await generator.writeListeningPart({
          index, startN: index * perPart + 1,
          topic: section.topics[index], difficulty: blueprint.difficulty, notes: section.notes,
        });
        await recordPart(job, part, index, progress);
        return part;
      })
    )
  );
  // 30 minutes for the full four parts, scaled down for a shorter test.
  return { type: "listening", durationMinutes: Math.max(8, Math.round((30 * section.parts) / 4)), parts };
}

/** Records a listening part's audio. A recording that fails becomes a
 * warning, not a failed build: the script and questions are still good, and
 * the exam can't be started without audio anyway (see POST /exams/:id/start). */
async function recordPart(job, part, index, progress) {
  if (!generator.audioAvailable()) {
    job.warnings.push(`Listening part ${index + 1} has no audio: ElevenLabs isn't configured on the server (ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID_DEFAULT).`);
    return;
  }
  progress("Recording the audio");
  try {
    await generator.recordListeningAudio(part);
  } catch (e) {
    part.audioUrl = null;
    job.warnings.push(`Listening part ${index + 1} has no audio: ${e.message}`);
  }
}

async function buildSatSection(job, blueprint, section) {
  const variants = [
    { key: "module1", stage: "module1" },
    { key: "easy", stage: "module2", variant: "easy" },
    { key: "hard", stage: "module2", variant: "hard" },
  ];
  const label = generator.SAT_SPEC[section.type].label;
  const modules = await Promise.all(
    variants.map(({ key, stage, variant }) =>
      runStep(job, `${section.type}-${key}`, async (progress) => {
        progress("Writing the questions");
        const mod = await generator.writeSatModule({
          sectionType: section.type, stage, variant,
          difficulty: blueprint.difficulty, topics: section.topics, notes: section.notes,
        });
        progress("Checking the answer key");
        const check = await generator.checkSatModule(mod, section.type);
        keyCheckNote(job, `${label} ${stage === "module1" ? "Module 1" : `Module 2 (${variant})`}`, check);
        return mod;
      })
    )
  );
  return { type: section.type, modules };
}

/**
 * Creates a placeholder exam and starts building it in the background.
 * @returns {Promise<{ exam: Object, job: Object }>}
 */
async function startBuild({ blueprint, centerId }) {
  const exam = await store.createExam({
    title: blueprint.title,
    testType: blueprint.testType,
    sections: [],
    status: "generating",
    centerId,
  });
  const job = createJob(exam.examId, "build", blueprint.title, buildSteps(blueprint));

  // Fire-and-forget: nothing awaits this, so every failure has to end up on
  // the job and the exam row rather than being thrown.
  (async () => {
    try {
      const settled = await Promise.allSettled(
        blueprint.sections.map(async (section) => {
          if (section.type === "reading") return buildReadingSection(job, blueprint, section);
          if (section.type === "listening") return buildListeningSection(job, blueprint, section);
          if (section.type === "writing") {
            return runStep(job, "writing", async (progress) => {
              progress("Writing the tasks");
              const { section: built, warnings } = await generator.writeWritingSection({
                topics: section.topics, difficulty: blueprint.difficulty, variant: blueprint.variant, notes: section.notes,
              });
              job.warnings.push(...warnings);
              return built;
            });
          }
          return buildSatSection(job, blueprint, section);
        })
      );
      const failed = settled.find((r) => r.status === "rejected");
      if (failed) throw failed.reason;

      await runStep(job, "assemble", async () => {
        const sections = settled.map((r) => r.value);
        const { valid, errors } = validateExam({ title: blueprint.title, testType: blueprint.testType, sections });
        if (!valid) throw new Error(`The assembled exam failed validation: ${errors.slice(0, 4).join("; ")}`);
        const saved = await store.updateExam(exam.examId, { sections, status: "draft", generationError: null });
        if (!saved) throw new Error("The finished exam couldn't be saved.");
      });
      finishJob(job, null);
    } catch (e) {
      console.error(`Exam build failed for ${exam.examId}`, e);
      const message = describeError(e);
      finishJob(job, message);
      await store.updateExam(exam.examId, { status: "generation_failed", generationError: message }).catch(() => {});
    }
  })();

  return { exam, job };
}

// ---------------------------------------------------------------------------
// Rewriting one part of an existing exam
// ---------------------------------------------------------------------------

const SAT_MODULE_BY_PART = [
  (m) => m.stage === "module1",
  (m) => m.stage === "module2" && m.difficulty === "easy",
  (m) => m.stage === "module2" && m.difficulty === "hard",
];

/** Describes what a (sectionType, part) pair points at, or why it doesn't. */
function locateUnit(exam, sectionType, part) {
  const section = (exam.sections || []).find((s) => s.type === sectionType);
  if (!section) return { error: `This exam has no ${sectionType} section.` };
  if (sectionType === "writing") return { section, label: "Writing tasks" };

  if (SAT_SECTIONS.includes(sectionType)) {
    const mod = (section.modules || []).find(SAT_MODULE_BY_PART[part - 1] || (() => false));
    if (!mod) return { error: "part must be 1 (Module 1), 2 (easier Module 2) or 3 (harder Module 2)." };
    const names = ["Module 1", "Module 2 (easier)", "Module 2 (harder)"];
    return { section, unit: mod, label: `${generator.SAT_SPEC[sectionType].label} ${names[part - 1]}` };
  }

  const unit = (section.parts || [])[part - 1];
  if (!unit) return { error: `part must be between 1 and ${(section.parts || []).length} for the ${sectionType} section.` };
  return { section, unit, label: sectionType === "reading" ? `Reading passage ${part}` : `Listening part ${part}` };
}

/**
 * Starts rewriting one part of a draft exam in the background.
 * @returns {{ job: Object } | { error: string }}
 */
function startRevision({ exam, sectionType, part, instructions }) {
  if (exam.status !== "draft") return { error: `Only a draft exam can be edited (this one is "${exam.status}").` };
  if (isBusy(exam.examId)) return { error: "This exam is still being worked on — wait for that to finish first." };
  const located = locateUnit(exam, sectionType, part);
  if (located.error) return { error: located.error };

  const job = createJob(exam.examId, "revise", exam.title, [
    { id: "rewrite", group: "Rewrite", label: located.label, hint: instructions.slice(0, 120) },
  ]);

  (async () => {
    try {
      await runStep(job, "rewrite", async (progress) => {
        progress("Rewriting");
        const sections = JSON.parse(JSON.stringify(exam.sections));
        const section = sections.find((s) => s.type === sectionType);
        const variant = (exam.sections.find((s) => s.type === "reading") || {}).variant === "general" ? "general" : "academic";

        if (sectionType === "writing") {
          const previous = section.parts.map((p, i) => `Task ${i + 1}: ${p.prompt}`).join("\n");
          const { section: rewritten, warnings } = await generator.writeWritingSection({
            variant,
            notes: `These are the current tasks:\n${previous}\n\nRewrite them with this change: ${instructions}`,
          });
          job.warnings.push(...warnings);
          sections[sections.indexOf(section)] = rewritten;
        } else if (sectionType === "reading") {
          const index = part - 1;
          const current = section.parts[index];
          const numbers = generator.readingNumbers(current);
          const startN = Math.min(...numbers);
          const count = numbers.length;
          const types = [...new Set(current.questions.map((q) => (q.type === "tfng" && q.variant === "yes-no" ? "tfng-yes-no" : q.type)))];
          const offered = ["tfng", "tfng-yes-no", "mcq", "gap-fill", "matching", "table", ...(generator.imagesAvailable() ? ["map"] : [])];
          const rewritten = await generator.rewriteUnit({
            unit: current,
            kind: `IELTS ${variant === "general" ? "General Training" : "Academic"} Reading passage ${part} (questions ${startN}-${startN + count - 1})`,
            shapeNotes:
              [...new Set([...types, ...offered])]
                .map((t) => `- ${generator.READING_TASK_SHAPES[t]}`).join("\n") +
              `\n"passage" is an array of paragraph strings. Put "groupTitle" and "groupInstructions" on the first question of each group. A map question that already has an "imageUrl" must keep its image and points unchanged.`,
            instructions,
            check: (p) => generator.readingPartErrors(p, startN, count),
            postProcess: async (p) => {
              p.id = current.id;
              generator.assignReadingIds(p, index);
              await generator.resolveMapImages(p);
            },
          });
          progress("Checking the answer key");
          keyCheckNote(job, located.label, await generator.checkReadingPart(rewritten, { variant, startN, count }));
          section.parts[index] = rewritten;
        } else if (sectionType === "listening") {
          const index = part - 1;
          const current = section.parts[index];
          const numbers = generator.listeningNumbers(current);
          const startN = Math.min(...numbers);
          const rewritten = await generator.rewriteUnit({
            unit: { ...current, audioUrl: null },
            kind: `IELTS Listening part ${part} (questions ${startN}-${startN + numbers.length - 1})`,
            shapeNotes:
              `"transcript" is the full spoken script (750-900 words, only words that are said aloud; each turn of a conversation on its own line as "Name: …"). ` +
              `"items" is an array of { "label", "lines" }; a line with "n" is a blank and needs "answer" (a string, or an array of accepted forms) with "pre"/"post" text around it; a line with only "text" is plain context. ` +
              `Note completion is the only listening task type available. Every answer must be heard word for word in the script, in order.`,
            instructions,
            check: (p) => generator.listeningPartErrors(p, startN, numbers.length),
            postProcess: (p) => { p.id = current.id; },
          });
          if (rewritten.transcript === current.transcript && current.audioUrl) {
            rewritten.audioUrl = current.audioUrl;
          } else {
            rewritten.audioUrl = null;
            await recordPart(job, rewritten, index, progress);
          }
          section.parts[index] = rewritten;
        } else {
          const spec = generator.SAT_SPEC[sectionType];
          const index = section.modules.indexOf(section.modules.find(SAT_MODULE_BY_PART[part - 1]));
          const current = section.modules[index];
          const rewritten = await generator.rewriteUnit({
            unit: current,
            kind: `digital SAT ${located.label}`,
            shapeNotes:
              `"questions" holds exactly ${spec.questions} objects. Multiple choice: { "id", "n", "type": "mcq", ${sectionType === "math" ? "" : `"passage", `}"prompt", "options": [exactly 4 different strings], "answer": the exact text of the correct option }. ` +
              (sectionType === "math"
                ? `Student-produced response: { "id", "n", "type": "grid-in", "prompt", "answer": a string holding one number such as "12", "-3", ".75" or "7/2" }. Plain text only — no figures, no rendered formulas.`
                : `Every question is multiple choice and has its own short passage. Plain text only — no graphics.`) +
              ` Keep "stage", "difficulty" and "durationMinutes" as they are.`,
            instructions,
            check: (m) => generator.satModuleErrors(m, sectionType, spec),
            postProcess: (m) => {
              Object.assign(m, { id: current.id, stage: current.stage, durationMinutes: current.durationMinutes });
              if (current.difficulty) m.difficulty = current.difficulty;
              (m.questions || []).forEach((q, i) => Object.assign(q, { id: `${current.id}-q${i + 1}`, n: i + 1 }));
            },
          });
          progress("Checking the answer key");
          keyCheckNote(job, located.label, await generator.checkSatModule(rewritten, sectionType));
          section.modules[index] = rewritten;
        }

        const { valid, errors } = validateExam({ title: exam.title, testType: exam.testType, sections });
        if (!valid) throw new Error(`The rewritten exam failed validation: ${errors.slice(0, 4).join("; ")}`);
        // The exam may have gone live while this was running — never
        // rewrite content under students who are sitting it.
        const latest = await store.getExam(exam.examId);
        if (!latest || latest.status !== "draft") throw new Error("The exam is no longer a draft, so the rewrite was not saved.");
        const saved = await store.updateExam(exam.examId, { sections });
        if (!saved) throw new Error("The rewritten exam couldn't be saved.");
      });
      finishJob(job, null);
    } catch (e) {
      console.error(`Exam revision failed for ${exam.examId}`, e);
      finishJob(job, describeError(e));
    }
  })();

  return { job };
}

// ---------------------------------------------------------------------------
// Outline — a compact description of a built exam for the chat agent
// ---------------------------------------------------------------------------

function typeCounts(questions) {
  const counts = {};
  for (const q of questions) {
    const size = q.type === "table" ? (q.gaps || []).length : q.type === "map" ? (q.points || []).length : 1;
    const name = q.type === "tfng" && q.variant === "yes-no" ? "yes/no/not given" : q.type;
    counts[name] = (counts[name] || 0) + size;
  }
  return counts;
}

function examOutline(exam) {
  return {
    examId: exam.examId,
    title: exam.title,
    testType: exam.testType,
    status: exam.status,
    sections: (exam.sections || []).map((section) => {
      if (Array.isArray(section.modules)) {
        return {
          type: section.type,
          modules: SAT_MODULE_BY_PART.map((match, i) => {
            const mod = section.modules.find(match);
            return mod && { part: i + 1, stage: mod.stage, difficulty: mod.difficulty || null, questions: mod.questions.length, types: typeCounts(mod.questions) };
          }).filter(Boolean),
        };
      }
      return {
        type: section.type,
        durationMinutes: section.durationMinutes,
        ...(section.variant ? { variant: section.variant } : {}),
        parts: (section.parts || []).map((part, i) => {
          if (section.type === "reading") {
            const ns = generator.readingNumbers(part);
            return { part: i + 1, headline: (part.passage || [])[0]?.slice(0, 120), words: (part.passage || []).join(" ").split(/\s+/).length, questions: `${Math.min(...ns)}-${Math.max(...ns)}`, types: typeCounts(part.questions || []) };
          }
          if (section.type === "listening") {
            const ns = generator.listeningNumbers(part);
            return { part: i + 1, title: part.title, questions: `${Math.min(...ns)}-${Math.max(...ns)}`, hasAudio: !!(part.audioUrl || section.audioUrl) };
          }
          return { part: i + 1, prompt: String(part.prompt || "").slice(0, 240), hasChart: !!part.chartImageUrl };
        }),
      };
    }),
  };
}

function capabilities() {
  return { audio: generator.audioAvailable(), images: generator.imagesAvailable() };
}

module.exports = { normalizeBlueprint, startBuild, startRevision, getJob, isBusy, examOutline, capabilities };
