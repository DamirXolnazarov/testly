/**
 * routes/sessions.js
 * Uses the shared store (services/store.js) so exams created and started via
 * routes/exams.js are visible here. Server clock is the source of truth for
 * timing: `startedAt` + section duration determines expiry, never the
 * client's cosmetic <Timer /> display in IELTSCDReplica.jsx.
 */

const express = require("express");
const router = express.Router();
const store = require("../services/store");
const { gradeSection, buildAnswerKey } = require("../services/grader");
const { appendCompletedTestRow } = require("../services/sheetsService");
const { requireAdmin } = require("../services/auth");

// GET /api/sessions/:id
// Resume support: on page load/refresh, the client calls this to recover
// exam data + saved answers + section timing instead of losing the attempt.
// Server clock (sectionStartedAt) is the source of truth for remaining time —
// never trust a client-side timer that reset on reload.
// While status is "pending_admission", examData is withheld — a waiting
// student has no exam content until a moderator admits them.
router.get("/:id", async (req, res) => {
  try {
    const session = await store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found." });
    const exam = await store.getExam(session.examId);
    if (!exam) return res.status(404).json({ error: "Exam not found." });

    res.json({
      sessionId: session.sessionId,
      fullName: session.fullName,
      status: session.status,
      examStatus: exam.status,
      currentSection: session.currentSection || null,
      sectionStartedAt: session.sectionStartedAt || null,
      answers: session.answers,
      results: session.results || null,
      examData: session.status === "pending_admission" ? null : stripAnswerKeys(exam),
    });
  } catch (e) {
    console.error("GET /api/sessions/:id failed", e);
    res.status(500).json({ error: "Could not load session." });
  }
});

// GET /api/sessions/:id/status
// Lightweight — the waiting-room screen polls this every few seconds instead
// of GET /:id, since it doesn't need exam content until admitted.
router.get("/:id/status", async (req, res) => {
  try {
    const session = await store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found." });
    const exam = await store.getExam(session.examId);
    res.json({ status: session.status, examStatus: exam?.status || null });
  } catch (e) {
    console.error("GET /api/sessions/:id/status failed", e);
    res.status(500).json({ error: "Could not load session status." });
  }
});

// POST /api/sessions/:id/begin-section  { section }
// Stamps the server-side start time for a section the first time the student
// reaches it (idempotent — re-calling for the same section returns the
// original timestamp, so refreshing mid-section doesn't grant extra time).
router.post("/:id/begin-section", async (req, res) => {
  try {
    const session = await store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found." });
    if (session.status !== "in_progress") {
      return res.status(403).json({ error: "Not admitted into the exam yet." });
    }
    const { section } = req.body || {};
    if (!["reading", "listening", "writing"].includes(section)) {
      return res.status(400).json({ error: "Invalid section." });
    }
    const updated = await store.beginSection(req.params.id, section);
    res.json({ currentSection: updated.currentSection, sectionStartedAt: updated.sectionStartedAt });
  } catch (e) {
    if (e.code === "SECTION_ORDER" || e.code === "SECTION_TIME_NOT_UP") {
      return res.status(403).json({ error: e.message, code: e.code });
    }
    console.error("POST /api/sessions/:id/begin-section failed", e);
    res.status(500).json({ error: "Could not start section." });
  }
});

// POST /api/sessions  { code, fullName }
// Student submits their start code + info at the end of PreTestFlow.
// This does NOT start the exam — it creates a session in "pending_admission"
// and the student is sent to a waiting room until a moderator admits them.
router.post("/", async (req, res) => {
  const { code, fullName } = req.body || {};
  if (!code || typeof code !== "string") {
    return res.status(400).json({ error: "Missing start code." });
  }
  try {
    const examId = await store.resolveStartCode(code);
    if (!examId) return res.status(404).json({ error: "That code isn't active yet." });
    const exam = await store.getExam(examId);
    if (!exam) return res.status(404).json({ error: "Exam not found for this code." });

    const session = await store.createSession(examId, fullName, exam);
    res.json({ sessionId: session.sessionId, status: session.status, examTitle: exam.title });
  } catch (e) {
    console.error("POST /api/sessions failed", e);
    res.status(500).json({ error: "Could not start session." });
  }
});

// ---- Moderator-only routes below ----

// POST /api/sessions/:id/admit
// The moderator lets one waiting student into the actual exam. This is what
// actually starts their clock — POST /:id/begin-section (called by the first
// section they load) stamps section_started_at only after this succeeds.
router.post("/:id/admit", requireAdmin, async (req, res) => {
  try {
    const session = await store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found." });
    const exam = await store.getExam(session.examId);
    if (!exam || exam.centerId == null || req.admin.centerId == null || exam.centerId !== req.admin.centerId) {
      return res.status(404).json({ error: "Session not found." });
    }
    const updated = await store.admitSession(req.params.id);
    if (!updated) return res.status(404).json({ error: "Session not found." });
    res.json({ sessionId: updated.sessionId, status: updated.status });
  } catch (e) {
    console.error("POST /api/sessions/:id/admit failed", e);
    res.status(500).json({ error: "Could not admit student." });
  }
});

// PATCH /api/sessions/:id/answers  { section, answers }
// Debounced autosave — called on every answer change (~800ms debounce client-side).
router.patch("/:id/answers", async (req, res) => {
  try {
    const session = await store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found." });
    if (session.status !== "in_progress") {
      return res.status(409).json({ error: "Session already submitted." });
    }
    const { section, answers } = req.body || {};
    if (!["reading", "listening", "writing"].includes(section)) {
      return res.status(400).json({ error: "Invalid section." });
    }
    // Only the section the student is actually on can be written to — once
    // begin-section has moved them past reading, a request still claiming
    // section: "reading" (a stale tab, a replayed request, or a direct API
    // call) must not silently keep editing already-locked answers.
    if (session.currentSection && section !== session.currentSection) {
      return res.status(403).json({ error: `You're no longer on the ${section} section.` });
    }
    // Server-side time cutoff — belt-and-braces alongside begin-section's
    // own gate. Covers the case where a client's local timer never fires
    // onExpire (a background/throttled tab, a JS error, clock drift) and
    // the student is otherwise left able to keep answering past real time.
    if (session.sectionStartedAt) {
      const exam = await store.getExam(session.examId);
      const durationMinutes = store.getSectionDurationMinutes(exam, section);
      const elapsedMs = Date.now() - Date.parse(session.sectionStartedAt);
      const GRACE_MS = 10000; // brief buffer for an in-flight save right at the boundary
      if (elapsedMs > durationMinutes * 60 * 1000 + GRACE_MS) {
        return res.status(403).json({ error: `Time is up for the ${section} section.` });
      }
    }
    await store.saveAnswers(req.params.id, section, answers);
    res.json({ ok: true, savedAt: Date.now() });
  } catch (e) {
    console.error("PATCH /api/sessions/:id/answers failed", e);
    res.status(500).json({ error: "Could not save answers." });
  }
});

// POST /api/sessions/:id/submit
// Grades reading/listening, writes the completed-test row to Google Sheets,
// marks the session done. Writing is stored raw for manual grading later.
router.post("/:id/submit", async (req, res) => {
  try {
    const session = await store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found." });
    if (session.status !== "in_progress") {
      return res.status(409).json({ error: "Session already submitted." });
    }

    const exam = await store.getExam(session.examId);
    const readingSection = exam.sections.find((s) => s.type === "reading");
    const listeningSection = exam.sections.find((s) => s.type === "listening");

    const readingResult = readingSection
      ? gradeSection(session.answers.reading, buildAnswerKey(readingSection))
      : null;
    const listeningResult = listeningSection
      ? gradeSection(session.answers.listening, buildAnswerKey(listeningSection))
      : null;

    const results = { reading: readingResult, listening: listeningResult };
    await store.completeSession(req.params.id, results);

    await writeSheetRowSafely({ sessionId: req.params.id, session, exam, results });

    // Hand the real scores back so the student sees an actual results screen,
    // not just a generic "thanks" message.
    res.json({ ok: true, results });
  } catch (e) {
    console.error("POST /api/sessions/:id/submit failed", e);
    res.status(500).json({ error: "Could not submit test." });
  }
});

// POST /api/sessions/:id/retry-sheet-write  — admin-only. For a session
// whose original Sheets write failed (session.sheetError is set) — retries
// after the admin has presumably fixed the underlying cause (missing
// sheetId, sharing permissions, etc.) without making the student re-take
// anything. Uses the already-stored `results` from when they submitted.
router.post("/:id/retry-sheet-write", requireAdmin, async (req, res) => {
  try {
    const session = await store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found." });
    if (session.status !== "completed") {
      return res.status(409).json({ error: "This session hasn't been submitted yet." });
    }
    const exam = await store.getExam(session.examId);
    if (!exam) return res.status(404).json({ error: "Exam not found." });
    if (exam.centerId == null || req.admin.centerId == null || exam.centerId !== req.admin.centerId) {
      return res.status(404).json({ error: "Session not found." });
    }

    const ok = await writeSheetRowSafely({ sessionId: req.params.id, session, exam, results: session.results || {} });
    if (!ok) {
      const updated = await store.getSession(req.params.id);
      return res.status(502).json({ error: updated.sheetError || "Sheets write failed again." });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/sessions/:id/retry-sheet-write failed", e);
    res.status(500).json({ error: "Could not retry the Sheets write." });
  }
});

/** Shared by the submit handler and the retry route. Never throws — always
 * resolves to true/false so callers can decide what to do next; the
 * student's submission (in the main handler) must never fail because of
 * this. Records the failure reason on the session either way. */
async function writeSheetRowSafely({ sessionId, session, exam, results }) {
  const row = {
    student_name: session.fullName,
    exam_id: session.examId,
    exam_title: exam.title,
    date: new Date().toISOString().slice(0, 10),
    reading_raw: results.reading?.rawScore ?? "",
    reading_band: results.reading?.band ?? "",
    listening_raw: results.listening?.rawScore ?? "",
    listening_band: results.listening?.band ?? "",
    writing_task1_band: "", // filled manually by admin
    writing_task2_band: "", // filled manually by admin
    speaking_band: "",      // filled manually by admin
    overall_band: "",       // computed once all four are in (admin dashboard, not here)
    status: "awaiting_manual_grading",
  };

  try {
    const { range } = await appendCompletedTestRow({ spreadsheetId: exam.sheetId, row });
    if (range) await store.setSheetRowRange(sessionId, range);
    return true;
  } catch (e) {
    // Don't fail the student's submission if Sheets write fails — the score
    // is already saved in `results` regardless. This previously only went
    // to console.error, invisible outside server logs. Recording it here
    // lets the Sessions view surface exactly what went wrong, and the
    // retry route lets the admin fix the cause and get the row written
    // without the student re-taking the exam.
    console.error("Sheets write failed for session", sessionId, e);
    try {
      await store.setSheetError(sessionId, e.message || "Unknown error writing to Google Sheets.");
    } catch (e2) {
      console.error("Additionally failed to record the sheet error itself for session", sessionId, e2);
    }
    return false;
  }
}

// ---- helper: strip server-only answer keys before sending exam JSON to student ----
// Strips every answer-key location a student's exam payload must never
// contain. Previously this only ever did `delete q.answer` on each
// top-level question/item — which is correct for mcq/tfng/gap-fill/matching
// (their answer lives right on the question object), but is a no-op for
// every other question type, since none of them keep their answer there:
//   - listening: the real answers live in item.lines[].answer, one level
//     deeper than what was being touched — every listening answer key was
//     being sent to students in full, undetected.
//   - reading table: answers live in q.gaps[].answer, not q.answer.
//   - reading map: answers live in q.points[].answer, not q.answer.
//   - "choose two, either order" listening groups: the answer set lives in
//     item.unorderedGroup.answers (see grader.js), a location that didn't
//     exist in the old shape at all.
// This now mirrors grader.js's buildAnswerKey() traversal exactly, since
// that function is the authoritative map of every place an answer key can
// live — anywhere it reads from, this must strip.
function stripAnswerKeys(exam) {
  const clone = JSON.parse(JSON.stringify(exam));
  for (const section of clone.sections || []) {
    for (const part of section.parts || []) {
      for (const q of part.questions || []) {
        delete q.answer;
        if (Array.isArray(q.gaps)) {
          for (const g of q.gaps) delete g.answer;
        }
        if (Array.isArray(q.points)) {
          for (const pt of q.points) delete pt.answer;
        }
      }
      for (const item of part.items || []) {
        delete item.unorderedGroup; // carries the answers[] for "choose two, either order" groups
        for (const line of item.lines || []) {
          delete line.answer;
        }
      }
      delete part.transcript; // listening transcripts are server-only too
    }
  }
  return clone;
}

module.exports = router;