/**
 * grammarChecker.js
 * Finds the language errors in one IELTS essay — grammar, spelling, word
 * choice, punctuation — and returns them as draft annotations pinned to
 * the exact words, for the teacher to accept or dismiss on the marking
 * screen. Nothing is saved here and nothing reaches the student until the
 * teacher accepts it.
 *
 * The model quotes the words; annotations.anchorQuotes finds where they
 * are. A quote it can't find in the essay is dropped, never guessed at.
 */

const { generateJson } = require("./llmClient");
const { isProviderError } = require("./aiProvider");
const { anchorQuotes } = require("./annotations");

// Spelling and word choice are Lexical Resource; grammar and punctuation
// are Grammatical Range and Accuracy.
const KIND_TO_CATEGORY = { grammar: "grammar", punctuation: "grammar", spelling: "lexical", vocabulary: "lexical" };
const KIND_LABEL = { grammar: "Grammar", punctuation: "Punctuation", spelling: "Spelling", vocabulary: "Word choice" };

/**
 * @param {Object} opts
 * @param {string} opts.text - the essay
 * @param {{ start: number, end: number }[]} [opts.taken] - ranges the teacher has already annotated
 * @returns {Promise<Array<{ id, start, end, quote, category, comment, correction }>>}
 */
async function checkGrammar({ text, taken = [] }) {
  const essay = String(text || "");
  if (!essay.trim()) return [];

  const prompt = `Find the language errors in this IELTS essay written by an English learner.

"""
${essay}
"""

List every clear error in grammar, spelling, word choice (wrong word, wrong collocation, wrong word form) and punctuation, in the order they appear. Skip matters of style and anything that is acceptable English. Do not comment on ideas or organisation.

For each error:
- "quote": the exact words from the essay that are wrong, copied character for character, as short as possible while still unique (usually 1 to 6 words)
- "correction": the corrected version of exactly those words
- "kind": one of "grammar", "spelling", "vocabulary", "punctuation"
- "explanation": one short sentence a student can learn from, naming the rule (e.g. "After 'people', use the plural verb 'are'.")

Return: { "issues": [ { "quote": "…", "correction": "…", "kind": "grammar", "explanation": "…" } ] }
If there are no errors, return { "issues": [] }.`;

  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const value = await generateJson({
        system: "You are a careful English teacher proofreading an IELTS candidate's essay. You flag real errors only and quote the essay exactly. Respond with ONLY a single valid JSON object.",
        prompt,
        maxTokens: 8000,
        effort: "low",
      });
      if (!Array.isArray(value?.issues)) throw new Error("The grammar check came back without a list of issues.");
      const issues = value.issues
        .filter((i) => i && typeof i.quote === "string" && i.quote.trim())
        .map((i) => ({
          quote: i.quote,
          correction: String(i.correction || "").trim().slice(0, 300),
          kind: KIND_TO_CATEGORY[i.kind] ? i.kind : "grammar",
          explanation: String(i.explanation || "").trim().slice(0, 600),
        }))
        // A "correction" identical to the quote isn't an error.
        .filter((i) => i.correction !== i.quote.trim());
      return anchorQuotes(issues, essay, taken).map((i, n) => ({
        id: `ai${Date.now().toString(36)}${n}`,
        start: i.start,
        end: i.end,
        quote: i.quote,
        category: KIND_TO_CATEGORY[i.kind],
        comment: i.explanation ? `${KIND_LABEL[i.kind]}: ${i.explanation}` : KIND_LABEL[i.kind],
        correction: i.correction,
      }));
    } catch (e) {
      if (isProviderError(e)) throw e;
      lastError = e;
    }
  }
  throw lastError;
}

module.exports = { checkGrammar };
