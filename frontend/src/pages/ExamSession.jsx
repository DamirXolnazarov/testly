import React, { useState, useCallback, useRef, useEffect } from "react";
import PreTestFlow from "../components/shared/PreTestFlow";
import IELTSCDReplica from "../components/shared/IELTSCDReplica";
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

const SECTION_ORDER = ["reading", "listening", "writing"];
const STORAGE_KEY = "testly_session_id";
const POLL_MS = 3000;

export default function ExamSession() {
  const [stage, setStage] = useState("loading");
  const [session, setSession] = useState(null); // { fullName, sessionId, examData, savedAnswers, sectionStartedAt }
  const [sectionIndex, setSectionIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // ---- On mount: try to resume a saved session before showing PreTestFlow ----
  useEffect(() => {
    const savedId = localStorage.getItem(STORAGE_KEY);
    if (!savedId) {
      setStage("pretest");
      return;
    }
    fetch(`/api/sessions/${savedId}`)
      .then((res) => { if (!res.ok) throw new Error("not found"); return res.json(); })
      .then((data) => {
        if (data.status === "completed") {
          localStorage.removeItem(STORAGE_KEY);
          setSession({ fullName: data.fullName, results: data.results });
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
        const idx = data.currentSection ? SECTION_ORDER.indexOf(data.currentSection) : 0;
        setSession({
          sessionId: data.sessionId,
          fullName: data.fullName,
          examData: data.examData,
          savedAnswers: data.answers,
          sectionStartedAt: data.sectionStartedAt,
        });
        setSectionIndex(idx === -1 ? 0 : idx);
        setStage(data.currentSection || SECTION_ORDER[0]);
      })
      .catch(() => {
        localStorage.removeItem(STORAGE_KEY);
        setStage("pretest");
      });
  }, []);

  // ---- 1. Start-code validation — real call to POST /api/sessions ----
  // Note: this no longer returns exam data. A successful call only means the
  // code was valid and a waiting-room session was created — the student is
  // NOT admitted yet.
  const validateStartCode = useCallback(async (code, fullName) => {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, fullName }),
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
          setSession((s) => ({ ...s, examData: full.examData, savedAnswers: full.answers }));
          setSectionIndex(0);
          setStage(SECTION_ORDER[0]);
        }
        if (stage === "paused" && data.examStatus === "active") {
          const full = await fetch(`/api/sessions/${session.sessionId}`).then((r) => r.json());
          if (cancelled) return;
          const index = SECTION_ORDER.indexOf(full.currentSection || "reading");
          setSession((s) => ({ ...s, examData: full.examData, savedAnswers: full.answers, currentSection: full.currentSection }));
          setSectionIndex(index < 0 ? 0 : index);
          setStage(full.currentSection || "reading");
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
    if (!SECTION_ORDER.includes(stage) || !session?.sessionId) return;
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
    const interval = setInterval(checkExam, POLL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [stage, session?.sessionId]);

  // ---- Server-authoritative section timing ----
  // Called once when a section actually mounts (see the effect below).
  // Idempotent server-side, so re-mounting the same section (e.g. resume)
  // never grants extra time — it just returns the original timestamp.
  const [sectionStartedAt, setSectionStartedAt] = useState(session?.sectionStartedAt || null);
  useEffect(() => {
    if (!session?.sessionId || !SECTION_ORDER.includes(stage)) return;
    // If we just resumed into this exact section, we already have its start time.
    if (session.sectionStartedAt && SECTION_ORDER[sectionIndex] === stage) {
      setSectionStartedAt(session.sectionStartedAt);
      return;
    }
    fetch(`/api/sessions/${session.sessionId}/begin-section`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ section: stage }),
    })
      .then((r) => r.json())
      .then((d) => setSectionStartedAt(d.sectionStartedAt))
      .catch((e) => console.error("begin-section failed", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, session?.sessionId]);

  // ---- 2. Autosave — debounced PATCH /api/sessions/:id/answers ----
  const saveTimer = useRef(null);
  const autosaveAnswers = useCallback((sectionType, answers) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      setSession((s) => {
        if (!s?.sessionId) return s;
        fetch(`/api/sessions/${s.sessionId}/answers`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ section: sectionType, answers }),
        }).catch((e) => console.error("autosave failed", e));
        return s;
      });
    }, 800);
  }, []);

  // ---- Section transitions ----
  // Called by IELTSCDReplica's onSectionComplete(sectionType, answers) when the
  // student taps the check/submit button for that section.
  const handleSectionComplete = (sectionType, answers) => {
    clearTimeout(saveTimer.current);
    if (session?.sessionId) {
      // Flush immediately (not debounced) since we're navigating away from this section.
      fetch(`/api/sessions/${session.sessionId}/answers`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section: sectionType, answers }),
      }).catch((e) => console.error("final section save failed", e));
    }
    const next = sectionIndex + 1;
    if (next < SECTION_ORDER.length) {
      setSectionIndex(next);
      setStage(SECTION_ORDER[next]);
    } else {
      submitSession();
    }
  };

  // ---- 3. Final submit -> POST /api/sessions/:id/submit ----
  // Backend runs grader.js on reading+listening and sheetsService.js writes the row.
  const submitSession = async () => {
    setSubmitting(true);
    try {
      if (session?.sessionId) {
        const res = await fetch(`/api/sessions/${session.sessionId}/submit`, { method: "POST" });
        if (res.ok) {
          const data = await res.json();
          setSession((s) => ({ ...s, results: data.results }));
        }
      }
    } catch (e) {
      console.error("submit failed", e);
    } finally {
      localStorage.removeItem(STORAGE_KEY); // done — nothing left to resume
      setSubmitting(false);
      setStage("submitted");
    }
  };

  if (stage === "loading") {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Arial, sans-serif", color: "#999", fontSize: 13 }}>
        Loading…
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
    return <ResultsScreen fullName={session?.fullName} results={session?.results} />;
  }

  if (stage === "paused" || stage === "exam_closed") {
    return <ExamControlNotice fullName={session?.fullName} paused={stage === "paused"} />;
  }

  // reading / listening / writing: IELTSCDReplica is fully prop-driven.
  // sectionStartedAt (server timestamp) drives the timer instead of a fresh
  // client-side countdown, so a reload doesn't hand the student extra time —
  // see the <Timer /> change in IELTSCDReplica.jsx for how it's consumed.
  return (
    <div style={{ position: "relative" }}>
      <IELTSCDReplica
        section={stage}
        onSectionComplete={handleSectionComplete}
        onAnswerChange={autosaveAnswers}
        examData={session?.examData}
        initialAnswers={session?.savedAnswers?.[stage]}
        sectionStartedAt={sectionStartedAt}
      />
      {submitting && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(255,255,255,.7)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "Arial, sans-serif", fontSize: 14, fontWeight: 600, color: "#1a1a1a",
        }}>
          Submitting your test…
        </div>
      )}
    </div>
  );
}

function ExamControlNotice({ fullName, paused }) {
  return (
    <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "#f7f8fc", fontFamily: "Arial, sans-serif", color: "#111d40", textAlign: "center" }}>
      <div style={{ maxWidth: 420 }}>
        <div style={{ fontSize: 38, marginBottom: 16 }}>{paused ? "Ⅱ" : "■"}</div>
        <h1 style={{ fontSize: 24, margin: "0 0 10px" }}>{paused ? "The exam is paused" : "The exam has finished"}</h1>
        <p style={{ color: "#697087", lineHeight: 1.6, margin: 0 }}>{fullName ? `Hi ${fullName}. ` : ""}{paused ? "Please keep this page open. Your test will continue when the administrator resumes it." : "Your administrator has ended this test session."}</p>
      </div>
    </div>
  );
}