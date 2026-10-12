/**
 * claudeClient.js
 * The one place that talks to the Claude API (official @anthropic-ai/sdk).
 * Two callers:
 *   - llmClient.js / examGenerator.js: completeText() for one-shot content
 *     writing (passages, questions, answer keys, answer-key checks).
 *   - studioAgent.js: openStream() for the AI Studio chat's tool-use loop.
 *
 * Env vars:
 *   ANTHROPIC_API_KEY     - required for anything here to run
 *   ANTHROPIC_MODEL       - optional, the content-writing model (default below)
 *   ANTHROPIC_CHAT_MODEL  - optional, the AI Studio chat model (defaults to
 *                           the writing model)
 *
 * Every request is streamed, even when the caller only wants the final
 * text: exam sections are long outputs and a non-streamed request that
 * large runs into HTTP timeouts well before the model is done.
 */

const AnthropicSdk = require("@anthropic-ai/sdk");
const Anthropic = AnthropicSdk.default || AnthropicSdk;

const WRITER_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
const CHAT_MODEL = process.env.ANTHROPIC_CHAT_MODEL || WRITER_MODEL;

// Claude's safety classifiers can occasionally decline a harmless request —
// an academic passage about viruses or network security is exactly the kind
// of thing that trips one. On the models that support it, `fallbacks:
// "default"` has the API re-run a declined request on a fallback model
// inside the same call instead of failing the whole exam build.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"]);

// A full exam build fans out into a dozen or so requests at once. Capping
// how many are in flight keeps a small-tier API key from being rate limited
// into failure; the SDK's own retries (maxRetries) cover the rest.
const MAX_CONCURRENT = 4;
let inFlight = 0;
const waiting = [];

let client = null;

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function getClient() {
  if (!isConfigured()) {
    throw new Error("ANTHROPIC_API_KEY is not set — add it to backend/.env to use AI generation.");
  }
  if (!client) client = new Anthropic({ maxRetries: 4 });
  return client;
}

async function withSlot(fn) {
  if (inFlight >= MAX_CONCURRENT) await new Promise((resolve) => waiting.push(resolve));
  inFlight += 1;
  try {
    return await fn();
  } finally {
    inFlight -= 1;
    const next = waiting.shift();
    if (next) next();
  }
}

/**
 * Opens a streamed Messages request and returns the SDK's MessageStream
 * (iterate it for events, or await .finalMessage()). Adds the refusal
 * fallback on models that support it.
 */
function openStream(params) {
  const anthropic = getClient();
  if (FALLBACK_MODELS.has(params.model)) {
    return anthropic.beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: "default" });
  }
  return anthropic.messages.stream(params);
}

/**
 * One-shot text completion for content writing.
 * @param {Object} opts
 * @param {string} opts.system
 * @param {string} opts.prompt
 * @param {number} [opts.maxTokens=32000] - includes the model's thinking, so
 *   keep generous headroom above the size of the JSON you expect back
 * @param {"low"|"medium"|"high"|"xhigh"|"max"} [opts.effort="high"]
 * @returns {Promise<string>} the response text
 */
async function completeText({ system, prompt, maxTokens = 32000, effort = "high" }) {
  const message = await withSlot(() =>
    openStream({
      model: WRITER_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
      output_config: { effort },
    }).finalMessage()
  );

  if (message.stop_reason === "refusal") {
    throw new Error("The model declined to write this content. Try a different topic.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("The model's output was cut off before it finished (max_tokens).");
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (!text.trim()) throw new Error("The model returned an empty response.");
  return text;
}

/** Turns an SDK error into a sentence an admin can act on. */
function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in the backend's environment.";
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return "This Anthropic API key isn't allowed to use the configured model.";
  }
  if (err instanceof Anthropic.NotFoundError) {
    return "The configured Claude model wasn't found. Check ANTHROPIC_MODEL / ANTHROPIC_CHAT_MODEL.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "Claude is rate limiting this API key right now. Wait a minute and try again.";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "Couldn't reach the Claude API. Check the server's network connection and try again.";
  }
  if (err instanceof Anthropic.APIError) {
    return `Claude API error${err.status ? ` (${err.status})` : ""}: ${err.message}`;
  }
  return err?.message || "Unknown error.";
}

module.exports = { isConfigured, openStream, completeText, describeError, WRITER_MODEL, CHAT_MODEL, Anthropic };
