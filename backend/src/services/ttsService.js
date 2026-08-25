/**
 * ttsService.js
 * Converts listening-section scripts into hosted audio via ElevenLabs.
 *
 * TODO:
 * - POST script text to ElevenLabs API with a chosen voice per speaker
 * - Upload resulting audio to storage (S3/GCS) and return a public URL
 * - Cache by script hash so re-generating the same exam doesn't re-call the API
 */

async function synthesizeAudio({ script, voiceId }) {
  // TODO: call ElevenLabs, upload result, return { audioUrl, durationSeconds }
  throw new Error("not implemented");
}

module.exports = { synthesizeAudio };