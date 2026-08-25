/**
 * routes/exams.js
 * Admin-side exam management, backed by the Supabase store (services/store.js).
 * Every route here requires a valid admin JWT (requireAdmin middleware below —
 * see services/auth.js and routes/auth.js for login). Exam generation itself
 * (examGenerator.js) is still a stub — POST /generate returns 501 until
 * that's implemented; everything else works end-to-end against Supabase.
 */

const express = require("express");
const router = express.Router();
const store = require("../services/store");
const examGenerator = require("../services/examGenerator");
const { requireAdmin } = require("../services/auth");
const { validateExam } = require("../services/examValidator");

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

// POST /api/exams/generate  — AI-generate a full exam (topic/difficulty in body)
router.post("/generate", async (req, res) => {
  try {
    const { title, topic, difficulty } = req.body || {};
    const [reading, listening, writing] = await Promise.all([
      examGenerator.generateReadingSection({ topic, difficulty }),
      examGenerator.generateListeningSection({ topic, difficulty }),
      examGenerator.generateWritingSection({ taskTypes: ["task1", "task2"] }),
    ]);
    const exam = await store.createExam({
      title: title || `IELTS Mock — ${topic || "General"}`,
      sections: [reading, listening, writing],
    });
    res.status(201).json(exam);
  } catch (e) {
    // examGenerator isn't implemented yet — surface that clearly rather than
    // a generic 500, so the admin UI can show "AI generation coming soon".
    res.status(501).json({ error: "Exam generation isn't implemented yet.", detail: e.message });
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

router.post("/:id/pause", async (req, res) => {
  const exam = await store.setExamStatus(req.params.id, "paused");
  if (!exam) return res.status(404).json({ error: "Exam not found." });
  res.json({ examId: exam.examId, status: exam.status });
});

router.post("/:id/resume", async (req, res) => {
  const exam = await store.setExamStatus(req.params.id, "active");
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
      proctorEvents: store.getProctorEvents(s.sessionId),
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
  };
}

module.exports = router;