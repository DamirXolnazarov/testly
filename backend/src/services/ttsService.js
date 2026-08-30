/**
 * ttsService.js
 * Converts listening-section scripts into hosted audio via ElevenLabs, then
 * uploads the result to Supabase Storage (same project as everything else —
 * no separate S3/GCS account needed) and returns a public URL.
 *
 * Required env vars:
 *   ELEVENLABS_API_KEY       - from elevenlabs.io
 *   ELEVENLABS_VOICE_ID_DEFAULT - a voice ID to use when no per-part voice is set
 *     (examGenerator.js can also set ELEVENLABS_VOICE_ID_PART1..4 for variety)
 *   Uploads go through storageService.js (shared SUPABASE_MEDIA_BUCKET,
 *   default "exam-media") — same bucket as manual/zip exam asset uploads.
 *
 * The bucket must exist and be set to public before this will produce a URL
 * students' browsers can actually play — create it once in the Supabase
 * dashboard under Storage (see storageService.js).
 *
 * Caching: results are cached in-memory by a hash of (script + voiceId) for
 * the life of the process, so re-generating the same exam content twice in
 * one deploy doesn't re-call ElevenLabs or re-upload identical audio. This
 * is a lightweight safety net, not a durable cache — a real cross-restart
 * cache would key off a `tts_cache` table, which is worth adding if
 * generation volume grows enough for API cost to matter.
 */

const crypto = require("crypto");
const { uploadBuffer } = require("./storageService");
const memoryCache = new Map(); // hash -> { audioUrl, durationSeconds }

async function synthesizeAudio({ script, voiceId }) {
  if (!script || !script.trim()) {
    throw new Error("synthesizeAudio: script is required.");
  }
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set.");

  const resolvedVoiceId = voiceId || process.env.ELEVENLABS_VOICE_ID_DEFAULT;
  if (!resolvedVoiceId) {
    throw new Error(
      "No ElevenLabs voice ID available — set ELEVENLABS_VOICE_ID_DEFAULT " +
      "(or pass voiceId explicitly)."
    );
  }

  const cacheKey = hashInput(script, resolvedVoiceId);
  if (memoryCache.has(cacheKey)) return memoryCache.get(cacheKey);

  const audioBuffer = await callElevenLabs({ script, voiceId: resolvedVoiceId, apiKey });
  const audioUrl = await uploadToSupabase({ buffer: audioBuffer, cacheKey });
  const result = { audioUrl, durationSeconds: estimateDurationSeconds(script) };

  memoryCache.set(cacheKey, result);
  return result;
}

async function callElevenLabs({ script, voiceId, apiKey }) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "xi-api-key": apiKey,
      accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: script,
      model_id: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2",
      voice_settings: { stability: 0.45, similarity_boost: 0.75 },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ElevenLabs API error ${res.status}: ${detail}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function uploadToSupabase({ buffer, cacheKey }) {
  return uploadBuffer({
    path: `tts/${cacheKey}.mp3`,
    buffer,
    contentType: "audio/mpeg",
  });
}

function hashInput(script, voiceId) {
  return crypto.createHash("sha256").update(`${voiceId}::${script}`).digest("hex").slice(0, 32);
}

/** Rough spoken-word-rate estimate (150 wpm) — good enough for display/UI
 * purposes; not used for grading or timing logic anywhere. */
function estimateDurationSeconds(script) {
  const words = script.trim().split(/\s+/).length;
  return Math.round((words / 150) * 60);
}

module.exports = { synthesizeAudio };
