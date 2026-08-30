/**
 * llmClient.js
 * Thin, provider-agnostic wrapper around whichever LLM API is generating
 * exam content. examGenerator.js only ever calls generateJson() below — it
 * never talks to Anthropic/OpenAI directly, so swapping providers (or
 * switching models later) never touches the generation/prompt logic.
 *
 * Provider is chosen by LLM_PROVIDER env var: "anthropic" | "openai".
 * Required env vars per provider:
 *   anthropic -> ANTHROPIC_API_KEY   (optional: ANTHROPIC_MODEL, default below)
 *   openai    -> OPENAI_API_KEY      (optional: OPENAI_MODEL, default below)
 *
 * generateJson({ system, prompt, maxTokens }) returns the PARSED JSON value
 * the model produced. It throws if the provider returns something that
 * doesn't parse as JSON at all (a hard error) — malformed-but-parseable JSON
 * (wrong shape) is caught later by examValidator.js in the retry loop in
 * examGenerator.js, not here.
 */

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

function getProvider() {
  const provider = (process.env.LLM_PROVIDER || "").toLowerCase();
  if (provider === "anthropic" || provider === "openai") return provider;
  // Fall back to whichever key is actually present, so a half-configured
  // .env still works without requiring LLM_PROVIDER to be set explicitly.
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  throw new Error(
    "No LLM configured. Set LLM_PROVIDER=anthropic|openai and the matching " +
    "ANTHROPIC_API_KEY or OPENAI_API_KEY in your .env."
  );
}

/**
 * @param {Object} opts
 * @param {string} opts.system - system prompt (instructions, constraints)
 * @param {string} opts.prompt - the actual generation request
 * @param {number} [opts.maxTokens=8000]
 * @returns {Promise<any>} parsed JSON
 */
async function generateJson({ system, prompt, maxTokens = 8000 }) {
  const provider = getProvider();
  const rawText =
    provider === "anthropic"
      ? await callAnthropic({ system, prompt, maxTokens })
      : await callOpenAI({ system, prompt, maxTokens });

  return parseJsonLoose(rawText, provider);
}

async function callAnthropic({ system, prompt, maxTokens }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("Anthropic response contained no text block.");
  return textBlock.text;
}

async function callOpenAI({ system, prompt, maxTokens }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set.");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI API error ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI response contained no message content.");
  return text;
}

/** Strips markdown code fences if the model wrapped its JSON in them, then parses. */
function parseJsonLoose(rawText, provider) {
  let text = rawText.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${provider} did not return parseable JSON: ${e.message}`);
  }
}

module.exports = { generateJson };
