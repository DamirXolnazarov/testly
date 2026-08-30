/**
 * routes/uploads.js
 * Single-file media upload, used by MediaSlotsPanel in AdminDashboard.jsx —
 * the "Attach" button next to each detected listening part / map question
 * when building an exam by upload/paste JSON (as opposed to the all-in-one
 * zip path, see routes/exams.js POST /upload-zip). Expects multipart form
 * data with one field named "file"; returns { url }.
 *
 * This route existed only on the frontend before (MediaSlotsPanel already
 * called POST /api/uploads) with no matching backend route — every manual
 * per-slot attach was silently 404ing. This file is what was missing.
 */

const express = require("express");
const multer = require("multer");
const router = express.Router();
const { requireAdmin } = require("../services/auth");
const { uploadExamAsset, MAX_BYTES } = require("../services/storageService");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

router.use(requireAdmin);

router.post("/", (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: `File exceeds the ${Math.round(MAX_BYTES / (1024 * 1024))}MB upload limit.` });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file provided — send it as multipart form field \"file\"." });
  }
  try {
    const { url } = await uploadExamAsset({
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      examId: req.body?.examId, // optional — exam may not exist yet during creation
    });
    res.status(201).json({ url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
