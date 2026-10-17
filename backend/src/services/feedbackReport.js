/**
 * feedbackReport.js
 * The student's copy of their marked IELTS Writing: their essays with the
 * teacher's annotations, the criterion and task bands, the teacher's notes,
 * and the bands for the whole test. Served at a private link
 * (/feedback/<token>, routes/feedback.js) that the teacher emails to the
 * student from the marking screen (POST /api/sessions/:id/feedback/send).
 *
 * Only what the teacher saved goes out — AI suggestions the teacher never
 * accepted are not stored, so they never reach the student.
 */

const crypto = require("crypto");
const { sendEmail } = require("./emailService");

const FRONTEND_URL = () => (process.env.FRONTEND_URL || "https://testly-mock.vercel.app").replace(/\/$/, "");

function newFeedbackToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function feedbackUrl(token) {
  return `${FRONTEND_URL()}/feedback/${token}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return EMAIL_RE.test(email) && email.length <= 254 ? email : null;
}

/** What the student's feedback page shows. */
function buildReport(session, exam) {
  const section = (exam.sections || []).find((s) => s.type === "writing");
  const reading = (exam.sections || []).find((s) => s.type === "reading");
  const marked = session.results?.writing?.tasks || [];
  const tasks = (section?.parts || []).map((part, i) => {
    const given = session.answers?.writing?.[part.id];
    const mark = marked.find((m) => m?.id === part.id) || null;
    return {
      id: part.id,
      number: i + 1,
      prompt: part.prompt || "",
      chartImageUrl: part.chartImageUrl || null,
      minWords: part.minWords || null,
      text: given?.text || "",
      words: given?.words || 0,
      criteria: mark?.criteria || {},
      band: mark?.band ?? null,
      feedback: mark?.feedback || "",
      annotations: mark?.annotations || [],
    };
  });
  return {
    fullName: session.fullName,
    examTitle: exam.title,
    takenAt: session.completedAt || session.startedAt,
    general: reading?.variant === "general",
    tasks,
    bands: {
      reading: session.results?.reading?.band ?? null,
      listening: session.results?.listening?.band ?? null,
      writing: session.results?.writing?.band ?? null,
      speaking: session.results?.speaking?.band ?? null,
      overall: session.results?.overall?.band ?? null,
    },
    markedAt: session.results?.writing?.markedAt || null,
  };
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Emails the student the link to their marked writing. */
async function sendFeedbackEmail({ to, session, exam, url }) {
  const report = buildReport(session, exam);
  const firstName = String(report.fullName || "").trim().split(/\s+/)[0] || "there";
  const rows = [["Reading", report.bands.reading], ["Listening", report.bands.listening], ["Writing", report.bands.writing], ["Speaking", report.bands.speaking]]
    .filter(([, band]) => band !== null && band !== undefined)
    .map(([label, band]) => `<td style="padding:10px 14px;border:1px solid #E7E8F2;border-radius:8px;text-align:center;"><div style="font-size:11px;color:#5B6178;text-transform:uppercase;letter-spacing:.5px;">${label}</div><div style="font-size:20px;font-weight:700;color:#111D40;">${Number(band).toFixed(1)}</div></td>`)
    .join('<td style="width:8px;"></td>');
  const notes = report.tasks.reduce((n, t) => n + t.annotations.length, 0);

  await sendEmail({
    attempts: 1, // a teacher is watching a spinner — fail fast rather than retry for minutes
    to,
    subject: `Your marked writing — ${report.examTitle}`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#111D40;max-width:560px;">
        <p>Hi ${escapeHtml(firstName)},</p>
        <p>Your teacher has marked your writing from <strong>${escapeHtml(report.examTitle)}</strong>.${notes ? ` They left ${notes} note${notes === 1 ? "" : "s"} on your essays.` : ""}</p>
        ${rows ? `<table style="border-collapse:separate;margin:18px 0;"><tr>${rows}</tr></table>` : ""}
        ${report.bands.overall !== null ? `<p style="font-size:15px;">Overall band: <strong style="color:#5B50E6;font-size:18px;">${Number(report.bands.overall).toFixed(1)}</strong></p>` : ""}
        <p style="margin:24px 0;"><a href="${url}" style="background:#5B50E6;color:#fff;padding:12px 20px;border-radius:9px;text-decoration:none;font-weight:600;">See your marked essays →</a></p>
        <p style="color:#5B6178;font-size:12px;">This link is just for you. Anyone you share it with can read your essays and marks.</p>
      </div>
    `,
  });
}

module.exports = { newFeedbackToken, feedbackUrl, normalizeEmail, buildReport, sendFeedbackEmail };
