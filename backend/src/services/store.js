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
const { buildSatModuleAnswerKey, gradeSatModule } = require("./grader");
const { routeToModule2, scaleScore } = require("./satScoring");

// Real IELTS section order and default durations (Reading 60 / Listening 30
// / Writing 60 minutes) — used to enforce that a student can't begin the
// next section until the current one's real time has elapsed, matching
// real IELTS conditions where finishing early doesn't buy early access to
// the next section. An exam's own `durationMinutes` per section (see
// docs/exam-json-schema.md) overrides these defaults, same fallback the
// frontend timer already uses in IELTSCDReplica.jsx.
const SECTION_ORDER = ["reading", "listening", "writing"];
const DEFAULT_SECTION_MINUTES = { reading: 60, listening: 30, writing: 60 };
// SAT has its own section order — see completeSatModule/beginSection below
// for how testType picks which of these two orders applies.
const SAT_SECTION_ORDER = ["reading-writing", "math"];

function getSectionOrder(exam) {
  // Filtered down to only the section types this exam actually has —
  // assuming every exam always contains all of an order's canonical types
  // was a latent bug (not new to SAT): an exam missing one section type
  // (a Math-only SAT mock, or even an IELTS exam authored without a
  // Listening section) would have expectedNext still point at the missing
  // type below, permanently blocking progression to whatever came after it.
  const canonical = exam?.testType === "sat" ? SAT_SECTION_ORDER : SECTION_ORDER;
  const present = new Set((exam?.sections || []).map((s) => s.type));
  return canonical.filter((t) => present.has(t));
}

function getSectionDurationMinutes(exam, sectionType) {
  const section = (exam?.sections || []).find((s) => s.type === sectionType);
  return (section && section.durationMinutes) || DEFAULT_SECTION_MINUTES[sectionType];
}

/**
 * Like getSectionDurationMinutes, but aware of SAT's module-level timing:
 * IELTS sections have one duration for the whole section; a SAT section's
 * two modules each have their OWN duration, and only one module is ever
 * "current" at a time (session.currentModuleId), so the duration that
 * matters is whichever module the student is actually on right now — not
 * a section-level number SAT sections don't even have.
 */
function getCurrentStageDurationMinutes(exam, session) {
  if (exam?.testType !== "sat") return getSectionDurationMinutes(exam, session.currentSection);
  const sectionDef = (exam?.sections || []).find((s) => s.type === session.currentSection);
  const moduleDef = sectionDef?.modules?.find((m) => m.id === session.currentModuleId);
  return moduleDef?.durationMinutes || 35; // 35 is a reasonable SAT-module-sized fallback, not a real default table
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
        test_type: examData.testType || "ielts",
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
  if (patch.testType !== undefined) row.test_type = patch.testType;
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
// Initial shape for session.answers, keyed by each of the exam's actual
// section types — previously this was hardcoded to
// { reading: {}, listening: {}, writing: {} } for every exam regardless of
// type, which left stray unused empty keys on an SAT session (whose real
// section types are "reading-writing"/"math") and initialized nothing for
// SAT's module-level routing state. sat: {} holds each section's routed
// module2 variant and Module 1 raw score once computed — see
// routes/sessions.js's SAT module-submission handling.
function initialAnswersShape(exam) {
  const shape = {};
  for (const section of exam?.sections || []) {
    if (section.type) shape[section.type] = {};
  }
  if (Object.keys(shape).length === 0) {
    // Fallback for safety if exam.sections is somehow empty/malformed —
    // keeps the old default rather than leaving answers with no keys at all.
    return { reading: {}, listening: {}, writing: {} };
  }
  if (exam?.testType === "sat") shape.sat = {};
  return shape;
}

async function createSession(examId, fullName, exam) {
  const { data, error } = await supabase
    .from("sessions")
    .insert({
      exam_id: examId,
      full_name: fullName || "",
      answers: initialAnswersShape(exam),
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
  const exam = await getExam(session.examId);
  if (!exam) return null;
  const order = getSectionOrder(exam);

  if (session.currentSection === section && session.sectionStartedAt) {
    // For SAT, "already on this section" only means it's genuinely still in
    // progress if a module is actually active — completeSatModule clears
    // currentModuleStage/currentModuleId once Module 2 finishes, but
    // deliberately leaves currentSection/sectionStartedAt alone (they're
    // not meaningless, just no longer "in progress"). Without this check,
    // a student who finished their only/last SAT section would have
    // beginSection silently treat it as still active forever, instead of
    // correctly falling through to say there's no next section.
    const sectionGenuinelyInProgress = exam.testType === "sat" ? !!session.currentModuleStage : true;
    if (sectionGenuinelyInProgress) return session; // already started — don't reset the timer
  }

  // A student can only move to the section immediately after the one
  // they're on (or to the first section from nothing yet) — never skip
  // ahead, never go backward. This is the server-side guard behind the
  // fact that the student UI itself has no way to trigger an early
  // section change — it also blocks a raw API call from doing the same.
  const currentIndex = session.currentSection ? order.indexOf(session.currentSection) : -1;
  const expectedNext = order[currentIndex + 1];
  if (section !== expectedNext) {
    const err = new Error(
      expectedNext === undefined
        ? "This exam's sections are already complete."
        : `Sections must be taken in order — expected "${expectedNext}".`
    );
    err.code = "SECTION_ORDER";
    throw err;
  }

  if (currentIndex >= 0 && session.sectionStartedAt) {
    const prevSectionType = order[currentIndex];
    if (exam.testType === "sat") {
      // SAT sections complete through their own explicit, server-graded
      // flow (completeSatModule finishing Module 2), not a stale-timer
      // check — a student literally cannot reach this point for a SAT
      // section unless completeSatModule already cleared its module
      // state, so this check is really just defense-in-depth.
      if (session.currentModuleStage) {
        const err = new Error(`The ${prevSectionType} section isn't finished yet.`);
        err.code = "SECTION_TIME_NOT_UP";
        throw err;
      }
    } else {
      // Even for the correct next section, it can't start until the
      // PREVIOUS section's full duration has actually elapsed — a student
      // who answers everything in reading in 20 minutes still can't reach
      // listening until reading's real 60 minutes are up, same as a real
      // IELTS test room.
      const requiredMs = getSectionDurationMinutes(exam, prevSectionType) * 60 * 1000;
      const elapsedMs = Date.now() - Date.parse(session.sectionStartedAt);
      const GRACE_MS = 5000; // clock-skew / request-latency buffer only, not extra time
      if (elapsedMs < requiredMs - GRACE_MS) {
        const err = new Error(`The ${prevSectionType} section isn't finished yet.`);
        err.code = "SECTION_TIME_NOT_UP";
        throw err;
      }
    }
  }

  const update = { current_section: section, section_started_at: new Date().toISOString() };
  if (exam.testType === "sat") {
    // Entering a SAT section always starts at Module 1 — Module 2 is only
    // ever reached via completeSatModule's routing decision, never directly.
    const sectionDef = exam.sections.find((s) => s.type === section);
    const module1 = sectionDef?.modules?.find((m) => m.stage === "module1");
    update.current_module_stage = "module1";
    update.current_module_id = module1?.id || null;
  }

  const { data, error } = await supabase
    .from("sessions")
    .update(update)
    .eq("session_id", sessionId)
    .select()
    .single();
  if (error) throw error;
  return rowToSession(data);
}

/**
 * Submits the student's answers for whichever SAT module they're currently
 * on (session.currentModuleStage / currentModuleId) and advances the state
 * machine:
 *   - Finishing Module 1 grades it, decides routing (satScoring.routeToModule2),
 *     stores that decision, and moves the student into the routed Module 2 —
 *     server-side only, so a student has no way to request the easier path.
 *   - Finishing Module 2 grades it, combines both modules' raw scores,
 *     computes the final scaled score (satScoring.scaleScore), stores it in
 *     session.results, and clears the module state — at that point
 *     beginSection can move on to the exam's next overall section.
 * Returns enough for the caller (routes/sessions.js) to tell the student
 * what happened: which stage just finished, and what comes next.
 */
async function completeSatModule(sessionId, moduleAnswers) {
  const session = await getSession(sessionId);
  if (!session) return null;
  const exam = await getExam(session.examId);
  if (!exam || exam.testType !== "sat") {
    const err = new Error("This session isn't a SAT exam.");
    err.code = "NOT_SAT";
    throw err;
  }
  const sectionType = session.currentSection;
  const stage = session.currentModuleStage;
  if (!sectionType || !stage) {
    const err = new Error("No SAT module is currently in progress for this session.");
    err.code = "NO_MODULE_IN_PROGRESS";
    throw err;
  }
  const sectionDef = exam.sections.find((s) => s.type === sectionType);
  const currentModule = sectionDef?.modules?.find((m) => m.id === session.currentModuleId);
  if (!currentModule) {
    const err = new Error("Could not find the current module definition.");
    err.code = "MODULE_NOT_FOUND";
    throw err;
  }

  const moduleKey = buildSatModuleAnswerKey(currentModule);
  const moduleResult = gradeSatModule(moduleAnswers, moduleKey);

  // Merge this module's answers into the section's flat answers object —
  // module1/module2's question ids are distinct (validateSatSection
  // requires each question to have its own id), so this never collides.
  const mergedSectionAnswers = { ...(session.answers?.[sectionType] || {}), ...moduleAnswers };
  const satState = { ...(session.answers?.sat || {}) };

  let update;
  let responseBody;

  if (stage === "module1") {
    const threshold = sectionDef.routing?.threshold;
    const routedTo = routeToModule2(moduleResult.rawScore, moduleResult.total, threshold);
    const module2 = sectionDef.modules.find((m) => m.stage === "module2" && m.difficulty === routedTo);
    satState[sectionType] = {
      module1RawScore: moduleResult.rawScore,
      module1Total: moduleResult.total,
      routedTo,
    };
    update = {
      answers: { ...session.answers, [sectionType]: mergedSectionAnswers, sat: satState },
      current_module_stage: "module2",
      current_module_id: module2?.id || null,
      section_started_at: new Date().toISOString(), // fresh timer for Module 2
    };
    responseBody = { stage: "module1", routedTo, nextModuleId: module2?.id || null, sectionComplete: false };
  } else {
    const m1 = satState[sectionType] || {};
    const totalCorrect = (m1.module1RawScore || 0) + moduleResult.rawScore;
    const totalQuestions = (m1.module1Total || 0) + moduleResult.total;
    const scaledScore = scaleScore(totalCorrect, totalQuestions, m1.routedTo);
    const results = { ...(session.results || {}) };
    results[sectionType] = { rawScore: totalCorrect, total: totalQuestions, scaledScore, module2Path: m1.routedTo };
    update = {
      answers: { ...session.answers, [sectionType]: mergedSectionAnswers, sat: satState },
      results,
      current_module_stage: null,
      current_module_id: null,
    };
    responseBody = { stage: "module2", sectionComplete: true, scaledScore, rawScore: totalCorrect, total: totalQuestions };
  }

  const { data, error } = await supabase
    .from("sessions")
    .update(update)
    .eq("session_id", sessionId)
    .select()
    .single();
  if (error) throw error;
  return { session: rowToSession(data), ...responseBody };
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
    testType: row.test_type || "ielts",
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
    currentModuleStage: row.current_module_stage || null, // SAT only: "module1" | "module2" | null
    currentModuleId: row.current_module_id || null, // SAT only — which module.id is currently active
    startedAt: row.started_at ? Date.parse(row.started_at) : null,
    completedAt: row.completed_at ? Date.parse(row.completed_at) : null,
    results: row.results,
    sheetRowRange: row.sheet_row_range || null,
    sheetError: row.sheet_error || null,
  };
}

module.exports = {
  createExam, getExam, deleteExam, updateExam, listExams, startExam, stopExam, setExamStatus, pauseExam, resumeExam, resolveStartCode,
  createSession, getSession, saveAnswers, completeSession, listSessionsForExam, beginSection, completeSatModule,
  SAT_SECTION_ORDER, getSectionOrder, getCurrentStageDurationMinutes,
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
    mustChangePassword: data.must_change_password,
    isSuperadmin: data.is_superadmin || false,
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
    mustChangePassword: data.must_change_password,
    isSuperadmin: data.is_superadmin || false,
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
  if (patch.passwordHash !== undefined) {
    row.password_hash = patch.passwordHash;
    // A real password change (not name/email) is exactly the event that
    // satisfies must_change_password — clear it here rather than requiring
    // every caller that changes a password to separately remember to.
    row.must_change_password = false;
  }

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
    mustChangePassword: data.must_change_password,
    isSuperadmin: data.is_superadmin || false,
  };
}

// Used by the one-time seed script (scripts/create-admin.js), and now also
// by the token-gated approval link in routes/adminRequests.js — that route
// is not a public "register an admin" endpoint (anyone can only ever create
// a pending *request*; only a valid single-use approve_token, sent solely to
// ADMIN_NOTIFY_EMAIL, can turn a request into a real admin_users row).
async function createAdmin({ email, passwordHash, fullName, centerId, mustChangePassword, isSuperadmin }) {
  const { data, error } = await supabase
    .from("admin_users")
    .insert({
      email: email.trim().toLowerCase(),
      password_hash: passwordHash,
      full_name: fullName || null,
      center_id: centerId || null,
      must_change_password: !!mustChangePassword,
      is_superadmin: !!isSuperadmin,
    })
    .select()
    .single();
  if (error) throw error;
  return { adminId: data.admin_id, email: data.email, fullName: data.full_name, centerId: data.center_id, mustChangePassword: data.must_change_password, isSuperadmin: data.is_superadmin || false };
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