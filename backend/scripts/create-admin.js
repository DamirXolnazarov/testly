#!/usr/bin/env node
/**
 * scripts/create-admin.js
 * Run locally to create your first admin login:
 *   node scripts/create-admin.js you@center.com yourPassword "Your Name" "Your Center Name"
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in your .env (same as
 * the backend itself). Deliberately a CLI script, not an HTTP endpoint —
 * there is no public admin-registration route, on purpose.
 *
 * Creates a new center for this admin (named from the 4th argument, or a
 * generic default) — an admin with no center_id can't see or create
 * anything, since every exam/roster/session query is scoped by it (see
 * routes/exams.js's belongsToCenter). Pass an existing --center-id=<uuid>
 * instead of a name to add a second admin to an already-existing center.
 */

require("dotenv").config();
const { hashPassword } = require("../src/services/auth");
const store = require("../src/services/store");

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--center-id="));
  const centerIdArg = process.argv.find((a) => a.startsWith("--center-id="))?.split("=")[1];
  const [email, password, fullName, centerName] = args;
  if (!email || !password) {
    console.error("Usage: node scripts/create-admin.js <email> <password> [full name] [center name] [--center-id=<uuid>]");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }
  const passwordHash = await hashPassword(password);
  let centerId = centerIdArg;
  if (!centerId) {
    const center = await store.createCenter(centerName || `${fullName || email}'s center`);
    centerId = center.centerId;
    console.log(`Center created: ${center.name} (${centerId})`);
  }
  const admin = await store.createAdmin({ email, passwordHash, fullName, centerId });
  console.log(`Admin created: ${admin.email} (${admin.adminId}), center ${centerId}`);
}

main().catch((e) => {
  console.error("Failed to create admin:", e.message);
  process.exit(1);
});