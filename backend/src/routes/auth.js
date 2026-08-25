/**
 * routes/auth.js
 * Admin login only — no public registration endpoint on purpose (that would
 * let anyone create an admin account for your Supabase project). First admin
 * is created via scripts/create-admin.js, run locally with your service key.
 */

const express = require("express");
const router = express.Router();
const store = require("../services/store");
const { verifyPassword, hashPassword, signToken, requireAdmin } = require("../services/auth");
const { loginRateLimiter, clearRateLimit } = require("../services/rateLimiter");

// POST /api/auth/login  { email, password }
router.post("/login", loginRateLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }
  try {
    const admin = await store.getAdminByEmail(email);
    // Same error for "no such admin" and "wrong password" — don't leak which
    // one it was, that's an account-enumeration hole.
    if (!admin || !(await verifyPassword(password, admin.passwordHash))) {
      return res.status(401).json({ error: "Incorrect email or password." });
    }
    clearRateLimit(req); // successful login — don't penalize future attempts for earlier typos
    const token = signToken(admin);
    res.json({ token, admin: { email: admin.email, fullName: admin.fullName } });
  } catch (e) {
    console.error("POST /api/auth/login failed", e);
    res.status(500).json({ error: "Could not log in." });
  }
});

// GET /api/auth/me  — used by the frontend on load to check if a stored token is still valid
router.get("/me", requireAdmin, (req, res) => {
  res.json({ admin: req.admin });
});

// PATCH /api/auth/me  { fullName?, email?, currentPassword?, newPassword? }
// Used by AdminDashboard's ProfileView. Name/email can be changed freely;
// changing the password requires currentPassword to verify it's really the
// account owner, not just anyone with a still-valid session token sitting
// open on a shared machine. Returns a fresh token since the JWT embeds
// email — a stale token after an email change would fail auth on the very
// next request otherwise.
router.patch("/me", requireAdmin, async (req, res) => {
  const { fullName, email, currentPassword, newPassword } = req.body || {};
  try {
    const admin = await store.getAdminById(req.admin.adminId);
    if (!admin) return res.status(404).json({ error: "Account not found." });

    const patch = {};
    if (fullName !== undefined) patch.fullName = fullName;
    if (email !== undefined && email.trim().toLowerCase() !== admin.email) {
      patch.email = email;
    }

    if (newPassword !== undefined && newPassword !== "") {
      if (newPassword.length < 8) {
        return res.status(400).json({ error: "New password must be at least 8 characters." });
      }
      if (!currentPassword || !(await verifyPassword(currentPassword, admin.passwordHash))) {
        return res.status(401).json({ error: "Current password is incorrect." });
      }
      patch.passwordHash = await hashPassword(newPassword);
    }

    if (Object.keys(patch).length === 0) {
      // Nothing actually changed — still return a valid response rather
      // than erroring, since "save with no edits" is a reasonable no-op.
      const token = signToken(admin);
      return res.json({ token, admin: { email: admin.email, fullName: admin.fullName } });
    }

    const updated = await store.updateAdmin(req.admin.adminId, patch);
    if (!updated) {
      return res.status(409).json({ error: "That email is already in use by another account." });
    }

    const token = signToken(updated);
    res.json({ token, admin: { email: updated.email, fullName: updated.fullName } });
  } catch (e) {
    console.error("PATCH /api/auth/me failed", e);
    res.status(500).json({ error: "Could not update profile." });
  }
});

module.exports = router;