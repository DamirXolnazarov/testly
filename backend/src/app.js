require("dotenv").config();
const express = require("express");
const sessionsRouter = require("./routes/sessions");
const examsRouter = require("./routes/exams");
const authRouter = require("./routes/auth");
const uploadsRouter = require("./routes/uploads");

const app = express();
app.use(express.json());

app.use("/api/auth", authRouter);
app.use("/api/sessions", sessionsRouter);
app.use("/api/exams", examsRouter);
app.use("/api/uploads", uploadsRouter);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Testly backend listening on :${PORT}`));

module.exports = app;