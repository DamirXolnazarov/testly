/**
 * routes/exams.js
 * Admin-side exam management, backed by the Supabase store (services/store.js).
 * Every route here requires a valid admin JWT (requireAdmin middleware below —
 * see services/auth.js and routes/auth.js for login). POST /generate starts
 * an AI build as a background job (examBuilder.js) — it returns 202
 * immediately with a "generating" placeholder exam; poll GET /:id for
 * status. Everything else works end-to-end against Supabase.
 */

const express = require("express");
const router = express.Router();
const multer = require("multer");
const store = require("../services/store");
const { normalizeBlueprint, startBuild } = require("../services/examBuilder");
const { requireAdmin } = require("../services/auth");
const { validateExam } = require("../services/examValidator");
const { extractAndMatch } = require("../services/examZipService");
const { examInsights } = require("../services/insights");
const { MAX_BYTES } = require("../services/storageService");

const zipUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES * 5 } }); // zips are bigger than a single asset

router.use(requireAdmin);

// Multi-tenant boundary check. Returns false (deny) unless both sides have
// a real, matching center_id — an admin or exam with a null center_id
// (shouldn't happen post-backfill, but fails closed rather than open if it
// ever does) can't see or touch anything. Callers respond 404 rather than
// 403 on a mismatch, so a center can't even learn that another center's
// exam ID exists.
function belongsToCenter(exam, admin) {
  return exam.centerId != null && admin.centerId != null && exam.centerId === admin.centerId;
}

// POST /api/exams  — create from admin-supplied JSON (matches docs/exam-json-schema.md)
router.post("/", async (req, res) => {
  const examData = req.body;
  const { valid, errors } = validateExam(examData);
  if (!valid) {
    return res.status(400).json({ error: "Exam JSON failed validation.", details: errors });
  }
  try {
    const exam = await store.createExam({ ...examData, centerId: req.admin.centerId });
    res.status(201).json(exam);
  } catch (e) {
    console.error("POST /api/exams failed", e);
    res.status(500).json({ error: "Could not create exam." });
  }
});

// POST /api/exams/generate  — one-shot AI generation of a full IELTS mock
// from just a topic and difficulty. AI Studio (routes/ai.js) is the main way
// to create an exam with AI now; this stays as the no-conversation shortcut
// and runs through the same builder. It responds immediately with a
// placeholder exam in "generating" status and does the work in the
// background — poll GET /api/ai/jobs/:id (or GET /api/exams/:id) for status.
router.post("/generate", async (req, res) => {
  const { title, topic, difficulty } = req.body || {};
  const topics = topic ? [String(topic)] : [];
  const { blueprint, errors } = normalizeBlueprint({
    title: title || `IELTS Mock — ${topic || "General"}`,
    testType: "ielts",
    difficulty,
    variant: "academic",
    sections: [
      { type: "reading", topics, notes: "" },
      { type: "listening", topics, notes: "" },
      { type: "writing", topics: [], notes: "" },
    ],
  });
  if (!blueprint) return res.status(400).json({ error: "Could not start exam generation.", details: errors });
  try {
    const { exam } = await startBuild({ blueprint, centerId: req.admin.centerId });
    res.status(202).json(exam);
  } catch (e) {
    console.error("POST /api/exams/generate failed to start", e);
    res.status(500).json({ error: "Could not start exam generation." });
  }
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

    const created = await store.createExam({ ...exam, centerId: req.admin.centerId });
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
    const exams = (await store.listExams(req.admin.centerId)).map(summarize);
    res.json(exams);
  } catch (e) {
    console.error("GET /api/exams failed", e);
    res.status(500).json({ error: "Could not list exams." });
  }
});

// GET /api/exams/:id  — full exam JSON for the admin editor (includes answer keys)
router.get("/:id", async (req, res) => {
  const exam = await store.getExam(req.params.id);
  if (!exam || !belongsToCenter(exam, req.admin)) return res.status(404).json({ error: "Exam not found." });
  res.json(exam);
});

// DELETE /api/exams/:id — mainly for clearing a "generation_failed" or
// unfinished "draft" exam so the admin can retry. Refuses to delete a
// "generating" exam (a background job may still write to it) or an
// "active"/"closed" exam (has real student sessions/results tied to it) —
// use PATCH status transitions for those instead.
router.delete("/:id", async (req, res) => {
  const exam = await store.getExam(req.params.id);
  if (!exam || !belongsToCenter(exam, req.admin)) return res.status(404).json({ error: "Exam not found." });
  // active/paused are still blocked: deleting a live exam out from under
  // students currently testing would break their session mid-exam. closed
  // is now allowed — the admin dashboard added a Delete button for closed
  // exams (cascades to sessions/results, schema.sql handles that via
  // "on delete cascade"), so a finished exam can be cleaned up like any
  // other, with a corresponding warning shown client-side first.
  if (exam.status === "active" || exam.status === "paused") {
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
  const existing = await store.getExam(req.params.id);
  if (!existing || !belongsToCenter(existing, req.admin)) return res.status(404).json({ error: "Exam not found." });

  // Content can't change under students who are sitting the exam: their
  // answers are keyed to the questions as they were when they started.
  // (The reading-scale toggle below is exempt — it only picks a band table.)
  if (req.body?.sections && ["active", "paused", "generating"].includes(existing.status)) {
    return res.status(409).json({ error: `This exam is ${existing.status === "generating" ? "still being built" : "live"} — its content can't be edited right now.` });
  }

  // `ieltsVariant` ("academic" | "general") is stored on the reading section
  // inside the sections JSONB (no schema column). Translate it into a sections
  // patch so the generic update path below persists + revalidates it.
  if (req.body?.ieltsVariant !== undefined) {
    if (!["academic", "general"].includes(req.body.ieltsVariant)) {
      return res.status(400).json({ error: 'ieltsVariant must be "academic" or "general".' });
    }
    const sections = (req.body.sections || existing.sections || []).map((s) =>
      s.type === "reading" ? { ...s, variant: req.body.ieltsVariant } : s
    );
    req.body.sections = sections;
    delete req.body.ieltsVariant;
  }

  if (req.body?.sections) {
    // Validate the would-be full exam (existing exam merged with the patch),
    // not just the patch in isolation — a patch that only touches `title`
    // shouldn't need sections revalidated, but one that touches sections
    // must be checked against the whole shape.
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
  const existing = await store.getExam(req.params.id);
  if (!existing || !belongsToCenter(existing, req.admin)) return res.status(404).json({ error: "Exam not found." });

  // examValidator deliberately allows a null audioUrl (a listening section
  // can be saved as a draft while TTS/audio generation is still running),
  // but a null audioUrl reaching a REAL, live exam is a different problem:
  // ListeningModule silently falls back to a fake, silent simulated
  // countdown with no real audio at all — indistinguishable to the student
  // from "audio is playing", with no error shown anywhere. Catching it here
  // (the one place that actually launches a real exam) instead of at save
  // time keeps drafts flexible while making sure this can't reach students.
  const missingAudio = [];
  for (const section of existing.sections || []) {
    if (section.type !== "listening") continue;
    if (section.audioUrl) continue; // single continuous recording covers the whole section
    (section.parts || []).forEach((part, i) => {
      if (!part.audioUrl) missingAudio.push(`Listening Part ${i + 1}`);
    });
  }
  if (missingAudio.length > 0) {
    return res.status(400).json({
      error: `This exam can't go live — missing listening audio for: ${missingAudio.join(", ")}. Students would hear nothing but see no error.`,
    });
  }

  const exam = await store.startExam(req.params.id);
  if (!exam) return res.status(404).json({ error: "Exam not found." });
  res.json({ examId: exam.examId, startCode: exam.startCode, status: exam.status });
});

// POST /api/exams/:id/pause — admin pauses a live exam mid-session. Every
// waiting student's poll (ExamSession.jsx) picks this up within a few
// seconds and shows a "please wait, exam is paused" screen; students
// already mid-section keep their in-progress answers, nothing is lost.
// This route existed on the frontend (AdminTestRoom.jsx's "Pause exam"
// button, and ExamSession.jsx's full resume-from-pause handling) with no
// matching backend route at all — pausing a live exam has been a dead,
// silently-failing button until this was added.
router.post("/:id/pause", async (req, res) => {
  const exam = await store.getExam(req.params.id);
  if (!exam || !belongsToCenter(exam, req.admin)) return res.status(404).json({ error: "Exam not found." });
  if (exam.status !== "active") {
    return res.status(409).json({ error: `Can only pause an active exam (current status: "${exam.status}").` });
  }
  const updated = await store.pauseExam(req.params.id);
  res.json({ examId: updated.examId, status: updated.status });
});

// POST /api/exams/:id/resume — reverses /pause. Deliberately only allowed
// from "paused" (not e.g. "draft") so this can't be misused as a second
// way to activate a brand-new exam — that's what /start is for.
// store.resumeExam shifts every in-progress session's section_started_at
// forward by however long the exam was paused, so the pause doesn't
// silently eat into students' remaining section time (see its comment).
router.post("/:id/resume", async (req, res) => {
  const exam = await store.getExam(req.params.id);
  if (!exam || !belongsToCenter(exam, req.admin)) return res.status(404).json({ error: "Exam not found." });
  if (exam.status !== "paused") {
    return res.status(409).json({ error: `Can only resume a paused exam (current status: "${exam.status}").` });
  }
  const updated = await store.resumeExam(req.params.id);
  res.json({ examId: updated.examId, status: updated.status });
});

// POST /api/exams/:id/stop  — admin ends the test window; code stops accepting new logins
router.post("/:id/stop", async (req, res) => {
  const existing = await store.getExam(req.params.id);
  if (!existing || !belongsToCenter(existing, req.admin)) return res.status(404).json({ error: "Exam not found." });
  const exam = await store.stopExam(req.params.id);
  if (!exam) return res.status(404).json({ error: "Exam not found." });
  res.json({ examId: exam.examId, status: exam.status });
});

// GET /api/exams/:id/sessions  — completed-tests tab: every session for this exam
router.get("/:id/sessions", async (req, res) => {
  const exam = await store.getExam(req.params.id);
  if (!exam || !belongsToCenter(exam, req.admin)) return res.status(404).json({ error: "Exam not found." });
  const sessions = (await store.listSessionsForExam(req.params.id)).map((s) => ({
    sessionId: s.sessionId,
    fullName: s.fullName,
    studentEmail: s.studentEmail,
    feedbackSentAt: s.feedbackSentAt,
    status: s.status,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    results: s.results, // { reading: {rawScore, band}, listening: {...} } once graded
    sheetUrl: buildSheetRowUrl(exam.sheetId, s.sheetRowRange),
    sheetError: s.sheetError || null,
  }));
  res.json(sessions);
});

// POST /api/exams/:id/duplicate — a new draft with the same content (and a
// new start code), for re-running a mock or making a variant of it.
router.post("/:id/duplicate", async (req, res) => {
  const exam = await store.getExam(req.params.id);
  if (!exam || !belongsToCenter(exam, req.admin)) return res.status(404).json({ error: "Exam not found." });
  if (exam.status === "generating" || !(exam.sections || []).length) {
    return res.status(409).json({ error: "This exam has no content to copy yet." });
  }
  try {
    const copy = await store.createExam({
      title: `${exam.title} (copy)`.slice(0, 140),
      testType: exam.testType,
      sections: exam.sections,
      status: "draft",
      centerId: req.admin.centerId,
    });
    res.status(201).json(summarize(copy));
  } catch (e) {
    console.error("POST /api/exams/:id/duplicate failed", e);
    res.status(500).json({ error: "Could not copy the exam." });
  }
});

// GET /api/exams/:id/insights — where the class loses marks: accuracy by
// question type (IELTS) or skill area (SAT), and the hardest questions.
router.get("/:id/insights", async (req, res) => {
  const exam = await store.getExam(req.params.id);
  if (!exam || !belongsToCenter(exam, req.admin)) return res.status(404).json({ error: "Exam not found." });
  try {
    res.json(examInsights(exam, await store.listSessionsForExam(req.params.id)));
  } catch (e) {
    console.error("GET /api/exams/:id/insights failed", e);
    res.status(500).json({ error: "Could not work out the insights." });
  }
});

// POST /api/exams/:id/admit-all
// Bulk-admit every currently-waiting student — the "let everyone in at once"
// button for when the moderator is ready to start test day rather than
// admitting one at a time via the roster's individual admit buttons.
router.post("/:id/admit-all", async (req, res) => {
  const exam = await store.getExam(req.params.id);
  if (!exam || !belongsToCenter(exam, req.admin)) return res.status(404).json({ error: "Exam not found." });
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
  if (!exam || !belongsToCenter(exam, req.admin)) return res.status(404).json({ error: "Exam not found." });
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
      sheetError: s.sheetError || null,
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
    testType: exam.testType,
    status: exam.status,
    startCode: exam.startCode,
    createdAt: exam.createdAt,
    startedAt: exam.startedAt,
    sectionTypes: (exam.sections || []).map((s) => s.type),
    sheetId: exam.sheetId || null,
    // Academic (default) vs General Training reading — drives the band table.
    ieltsVariant:
      (exam.sections || []).find((s) => s.type === "reading")?.variant === "general"
        ? "general"
        : "academic",
    generationError: exam.generationError || undefined,
  };
}

module.exports = router;