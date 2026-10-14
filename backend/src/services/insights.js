/**
 * insights.js
 * Where a class loses marks on one exam: accuracy by question type (IELTS)
 * or by skill area (SAT), and the questions the fewest students got right.
 *
 * Worked out by re-marking each completed session's saved answers against
 * the exam as it stands, rather than from stored per-question results, so
 * it works for every past session (SAT results only ever stored totals)
 * and always uses one consistent marking.
 */

const { buildAnswerKey, gradeSection, buildSatModuleAnswerKey, gradeSatModule } = require("./grader");

const READING_LABELS = {
  tfng: "True / False / Not Given",
  "yes-no": "Yes / No / Not Given",
  mcq: "Multiple choice",
  "gap-fill": "Sentence and summary completion",
  matching: "Matching",
  headings: "Matching headings",
  table: "Table completion",
  map: "Diagram labelling",
};

const snippet = (text) => String(text || "").replace(/\s+/g, " ").trim().slice(0, 140);

/** Question number -> { label, text } for an IELTS reading or listening section. */
function ieltsIndex(section) {
  const index = new Map();
  for (const part of section.parts || []) {
    for (const item of part.items || []) {
      for (const line of item.lines || []) {
        if (line.n !== undefined) index.set(line.n, { label: "Note and form completion", text: `${line.pre || ""} ____ ${line.post || ""}` });
      }
    }
    for (const q of part.questions || []) {
      const label =
        q.type === "tfng" ? READING_LABELS[q.variant === "yes-no" ? "yes-no" : "tfng"]
        : q.type === "matching" && Array.isArray(q.optionLetters) ? READING_LABELS.headings
        : READING_LABELS[q.type] || q.type;
      if (q.type === "table") (q.gaps || []).forEach((g) => index.set(g.n, { label, text: (q.table?.headers || []).join(" / ") }));
      else if (q.type === "map") (q.points || []).forEach((p) => index.set(p.n, { label, text: "Diagram point" }));
      else index.set(q.n, { label, text: q.prompt || `${q.before || ""} ____ ${q.after || ""}` });
    }
  }
  return index;
}

/** True when a student typed or chose anything in a section's answers. */
function answered(answers) {
  if (!answers || typeof answers !== "object") return false;
  return Object.entries(answers).some(([k, v]) => !k.startsWith("__") && (typeof v === "object" ? answered(v) : v !== "" && v !== null && v !== undefined));
}

function tally(map, key, correct, extra) {
  const entry = map.get(key) || { ...extra, correct: 0, attempts: 0 };
  entry.attempts += 1;
  if (correct) entry.correct += 1;
  map.set(key, entry);
}

function finish(categories, questions) {
  const pct = (e) => Math.round((e.correct / e.attempts) * 100);
  return {
    categories: [...categories.values()].map((e) => ({ ...e, pct: pct(e) })).sort((a, b) => a.pct - b.pct),
    hardest: [...questions.values()].map((e) => ({ ...e, pct: pct(e) })).sort((a, b) => a.pct - b.pct || b.attempts - a.attempts).slice(0, 6),
  };
}

/**
 * @param {Object} exam
 * @param {Array} sessions - from store.listSessionsForExam
 */
function examInsights(exam, sessions) {
  const completed = sessions.filter((s) => s.status === "completed" && s.answers);
  const sections = [];

  if (exam.testType === "sat") {
    for (const section of exam.sections || []) {
      const categories = new Map();
      const questions = new Map();
      for (const s of completed) {
        const answers = s.answers?.[section.type] || {};
        const routedTo = s.answers?.sat?.[section.type]?.routedTo;
        if (!routedTo && !answered(answers)) continue; // never reached this section
        const taken = (section.modules || []).filter((m) => m.stage === "module1" || (m.stage === "module2" && m.difficulty === routedTo));
        for (const mod of taken) {
          const graded = gradeSatModule(answers, buildSatModuleAnswerKey(mod));
          for (const result of graded.perQuestion) {
            const q = mod.questions.find((x) => x.id === result.id);
            if (!q) continue;
            const label = q.skill || (q.type === "grid-in" ? "Student-produced response" : "Multiple choice");
            tally(categories, label, result.correct, { label });
            const moduleName = mod.stage === "module1" ? "Module 1" : `Module 2 (${mod.difficulty === "hard" ? "harder" : "easier"})`;
            tally(questions, `${mod.id}:${q.id}`, result.correct, { label, n: q.n, module: moduleName, text: snippet(q.prompt) });
          }
        }
      }
      if (categories.size) sections.push({ type: section.type, name: section.type === "math" ? "Math" : "Reading and Writing", ...finish(categories, questions) });
    }
  } else {
    for (const section of (exam.sections || []).filter((s) => s.type === "reading" || s.type === "listening")) {
      const index = ieltsIndex(section);
      const key = buildAnswerKey(section);
      const categories = new Map();
      const questions = new Map();
      for (const s of completed) {
        if (!answered(s.answers?.[section.type])) continue; // never reached this section
        const graded = gradeSection(s.answers[section.type], key);
        for (const result of graded.perQuestion) {
          const info = index.get(result.n);
          if (!info) continue;
          tally(categories, info.label, result.correct, { label: info.label });
          tally(questions, result.n, result.correct, { label: info.label, n: result.n, text: snippet(info.text) });
        }
      }
      if (categories.size) sections.push({ type: section.type, name: section.type === "reading" ? "Reading" : "Listening", ...finish(categories, questions) });
    }
  }

  return { completed: completed.length, sections };
}

module.exports = { examInsights };
