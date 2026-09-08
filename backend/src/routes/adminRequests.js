/**
 * routes/adminRequests.js
 * Public admin-access request flow. There is deliberately NO public
 * "create an admin account" endpoint anywhere — this only ever creates a
 * pending *request* row. A real admin_users row only gets created when the
 * single-use approve link (sent solely to ADMIN_NOTIFY_EMAIL, never to the
 * requester) is clicked.
 *
 * Flow:
 *   1. POST /api/admin-requests (public) — anyone can submit a request.
 *      Saves it, emails ADMIN_NOTIFY_EMAIL with the request details and
 *      one-click Approve / Reject links.
 *   2. GET  /api/admin-requests/:id/approve?token=... — clicking the emailed
 *      link creates the real admin account with a random temporary
 *      password, emails those credentials to the REQUESTER, and shows a
 *      plain confirmation page (this is opened directly in a browser from
 *      an email client, not called by the frontend app).
 *   3. GET  /api/admin-requests/:id/reject?token=... — same shape, marks
 *      the request rejected, no account created.
 *
 * Both links are guarded by a random per-request token (not just the
 * request's id, which is guessable/enumerable) and are single-use — the
 * underlying store.decideAdminRequest() only updates a row still "pending",
 * so clicking an already-decided link is a no-op that shows a clear message
 * instead of silently doing nothing or double-creating an account.
 */

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const store = require("../services/store");
const { hashPassword, requireAdmin } = require("../services/auth");
const { sendEmail } = require("../services/emailService");

const VALID_TEST_TYPES = ["ielts", "sat"];

function htmlPage({ title, message, tone = "neutral" }) {
  const color = tone === "success" ? "#1e7a34" : tone === "error" ? "#b3261e" : "#111d40";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
    <style>body{font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f7f8fc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;color:#111d40;}
    .card{background:#fff;border:1px solid #e7e8f2;border-radius:14px;padding:36px 40px;max-width:440px;text-align:center;}
    h1{font-size:19px;margin:0 0 10px;color:${color};} p{font-size:14px;color:#5B6178;line-height:1.6;margin:0;}</style>
    </head><body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

function generateTempPassword() {
  // URL/keyboard-safe, 12 characters, cryptographically random.
  return crypto.randomBytes(9).toString("base64url");
}

// Shared by both the emailed single-use link (GET, token-authenticated) and
// the admin-dashboard fallback (POST, session-authenticated) — one real
// implementation of "what approving a request actually does", not two
// copies that could drift apart. Returns a plain result object rather than
// writing to `res` directly so each caller can render it its own way
// (an HTML confirmation page vs a JSON response).
async function approveRequest(request) {
  const tempPassword = generateTempPassword();
  let center;
  try {
    center = await store.createCenter(request.organization);
    await store.createAdmin({
      email: request.email,
      passwordHash: await hashPassword(tempPassword),
      fullName: request.fullName,
      centerId: center.centerId,
    });
  } catch (e) {
    console.error(`Failed to create admin for request ${request.requestId}`, e);
    // Deliberately NOT marking the request decided — a duplicate-email
    // conflict (most likely cause) is something worth trying again after
    // it's resolved, not a permanent rejection.
    return { ok: false, error: "An account for this email may already exist. No account was created — the request is still pending." };
  }

  await store.decideAdminRequest(request.requestId, "approved");

  const frontendUrl = process.env.FRONTEND_URL || "https://testly-mock.vercel.app";
  try {
    await sendEmail({
      to: request.email,
      subject: "Your Testly admin account is ready",
      html: `
        <p>Hi ${escapeHtml(request.fullName)},</p>
        <p>Your Testly admin account for <strong>${escapeHtml(request.organization)}</strong> has been approved.</p>
        <p><strong>Email:</strong> ${escapeHtml(request.email)}<br/>
        <strong>Temporary password:</strong> ${tempPassword}</p>
        <p><a href="${frontendUrl}/admin" style="background:#5B50E6;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;">Log in →</a></p>
        <p style="color:#999;font-size:12px;">This is a temporary password — consider it shared until you're able to change it.</p>
      `,
    });
  } catch (e) {
    console.error(`Account created for request ${request.requestId} but credentials email failed to send`, e);
    return { ok: true, emailFailed: true, tempPassword, message: `Account created, but the credentials email to ${request.email} failed to send. Temporary password: ${tempPassword}` };
  }

  return { ok: true, emailFailed: false, message: `An account was created and login credentials were emailed to ${request.email}.` };
}

// POST /api/admin-requests — public, submits a new access request.
router.post("/", async (req, res) => {
  const { fullName, email, organization, testTypes, otherTestType } = req.body || {};
  if (!fullName?.trim() || !email?.trim() || !organization?.trim()) {
    return res.status(400).json({ error: "Name, email, and organization are required." });
  }
  const cleanTypes = Array.isArray(testTypes) ? testTypes.filter((t) => VALID_TEST_TYPES.includes(t)) : [];
  if (otherTestType?.trim()) cleanTypes.push(otherTestType.trim());
  if (cleanTypes.length === 0) {
    return res.status(400).json({ error: "Select at least one test type, or describe what you need." });
  }

  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD || !process.env.ADMIN_NOTIFY_EMAIL) {
    console.error("Admin access request email configuration is incomplete.", {
      hasGmailUser: !!process.env.GMAIL_USER,
      hasGmailAppPassword: !!process.env.GMAIL_APP_PASSWORD,
      hasAdminNotifyEmail: !!process.env.ADMIN_NOTIFY_EMAIL,
    });
    return res.status(500).json({
      error: "This server is missing the Gmail/notification email config needed for admin requests.",
    });
  }

  const approveToken = crypto.randomBytes(24).toString("hex");
  let request;
  try {
    request = await store.createAdminRequest({
      fullName: fullName.trim(),
      email: email.trim(),
      organization: organization.trim(),
      testTypes: cleanTypes,
      approveToken,
    });
  } catch (e) {
    console.error("Failed to save admin request", e);
    return res.status(500).json({ error: "Could not submit your request. Please try again." });
  }

  // The request is already saved regardless of whether this email succeeds —
  // submitting the request is what the requester asked for, and that part
  // genuinely worked. A failed notification email is a real ops problem
  // (logged loudly below) but shouldn't make the requester think their
  // submission was lost when it wasn't.
  const backendUrl = process.env.PUBLIC_BACKEND_URL || `${req.protocol}://${req.get("host")}`;
  const approveUrl = `${backendUrl}/api/admin-requests/${request.requestId}/approve?token=${approveToken}`;
  const rejectUrl = `${backendUrl}/api/admin-requests/${request.requestId}/reject?token=${approveToken}`;

  try {
    await sendEmail({
      to: process.env.ADMIN_NOTIFY_EMAIL,
      subject: `New Testly admin access request — ${request.organization}`,
      html: `
        <p><strong>${escapeHtml(request.fullName)}</strong> (${escapeHtml(request.email)}) at
        <strong>${escapeHtml(request.organization)}</strong> is requesting admin access.</p>
        <p><strong>Test types needed:</strong> ${request.testTypes.map(escapeHtml).join(", ")}</p>
        <p style="margin-top:24px;">
          <a href="${approveUrl}" style="background:#5B50E6;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;margin-right:12px;">Approve</a>
          <a href="${rejectUrl}" style="background:#f0f0f0;color:#333;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;">Reject</a>
        </p>
      `,
    });
  } catch (e) {
    console.error(`Failed to send admin-request notification email for request ${request.requestId}`, e);
  }

  res.status(201).json({ requestId: request.requestId });
});

// GET /api/admin-requests/:id/approve — single-use, opened from the notification email.
router.get("/:id/approve", async (req, res) => {
  const request = await store.getAdminRequest(req.params.id);
  if (!request) return res.status(404).send(htmlPage({ title: "Not found", message: "This request doesn't exist.", tone: "error" }));
  if (request.approveToken !== req.query.token) {
    return res.status(403).send(htmlPage({ title: "Invalid link", message: "This approval link isn't valid.", tone: "error" }));
  }
  if (request.status !== "pending") {
    return res.send(htmlPage({ title: "Already decided", message: `This request was already marked "${request.status}".` }));
  }

  const result = await approveRequest(request);
  if (!result.ok) {
    return res.status(500).send(htmlPage({ title: "Couldn't create the account", message: result.error, tone: "error" }));
  }
  if (result.emailFailed) {
    return res.send(htmlPage({ title: "Account created — email failed", message: result.message, tone: "error" }));
  }
  res.send(htmlPage({ title: "Approved", message: result.message, tone: "success" }));
});

// GET /api/admin-requests/:id/reject — single-use, opened from the notification email.
router.get("/:id/reject", async (req, res) => {
  const request = await store.getAdminRequest(req.params.id);
  if (!request) return res.status(404).send(htmlPage({ title: "Not found", message: "This request doesn't exist.", tone: "error" }));
  if (request.approveToken !== req.query.token) {
    return res.status(403).send(htmlPage({ title: "Invalid link", message: "This link isn't valid.", tone: "error" }));
  }
  if (request.status !== "pending") {
    return res.send(htmlPage({ title: "Already decided", message: `This request was already marked "${request.status}".` }));
  }

  await store.decideAdminRequest(request.requestId, "rejected");
  res.send(htmlPage({ title: "Rejected", message: `The request from ${escapeHtml(request.email)} was marked rejected. No account was created.` }));
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- Admin-authenticated fallback (no email/token required) ----
// The notification email is the primary path, but it's a single point of
// failure (see the sendEmail retry fix in emailService.js) — if it's ever
// lost anyway, or GMAIL_* env vars are misconfigured, a request could sit
// invisible forever with no way to even know it exists. These routes let
// any logged-in admin see and decide pending requests directly.

router.get("/", requireAdmin, async (req, res) => {
  try {
    const requests = await store.listAdminRequests(req.query.status);
    res.json(requests);
  } catch (e) {
    console.error("GET /api/admin-requests failed", e);
    res.status(500).json({ error: "Could not load requests." });
  }
});

router.post("/:id/approve", requireAdmin, async (req, res) => {
  try {
    const request = await store.getAdminRequest(req.params.id);
    if (!request) return res.status(404).json({ error: "Request not found." });
    if (request.status !== "pending") {
      return res.status(409).json({ error: `This request was already marked "${request.status}".` });
    }
    const result = await approveRequest(request);
    if (!result.ok) return res.status(409).json({ error: result.error });
    res.json({ ok: true, emailFailed: !!result.emailFailed, tempPassword: result.emailFailed ? result.tempPassword : undefined });
  } catch (e) {
    console.error(`POST /api/admin-requests/:id/approve failed`, e);
    res.status(500).json({ error: "Could not approve the request." });
  }
});

router.post("/:id/reject", requireAdmin, async (req, res) => {
  try {
    const request = await store.getAdminRequest(req.params.id);
    if (!request) return res.status(404).json({ error: "Request not found." });
    if (request.status !== "pending") {
      return res.status(409).json({ error: `This request was already marked "${request.status}".` });
    }
    await store.decideAdminRequest(request.requestId, "rejected");
    res.json({ ok: true });
  } catch (e) {
    console.error(`POST /api/admin-requests/:id/reject failed`, e);
    res.status(500).json({ error: "Could not reject the request." });
  }
});

module.exports = router;
