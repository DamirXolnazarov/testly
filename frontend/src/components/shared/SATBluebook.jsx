import React, { useState, useEffect, useRef, useCallback } from "react";

/**
 * SATBluebook.jsx — THE SAT exam UI, styled after College Board's Bluebook app.
 *
 * Deliberately its own component rather than a mode inside IELTSCDReplica:
 * the two tests share almost no UI. IELTS CD is a monochrome split-pane with
 * part tabs and a question-number strip; Bluebook is a white, roomy,
 * single-question-at-a-time flow with a top bar, a bottom nav with a
 * question-navigator popover, per-question "Mark for Review", and (for
 * Reading & Writing) a left passage / right question split.
 *
 * Like IELTSCDReplica, this deliberately does NOT use Testly's brand colors
 * (theme.js COLORS) — it's an imitation of a specific real interface, so it
 * uses Bluebook's own palette. Don't restyle it to match the rest of the app.
 *
 * Adaptive flow (the part that makes SAT structurally different from IELTS):
 * a section is Module 1 -> a server-decided Module 2 variant -> section done.
 * This component NEVER decides routing itself; it POSTs the module's answers
 * to /api/sessions/:id/complete-module and does whatever the server says
 * came next. See services/satScoring.js and store.completeSatModule.
 */

const BB = {
  ink: "#1e1e1e",
  sub: "#5b5b5b",
  line: "#d4d4d4",
  blue: "#324dc7",
  blueDark: "#26399c",
  bg: "#ffffff",
  shell: "#f4f4f4",
  mark: "#c9432f",
};

export default function SATBluebook({
  sessionId,
  examData,
  sectionType,
  currentModuleStage,
  currentModuleId,
  initialAnswers,
  sectionStartedAt,
  onAnswerChange,
  onModuleAdvance,
  onSectionComplete,
}) {
  const section = (examData?.sections || []).find((s) => s.type === sectionType);
  const modules = section?.modules || [];

  // Which module is active is driven by server state (currentModuleId), not
  // local guessing — on a refresh mid-Module-2 this lands on the right
  // variant instead of restarting at Module 1.
  const activeModule =
    modules.find((m) => m.id === currentModuleId) ||
    modules.find((m) => m.stage === "module1") ||
    modules[0];

  const questions = activeModule?.questions || [];
  const [qIdx, setQIdx] = useState(0);
  const [answers, setAnswers] = useState(initialAnswers || {});
  const [marked, setMarked] = useState(() => new Set(initialAnswers?.__marked || []));
  const [navOpen, setNavOpen] = useState(false);
  const [review, setReview] = useState(false); // the "Check Your Work" review screen before submitting a module
  const [submitting, setSubmitting] = useState(false);
  const [transition, setTransition] = useState(null); // between-module screen
  const [error, setError] = useState(null);

  // Reset per-module UI state whenever the active module changes (Module 1
  // -> Module 2). Answers deliberately persist in one object across both
  // modules of a section — question ids are unique per module, and the
  // backend merges them into the same section answers object.
  useEffect(() => {
    setQIdx(0);
    setNavOpen(false);
    setReview(false);
  }, [activeModule?.id]);

  // Autosave, same contract as IELTSCDReplica: marked-for-review rides along
  // under a reserved __marked key so it survives a refresh (grader.js never
  // reads unrecognized keys, so it's inert for scoring).
  useEffect(() => {
    onAnswerChange?.(sectionType, { ...answers, __marked: [...marked] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers, marked]);

  const q = questions[qIdx];
  const setAnswer = (id, value) => setAnswers((a) => ({ ...a, [id]: value }));
  const toggleMark = (id) =>
    setMarked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // ---- Submitting a module -> server routes/scores, we follow ----
  const submitModule = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/complete-module`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Could not submit this module.");
      }
      const data = await res.json();
      if (data.sectionComplete) {
        onSectionComplete?.(sectionType, answers);
      } else {
        // Module 1 done — show the between-module screen, then continue into
        // whichever Module 2 the server routed this student to. The variant
        // itself is deliberately never surfaced to the student (the real
        // test doesn't tell you either, and knowing would be discouraging).
        onModuleAdvance?.({ currentModuleId: data.currentModuleId, sectionStartedAt: data.sectionStartedAt });
        setTransition({ next: data.currentModuleId });
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }, [answers, sessionId, sectionType, submitting, onSectionComplete, onModuleAdvance]);

  // Time expiry submits the module automatically — same as the real test,
  // where running out of time on a module just moves you on.
  const handleExpire = useCallback(() => { submitModule(); }, [submitModule]);

  if (!section || !activeModule) {
    return <div style={{ padding: 40, fontFamily: "Arial, sans-serif" }}>This section has no modules to display.</div>;
  }

  if (transition) {
    return (
      <ModuleTransition
        sectionLabel={sectionLabel(sectionType)}
        onContinue={() => setTransition(null)}
      />
    );
  }

  const answeredCount = questions.filter((qq) => hasAnswer(answers[qq.id])).length;

  return (
    <div style={S.page}>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <header style={S.topBar}>
        <div>
          <div style={S.topTitle}>{sectionLabel(sectionType)}</div>
          <div style={S.topSub}>
            {activeModule.stage === "module1" ? "Module 1" : "Module 2"}
          </div>
        </div>
        <Timer startedAt={sectionStartedAt} minutes={activeModule.durationMinutes || 35} onExpire={handleExpire} />
        <div style={S.topRight}>{answeredCount} of {questions.length} answered</div>
      </header>

      {error && <div style={S.errorBar}>{error}</div>}

      {review ? (
        <ReviewScreen
          questions={questions}
          answers={answers}
          marked={marked}
          onJump={(i) => { setQIdx(i); setReview(false); }}
          onBack={() => setReview(false)}
          onSubmit={submitModule}
          submitting={submitting}
          isLastModule={activeModule.stage === "module2"}
        />
      ) : (
        <main style={S.main}>
          {sectionType === "reading-writing" ? (
            <div style={S.split}>
              <div style={S.pane}>
                <div style={S.passage}>{q?.passage || section.passage || ""}</div>
              </div>
              <div style={S.paneDivider} />
              <div style={S.pane}>
                <QuestionBlock
                  q={q}
                  index={qIdx}
                  value={answers[q?.id]}
                  onChange={(v) => setAnswer(q.id, v)}
                  marked={marked.has(q?.id)}
                  onToggleMark={() => toggleMark(q.id)}
                />
              </div>
            </div>
          ) : (
            <div style={S.singleCol}>
              <QuestionBlock
                q={q}
                index={qIdx}
                value={answers[q?.id]}
                onChange={(v) => setAnswer(q.id, v)}
                marked={marked.has(q?.id)}
                onToggleMark={() => toggleMark(q.id)}
              />
            </div>
          )}
        </main>
      )}

      {!review && (
        <footer style={S.bottomBar}>
          <div style={S.bottomLeft} />
          <div style={{ position: "relative" }}>
            <button className="bb-navbtn" onClick={() => setNavOpen((o) => !o)}>
              Question {qIdx + 1} of {questions.length} ▲
            </button>
            {navOpen && (
              <QuestionNavigator
                questions={questions}
                answers={answers}
                marked={marked}
                current={qIdx}
                onJump={(i) => { setQIdx(i); setNavOpen(false); }}
                onGoToReview={() => { setNavOpen(false); setReview(true); }}
              />
            )}
          </div>
          <div style={S.bottomRight}>
            <button
              className="bb-btn ghost"
              onClick={() => setQIdx((i) => Math.max(0, i - 1))}
              disabled={qIdx === 0}
            >
              Back
            </button>
            {qIdx < questions.length - 1 ? (
              <button className="bb-btn" onClick={() => setQIdx((i) => i + 1)}>Next</button>
            ) : (
              <button className="bb-btn" onClick={() => setReview(true)}>Review</button>
            )}
          </div>
        </footer>
      )}
    </div>
  );
}

/* ---------------- Question rendering ---------------- */

function QuestionBlock({ q, index, value, onChange, marked, onToggleMark }) {
  if (!q) return null;
  return (
    <div>
      <div style={S.qHeader}>
        <span style={S.qNum}>{index + 1}</span>
        <button className={`bb-mark ${marked ? "on" : ""}`} onClick={onToggleMark}>
          {marked ? "★ Marked for Review" : "☆ Mark for Review"}
        </button>
      </div>
      <p style={S.qPrompt}>{q.prompt}</p>

      {q.type === "grid-in" ? (
        <div>
          <input
            className="bb-gridin"
            value={value || ""}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Enter answer"
            inputMode="text"
          />
          <div style={S.gridHint}>
            You may enter a whole number, decimal, or fraction (for example, 3/4 or .75).
          </div>
        </div>
      ) : (
        <div>
          {(q.options || []).map((opt, i) => {
            const letter = String.fromCharCode(65 + i);
            const selected = value === opt;
            return (
              <button
                key={i}
                className={`bb-choice ${selected ? "sel" : ""}`}
                onClick={() => onChange(opt)}
              >
                <span className={`bb-letter ${selected ? "sel" : ""}`}>{letter}</span>
                <span>{opt}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------------- Question navigator popover ---------------- */

function QuestionNavigator({ questions, answers, marked, current, onJump, onGoToReview }) {
  return (
    <div style={S.navPop}>
      <div style={S.navGrid}>
        {questions.map((qq, i) => {
          const answered = hasAnswer(answers[qq.id]);
          const cls = ["bb-navcell", i === current ? "cur" : "", answered ? "ans" : "", marked.has(qq.id) ? "mk" : ""]
            .filter(Boolean).join(" ");
          return <button key={qq.id} className={cls} onClick={() => onJump(i)}>{i + 1}</button>;
        })}
      </div>
      <div style={S.navLegend}>
        <span><i className="bb-dot cur" /> Current</span>
        <span><i className="bb-dot ans" /> Answered</span>
        <span><i className="bb-dot mk" /> For Review</span>
      </div>
      <button className="bb-btn wide" onClick={onGoToReview}>Go to Review Page</button>
    </div>
  );
}

/* ---------------- Review ("Check Your Work") screen ---------------- */

function ReviewScreen({ questions, answers, marked, onJump, onBack, onSubmit, submitting, isLastModule }) {
  const unanswered = questions.filter((qq) => !hasAnswer(answers[qq.id])).length;
  return (
    <main style={S.reviewWrap}>
      <h1 style={S.reviewTitle}>Check Your Work</h1>
      <p style={S.reviewSub}>
        You can still go back and change your answers. Once you submit, you cannot return to this module.
      </p>
      <div style={S.navGrid}>
        {questions.map((qq, i) => {
          const answered = hasAnswer(answers[qq.id]);
          const cls = ["bb-navcell", answered ? "ans" : "", marked.has(qq.id) ? "mk" : ""].filter(Boolean).join(" ");
          return <button key={qq.id} className={cls} onClick={() => onJump(i)}>{i + 1}</button>;
        })}
      </div>
      {unanswered > 0 && (
        <p style={S.reviewWarn}>
          You have {unanswered} unanswered {unanswered === 1 ? "question" : "questions"}. There is no penalty for guessing.
        </p>
      )}
      <div style={S.reviewActions}>
        <button className="bb-btn ghost" onClick={onBack}>Back to Questions</button>
        <button className="bb-btn" onClick={onSubmit} disabled={submitting}>
          {submitting ? "Submitting…" : isLastModule ? "Submit Section" : "Submit Module"}
        </button>
      </div>
    </main>
  );
}

/* ---------------- Between-module screen ---------------- */

function ModuleTransition({ sectionLabel, onContinue }) {
  return (
    <div style={S.transWrap}>
      <div style={{ maxWidth: 480, textAlign: "center" }}>
        <h1 style={S.transTitle}>Module 1 Complete</h1>
        <p style={S.transText}>
          You have finished Module 1 of {sectionLabel}. Module 2 begins when you continue, with its own
          time limit. You cannot return to Module 1.
        </p>
        <button className="bb-btn" onClick={onContinue}>Continue to Module 2</button>
      </div>
    </div>
  );
}

/* ---------------- Timer ---------------- */

// Server-authoritative, same approach as IELTSCDReplica's Timer: remaining
// time is derived from the server's start timestamp, never from a local
// countdown that a refresh could restart.
function Timer({ startedAt, minutes, onExpire }) {
  const total = minutes * 60;
  const compute = () => {
    if (!startedAt) return total;
    return Math.max(0, total - Math.floor((Date.now() - startedAt) / 1000));
  };
  const [left, setLeft] = useState(compute);
  const [hidden, setHidden] = useState(false);
  const firedRef = useRef(false);

  useEffect(() => {
    setLeft(compute());
    firedRef.current = false;
    const t = setInterval(() => {
      const next = compute();
      setLeft(next);
      if (next <= 0 && !firedRef.current) {
        firedRef.current = true;
        onExpire?.();
      }
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startedAt, minutes]);

  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");
  const low = left <= 300;

  return (
    <div style={S.timerWrap}>
      <div style={{ ...S.timerClock, color: low ? BB.mark : BB.ink }}>
        {hidden ? "— —" : `${mm}:${ss}`}
      </div>
      <button className="bb-hide" onClick={() => setHidden((h) => !h)}>
        {hidden ? "Show" : "Hide"}
      </button>
    </div>
  );
}

/* ---------------- helpers ---------------- */

function hasAnswer(v) {
  return v !== undefined && v !== null && String(v).trim() !== "";
}

function sectionLabel(type) {
  return type === "reading-writing" ? "Reading and Writing" : type === "math" ? "Math" : type;
}

const S = {
  page: { minHeight: "100dvh", display: "flex", flexDirection: "column", background: BB.bg, color: BB.ink, fontFamily: '"Helvetica Neue", Arial, sans-serif' },
  topBar: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 24px", borderBottom: `1px solid ${BB.line}`, background: BB.bg },
  topTitle: { fontSize: 15, fontWeight: 700 },
  topSub: { fontSize: 12.5, color: BB.sub, marginTop: 2 },
  topRight: { fontSize: 12.5, color: BB.sub, minWidth: 140, textAlign: "right" },
  timerWrap: { display: "flex", flexDirection: "column", alignItems: "center", gap: 4 },
  timerClock: { fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums", letterSpacing: 0.5 },
  main: { flex: 1, display: "flex", overflow: "hidden" },
  split: { flex: 1, display: "flex", minHeight: 0 },
  pane: { flex: 1, overflowY: "auto", padding: "28px 34px", minWidth: 0 },
  paneDivider: { width: 1, background: BB.line },
  singleCol: { flex: 1, overflowY: "auto", padding: "28px 34px", maxWidth: 760, margin: "0 auto", width: "100%" },
  passage: { fontSize: 15.5, lineHeight: 1.75, whiteSpace: "pre-wrap" },
  qHeader: { display: "flex", alignItems: "center", gap: 12, marginBottom: 14, paddingBottom: 12, borderBottom: `1px solid ${BB.line}` },
  qNum: { background: BB.ink, color: "#fff", width: 26, height: 26, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13.5, fontWeight: 700 },
  qPrompt: { fontSize: 15.5, lineHeight: 1.7, margin: "0 0 18px" },
  gridHint: { fontSize: 12.5, color: BB.sub, marginTop: 10, lineHeight: 1.5 },
  bottomBar: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 24px", borderTop: `1px solid ${BB.line}`, background: BB.shell },
  bottomLeft: { flex: 1 },
  bottomRight: { flex: 1, display: "flex", justifyContent: "flex-end", gap: 10 },
  navPop: { position: "absolute", bottom: "calc(100% + 10px)", left: "50%", transform: "translateX(-50%)", background: "#fff", border: `1px solid ${BB.line}`, borderRadius: 8, padding: 16, boxShadow: "0 8px 28px rgba(0,0,0,.16)", zIndex: 50, width: 340 },
  navGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(38px, 1fr))", gap: 8, marginBottom: 14 },
  navLegend: { display: "flex", gap: 14, fontSize: 11.5, color: BB.sub, marginBottom: 12, flexWrap: "wrap" },
  reviewWrap: { flex: 1, overflowY: "auto", padding: "40px 34px", maxWidth: 720, margin: "0 auto", width: "100%" },
  reviewTitle: { fontSize: 26, margin: "0 0 8px", textAlign: "center" },
  reviewSub: { fontSize: 14, color: BB.sub, textAlign: "center", margin: "0 0 28px", lineHeight: 1.6 },
  reviewWarn: { fontSize: 13.5, color: BB.mark, textAlign: "center", lineHeight: 1.6 },
  reviewActions: { display: "flex", justifyContent: "center", gap: 12, marginTop: 24 },
  transWrap: { minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: BB.bg, color: BB.ink, fontFamily: '"Helvetica Neue", Arial, sans-serif' },
  transTitle: { fontSize: 28, margin: "0 0 14px" },
  transText: { fontSize: 15, color: BB.sub, lineHeight: 1.7, margin: "0 0 28px" },
  errorBar: { background: "#fdeceb", color: "#b3261e", padding: "10px 24px", fontSize: 13 },
};

const CSS = `
.bb-btn { background:${BB.blue}; color:#fff; border:none; padding:10px 22px; border-radius:20px; font-size:14px; font-weight:600; cursor:pointer; font-family:inherit; }
.bb-btn:hover:not(:disabled) { background:${BB.blueDark}; }
.bb-btn:disabled { opacity:.5; cursor:default; }
.bb-btn.ghost { background:#fff; color:${BB.blue}; border:1px solid ${BB.blue}; }
.bb-btn.ghost:hover:not(:disabled) { background:#eef1fc; }
.bb-btn.wide { width:100%; }
.bb-navbtn { background:#fff; border:1px solid ${BB.line}; border-radius:6px; padding:8px 16px; font-size:13.5px; font-weight:600; cursor:pointer; font-family:inherit; color:${BB.ink}; }
.bb-navbtn:hover { border-color:${BB.blue}; }
.bb-choice { display:flex; align-items:flex-start; gap:12px; width:100%; text-align:left; background:#fff; border:1.5px solid ${BB.line}; border-radius:8px; padding:13px 16px; margin-bottom:10px; font-size:15px; line-height:1.55; cursor:pointer; font-family:inherit; color:${BB.ink}; }
.bb-choice:hover { border-color:${BB.blue}; }
.bb-choice.sel { border-color:${BB.blue}; background:#eef1fc; }
.bb-letter { flex:0 0 auto; width:24px; height:24px; border-radius:50%; border:1.5px solid ${BB.sub}; display:flex; align-items:center; justify-content:center; font-size:12.5px; font-weight:700; }
.bb-letter.sel { background:${BB.blue}; border-color:${BB.blue}; color:#fff; }
.bb-gridin { width:220px; padding:12px 14px; font-size:17px; border:1.5px solid ${BB.line}; border-radius:6px; font-family:inherit; }
.bb-gridin:focus { outline:none; border-color:${BB.blue}; }
.bb-mark { background:none; border:none; font-size:12.5px; color:${BB.sub}; cursor:pointer; font-family:inherit; padding:4px 6px; border-radius:4px; }
.bb-mark:hover { background:#f0f0f0; }
.bb-mark.on { color:${BB.mark}; font-weight:600; }
.bb-navcell { aspect-ratio:1; border:1px dashed ${BB.line}; background:#fff; border-radius:4px; font-size:12.5px; cursor:pointer; font-family:inherit; color:${BB.ink}; position:relative; }
.bb-navcell:hover { border-color:${BB.blue}; }
.bb-navcell.ans { background:${BB.blue}; border:1px solid ${BB.blue}; color:#fff; }
.bb-navcell.cur { outline:2px solid ${BB.ink}; outline-offset:1px; }
.bb-navcell.mk::after { content:"★"; position:absolute; top:-6px; right:-3px; font-size:11px; color:${BB.mark}; }
.bb-dot { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:4px; vertical-align:middle; }
.bb-dot.cur { border:2px solid ${BB.ink}; }
.bb-dot.ans { background:${BB.blue}; }
.bb-dot.mk { background:${BB.mark}; }
.bb-hide { background:none; border:1px solid ${BB.line}; border-radius:14px; font-size:11.5px; padding:2px 12px; cursor:pointer; font-family:inherit; color:${BB.sub}; }
.bb-hide:hover { border-color:${BB.blue}; color:${BB.blue}; }
@media (max-width: 820px) {
  .bb-choice { font-size:14px; }
}
`;
