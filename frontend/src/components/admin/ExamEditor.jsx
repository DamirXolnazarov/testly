import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  ArrowLeft, Save, Eye, Plus, Trash2, ChevronUp, ChevronDown, Copy, UploadCloud, Loader2, Check,
  AlertTriangle, BookOpen, Headphones, PenLine, Calculator, Mic, X, ListOrdered, Settings2, ImagePlus, Music,
} from "lucide-react";
import { adminFetch } from "../../lib/adminApi";

/**
 * ExamEditor.jsx — edit everything about an exam without touching JSON.
 *
 * Opened from the draft preview, an exam card, or AI Studio (page:
 * pages/admin-editor/[examId].jsx). The left rail lists each section and
 * its parts (IELTS) or modules (SAT); the main pane edits whichever one is
 * selected: passages, scripts, prompts, every question with its options and
 * answer key, and the media that goes with them — listening audio, writing
 * charts, diagram images, SAT figures.
 *
 * The exam is held as one object and saved whole with PATCH /api/exams/:id,
 * which runs the same validator as an upload; its per-question messages are
 * shown as-is when a save is refused. The server refuses content edits on a
 * live exam, so this editor is read-only for those.
 */

const SECTION_META = {
  reading: { icon: BookOpen, name: "Reading", unit: "Passage" },
  listening: { icon: Headphones, name: "Listening", unit: "Part" },
  writing: { icon: PenLine, name: "Writing", unit: "Task" },
  "reading-writing": { icon: BookOpen, name: "Reading and Writing", unit: "Module" },
  math: { icon: Calculator, name: "Math", unit: "Module" },
};
const SECTION_ORDER = { ielts: ["reading", "listening", "writing"], sat: ["reading-writing", "math"] };
const READING_TYPES = [
  ["tfng", "True / False / Not Given"],
  ["mcq", "Multiple choice"],
  ["gap-fill", "Gap fill"],
  ["matching", "Matching"],
  ["table", "Table completion"],
  ["map", "Diagram labelling"],
];
const ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv"];

const uid = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
const isSatSection = (section) => Array.isArray(section.modules);
const moduleLabel = (mod) => (mod.stage === "module1" ? "Module 1" : `Module 2 · ${mod.difficulty === "hard" ? "harder" : "easier"}`);

// Accepted answers are a string, or an array of alternatives. In the editor
// they are one text box with alternatives separated by "|".
const answerToText = (answer) => [].concat(answer ?? "").join(" | ");
const textToAnswer = (text) => {
  const forms = text.split("|").map((t) => t.trim()).filter(Boolean);
  return forms.length > 1 ? forms : forms[0] || "";
};

/** Every question number a part answers, in order (table gaps and map points count). */
function partNumbers(part) {
  const ns = [];
  for (const q of part.questions || []) {
    if (q.type === "table") (q.gaps || []).forEach((g) => ns.push(g.n));
    else if (q.type === "map") (q.points || []).forEach((p) => ns.push(p.n));
    else ns.push(q.n);
  }
  for (const item of part.items || []) for (const line of item.lines || []) if (line.n !== undefined) ns.push(line.n);
  return ns;
}

function nextNumber(section) {
  const all = (section.parts || []).flatMap(partNumbers).filter((n) => typeof n === "number");
  return all.length ? Math.max(...all) + 1 : 1;
}

function newReadingQuestion(type, n) {
  const base = { id: uid("q"), n, type };
  if (type === "tfng") return { ...base, prompt: "", answer: "TRUE" };
  if (type === "mcq") return { ...base, prompt: "", options: ["", "", "", ""], answer: "" };
  if (type === "gap-fill") return { ...base, before: "", after: "", answer: "" };
  if (type === "matching") return { ...base, prompt: "", options: ["", "", ""], answer: "A" };
  if (type === "table") {
    return { ...base, table: { headers: ["", ""], rows: [["", `___GAP${n}___`]] }, gaps: [{ id: uid("g"), n, cellMarker: `___GAP${n}___`, answer: "" }] };
  }
  return { ...base, imageUrl: "", points: [{ id: uid("p"), n, x: 50, y: 50, answer: "" }] };
}

function newPart(sectionType, section) {
  const index = (section.parts || []).length + 1;
  const n = nextNumber(section);
  if (sectionType === "reading") {
    return { id: uid("r-part"), title: `READING PASSAGE ${index}`, passage: ["Passage title", "First paragraph…"], instructionsTitle: "", instructions: "", questions: [newReadingQuestion("tfng", n)] };
  }
  if (sectionType === "listening") {
    return { id: uid("l-part"), title: `Part ${index}`, instructions: "Complete the notes below. Write ONE WORD AND/OR A NUMBER for each answer.", audioUrl: null, transcript: "", items: [{ label: "", lines: [{ pre: "", n, post: "", answer: "" }] }] };
  }
  return { id: uid("w-task"), instructions: "You should spend about 40 minutes on this task. Write at least 250 words.", prompt: "", minWords: 250 };
}

function newSection(type) {
  if (type === "reading") return { type, durationMinutes: 60, parts: [newPart("reading", { parts: [] })] };
  if (type === "listening") return { type, durationMinutes: 30, parts: [newPart("listening", { parts: [] })] };
  if (type === "writing") {
    return {
      type, durationMinutes: 60,
      parts: [
        { id: "w-task1", instructions: "You should spend about 20 minutes on this task. Write at least 150 words.", prompt: "", minWords: 150 },
        { id: "w-task2", instructions: "You should spend about 40 minutes on this task. Write at least 250 words.", prompt: "", minWords: 250 },
      ],
    };
  }
  const prefix = type === "math" ? "math" : "rw";
  const question = (moduleId) => ({ id: `${moduleId}-${uid("q")}`, n: 1, type: "mcq", ...(type === "math" ? {} : { passage: "" }), prompt: "", options: ["", "", "", ""], answer: "" });
  const duration = type === "math" ? 35 : 32;
  return {
    type,
    modules: [
      { id: `${prefix}-m1`, stage: "module1", durationMinutes: duration, questions: [question(`${prefix}-m1`)] },
      { id: `${prefix}-m2-easy`, stage: "module2", difficulty: "easy", durationMinutes: duration, questions: [question(`${prefix}-m2-easy`)] },
      { id: `${prefix}-m2-hard`, stage: "module2", difficulty: "hard", durationMinutes: duration, questions: [question(`${prefix}-m2-hard`)] },
    ],
  };
}

// ---------------- Small building blocks ----------------

function Field({ label, hint, children, grow }) {
  return (
    <label className={`ed-field ${grow ? "grow" : ""}`}>
      {label && <span className="ed-label">{label}{hint && <em>{hint}</em>}</span>}
      {children}
    </label>
  );
}

/** A textarea that grows with its content. */
function Area({ value, onChange, placeholder, minRows = 2, disabled, mono }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight + 2}px`;
    };
    fit();
    // Text also re-wraps when the box changes width or the web font arrives.
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [value]);
  return <textarea ref={ref} className={`ed-input ${mono ? "mono" : ""}`} rows={minRows} value={value || ""} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
}

/** A delete button that asks once more before it acts. */
function ConfirmDelete({ onConfirm, label = "Delete", disabled }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button type="button" className={`ed-iconbtn danger ${armed ? "armed" : ""}`} disabled={disabled} title={label}
      onClick={() => (armed ? onConfirm() : setArmed(true))}>
      <Trash2 size={14} />{armed && <span>Sure?</span>}
    </button>
  );
}

/** Upload (or replace, or remove) one audio or image file and hand back its URL. */
function MediaField({ kind, url, examId, onChange, disabled, label, hidePreview }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);
  const accept = kind === "audio" ? "audio/mpeg,audio/wav,audio/mp4,audio/x-m4a,audio/ogg,.mp3,.wav,.m4a,.ogg" : "image/png,image/jpeg,image/webp";

  const upload = async (file) => {
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("examId", examId);
      const data = await adminFetch("/api/uploads", { method: "POST", body: form });
      onChange(data.url);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className={`ed-media ${url ? "filled" : ""}`}>
      {url && kind === "audio" && <audio controls src={url} className="ed-audio" />}
      {url && kind === "image" && !hidePreview && <img src={url} alt="" className="ed-image" />}
      <div className="ed-media-row">
        <span className="ed-media-icon">{kind === "audio" ? <Music size={15} /> : <ImagePlus size={15} />}</span>
        <span className="ed-media-text">{error ? <span className="ed-media-error">{error}</span> : url ? `${label} attached` : `No ${label.toLowerCase()} yet`}</span>
        <input ref={inputRef} type="file" accept={accept} hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        <button type="button" className="ed-btn small" disabled={disabled || busy} onClick={() => inputRef.current?.click()}>
          {busy ? <Loader2 size={13} className="ed-spin" /> : <UploadCloud size={13} />}{url ? "Replace" : "Upload"}
        </button>
        {url && <button type="button" className="ed-btn small ghost" disabled={disabled || busy} onClick={() => onChange(null)}>Remove</button>}
      </div>
    </div>
  );
}

// ---------------- Question editors (IELTS reading) ----------------

function QuestionCard({ q, index, count, readOnly, examId, onChange, onMove, onDelete, onDuplicate, onPropagateOptions }) {
  const [showGroup, setShowGroup] = useState(!!q.groupTitle);
  const set = (patch) => onChange({ ...q, ...patch });
  const letters = q.optionLetters || (q.options || []).map((_, i) => String.fromCharCode(65 + i));
  const yesNo = q.variant === "yes-no";

  return (
    <div className="ed-q">
      <div className="ed-q-head">
        {q.type === "table" || q.type === "map"
          ? <span className="ed-q-n wide">{partNumbers({ questions: [q] }).join(", ") || "—"}</span>
          : <input className="ed-q-n" type="number" value={q.n ?? ""} disabled={readOnly} onChange={(e) => set({ n: Number(e.target.value) })} title="Question number" />}
        <span className="ed-q-type">{READING_TYPES.find(([t]) => t === q.type)?.[1] || q.type}</span>
        <button type="button" className={`ed-chip ${showGroup ? "on" : ""}`} onClick={() => setShowGroup(!showGroup)} title="A heading and instructions printed above this question, starting a new group">Group heading</button>
        <span className="ed-q-tools">
          <button type="button" className="ed-iconbtn" disabled={readOnly || index === 0} onClick={() => onMove(-1)} title="Move up"><ChevronUp size={15} /></button>
          <button type="button" className="ed-iconbtn" disabled={readOnly || index === count - 1} onClick={() => onMove(1)} title="Move down"><ChevronDown size={15} /></button>
          <button type="button" className="ed-iconbtn" disabled={readOnly} onClick={onDuplicate} title="Duplicate"><Copy size={14} /></button>
          <ConfirmDelete onConfirm={onDelete} disabled={readOnly || count === 1} label="Delete question" />
        </span>
      </div>

      {showGroup && (
        <div className="ed-group">
          <Field label="Group heading" hint="e.g. Questions 1-5"><input className="ed-input" value={q.groupTitle || ""} disabled={readOnly} onChange={(e) => set({ groupTitle: e.target.value || undefined })} /></Field>
          <Field label="Group instructions"><Area value={q.groupInstructions} disabled={readOnly} onChange={(v) => set({ groupInstructions: v || undefined })} minRows={1} /></Field>
        </div>
      )}

      {q.type === "tfng" && (
        <>
          <Field label="Statement"><Area value={q.prompt} disabled={readOnly} onChange={(v) => set({ prompt: v })} minRows={1} /></Field>
          <div className="ed-row">
            <div className="ed-seg">
              {(yesNo ? ["YES", "NO", "NOT GIVEN"] : ["TRUE", "FALSE", "NOT GIVEN"]).map((a) => (
                <button type="button" key={a} className={q.answer === a ? "on" : ""} disabled={readOnly} onClick={() => set({ answer: a })}>{a}</button>
              ))}
            </div>
            <label className="ed-check">
              <input type="checkbox" checked={yesNo} disabled={readOnly}
                onChange={(e) => set({ variant: e.target.checked ? "yes-no" : undefined, answer: { TRUE: "YES", FALSE: "NO", YES: "TRUE", NO: "FALSE" }[q.answer] || q.answer })} />
              Yes / No / Not Given (writer's views)
            </label>
          </div>
        </>
      )}

      {q.type === "mcq" && (
        <>
          <Field label="Question"><Area value={q.prompt} disabled={readOnly} onChange={(v) => set({ prompt: v })} minRows={1} /></Field>
          <OptionList options={q.options || []} answer={q.answer} readOnly={readOnly} onChange={(options, answer) => set({ options, answer })} />
        </>
      )}

      {q.type === "gap-fill" && (
        <>
          <div className="ed-gap">
            <Area value={q.before} disabled={readOnly} onChange={(v) => set({ before: v })} placeholder="Text before the blank" minRows={1} />
            <span className="ed-blank">blank</span>
            <Area value={q.after} disabled={readOnly} onChange={(v) => set({ after: v })} placeholder="Text after the blank" minRows={1} />
          </div>
          <Field label="Accepted answers" hint="separate alternatives with |"><input className="ed-input answer" value={answerToText(q.answer)} disabled={readOnly} onChange={(e) => set({ answer: textToAnswer(e.target.value) })} /></Field>
        </>
      )}

      {q.type === "matching" && (
        <>
          <Field label="Item to match"><Area value={q.prompt} disabled={readOnly} onChange={(v) => set({ prompt: v })} minRows={1} /></Field>
          <Field label="Options" hint="one per line — shared with the other questions in this matching group">
            <Area value={(q.options || []).join("\n")} disabled={readOnly} minRows={3}
              onChange={(v) => onPropagateOptions(q.options, v.split("\n"), q.optionLetters ? ROMAN.slice(0, v.split("\n").length) : undefined)} />
          </Field>
          <div className="ed-row">
            <Field label="Correct option">
              <select className="ed-input" value={String(q.answer ?? "")} disabled={readOnly} onChange={(e) => set({ answer: e.target.value })}>
                {!letters.includes(String(q.answer)) && <option value={String(q.answer ?? "")}>—</option>}
                {letters.map((l, i) => <option key={l} value={l}>{l} — {(q.options[i] || "").slice(0, 60)}</option>)}
              </select>
            </Field>
            <label className="ed-check">
              <input type="checkbox" checked={!!q.optionLetters} disabled={readOnly}
                onChange={(e) => onPropagateOptions(q.options, q.options, e.target.checked ? ROMAN.slice(0, q.options.length) : undefined)} />
              Label options i, ii, iii (matching headings)
            </label>
          </div>
        </>
      )}

      {q.type === "table" && <TableEditor q={q} readOnly={readOnly} onChange={onChange} />}
      {q.type === "map" && <MapEditor q={q} readOnly={readOnly} examId={examId} onChange={onChange} />}
    </div>
  );
}

/** Multiple-choice options with a radio marking the correct one. */
function OptionList({ options, answer, readOnly, onChange, min = 2 }) {
  const correct = options.indexOf(answer);
  return (
    <div className="ed-options">
      <span className="ed-label">Options <em>select the correct one</em></span>
      {options.map((opt, i) => (
        <div className="ed-option" key={i}>
          <input type="radio" checked={correct === i && opt !== ""} disabled={readOnly || opt === ""} onChange={() => onChange(options, opt)} title="Correct answer" />
          <span className="ed-letter">{String.fromCharCode(65 + i)}</span>
          <input className={`ed-input ${correct === i && opt !== "" ? "answer" : ""}`} value={opt} disabled={readOnly}
            onChange={(e) => { const next = [...options]; next[i] = e.target.value; onChange(next, correct === i ? e.target.value : answer); }} />
          <button type="button" className="ed-iconbtn" disabled={readOnly || options.length <= min} title="Remove option"
            onClick={() => onChange(options.filter((_, j) => j !== i), correct === i ? "" : answer)}><X size={13} /></button>
        </div>
      ))}
      {!readOnly && <button type="button" className="ed-link" onClick={() => onChange([...options, ""], answer)}><Plus size={12} /> Add option</button>}
    </div>
  );
}

function TableEditor({ q, readOnly, onChange }) {
  const { headers, rows } = q.table;
  const gapFor = (cell) => q.gaps.find((g) => g.cellMarker === cell);
  const setTable = (table, gaps = q.gaps) => onChange({ ...q, table, gaps, n: gaps[0]?.n ?? q.n });
  const setCell = (r, c, value) => setTable({ headers, rows: rows.map((row, ri) => row.map((cell, ci) => (ri === r && ci === c ? value : cell))) });

  const toggleBlank = (r, c) => {
    const gap = gapFor(rows[r][c]);
    if (gap) {
      const gaps = q.gaps.filter((g) => g !== gap);
      onChange({ ...q, gaps, n: gaps[0]?.n ?? q.n, table: { headers, rows: rows.map((row, ri) => row.map((cell, ci) => (ri === r && ci === c ? [].concat(gap.answer)[0] || "" : cell))) } });
    } else {
      const n = (q.gaps.length ? Math.max(...q.gaps.map((g) => g.n)) : (q.n || 1) - 1) + 1;
      const marker = `___GAP${n}_${Math.random().toString(36).slice(2, 5)}___`;
      const gaps = [...q.gaps, { id: uid("g"), n, cellMarker: marker, answer: rows[r][c] }];
      onChange({ ...q, gaps, n: gaps[0].n, table: { headers, rows: rows.map((row, ri) => row.map((cell, ci) => (ri === r && ci === c ? marker : cell))) } });
    }
  };
  const setGap = (gap, patch) => onChange({ ...q, gaps: q.gaps.map((g) => (g === gap ? { ...g, ...patch } : g)) });

  return (
    <div className="ed-table-wrap">
      <table className="ed-table">
        <thead>
          <tr>{headers.map((h, c) => <th key={c}><input className="ed-input" value={h} disabled={readOnly} placeholder="Heading" onChange={(e) => setTable({ headers: headers.map((x, i) => (i === c ? e.target.value : x)), rows })} /></th>)}<th /></tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => {
                const gap = gapFor(cell);
                return (
                  <td key={c} className={gap ? "blank" : ""}>
                    {gap ? (
                      <div className="ed-cell-blank">
                        <input className="ed-q-n" type="number" value={gap.n} disabled={readOnly} onChange={(e) => setGap(gap, { n: Number(e.target.value) })} title="Question number" />
                        <input className="ed-input answer" value={answerToText(gap.answer)} disabled={readOnly} placeholder="Answer" onChange={(e) => setGap(gap, { answer: textToAnswer(e.target.value) })} />
                      </div>
                    ) : <input className="ed-input" value={cell} disabled={readOnly} onChange={(e) => setCell(r, c, e.target.value)} />}
                    {!readOnly && <button type="button" className="ed-cell-toggle" onClick={() => toggleBlank(r, c)}>{gap ? "make text" : "make blank"}</button>}
                  </td>
                );
              })}
              <td className="ed-table-tool">
                <ConfirmDelete disabled={readOnly || rows.length === 1} label="Delete row"
                  onConfirm={() => { const removed = rows[r]; const gaps = q.gaps.filter((g) => !removed.includes(g.cellMarker)); setTable({ headers, rows: rows.filter((_, i) => i !== r) }, gaps); }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly && (
        <div className="ed-row">
          <button type="button" className="ed-link" onClick={() => setTable({ headers, rows: [...rows, headers.map(() => "")] })}><Plus size={12} /> Add row</button>
          <button type="button" className="ed-link" onClick={() => setTable({ headers: [...headers, ""], rows: rows.map((row) => [...row, ""]) })}><Plus size={12} /> Add column</button>
          {headers.length > 1 && (
            <button type="button" className="ed-link" onClick={() => { const last = headers.length - 1; const gaps = q.gaps.filter((g) => !rows.some((row) => row[last] === g.cellMarker)); setTable({ headers: headers.slice(0, last), rows: rows.map((row) => row.slice(0, last)) }, gaps); }}>Remove last column</button>
          )}
        </div>
      )}
    </div>
  );
}

function MapEditor({ q, readOnly, examId, onChange }) {
  const [active, setActive] = useState(0);
  const setPoint = (i, patch) => onChange({ ...q, points: q.points.map((p, j) => (j === i ? { ...p, ...patch } : p)), n: q.points[0]?.n ?? q.n });
  const place = (e) => {
    if (readOnly || !q.points[active]) return;
    const box = e.currentTarget.getBoundingClientRect();
    setPoint(active, { x: Math.round(((e.clientX - box.left) / box.width) * 1000) / 10, y: Math.round(((e.clientY - box.top) / box.height) * 1000) / 10 });
  };
  return (
    <div className="ed-map">
      <MediaField kind="image" label="Diagram" url={q.imageUrl || null} hidePreview examId={examId} disabled={readOnly} onChange={(url) => onChange({ ...q, imageUrl: url || "" })} />
      {q.imageUrl ? (
        <div className="ed-map-stage" onClick={place} title="Click to place the selected pin">
          <img src={q.imageUrl} alt="Diagram" />
          {q.points.map((p, i) => <span key={p.id} className={`ed-pin ${i === active ? "on" : ""}`} style={{ left: `${p.x}%`, top: `${p.y}%` }}>{p.n}</span>)}
        </div>
      ) : <p className="ed-hint">Upload the diagram, then select a pin below and click on the image to place it.</p>}
      {q.points.map((p, i) => (
        <div className={`ed-point ${i === active ? "on" : ""}`} key={p.id} onClick={() => setActive(i)}>
          <input className="ed-q-n" type="number" value={p.n} disabled={readOnly} onChange={(e) => setPoint(i, { n: Number(e.target.value) })} title="Question number" />
          <input className="ed-input answer" value={answerToText(p.answer)} disabled={readOnly} placeholder="Label (accepted answers, | between alternatives)" onChange={(e) => setPoint(i, { answer: textToAnswer(e.target.value) })} />
          <ConfirmDelete disabled={readOnly || q.points.length === 1} label="Delete pin"
            onConfirm={() => { const points = q.points.filter((_, j) => j !== i); onChange({ ...q, points, n: points[0]?.n ?? q.n }); setActive(0); }} />
        </div>
      ))}
      {!readOnly && (
        <button type="button" className="ed-link" onClick={() => { const n = Math.max(...q.points.map((p) => p.n)) + 1; onChange({ ...q, points: [...q.points, { id: uid("p"), n, x: 50, y: 50, answer: "" }] }); setActive(q.points.length); }}>
          <Plus size={12} /> Add pin
        </button>
      )}
    </div>
  );
}

// ---------------- Unit editors ----------------

function ReadingPartEditor({ part, section, readOnly, examId, onChange }) {
  const set = (patch) => onChange({ ...part, ...patch });
  const [adding, setAdding] = useState(false);
  const setQuestions = (questions) => set({ questions });
  const words = part.passage.join(" ").trim().split(/\s+/).filter(Boolean).length;

  // Matching questions that shared one option bank keep sharing it.
  const propagate = (oldOptions, options, optionLetters) => {
    const key = JSON.stringify(oldOptions);
    setQuestions(part.questions.map((q) => {
      if (q.type !== "matching" || JSON.stringify(q.options) !== key) return q;
      const next = { ...q, options };
      if (optionLetters) next.optionLetters = optionLetters; else delete next.optionLetters;
      return next;
    }));
  };

  return (
    <>
      <div className="ed-card">
        <Field label="Passage heading"><input className="ed-input" value={part.title || ""} disabled={readOnly} onChange={(e) => set({ title: e.target.value })} /></Field>
        <Field label="Passage" hint={`${words} words · leave a blank line between paragraphs`}>
          <Area value={part.passage.join("\n\n")} disabled={readOnly} minRows={10} onChange={(v) => set({ passage: v.split(/\n\s*\n/) })} />
        </Field>
      </div>
      <div className="ed-card">
        <h4>Instructions above the questions</h4>
        <Field label="Heading" hint="e.g. Questions 1-13"><input className="ed-input" value={part.instructionsTitle || ""} disabled={readOnly} onChange={(e) => set({ instructionsTitle: e.target.value })} /></Field>
        <Field label="Instructions"><Area value={part.instructions} disabled={readOnly} minRows={1} onChange={(v) => set({ instructions: v })} /></Field>
      </div>

      <div className="ed-list-head"><h4>Questions <em>{partNumbers(part).length}</em></h4></div>
      {part.questions.map((q, i) => (
        <QuestionCard key={q.id || i} q={q} index={i} count={part.questions.length} readOnly={readOnly} examId={examId}
          onChange={(next) => setQuestions(part.questions.map((x, j) => (j === i ? next : x)))}
          onMove={(dir) => { const next = [...part.questions]; [next[i], next[i + dir]] = [next[i + dir], next[i]]; setQuestions(next); }}
          onDelete={() => setQuestions(part.questions.filter((_, j) => j !== i))}
          onDuplicate={() => { const copy = JSON.parse(JSON.stringify(q)); copy.id = uid("q"); (copy.gaps || []).forEach((g) => { g.id = uid("g"); }); (copy.points || []).forEach((p) => { p.id = uid("p"); }); const next = [...part.questions]; next.splice(i + 1, 0, copy); setQuestions(next); }}
          onPropagateOptions={propagate} />
      ))}
      {!readOnly && (
        <div className="ed-add">
          {adding ? (
            <>
              {READING_TYPES.map(([type, label]) => (
                <button type="button" key={type} className="ed-btn small" onClick={() => { setQuestions([...part.questions, newReadingQuestion(type, nextNumber(section))]); setAdding(false); }}>{label}</button>
              ))}
              <button type="button" className="ed-btn small ghost" onClick={() => setAdding(false)}>Cancel</button>
            </>
          ) : <button type="button" className="ed-btn" onClick={() => setAdding(true)}><Plus size={14} /> Add question</button>}
        </div>
      )}
    </>
  );
}

function ListeningPartEditor({ part, partIndex, section, readOnly, examId, canRecord, onChange }) {
  const set = (patch) => onChange({ ...part, ...patch });
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState("");
  const setItem = (i, item) => set({ items: part.items.map((x, j) => (j === i ? item : x)) });
  const words = (part.transcript || "").trim().split(/\s+/).filter(Boolean).length;

  const record = async () => {
    setRecording(true);
    setRecordError("");
    try {
      const data = await adminFetch("/api/ai/tts", { method: "POST", body: JSON.stringify({ script: part.transcript, partIndex }) });
      set({ audioUrl: data.audioUrl });
    } catch (e) {
      setRecordError(e.message);
    } finally {
      setRecording(false);
    }
  };

  return (
    <>
      <div className="ed-card">
        <Field label="Part title"><input className="ed-input" value={part.title || ""} disabled={readOnly} onChange={(e) => set({ title: e.target.value })} /></Field>
        <Field label="Instructions"><Area value={part.instructions} disabled={readOnly} minRows={1} onChange={(v) => set({ instructions: v })} /></Field>
      </div>

      <div className="ed-card">
        <h4>Audio</h4>
        {section.audioUrl && <p className="ed-hint">This section plays one recording for all its parts (see Section settings), so audio set here is ignored.</p>}
        <MediaField kind="audio" label="Recording" url={part.audioUrl} examId={examId} disabled={readOnly} onChange={(url) => set({ audioUrl: url })} />
        {canRecord && !readOnly && (
          <div className="ed-row">
            <button type="button" className="ed-btn small" disabled={recording || words < 20} onClick={record}>
              {recording ? <Loader2 size={13} className="ed-spin" /> : <Mic size={13} />}
              {recording ? "Recording… this takes a minute or two" : part.audioUrl ? "Record again from the script" : "Record from the script"}
            </button>
            {recordError && <span className="ed-media-error">{recordError}</span>}
          </div>
        )}
        <Field label="Script" hint={`${words} words · students never see this · start each turn of a conversation with "Name:"`}>
          <Area value={part.transcript} disabled={readOnly} minRows={6} onChange={(v) => set({ transcript: v })} />
        </Field>
      </div>

      <div className="ed-list-head"><h4>Notes and blanks <em>{partNumbers(part).length} questions</em></h4></div>
      {part.items.map((item, i) => (
        <div className="ed-q" key={i}>
          <div className="ed-q-head">
            <input className="ed-input" value={item.label || ""} placeholder="Heading for this group of notes" disabled={readOnly} onChange={(e) => setItem(i, { ...item, label: e.target.value })} />
            <ConfirmDelete disabled={readOnly || part.items.length === 1} label="Delete group" onConfirm={() => set({ items: part.items.filter((_, j) => j !== i) })} />
          </div>
          {item.unorderedGroup && <p className="ed-hint">This group is a "choose {item.unorderedGroup.ns.length} letters in any order" question; its answers ({item.unorderedGroup.answers.join(", ")}) are kept as they are.</p>}
          {item.lines.map((line, li) => {
            const setLine = (patch) => setItem(i, { ...item, lines: item.lines.map((x, j) => (j === li ? { ...x, ...patch } : x)) });
            const move = (dir) => { const lines = [...item.lines]; [lines[li], lines[li + dir]] = [lines[li + dir], lines[li]]; setItem(i, { ...item, lines }); };
            const grouped = item.unorderedGroup?.ns.includes(line.n);
            return (
              <div className="ed-line" key={li}>
                {line.n === undefined ? (
                  <>
                    <span className="ed-q-n wide muted">text</span>
                    <input className="ed-input narrow" value={line.pre || ""} placeholder="-" disabled={readOnly} onChange={(e) => setLine({ pre: e.target.value })} />
                    <input className="ed-input" value={line.text || ""} placeholder="A line of notes with no blank" disabled={readOnly} onChange={(e) => setLine({ text: e.target.value })} />
                  </>
                ) : (
                  <>
                    <input className="ed-q-n" type="number" value={line.n} disabled={readOnly} onChange={(e) => setLine({ n: Number(e.target.value) })} title="Question number" />
                    <input className="ed-input" value={line.pre || ""} placeholder="Text before the blank" disabled={readOnly} onChange={(e) => setLine({ pre: e.target.value })} />
                    {grouped
                      ? <span className="ed-blank">blank</span>
                      : <input className="ed-input answer" value={answerToText(line.answer)} placeholder="Answer (| between alternatives)" disabled={readOnly} onChange={(e) => setLine({ answer: textToAnswer(e.target.value) })} />}
                    <input className="ed-input" value={line.post || ""} placeholder="Text after" disabled={readOnly} onChange={(e) => setLine({ post: e.target.value })} />
                  </>
                )}
                <button type="button" className="ed-iconbtn" disabled={readOnly || li === 0} onClick={() => move(-1)} title="Move up"><ChevronUp size={14} /></button>
                <button type="button" className="ed-iconbtn" disabled={readOnly || li === item.lines.length - 1} onClick={() => move(1)} title="Move down"><ChevronDown size={14} /></button>
                <ConfirmDelete disabled={readOnly || item.lines.length === 1 || grouped} label="Delete line" onConfirm={() => setItem(i, { ...item, lines: item.lines.filter((_, j) => j !== li) })} />
              </div>
            );
          })}
          {!readOnly && (
            <div className="ed-row">
              <button type="button" className="ed-link" onClick={() => setItem(i, { ...item, lines: [...item.lines, { pre: "", n: nextNumber(section), post: "", answer: "" }] })}><Plus size={12} /> Add blank</button>
              <button type="button" className="ed-link" onClick={() => setItem(i, { ...item, lines: [...item.lines, { pre: "-", text: "" }] })}><Plus size={12} /> Add text line</button>
            </div>
          )}
        </div>
      ))}
      {!readOnly && (
        <div className="ed-add">
          <button type="button" className="ed-btn" onClick={() => set({ items: [...part.items, { label: "", lines: [{ pre: "", n: nextNumber(section), post: "", answer: "" }] }] })}><Plus size={14} /> Add group of notes</button>
        </div>
      )}
    </>
  );
}

function WritingPartEditor({ part, index, readOnly, examId, onChange }) {
  const set = (patch) => onChange({ ...part, ...patch });
  return (
    <div className="ed-card">
      <h4>Task {index + 1}</h4>
      <Field label="Instructions"><Area value={part.instructions} disabled={readOnly} minRows={1} onChange={(v) => set({ instructions: v })} /></Field>
      <Field label="Task"><Area value={part.prompt} disabled={readOnly} minRows={4} onChange={(v) => set({ prompt: v })} /></Field>
      <div className="ed-row">
        <Field label="Minimum words"><input className="ed-input narrow" type="number" value={part.minWords ?? ""} disabled={readOnly} onChange={(e) => set({ minWords: e.target.value === "" ? undefined : Number(e.target.value) })} /></Field>
      </div>
      <span className="ed-label">Chart, graph or diagram <em>shown under the task</em></span>
      <MediaField kind="image" label="Image" url={part.chartImageUrl} examId={examId} disabled={readOnly} onChange={(url) => set({ chartImageUrl: url })} />
    </div>
  );
}

function SatModuleEditor({ mod, sectionType, readOnly, examId, onChange }) {
  const isMath = sectionType === "math";
  // SAT questions are numbered by position, so keep n in step with the order.
  const setQuestions = (questions) => onChange({ ...mod, questions: questions.map((q, i) => ({ ...q, n: i + 1 })) });
  const setQ = (i, patch) => setQuestions(mod.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const blank = () => ({ id: `${mod.id}-${uid("q")}`, n: 0, type: "mcq", ...(isMath ? {} : { passage: "" }), prompt: "", options: ["", "", "", ""], answer: "" });

  return (
    <>
      <div className="ed-card">
        <div className="ed-row">
          <Field label="Time for this module (minutes)"><input className="ed-input narrow" type="number" value={mod.durationMinutes ?? ""} disabled={readOnly} onChange={(e) => onChange({ ...mod, durationMinutes: Number(e.target.value) })} /></Field>
        </div>
        {mod.stage === "module2" && <p className="ed-hint">A student sees Module 1 and then only one Module 2: this {mod.difficulty === "hard" ? "harder" : "easier"} one if they scored {mod.difficulty === "hard" ? "above" : "below"} the routing threshold on Module 1.</p>}
      </div>
      <div className="ed-list-head"><h4>Questions <em>{mod.questions.length}</em></h4></div>
      {mod.questions.map((q, i) => (
        <div className="ed-q" key={q.id || i}>
          <div className="ed-q-head">
            <span className="ed-q-n wide">{i + 1}</span>
            {isMath ? (
              <div className="ed-seg small">
                <button type="button" className={q.type === "mcq" ? "on" : ""} disabled={readOnly} onClick={() => setQ(i, { type: "mcq", options: q.options?.length ? q.options : ["", "", "", ""], answer: "" })}>Multiple choice</button>
                <button type="button" className={q.type === "grid-in" ? "on" : ""} disabled={readOnly} onClick={() => { const { options, ...rest } = q; setQuestions(mod.questions.map((x, j) => (j === i ? { ...rest, type: "grid-in", answer: "" } : x))); }}>Student answer</button>
              </div>
            ) : <span className="ed-q-type">Multiple choice</span>}
            <span className="ed-q-tools">
              <button type="button" className="ed-iconbtn" disabled={readOnly || i === 0} onClick={() => { const next = [...mod.questions]; [next[i], next[i - 1]] = [next[i - 1], next[i]]; setQuestions(next); }} title="Move up"><ChevronUp size={15} /></button>
              <button type="button" className="ed-iconbtn" disabled={readOnly || i === mod.questions.length - 1} onClick={() => { const next = [...mod.questions]; [next[i], next[i + 1]] = [next[i + 1], next[i]]; setQuestions(next); }} title="Move down"><ChevronDown size={15} /></button>
              <button type="button" className="ed-iconbtn" disabled={readOnly} title="Duplicate" onClick={() => { const next = [...mod.questions]; next.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(q)), id: `${mod.id}-${uid("q")}` }); setQuestions(next); }}><Copy size={14} /></button>
              <ConfirmDelete disabled={readOnly || mod.questions.length === 1} label="Delete question" onConfirm={() => setQuestions(mod.questions.filter((_, j) => j !== i))} />
            </span>
          </div>
          {!isMath && <Field label="Passage"><Area value={q.passage} disabled={readOnly} minRows={3} onChange={(v) => setQ(i, { passage: v })} /></Field>}
          <Field label="Question"><Area value={q.prompt} disabled={readOnly} minRows={1} onChange={(v) => setQ(i, { prompt: v })} /></Field>
          {q.type === "grid-in" ? (
            <Field label="Correct answer" hint="a number: 12, -3, .75 or 7/2 — equivalent forms are accepted automatically">
              <input className="ed-input answer narrow" value={q.answer ?? ""} disabled={readOnly} onChange={(e) => setQ(i, { answer: e.target.value })} />
            </Field>
          ) : <OptionList options={q.options || []} answer={q.answer} readOnly={readOnly} min={4} onChange={(options, answer) => setQ(i, { options, answer })} />}
          <span className="ed-label">Figure <em>a graph or diagram shown above the question</em></span>
          <MediaField kind="image" label="Figure" url={q.imageUrl} examId={examId} disabled={readOnly} onChange={(url) => { if (url) setQ(i, { imageUrl: url }); else { const { imageUrl, ...rest } = q; setQuestions(mod.questions.map((x, j) => (j === i ? rest : x))); } }} />
        </div>
      ))}
      {!readOnly && <div className="ed-add"><button type="button" className="ed-btn" onClick={() => setQuestions([...mod.questions, blank()])}><Plus size={14} /> Add question</button></div>}
    </>
  );
}

function SectionSettings({ section, readOnly, examId, onChange, onDelete, onRenumber, canDelete }) {
  const set = (patch) => onChange({ ...section, ...patch });
  const meta = SECTION_META[section.type];
  return (
    <div className="ed-card">
      <h4>{meta.name} settings</h4>
      {!isSatSection(section) && (
        <div className="ed-row">
          <Field label="Time for this section (minutes)"><input className="ed-input narrow" type="number" value={section.durationMinutes ?? ""} disabled={readOnly} onChange={(e) => set({ durationMinutes: e.target.value === "" ? undefined : Number(e.target.value) })} /></Field>
        </div>
      )}
      {section.type === "reading" && (
        <Field label="Reading band scale">
          <div className="ed-seg">
            {[["academic", "Academic"], ["general", "General Training"]].map(([v, label]) => (
              <button type="button" key={v} className={(section.variant || "academic") === v ? "on" : ""} disabled={readOnly} onClick={() => set({ variant: v })}>{label}</button>
            ))}
          </div>
        </Field>
      )}
      {section.type === "listening" && (
        <>
          <span className="ed-label">One recording for the whole section <em>like the real test: it plays straight through every part. Leave empty to give each part its own audio.</em></span>
          <MediaField kind="audio" label="Section recording" url={section.audioUrl} examId={examId} disabled={readOnly}
            onChange={(url) => set(url ? { audioUrl: url, id: section.id || "listening" } : { audioUrl: null })} />
        </>
      )}
      {isSatSection(section) && (
        <Field label="Routing threshold" hint="share of Module 1 a student must get right to be given the harder Module 2 (0 to 1; 0.6 if left empty)">
          <input className="ed-input narrow" type="number" step="0.05" min="0" max="1" value={section.routing?.threshold ?? ""} disabled={readOnly}
            onChange={(e) => { if (e.target.value === "") { const { routing, ...rest } = section; onChange(rest); } else set({ routing: { threshold: Number(e.target.value) } }); }} />
        </Field>
      )}
      {!readOnly && (
        <div className="ed-row spread">
          {!isSatSection(section) && section.type !== "writing"
            ? <button type="button" className="ed-btn small" onClick={onRenumber}><ListOrdered size={13} /> Renumber questions 1, 2, 3…</button>
            : <span />}
          {canDelete && <span className="ed-danger-zone">Remove this whole section <ConfirmDelete onConfirm={onDelete} label="Delete section" /></span>}
        </div>
      )}
    </div>
  );
}

/** Renumbers every question in an IELTS section 1, 2, 3… in the order shown. */
function renumber(section) {
  let n = 0;
  const next = JSON.parse(JSON.stringify(section));
  for (const part of next.parts) {
    for (const q of part.questions || []) {
      if (q.type === "table") {
        // Gaps are numbered in reading order of the table, not creation order.
        const order = q.table.rows.flat();
        q.gaps.sort((a, b) => order.indexOf(a.cellMarker) - order.indexOf(b.cellMarker));
        q.gaps.forEach((g) => { g.n = ++n; });
        q.n = q.gaps[0]?.n ?? q.n;
      } else if (q.type === "map") {
        q.points.forEach((p) => { p.n = ++n; });
        q.n = q.points[0]?.n ?? q.n;
      } else q.n = ++n;
    }
    for (const item of part.items || []) {
      const mapping = new Map();
      for (const line of item.lines) if (line.n !== undefined) { mapping.set(line.n, ++n); line.n = n; }
      if (item.unorderedGroup) item.unorderedGroup.ns = item.unorderedGroup.ns.map((old) => mapping.get(old) ?? old);
    }
  }
  return next;
}

/** Drops what free typing leaves behind before a save: blank paragraphs,
 * blank lines in a matching option list, stray whitespace. */
function tidy(sections) {
  const next = JSON.parse(JSON.stringify(sections));
  for (const section of next) {
    for (const part of section.parts || []) {
      if (Array.isArray(part.passage)) part.passage = part.passage.map((p) => p.trim()).filter(Boolean);
      for (const q of part.questions || []) {
        if (q.type !== "matching") continue;
        q.options = q.options.map((o) => o.trim()).filter(Boolean);
        if (q.optionLetters) q.optionLetters = q.optionLetters.slice(0, q.options.length);
      }
    }
  }
  return next;
}

// ---------------- The editor ----------------

export default function ExamEditor({ examId, onBack, onPreview }) {
  const [exam, setExam] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState({ section: 0, unit: 0 }); // unit: index of part/module, or "settings"
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [errors, setErrors] = useState(null); // { message, details[] }
  const [canRecord, setCanRecord] = useState(false);
  const [addingSection, setAddingSection] = useState(false);
  const mainRef = useRef(null);

  useEffect(() => {
    adminFetch(`/api/exams/${examId}`, {}, onBack).then(setExam).catch((e) => setLoadError(e.message));
    adminFetch("/api/ai/status").then((s) => setCanRecord(!!s.audio)).catch(() => {});
  }, [examId, onBack]);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const change = useCallback((fn) => {
    setExam((prev) => fn(prev));
    setDirty(true);
  }, []);

  const save = useCallback(async () => {
    if (!exam || saving) return;
    setSaving(true);
    setErrors(null);
    try {
      const saved = await adminFetch(`/api/exams/${examId}`, { method: "PATCH", body: JSON.stringify({ title: exam.title, sections: tidy(exam.sections) }) });
      setExam(saved);
      setDirty(false);
      setSavedAt(Date.now());
    } catch (e) {
      setErrors({ message: e.message, details: e.details || [] });
      mainRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setSaving(false);
    }
  }, [exam, examId, saving]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  useEffect(() => { mainRef.current?.scrollTo({ top: 0 }); }, [selected.section, selected.unit]);

  if (loadError) return <div className="ed-root ed-center"><style dangerouslySetInnerHTML={{ __html: CSS }} /><p>{loadError}</p><button className="ed-btn" onClick={onBack}><ArrowLeft size={14} /> Back to exams</button></div>;
  if (!exam) return <div className="ed-root ed-center"><style dangerouslySetInnerHTML={{ __html: CSS }} /><Loader2 size={22} className="ed-spin" /></div>;

  const readOnly = ["active", "paused", "generating"].includes(exam.status);
  const testType = exam.testType || "ielts";
  const sections = exam.sections || [];
  const section = sections[Math.min(selected.section, sections.length - 1)];
  const sectionIndex = sections.indexOf(section);
  const units = section ? (isSatSection(section) ? section.modules : section.parts) : [];
  const setSection = (next) => change((prev) => ({ ...prev, sections: prev.sections.map((s, i) => (i === sectionIndex ? next : s)) }));
  const setUnit = (unitIndex, next) => setSection(isSatSection(section) ? { ...section, modules: section.modules.map((m, i) => (i === unitIndex ? next : m)) } : { ...section, parts: section.parts.map((p, i) => (i === unitIndex ? next : p)) });
  const missingSections = SECTION_ORDER[testType].filter((type) => !sections.some((s) => s.type === type));

  const leave = (go) => {
    if (dirty && !window.confirm("You have unsaved changes. Leave without saving?")) return;
    go();
  };

  return (
    <div className="ed-root">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <header className="ed-top">
        <button className="ed-btn ghost" onClick={() => leave(onBack)}><ArrowLeft size={15} /> Exams</button>
        <input className="ed-title" value={exam.title || ""} disabled={readOnly} onChange={(e) => change((prev) => ({ ...prev, title: e.target.value }))} placeholder="Exam title" />
        <span className={`ed-status ${dirty ? "dirty" : ""}`}>
          {saving ? "Saving…" : dirty ? "Unsaved changes" : savedAt ? <><Check size={13} /> Saved</> : { draft: "Draft", closed: "Closed", active: "Live", paused: "Paused", generating: "Being built", generation_failed: "Build failed" }[exam.status] || exam.status}
        </span>
        <button className="ed-btn ghost" onClick={() => leave(onPreview)}><Eye size={15} /> Preview</button>
        <button className="ed-btn primary" onClick={save} disabled={readOnly || saving || !dirty}>
          {saving ? <Loader2 size={15} className="ed-spin" /> : <Save size={15} />} Save
        </button>
      </header>

      <div className="ed-body">
        <nav className="ed-rail">
          {sections.map((s, si) => {
            const meta = SECTION_META[s.type];
            const list = isSatSection(s) ? s.modules : s.parts;
            return (
              <div className="ed-rail-section" key={s.type}>
                <div className="ed-rail-title"><meta.icon size={14} /> {meta.name}</div>
                {list.map((unit, ui) => (
                  <div key={unit.id || ui} className={`ed-rail-item ${si === sectionIndex && selected.unit === ui ? "on" : ""}`}>
                    <button type="button" onClick={() => setSelected({ section: si, unit: ui })}>
                      <span>{isSatSection(s) ? moduleLabel(unit) : `${meta.unit} ${ui + 1}`}</span>
                      <small>
                        {isSatSection(s) ? `${unit.questions.length} questions`
                          : s.type === "writing" ? `${(unit.prompt || "").trim().split(/\s+/).filter(Boolean).length} words`
                          : `${partNumbers(unit).length} questions`}
                        {s.type === "listening" && !unit.audioUrl && !s.audioUrl && <em> · no audio</em>}
                      </small>
                    </button>
                    {!readOnly && !isSatSection(s) && list.length > 1 && (
                      <ConfirmDelete label={`Delete this ${meta.unit.toLowerCase()}`}
                        onConfirm={() => { change((prev) => ({ ...prev, sections: prev.sections.map((x, i) => (i === si ? { ...x, parts: x.parts.filter((_, j) => j !== ui) } : x)) })); setSelected({ section: si, unit: 0 }); }} />
                    )}
                  </div>
                ))}
                {!readOnly && !isSatSection(s) && !(s.type === "writing" && list.length >= 2) && (
                  <button type="button" className="ed-rail-add" onClick={() => { change((prev) => ({ ...prev, sections: prev.sections.map((x, i) => (i === si ? { ...x, parts: [...x.parts, newPart(x.type, x)] } : x)) })); setSelected({ section: si, unit: list.length }); }}>
                    <Plus size={12} /> Add {meta.unit.toLowerCase()}
                  </button>
                )}
                <button type="button" className={`ed-rail-item settings ${si === sectionIndex && selected.unit === "settings" ? "on" : ""}`} onClick={() => setSelected({ section: si, unit: "settings" })}>
                  <span><Settings2 size={12} /> Section settings</span>
                </button>
              </div>
            );
          })}
          {!readOnly && missingSections.length > 0 && (
            <div className="ed-rail-section">
              {addingSection ? missingSections.map((type) => (
                <button type="button" key={type} className="ed-rail-add" onClick={() => { change((prev) => { const next = [...prev.sections, newSection(type)]; next.sort((a, b) => SECTION_ORDER[testType].indexOf(a.type) - SECTION_ORDER[testType].indexOf(b.type)); return { ...prev, sections: next }; }); setAddingSection(false); setSelected({ section: SECTION_ORDER[testType].filter((t) => t === type || sections.some((s) => s.type === t)).indexOf(type), unit: 0 }); }}>
                  <Plus size={12} /> {SECTION_META[type].name}
                </button>
              )) : <button type="button" className="ed-rail-add" onClick={() => setAddingSection(true)}><Plus size={12} /> Add section</button>}
            </div>
          )}
        </nav>

        <main className="ed-main" ref={mainRef}>
          <div className="ed-column">
            {readOnly && <div className="ed-banner"><AlertTriangle size={15} /> This exam is {exam.status === "generating" ? "still being built" : "live"}, so it can't be edited right now.</div>}
            {errors && (
              <div className="ed-errors">
                <strong><AlertTriangle size={14} /> {errors.message}</strong>
                {errors.details.length > 0 && <ul>{errors.details.slice(0, 30).map((d, i) => <li key={i}>{d}</li>)}</ul>}
                <button type="button" className="ed-iconbtn" onClick={() => setErrors(null)}><X size={14} /></button>
              </div>
            )}

            {!section ? <p className="ed-hint">This exam has no sections yet. Add one from the left.</p>
              : selected.unit === "settings" ? (
                <SectionSettings section={section} readOnly={readOnly} examId={examId} canDelete={sections.length > 1}
                  onChange={setSection} onRenumber={() => setSection(renumber(section))}
                  onDelete={() => { change((prev) => ({ ...prev, sections: prev.sections.filter((_, i) => i !== sectionIndex) })); setSelected({ section: 0, unit: 0 }); }} />
              ) : (() => {
                const unitIndex = Math.min(selected.unit, units.length - 1);
                const unit = units[unitIndex];
                if (!unit) return null;
                const heading = isSatSection(section) ? `${SECTION_META[section.type].name} · ${moduleLabel(unit)}` : `${SECTION_META[section.type].name} · ${SECTION_META[section.type].unit} ${unitIndex + 1}`;
                return (
                  <>
                    <h2 className="ed-heading">{heading}</h2>
                    {isSatSection(section) && <SatModuleEditor mod={unit} sectionType={section.type} readOnly={readOnly} examId={examId} onChange={(next) => setUnit(unitIndex, next)} />}
                    {section.type === "reading" && <ReadingPartEditor part={unit} section={section} readOnly={readOnly} examId={examId} onChange={(next) => setUnit(unitIndex, next)} />}
                    {section.type === "listening" && <ListeningPartEditor part={unit} partIndex={unitIndex} section={section} readOnly={readOnly} examId={examId} canRecord={canRecord} onChange={(next) => setUnit(unitIndex, next)} />}
                    {section.type === "writing" && <WritingPartEditor part={unit} index={unitIndex} readOnly={readOnly} examId={examId} onChange={(next) => setUnit(unitIndex, next)} />}
                  </>
                );
              })()}
          </div>
        </main>
      </div>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap');
html, body, #__next { margin:0; height:100%; }
.ed-root { --bg:#f8f9fc; --surface:#fff; --border:#e8eaf2; --text:#111d40; --muted:#6f7890; --purple:#5b50e6; --green:#1e7a34; --green-bg:#e3f5e8;
  height:100vh; display:flex; flex-direction:column; background:var(--bg); color:var(--text); font-family:"Poppins",-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; font-size:13px; }
.ed-root * { box-sizing:border-box; }
.ed-root button, .ed-root input, .ed-root textarea, .ed-root select { font:inherit; color:inherit; }
.ed-center { align-items:center; justify-content:center; gap:14px; }
.ed-spin { animation:edSpin .8s linear infinite; }
@keyframes edSpin { to { transform:rotate(360deg); } }

.ed-top { flex-shrink:0; display:flex; align-items:center; gap:12px; padding:12px 20px; background:var(--surface); border-bottom:1px solid var(--border); }
.ed-title { flex:1; min-width:0; border:1.5px solid transparent; border-radius:8px; padding:7px 10px; font-size:16px; font-weight:700; letter-spacing:-.2px; background:transparent; }
.ed-title:hover:not(:disabled) { border-color:var(--border); }
.ed-title:focus { outline:none; border-color:var(--purple); background:var(--surface); }
.ed-status { display:inline-flex; align-items:center; gap:5px; font-size:11.5px; font-weight:600; color:var(--muted); white-space:nowrap; }
.ed-status.dirty { color:#b47a16; }

.ed-btn { display:inline-flex; align-items:center; gap:7px; padding:8px 14px; border-radius:8px; border:1.5px solid var(--border); background:var(--surface); font-size:12.5px; font-weight:600; cursor:pointer; white-space:nowrap; transition:background-color .15s ease, border-color .15s ease, opacity .15s ease; }
.ed-btn:hover:not(:disabled) { border-color:#c3c8d8; }
.ed-btn:disabled { opacity:.45; cursor:not-allowed; }
.ed-btn.primary { background:var(--purple); border-color:var(--purple); color:#fff; box-shadow:0 5px 12px rgba(91,80,230,.17); }
.ed-btn.primary:hover:not(:disabled) { background:#4a40d6; border-color:#4a40d6; }
.ed-btn.ghost { background:transparent; }
.ed-btn.small { padding:6px 11px; font-size:11.5px; }
.ed-link { display:inline-flex; align-items:center; gap:4px; padding:4px 0; border:0; background:none; color:var(--purple); font-size:11.5px; font-weight:600; cursor:pointer; }
.ed-link:hover { text-decoration:underline; }
.ed-iconbtn { display:inline-flex; align-items:center; justify-content:center; gap:4px; min-width:26px; height:26px; padding:0 5px; border:0; border-radius:6px; background:none; color:var(--muted); cursor:pointer; flex-shrink:0; }
.ed-iconbtn:hover:not(:disabled) { background:#eef0f5; color:var(--text); }
.ed-iconbtn:disabled { opacity:.3; cursor:not-allowed; }
.ed-iconbtn.danger:hover:not(:disabled), .ed-iconbtn.danger.armed { background:#fdeceb; color:#b3261e; }
.ed-iconbtn.armed span { font-size:11px; font-weight:700; }
.ed-chip { border:1px solid var(--border); background:var(--surface); border-radius:10px; padding:2px 9px; font-size:10.5px; font-weight:600; color:var(--muted); cursor:pointer; }
.ed-chip.on { background:#eeecfd; border-color:#d9d5fb; color:#4a40d6; }

.ed-body { flex:1; min-height:0; display:flex; }
.ed-rail { width:236px; flex-shrink:0; overflow-y:auto; padding:16px 12px 30px; background:var(--surface); border-right:1px solid var(--border); }
.ed-rail-section { margin-bottom:18px; }
.ed-rail-title { display:flex; align-items:center; gap:7px; padding:0 8px 7px; font-size:10.5px; font-weight:700; letter-spacing:.6px; text-transform:uppercase; color:var(--muted); }
.ed-rail-item { display:flex; align-items:center; width:100%; border-radius:8px; border:0; background:none; text-align:left; }
.ed-rail-item > button:first-child { flex:1; min-width:0; display:block; padding:7px 9px; border:0; background:none; text-align:left; cursor:pointer; border-radius:8px; }
.ed-rail-item span { display:flex; align-items:center; gap:6px; font-size:12.5px; font-weight:600; }
.ed-rail-item small { display:block; font-size:10.5px; color:var(--muted); margin-top:1px; }
.ed-rail-item small em { font-style:normal; color:#b47a16; }
.ed-rail-item:hover { background:#f4f5fa; }
.ed-rail-item.on { background:#eeecfd; }
.ed-rail-item.on span { color:#4a40d6; }
.ed-rail-item.settings { padding:6px 9px; cursor:pointer; }
.ed-rail-item.settings span { font-size:11.5px; font-weight:500; color:var(--muted); }
.ed-rail-add { display:flex; align-items:center; gap:5px; width:100%; padding:6px 9px; border:0; background:none; color:var(--purple); font-size:11.5px; font-weight:600; cursor:pointer; border-radius:8px; }
.ed-rail-add:hover { background:#f4f5fa; }

.ed-main { flex:1; min-width:0; overflow-y:auto; padding:24px 28px 80px; }
.ed-column { max-width:860px; margin:0 auto; display:flex; flex-direction:column; gap:14px; }
.ed-heading { margin:0 0 2px; font-size:19px; letter-spacing:-.3px; }
.ed-card, .ed-q { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:16px 18px; display:flex; flex-direction:column; gap:12px; }
.ed-card h4, .ed-list-head h4 { margin:0; font-size:13px; }
.ed-list-head { display:flex; align-items:center; justify-content:space-between; margin-top:8px; }
.ed-list-head em { font-style:normal; font-weight:500; color:var(--muted); margin-left:6px; font-size:11.5px; }
.ed-field { display:flex; flex-direction:column; gap:5px; min-width:0; }
.ed-field.grow { flex:1; }
.ed-label { display:block; font-size:11px; font-weight:700; color:#4b536b; }
.ed-label em { font-style:normal; font-weight:400; color:var(--muted); margin-left:6px; }
.ed-input { width:100%; padding:8px 10px; border:1.5px solid var(--border); border-radius:8px; background:var(--surface); font-size:12.5px; line-height:1.55; transition:border-color .15s ease, box-shadow .15s ease; }
textarea.ed-input { resize:none; overflow:hidden; display:block; }
.ed-input:focus { outline:none; border-color:var(--purple); box-shadow:0 0 0 3px rgba(91,80,230,.1); }
.ed-input:disabled { background:#f6f7fa; color:#6f7890; }
.ed-input.narrow { width:110px; flex:0 0 auto; }
.ed-input.answer { border-color:#bfe3ca; background:#f6fbf7; color:var(--green); font-weight:600; }
.ed-hint { margin:0; font-size:11.5px; line-height:1.55; color:var(--muted); }
.ed-row { display:flex; align-items:center; flex-wrap:wrap; gap:14px; }
.ed-row.spread { justify-content:space-between; }
.ed-danger-zone { display:inline-flex; align-items:center; gap:6px; font-size:11.5px; color:var(--muted); }
.ed-check { display:inline-flex; align-items:center; gap:7px; font-size:11.5px; color:#4b536b; cursor:pointer; }
.ed-seg { display:inline-flex; border:1.5px solid var(--border); border-radius:8px; overflow:hidden; }
.ed-seg button { border:0; background:var(--surface); padding:7px 13px; font-size:11.5px; font-weight:600; color:var(--muted); cursor:pointer; }
.ed-seg button + button { border-left:1.5px solid var(--border); }
.ed-seg button.on { background:var(--green-bg); color:var(--green); }
.ed-seg.small button { padding:4px 10px; font-size:11px; }
.ed-seg.small button.on { background:#eeecfd; color:#4a40d6; }

.ed-q-head { display:flex; align-items:center; gap:9px; }
.ed-q-n { width:52px; flex-shrink:0; padding:5px 6px; border:1.5px solid var(--border); border-radius:7px; background:#f4f5fa; font-size:12px; font-weight:700; text-align:center; }
.ed-q-n.wide { width:auto; min-width:34px; padding:5px 9px; display:inline-block; }
.ed-q-n.muted { font-weight:500; color:var(--muted); font-size:10.5px; }
.ed-q-n:focus { outline:none; border-color:var(--purple); }
.ed-q-type { font-size:11.5px; font-weight:600; color:var(--muted); }
.ed-q-tools { margin-left:auto; display:flex; align-items:center; gap:1px; }
.ed-group { display:grid; grid-template-columns:200px 1fr; gap:12px; padding:12px; background:#faf9ff; border:1px dashed #d9d5fb; border-radius:9px; }
.ed-gap { display:grid; grid-template-columns:1fr auto 1fr; align-items:center; gap:8px; }
.ed-blank { padding:4px 10px; border:1.5px dashed #bfe3ca; border-radius:7px; background:#f6fbf7; color:var(--green); font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.4px; white-space:nowrap; }
.ed-options { display:flex; flex-direction:column; gap:6px; }
.ed-option { display:flex; align-items:center; gap:8px; }
.ed-option input[type=radio] { accent-color:var(--green); width:15px; height:15px; flex-shrink:0; }
.ed-letter { width:16px; font-size:11.5px; font-weight:700; color:var(--muted); flex-shrink:0; }
.ed-line { display:flex; align-items:center; gap:7px; }
.ed-add { display:flex; flex-wrap:wrap; gap:8px; padding:4px 0 8px; }

.ed-media { border:1.5px dashed #d5d9e6; border-radius:10px; padding:10px 12px; display:flex; flex-direction:column; gap:10px; }
.ed-media.filled { border-style:solid; border-color:#cfe8d8; background:#f9fcfa; }
.ed-media-row { display:flex; align-items:center; gap:9px; }
.ed-media-icon { width:28px; height:28px; display:flex; align-items:center; justify-content:center; border-radius:7px; background:#eeecfd; color:var(--purple); flex-shrink:0; }
.ed-media.filled .ed-media-icon { background:var(--green-bg); color:var(--green); }
.ed-media-text { flex:1; min-width:0; font-size:11.5px; color:var(--muted); }
.ed-media-error { color:#b3261e; font-size:11.5px; }
.ed-audio { width:100%; height:36px; }
.ed-image { display:block; max-width:100%; max-height:300px; border-radius:8px; border:1px solid var(--border); }

.ed-table-wrap { display:flex; flex-direction:column; gap:8px; overflow-x:auto; }
.ed-table { border-collapse:separate; border-spacing:6px; margin:-6px; }
.ed-table th, .ed-table td { vertical-align:top; min-width:150px; text-align:left; font-weight:400; }
.ed-table td.blank .ed-input { min-width:0; }
.ed-cell-blank { display:flex; gap:5px; }
.ed-cell-toggle { border:0; background:none; padding:2px 0 0; font-size:10px; font-weight:600; color:var(--muted); cursor:pointer; }
.ed-cell-toggle:hover { color:var(--purple); }
.ed-table-tool { min-width:0 !important; width:30px; }

.ed-map { display:flex; flex-direction:column; gap:9px; }
.ed-map-stage { position:relative; align-self:flex-start; max-width:100%; cursor:crosshair; border:1px solid var(--border); border-radius:8px; overflow:hidden; }
.ed-map-stage img { display:block; max-width:100%; max-height:420px; }
.ed-pin { position:absolute; transform:translate(-50%,-50%); min-width:22px; height:22px; padding:0 5px; display:flex; align-items:center; justify-content:center; border-radius:11px; background:#111d40; color:#fff; font-size:11px; font-weight:700; border:2px solid #fff; pointer-events:none; }
.ed-pin.on { background:var(--purple); }
.ed-point { display:flex; align-items:center; gap:7px; padding:4px; border-radius:8px; cursor:pointer; }
.ed-point.on { background:#eeecfd; }

.ed-banner { display:flex; align-items:center; gap:8px; padding:11px 14px; border-radius:10px; background:#fff6e5; border:1px solid #f5deac; color:#8a5a00; font-size:12.5px; }
.ed-errors { position:sticky; top:0; z-index:5; box-shadow:0 6px 16px rgba(17,29,64,.08); padding:12px 40px 12px 14px; border-radius:10px; background:#fdeceb; color:#b3261e; font-size:12.5px; }
.ed-errors strong { display:flex; align-items:center; gap:7px; }
.ed-errors ul { margin:8px 0 0; padding-left:20px; font-size:11.5px; line-height:1.7; max-height:160px; overflow-y:auto; }
.ed-errors .ed-iconbtn { position:absolute; top:8px; right:8px; color:#b3261e; }

@media (max-width: 860px) {
  .ed-rail { width:176px; }
  .ed-main { padding:16px 14px 60px; }
  .ed-group, .ed-gap { grid-template-columns:1fr; }
  .ed-top { flex-wrap:wrap; }
  .ed-line { flex-wrap:wrap; }
}
`;
