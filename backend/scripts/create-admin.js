#!/usr/bin/env node
/**
 * scripts/create-admin.js
 * Run locally to create your first admin login:
 *   node scripts/create-admin.js you@center.com yourPassword "Your Name"
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in your .env (same as
 * the backend itself). Deliberately a CLI script, not an HTTP endpoint —
 * there is no public admin-registration route, on purpose.
 */

require("dotenv").config();
const { hashPassword } = require("../src/services/auth");
const store = require("../src/services/store");

async function main() {
  const [, , email, password, fullName] = process.argv;
  if (!email || !password) {
    console.error("Usage: node scripts/create-admin.js <email> <password> [full name]");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }
  const passwordHash = await hashPassword(password);
  const admin = await store.createAdmin({ email, passwordHash, fullName });
  console.log(`Admin created: ${admin.email} (${admin.adminId})`);
}

main().catch((e) => {
  console.error("Failed to create admin:", e.message);
  process.exit(1);
});