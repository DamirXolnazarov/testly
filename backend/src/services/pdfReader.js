/**
 * pdfReader.js
 * Asks a model to read a PDF and answer in JSON — used by paperImporter.js
 * to digitise an uploaded exam paper. Only models that take a PDF directly
 * can do this: Claude (through claudeClient.js) and Gemini (through its
 * native API here, since the OpenAI-compatible endpoint the rest of the
 * free pool uses has no document input). Groq can't read PDFs at all.
 *
 * The whole PDF goes with every request, so a caller that asks several
 * questions about one paper pays for the paper each time; on Gemini's free
 * tier that is also one of a model's ~20 daily requests each time.
 */

const { getProvider } = require("./aiProvider");
const claude = require("./claudeClient");
const { CompatApiError } = require("./openaiCompatClient");

// Above this the base64 request body passes Gemini's 20MB inline limit.
const MAX_PDF_BYTES = 14 * 1024 * 1024;
// Strongest first; the light models at the end have their own daily
// allowance and still transcribe well, so an import can finish after the
// others have run out.
const GEMINI_MODELS = (process.env.GEMINI_PDF_MODEL || "gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite")
  .split(",").map((m) => m.trim()).filter(Boolean);
const restingUntil = new Map(); // model -> timestamp it may be tried again

function canReadPdf() {
  return getProvider() === "anthropic" || !!process.env.GEMINI_API_KEY;
}

function parseJson(text) {
  let body = String(text).trim();
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) body = fenced[1].trim();
  if (!body.startsWith("{") && body.includes("{")) body = body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1);
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error(`The model's reading of the PDF wasn't valid JSON: ${e.message}`);
  }
}

async function askGemini({ pdf, system, prompt }) {
  let lastError = null;
  const rested = GEMINI_MODELS.filter((m) => (restingUntil.get(m) || 0) <= Date.now());
  for (const model of rested.length ? rested : GEMINI_MODELS) {
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ inlineData: { mimeType: "application/pdf", data: pdf.toString("base64") } }, { text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", maxOutputTokens: 60000 },
        }),
      });
    } catch (e) {
      lastError = new CompatApiError(`Couldn't reach Google Gemini: ${e.message}`, 0);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = String(data?.error?.message || "").split("\n")[0];
      lastError = new CompatApiError(`Google Gemini (${model}): ${message}`, res.status);
      if (![429, 500, 502, 503, 504].includes(res.status)) throw lastError;
      const retry = (data?.error?.details || []).find((d) => d.retryDelay)?.retryDelay;
      restingUntil.set(model, Date.now() + (retry ? parseFloat(retry) * 1000 : 30000));
      continue; // busy or out of quota — the next model may have room
    }
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason === "MAX_TOKENS") throw new Error("The model's reading of the PDF was cut off before it finished.");
    const text = (candidate?.content?.parts || []).map((p) => p.text || "").join("");
    if (!text.trim()) {
      lastError = new Error(`Google Gemini (${model}) returned nothing for this PDF${candidate?.finishReason ? ` (${candidate.finishReason})` : ""}.`);
      continue;
    }
    return text;
  }
  throw lastError;
}

/**
 * @param {Object} opts
 * @param {Buffer} opts.pdf
 * @param {string} opts.system
 * @param {string} opts.prompt
 * @returns {Promise<any>} the parsed JSON the model answered with
 */
async function readPdfJson({ pdf, system, prompt }) {
  if (pdf.length > MAX_PDF_BYTES) throw new Error(`The PDF is larger than ${Math.round(MAX_PDF_BYTES / (1024 * 1024))}MB.`);
  if (getProvider() === "anthropic") {
    return parseJson(await claude.completeText({ system, prompt, pdf, maxTokens: 60000 }));
  }
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Reading a PDF needs a Claude or Gemini key on the server (ANTHROPIC_API_KEY or GEMINI_API_KEY).");
  }
  return parseJson(await askGemini({ pdf, system, prompt }));
}

module.exports = { readPdfJson, canReadPdf, MAX_PDF_BYTES };
