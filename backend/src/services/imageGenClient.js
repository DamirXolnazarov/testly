/**
 * imageGenClient.js
 * Thin wrapper around OpenAI's image generation API. Used only by
 * mapImageService.js to draw map/floor-plan images for map-type reading
 * questions. Kept separate from llmClient.js because image generation is
 * fixed to OpenAI regardless of which provider is chosen for text content
 * (LLM_PROVIDER) — the two are independent decisions.
 *
 * Required env var: OPENAI_API_KEY (same key used for LLM_PROVIDER=openai,
 * if you use that; if you're on Anthropic for text, this is the ONLY
 * OpenAI usage in the app and still needs its own key set).
 * Optional: OPENAI_IMAGE_MODEL (default "gpt-image-1").
 */

const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";

/**
 * @param {Object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.size="1024x1024"]
 * @returns {Promise<Buffer>} PNG image bytes
 */
async function generateImage({ prompt, size = "1024x1024" }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Map image generation uses OpenAI's image " +
      "API regardless of which provider LLM_PROVIDER is set to for text."
    );
  }

  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_IMAGE_MODEL,
      prompt,
      size,
      n: 1,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI image API error ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI image API returned no image data.");
  return Buffer.from(b64, "base64");
}

/**
 * Sends an already-generated image back to a vision-capable OpenAI model and
 * asks it to read off the real pixel/percent position of each numbered
 * marker actually drawn in the image. This closes the loop between "where
 * we asked for a marker" and "where it actually ended up" — image models
 * don't reliably place things exactly where a text prompt describes, so we
 * never trust the original requested coordinates, only what a second model
 * pass observes in the real output image.
 *
 * @param {Object} opts
 * @param {Buffer} opts.imageBuffer - the generated PNG
 * @param {number[]} opts.markerNumbers - which numbered markers to look for, e.g. [1,2,3]
 * @returns {Promise<Array<{n: number, x: number, y: number}>>} x/y as 0-100 percent
 */
async function detectMarkerPositions({ imageBuffer, markerNumbers }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set.");

  const visionModel = process.env.OPENAI_VISION_MODEL || "gpt-4.1";
  const base64Image = imageBuffer.toString("base64");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: visionModel,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `This image contains numbered markers: ${markerNumbers.join(", ")}. ` +
                `For each number, find its marker in the image and report its center ` +
                `position as a percentage of image width (x) and height (y), where ` +
                `(0,0) is the top-left corner and (100,100) is the bottom-right corner. ` +
                `Respond with ONLY a JSON object of this exact shape: ` +
                `{ "points": [ { "n": 1, "x": 42.5, "y": 30.0 }, ... ] }, one entry per ` +
                `marker number listed above, in any order. No commentary.`,
            },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${base64Image}` },
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI vision API error ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI vision response contained no content.");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Vision model did not return parseable JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed.points)) {
    throw new Error("Vision model response missing points[] array.");
  }
  return parsed.points;
}

module.exports = { generateImage, detectMarkerPositions };
