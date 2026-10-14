/**
 * openaiCompatClient.js
 * Chat-completions client for every provider that speaks the OpenAI wire
 * format: Google Gemini (through its OpenAI-compatible endpoint), Groq, and
 * OpenAI itself. Used when AI runs on something other than Claude — see
 * aiProvider.js for how that is decided, and claudeClient.js for the Claude
 * path.
 *
 * Every provider with an API key set contributes its models to one ordered
 * list of candidates, and each request walks that list until a model
 * answers. That matters most on free plans, which is what this file is
 * tuned for: Gemini's free tier allows each model about 20 requests a day,
 * Groq's allows 8,000 tokens a minute per model, and both regularly answer
 * "overloaded". No single free model can write a whole exam; several taking
 * turns can. A model that is rate limited is rested for as long as its
 * provider asks, so later requests don't pay for the same failed attempt.
 *
 * Env vars:
 *   GEMINI_API_KEY / GROQ_API_KEY / OPENAI_API_KEY   - any that are set are used
 *   AI_WRITER_MODELS  - optional, the candidates for writing exam content,
 *                       as "provider:model,provider:model" in order of preference
 *   AI_CHAT_MODELS    - optional, the same for the studio chat
 */

const PROVIDERS = {
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyVar: "GEMINI_API_KEY",
    writerModels: ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash"],
    // The chat wants a quick first word more than the deepest answer, and
    // the stronger models' small daily allowance is better spent writing
    // exams — so the chat uses the light models and short thinking.
    chatModels: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
    chatExtras: { reasoning_effort: "low" },
    maxOutput: 60000,
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyVar: "GROQ_API_KEY",
    writerModels: ["openai/gpt-oss-120b"],
    chatModels: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
    // The free plan's per-minute token budget covers prompt and reply
    // together, so a request may not ask for more output than this.
    maxOutput: 6000,
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyVar: "OPENAI_API_KEY",
    writerModels: [(process.env.OPENAI_MODEL || "gpt-4.1")],
    chatModels: [(process.env.OPENAI_MODEL || "gpt-4.1")],
    maxOutput: 32000,
  },
};

const MAX_CONCURRENT = 2;
// How long one request may spend waiting out rate limits. A build can wait
// its turn for minutes; someone watching the chat cannot.
const MAX_WAIT_MS = { writer: 12 * 60 * 1000, chat: 45 * 1000 };
// Free models sometimes accept a request and then sit on it for a minute or
// more. In the chat, a model that hasn't started answering within this long
// is dropped for the next one, and rested so the following messages don't
// wait on it again.
const CHAT_FIRST_BYTE_MS = 7000;
// A writing request returns a long JSON document, which can fairly take a
// couple of minutes — but a free model can also accept a request and never
// answer at all. Past this, the request is abandoned for the next model.
const WRITER_TIMEOUT_MS = 4 * 60 * 1000;
const SLOW_MODEL_REST_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000; // default rest after a rate limit with no retry hint
let inFlight = 0;
const waiting = [];
const coolingUntil = new Map(); // model -> timestamp it may be tried again

/** An API failure, with what the caller needs to decide what to do next. */
class CompatApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "CompatApiError";
    this.status = status;
  }
}

function hasKey(provider) {
  return !!(PROVIDERS[provider] && process.env[PROVIDERS[provider].keyVar]);
}

/**
 * The ordered candidates for a kind of request: every model of every
 * provider that has a key, or exactly what AI_WRITER_MODELS / AI_CHAT_MODELS
 * lists.
 * @param {"writer"|"chat"} kind
 * @returns {Array<{ provider: string, model: string }>}
 */
function candidates(kind) {
  const override = process.env[kind === "chat" ? "AI_CHAT_MODELS" : "AI_WRITER_MODELS"];
  if (override) {
    return override.split(",").map((entry) => {
      const [provider, ...rest] = entry.trim().split(":");
      return { provider, model: rest.join(":") };
    }).filter((c) => hasKey(c.provider) && c.model);
  }
  const list = [];
  const add = (provider, models) => {
    for (const model of models) {
      if (!list.some((c) => c.provider === provider && c.model === model)) list.push({ provider, model });
    }
  };
  const active = Object.keys(PROVIDERS).filter(hasKey);
  if (kind === "chat") {
    // Every provider's chat models before anyone's writing models, so the
    // chat only dips into the writers' allowance as a last resort.
    active.forEach((provider) => add(provider, PROVIDERS[provider].chatModels));
  }
  active.forEach((provider) => add(provider, PROVIDERS[provider].writerModels));
  return list;
}

function isConfigured() {
  return candidates("writer").length > 0;
}

/** The first-choice writing model, for display. */
function describe() {
  const first = candidates("writer")[0];
  return first ? { providerLabel: PROVIDERS[first.provider].label, model: first.model } : null;
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pulls a readable message (and a retry hint, when the provider gives one)
 * out of an error response. Gemini wraps its error object in an array. */
async function readError(res) {
  const text = await res.text().catch(() => "");
  let message = text.slice(0, 300);
  let retryAfterMs = Number(res.headers.get("retry-after")) * 1000 || 0;
  try {
    let body = JSON.parse(text);
    if (Array.isArray(body)) body = body[0];
    const err = body?.error || body;
    if (err?.message) message = String(err.message).split("\n")[0];
    const delay = (err?.details || []).find((d) => d.retryDelay)?.retryDelay;
    if (delay) retryAfterMs = parseFloat(delay) * 1000;
  } catch {
    // not JSON — keep the raw text
  }
  return { message, retryAfterMs };
}

/**
 * Sends one chat-completions request, walking the candidates until one
 * answers and waiting out short rate limits. `build(candidate, preset)`
 * returns the request body for that candidate (output caps and extras
 * differ per provider). Returns { res, firstChunk, text }: the fetch
 * Response; for the chat, where the body is read as a stream, the first
 * chunk of that stream, already taken off it to prove the model is
 * answering; for writing, the whole body, read within the time limit.
 */
async function request(kind, build) {
  const list = candidates(kind);
  if (list.length === 0) throw new CompatApiError("No AI provider key is set.", 0);
  const key = (c) => `${c.provider}:${c.model}`;
  const deadline = Date.now() + MAX_WAIT_MS[kind];
  const unusable = new Set(); // candidates that can't take this particular request
  let lastError = null;

  for (;;) {
    const usable = list.filter((c) => !unusable.has(key(c)));
    for (const candidate of usable.filter((c) => (coolingUntil.get(key(c)) || 0) <= Date.now())) {
      const preset = PROVIDERS[candidate.provider];
      let res;
      let firstChunk = null;
      const abort = new AbortController();
      const slow = setTimeout(() => abort.abort(), kind === "chat" ? CHAT_FIRST_BYTE_MS : WRITER_TIMEOUT_MS);
      let text = null;
      try {
        res = await fetch(`${preset.baseUrl}/chat/completions`, {
          method: "POST",
          signal: abort.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${process.env[preset.keyVar]}` },
          body: JSON.stringify({ ...build(candidate, preset), model: candidate.model }),
        });
        if (res.ok && kind === "chat") {
          const reader = res.body.getReader();
          firstChunk = (await reader.read()).value || new Uint8Array();
          res.reader = reader;
        } else if (res.ok) {
          text = await res.text();
        }
      } catch (e) {
        const timedOut = abort.signal.aborted;
        if (process.env.AI_DEBUG) console.log(`[ai] ${candidate.model} ${timedOut ? "too slow, skipped" : `unreachable: ${e.message}`}`);
        lastError = new CompatApiError(
          timedOut ? `${preset.label} (${candidate.model}) took too long to answer.` : `Couldn't reach ${preset.label}: ${e.message}`,
          timedOut ? 503 : 0
        );
        coolingUntil.set(key(candidate), Date.now() + (timedOut ? SLOW_MODEL_REST_MS : 5000));
        continue;
      } finally {
        clearTimeout(slow);
      }
      if (res.ok) return { res, firstChunk, text };

      const { message, retryAfterMs } = await readError(res);
      lastError = new CompatApiError(`${preset.label} (${candidate.model}): ${message}`, res.status);
      if (process.env.AI_DEBUG) console.log(`[ai] ${candidate.model} ${res.status} retryAfter=${retryAfterMs}ms ${message.slice(0, 160)}`);
      const tooLarge = res.status === 413 || /request too large/i.test(message);
      if (!tooLarge && [408, 429, 500, 502, 503, 504].includes(res.status)) {
        // Busy or rate limited: rest this model for as long as the provider
        // says (a spent daily quota comes back as hours), or a short default.
        coolingUntil.set(key(candidate), Date.now() + (retryAfterMs || (res.status === 429 ? COOLDOWN_MS : 20000)));
      } else {
        // Anything else (request too large for this model, a key this
        // provider rejects, …) won't change on a retry — but another
        // candidate may still be able to take it.
        unusable.add(key(candidate));
      }
    }

    // Nothing answered. Wait for whichever candidate is available soonest,
    // unless that is further away than this request may wait — typically
    // every model being out of its daily quota.
    const remaining = list.filter((c) => !unusable.has(key(c)));
    if (remaining.length === 0) throw lastError;
    const soonest = Math.min(...remaining.map((c) => coolingUntil.get(key(c)) || 0));
    const wait = Math.max(4000, soonest - Date.now());
    if (Date.now() + wait > deadline) {
      throw new CompatApiError(`Every available AI model is out of its free allowance for now. Last answer: ${lastError?.message}`, 429);
    }
    await sleep(wait);
  }
}

/**
 * One-shot completion for content writing.
 * @returns {Promise<string>} the response text
 */
async function completeText({ system, prompt, maxTokens = 32000, json = true }) {
  return withSlot(async () => {
    const { text: body } = await request("writer", (candidate, preset) => ({
      max_tokens: Math.min(maxTokens, preset.maxOutput),
      ...(json ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }));
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error("The AI provider sent back a response that wasn't valid JSON.");
    }
    const choice = data.choices?.[0];
    if (process.env.AI_DEBUG) console.log(`[ai] ${data.model} finish=${choice?.finish_reason} usage=${JSON.stringify(data.usage)}`);
    if (choice?.finish_reason === "length") throw new Error("The model's output was cut off before it finished.");
    const text = choice?.message?.content;
    if (!text || !String(text).trim()) throw new Error("The model returned an empty response.");
    return text;
  });
}

/**
 * A conversation can pass between providers from one message to the next
 * (that is the point of the pool), and each is particular about the extras
 * on earlier tool calls. Gemini requires a "thought signature" on every
 * tool call in the history and documents a placeholder for calls it didn't
 * make itself; the others don't know the field at all.
 */
function messagesFor(provider, messages) {
  return messages.map((message) => {
    if (!message.tool_calls) return message;
    return {
      ...message,
      tool_calls: message.tool_calls.map(({ extra_content, ...call }) =>
        provider === "gemini"
          ? { ...call, extra_content: extra_content || { google: { thought_signature: "skip_thought_signature_validator" } } }
          : call
      ),
    };
  });
}

/**
 * One streamed assistant turn with tools, for the AI Studio chat.
 * @param {Object} opts
 * @param {Array} opts.messages - OpenAI-format messages, system first
 * @param {Array} opts.tools - OpenAI-format tool definitions
 * @param {(delta: string) => void} opts.onText
 * @returns {Promise<{ text: string, toolCalls: Array, finishReason: string }>}
 *   toolCalls are returned exactly as the provider sent them (including
 *   provider extras such as Gemini's thought signatures, which have to be
 *   sent back with the call), with `function.arguments` as one JSON string.
 */
async function streamChat({ messages, tools, onText, maxTokens = 2500 }) {
  const { res, firstChunk } = await request("chat", (candidate, preset) => ({
    stream: true,
    max_tokens: Math.min(maxTokens, preset.maxOutput),
    ...(preset.chatExtras || {}),
    messages: messagesFor(candidate.provider, messages),
    tools,
  }));

  const decoder = new TextDecoder();
  const toolCalls = [];
  let text = "";
  let finishReason = "stop";
  let buffer = "";

  const handle = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { return; }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      onText(delta.content);
    }
    for (const part of delta.tool_calls || []) {
      // A call can arrive whole or in fragments keyed by index.
      const index = Number.isInteger(part.index) ? part.index : toolCalls.length;
      const call = (toolCalls[index] ||= { type: "function", function: { name: "", arguments: "" } });
      if (part.id) call.id = part.id;
      if (part.extra_content) call.extra_content = part.extra_content;
      if (part.function?.name) call.function.name = part.function.name;
      if (part.function?.arguments) call.function.arguments += part.function.arguments;
    }
  };

  for (let piece = firstChunk; piece; piece = (await res.reader.read()).value) {
    buffer += decoder.decode(piece, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    lines.forEach((line) => handle(line.trim()));
  }
  if (buffer.trim()) handle(buffer.trim());

  const calls = toolCalls.filter(Boolean).map((call, i) => ({ ...call, id: call.id || `call_${Date.now()}_${i}` }));
  return { text, toolCalls: calls, finishReason };
}

/** Turns a failure into a sentence an admin can act on. */
function describeError(err) {
  if (!(err instanceof CompatApiError)) return err?.message || "Unknown error.";
  if (err.status === 401 || err.status === 403) return `The AI provider rejected the API key. ${err.message}`;
  if (err.status === 429) return `The AI provider's usage limit has been reached — free plans allow only so much per minute and per day. Try again later. (${err.message})`;
  if (err.status === 503) return `The AI model is overloaded right now. Try again in a minute. (${err.message})`;
  return err.message;
}

module.exports = { isConfigured, describe, completeText, streamChat, describeError, CompatApiError };
