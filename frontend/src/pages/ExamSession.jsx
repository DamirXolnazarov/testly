import React, { useState, useCallback, useRef, useEffect } from "react";
import PreTestFlow from "../components/shared/PreTestFlow";
import IELTSCDReplica, { SectionTransitionScreen } from "../components/shared/IELTSCDReplica";
import SATBluebook from "../components/shared/SATBluebook";
import WaitingRoom from "./WaitingRoom";
import ResultsScreen from "../components/shared/ResultsScreen";

/**
 * ExamSession.jsx — the page that actually runs a student's test end to end.
 *
 * Stages: "loading" -> "pretest" -> "waiting" -> "reading" -> "listening" -> "writing" -> "submitted"
 *
 * Moderator admission gate: after PreTestFlow, a session is created as
 * "pending_admission" — the student sits in a waiting room polling
 * GET /api/sessions/:id/status until a moderator admits them from the admin
 * dashboard's live roster (POST /api/sessions/:id/admit). Only then does the
 * exam itself load and the clock start. This matters for proctored test
 * days where the moderator needs to visually confirm each student before
 * they can begin — a code alone isn't enough gatekeeping.
 *
 * Resume support: the session ID is kept in localStorage. On mount, if a
 * saved session ID exists, the backend tells us its real status (still
 * waiting / now in progress / already done) and we drop the student back
 * into the right place — waiting room, exact section with answers restored,
 * or the submitted screen — never losing the attempt or resetting a clock.
 *
 * Section timing is server-authoritative: each section calls
 * POST /api/sessions/:id/begin-section once on entry (idempotent), and the
 * client computes remaining time from that real start time.
 */

// Real IELTS order: Listening, then Reading, then Writing. Must match
// SECTION_ORDER in backend/src/services/store.js.
const IELTS_SECTION_ORDER = ["listening", "reading", "writing"];
const SAT_SECTION_ORDER = ["reading-writing", "math"];
const SECTION_DISPLAY_NAMES = {
  reading: "Reading",
  listening: "Listening",
  writing: "Writing",
  "reading-writing": "Reading and Writing",
  math: "Math",
};

const STORAGE_KEY = "testly_session_id";
const POLL_MS = 3000;

// ---- Never lose an answer ----
// Every change goes into an "outbox" (kept in memory AND in localStorage) and
// is only removed once the server has confirmed it. A failed save is retried
// with backoff for as long as the page is open, and anything still unsent
// when the tab closes or refreshes is sent first thing on the next load.
const outboxKey = (sid) => `testly_outbox_${sid}`;
const readOutbox = (sid) => {
  try { return JSON.parse(localStorage.getItem(outboxKey(sid)) || "{}") || {}; } catch { return {}; }
};
const writeOutbox = (sid, box) => {
  try {
    if (Object.keys(box).length) localStorage.setItem(outboxKey(sid), JSON.stringify(box));
    else localStorage.removeItem(outboxKey(sid));
  } catch { /* storage full or blocked — the in-memory outbox still works */ }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// => { ok: true } | { ok: false, retry: true } (network / server trouble)
//  | { ok: false, retry: false } (the server said no — retrying can't help)
async function sendAnswers(sid, section, answers) {
  try {
    const r = await fetch(`/api/sessions/${sid}/answers`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ section, answers }),
    });
    if (r.ok) return { ok: true };
    if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) return { ok: false, retry: false, status: r.status };
    return { ok: false, retry: true };
  } catch {
    return { ok: false, retry: true };
  }
}

// Loads a session, riding out a server that is slow or waking up. Only a real
// "no such session" (404) is final; anything else is retried.
async function fetchSessionWithRetry(sid, shouldStop) {
  let delay = 1000;
  for (let attempt = 0; attempt < 14; attempt++) {
    if (shouldStop && shouldStop()) throw new Error("stopped");
    try {
      const res = await fetch(`/api/sessions/${sid}`);
      if (res.ok) return await res.json();
      if (res.status === 404) throw new Error("not found");
    } catch (e) {
      if (e.message === "not found") throw e;
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 10000);
  }
  throw new Error("unreachable");
}

// Mirrors store.js's getSectionOrder exactly — same canonical orders, same
// filtering down to only the section types this exam actually has. A
// mismatch between the two would mean client and server disagree about
// which section comes next, which is exactly the kind of desync that
// produces a stuck student mid-exam.
function computeSectionOrder(examData) {
  const canonical = examData?.testType === "sat" ? SAT_SECTION_ORDER : IELTS_SECTION_ORDER;
  const present = new Set((examData?.sections || []).map((s) => s.type));
  const filtered = canonical.filter((t) => present.has(t));
  // Fallback only for the window before examData has loaded — never used
  // once a real exam is in hand.
  return filtered.length > 0 ? filtered : IELTS_SECTION_ORDER;
}

export default function ExamSession() {
  const [stage, setStage] = useState("loading");
  const [session, setSession] = useState(null); // { fullName, sessionId, examData, savedAnswers, sectionStartedAt }
  const [sectionIndex, setSectionIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitNote, setSubmitNote] = useState("");
  const [pendingNext, setPendingNext] = useState(null); // section index to move to once the transition screen finishes
  const sectionOrder = computeSectionOrder(session?.examData);

  // The outbox of unsent answers (see "Never lose an answer" above).
  const outboxRef = useRef({}); // section -> { answers, v }
  const versionRef = useRef(0);
  const sessionIdRef = useRef(null);
  const pumpingRef = useRef(false);
  const unmountedRef = useRef(false);
  const retryDelayRef = useRef(1000);
  useEffect(() => { sessionIdRef.current = session?.sessionId || null; }, [session?.sessionId]);
  useEffect(() => () => { unmountedRef.current = true; }, []);

  // Sends whatever is in the outbox, one request at a time (so a slow older
  // save can never land after, and overwrite, a newer one), retrying until
  // the server accepts it.
  const pumpOutbox = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      while (!unmountedRef.current) {
        const sid = sessionIdRef.current;
        const entries = Object.entries(outboxRef.current);
        if (!sid || entries.length === 0) break;
        const [section, item] = entries[0];
        const res = await sendAnswers(sid, section, item.answers);
        if (res.ok || !res.retry) {
          if (!res.ok) console.error("answers were refused by the server", section, res.status);
          // Keep the entry if the student has typed more since this send began.
          if (outboxRef.current[section]?.v === item.v) delete outboxRef.current[section];
          writeOutbox(sid, outboxRef.current);
          retryDelayRef.current = 1000;
          continue;
        }
        const wait = retryDelayRef.current;
        retryDelayRef.current = Math.min(wait * 2, 10000);
        await sleep(wait);
      }
    } finally {
      pumpingRef.current = false;
    }
  }, []);

  const queueSave = useCallback((section, answers) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    outboxRef.current[section] = { answers, v: ++versionRef.current };
    writeOutbox(sid, outboxRef.current);
  }, []);

  const waitForOutbox = useCallback(async (maxMs) => {
    const start = Date.now();
    pumpOutbox();
    while (Object.keys(outboxRef.current).length > 0 && Date.now() - start < maxMs) await sleep(250);
  }, [pumpOutbox]);

  // Warn before the tab closes if something hasn't reached the server yet.
  useEffect(() => {
    const warn = (e) => {
      if (Object.keys(outboxRef.current).length > 0) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  // ---- On mount: try to resume a saved session before showing PreTestFlow ----
  useEffect(() => {
    const savedId = localStorage.getItem(STORAGE_KEY);
    if (!savedId) {
      setStage("pretest");
      return;
    }
    // Anything that never reached the server last time goes first, so the
    // session we load already contains it.
    sessionIdRef.current = savedId;
    outboxRef.current = readOutbox(savedId);
    waitForOutbox(15000)
      .then(() => fetchSessionWithRetry(savedId, () => unmountedRef.current))
      .then((data) => {
        // Answers still waiting to be sent are newer than the server's copy —
        // show those, so further typing can never overwrite them with older text.
        for (const [section, item] of Object.entries(outboxRef.current)) {
          data.answers = { ...(data.answers || {}), [section]: item.answers };
        }
        if (data.status === "completed") {
          localStorage.removeItem(STORAGE_KEY);
          // examData is null for a completed session, so testType comes from
          // the response's own top-level field rather than examData.
          setSession({ fullName: data.fullName, results: data.results, testType: data.testType });
          setStage("submitted");
          return;
        }
        if (data.examStatus === "paused") {
          setSession({ sessionId: data.sessionId, fullName: data.fullName, currentSection: data.currentSection });
          setStage("paused");
          return;
        }
        if (data.examStatus === "closed") {
          setSession({ sessionId: data.sessionId, fullName: data.fullName });
          setStage("exam_closed");
          return;
        }
        if (data.status === "pending_admission") {
          setSession({ sessionId: data.sessionId, fullName: data.fullName });
          setStage("waiting");
          return;
        }
        const order = computeSectionOrder(data.examData);
        const idx = data.currentSection ? order.indexOf(data.currentSection) : 0;
        setSession({
          sessionId: data.sessionId,
          fullName: data.fullName,
          examData: data.examData,
          savedAnswers: data.answers,
          sectionStartedAt: data.sectionStartedAt,
          currentModuleStage: data.currentModuleStage || null,
          currentModuleId: data.currentModuleId || null,
        });
        setSectionIndex(idx === -1 ? 0 : idx);
        setStage(data.currentSection || order[0]);
      })
      .catch((e) => {
        if (e.message === "stopped") return;
        // Only a real "no such session" forgets the student's place. If the
        // server was just unreachable, keep it so the next refresh resumes.
        if (e.message === "not found") localStorage.removeItem(STORAGE_KEY);
        setStage("pretest");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 1. Start-code validation — real call to POST /api/sessions ----
  // Note: this no longer returns exam data. A successful call only means the
  // code was valid and a waiting-room session was created — the student is
  // NOT admitted yet.
  const validateStartCode = useCallback(async (code, fullName, email) => {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, fullName, email }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    localStorage.setItem(STORAGE_KEY, data.sessionId);
    setSession((s) => ({ ...s, sessionId: data.sessionId, examTitle: data.examTitle }));
    return true;
  }, []);

  const handlePreTestComplete = ({ fullName }) => {
    setSession((s) => ({ ...(s || {}), fullName }));
    setStage("waiting");
  };

  // ---- Waiting room: poll until a moderator admits this student ----
  useEffect(() => {
    if (!["waiting", "paused"].includes(stage) || !session?.sessionId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`/api/sessions/${session.sessionId}/status`);
        const data = await res.json();
        if (cancelled) return;
        if (data.examStatus === "paused") {
          if (stage !== "paused") setStage("paused");
          return;
        }
        if (data.examStatus === "closed") {
          setStage("exam_closed");
          return;
        }
        if (data.status === "in_progress") {
          // Admitted — fetch full session (now includes exam data) and proceed.
          const full = await fetch(`/api/sessions/${session.sessionId}`).then((r) => r.json());
          if (cancelled) return;
          const order = computeSectionOrder(full.examData);
          setSession((s) => ({ ...s, examData: full.examData, savedAnswers: full.answers, currentModuleStage: full.currentModuleStage || null, currentModuleId: full.currentModuleId || null }));
          setSectionIndex(0);
          setStage(order[0]);
        }
        if (stage === "paused" && data.examStatus === "active") {
          const full = await fetch(`/api/sessions/${session.sessionId}`).then((r) => r.json());
          if (cancelled) return;
          const order = computeSectionOrder(full.examData);
          const index = order.indexOf(full.currentSection || order[0]);
          setSession((s) => ({ ...s, examData: full.examData, savedAnswers: full.answers, currentSection: full.currentSection, currentModuleStage: full.currentModuleStage || null, currentModuleId: full.currentModuleId || null }));
          setSectionIndex(index < 0 ? 0 : index);
          setStage(full.currentSection || order[0]);
        }
      } catch (e) {
        console.error("waiting-room poll failed", e);
      }
    };

    poll(); // check immediately, then on an interval
    const interval = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [stage, session?.sessionId]);



  useEffect(() => {
    if (!sectionOrder.includes(stage) || !session?.sessionId) return;
    let cancelled = false;
    const checkExam = async () => {
      try {
        const response = await fetch(`/api/sessions/${session.sessionId}/status`);
        const data = await response.json();
        if (cancelled) return;
        if (data.examStatus === "paused") setStage("paused");
        if (data.examStatus === "closed") setStage("exam_closed");
      } catch (error) {
        console.error("exam status poll failed", error);
      }
    };
    // Only watches for a pause / close, so every 10s is plenty (the waiting
    // room above stays at 3s so admission feels instant).
    const interval = setInterval(checkExam, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [stage, session?.sessionId]);

  // ---- Server-authoritative section timing ----
  // Called once when a section actually mounts (see the effect below).
  // Idempotent server-side, so re-mounting the same section (e.g. resume)
  // never grants extra time — it just returns the original timestamp.
  const [sectionStartedAt, setSectionStartedAt] = useState(session?.sectionStartedAt || null);
  useEffect(() => {
    if (!session?.sessionId || !sectionOrder.includes(stage)) return;
    // ROOT CAUSE of "Listening/Writing instantly end after Reading":
    // this used to short-circuit with `session.sectionStartedAt` whenever
    // sectionOrder[sectionIndex] === stage. But handleSectionComplete /
    // proceedToNextSection set sectionIndex and stage together, so that
    // condition is ALSO true after every in-app advance — and
    // session.sectionStartedAt is only a snapshot from page load (Reading's
    // start). Listening and Writing therefore got Reading's old timestamp,
    // computed as already expired, and onExpire fired within ~1s of mount.
    // begin-section is idempotent server-side (returns the existing stamp
    // when resuming the same section, stamps fresh for a new one), so we
    // just always ask it. Clear the previous section's value first so a
    // stale stamp can never drive the new section's timer while the
    // request is in flight (null => timer shows the full duration).
    setSectionStartedAt(null);
    let cancelled = false;
    let retryTimer = null;
    // Previously this parsed the response body unconditionally, even on a
    // non-2xx status — an error JSON ({error, code}) has no
    // sectionStartedAt field, so a rejected begin-section (most plausibly
    // a narrow clock-skew race right at a section's time boundary, since
    // fetch doesn't reject on 4xx/5xx by design) silently set
    // sectionStartedAt to undefined. That fed straight into the section's
    // timer as an invalid start time, which is exactly the kind of state
    // that produces a frozen countdown and a broken render recoverable
    // only by a full reload — this never retried and never surfaced
    // anything, it just quietly corrupted the one piece of state the
    // whole section's timing depends on.
    //
    // Fix: check the response is actually ok before trusting its body,
    // never write a failed response's fields into state, and self-heal
    // with a short retry instead of requiring a manual reload — a
    // transient clock-skew rejection right at the boundary should
    // resolve itself within a couple seconds of real time passing.
    const attempt = (retriesLeft) => {
      fetch(`/api/sessions/${session.sessionId}/begin-section`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section: stage }),
      })
        .then(async (r) => {
          if (cancelled) return;
          const d = await r.json().catch(() => null);
          if (r.ok && d?.sectionStartedAt) {
            setSectionStartedAt(d.sectionStartedAt);
          } else if (retriesLeft > 0) {
            console.error("begin-section rejected, retrying", d?.error || r.status);
            retryTimer = setTimeout(() => attempt(retriesLeft - 1), 3000);
          } else {
            console.error("begin-section failed after retries", d?.error || r.status);
          }
        })
        .catch((e) => {
          if (cancelled) return;
          if (retriesLeft > 0) retryTimer = setTimeout(() => attempt(retriesLeft - 1), 3000);
          else console.error("begin-section failed after retries", e);
        });
    };
    // Keep trying for ~2 minutes: if this never succeeds the server refuses every
    // answer save for the section (it still thinks the student is elsewhere),
    // which silently loses their work.
    attempt(40);
    return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, session?.sessionId]);

  // ---- 2. Autosave — debounced PATCH /api/sessions/:id/answers ----
  const saveTimer = useRef(null);
  const autosaveAnswers = useCallback((sectionType, answers) => {
    queueSave(sectionType, answers);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(pumpOutbox, 800);
  }, [queueSave, pumpOutbox]);

  // ---- SAT only: called by SATBluebook right after Module 1 is submitted
  // and the SERVER has decided which Module 2 variant this student gets.
  // Keeps ExamSession's own state in sync with that decision so a refresh
  // mid-Module-2 resumes into the correct variant with the correct clock,
  // rather than falling back to Module 1. Never used for IELTS.
  const handleModuleAdvance = (moduleInfo) => {
    setSectionStartedAt(moduleInfo.sectionStartedAt);
    setSession((s) => ({ ...s, currentModuleStage: "module2", currentModuleId: moduleInfo.currentModuleId }));
  };

  // ---- Section transitions ----
  // Called by IELTSCDReplica's onSectionComplete(sectionType, answers) when the
  // student taps the check/submit button for that section.
  const handleSectionComplete = (sectionType, answers, opts) => {
    clearTimeout(saveTimer.current);
    if (session?.sessionId) {
      // Flush immediately (not debounced) since we're navigating away from
      // this section — and keep retrying in the background if it fails.
      queueSave(sectionType, answers);
      pumpOutbox();
    }
    setSession((s) => ({ ...s, currentModuleStage: null, currentModuleId: null }));
    const next = sectionIndex + 1;
    if (next < sectionOrder.length) {
      if (opts?.skipTransition) {
        // Early-finish path (EarlyFinishWaitingRoom) already waited out
        // real remaining section time PLUS the same buffer
        // SectionTransitionScreen would add — running that screen again
        // here would double the wait. Go straight into the next section.
        setSectionIndex(next);
        setStage(sectionOrder[next]);
        return;
      }
      // Natural timeout — no real "remaining time" to have already waited
      // through, so show the transition screen for the buffer instead.
      // The next section's own server-authoritative timer only starts once
      // that screen's onContinue fires (proceedToNextSection below), so
      // this pause is free administrative time, never eating into any
      // section's actual duration.
      setPendingNext(next);
      setStage("transition");
    } else {
      submitSession();
    }
  };

  const proceedToNextSection = () => {
    setSectionIndex(pendingNext);
    setStage(sectionOrder[pendingNext]);
    setPendingNext(null);
  };

  // ---- 3. Final submit -> POST /api/sessions/:id/submit ----
  // Backend runs grader.js on reading+listening and sheetsService.js writes the row.
  const submitSession = async () => {
    setSubmitting(true);
    const sid = session?.sessionId;
    let results = null;
    if (sid) {
      // 1. Every answer must have reached the server before we submit.
      await waitForOutbox(45000);
      // 2. Submit, and keep trying until the server confirms. A dropped
      //    connection or a waking server must never turn into a "submitted"
      //    screen for a test the server never received.
      let delay = 1000;
      for (let attempt = 0; !unmountedRef.current; attempt++) {
        try {
          const res = await fetch(`/api/sessions/${sid}/submit`, { method: "POST" });
          if (res.ok) { results = (await res.json()).results; break; }
          if (res.status === 409) {
            // An earlier attempt got through but its reply was lost.
            try { results = (await (await fetch(`/api/sessions/${sid}`)).json()).results || null; } catch { /* fine */ }
            break;
          }
          if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break; // can't succeed
        } catch (e) {
          console.error("submit failed, retrying", e);
        }
        if (attempt >= 2) setSubmitNote("Reconnecting… your answers are saved. Please keep this page open.");
        await sleep(delay);
        delay = Math.min(delay * 2, 10000);
      }
    }
    if (results) setSession((s) => ({ ...s, results }));
    localStorage.removeItem(STORAGE_KEY); // done — nothing left to resume
    if (sid) localStorage.removeItem(outboxKey(sid));
    setSubmitNote("");
    setSubmitting(false);
    setStage("submitted");
  };

  if (stage === "loading") {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 20,
          background: "#f5f6fa",
          fontFamily: "'Poppins', system-ui, sans-serif",
        }}
      >
        <img
          src="/images/testly-logo.png"
          alt="Testly"
          style={{ height: 34, opacity: 0.95 }}
        />
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: "50%",
            border: "3px solid rgba(91,91,214,0.2)",
            borderTopColor: "#5b5bd6",
            animation: "testly-spin 0.8s linear infinite",
          }}
        />
        <p style={{ color: "#6b7280", fontSize: 13, margin: 0 }}>
          Preparing your test session…
        </p>
        <style>{`@keyframes testly-spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (stage === "pretest") {
    return <PreTestFlow onComplete={handlePreTestComplete} validateStartCode={validateStartCode} />;
  }

  if (stage === "waiting") {
    return <WaitingRoom fullName={session?.fullName} examTitle={session?.examTitle} />;
  }

  if (stage === "submitted") {
    return <ResultsScreen fullName={session?.fullName} results={session?.results} testType={session?.testType || session?.examData?.testType} />;
  }

  if (stage === "paused" || stage === "exam_closed") {
    return <WaitingRoom fullName={session?.fullName} variant={stage === "paused" ? "paused" : "closed"} />;
  }

  if (stage === "transition" && pendingNext !== null) {
    // key forces a clean remount (and a fresh countdown) for every distinct
    // transition, rather than React reusing the same instance and relying
    // on the effect's own dependency-based reset.
    const completedType = sectionOrder[pendingNext - 1];
    const nextType = sectionOrder[pendingNext];
    return (
      <SectionTransitionScreen
        key={`${completedType}-${nextType}`}
        completedLabel={SECTION_DISPLAY_NAMES[completedType] || completedType}
        nextLabel={SECTION_DISPLAY_NAMES[nextType] || nextType}
        durationSeconds={60}
        onContinue={proceedToNextSection}
      />
    );
  }

  // reading / listening / writing: IELTSCDReplica is fully prop-driven.
  // sectionStartedAt (server timestamp) drives the timer instead of a fresh
  // client-side countdown, so a reload doesn't hand the student extra time —
  // see the <Timer /> change in IELTSCDReplica.jsx for how it's consumed.
  const isSat = session?.examData?.testType === "sat";

  return (
    <div style={{ position: "relative" }}>
      {isSat ? (
        <SATBluebook
          sessionId={session?.sessionId}
          examData={session?.examData}
          sectionType={stage}
          currentModuleStage={session?.currentModuleStage}
          currentModuleId={session?.currentModuleId}
          initialAnswers={session?.savedAnswers?.[stage]}
          sectionStartedAt={sectionStartedAt}
          onAnswerChange={autosaveAnswers}
          onModuleAdvance={handleModuleAdvance}
          onSectionComplete={handleSectionComplete}
        />
      ) : (
        <IELTSCDReplica
          section={stage}
          onSectionComplete={handleSectionComplete}
          onAnswerChange={autosaveAnswers}
          examData={session?.examData}
          initialAnswers={session?.savedAnswers?.[stage]}
          sectionStartedAt={sectionStartedAt}
        />
      )}
      {submitting && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(255,255,255,.7)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "Arial, sans-serif", fontSize: 14, fontWeight: 600, color: "#1a1a1a",
        }}>
          <div style={{ textAlign: "center", lineHeight: 1.6 }}>
            Submitting your test…
            {submitNote && <div style={{ fontWeight: 400, color: "#a05a00", marginTop: 6 }}>{submitNote}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
