/**
 * rateLimiter.js
 * Minimal in-memory rate limiter — no Redis/external dependency needed for
 * a single-instance deployment. Keyed by IP + email combined, so it throttles
 * repeated guesses against one account without also locking out everyone
 * behind a shared office IP trying different accounts.
 *
 * If you ever run multiple backend instances behind a load balancer, this
 * needs to move to a shared store (Redis) — noted here rather than silently
 * becoming wrong under scale.
 */

const attempts = new Map(); // key -> { count, firstAttemptAt }

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 8;

function loginRateLimiter(req, res, next) {
  const email = (req.body?.email || "").trim().toLowerCase();
  const key = `${req.ip}:${email}`;
  const now = Date.now();

  const entry = attempts.get(key);
  if (!entry || now - entry.firstAttemptAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAttemptAt: now });
    return next();
  }

  if (entry.count >= MAX_ATTEMPTS) {
    const retryAfterSec = Math.ceil((entry.firstAttemptAt + WINDOW_MS - now) / 1000);
    res.set("Retry-After", String(retryAfterSec));
    return res.status(429).json({
      error: `Too many login attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).`,
    });
  }

  entry.count += 1;
  next();
}

// Successful logins should clear the counter for that key so a legitimate
// admin who mistyped their password twice isn't left with a lower ceiling
// than a fresh attacker would get.
function clearRateLimit(req) {
  const email = (req.body?.email || "").trim().toLowerCase();
  attempts.delete(`${req.ip}:${email}`);
}

// Periodic cleanup so `attempts` doesn't grow unbounded on a long-running
// process — old entries outside the window are harmless but wasteful to keep.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    if (now - entry.firstAttemptAt > WINDOW_MS) attempts.delete(key);
  }
}, WINDOW_MS).unref();

module.exports = { loginRateLimiter, clearRateLimit };