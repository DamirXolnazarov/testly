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

// Real IELTS section order and default durations (Reading 60 / Listening 30
// / Writing 60 minutes) — used to enforce that a student can't begin the
// next section until the current one's real time has elapsed, matching
// real IELTS conditions where finishing early doesn't buy early access to
// the next section. An exam's own `durationMinutes` per section (see
// docs/exam-json-schema.md) overrides these defaults, same fallback the
// frontend timer already uses in IELTSCDReplica.jsx.
const SECTION_ORDER = ["reading", "listening", "writing"];
const DEFAULT_SECTION_MINUTES = { reading: 60, listening: 30, writing: 60 };

function getSectionDurationMinutes(exam, sectionType) {
  const section = (exam?.sections || []).find((s) => s.type === sectionType);
  return (section && section.durationMinutes) || DEFAULT_SECTION_MINUTES[sectionType];
}

function generateStartCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

// Admins paste whatever their browser gives them when they open/share a
// Google Sheet, which is the full edit URL
// (https://docs.google.com/spreadsheets/d/<ID>/edit#gid=0), not the bare
// ID the Sheets API actually needs. Extract the ID regardless of which
// form comes in, so a full URL and a bare ID both work identically.
// (This was the real cause of every "Requested entity was not found"
// Sheets write failure — the whole URL was being sent as the ID.)
function extractSheetId(input) {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const urlMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return urlMatch ? urlMatch[1] : trimmed;
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
        sheet_id: extractSheetId(examData.sheetId),
        start_code: generateStartCode(),
        status: examData.status || "draft",
        center_id: examData.centerId || null,
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
  if (patch.sheetId !== undefined) row.sheet_id = extractSheetId(patch.sheetId);
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.generationError !== undefined) row.generation_error = patch.generationError;

  const { data, error } = await supabase.from("exams").update(row).eq("exam_id", examId).select().single();
  if (error) return null;
  return rowToExam(data);
}

async function listExams(centerId) {
  let query = supabase.from("exams").select("*").order("created_at", { ascending: false });
  if (centerId) query = query.eq("center_id", centerId);
  const { data, error } = await query;
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

// Pausing an exam only stamps paused_at — it deliberately does NOT touch any
// session's section_started_at. That timestamp is untouched until resumeExam
// shifts it forward by the real pause duration (see below).
async function pauseExam(examId) {
  const { data, error } = await supabase
    .from("exams")
    .update({ status: "paused", paused_at: new Date().toISOString() })
    .eq("exam_id", examId)
    .select()
    .single();
  if (error) throw error;
  return rowToExam(data);
}

// Resuming an exam must shift every currently-in-progress session's
// section_started_at forward by exactly how long the exam was paused.
// Every section's remaining time is computed client- and server-side as
// `duration - (now - section_started_at)` (see useCountdown in
// IELTSCDReplica.jsx) — a pure wall-clock calculation with no other notion
// of "paused" built in. Without this shift, the wall-clock time spent
// paused would count against every student's remaining time, and a pause
// long enough could silently expire (and auto-submit) their current
// section the instant the exam resumes, defeating the entire point of a
// pause. This was never implemented when /pause and /resume were first
// added, so every previous pause silently did this.
async function resumeExam(examId) {
  const exam = await getExam(examId);
  if (!exam) return null;
  const pauseDurationMs = exam.pausedAt ? Date.now() - exam.pausedAt : 0;

  if (pauseDurationMs > 0) {
    const { data: sessions, error: fetchErr } = await supabase
      .from("sessions")
      .select("session_id, section_started_at")
      .eq("exam_id", examId)
      .eq("status", "in_progress")
      .not("section_started_at", "is", null);
    if (fetchErr) throw fetchErr;

    for (const s of sessions || []) {
      const shifted = new Date(Date.parse(s.section_started_at) + pauseDurationMs).toISOString();
      const { error: updateErr } = await supabase
        .from("sessions")
        .update({ section_started_at: shifted })
        .eq("session_id", s.session_id);
      if (updateErr) throw updateErr;
    }
  }

  const { data, error } = await supabase
    .from("exams")
    .update({ status: "active", paused_at: null })
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

  // A student can only move to the section immediately after the one
  // they're on (or to "reading" from nothing yet) — never skip ahead,
  // never go backward. This is the server-side guard behind the fact
  // that the student UI itself has no way to trigger an early section
  // change (see IELTSCDReplica.jsx) — it also blocks a raw API call
  // from doing the same thing.
  const currentIndex = session.currentSection ? SECTION_ORDER.indexOf(session.currentSection) : -1;
  const expectedNext = SECTION_ORDER[currentIndex + 1];
  if (section !== expectedNext) {
    const err = new Error(
      expectedNext === undefined
        ? "This exam's sections are already complete."
        : `Sections must be taken in order — expected "${expectedNext}".`
    );
    err.code = "SECTION_ORDER";
    throw err;
  }

  // Even for the correct next section, it can't start until the PREVIOUS
  // section's full duration has actually elapsed — a student who answers
  // everything in reading in 20 minutes still can't reach listening until
  // reading's real 60 minutes are up, same as a real IELTS test room.
  if (currentIndex >= 0 && session.sectionStartedAt) {
    const exam = await getExam(session.examId);
    const prevSectionType = SECTION_ORDER[currentIndex];
    const requiredMs = getSectionDurationMinutes(exam, prevSectionType) * 60 * 1000;
    const elapsedMs = Date.now() - Date.parse(session.sectionStartedAt);
    const GRACE_MS = 5000; // clock-skew / request-latency buffer only, not extra time
    if (elapsedMs < requiredMs - GRACE_MS) {
      const err = new Error(`The ${prevSectionType} section isn't finished yet.`);
      err.code = "SECTION_TIME_NOT_UP";
      throw err;
    }
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
    .update({ sheet_row_range: range, sheet_error: null }) // a successful write clears any prior error
    .eq("session_id", sessionId)
    .select()
    .single();
  if (error) throw error;
  return rowToSession(data);
}

/** Records why the Sheets write failed for this session, so the admin
 * dashboard can surface it instead of the failure being visible only in
 * server logs. Called from the catch block in routes/sessions.js
 * POST /:id/submit, and again from the retry route if a retry also fails. */
async function setSheetError(sessionId, message) {
  const { data, error } = await supabase
    .from("sessions")
    .update({ sheet_error: message })
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
    centerId: row.center_id,
    title: row.title,
    sections: row.sections,
    sheetId: row.sheet_id,
    startCode: row.start_code,
    status: row.status,
    generationError: row.generation_error || null,
    createdAt: row.created_at ? Date.parse(row.created_at) : null,
    startedAt: row.started_at ? Date.parse(row.started_at) : null,
    pausedAt: row.paused_at ? Date.parse(row.paused_at) : null,
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
    sheetError: row.sheet_error || null,
  };
}

module.exports = {
  createExam, getExam, deleteExam, updateExam, listExams, startExam, stopExam, setExamStatus, pauseExam, resumeExam, resolveStartCode,
  createSession, getSession, saveAnswers, completeSession, listSessionsForExam, beginSection,
  admitSession, getRoster, setSheetRowRange, setSheetError,
  getAdminByEmail, getAdminById, createAdmin, updateAdmin, createCenter,
  createAdminRequest, getAdminRequest, decideAdminRequest, listAdminRequests,
  SECTION_ORDER, DEFAULT_SECTION_MINUTES, getSectionDurationMinutes,
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

// Used by the one-time seed script (scripts/create-admin.js), and now also
// by the token-gated approval link in routes/adminRequests.js — that route
// is not a public "register an admin" endpoint (anyone can only ever create
// a pending *request*; only a valid single-use approve_token, sent solely to
// ADMIN_NOTIFY_EMAIL, can turn a request into a real admin_users row).
async function createAdmin({ email, passwordHash, fullName, centerId }) {
  const { data, error } = await supabase
    .from("admin_users")
    .insert({ email: email.trim().toLowerCase(), password_hash: passwordHash, full_name: fullName || null, center_id: centerId || null })
    .select()
    .single();
  if (error) throw error;
  return { adminId: data.admin_id, email: data.email, fullName: data.full_name, centerId: data.center_id };
}

// ---- Centers ----

// One center per approved admin-access request (see routes/adminRequests.js),
// named after the requester's organization — this is what turns "the
// founder testing solo" into genuine multi-tenancy: every exam/roster/
// session an admin can see is scoped to their own center_id (embedded in
// their JWT at login — see auth.signToken), never another center's.
async function createCenter(name) {
  const { data, error } = await supabase.from("centers").insert({ name }).select().single();
  if (error) throw error;
  return { centerId: data.center_id, name: data.name };
}

// ---- Admin access requests ----

function rowToAdminRequest(row) {
  return {
    requestId: row.request_id,
    fullName: row.full_name,
    email: row.email,
    organization: row.organization,
    testTypes: row.test_types || [],
    status: row.status,
    approveToken: row.approve_token,
    createdAt: row.created_at ? Date.parse(row.created_at) : null,
    decidedAt: row.decided_at ? Date.parse(row.decided_at) : null,
  };
}

async function createAdminRequest({ fullName, email, organization, testTypes, approveToken }) {
  const { data, error } = await supabase
    .from("admin_requests")
    .insert({
      full_name: fullName,
      email: email.trim().toLowerCase(),
      organization,
      test_types: testTypes || [],
      approve_token: approveToken,
      status: "pending",
    })
    .select()
    .single();
  if (error) throw error;
  return rowToAdminRequest(data);
}

async function getAdminRequest(requestId) {
  const { data, error } = await supabase.from("admin_requests").select("*").eq("request_id", requestId).single();
  if (error) return null;
  return rowToAdminRequest(data);
}

// Fallback path for reviewing requests without relying on the notification
// email actually arriving (see routes/adminRequests.js) — any logged-in
// admin can see and decide pending requests this way. There's no
// superadmin/role concept in this schema yet, so this is intentionally
// available to any admin for now, same trust level as the emailed link
// itself (which is really just "whoever has the link", not identity-
// verified) — worth revisiting once there's more than one center's admin.
async function listAdminRequests(status) {
  let query = supabase.from("admin_requests").select("*").order("created_at", { ascending: false });
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) throw error;
  return data.map(rowToAdminRequest);
}

/** Marks a request approved or rejected. Guards against re-deciding an
 * already-decided request (e.g. the approve link being clicked twice) by
 * only updating rows still in "pending" — callers should check the
 * returned row is non-null to know whether their decision actually took
 * effect or arrived too late. */
async function decideAdminRequest(requestId, status) {
  const { data, error } = await supabase
    .from("admin_requests")
    .update({ status, decided_at: new Date().toISOString() })
    .eq("request_id", requestId)
    .eq("status", "pending")
    .select()
    .single();
  if (error) return null;
  return rowToAdminRequest(data);
}