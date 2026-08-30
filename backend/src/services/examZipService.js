/**
 * examZipService.js
 * Handles the "upload everything in one ZIP" path — an alternative to
 * building an exam by pasting JSON and then attaching media one slot at a
 * time (see MediaSlotsPanel in AdminDashboard.jsx). Instead, the admin zips
 * their exam.json together with media files, and each file is matched to
 * the exact slot it belongs to by a simple, explicit naming convention:
 *
 *   The media file's name (without extension) must exactly equal the `id`
 *   of the thing it belongs to — the listening part's `id` for audio, or
 *   the map question's `id` for an image.
 *
 *   e.g. exam.json has a listening part { "id": "l-part1", ... }
 *        -> the zip should contain "l-part1.mp3" (or .wav)
 *
 *   e.g. exam.json has a map question { "id": "r10", ... }
 *        -> the zip should contain "r10.png" (or .jpg/.webp)
 *
 *   e.g. exam.json has a writing part { "id": "w-task1", ... } that wants a
 *        chart/graph/table image for the prompt (optional — Task 2 essay
 *        prompts never have one, and Task 1 doesn't require one either)
 *        -> the zip should contain "w-task1.png" (or .jpg/.webp)
 *
 * This is a deliberate design choice over guessing from filenames like
 * "part1_audio_final_v2.mp3" — matching against the id that's already in
 * the JSON is unambiguous, and a mismatch is reported clearly (see
 * `unmatchedFiles` / `missingSlots` in the result) rather than silently
 * guessed at. No AI involved — this is the AI-generation path's audio still
 * needing this exact behavior is unlikely, since examGenerator.js will
 * write audioUrl directly; this path is for manually-built/testing exams,
 * same scope as MediaSlotsPanel.
 */

const AdmZip = require("adm-zip");
const { uploadExamAsset } = require("./storageService");

const AUDIO_EXT = ["mp3", "wav"];
const IMAGE_EXT = ["png", "jpg", "jpeg", "webp"];
const MIME_BY_EXT = {
  mp3: "audio/mpeg", wav: "audio/wav",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
};

/** Walks the parsed exam JSON and returns every slot that needs a hosted
 * file, with the id it must be matched against — same slots
 * MediaSlotsPanel.jsx shows in the manual-attach UI, kept in sync by hand
 * since frontend/backend don't share a module in this project layout. */
function findSlots(exam) {
  const slots = [];
  (exam.sections || []).forEach((section, si) => {
    if (section.type === "listening") {
      (section.parts || []).forEach((part, pi) => {
        if (!part.id) return;
        slots.push({ matchId: part.id, kind: "audio", path: ["sections", si, "parts", pi, "audioUrl"] });
      });
    }
    if (section.type === "writing") {
      (section.parts || []).forEach((part, pi) => {
        if (!part.id) return;
        // Optional — a Task 1 prompt describing a chart/graph/table can have
        // a matching image; Task 2 (essay) parts simply never get a file
        // for this slot and that's fine (see missingSlots handling below).
        slots.push({ matchId: part.id, kind: "image", path: ["sections", si, "parts", pi, "chartImageUrl"], optional: true });
      });
    }
    (section.parts || []).forEach((part, pi) => {
      (part.questions || []).forEach((q, qi) => {
        if (q.type === "map" && q.id) {
          slots.push({ matchId: q.id, kind: "image", path: ["sections", si, "parts", pi, "questions", qi, "imageUrl"] });
        }
      });
    });
  });
  return slots;
}

function setAtPath(obj, path, value) {
  let cursor = obj;
  for (let i = 0; i < path.length - 1; i++) cursor = cursor[path[i]];
  cursor[path[path.length - 1]] = value;
}

/**
 * @param {Buffer} zipBuffer
 * @param {string} examId - namespaces uploaded assets in storage, same as MediaSlotsPanel
 * @returns {{
 *   exam: object,                // the exam JSON with matched audioUrl/imageUrl filled in
 *   matched: Array<{matchId, kind, url}>,
 *   unmatchedFiles: string[],    // files in the zip that didn't match any slot
 *   missingSlots: Array<{matchId, kind}>, // slots the JSON needs that had no matching file
 * }}
 */
async function extractAndMatch(zipBuffer, examId) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);

  const jsonEntry = entries.find((e) => e.entryName.toLowerCase().endsWith(".json"));
  if (!jsonEntry) {
    throw new Error("No .json file found in the zip — include your exam JSON at the top level.");
  }
  let exam;
  try {
    exam = JSON.parse(jsonEntry.getData().toString("utf8"));
  } catch {
    throw new Error(`Could not parse ${jsonEntry.entryName} — check it's valid JSON.`);
  }

  const slots = findSlots(exam);
  const slotsByMatchId = new Map(slots.map((s) => [s.matchId, s]));
  const matched = [];
  const unmatchedFiles = [];
  const claimedMatchIds = new Set();

  for (const entry of entries) {
    if (entry === jsonEntry) continue;
    const name = entry.entryName.split("/").pop(); // strip any folder prefix in the zip
    const dot = name.lastIndexOf(".");
    if (dot === -1) { unmatchedFiles.push(name); continue; }
    const base = name.slice(0, dot);
    const ext = name.slice(dot + 1).toLowerCase();

    const slot = slotsByMatchId.get(base);
    if (!slot) { unmatchedFiles.push(name); continue; }

    const expectedExts = slot.kind === "audio" ? AUDIO_EXT : IMAGE_EXT;
    if (!expectedExts.includes(ext)) {
      unmatchedFiles.push(`${name} (matches "${base}" but wrong file type for ${slot.kind} — expected ${expectedExts.join("/")})`);
      continue;
    }

    const mimetype = MIME_BY_EXT[ext];
    const { url } = await uploadExamAsset({ buffer: entry.getData(), mimetype, examId });
    setAtPath(exam, slot.path, url);
    matched.push({ matchId: base, kind: slot.kind, url });
    claimedMatchIds.add(base);
  }

  const missingSlots = slots
    .filter((s) => !s.optional && !claimedMatchIds.has(s.matchId) && !getAtPath(exam, s.path))
    .map((s) => ({ matchId: s.matchId, kind: s.kind }));

  return { exam, matched, unmatchedFiles, missingSlots };
}

function getAtPath(obj, path) {
  let cursor = obj;
  for (const key of path) {
    if (cursor === undefined || cursor === null) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

module.exports = { extractAndMatch, findSlots };