/**
 * studioAgent.js
 * The AI Studio chat: a tool-use loop that helps a moderator go from
 * "I need a mock for Saturday" to a blueprint, a built exam, and targeted
 * rewrites. The model never writes exam content here — it plans, and calls
 * tools that hand the real work to examBuilder.js.
 *
 * The backend keeps no conversation state. The browser holds the transcript
 * and sends it back with each message; runTurn() returns the messages this
 * turn added (`turn`) for the browser to append. Stored turns carry only
 * text, tool calls and tool results — Claude's thinking blocks are used
 * inside a turn's own tool loop (the API requires them there) and dropped
 * before the turn is handed back, which keeps the stored transcript small
 * and lets old turns be trimmed without invalidating anything.
 *
 * The loop itself is provider-neutral. The stored transcript uses one
 * block format (text / tool_use / tool_result) whichever model is behind
 * it, and the two adapters at the bottom of this file translate that to
 * and from Claude's Messages API and the OpenAI chat-completions format
 * that Gemini, Groq and OpenAI share (see aiProvider.js).
 */

const store = require("./store");
const builder = require("./examBuilder");
const { getProvider } = require("./aiProvider");
const { openStream, CHAT_MODEL, Anthropic } = require("./claudeClient");
const compat = require("./openaiCompatClient");

const MAX_TOOL_ROUNDS = 6;
const MAX_HISTORY_MESSAGES = 60;

// Built once per process: Claude caches the system prompt, and caching is
// a prefix match — anything that varied per request here would defeat it.
const SYSTEM_PROMPT = `You are the exam-building assistant in Testly's AI Studio. Testly is a mock-exam platform that education centres use to run IELTS and SAT practice tests under real test conditions. You are talking to a test moderator or teacher at one of those centres: someone who knows their students well and is usually not technical. Your job is to take them from a rough idea to a finished mock exam they can run.

How the studio works
The moderator sees this chat next to a blueprint panel. You shape the exam by calling set_blueprint, and whatever you pass appears in the panel at once, so they read the plan there — don't recite the blueprint back in chat. Once they approve it, build_exam builds the exam (they can also press Build in the panel). A build writes every passage, script, question and answer key, records the listening audio, and runs a second-pass check of the answer keys. It takes anywhere from a few minutes to twenty and the panel shows live progress. The result is saved as a draft that they can review, preview and start from the Exams page.

What the studio can build
IELTS, Academic or General Training:
- Reading: 1 to 3 passages carrying 13, 13 and 14 questions; three passages make the full 40-question, 60-minute paper. Task types: True/False/Not Given, Yes/No/Not Given, multiple choice, sentence and summary completion, matching (headings, information, features, sentence endings) and table completion.${builder.capabilities().images ? " Diagram labelling is available too." : ""}
- Listening: 1 to 4 parts of 10 questions each; four parts make the full 40-question test. Note and form completion is the only task type. Conversations have two speakers; the audio is recorded by synthetic voices.
- Writing: Task 1 and Task 2 together. Academic Task 1 comes with a real chart or table; General Training Task 1 is a letter. The centre marks writing itself.
- Speaking is not supported.
SAT, the digital adaptive format:
- Reading and Writing: Module 1 plus an easier and a harder Module 2, 27 questions and 32 minutes each.
- Math: the same three modules, 22 questions and 35 minutes each, multiple choice and student-produced responses.
- SAT content is plain text: no figures or graphs, and formulas are written out (x^2, sqrt(x)). Always full length.
An exam is IELTS or SAT, never a mix.

How to work
- Get to a blueprint quickly. As soon as you know which test they want, propose a complete blueprint with sensible defaults and ask what to change, instead of interviewing them. If their first message is already specific, go straight to the blueprint.
- Choose specific, fresh topics rather than broad ones: not "technology" but "how barcode scanning changed supermarket supply chains". Vary subject areas across an exam, and keep everything suitable for teenage and young adult students from any background.
- Each section's notes are instructions for the item writers. Put there anything the moderator wants emphasised: task types, skills to target, a weak area their students have, a vocabulary theme.
- Building spends the centre's AI and audio credits, so call build_exam only when the moderator has clearly said to go ahead. Once they have, just build — don't ask again.
- After a build you can inspect the exam with get_exam and rewrite a single reading passage, listening part or SAT module, or the writing tasks, with revise_exam. A rewrite runs in the background for a minute or two, one at a time. Anything bigger — a different test, more passages — means updating the blueprint and building a new exam.
- Be straightforward about limits. If they ask for something the studio can't produce, say so and offer the nearest thing it can.
- A line in square brackets beginning "Studio:" is a note from the app about something the moderator did in the panel. Treat it as fact, not as something they typed.
- Reply in the language the moderator writes in; many write in Uzbek or Russian. The exam content itself is always in English.
- Keep replies to a few plain sentences. No headings, and lists only when you are laying out options.`;

const TOOLS = [
  {
    name: "set_blueprint",
    description:
      "Create or replace the exam blueprint shown in the moderator's panel. Call this whenever the plan is first proposed or changes; always send the complete blueprint, not a partial update.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The exam's title as it will appear in the exam list, e.g. \"IELTS Academic Mock 7 — October\"." },
        testType: { type: "string", enum: ["ielts", "sat"] },
        difficulty: { type: "string", enum: ["easy", "medium", "hard"], description: "Overall level. medium matches the real test." },
        variant: { type: "string", enum: ["academic", "general"], description: "IELTS only: Academic or General Training. Use academic for SAT." },
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["reading", "listening", "writing", "reading-writing", "math"] },
              parts: { type: "integer", description: "Reading: number of passages, 1-3. Listening: number of parts, 1-4. Use 0 for every other section type." },
              topics: {
                type: "array",
                items: { type: "string" },
                description: "Reading: one topic per passage, in order. Listening: one scenario per part. Writing: the Task 1 subject, then the Task 2 subject. SAT: optional focus areas to weight, or empty.",
              },
              notes: { type: "string", description: "Instructions for the item writers of this section, or an empty string." },
            },
            required: ["type", "parts", "topics", "notes"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "testType", "difficulty", "variant", "sections"],
      additionalProperties: false,
    },
  },
  {
    name: "build_exam",
    description:
      "Start building the exam from the current blueprint. Runs in the background for several minutes and uses paid credits, so call it only after the moderator has clearly approved the blueprint.",
    eager_input_streaming: true,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_exam",
    description:
      "Look at the exam built in this conversation: its sections, passages, question types, any warnings from the build, and whether work on it is still running. Call this before discussing or rewriting specific content.",
    eager_input_streaming: true,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "revise_exam",
    description:
      "Rewrite one part of the built exam in the background, following the moderator's instructions. Only works on a draft exam, one rewrite at a time.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        section: { type: "string", enum: ["reading", "listening", "writing", "reading-writing", "math"] },
        part: {
          type: "integer",
          description: "Reading: passage number. Listening: part number. SAT: 1 = Module 1, 2 = easier Module 2, 3 = harder Module 2. Writing: 0 (both tasks are rewritten together).",
        },
        instructions: { type: "string", description: "What to change, written for the item writer, with enough detail to act on." },
      },
      required: ["section", "part", "instructions"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Transcript handling
// ---------------------------------------------------------------------------

function isText(value, max) {
  return typeof value === "string" && value.length <= max;
}

/**
 * Checks a transcript sent back by the browser and trims it to a bounded
 * length. Only the block types this module itself stores are accepted.
 * @returns {Array|null} the usable history, or null when it is malformed
 */
function sanitizeHistory(raw) {
  if (!Array.isArray(raw) || raw.length > 400) return null;
  const messages = [];
  for (const m of raw) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return null;
    if (typeof m.content === "string") {
      if (!isText(m.content, 20000)) return null;
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content) || m.content.length === 0 || m.content.length > 20) return null;
    const blocks = [];
    for (const b of m.content) {
      if (b?.type === "text" && isText(b.text, 20000)) blocks.push({ type: "text", text: b.text });
      else if (m.role === "assistant" && b?.type === "tool_use" && isText(b.id, 200) && isText(b.name, 100) && b.input && typeof b.input === "object") {
        const block = { type: "tool_use", id: b.id, name: b.name, input: b.input };
        // Provider extras that must travel with the call (Gemini's thought
        // signature). Opaque to us; bounded so it can't be abused as storage.
        if (b.extra && typeof b.extra === "object" && JSON.stringify(b.extra).length <= 20000) block.extra = b.extra;
        blocks.push(block);
      } else if (m.role === "user" && b?.type === "tool_result" && isText(b.tool_use_id, 200) && isText(b.content, 40000)) {
        blocks.push({ type: "tool_result", tool_use_id: b.tool_use_id, content: b.content, ...(b.is_error ? { is_error: true } : {}) });
      } else return null;
    }
    messages.push({ role: m.role, content: blocks });
  }

  // Trim from the front, but only ever to the start of a real user message
  // so a tool result is never separated from the call it answers.
  let start = Math.max(0, messages.length - MAX_HISTORY_MESSAGES);
  while (start > 0 && start < messages.length && !(messages[start].role === "user" && typeof messages[start].content === "string")) start += 1;
  return messages.slice(start);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

async function loadExam(state, admin) {
  if (!state.examId) return null;
  const exam = await store.getExam(state.examId);
  if (!exam || exam.centerId == null || exam.centerId !== admin.centerId) return null;
  return exam;
}

function jobSummary(job) {
  if (!job) return null;
  return {
    kind: job.kind,
    status: job.status,
    steps: job.steps.map((s) => `${s.group} — ${s.label}: ${s.status}${s.detail ? ` (${s.detail})` : ""}`),
    notes: job.notes,
    warnings: job.warnings,
    error: job.error,
  };
}

/** Runs one tool call. Returns { content, isError? }; never throws for a
 * problem the model can react to. */
async function runTool(name, input, { state, admin, emit }) {
  if (name === "set_blueprint") {
    const { blueprint, errors } = builder.normalizeBlueprint(input);
    if (!blueprint) return { content: `The blueprint was not accepted:\n${errors.map((e) => `- ${e}`).join("\n")}`, isError: true };
    state.blueprint = blueprint;
    emit("blueprint", { blueprint });
    return { content: "The blueprint is now showing in the moderator's panel." };
  }

  if (name === "build_exam") {
    if (!state.blueprint) return { content: "There is no blueprint yet. Call set_blueprint first.", isError: true };
    if (state.examId && builder.isBusy(state.examId)) {
      return { content: "An exam from this conversation is still being built. Wait for it to finish.", isError: true };
    }
    const { exam, job } = await builder.startBuild({ blueprint: state.blueprint, centerId: admin.centerId });
    state.examId = exam.examId;
    emit("job", { examId: exam.examId, job });
    return { content: `The build has started (exam id ${exam.examId}). It runs in the background for several minutes; the panel shows its progress, and the finished exam is saved as a draft.` };
  }

  if (name === "get_exam") {
    const exam = await loadExam(state, admin);
    if (!exam) return { content: "No exam has been built in this conversation yet.", isError: true };
    return { content: JSON.stringify({ exam: builder.examOutline(exam), work: jobSummary(builder.getJob(exam.examId)) }) };
  }

  if (name === "revise_exam") {
    if (!isText(input?.instructions, 4000) || !input.instructions.trim() || !isText(input?.section, 40) || !Number.isInteger(input?.part)) {
      return { content: "revise_exam needs section, part (an integer) and instructions.", isError: true };
    }
    const exam = await loadExam(state, admin);
    if (!exam) return { content: "No exam has been built in this conversation yet.", isError: true };
    const started = builder.startRevision({ exam, sectionType: input.section, part: input.part, instructions: input.instructions.trim() });
    if (started.error) return { content: started.error, isError: true };
    emit("job", { examId: exam.examId, job: started.job });
    return { content: "The rewrite has started and runs in the background for a minute or two; the panel shows its progress." };
  }

  return { content: `Unknown tool "${name}".`, isError: true };
}

// ---------------------------------------------------------------------------
// One chat turn
// ---------------------------------------------------------------------------

/**
 * Runs one moderator message through the agent.
 *
 * @param {Object} opts
 * @param {Array} opts.history - sanitized transcript so far
 * @param {string} opts.text - what the moderator typed
 * @param {string[]} [opts.events] - things they did in the panel since the last message
 * @param {Object|null} opts.blueprint - the blueprint currently in the panel
 * @param {string|null} opts.examId - the exam built in this conversation, if any
 * @param {Object} opts.admin - req.admin
 * @param {(event: string, data: Object) => void} opts.emit - sends a server-sent event to the browser
 * @returns {Promise<{ turn: Array, blueprint: Object|null, examId: string|null }>}
 */
async function runTurn({ history, text, events = [], blueprint, examId, admin, emit }) {
  const provider = getProvider();
  if (!provider) throw new Error("No AI provider is configured.");
  const model = provider === "anthropic" ? claudeModel() : compatModel();

  const state = { blueprint: blueprint || null, examId: examId || null };
  const userContent = events.length ? `[Studio: ${events.join(" ")}]\n\n${text}` : text;
  const turn = [{ role: "user", content: userContent }];
  const conversation = model.start([...history, ...turn]);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // { blocks, stop }: the assistant's stored blocks for this round, and
    // why it stopped — "end", "tools", "cut_off" or "refusal".
    const reply = await model.round(conversation, (delta) => emit("text", { delta }));

    if (reply.stop === "refusal") {
      emit("text", { delta: "Sorry — I can't help with that request. Could you put it another way?" });
      break;
    }
    const calls = reply.blocks.filter((b) => b.type === "tool_use");
    // A tool call cut off mid-way can still parse as a valid partial
    // object, so it is never run.
    if (calls.length && reply.stop === "cut_off") {
      throw new Error("The assistant's reply was cut off mid-action. Please send your message again.");
    }

    if (reply.blocks.length) turn.push({ role: "assistant", content: reply.blocks });
    if (calls.length === 0) break;

    const results = [];
    for (const call of calls) {
      const outcome = await runTool(call.name, call.input || {}, { state, admin, emit });
      emit("tool", { name: call.name, ok: !outcome.isError });
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: outcome.content,
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }
    model.addToolResults(conversation, results);
    turn.push({ role: "user", content: results });
  }

  // The stored transcript must never end on unanswered tool results, or the
  // next message would be glued onto them.
  if (turn[turn.length - 1].role === "user" && turn.length > 1) {
    turn.push({ role: "assistant", content: [{ type: "text", text: "(The assistant stopped here.)" }] });
  }

  return { turn, blueprint: state.blueprint, examId: state.examId };
}

// ---------------------------------------------------------------------------
// Model adapters
//
// Each adapter exposes the same three functions over its own native
// message list:
//   start(transcript)                 -> conversation (native messages)
//   round(conversation, onText)       -> { blocks, stop }, and appends the
//                                        assistant's native message
//   addToolResults(conversation, results)
// ---------------------------------------------------------------------------

function claudeModel() {
  // Only the block fields Claude knows about go on the wire.
  const toNative = (message) =>
    typeof message.content === "string"
      ? message
      : {
          role: message.role,
          content: message.content.map((b) =>
            b.type === "tool_use" ? { type: "tool_use", id: b.id, name: b.name, input: b.input } : b
          ),
        };

  return {
    start: (transcript) => transcript.map(toNative),

    async round(messages, onText) {
      for (let jsonRetries = 0; ; ) {
        const stream = openStream({
          model: CHAT_MODEL,
          max_tokens: 8000,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          tools: TOOLS,
          messages,
          // A planning chat: responsiveness matters more than depth here.
          output_config: { effort: "low" },
        });
        stream.on("text", onText);

        let message;
        try {
          message = await stream.finalMessage();
        } catch (err) {
          // Tool inputs stream unbuffered (eager_input_streaming), so input
          // the SDK can't parse at all surfaces here. Re-issue the round for
          // that case only; real API errors go to the caller.
          if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
          continue;
        }

        if (message.stop_reason === "refusal") return { blocks: [], stop: "refusal" };
        // The full content, thinking blocks included, stays in this
        // request's own loop; only text and tool calls are stored.
        messages.push({ role: "assistant", content: message.content });
        const blocks = message.content
          .filter((b) => b.type === "text" || b.type === "tool_use")
          .map((b) => (b.type === "text" ? { type: "text", text: b.text } : { type: "tool_use", id: b.id, name: b.name, input: b.input }));
        const stop = message.stop_reason === "max_tokens" ? "cut_off" : message.stop_reason === "tool_use" ? "tools" : "end";
        return { blocks, stop };
      }
    },

    addToolResults(messages, results) {
      messages.push({ role: "user", content: results });
    },
  };
}

function compatModel() {
  const tools = TOOLS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  // Stored blocks -> chat-completions messages. A tool result becomes its
  // own "tool" message; a tool call carries back any provider extras.
  const toNative = (message) => {
    if (typeof message.content === "string") return [{ role: message.role, content: message.content }];
    if (message.role === "assistant") {
      const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const calls = message.content.filter((b) => b.type === "tool_use").map((b) => ({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input) },
        ...(b.extra ? { extra_content: b.extra } : {}),
      }));
      return [{ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }];
    }
    return message.content.map((b) =>
      b.type === "tool_result"
        ? { role: "tool", tool_call_id: b.tool_use_id, content: b.content }
        : { role: "user", content: b.text }
    );
  };

  return {
    start: (transcript) => [{ role: "system", content: SYSTEM_PROMPT }, ...transcript.flatMap(toNative)],

    async round(messages, onText) {
      const { text, toolCalls, finishReason } = await compat.streamChat({ messages, tools, onText });
      if (finishReason === "content_filter") return { blocks: [], stop: "refusal" };

      const blocks = [];
      if (text) blocks.push({ type: "text", text });
      let cutOff = finishReason === "length";
      for (const call of toolCalls) {
        let input;
        try {
          input = JSON.parse(call.function.arguments || "{}");
        } catch {
          cutOff = true; // arguments that don't parse were truncated
          input = {};
        }
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input,
          ...(call.extra_content ? { extra: call.extra_content } : {}),
        });
      }
      messages.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      return { blocks, stop: cutOff ? "cut_off" : toolCalls.length ? "tools" : "end" };
    },

    addToolResults(messages, results) {
      for (const r of results) messages.push({ role: "tool", tool_call_id: r.tool_use_id, content: r.content });
    },
  };
}

module.exports = { runTurn, sanitizeHistory };
