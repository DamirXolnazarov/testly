/**
 * auth.js
 * Password hashing (bcrypt) + JWT sign/verify for admin login.
 *
 * Env var required: JWT_SECRET (long random string, never commit).
 * Tokens last 30 days — the frontend re-logs-in after prolonged inactivity
 * rather than silently refreshing.
 */

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = "30d";

if (!JWT_SECRET) {
  console.warn("[auth] JWT_SECRET not set — admin login/token verification will fail until it's configured in .env");
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(admin) {
  return jwt.sign(
    { adminId: admin.adminId, email: admin.email, fullName: admin.fullName || null, centerId: admin.centerId || null },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

/** Express middleware: requires a valid "Authorization: Bearer <token>" header. */
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing auth token." });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: "Invalid or expired token." });
  req.admin = payload; // { adminId, email, centerId }
  next();
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, requireAdmin };