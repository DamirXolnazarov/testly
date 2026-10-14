/**
 * writingAssessor.js
 * Suggests IELTS Writing bands for one task — four criterion bands with a
 * reason for each, plus what the candidate did well and should work on —
 * for a teacher to accept, adjust or ignore on the marking screen.
 *
 * It is a second opinion, not the mark: a model reading one essay can be a
 * band out either way, and free models more so. The marking screen says
 * so and the teacher's numbers are what get saved.
 */

const { generateJson } = require("./llmClient");
const { isProviderError } = require("./aiProvider");
const { CRITERIA, taskBand } = require("./ieltsBands");

const DESCRIPTORS = `Mark against the public IELTS Writing band descriptors. In brief:
- Task Achievement (Task 1) / Task Response (Task 2): does the answer address every part of the task with relevant, developed content? Task 1 (Academic): a clear overview and the key features, accurately reported, with comparisons; no opinion. Task 1 (General Training letter): every bullet point covered, a clear purpose and an appropriate tone. Task 2: a clear position throughout, main ideas extended and supported. An answer under the word limit, off-topic, or memorised loses marks here.
- Coherence and Cohesion: logical organisation and progression, paragraphing, and cohesive devices used accurately and not mechanically.
- Lexical Resource: range and precision of vocabulary, collocation, less common items, and spelling and word-formation errors.
- Grammatical Range and Accuracy: range of structures, including complex sentences, and how many sentences are error-free.
Band 9 is expert, 7 good (occasional errors), 6 competent (some errors, still clear), 5 modest (frequent errors, partial), 4 limited. Most mock candidates sit between 4 and 7: don't reward length or fancy words for their own sake, and don't be harsh on a clear, accurate essay because it is plain.`;

/**
 * @param {Object} task
 * @param {number} task.index - 0 for Task 1, 1 for Task 2
 * @param {string} task.prompt - the task as set
 * @param {string} task.text - what the candidate wrote
 * @param {number} [task.minWords]
 * @param {boolean} [task.general] - General Training (Task 1 is a letter)
 * @returns {Promise<{ criteria: Object, notes: Object, band: number, strengths: string[], improvements: string[] }>}
 */
async function assessWritingTask({ index, prompt, text, minWords, general }) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) {
    const criteria = { task: 0, coherence: 0, lexical: 0, grammar: 0 };
    return { criteria, notes: {}, band: 0, strengths: [], improvements: ["Nothing was written for this task."] };
  }

  const taskName = index === 0 ? (general ? "Task 1 (a General Training letter)" : "Task 1 (Academic report)") : "Task 2 (essay)";
  const prompt_ = `Mark this IELTS Writing ${taskName} as an experienced examiner would.

${DESCRIPTORS}

The task:
${prompt}

The candidate's answer (${words} words${minWords ? `; the minimum is ${minWords}` : ""}):
"""
${text}
"""

Return this JSON shape. Each band is a whole number from 0 to 9.

{
  "task": { "band": 6, "reason": "one or two sentences naming what in the answer earned this band" },
  "coherence": { "band": 6, "reason": "…" },
  "lexical": { "band": 6, "reason": "…" },
  "grammar": { "band": 6, "reason": "…" },
  "strengths": ["one specific thing done well", "another"],
  "improvements": ["the most useful specific thing to work on, quoting the answer where it helps", "another", "a third"]
}

Write the reasons and advice for a teacher to pass on to the student: plain, specific, and short.`;

  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const value = await generateJson({
        system: "You are a certified IELTS Writing examiner. You mark consistently with the public band descriptors. Respond with ONLY a single valid JSON object.",
        prompt: prompt_,
        maxTokens: 6000,
        effort: "medium",
      });
      const criteria = {};
      const notes = {};
      for (const c of CRITERIA) {
        const band = Math.round(Number(value?.[c]?.band));
        if (!Number.isInteger(band) || band < 0 || band > 9) throw new Error(`The suggestion had no usable band for ${c}.`);
        criteria[c] = band;
        notes[c] = String(value[c].reason || "").trim();
      }
      return {
        criteria,
        notes,
        band: taskBand(criteria),
        strengths: (Array.isArray(value.strengths) ? value.strengths : []).map(String).slice(0, 4),
        improvements: (Array.isArray(value.improvements) ? value.improvements : []).map(String).slice(0, 5),
      };
    } catch (e) {
      if (isProviderError(e)) throw e;
      lastError = e;
    }
  }
  throw lastError;
}

module.exports = { assessWritingTask };
