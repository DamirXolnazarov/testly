/**
 * storageService.js
 * Shared Supabase Storage upload helper for every backend feature that
 * hosts a binary asset: manual per-slot media attach (MediaSlotsPanel ->
 * POST /api/uploads), zip-bundle uploads (examZipService.js), and
 * AI-generated audio/images (ttsService.js, mapImageService.js). One bucket,
 * one place that knows how to talk to Supabase Storage.
 *
 * Required env vars (beyond the SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 * already used by supabaseClient.js):
 *   SUPABASE_MEDIA_BUCKET - bucket name (default: "exam-media")
 * The bucket must already exist and be set to PUBLIC in the Supabase
 * dashboard — this module does not create buckets.
 *
 * Optional: UPLOAD_MAX_BYTES - max size enforced on admin-uploaded files
 * (default 25MB). AI-generated assets (ttsService/mapImageService) are not
 * subject to this cap — it exists to bound what an admin can upload via the
 * browser, not to limit generation output.
 */

const crypto = require("crypto");
const supabase = require("./supabaseClient");

const BUCKET = process.env.SUPABASE_MEDIA_BUCKET || "exam-media";
const MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES) || 25 * 1024 * 1024; // 25MB

const EXT_BY_MIME = {
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Low-level upload: puts a buffer at an exact path in the shared bucket and
 * returns its public URL. Used internally and by services (ttsService,
 * mapImageService) that already know the exact path/filename they want. */
async function uploadBuffer({ path, buffer, contentType }) {
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType, upsert: true });

  if (error) {
    throw new Error(
      `Supabase Storage upload failed (bucket "${BUCKET}"): ${error.message}. ` +
      `Make sure this bucket exists and is public.`
    );
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  if (!data?.publicUrl) {
    throw new Error("Supabase Storage upload succeeded but returned no public URL.");
  }
  return data.publicUrl;
}

/**
 * Higher-level upload for admin-supplied exam assets (single-slot attach and
 * zip-bundle extraction). Enforces MAX_BYTES, derives a filename from a
 * content hash (so re-uploading the identical file is a no-op overwrite, not
 * a new object), and namespaces by examId when known.
 *
 * @param {Object} opts
 * @param {Buffer} opts.buffer
 * @param {string} opts.mimetype - one of the keys in EXT_BY_MIME
 * @param {string} [opts.examId] - namespaces the path; falls back to
 *   "unassigned" for uploads that happen before the exam row exists yet
 *   (the manual single-slot attach flow uploads during exam creation,
 *   before the exam has been saved — same as the zip path's `examId`
 *   being optional).
 * @returns {Promise<{ url: string }>}
 */
async function uploadExamAsset({ buffer, mimetype, examId }) {
  if (buffer.length > MAX_BYTES) {
    throw new Error(`File exceeds the ${Math.round(MAX_BYTES / (1024 * 1024))}MB upload limit.`);
  }
  const ext = EXT_BY_MIME[mimetype];
  if (!ext) {
    throw new Error(`Unsupported file type "${mimetype}". Expected audio (mp3/wav) or image (png/jpg/webp).`);
  }

  const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 24);
  const path = `${examId || "unassigned"}/${hash}.${ext}`;
  const url = await uploadBuffer({ path, buffer, contentType: mimetype });
  return { url };
}

module.exports = { uploadExamAsset, uploadBuffer, MAX_BYTES, BUCKET };
