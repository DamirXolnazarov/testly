require("dotenv").config();
const express = require("express");
const sessionsRouter = require("./routes/sessions");
const examsRouter = require("./routes/exams");
const authRouter = require("./routes/auth");
const uploadsRouter = require("./routes/uploads");
const adminRequestsRouter = require("./routes/adminRequests");

const app = express();
// Default express.json() limit is 100kb — too small for a full exam's JSON
// body (POST /api/exams paste/upload, or PATCH /api/exams/:id editing a
// generated exam), which can comfortably exceed that with several reading
// passages, 40+ questions, and listening transcripts. 10mb leaves generous
// headroom while staying well under the 25MB per-file media upload limit
// (storageService.js) so this isn't the bottleneck for anything reasonable.
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    env: {
      hasSupabase: !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      hasJwtSecret: !!process.env.JWT_SECRET,
      hasGmail: !!process.env.GMAIL_USER && !!process.env.GMAIL_APP_PASSWORD,
      hasAdminNotifyEmail: !!process.env.ADMIN_NOTIFY_EMAIL,
    },
  });
});

console.log("[backend] Starting Testly backend", {
  hasSupabase: !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  hasJwtSecret: !!process.env.JWT_SECRET,
  hasGmail: !!process.env.GMAIL_USER && !!process.env.GMAIL_APP_PASSWORD,
  hasAdminNotifyEmail: !!process.env.ADMIN_NOTIFY_EMAIL,
  port: process.env.PORT || 4000,
});

app.use("/api/auth", authRouter);
app.use("/api/sessions", sessionsRouter);
app.use("/api/exams", examsRouter);
app.use("/api/uploads", uploadsRouter);
app.use("/api/admin-requests", adminRequestsRouter);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Testly backend listening on :${PORT}`));

module.exports = app;