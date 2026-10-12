/**
 * aiProvider.js
 * Decides what this server's AI runs on and gives the rest of the backend
 * one place to ask about it.
 *
 * Two families:
 *   "anthropic" - Claude, through claudeClient.js (official SDK). Used
 *                 whenever ANTHROPIC_API_KEY is set.
 *   "compat"    - everything that speaks the OpenAI wire format (Gemini,
 *                 Groq, OpenAI), through openaiCompatClient.js, which pools
 *                 the models of every such provider that has a key. This is
 *                 what makes a server with only free keys work.
 *
 * Set AI_PROVIDER=compat to stay on the pooled providers even when an
 * Anthropic key is present.
 */

const claude = require("./claudeClient");
const compat = require("./openaiCompatClient");

/** @returns {"anthropic"|"compat"|null} */
function getProvider() {
  const explicit = (process.env.AI_PROVIDER || "").toLowerCase();
  if (explicit === "compat" && compat.isConfigured()) return "compat";
  if (claude.isConfigured()) return "anthropic";
  return compat.isConfigured() ? "compat" : null;
}

function isConfigured() {
  return getProvider() !== null;
}

/** What the admin UI shows about the AI behind the studio. */
function describeProvider() {
  const provider = getProvider();
  if (!provider) return { provider: null, providerLabel: null, model: null };
  if (provider === "anthropic") return { provider, providerLabel: "Claude", model: claude.WRITER_MODEL };
  return { provider, ...compat.describe() };
}

/** True for a failure reported by the provider itself (bad key, quota,
 * overload) as opposed to bad content from the model — the first kind is
 * not something a repair prompt can fix. */
function isProviderError(err) {
  return err instanceof claude.Anthropic.APIError || err instanceof compat.CompatApiError;
}

function describeError(err) {
  return err instanceof compat.CompatApiError ? compat.describeError(err) : claude.describeError(err);
}

module.exports = { getProvider, isConfigured, describeProvider, isProviderError, describeError };
