/**
 * mapImageService.js
 * Turns a map question's point *descriptions* (from the text LLM) into a
 * real generated image with a real, verified answer key of x/y positions.
 *
 * Why this exists: a text-only model can describe "the reception desk is
 * near the entrance" but cannot know the actual pixel layout of an image it
 * hasn't seen — image generation models don't reliably place things exactly
 * where a prompt asks either. So instead of trusting guessed coordinates,
 * this:
 *   1. Asks the text LLM (in examGenerator.js) for point LABELS only, no x/y.
 *   2. Generates one image with numbered markers via OpenAI's image API.
 *   3. Sends that same image to a vision model and asks it to report back
 *      where each numbered marker actually ended up.
 *   4. Uses those observed coordinates as the real answer key — so
 *      question.points[].x/y always match what's genuinely drawn on
 *      question.imageUrl, never a blind guess.
 *
 * Required env vars: OPENAI_API_KEY (image + vision), plus the standard
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY already used elsewhere. Uploads go
 * through storageService.js (shared SUPABASE_MEDIA_BUCKET, default
 * "exam-media") — same bucket as manual/zip exam asset uploads and TTS audio.
 */

const crypto = require("crypto");
const { generateImage, detectMarkerPositions } = require("./imageGenClient");
const { uploadBuffer } = require("./storageService");

/**
 * @param {Object} opts
 * @param {string} opts.sceneDescription - overall setting, e.g.
 *   "a small university library, top-down floor plan"
 * @param {Array<{n: number, label: string}>} opts.points - what each
 *   numbered marker represents, e.g. { n: 3, label: "the reception desk" }
 *   (label is descriptive only — it is NOT necessarily the same as the
 *   question's answer text, just what the image should visually depict there)
 * @returns {Promise<{ imageUrl: string, points: Array<{n: number, x: number, y: number}> }>}
 */
async function generateMapImage({ sceneDescription, points }) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new Error("generateMapImage: points[] is required and must be non-empty.");
  }

  const prompt = buildImagePrompt({ sceneDescription, points });
  const imageBuffer = await generateImage({ prompt, size: "1024x1024" });

  const markerNumbers = points.map((p) => p.n);
  const observed = await detectMarkerPositions({ imageBuffer, markerNumbers });

  // Sanity check: every marker we asked for must have been found. If the
  // vision pass silently dropped one, that's a generation defect worth
  // failing loudly on rather than shipping a map with a dead/missing pin.
  const missing = markerNumbers.filter((n) => !observed.some((o) => o.n === n));
  if (missing.length > 0) {
    throw new Error(
      `Map image generation: vision pass could not locate marker(s) ${missing.join(", ")} ` +
      `in the generated image. Retry generation.`
    );
  }

  const cacheKey = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 32);
  const imageUrl = await uploadBuffer({
    path: `map-images/${cacheKey}.png`,
    buffer: imageBuffer,
    contentType: "image/png",
  });

  return {
    imageUrl,
    points: observed.map((o) => ({
      n: o.n,
      x: clampPercent(o.x),
      y: clampPercent(o.y),
    })),
  };
}

function buildImagePrompt({ sceneDescription, points }) {
  const markerList = points
    .map((p) => `Marker ${p.n}: place it at/on ${p.label}.`)
    .join(" ");

  return (
    `A clean, simple, schematic top-down diagram (like a textbook floor plan ` +
    `or map illustration, flat colors, clear line art, NOT photorealistic) of: ` +
    `${sceneDescription}. Place exactly ${points.length} distinct numbered circular ` +
    `markers on the image, each a bold filled circle with its number printed clearly ` +
    `inside or beside it in large legible black text on a white background. ` +
    `${markerList} Spread the markers out so they are clearly separated from each ` +
    `other and don't overlap. No other text, labels, or captions besides the marker numbers.`
  );
}

function clampPercent(n) {
  const num = Number(n);
  if (Number.isNaN(num)) return 50;
  return Math.max(0, Math.min(100, num));
}

module.exports = { generateMapImage };
