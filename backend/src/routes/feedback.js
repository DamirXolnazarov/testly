/**
 * routes/feedback.js
 * GET /api/feedback/:token — public. A student's marked writing, for the
 * page their teacher emailed them a link to (frontend/src/pages/feedback/
 * [token].jsx). The token is the only key: long, random, and made only when
 * a teacher sends the feedback (see feedbackReport.js).
 */

const express = require("express");
const router = express.Router();
const store = require("../services/store");
const { buildReport } = require("../services/feedbackReport");

router.get("/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "");
    if (token.length < 20) return res.status(404).json({ error: "This feedback link isn't valid." });
    const session = await store.getSessionByFeedbackToken(token);
    if (!session) return res.status(404).json({ error: "This feedback link isn't valid." });
    const exam = await store.getExam(session.examId);
    if (!exam) return res.status(404).json({ error: "This feedback link isn't valid." });
    res.json(buildReport(session, exam));
  } catch (e) {
    console.error("GET /api/feedback/:token failed", e);
    res.status(500).json({ error: "Could not load this feedback." });
  }
});

module.exports = router;
