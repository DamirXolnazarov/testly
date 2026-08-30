/**
 * store.js
 * Supabase-backed version of the data layer. Same exported function names/
 * signatures as the old in-memory Maps version — routes/exams.js and
 * routes/sessions.js call these exactly as before and don't know or care
 * that storage changed underneath them.
 *
 * Schema: backend/supabase/schema.sql — run that in your Supabase project
 * before this will work. Requires SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY in your backend's .env (see supabaseClient.js).
 */

const supabase = require("./supabaseClient");

function generateStartCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

// ---- Exams ----

async function createExam(examData) {
  // Try a few times in the unlikely event of a start_code collision
  // (unique constraint in schema.sql catches it, we just retry).
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, error } = await supabase
      .from("exams")
      .insert({
        title: examData.title,
        sections: examData.sections,
        sheet_id: examData.sheetId || null,
        start_code: generateStartCode(),
        status: examData.status || "draft",
      })
      .select()
      .single();
    if (!error) return rowToExam(data);
    if (error.code !== "23505") throw error; // not a unique-violation — real error, bubble up
  }
  throw new Error("Could not generate a unique start code after 5 attempts.");
}

async function getExam(examId) {
  const { data, error } = await supabase.from("exams").select("*").eq("exam_id", examId).single();
  if (error) return null;
  return rowToExam(data);
}

/** Deletes an exam row outright. Used mainly to clear out a
 * "generation_failed" placeholder so the admin can retry — there was
 * previously no way to remove a failed AI-generation attempt from the list.
 * Returns true if a row was deleted, false otherwise (already gone, etc). */
async function deleteExam(examId) {
  const { error, count } = await supabase.from("exams").delete({ count: "exact" }).eq("exam_id", examId);
  if (error) throw new Error(error.message);
  return (count || 0) > 0;
}

async function updateExam(examId, patch) {
  const row = {};
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.sections !== undefined) row.sections = patch.sections;
  if (patch.sheetId !== undefined) row.sheet_id = patch.sheetId;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.generationError !== undefined) row.generation_error = patch.generationError;

  const { data, error } = await supabase.from("exams").update(row).eq("exam_id", examId).select().single();
  if (error) return null;
  return rowToExam(data);
}

async function listExams() {
  const { data, error } = await supabase.from("exams").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data.map(rowToExam);
}

async function startExam(examId) {
  const { data, error } = await supabase
    .from("exams")
    .update({ status: "active", started_at: new Date().toISOString() })
    .eq("exam_id", examId)
    .select()
    .single();
  if (error) return null;
  return rowToExam(data);
}

async function stopExam(examId) {
  const { data, error } = await supabase
    .from("exams")
    .update({ status: "closed" })
    .eq("exam_id", examId)
    .select()
    .single();
  if (error) return null;
  return rowToExam(data);
}

async function setExamStatus(examId, status) {
  const { data, error } = await supabase
    .from("exams")
    .update({ status })
    .eq("exam_id", examId)
    .select()
    .single();
  if (error) throw error;
  return rowToExam(data);
}

// Only resolves codes for exams that are currently "active" — a closed or
// draft exam's code (even if not yet reused) will not open a session.
async function resolveStartCode(code) {
  const { data, error } = await supabase
    .from("exams")
    .select("exam_id")
    .eq("start_code", (code || "").trim().toUpperCase())
    .eq("status", "active")
    .single();
  if (error || !data) return null;
  return data.exam_id;
}

// ---- Sessions ----

// New sessions start pending_admission — they are NOT let into the exam
// until a moderator calls admitSession(). This is the "waiting room" gate.
async function createSession(examId, fullName) {
  const { data, error } = await supabase
    .from("sessions")
    .insert({
      exam_id: examId,
      full_name: fullName || "",
      answers: { reading: {}, listening: {}, writing: {} },
      status: "pending_admission",
    })
    .select()
    .single();
  if (error) throw error;
  return rowToSession(data);
}

// Moderator lets a waiting student into the actual exam. Idempotent-ish:
// re-admitting an already in_progress/completed session is a no-op (returns
// it unchanged) rather than resetting their clock.
async function admitSession(sessionId) {
  const session = await getSession(sessionId);
  if (!session) return null;
  if (session.status !== "pending_admission") return session;
  const { data, error } = await supabase
    .from("sessions")
    .update({ status: "in_progress", admitted_at: new Date().toISOString() })
    .eq("session_id", sessionId)
    .select()
    .single();
  if (error) throw error;
  return rowToSession(data);
}

// Grouped roster for the admin's live test-day room: who's waiting, who's
// actively testing, who's finished. One call, three lists — avoids the
// admin UI having to fetch-and-filter client-side.
async function getRoster(examId) {
  const all = await listSessionsForExam(examId);
  return {
    pending: all.filter((s) => s.status === "pending_admission"),
    inProgress: all.filter((s) => s.status === "in_progress"),
    completed: all.filter((s) => s.status === "completed"),
  };
}

async function getSession(sessionId) {
  const { data, error } = await supabase.from("sessions").select("*").eq("session_id", sessionId).single();
  if (error) return null;
  return rowToSession(data);
}

// Note: this does a read-modify-write (fetch current answers, merge, save)
// rather than a partial JSONB patch, to keep the function signature simple
// for callers. Fine at mock-test scale; if concurrent writes to the same
// session/section become a real issue, switch to a Postgres function that
// does the merge atomically (`answers = answers || jsonb_build_object(...)`).
// Idempotent: if this section already has a start timestamp, returns it
// unchanged rather than resetting the clock — a refresh mid-section must not
// grant extra time.
async function beginSection(sessionId, section) {
  const session = await getSession(sessionId);
  if (!session) return null;
  if (session.currentSection === section && session.sectionStartedAt) {
    return session; // already started — don't reset the timer
  }
  const { data, error } = await supabase
    .from("sessions")
    .update({ current_section: section, section_started_at: new Date().toISOString() })
    .eq("session_id", sessionId)
    .select()
    .single();
  if (error) throw error;
  return rowToSession(data);
}

async function saveAnswers(sessionId, section, answers) {  const session = await getSession(sessionId);
  if (!session) return null;
  const merged = { ...session.answers, [section]: { ...session.answers[section], ...answers } };
  const { data, error } = await supabase
    .from("sessions")
    .update({ answers: merged })
    .eq("session_id", sessionId)
    .select()
    .single();
  if (error) throw error;
  return rowToSession(data);
}

async function completeSession(sessionId, results, sheetRowRange) {
  const patch = { status: "completed", completed_at: new Date().toISOString(), results };
  if (sheetRowRange) patch.sheet_row_range = sheetRowRange;
  const { data, error } = await supabase
    .from("sessions")
    .update(patch)
    .eq("session_id", sessionId)
    .select()
    .single();
  if (error) throw error;
  return rowToSession(data);
}

// Separate from completeSession because the Sheets write happens after the
// session is already marked completed (grading shouldn't wait on a
// third-party API call) — this patches in the row location once it's known.
async function setSheetRowRange(sessionId, range) {
  const { data, error } = await supabase
    .from("sessions")
    .update({ sheet_row_range: range })
    .eq("session_id", sessionId)
    .select()
    .single();
  if (error) throw error;
  return rowToSession(data);
}

async function listSessionsForExam(examId) {
  const { data, error } = await supabase
    .from("sessions")
    .select("*")
    .eq("exam_id", examId)
    .order("started_at", { ascending: false });
  if (error) throw error;
  return data.map(rowToSession);
}

// ---- row <-> app-shape mappers (snake_case DB columns -> camelCase app fields) ----

function rowToExam(row) {
  return {
    examId: row.exam_id,
    title: row.title,
    sections: row.sections,
    sheetId: row.sheet_id,
    startCode: row.start_code,
    status: row.status,
    generationError: row.generation_error || null,
    createdAt: row.created_at ? Date.parse(row.created_at) : null,
    startedAt: row.started_at ? Date.parse(row.started_at) : null,
  };
}

function rowToSession(row) {
  return {
    sessionId: row.session_id,
    examId: row.exam_id,
    fullName: row.full_name,
    answers: row.answers,
    status: row.status,
    admittedAt: row.admitted_at ? Date.parse(row.admitted_at) : null,
    currentSection: row.current_section,
    sectionStartedAt: row.section_started_at ? Date.parse(row.section_started_at) : null,
    startedAt: row.started_at ? Date.parse(row.started_at) : null,
    completedAt: row.completed_at ? Date.parse(row.completed_at) : null,
    results: row.results,
    sheetRowRange: row.sheet_row_range || null,
  };
}

module.exports = {
  createExam, getExam, deleteExam, updateExam, listExams, startExam, stopExam, setExamStatus, resolveStartCode,
  createSession, getSession, saveAnswers, completeSession, listSessionsForExam, beginSection,
  admitSession, getRoster, setSheetRowRange,
  getAdminByEmail, getAdminById, createAdmin, updateAdmin,
};

// ---- Admin users ----

async function getAdminByEmail(email) {
  const { data, error } = await supabase
    .from("admin_users")
    .select("*")
    .eq("email", (email || "").trim().toLowerCase())
    .single();
  if (error) return null;
  return {
    adminId: data.admin_id,
    email: data.email,
    passwordHash: data.password_hash,
    fullName: data.full_name,
    centerId: data.center_id,
  };
}

// Looked up by id rather than email — used when an admin edits their own
// email address, since we need their current record before the email
// they're changing FROM has moved.
async function getAdminById(adminId) {
  const { data, error } = await supabase
    .from("admin_users")
    .select("*")
    .eq("admin_id", adminId)
    .single();
  if (error) return null;
  return {
    adminId: data.admin_id,
    email: data.email,
    passwordHash: data.password_hash,
    fullName: data.full_name,
    centerId: data.center_id,
  };
}

// Partial update — pass only the fields being changed. `email`, if present,
// is lowercased/trimmed the same way createAdmin does, so lookups by email
// stay consistent. Returns null on a unique-constraint conflict (email
// already taken by another admin) rather than throwing, so the route can
// turn that into a clean 409 instead of a generic 500.
async function updateAdmin(adminId, patch) {
  const row = {};
  if (patch.fullName !== undefined) row.full_name = patch.fullName;
  if (patch.email !== undefined) row.email = patch.email.trim().toLowerCase();
  if (patch.passwordHash !== undefined) row.password_hash = patch.passwordHash;

  const { data, error } = await supabase
    .from("admin_users")
    .update(row)
    .eq("admin_id", adminId)
    .select()
    .single();
  if (error) {
    if (error.code === "23505") return null; // unique violation — email taken
    throw error;
  }
  return {
    adminId: data.admin_id,
    email: data.email,
    passwordHash: data.password_hash,
    fullName: data.full_name,
    centerId: data.center_id,
  };
}

// Used by the one-time seed script (scripts/create-admin.js) — not exposed
// over HTTP, so there's no public "register an admin" endpoint to abuse.
async function createAdmin({ email, passwordHash, fullName }) {
  const { data, error } = await supabase
    .from("admin_users")
    .insert({ email: email.trim().toLowerCase(), password_hash: passwordHash, full_name: fullName || null })
    .select()
    .single();
  if (error) throw error;
  return { adminId: data.admin_id, email: data.email, fullName: data.full_name };
}