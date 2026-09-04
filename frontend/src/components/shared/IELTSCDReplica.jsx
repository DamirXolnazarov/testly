import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  Wifi, Bell, Menu, StickyNote, X, ArrowRight, MoveHorizontal,
  Check, Headphones as HeadphonesIcon, Play as PlayIcon, Volume2, VolumeX, Flag,
} from "lucide-react";
import { MatchingQuestion, MatchingOptionBank, MapQuestion, QUESTION_TYPE_CSS } from "./QuestionTypes";

/**
 * IELTS CD Replica v2 — matched against real test-taker screenshots.
 * Modules: Reading (mcq / tfng / gap-fill / table / matching / map — all
 * type-driven, see QuestionRenderer below), Listening (pre-play gate +
 * playing state, no pause/rewind), Writing (chart prompt + live word count).
 *
 * Exam JSON contract (what admin-side AI generation should emit) — see
 * docs/exam-json-schema.md. Reading's `data.parts[]` shape (each with a
 * `questions[]` array of mixed types) is the generic one that schema
 * describes; swap READING_JSON for real admin-authored data via the
 * `examData` prop on <IELTSCDReplica />.
 * Grading key (`answer` fields) should be stripped before sending this JSON
 * to the student client; keep it server-side for auto-grading.
 */

// ---------------- Icons — lucide-react, wrapped so existing <Icon.X /> call
// sites elsewhere in this file need zero changes. ----------------
const Icon = {
  Wifi: () => <Wifi size={18} strokeWidth={2} />,
  Bell: () => <Bell size={18} strokeWidth={2} />,
  Menu: () => <Menu size={20} strokeWidth={2} />,
  Notes: () => <StickyNote size={18} strokeWidth={2} />,
  Close: () => <X size={18} strokeWidth={2} />,
  Arrow: ({ dir = "right" }) => (
    <ArrowRight size={18} strokeWidth={2.2} style={{ transform: dir === "left" ? "rotate(180deg)" : "none" }} />
  ),
  Resize: () => <MoveHorizontal size={14} strokeWidth={2} />,
  Check: () => <Check size={20} strokeWidth={2.4} />,
  Headphones: () => <HeadphonesIcon size={72} strokeWidth={1.6} />,
  Play: () => <PlayIcon size={14} fill="currentColor" />,
  Speaker: () => <Volume2 size={14} strokeWidth={2} />,
  Flag: () => <Flag size={13} strokeWidth={2} />,
};

// ---------------- Sample exam JSON (generic parts/questions shape) ----------------
const READING_JSON = {
  parts: [
    {
      id: "part1",
      title: "The life and work of Marie Curie",
      instructionsTitle: "Questions 1–3",
      instructions: (
        <>Choose <b>TRUE</b> if the statement agrees with the information given in the text, choose{" "}
          <b>FALSE</b> if the statement contradicts the information, or choose <b>NOT GIVEN</b> if there is no
          information on this.</>
      ),
      passage: [
        "Marie Curie is probably the most famous woman scientist who has ever lived. Born Maria Sklodowska in Poland in 1867, she is famous for her work on radioactivity, and was twice a winner of the Nobel Prize. With her husband, Pierre Curie, and Henri Becquerel, she was awarded the 1903 Nobel Prize for Physics, and was then sole winner of the 1911 Nobel Prize for Chemistry. She was the first woman to win a Nobel Prize.",
        "From childhood, Marie was remarkable for her prodigious memory, and at the age of 16 won a gold medal on completion of her secondary education. Because her father lost his savings through bad investment, she then had to take work as a teacher. From her earnings she was able to finance her sister Bronia's medical studies in Paris, on the understanding that Bronia would, in turn, later help her to get an education.",
        "In 1891 this promise was fulfilled and Marie went to Paris and began to study at the Sorbonne (the University of Paris). She often worked far into the night and lived on little more than bread and butter and tea. She came first in the examination in the physical sciences in 1893, and in 1894 was placed second in the examination in mathematical sciences. It was not until the spring of that year that she was introduced to Pierre Curie.",
        "Their marriage in 1895 marked the start of a partnership that was soon to achieve results of world significance. Following Henri Becquerel's discovery in 1896 of a new phenomenon, which Marie later called 'radioactivity', Marie Curie decided to find out if the radioactivity discovered in uranium was to be found in other elements. She discovered that this was true for thorium.",
      ],
      questions: [
        { id: "q1", n: 1, type: "tfng", prompt: "Marie Curie's husband was a joint winner of both Marie's Nobel Prizes." },
        { id: "q2", n: 2, type: "tfng", prompt: "Marie became interested in science when she was a child." },
        { id: "q3", n: 3, type: "tfng", prompt: "Marie was able to attend the Sorbonne because of her sister's financial contribution." },
        {
          id: "q4", n: 4, type: "mcq",
          prompt: "According to the passage, why did Marie Curie start working as a teacher?",
          options: ["She wanted to fund her own studies", "Her father lost his savings in a bad investment", "She was not accepted at the Sorbonne", "Pierre Curie recommended it"],
        },
        {
          id: "q5", n: 5, type: "gap-fill",
          before: "When uranium was discovered to be radioactive, Marie Curie found that the element called",
          after: "had the same property.",
        },
        {
          id: "q6", n: 6, type: "matching",
          groupTitle: "Questions 6–7", groupInstructions: "Match each person below with the correct description.",
          prompt: "Henri Becquerel",
          options: ["Discovered a new phenomenon he called 'radioactivity'", "Financed Marie's education after her own studies", "Co-directed the Radium Institute in Warsaw"],
        },
        {
          id: "q7", n: 7, type: "matching",
          prompt: "Bronia Sklodowska",
          options: ["Discovered a new phenomenon he called 'radioactivity'", "Financed Marie's education after her own studies", "Co-directed the Radium Institute in Warsaw"],
        },
        {
          id: "q8", n: 8, type: "table",
          groupTitle: "Questions 8–9", groupInstructions: "Complete the table below.",
          table: { headers: ["Year", "Event"], rows: [["1891", "___GAP8___"], ["1895", "Married Pierre Curie"]] },
          gaps: [{ id: "q8gap", n: 8, cellMarker: "___GAP8___" }],
        },
      ],
    },
  ],
};

const LISTENING_JSON = {
  title: "Phone call about second-hand furniture",
  instructions: "Complete the notes. Write ONE WORD AND/OR A NUMBER for each answer.",
  audioUrl: null, // ElevenLabs-generated URL goes here
  items: [
    { label: "Dining table:", lines: [
      { pre: "-", n: 1, post: "shape" },
      { pre: "-", text: "medium size" },
      { pre: "-", n: 2, post: "old" },
      { pre: "-", text: "price: £25.00" },
    ]},
    { label: "Dining chairs:", lines: [
      { pre: "- set of", n: 3, post: "chairs" },
      { pre: "- seats covered in", n: 4, post: "material" },
      { pre: "- in", n: 5, post: "condition" },
      { pre: "-", text: "price: £20.00" },
    ]},
  ],
};

const WRITING_JSON = {
  type: "writing",
  parts: [
    {
      id: "w-task1",
      instructions: "You should spend about 20 minutes on this task. Write at least 150 words.",
      prompt:
        "The chart below shows the number of adults participating in different major sports in one area, in 1997 and 2017. Summarise the information by selecting and reporting the main features, and make comparisons where relevant.",
      minWords: 150,
    },
    {
      id: "w-task2",
      instructions: "You should spend about 40 minutes on this task. Write at least 250 words.",
      prompt: "Some people believe that technology has made life more complicated rather than simpler. To what extent do you agree or disagree?",
      minWords: 250,
    },
  ],
};

// ---------------- Timer ----------------
// Smooth 1s-tick countdown. Visual state escalates: normal -> warning (<15min)
// -> danger (<5min, red + gentle pulse) -> critical (<1min, faster pulse).
// Fires onExpire exactly once when it hits zero (auto-submit hook point).
//
// If `startedAt` (a server-stamped ms epoch timestamp) is provided, remaining
// time is computed from real elapsed wall-clock time since that moment —
// so a page reload recovers the true remaining time instead of granting a
// fresh totalSeconds countdown. Without it, falls back to a plain countdown
// (used only for standalone/demo rendering with no backend session).
function useCountdown(totalSeconds, { onExpire, running = true, startedAt } = {}) {
  const computeRemaining = () => {
    if (!startedAt) return totalSeconds;
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    return Math.max(0, totalSeconds - elapsed);
  };

  const [secondsLeft, setSecondsLeft] = useState(computeRemaining);
  const expiredRef = useRef(false);

  // If startedAt arrives after mount (e.g. begin-section call resolves late),
  // snap to the correct remaining time rather than waiting for the next tick.
  useEffect(() => {
    setSecondsLeft(computeRemaining());
    expiredRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startedAt, totalSeconds]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      const remaining = computeRemaining();
      setSecondsLeft(remaining);
      if (remaining <= 0) {
        clearInterval(t);
        if (!expiredRef.current) {
          expiredRef.current = true;
          onExpire && onExpire();
        }
      }
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, onExpire, startedAt, totalSeconds]);

  const h = Math.floor(secondsLeft / 3600);
  const m = Math.floor((secondsLeft % 3600) / 60);
  const s = secondsLeft % 60;
  const label = h > 0
    ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;

  let state = "normal";
  if (secondsLeft <= 60) state = "critical";
  else if (secondsLeft <= 300) state = "danger";
  else if (secondsLeft <= 900) state = "warning";

  return { secondsLeft, label, state };
}

function Timer({ totalSeconds, onExpire, running = true, startedAt }) {
  const { label, state } = useCountdown(totalSeconds, { onExpire, running, startedAt });
  return (
    <div className={`timer timer-${state}`}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3.5 2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="timer-label">{label}</span>
      {state === "danger" && <span className="timer-tag">5 min left</span>}
      {state === "critical" && <span className="timer-tag">1 min left</span>}
    </div>
  );
}

// ---------------- Shared chrome: Topbar ----------------
function TopBar({ audioState, notesOpen, setNotesOpen, timerProps }) {
  return (
    <div className="tb">
      <div className="tb-left">
        <span className="tb-logo">IELTS<sup>™</sup></span>
        <div className="tb-id">
          <span>Test taker ID</span>
          {audioState && (
            <span className="tb-audio">
              <Icon.Speaker /> {audioState}
            </span>
          )}
        </div>
      </div>
      <div className="tb-right">
        {timerProps && <Timer {...timerProps} />}
        <Icon.Wifi />
        <Icon.Bell />
        <Icon.Menu />
        <button className="tb-iconbtn" onClick={() => setNotesOpen((v) => !v)}>
          <Icon.Notes />
        </button>
      </div>
    </div>
  );
}

// ---------------- Notes panel ----------------
function NotesPanel({ open, onClose, notes }) {
  return (
    <div className={`notes-panel ${open ? "open" : ""}`}>
      <div className="notes-head">
        <span>Notes</span>
        <button className="tb-iconbtn" onClick={onClose}><Icon.Close /></button>
      </div>
      <div className="notes-body">
        {notes.length === 0 ? (
          <>
            <p className="notes-placeholder">Your private notes will show here</p>
            <p className="notes-hint">Select text to highlight or create a note.</p>
          </>
        ) : (
          notes.map((n, i) => <p key={i} className="notes-item">{n}</p>)
        )}
      </div>
    </div>
  );
}

// ---------------- Highlightable passage ----------------
function HighlightablePassage({ paragraphs, onNote, readOnly = false }) {
  const ref = useRef(null);
  const [menu, setMenu] = useState(null);

  const onMouseUp = useCallback(() => {
    if (readOnly) return setMenu(null);
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return setMenu(null);
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const cRect = ref.current.getBoundingClientRect();
    setMenu({ x: rect.left - cRect.left + rect.width / 2, y: rect.top - cRect.top - 10, text: sel.toString() });
  }, [readOnly]);

  const highlight = () => {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const span = document.createElement("mark");
    span.className = "hl";
    try { range.surroundContents(span); } catch {}
    sel.removeAllRanges();
    setMenu(null);
  };

  const note = () => {
    if (menu?.text) onNote(menu.text);
    highlight();
  };

  return (
    <div ref={ref} className="passage" onMouseUp={onMouseUp}
      onContextMenu={(e) => {
        if (readOnly) return;
        if (e.target.classList?.contains("hl")) {
          e.preventDefault();
          e.target.replaceWith(...e.target.childNodes);
        }
      }}>
      {paragraphs.map((p, i) => <p key={i} className="para">{p}</p>)}
      {menu && (
        <div className="sel-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.preventDefault()}>
          <button onClick={highlight}>Highlight</button>
          <button onClick={note}>Note</button>
        </div>
      )}
    </div>
  );
}

// ---------------- Draggable divider ----------------
function Divider({ onDrag }) {
  const dragging = useRef(false);
  useEffect(() => {
    const move = (e) => dragging.current && onDrag(e.clientX);
    const up = () => (dragging.current = false);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [onDrag]);
  return (
    <div className="divider">
      <div className="divider-handle" onMouseDown={() => (dragging.current = true)}>
        <Icon.Resize />
      </div>
    </div>
  );
}

/** Shared resize-split logic for the three modules' pane-left/pane-right
 * split. Returns a ref to put on the `.split` container, the current left
 * pane width (%), and an onDrag handler to hand straight to <Divider>.
 * Previously every caller passed `onDrag={() => {}}` — the Divider itself
 * always worked (it tracks mouse position correctly), but nothing used
 * that position to actually resize anything, so dragging the handle did
 * nothing at all. */
function useSplitResize(initial = 50) {
  const containerRef = useRef(null);
  const [leftPercent, setLeftPercent] = useState(initial);

  const onDrag = useCallback((clientX) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setLeftPercent(Math.min(75, Math.max(25, pct))); // keep both panes usably wide
  }, []);

  return { containerRef, leftPercent, onDrag };
}

// ---------------- Bottom nav (part progress bar) ----------------
// `parts[i].label` is now clickable — clicking it calls onSwitchPart(i) to
// actually change the active part. Previously only the active part's own
// question buttons were rendered at all, and nothing could ever change
// which part was active except jumping to a question already inside it —
// a dead end that made it impossible to ever reach Part 2+ from Part 1.
// Each qnum button now also reflects real answered/flagged status via CSS
// classes, layered under the existing "current" state.
function BottomNav({ current, total, parts, activePart, onJump, onSwitchPart, onCheck, isAnswered, isFlagged, readOnly = false }) {
  return (
    <div className="bottombar">
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${(current / total) * 100}%` }} />
      </div>
      <div className="bottombar-row">
        {parts.map((p, i) => (
          <div className="part-block" key={p.label}>
            <span
              className={`part-label ${i === activePart ? "active" : ""} ${onSwitchPart ? "clickable" : ""}`}
              onClick={() => onSwitchPart && onSwitchPart(i)}
            >
              {p.label}
            </span>
            {i === activePart ? (
              <div className="qnums">
                {p.questions.map((q) => {
                  const answered = isAnswered ? isAnswered(q) : false;
                  const flagged = isFlagged ? isFlagged(q) : false;
                  const cls = ["qnum", q === current ? "current" : "", answered ? "answered" : "", flagged ? "flagged" : ""]
                    .filter(Boolean).join(" ");
                  return (
                    <button key={q} className={cls} onClick={() => onJump(q)}>
                      {q}
                    </button>
                  );
                })}
              </div>
            ) : (
              <span className="qcount">{p.answeredCount} of {p.total}</span>
            )}
          </div>
        ))}
        {!readOnly && <button className="check-btn" onClick={onCheck}><Icon.Check /></button>}
      </div>
    </div>
  );
}

// ---------------- Generic question renderer ----------------
// Consumes one question object (schema in docs/exam-json-schema.md) and
// renders the right widget by `type`. Groups (matching option banks, table
// gaps, group titles) are handled by QuestionList below, which walks the
// full array and only prints a group header/bank once per contiguous group.
function QuestionRenderer({ q, value, onChange, readOnly = false, flagged = false, onToggleFlag }) {
  const change = (nextValue) => {
    if (!readOnly && onChange) onChange(q.id, nextValue);
  };

  const FlagButton = !readOnly && onToggleFlag ? (
    <button
      type="button"
      className={`flag-btn ${flagged ? "active" : ""}`}
      onClick={() => onToggleFlag(q.n)}
      title={flagged ? "Unflag this question" : "Flag this question for review"}
    >
      <Icon.Flag />
    </button>
  ) : null;

  switch (q.type) {
    case "tfng":
      return (
        <div className="tfng-block" id={`q-${q.n}`}>
          <div className="tfng-head">
            <span className="qbadge">{q.n}</span>
            <span>{q.prompt}</span>
            {FlagButton}
          </div>
          <div className="tfng-opts">
            {["TRUE", "FALSE", "NOT GIVEN"].map((opt) => (
              <label key={opt} className="radio-row">
                <input type="radio" name={`q${q.n}`} checked={value === opt} onChange={() => change(opt)} disabled={readOnly} />
                {opt}
              </label>
            ))}
          </div>
        </div>
      );
    case "mcq":
      return (
        <div className="tfng-block" id={`q-${q.n}`}>
          <div className="tfng-head">
            <span className="qbadge">{q.n}</span>
            <span>{q.prompt}</span>
            {FlagButton}
          </div>
          <div className="tfng-opts">
            {q.options.map((opt) => (
              <label key={opt} className="radio-row">
                <input type="radio" name={`q${q.n}`} checked={value === opt} onChange={() => change(opt)} disabled={readOnly} />
                {opt}
              </label>
            ))}
          </div>
        </div>
      );
    case "gap-fill":
      return (
        <p className="gapfill-line" id={`q-${q.n}`}>
          <span className="qbadge small">{q.n}</span>{" "}
          {q.before}{" "}
          <input className="gap-box" value={value || ""} onChange={(e) => change(e.target.value)} disabled={readOnly} />{" "}
          {q.after}{" "}{FlagButton}
        </p>
      );
    case "matching":
      return (
        <div id={`q-${q.n}`}>
          <div className="tfng-head" style={{ marginBottom: 6 }}>
            <span className="qbadge">{q.n}</span>
            {FlagButton}
          </div>
          <MatchingQuestion q={q} value={value} onChange={readOnly ? () => {} : onChange} />
        </div>
      );
    case "table":
      return (
        <div id={`q-${q.n}`}>
          <table className="read-table">
            <thead><tr>{q.table.headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
            <tbody>
              {q.table.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => {
                    const gap = q.gaps?.find((g) => g.cellMarker === cell);
                    return (
                      <td key={ci}>
                        {gap ? (
                          <span><span className="qbadge small">{gap.n}</span>{" "}
                            <input className="gap-box" value={value?.[gap.id] || ""}
                              onChange={(e) => change({ ...(value || {}), [gap.id]: e.target.value })} disabled={readOnly} />
                          </span>
                        ) : cell}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "map":
      return <MapQuestion q={q} values={value || {}} onChange={readOnly ? () => {} : (ptId, v) => onChange(q.id, { ...(value || {}), [ptId]: v })} />;
    default:
      return null;
  }
}

// Walks a part's questions[], printing group headers (groupTitle/groupInstructions)
// and matching option banks once per contiguous run sharing them.
function QuestionList({ questions, answers, onChange, readOnly = false, flags, onToggleFlag }) {
  let lastGroupTitle = null;
  let lastMatchingBank = null;
  return (
    <>
      {questions.map((q) => {
        const showGroupHeader = q.groupTitle && q.groupTitle !== lastGroupTitle;
        if (showGroupHeader) lastGroupTitle = q.groupTitle;
        const showBank = q.type === "matching" && q.options !== lastMatchingBank;
        if (q.type === "matching") lastMatchingBank = q.options;
        return (
          <div key={q.id} className="q-item">
            {showGroupHeader && (
              <>
                <h4 className="q-group-title" style={{ marginTop: 24 }}>{q.groupTitle}</h4>
                {q.groupInstructions && <p className="q-group-instr">{q.groupInstructions}</p>}
              </>
            )}
            {showBank && <MatchingOptionBank options={q.options} optionLetters={q.optionLetters} />}
            <QuestionRenderer
              q={q} value={answers[q.id]} onChange={onChange} readOnly={readOnly}
              flagged={flags ? flags.has(q.n) : false}
              onToggleFlag={onToggleFlag}
            />
          </div>
        );
      })}
    </>
  );
}

// ---------------- Reading module ----------------
function ReadingModule({ notesOpen, setNotesOpen, notes, addNote, examData, onComplete, initialAnswers, sectionStartedAt, readOnly = false }) {
  const data = examData || READING_JSON;
  const parts = Array.isArray(data?.parts) ? data.parts : READING_JSON.parts;
  const [answers, setAnswers] = useState(initialAnswers || {});
  const [partIdx, setPartIdx] = useState(0);
  const [flags, setFlags] = useState(() => new Set());
  const { containerRef, leftPercent, onDrag } = useSplitResize(55);
  const set = (id, v) => {
    if (readOnly) return;
    setAnswers((a) => ({ ...a, [id]: v }));
  };
  const toggleFlag = (n) => {
    if (readOnly) return;
    setFlags((prev) => {
      const next = new Set(prev);
      next.has(n) ? next.delete(n) : next.add(n);
      return next;
    });
  };
  const part = parts[partIdx] || parts[0];
  const allQuestions = parts.flatMap((p) => Array.isArray(p?.questions) ? p.questions : []);

  // Switching parts directly (clicking a part label in the bottom nav) —
  // previously the only way to change partIdx was jumpTo(n), which requires
  // a visible qnum button for a question in that part, but inactive parts'
  // qnum buttons were never rendered at all. That made Part 2+ unreachable.
  // Navigation (switching parts, jumping to a question) is always allowed,
  // even in readOnly admin-preview mode — only answering/flagging is
  // blocked there. Previously these bailed out on readOnly too, which left
  // admin preview stuck on Part 1 forever with no way to check the rest of
  // the passage.
  const switchPart = (i) => {
    setPartIdx(i);
  };

  const jumpTo = (n) => {
    const pi = parts.findIndex((p) => (p?.questions || []).some((q) => q.n === n));
    if (pi !== -1) setPartIdx(pi);
    setTimeout(() => document.getElementById(`q-${n}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  };

  const isAnswered = (n) => {
    const q = allQuestions.find((qq) => qq.n === n);
    if (!q) return false;
    const v = answers[q.id];
    if (v === undefined || v === null || v === "") return false;
    if (typeof v === "object") return Object.values(v).some((x) => x !== undefined && x !== null && x !== "");
    return true;
  };

  return (
    <div className="page">
      <TopBar
        notesOpen={notesOpen}
        setNotesOpen={setNotesOpen}
        timerProps={!readOnly ? { totalSeconds: (data.durationMinutes || 60) * 60, onExpire: () => onComplete && onComplete("reading", answers), startedAt: sectionStartedAt } : null}
      />
      <div className="instr-box">
        <div className="instr-title">Part {partIdx + 1}</div>
        <div>Read the text and answer the questions. Use the part labels below to move freely between passages.</div>
      </div>
      <div className="split" ref={containerRef}>
        <div className="pane-left" style={{ flex: `0 0 ${leftPercent}%` }}>
          <h3 className="passage-title">{part?.title || "Reading passage"}</h3>
          <HighlightablePassage paragraphs={part?.passage || []} onNote={addNote} readOnly={readOnly} />
        </div>
        <Divider onDrag={onDrag} />
        <div className="pane-right" style={{ flex: `1 1 ${100 - leftPercent}%` }}>
          {part?.instructionsTitle && <h4 className="q-group-title">{part.instructionsTitle}</h4>}
          {part?.instructions && <p className="q-group-instr">{part.instructions}</p>}
          <QuestionList
            questions={part?.questions || []} answers={answers} onChange={set} readOnly={readOnly}
            flags={flags} onToggleFlag={toggleFlag}
          />
        </div>
      </div>
      <BottomNav
        current={part?.questions?.[0]?.n || 1}
        total={allQuestions.length}
        activePart={partIdx}
        parts={parts.map((p, i) => ({
          label: `Part ${i + 1}`,
          questions: (p?.questions || []).map((q) => q.n),
          total: (p?.questions || []).length,
          answeredCount: (p?.questions || []).filter((q) => answers[q.id] !== undefined && answers[q.id] !== "").length,
        }))}
        onJump={jumpTo}
        onSwitchPart={switchPart}
        onCheck={() => onComplete && onComplete("reading", answers)}
        isAnswered={isAnswered}
        isFlagged={(n) => flags.has(n)}
        readOnly={readOnly}
      />
      {!readOnly && <NotesPanel open={notesOpen} onClose={() => setNotesOpen(false)} notes={notes} />}
    </div>
  );
}

// ---------------- Listening module ----------------
// Previously this read data.items / data.audioUrl directly off the whole
// listening SECTION — but the real exam schema (docs/exam-json-schema.md)
// puts those on EACH PART: data.parts[i].items / data.parts[i].audioUrl.
// That mismatch meant data.audioUrl was always undefined for every real
// exam, so the <audio> element never even rendered — this is the actual
// cause of "no audio at all" reports, not a playback/codec issue. This
// rewrite reads the real per-part shape and gives each part its own
// independent play-once gate, matching the free-navigation pattern already
// built for Writing's Task 1/2 (start whichever part you want).
function ListeningModule({ examData, onComplete, initialAnswers, sectionStartedAt, readOnly = false }) {
  const data = examData || { parts: [LISTENING_JSON] };
  const parts = Array.isArray(data?.parts) ? data.parts : [LISTENING_JSON];
  const [partIdx, setPartIdx] = useState(0);
  const [phaseByPart, setPhaseByPart] = useState({}); // partId -> "gate" | "playing" | "done"
  const [answers, setAnswers] = useState(initialAnswers || {});
  const [flags, setFlags] = useState(() => new Set());
  const [progress, setProgress] = useState(0); // 0-100, display only — never used to seek
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [playbackError, setPlaybackError] = useState(false);
  const { containerRef, leftPercent, onDrag } = useSplitResize(50);
  const audioRef = useRef(null);

  const part = parts[partIdx] || parts[0];
  // In readOnly admin-preview mode there is no play gate at all — an admin
  // checking a draft needs to see the questions immediately, not click
  // through a "Play audio" overlay that startAudio() (below) never even
  // lets them dismiss, since it also bails out on readOnly. Previously this
  // left every listening part permanently hidden behind that overlay in
  // preview.
  const phase = readOnly ? "done" : (phaseByPart[part.id] ?? "gate");
  const setPhase = (p) => setPhaseByPart((prev) => ({ ...prev, [part.id]: p }));

  const allLines = parts.flatMap((p) => (p?.items || []).flatMap((it) => (it?.lines || []).filter((l) => l.n)));

  const set = (n, v) => {
    if (readOnly) return;
    setAnswers((a) => ({ ...a, [n]: v }));
  };
  const toggleFlag = (n) => {
    if (readOnly) return;
    setFlags((prev) => {
      const next = new Set(prev);
      next.has(n) ? next.delete(n) : next.add(n);
      return next;
    });
  };

  // Navigation is always allowed, even in readOnly preview — see the note
  // on the Reading module's switchPart above.
  const switchPart = (i) => {
    setProgress(0);
    setPlaybackError(false);
    setPartIdx(i);
  };

  const startAudio = () => {
    if (readOnly) return;
    setPlaybackError(false);
    setPhase("playing");
    if (part.audioUrl && audioRef.current) {
      audioRef.current.play().catch(() => {
        // Previously this error was silently swallowed — phase still
        // flipped to "playing" with no audio and no indication anything
        // was wrong, which is indistinguishable from "audio is just quiet".
        // Surface it instead so a real playback failure (autoplay policy,
        // broken URL, CORS on the storage bucket, unsupported format) is
        // visible rather than looking like empty silence.
        setPlaybackError(true);
      });
    } else if (!part.audioUrl) {
      // No real audio for this part (e.g. still-editing draft, or old demo
      // data) — simulate a fixed-duration clip so the UI still demos
      // meaningfully instead of hanging forever with a "Playing" state
      // that never finishes.
      const fakeDuration = 20;
      let elapsed = 0;
      const tick = setInterval(() => {
        elapsed += 0.25;
        setProgress(Math.min(100, (elapsed / fakeDuration) * 100));
        if (elapsed >= fakeDuration) {
          clearInterval(tick);
          setPhase("done");
        }
      }, 250);
    }
  };

  const onTimeUpdate = () => {
    const a = audioRef.current;
    if (!a || !a.duration) return;
    setProgress((a.currentTime / a.duration) * 100);
  };
  const onEnded = () => setPhase("done");
  const onAudioError = () => setPlaybackError(true);

  // Prevent student from controlling audio via keyboard (pause/play/seek only; volume is allowed)
  useEffect(() => {
    if (phase !== "playing" || readOnly) return;
    const preventAudioControl = (e) => {
      const blockedKeys = ["Space", "ArrowLeft", "ArrowRight", "MediaPlayPause", "MediaStop", "MediaTrackNext", "MediaTrackPrevious"];
      if (blockedKeys.includes(e.code)) e.preventDefault();
    };
    const preventContextMenu = (e) => { if (e.target === audioRef.current) e.preventDefault(); };
    window.addEventListener("keydown", preventAudioControl);
    document.addEventListener("contextmenu", preventContextMenu);
    return () => {
      window.removeEventListener("keydown", preventAudioControl);
      document.removeEventListener("contextmenu", preventContextMenu);
    };
  }, [phase, readOnly]);

  const isAnswered = (n) => answers[n] !== undefined && answers[n] !== "";

  return (
    <div className="page">
      <TopBar
        audioState={phase === "playing" ? "Audio is Playing" : phase === "done" ? "Audio finished" : null}
        timerProps={!readOnly ? { totalSeconds: (data.durationMinutes || 30) * 60, onExpire: () => onComplete && onComplete("listening", answers), startedAt: sectionStartedAt } : null}
      />
      {part.audioUrl && (
        <audio
          key={part.id}
          ref={audioRef}
          src={part.audioUrl}
          onTimeUpdate={onTimeUpdate}
          onEnded={onEnded}
          onError={onAudioError}
          volume={muted ? 0 : volume}
          // Deliberately no controls prop and no seek UI — matches real IELTS CD:
          // audio plays once, cannot be paused, rewound, or skipped by the student.
          // Students CAN control volume and mute.
        />
      )}
      <div className="instr-box">
        <div className="instr-title">Part {partIdx + 1}{part.title ? ` — ${part.title}` : ""}</div>
        <div>Listen and answer the questions. Use the part labels below to move freely between parts.</div>
      </div>

      {phase !== "gate" && (
        <div className="audio-bar">
          <Icon.Speaker />
          <div className="audio-track">
            <div className="audio-fill" style={{ width: `${progress}%` }} />
          </div>
          <button className="audio-mute" onClick={() => setMuted((m) => !m)} title={muted ? "Unmute" : "Mute"}>
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
          <input
            className="audio-volume"
            type="range" min="0" max="1" step="0.05"
            value={muted ? 0 : volume}
            onChange={(e) => { setVolume(parseFloat(e.target.value)); setMuted(false); }}
          />
          {playbackError && (
            <span className="audio-error">
              Audio couldn't play. Check your connection, or flag this for your test administrator.
            </span>
          )}
        </div>
      )}

      <div className="split" ref={containerRef}>
        <div className="pane-left" style={{ flex: `1 1 100%` }}>
          <div className="listening-body">
            <h4 className="q-group-title">{part.instructionsTitle || `Questions`}</h4>
            <p className="q-group-instr">{part.instructions}</p>
            <div className="notes-grid">
              {(part.items || []).map((item, i) => (
                <div className="item-block" key={i}>
                  {item.label && <span className="item-label">{item.label}</span>}
                  <div className="item-lines">
                    {(item.lines || []).map((l, j) => (
                      <div className="item-line" key={j} id={l.n ? `q-${l.n}` : undefined}>
                        {l.pre}{" "}
                        {l.n ? (
                          <>
                            <span className="qbadge small">{l.n}</span>{" "}
                            <input
                              className="gap-box"
                              disabled={readOnly || phase === "gate"}
                              value={answers[l.n] || ""}
                              onChange={(e) => set(l.n, e.target.value)}
                            />{" "}
                            {l.post}{" "}
                            {!readOnly && (
                              <button type="button" className={`flag-btn ${flags.has(l.n) ? "active" : ""}`} onClick={() => toggleFlag(l.n)} title="Flag for review">
                                <Icon.Flag />
                              </button>
                            )}
                          </>
                        ) : (
                          l.text
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {phase === "gate" && (
        <div className="listen-overlay">
          <Icon.Headphones />
          <p className="overlay-text">
            You will be listening to an audio clip during this part. You will not be permitted to pause or rewind
            the audio while answering the questions.
          </p>
          <p className="overlay-sub">To continue, click Play.</p>
          <button className="play-btn" onClick={startAudio}>
            <Icon.Play /> Play
          </button>
        </div>
      )}

      <BottomNav
        current={(part.items?.[0]?.lines || []).find((l) => l.n)?.n || 1}
        total={allLines.length}
        activePart={partIdx}
        parts={parts.map((p, i) => {
          const lines = (p?.items || []).flatMap((it) => (it?.lines || []).filter((l) => l.n));
          return {
            label: `Part ${i + 1}`,
            questions: lines.map((l) => l.n),
            total: lines.length,
            answeredCount: lines.filter((l) => answers[l.n] !== undefined && answers[l.n] !== "").length,
          };
        })}
        onJump={(n) => setTimeout(() => document.getElementById(`q-${n}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50)}
        onSwitchPart={switchPart}
        onCheck={() => onComplete && onComplete("listening", answers)}
        isAnswered={isAnswered}
        isFlagged={(n) => flags.has(n)}
        readOnly={readOnly}
      />
    </div>
  );
}

// ---------------- Writing module ----------------
function WritingModule({ examData, onComplete, initialAnswers, sectionStartedAt, readOnly = false }) {
  const data = examData || WRITING_JSON;
  const parts = Array.isArray(data?.parts) ? data.parts : WRITING_JSON.parts;
  const [taskIdx, setTaskIdx] = useState(0);
  const { containerRef, leftPercent, onDrag } = useSplitResize(45);
  // Keyed by part id (e.g. "w-task1"/"w-task2") so each task's draft is
  // independent and both survive switching tasks or resuming after a
  // refresh — previously this module only ever held one task's text at
  // all, so Task 2 (or any writing part beyond the first) was unreachable
  // and its content was silently lost.
  const [answers, setAnswers] = useState(initialAnswers || {});
  const part = parts[taskIdx] || parts[0];
  const isLastTask = taskIdx === parts.length - 1;

  const currentText = answers[part.id]?.text || "";
  const words = currentText.trim() ? currentText.trim().split(/\s+/).length : 0;
  const setText = (text) => {
    if (readOnly) return;
    const w = text.trim() ? text.trim().split(/\s+/).length : 0;
    setAnswers((a) => ({ ...a, [part.id]: { text, words: w } }));
  };

  // Navigation is always allowed, even in readOnly preview — see the note
  // on the Reading module's switchPart above.
  const goToTask = (idx) => {
    setTaskIdx(Math.max(0, Math.min(parts.length - 1, idx)));
  };
  const handleCheck = () => {
    if (readOnly) return;
    if (!isLastTask) {
      goToTask(taskIdx + 1);
    } else {
      onComplete && onComplete("writing", answers);
    }
  };

  return (
    <div className="page">
      <TopBar timerProps={!readOnly ? { totalSeconds: (data.durationMinutes || 60) * 60, onExpire: () => onComplete && onComplete("writing", answers), startedAt: sectionStartedAt } : null} />
      <div className="instr-box">
        <div className="instr-title">Part {taskIdx + 1}</div>
        <div>{part?.instructions || "Writing task"}</div>
      </div>
      <div className="split" ref={containerRef}>
        <div className="pane-left" style={{ flex: `0 0 ${leftPercent}%` }}>
          <p className="writing-prompt">{part?.prompt || "Writing prompt"}</p>
          {part?.chartImageUrl && (
            <div className="chart-placeholder">
              <img src={part.chartImageUrl} alt="Chart for this writing task" className="writing-chart-image" />
            </div>
          )}
        </div>
        <Divider onDrag={onDrag} />
        <div className="pane-right" style={{ flex: `1 1 ${100 - leftPercent}%` }}>
          <textarea
            key={part.id}
            className="writing-area"
            placeholder=""
            value={currentText}
            onChange={(e) => setText(e.target.value)}
            readOnly={readOnly}
          />
          <div className={`word-count ${words < (part.minWords || 150) ? "under" : "met"}`}>
            Words: {words}{part.minWords ? ` / ${part.minWords} min` : ""}
          </div>
        </div>
      </div>
      <div className="bottombar">
        <div className="bottombar-row">
          {parts.map((p, i) => {
            const pWords = answers[p.id]?.words || 0;
            return (
              <div className="part-block" key={p.id || i} onClick={() => goToTask(i)} style={{ cursor: "pointer" }}>
                <span className={`part-label ${i === taskIdx ? "active" : ""}`}>Part {i + 1}</span>
                <span className="qcount">{pWords >= (p.minWords || 150) ? "met" : `${pWords} words`}</span>
              </div>
            );
          })}
          {!readOnly && <button className="check-btn" onClick={handleCheck} title={isLastTask ? "Submit Writing" : "Next task"}>
            <Icon.Check />
          </button>}
        </div>
      </div>
    </div>
  );
}

function ChartSVG() {
  const data = [
    { s: "Tennis", a: 50, b: 55 },
    { s: "Basketball", a: 9, b: 23 },
    { s: "Cricket", a: 26, b: 7 },
    { s: "Golf", a: 32, b: 33 },
    { s: "Swimming", a: 35, b: 35 },
    { s: "Football", a: 32, b: 48 },
    { s: "Rugby", a: 33, b: 49 },
  ];
  const max = 60, w = 460, h = 260, pad = 34;
  const bw = (w - pad) / data.length / 2.4;
  return (
    <svg viewBox={`0 0 ${w + 40} ${h + 50}`} className="chart-svg">
      {[0, 10, 20, 30, 40, 50, 60].map((v) => {
        const y = h - (v / max) * h + 10;
        return (
          <g key={v}>
            <line x1={pad} x2={w + 20} y1={y} y2={y} stroke="#ddd" />
            <text x={pad - 8} y={y + 4} fontSize="10" textAnchor="end" fill="#333">{v}</text>
          </g>
        );
      })}
      {data.map((d, i) => {
        const x = pad + i * ((w - pad) / data.length) + 8;
        const ya = h - (d.a / max) * h + 10;
        const yb = h - (d.b / max) * h + 10;
        return (
          <g key={d.s}>
            <rect x={x} y={ya} width={bw} height={h - ya + 10} fill="#222" />
            <rect x={x + bw} y={yb} width={bw} height={h - yb + 10} fill="#b8b8b8" />
            <text x={x + bw} y={h + 26} fontSize="10" textAnchor="middle" fill="#333"
              transform={`rotate(-25 ${x + bw} ${h + 26})`}>{d.s}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------------- Root ----------------
// Production usage: <IELTSCDReplica section="reading" onSectionComplete={fn} />
// driven by ExamSession.jsx (pages/ExamSession.jsx), which owns section order.
// Demo usage: <IELTSCDReplica /> with no props falls back to an internal
// switcher so this file still renders standalone for quick preview.
export default function IELTSCDReplica({ section, onSectionComplete, examData, initialAnswers, sectionStartedAt, readOnly = false }) {
  const isControlled = !!section;
  const [demoModule, setDemoModule] = useState("reading");
  const module = isControlled ? section : demoModule;
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState([]);

  // examData, as sent by GET /api/sessions/:id (see stripAnswerKeys in
  // routes/sessions.js), is the raw exam object shaped { sections: [...] }
  // — an array of { type, parts } — not an object with .reading/.listening/
  // .writing keys. This lookup bridges that: any real exam (hand-built,
  // zip-uploaded, or AI-generated) is matched to the right module by its
  // section `type`. Without this, every module silently falls back to its
  // own hardcoded demo content below, regardless of what the exam actually
  // contains — which is what was happening before this fix.
  const sectionsByType = {};
  for (const s of examData?.sections || []) sectionsByType[s.type] = s;

  return (
    <div className="root">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <style dangerouslySetInnerHTML={{ __html: QUESTION_TYPE_CSS }} />
      {!isControlled && (
        <div className="demo-switch">
          {["reading", "listening", "writing"].map((m) => (
            <button key={m} className={`demo-btn ${module === m ? "active" : ""}`} onClick={() => setDemoModule(m)}>
              {m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
      )}
      {module === "reading" && (
        <ReadingModule
          notesOpen={notesOpen}
          setNotesOpen={setNotesOpen}
          notes={notes}
          addNote={(n) => setNotes((s) => [...s, n])}
          examData={sectionsByType.reading}
          onComplete={onSectionComplete}
          initialAnswers={initialAnswers}
          sectionStartedAt={sectionStartedAt}
          readOnly={readOnly}
        />
      )}
      {module === "listening" && (
        <ListeningModule
          examData={sectionsByType.listening}
          onComplete={onSectionComplete}
          initialAnswers={initialAnswers}
          sectionStartedAt={sectionStartedAt}
          readOnly={readOnly}
        />
      )}
      {module === "writing" && (
        <WritingModule
          examData={sectionsByType.writing}
          onComplete={onSectionComplete}
          initialAnswers={initialAnswers}
          sectionStartedAt={sectionStartedAt}
          readOnly={readOnly}
        />
      )}
    </div>
  );
}

// ---------------- CSS (matched to reference screenshots) ----------------
const CSS = `
* { box-sizing: border-box; }
.root { width:100%; min-height:100dvh; font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; background:#fff; }
.demo-switch { display:flex; gap:6px; padding:8px 10px; background:#f4f4f4; border-bottom:1px solid #ddd; }
.demo-btn { border:1px solid #ccc; background:#fff; padding:5px 12px; font-size:12px; border-radius:4px; cursor:pointer; }
.demo-btn.active { background:#1a1a1a; color:#fff; border-color:#1a1a1a; }
.page { position:relative; display:flex; flex-direction:column; height:800px; overflow:hidden; }

.tb { display:flex; align-items:center; justify-content:space-between; padding:14px 24px; border-bottom:1px solid #e2e2e2; }
.tb-left { display:flex; align-items:center; gap:20px; }
.tb-logo { color:#d21f3c; font-weight:800; font-size:20px; letter-spacing:.5px; }
.tb-id { display:flex; flex-direction:column; font-size:13px; font-weight:600; line-height:1.3; }
.tb-audio { display:flex; align-items:center; gap:5px; font-weight:400; color:#333; font-size:12px; }
.tb-right { display:flex; align-items:center; gap:16px; color:#333; }
.tb-iconbtn { background:none; border:none; cursor:pointer; color:#333; display:flex; }

.timer { display:flex; align-items:center; gap:7px; padding:5px 12px; border-radius:14px; font-size:13px; font-weight:700; font-variant-numeric:tabular-nums; background:#f0f0f0; color:#1a1a1a; transition:background-color .4s ease, color .4s ease; }
.timer-label { transition:color .3s ease; }
.timer-warning { background:#fff4dd; color:#8a5b00; }
.timer-danger { background:#fde3e3; color:#b3261e; animation:timerPulse 2s ease-in-out infinite; }
.timer-critical { background:#fbd0d0; color:#a11d16; animation:timerPulse 1s ease-in-out infinite; }
.timer-tag { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.4px; background:rgba(255,255,255,.6); padding:2px 6px; border-radius:8px; }
@keyframes timerPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(179,38,30,.35); }
  50% { box-shadow: 0 0 0 5px rgba(179,38,30,0); }
}

.instr-box { margin:16px 24px; background:#f2f1ee; border:1px solid #e5e4e0; border-radius:4px; padding:14px 18px; font-size:14px; }
.instr-title { font-weight:700; margin-bottom:4px; }

.split { display:flex; flex:1; overflow:hidden; padding:0 24px; gap:0; }
.pane-left, .pane-right { flex:1; overflow-y:auto; padding:8px 16px; }
.passage-title { font-size:16px; font-weight:700; margin-bottom:14px; }
.passage { position:relative; }
.para { font-size:14px; line-height:1.75; margin-bottom:14px; }
.hl { background:#ffe066; }
.sel-menu { position:absolute; transform:translate(-50%,-100%); background:#1a1a1a; border-radius:4px; display:flex; z-index:20; }
.sel-menu button { color:#fff; background:none; border:none; padding:6px 10px; font-size:12px; cursor:pointer; }

.divider { width:24px; display:flex; align-items:stretch; justify-content:center; position:relative; }
.divider::before { content:""; position:absolute; left:50%; top:0; bottom:0; width:1px; background:#dcdcdc; }
.divider-handle { position:absolute; top:40%; width:28px; height:28px; border:1px solid #999; border-radius:3px; background:#fff; display:flex; align-items:center; justify-content:center; cursor:col-resize; z-index:5; }

.q-group-title { font-size:15px; font-weight:700; margin-bottom:6px; }
.q-group-instr { font-size:13.5px; line-height:1.6; margin-bottom:14px; }
.tfng-block { border-bottom:1px solid #eee; padding:10px 0; }
.tfng-head { display:flex; gap:10px; align-items:flex-start; font-size:14px; margin-bottom:8px; }
.qbadge { border:1.5px solid #1a1a1a; min-width:24px; height:24px; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:13px; border-radius:2px; }
.tfng-opts { display:flex; flex-direction:column; gap:8px; padding-left:34px; }
.radio-row { display:flex; align-items:center; gap:8px; font-size:14px; }
.radio-row input { width:16px; height:16px; }

.gapfill-list { list-style:disc; padding-left:20px; font-size:14px; line-height:2; }
.gapfill-list li { margin-bottom:14px; }
.gap-inline { display:inline-block; }
.q-item { margin-bottom:6px; }
.gapfill-line { font-size:14px; line-height:2; margin-bottom:16px; }
.qbadge.small { min-width:20px; height:20px; font-size:11px; }
.read-table { border-collapse:collapse; width:100%; margin-bottom:18px; font-size:13.5px; }
.read-table th, .read-table td { border:1px solid #ccd6db; padding:8px 10px; text-align:left; }
.read-table th { background:#f4f4f4; }
.gap-box { border:1px solid #888; text-align:center; font-weight:700; font-size:13px; padding:5px 10px; min-width:70px; border-radius:2px; transition:border-color .15s ease, box-shadow .15s ease; }
.gap-box:focus { outline:none; border-color:#1a1a1a; box-shadow:0 0 0 3px rgba(26,26,26,.08); }
.qnum, .demo-btn, .part-btn, .check-btn, .play-btn, .tb-iconbtn { transition:background-color .15s ease, border-color .15s ease, transform .1s ease; }
.qnum:hover { border-color:#1a1a1a; }
.qnum:active, .check-btn:active, .play-btn:active { transform:scale(0.94); }
.radio-row input, .gap-box, .writing-area { transition:box-shadow .15s ease; }
.writing-area:focus { outline:none; border-color:#1a1a1a; box-shadow:0 0 0 3px rgba(26,26,26,.06); }

.listening-body { padding:0 24px; flex:1; overflow-y:auto; }
.audio-bar { display:flex; align-items:center; gap:10px; padding:10px 24px; border-bottom:1px solid #eee; color:#444; }
.audio-track { flex:1; height:4px; background:#e4e4e4; border-radius:2px; overflow:hidden; }
.audio-fill { height:100%; background:#1a1a1a; transition:width .25s linear; }
.audio-mute { background:none; border:none; cursor:pointer; font-size:14px; }
.audio-volume { width:80px; accent-color:#1a1a1a; }
.notes-grid { margin-top:16px; }
.section-label { font-weight:700; font-size:14px; display:block; margin-bottom:10px; }
.item-block { display:flex; gap:20px; margin-bottom:20px; font-size:14px; }
.item-label { font-weight:600; min-width:110px; }
.item-lines { display:flex; flex-direction:column; gap:10px; }
.item-line { display:flex; align-items:center; gap:6px; }

.listen-overlay { position:absolute; inset:0; background:rgba(60,60,60,.72); display:flex; flex-direction:column; align-items:center; justify-content:center; color:#fff; gap:14px; text-align:center; padding:40px; }.overlay-text { max-width:640px; font-size:17px; }
.overlay-sub { font-size:17px; }
.play-btn { background:#1a1a1a; color:#fff; border:none; padding:10px 26px; border-radius:22px; font-size:14px; display:flex; align-items:center; gap:8px; cursor:pointer; margin-top:6px; }

.writing-prompt { font-size:14px; line-height:1.7; margin-bottom:16px; }
.chart-placeholder { border:1px solid #eee; padding:12px; }
.writing-chart-image { max-width:100%; height:auto; display:block; margin:0 auto; }
.chart-title { font-weight:700; text-align:center; font-size:15px; margin-bottom:8px; }
.chart-svg { width:100%; height:auto; }
.writing-area { width:100%; height:280px; border:1px solid #999; border-radius:3px; padding:12px; font-size:14px; font-family:inherit; resize:none; }
.word-count { text-align:right; font-size:13px; margin-top:6px; color:#333; transition:color .2s ease; }
.word-count.under { color:#8a5b00; }
.word-count.met { color:#2f8a4a; font-weight:600; }

.bottombar { border-top:1px solid #e2e2e2; padding:10px 20px 14px; }
.progress-track { height:3px; background:#eee; margin-bottom:10px; }
.progress-fill { height:100%; background:#1a1a1a; }
.bottombar-row { display:flex; align-items:center; gap:36px; }
.part-block { display:flex; align-items:center; gap:10px; }
.part-label { font-weight:700; font-size:14px; color:#888; }
.part-label.active { color:#1a1a1a; }
.part-label.clickable { cursor:pointer; }
.part-label.clickable:hover { text-decoration:underline; }
.qnums { display:flex; gap:6px; flex-wrap:wrap; }
.qnum { width:26px; height:26px; border:1px solid #bbb; background:#fff; border-radius:2px; font-size:12px; cursor:pointer; position:relative; }
.qnum.answered { background:#1a1a1a; color:#fff; border-color:#1a1a1a; }
.qnum.current { box-shadow:0 0 0 2px #1a1a1a; border-color:transparent; font-weight:700; }
.qnum.flagged::after { content:""; position:absolute; top:-3px; right:-3px; width:8px; height:8px; border-radius:50%; background:#e8871e; border:1px solid #fff; }
.qnum:disabled { cursor:default; opacity:.7; }
.qcount { font-size:13px; color:#666; }
.check-btn { margin-left:auto; background:#eee; border:none; width:40px; height:40px; border-radius:4px; display:flex; align-items:center; justify-content:center; cursor:pointer; color:#1a1a1a; }
.check-btn:hover { background:#e0e0e0; }
.flag-btn { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border:none; background:transparent; color:#bbb; cursor:pointer; border-radius:3px; vertical-align:middle; }
.flag-btn:hover { background:#f0f0f0; color:#888; }
.flag-btn.active { color:#e8871e; }
.audio-error { font-size:12px; color:#c0392b; margin-left:8px; }

.notes-panel { position:absolute; top:0; right:0; bottom:0; width:340px; background:#fff; border-left:1px solid #ddd; transform:translateX(100%); transition:transform .25s ease; display:flex; flex-direction:column; z-index:30; box-shadow:-4px 0 12px rgba(0,0,0,.06); }
.notes-panel.open { transform:translateX(0); }
.notes-head { display:flex; justify-content:space-between; align-items:center; padding:14px 18px; border-bottom:1px solid #eee; font-weight:700; }
.notes-body { padding:20px; flex:1; display:flex; flex-direction:column; align-items:center; text-align:center; color:#333; }
.notes-placeholder { font-size:15px; margin-top:60px; }
.notes-hint { font-size:13px; color:#888; margin-top:30px; }
.notes-item { align-self:flex-start; font-size:13px; background:#f7f7f7; padding:8px 10px; border-radius:4px; margin-bottom:8px; }
`;