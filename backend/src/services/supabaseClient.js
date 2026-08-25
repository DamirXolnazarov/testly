/**
 * supabaseClient.js
 * Backend-only Supabase client using the service role key (bypasses RLS —
 * that's correct here since the Node backend is the trusted layer; the
 * frontend never talks to Supabase directly with this key).
 *
 * Env vars required (.env, never commit):
 *   SUPABASE_URL=https://<project>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=<service role secret, from Supabase project settings>
 */

const { createClient } = require("@supabase/supabase-js");

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    "[supabaseClient] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — " +
    "store.js calls will fail until these are configured in your .env"
  );
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = supabase;