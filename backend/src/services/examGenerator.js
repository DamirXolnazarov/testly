/**
 * examGenerator.js
 * Calls an LLM to generate a full IELTS mock exam matching
 * docs/exam-json-schema.md. Admin reviews/edits the output before publishing.
 *
 * TODO:
 * - Build section-specific prompts (reading passage+questions, listening
 *   script+items, writing task1/task2) with strict "return JSON only" instructions
 * - Validate output against a JSON schema (e.g. zod/ajv) before saving
 * - Retry/repair loop if validation fails
 */

async function generateReadingSection({ topic, difficulty }) {
  // TODO: call LLM, return object matching the "reading" section shape
  throw new Error("not implemented");
}

async function generateListeningSection({ topic, difficulty }) {
  // TODO: call LLM for script + questions; audio comes later via ttsService
  throw new Error("not implemented");
}

async function generateWritingSection({ taskTypes }) {
  // TODO: call LLM for task 1 (chart data) + task 2 (essay prompt)
  throw new Error("not implemented");
}

module.exports = { generateReadingSection, generateListeningSection, generateWritingSection };