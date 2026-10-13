/**
 * routes/ai.js
 * AI Studio — the chat-driven way to create an exam (see studioAgent.js for
 * the agent, examBuilder.js for the work it starts). Every route requires a
 * valid admin JWT.
 *
 *   GET  /api/ai/status          is AI configured on this server, and with what
 *   POST /api/ai/chat            one chat message; replies as server-sent events
 *   POST /api/ai/build           build the blueprint in the panel (the Build button)
 *   GET  /api/ai/jobs/:examId    progress of the build or rewrite running on an exam
 *   POST /api/ai/import          digitise an uploaded paper (multipart, field "file", a PDF)
 *                                into a draft exam; progress through /jobs like a build
 *   POST /api/ai/tts             record a listening script as audio (the test editor's
 *                                "Record from script" button); returns { audioUrl }
 *
 * /chat streams these events, each a JSON payload:
 *   text      { delta }               assistant text as it is written
 *   tool      { name, ok }            the assistant used a tool, and whether it worked
 *   blueprint { blueprint }           the blueprint in the panel changed
 *   job       { examId, job }         a build or rewrite started
 *   done      { turn, blueprint, examId }   the turn is complete; `turn` is
 *                                     what the browser appends to its transcript
 *   error     { message }
 */

const express = require("express");
const router = express.Router();
const store = require("../services/store");
const builder = require("../services/examBuilder");
const { runTurn, sanitizeHistory } = require("../services/studioAgent");
const { isConfigured, describeError, describeProvider } = require("../services/aiProvider");
const multer = require("multer");
const tts = require("../services/ttsService");
const { startImport } = require("../services/paperImporter");
const { canReadPdf, MAX_PDF_BYTES } = require("../services/pdfReader");
const { requireAdmin } = require("../services/auth");

router.use(requireAdmin);

// Chat and builds both spend the centre's API credits, so each admin gets a
// ceiling. In-memory, like rateLimiter.js — fine for a single instance.
const usage = new Map(); // `${kind}:${adminId}` -> timestamps
function allow(kind, adminId, max, windowMs) {
  const key = `${kind}:${adminId}`;
  const now = Date.now();
  const recent = (usage.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    usage.set(key, recent);
    return false;
  }
  recent.push(now);
  usage.set(key, recent);
  return true;
}

const NOT_CONFIGURED = "AI generation isn't set up on this server yet. Add ANTHROPIC_API_KEY, GEMINI_API_KEY or GROQ_API_KEY to the backend's environment and restart it.";

router.get("/status", (req, res) => {
  res.json({
    configured: isConfigured(),
    ...describeProvider(),
    pdf: canReadPdf(),
    ...builder.capabilities(),
  });
});

router.post("/chat", async (req, res) => {
  const { message, history, events, blueprint, examId } = req.body || {};
  if (!isConfigured()) return res.status(503).json({ error: NOT_CONFIGURED });
  if (typeof message !== "string" || !message.trim() || message.length > 6000) {
    return res.status(400).json({ error: "Write a message of up to 6,000 characters." });
  }
  const cleanHistory = sanitizeHistory(history || []);
  if (!cleanHistory) return res.status(400).json({ error: "This conversation couldn't be read. Start a new chat." });
  let cleanBlueprint = null;
  if (blueprint) {
    cleanBlueprint = builder.normalizeBlueprint(blueprint).blueprint;
  }
  const cleanEvents = (Array.isArray(events) ? events : []).filter((e) => typeof e === "string").map((e) => e.slice(0, 300)).slice(0, 5);
  if (!allow("chat", req.admin.adminId, 40, 10 * 60 * 1000)) {
    return res.status(429).json({ error: "That's a lot of messages in a short time — give it a few minutes." });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // tell reverse proxies not to buffer the stream
  });
  let open = true;
  res.on("close", () => { open = false; });
  const emit = (event, data) => {
    if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => { if (open) res.write(": keep-alive\n\n"); }, 15000);

  try {
    const result = await runTurn({
      history: cleanHistory,
      text: message.trim(),
      events: cleanEvents,
      blueprint: cleanBlueprint,
      examId: typeof examId === "string" ? examId : null,
      admin: req.admin,
      emit,
    });
    emit("done", result);
  } catch (e) {
    console.error("POST /api/ai/chat failed", e);
    emit("error", { message: describeError(e) });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

router.post("/build", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: NOT_CONFIGURED });
  const { blueprint, errors } = builder.normalizeBlueprint(req.body?.blueprint);
  if (!blueprint) return res.status(400).json({ error: "This blueprint can't be built.", details: errors });
  if (!allow("build", req.admin.adminId, 12, 60 * 60 * 1000)) {
    return res.status(429).json({ error: "You've started a lot of builds this hour — try again a little later." });
  }
  try {
    const { exam, job } = await builder.startBuild({ blueprint, centerId: req.admin.centerId });
    res.status(202).json({ examId: exam.examId, job });
  } catch (e) {
    console.error("POST /api/ai/build failed", e);
    res.status(500).json({ error: "Could not start the build." });
  }
});

const pdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_BYTES } });

router.post("/import", (req, res, next) => {
  pdfUpload.single("file")(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === "LIMIT_FILE_SIZE";
    res.status(400).json({ error: tooBig ? `That PDF is larger than ${Math.round(MAX_PDF_BYTES / (1024 * 1024))}MB. Split it, or export it at a lower quality.` : err.message });
  });
}, async (req, res) => {
  if (!canReadPdf()) {
    return res.status(503).json({ error: "Reading a PDF needs a Claude or Gemini key on this server (ANTHROPIC_API_KEY or GEMINI_API_KEY)." });
  }
  // The first bytes of every PDF spell "%PDF", whatever the file is called.
  if (!req.file || req.file.buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return res.status(400).json({ error: "Attach the paper as a PDF file." });
  }
  if (!allow("import", req.admin.adminId, 8, 60 * 60 * 1000)) {
    return res.status(429).json({ error: "You've imported several papers this hour — try again a little later." });
  }
  try {
    const { exam, job } = await startImport({ pdf: req.file.buffer, fileName: req.file.originalname, centerId: req.admin.centerId });
    res.status(202).json({ examId: exam.examId, job });
  } catch (e) {
    console.error("POST /api/ai/import failed", e);
    res.status(500).json({ error: "Could not start reading the paper." });
  }
});

router.post("/tts", async (req, res) => {
  const { script, partIndex } = req.body || {};
  if (!tts.isConfigured()) {
    return res.status(503).json({ error: "No text-to-speech is set up on this server (GEMINI_API_KEY, or ELEVENLABS_API_KEY with a voice)." });
  }
  if (typeof script !== "string" || script.trim().split(/\s+/).length < 20 || script.length > 12000) {
    return res.status(400).json({ error: "The script needs to be between about 20 words and 12,000 characters to record." });
  }
  if (!allow("tts", req.admin.adminId, 20, 60 * 60 * 1000)) {
    return res.status(429).json({ error: "You've recorded a lot of audio this hour — try again a little later." });
  }
  try {
    const index = Number.isInteger(partIndex) && partIndex >= 0 ? partIndex : 0;
    res.json(await tts.synthesizeAudio({ script, partIndex: index }));
  } catch (e) {
    console.error("POST /api/ai/tts failed", e);
    res.status(502).json({ error: `The recording failed: ${e.message}` });
  }
});

router.get("/jobs/:examId", async (req, res) => {
  const exam = await store.getExam(req.params.examId);
  if (!exam || exam.centerId == null || exam.centerId !== req.admin.centerId) {
    return res.status(404).json({ error: "Exam not found." });
  }
  const job = builder.getJob(exam.examId);

  // A "generating" exam with no job behind it means the server restarted
  // mid-build. Nothing will ever finish it, so say so instead of leaving a
  // row that spins forever and can't be deleted.
  if (!job && exam.status === "generating") {
    const message = "The server restarted while this exam was being built. Build it again.";
    await store.updateExam(exam.examId, { status: "generation_failed", generationError: message });
    return res.json({ job: null, exam: { examId: exam.examId, title: exam.title, testType: exam.testType, status: "generation_failed", generationError: message } });
  }

  res.json({
    job,
    exam: { examId: exam.examId, title: exam.title, testType: exam.testType, status: exam.status, generationError: exam.generationError || null },
  });
});

module.exports = router;
