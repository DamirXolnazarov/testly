/**
 * llmClient.js
 * The one function exam-content code calls to get JSON out of a model.
 * examGenerator.js never talks to a provider directly, so which provider
 * (and which model) writes the exams is decided entirely by aiProvider.js.
 *
 * generateJson({ system, prompt, maxTokens, effort }) returns the PARSED
 * JSON value the model produced. It throws if the reply doesn't parse as
 * JSON at all — parseable JSON of the wrong shape is caught later by the
 * checks in examGenerator.js, not here.
 */

const { getProvider } = require("./aiProvider");
const claude = require("./claudeClient");
const compat = require("./openaiCompatClient");

/**
 * @param {Object} opts
 * @param {string} opts.system - system prompt (instructions, constraints)
 * @param {string} opts.prompt - the actual generation request
 * @param {number} [opts.maxTokens=32000]
 * @param {string} [opts.effort] - Claude only: how hard the model works (see claudeClient.js)
 * @returns {Promise<any>} parsed JSON
 */
async function generateJson({ system, prompt, maxTokens = 32000, effort }) {
  const provider = getProvider();
  if (!provider) {
    throw new Error("No AI provider is configured. Set ANTHROPIC_API_KEY, GEMINI_API_KEY or GROQ_API_KEY in the backend's .env.");
  }
  const rawText =
    provider === "anthropic"
      ? await claude.completeText({ system, prompt, maxTokens, effort })
      : await compat.completeText({ system, prompt, maxTokens });
  return parseJsonLoose(rawText, provider);
}

/** Strips markdown code fences or surrounding prose if the model wrapped its JSON in them, then parses. */
function parseJsonLoose(rawText, provider) {
  let text = rawText.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  // A sentence of preamble before the object is the other common slip —
  // take everything from the first brace to the last.
  if (!text.startsWith("{") && text.includes("{")) {
    text = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${provider} did not return parseable JSON: ${e.message}`);
  }
}

module.exports = { generateJson };
