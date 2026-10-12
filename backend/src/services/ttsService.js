/**
 * ttsService.js
 * Turns a listening-section script into hosted audio and returns a public
 * URL (uploaded to Supabase Storage through storageService.js — the bucket
 * must exist and be public, see that file).
 *
 * Two voices-for-hire, chosen by what is configured:
 *
 *   Gemini text-to-speech (GEMINI_API_KEY) — the default when its key is
 *     set. It reads a two-person conversation in two different voices,
 *     which is what an IELTS Part 1 or Part 3 needs, and it is available on
 *     Gemini's free tier. It returns raw PCM, which is encoded to MP3 here
 *     so a part is a couple of megabytes rather than fifteen.
 *
 *   ElevenLabs (ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID_DEFAULT, optional
 *     ELEVENLABS_VOICE_ID_PART1..4 and ELEVENLABS_MODEL_ID) — one voice per
 *     part. Its free plan covers about two parts a month, so it only makes
 *     sense on a paid plan.
 *
 * Set TTS_PROVIDER=gemini|elevenlabs to choose explicitly.
 *
 * Scripts mark each turn of a conversation as "Name: what they say". Those
 * labels tell Gemini which voice speaks; for a single voice they are
 * stripped first, since a voice would otherwise read them aloud.
 *
 * Results are cached in memory by a hash of the script and voices for the
 * life of the process, so recording the same content twice in one deploy
 * doesn't spend quota twice. Not a durable cache.
 */

const crypto = require("crypto");
const { uploadBuffer } = require("./storageService");
const memoryCache = new Map(); // hash -> { audioUrl, durationSeconds }

const GEMINI_TTS_MODELS = (process.env.GEMINI_TTS_MODEL || "gemini-3.1-flash-tts-preview,gemini-2.5-flash-preview-tts")
  .split(",").map((m) => m.trim()).filter(Boolean);
const GEMINI_SAMPLE_RATE = 24000; // Gemini TTS returns 16-bit mono PCM at this rate
// A different pair of voices for each part, so four parts don't sound like
// the same two people; the first of each pair also reads monologues.
const GEMINI_VOICES = [["Kore", "Puck"], ["Charon", "Aoede"], ["Leda", "Fenrir"], ["Orus", "Kore"]];
const SPEAKER_LABEL = /^\s*([A-Z][\w .'-]{0,28}):\s+/;

/** @returns {"gemini"|"elevenlabs"|null} */
function getProvider() {
  const hasGemini = !!process.env.GEMINI_API_KEY;
  const hasEleven = !!process.env.ELEVENLABS_API_KEY && !!process.env.ELEVENLABS_VOICE_ID_DEFAULT;
  const explicit = (process.env.TTS_PROVIDER || "").toLowerCase();
  if (explicit === "gemini" && hasGemini) return "gemini";
  if (explicit === "elevenlabs" && hasEleven) return "elevenlabs";
  return hasGemini ? "gemini" : hasEleven ? "elevenlabs" : null;
}

function isConfigured() {
  return getProvider() !== null;
}

/** The distinct speaker names a script's turns are labelled with, in order of appearance. */
function speakersIn(script) {
  const names = [];
  for (const line of String(script).split("\n")) {
    const name = line.match(SPEAKER_LABEL)?.[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** The script as one voice should read it: without the "Name:" labels. */
function withoutLabels(script) {
  return String(script).split("\n").map((line) => line.replace(SPEAKER_LABEL, "")).join("\n").trim();
}

/**
 * @param {Object} opts
 * @param {string} opts.script - the script, with "Name: …" turn labels where it is a conversation
 * @param {number} [opts.partIndex=0] - 0-based part number, used to vary the voices
 * @returns {Promise<{ audioUrl: string, durationSeconds: number }>}
 */
async function synthesizeAudio({ script, partIndex = 0 }) {
  if (!script || !script.trim()) throw new Error("synthesizeAudio: script is required.");
  const provider = getProvider();
  if (!provider) {
    throw new Error("No text-to-speech provider is configured — set GEMINI_API_KEY, or ELEVENLABS_API_KEY with ELEVENLABS_VOICE_ID_DEFAULT.");
  }

  const cacheKey = crypto.createHash("sha256").update(`${provider}::${partIndex}::${script}`).digest("hex").slice(0, 32);
  if (memoryCache.has(cacheKey)) return memoryCache.get(cacheKey);

  const { buffer, durationSeconds } =
    provider === "gemini" ? await speakWithGemini(script, partIndex) : await speakWithElevenLabs(script, partIndex);
  const audioUrl = await uploadBuffer({ path: `tts/${cacheKey}.mp3`, buffer, contentType: "audio/mpeg" });

  const result = { audioUrl, durationSeconds };
  memoryCache.set(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

async function speakWithGemini(script, partIndex) {
  const voices = GEMINI_VOICES[partIndex % GEMINI_VOICES.length];
  const speakers = speakersIn(script);
  // Gemini voices at most two speakers. A script with exactly two gets one
  // voice each; anything else is read by a single voice.
  const twoVoices = speakers.length === 2;
  const speechConfig = twoVoices
    ? {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: speakers.map((speaker, i) => ({
            speaker,
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voices[i] } },
          })),
        },
      }
    : { voiceConfig: { prebuiltVoiceConfig: { voiceName: voices[0] } } };
  const text =
    "Read this IELTS listening recording aloud at a calm, clear, natural pace in British English.\n\n" +
    (twoVoices ? script : withoutLabels(script));

  let lastError = null;
  for (const model of GEMINI_TTS_MODELS) {
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: { responseModalities: ["AUDIO"], speechConfig },
        }),
      });
    } catch (e) {
      lastError = new Error(`Couldn't reach Gemini text-to-speech: ${e.message}`);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      lastError = new Error(`Gemini text-to-speech (${model}) error ${res.status}: ${String(data?.error?.message || "").split("\n")[0]}`);
      continue; // quota or overload on this model — the next one may have room
    }
    const base64 = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
    if (!base64) {
      lastError = new Error(`Gemini text-to-speech (${model}) returned no audio.`);
      continue;
    }
    const pcm = Buffer.from(base64, "base64");
    const durationSeconds = Math.round(pcm.length / 2 / GEMINI_SAMPLE_RATE);
    // Speech runs at roughly 150 words a minute. Far less audio than the
    // script calls for means the recording was cut short.
    const expectedSeconds = (text.trim().split(/\s+/).length / 150) * 60;
    if (durationSeconds < expectedSeconds * 0.6) {
      lastError = new Error(`Gemini text-to-speech (${model}) stopped early: ${durationSeconds}s of audio for a script of about ${Math.round(expectedSeconds)}s.`);
      continue;
    }
    return { buffer: await pcmToMp3(pcm), durationSeconds };
  }
  throw lastError;
}

/** Encodes 16-bit mono PCM as a 48 kbps MP3 — plenty for speech. Yields to
 * the event loop as it goes, since a few minutes of audio takes seconds of
 * CPU and the server has other requests to answer. */
async function pcmToMp3(pcm) {
  const { Mp3Encoder } = await import("@breezystack/lamejs"); // ESM-only package
  const encoder = new Mp3Encoder(1, GEMINI_SAMPLE_RATE, 48);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const FRAME = 1152;
  const chunks = [];
  for (let i = 0; i < samples.length; i += FRAME) {
    const encoded = encoder.encodeBuffer(samples.subarray(i, i + FRAME));
    if (encoded.length) chunks.push(Buffer.from(encoded));
    if ((i / FRAME) % 500 === 499) await new Promise((resolve) => setImmediate(resolve));
  }
  const tail = encoder.flush();
  if (tail.length) chunks.push(Buffer.from(tail));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// ElevenLabs
// ---------------------------------------------------------------------------

async function speakWithElevenLabs(script, partIndex) {
  const voiceId = process.env[`ELEVENLABS_VOICE_ID_PART${partIndex + 1}`] || process.env.ELEVENLABS_VOICE_ID_DEFAULT;
  const text = withoutLabels(script);
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "xi-api-key": process.env.ELEVENLABS_API_KEY,
      accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2",
      voice_settings: { stability: 0.45, similarity_boost: 0.75 },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ElevenLabs API error ${res.status}: ${detail.slice(0, 300)}`);
  }
  // No length comes back with the audio, so estimate from the word count.
  const durationSeconds = Math.round((text.split(/\s+/).length / 150) * 60);
  return { buffer: Buffer.from(await res.arrayBuffer()), durationSeconds };
}

module.exports = { synthesizeAudio, isConfigured, getProvider };
