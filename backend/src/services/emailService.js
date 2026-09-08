/**
 * emailService.js
 * Sends transactional email via Gmail SMTP (using nodemailer + a Gmail App
 * Password) — used by the admin-access request flow: notifying the owner of
 * a new request, and sending approved applicants their login credentials.
 *
 * Gmail SMTP was chosen over a dedicated email API (e.g. Resend) deliberately:
 * services like Resend restrict you to only sending to your OWN account email
 * until you verify a domain you own — which would silently break sending
 * credentials to actual third-party requesters. Gmail SMTP has no such
 * restriction and can send to anyone immediately, for free, with no domain
 * needed.
 *
 * Required env vars:
 *   GMAIL_USER          - the Gmail address to send from (e.g. yourname@gmail.com)
 *   GMAIL_APP_PASSWORD  - a 16-character App Password for that account (NOT your
 *                          regular Gmail password) — generate one at
 *                          https://myaccount.google.com/apppasswords (requires
 *                          2-Step Verification to be enabled on the account first)
 *   ADMIN_NOTIFY_EMAIL  - where new access requests are sent (e.g. your own inbox)
 */

const nodemailer = require("nodemailer");

let cachedTransporter = null;

function getTransporter() {
  if (cachedTransporter) return cachedTransporter;

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      "GMAIL_USER / GMAIL_APP_PASSWORD are not set — see emailService.js for how to generate an App Password."
    );
  }

  cachedTransporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
  return cachedTransporter;
}

/**
 * @param {Object} opts
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} opts.html
 *
 * Retries transient failures (e.g. the "Connection timeout" that silently
 * lost two real admin-access-request notifications on 2026-09-01 — the
 * request itself was saved, but nobody ever saw the email telling them a
 * new center wanted access) up to 3 attempts with a short backoff, before
 * giving up and letting the caller's own error handling/logging take over.
 */
async function sendEmail({ to, subject, html }) {
  const transporter = getTransporter();
  const from = process.env.GMAIL_USER;
  const MAX_ATTEMPTS = 3;
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await transporter.sendMail({ from: `Testly <${from}>`, to, subject, html });
      return;
    } catch (e) {
      lastError = e;
      console.error(`sendEmail attempt ${attempt}/${MAX_ATTEMPTS} to ${to} failed:`, e.message);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 2000)); // 2s, 4s
      }
    }
  }
  throw lastError;
}

module.exports = { sendEmail };
