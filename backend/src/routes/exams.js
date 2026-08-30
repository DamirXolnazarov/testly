/**
 * routes/exams.js
 * Admin-side exam management, backed by the Supabase store (services/store.js).
 * Every route here requires a valid admin JWT (requireAdmin middleware below —
 * see services/auth.js and routes/auth.js for login). POST /generate runs
 * examGenerator.js as a background job (see that route for why) — it returns
 * 202 immediately with a "generating" placeholder exam; poll GET /:id for
 * status. Everything else works end-to-end against Supabase.
 */

const express = require("express");
const router = express.Router();
const multer = require("multer");
const store = require("../services/store");
const examGenerator = require("../services/examGenerator");
const { requireAdmin } = require("../services/auth");
const { validateExam } = require("../services/examValidator");
const { extractAndMatch } = require("../services/examZipService");
const { MAX_BYTES } = require("../services/storageService");

const zipUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES * 5 } }); // zips are bigger than a single asset

router.use(requireAdmin);

// POST /api/exams  — create from admin-supplied JSON (matches docs/exam-json-schema.md)
router.post("/", async (req, res) => {
  const examData = req.body;
  const { valid, errors } = validateExam(examData);
  if (!valid) {
    return res.status(400).json({ error: "Exam JSON failed validation.", details: errors });
  }
  try {
    const exam = await store.createExam(examData);
    res.status(201).json(exam);
  } catch (e) {
    console.error("POST /api/exams failed", e);
    res.status(500).json({ error: "Could not create exam." });
  }
});

// POST /api/exams/generate  — kick off AI generation (topic/difficulty in body).
// Generation realistically takes 30-90+ seconds (multiple LLM calls, several
// image generations, four TTS calls, with retries) — far longer than most
// platforms' default request timeout. So this responds immediately with a
// placeholder exam in "generating" status and does the actual work in the
// background; the admin UI polls GET /api/exams/:id until status changes.
router.post("/generate", async (req, res) => {
  const { title, topic, difficulty } = req.body || {};
  let placeholder;
  try {
    placeholder = await store.createExam({
      title: title || `IELTS Mock — ${topic || "General"}`,
      sections: [],
      status: "generating",
    });
  } catch (e) {
    console.error("POST /api/exams/generate failed to create placeholder", e);
    return res.status(500).json({ error: "Could not start exam generation." });
  }

  res.status(202).json(placeholder);

  // Fire-and-forget: intentionally not awaited so the response above isn't
  // held open for the full generation time. Errors here are caught and
  // written onto the exam row (status + generation_error) rather than
  // thrown, since there's no request left to send them to.
  (async () => {
    try {
      const [reading, listening, writing] = await Promise.all([
        examGenerator.generateReadingSection({ topic, difficulty }),
        examGenerator.generateListeningSection({ topic, difficulty }),
        examGenerator.generateWritingSection({ taskTypes: ["task1", "task2"] }),
      ]);
      await store.updateExam(placeholder.examId, {
        sections: [reading, listening, writing],
        status: "draft",
        generationError: null,
      });
    } catch (e) {
      console.error(`Exam generation failed for ${placeholder.examId}`, e);
      await store.updateExam(placeholder.examId, {
        status: "generation_failed",
        generationError: e.message || "Unknown generation error.",
      });
    }
  })();
});

// POST /api/exams/upload-zip  — multipart, field "file" (a .zip)
// Bundles exam JSON + its media into one upload: name each audio/image file
// after the exact `id` it belongs to in the JSON (e.g. a listening part with
// "id": "l-part1" needs "l-part1.mp3" in the zip; a map question with
// "id": "r10" needs "r10.png"). See examZipService.js for the full matching
// rules and docs/exam-json-schema.md for the naming convention writeup.
//
// If any required slot has no matching file after extraction, the exam is
// still created (so the admin doesn't lose their JSON work) but forced into
// "draft" status regardless of what the JSON said — an incomplete listening
// section should never be a click away from going live by accident.
router.post("/upload-zip", zipUpload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file provided — send it as multipart form field \"file\"." });
  }
  try {
    const { exam, matched, unmatchedFiles, missingSlots } = await extractAndMatch(req.file.buffer, undefined);

    const { valid, errors } = validateExam(exam);
    if (!valid) {
      return res.status(400).json({ error: "Exam JSON in the zip failed validation.", details: errors });
    }

    const created = await store.createExam(exam);
    if (missingSlots.length > 0) {
      await store.updateExam(created.examId, { status: "draft" });
    }

    res.status(201).json({
      exam: { ...created, status: missingSlots.length > 0 ? "draft" : created.status },
      matched,
      unmatchedFiles,
      missingSlots,
    });
  } catch (e) {
    console.error("POST /api/exams/upload-zip failed", e);
    res.status(400).json({ error: e.message });
  }
});

// GET /api/exams  — list all exams (admin dashboard "My Exams" list)
router.get("/", async (req, res) => {
  try {
    const exams = (await store.listExams()).map(summarize);
    res.json(exams);
  } catch (e) {
    console.error("GET /api/exams failed", e);
    res.status(500).json({ error: "Could not list exams." });
  }
});

// GET /api/exams/:id  — full exam JSON for the admin editor (includes answer keys)
router.get("/:id", async (req, res) => {
  const exam = await store.getExam(req.params.id);
  if (!exam) return res.status(404).json({ error: "Exam not found." });
  res.json(exam);
});

// DELETE /api/exams/:id — mainly for clearing a "generation_failed" or
// unfinished "draft" exam so the admin can retry. Refuses to delete a
// "generating" exam (a background job may still write to it) or an
// "active"/"closed" exam (has real student sessions/results tied to it) —
// use PATCH status transitions for those instead.
router.delete("/:id", async (req, res) => {
  const exam = await store.getExam(req.params.id);
  if (!exam) return res.status(404).json({ error: "Exam not found." });
  if (exam.status === "active" || exam.status === "closed") {
    return res.status(409).json({ error: `Cannot delete an exam with status "${exam.status}".` });
  }
  if (exam.status === "generating") {
    return res.status(409).json({ error: "This exam is still generating — wait for it to finish or fail before deleting." });
  }
  const deleted = await store.deleteExam(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Exam not found." });
  res.status(200).json({ deleted: true });
});

// PATCH /api/exams/:id  — admin edits generated content before publishing
router.patch("/:id", async (req, res) => {
  if (req.body?.sections) {
    // Validate the would-be full exam (existing exam merged with the patch),
    // not just the patch in isolation — a patch that only touches `title`
    // shouldn't need sections revalidated, but one that touches sections
    // must be checked against the whole shape.
    const existing = await store.getExam(req.params.id);
    if (!existing) return res.status(404).json({ error: "Exam not found." });
    const merged = { ...existing, ...req.body };
    const { valid, errors } = validateExam(merged);
    if (!valid) {
      return res.status(400).json({ error: "Edited exam JSON failed validation.", details: errors });
    }
  }
  const exam = await store.updateExam(req.params.id, req.body || {});
  if (!exam) return res.status(404).json({ error: "Exam not found." });
  res.json(exam);
});

// POST /api/exams/:id/start  — admin taps "Start Test": activates the start code
router.post("/:id/start", async (req, res) => {
  const exam = await store.startExam(req.params.id);
  if (!exam) return res.status(404).json({ error: "Exam not found." });
  res.json({ examId: exam.examId, startCode: exam.startCode, status: exam.status });
});

// POST /api/exams/:id/stop  — admin ends the test window; code stops accepting new logins
router.post("/:id/stop", async (req, res) => {
  const exam = await store.stopExam(req.params.id);
  if (!exam) return res.status(404).json({ error: "Exam not found." });
  res.json({ examId: exam.examId, status: exam.status });
});

// GET /api/exams/:id/sessions  — completed-tests tab: every session for this exam
router.get("/:id/sessions", async (req, res) => {
  const exam = await store.getExam(req.params.id);
  if (!exam) return res.status(404).json({ error: "Exam not found." });
  const sessions = (await store.listSessionsForExam(req.params.id)).map((s) => ({
    sessionId: s.sessionId,
    fullName: s.fullName,
    status: s.status,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    results: s.results, // { reading: {rawScore, band}, listening: {...} } once graded
    sheetUrl: buildSheetRowUrl(exam.sheetId, s.sheetRowRange),
  }));
  res.json(sessions);
});

// POST /api/exams/:id/admit-all
// Bulk-admit every currently-waiting student — the "let everyone in at once"
// button for when the moderator is ready to start test day rather than
// admitting one at a time via the roster's individual admit buttons.
router.post("/:id/admit-all", async (req, res) => {
  const exam = await store.getExam(req.params.id);
  if (!exam) return res.status(404).json({ error: "Exam not found." });
  try {
    const roster = await store.getRoster(req.params.id);
    const admitted = await Promise.all(roster.pending.map((s) => store.admitSession(s.sessionId)));
    res.json({ admittedCount: admitted.length });
  } catch (e) {
    console.error("POST /api/exams/:id/admit-all failed", e);
    res.status(500).json({ error: "Could not admit students." });
  }
});
router.get("/:id/roster", async (req, res) => {
  const exam = await store.getExam(req.params.id);
  if (!exam) return res.status(404).json({ error: "Exam not found." });
  try {
    const roster = await store.getRoster(req.params.id);
    const trim = (s) => ({
      sessionId: s.sessionId,
      fullName: s.fullName,
      status: s.status,
      currentSection: s.currentSection,
      startedAt: s.startedAt,
      admittedAt: s.admittedAt,
      completedAt: s.completedAt,
      results: s.results,
      sheetUrl: buildSheetRowUrl(exam.sheetId, s.sheetRowRange),
    });
    res.json({
      pending: roster.pending.map(trim),
      inProgress: roster.inProgress.map(trim),
      completed: roster.completed.map(trim),
    });
  } catch (e) {
    console.error("GET /api/exams/:id/roster failed", e);
    res.status(500).json({ error: "Could not load roster." });
  }
});

// Builds a Google Sheets URL that jumps straight to a student's row, e.g.
// "Completed Tests!A5:M5" -> "...#gid=0&range=A5:M5". Returns null if either
// piece is missing (no sheetId set on the exam, or the Sheets write hasn't
// happened/succeeded yet) — the frontend treats null as "not available".
function buildSheetRowUrl(sheetId, rowRange) {
  if (!sheetId || !rowRange) return null;
  const cellRange = rowRange.includes("!") ? rowRange.split("!")[1] : rowRange;
  return `https://docs.google.com/spreadsheets/d/${sheetId}/edit#range=${cellRange}`;
}

// Trim the full (answer-key-bearing) exam down to list-view fields.
function summarize(exam) {
  return {
    examId: exam.examId,
    title: exam.title,
    status: exam.status,
    startCode: exam.startCode,
    createdAt: exam.createdAt,
    startedAt: exam.startedAt,
    sectionTypes: (exam.sections || []).map((s) => s.type),
    sheetId: exam.sheetId || null,
    generationError: exam.generationError || undefined,
  };
}

module.exports = router;