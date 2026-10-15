import React, { useEffect, useRef, useState } from "react";
import { X, Sparkles, Loader2, Check, AlertTriangle, ChevronDown, ChevronUp, Save, Send, SpellCheck, Trash2, Pencil, ExternalLink, MessageSquarePlus } from "lucide-react";
import { adminFetch } from "../../lib/adminApi";
import AnnotatedEssay, { CATEGORIES, CATEGORY_KEYS, numberAnnotations } from "../shared/AnnotatedEssay";

/**
 * WritingMarking.jsx — the teacher marks a student's IELTS Writing (and
 * enters their Speaking band) after the test, and sends it back to them.
 *
 * For each task: the essay, which the teacher annotates by selecting words
 * (a comment, a category, optionally a correction), with an AI grammar
 * check that drafts annotations for the teacher to accept or dismiss
 * (POST /api/sessions/:id/writing/grammar). Beside it, four criterion
 * bands, optionally starting from an AI suggestion with a reason for each
 * band. The task band, the Writing band and the overall band are worked
 * out as they go (same rules as backend/src/services/ieltsBands.js), and
 * any of the task bands can be overridden.
 *
 * Saving (PUT /api/sessions/:id/marks) stores the marks and accepted
 * annotations on the student's results and fills in their Google Sheet
 * row. "Save and send" then emails the student a link to their marked
 * essays (POST /api/sessions/:id/feedback/send → pages/feedback/[token]).
 * AI suggestions not accepted are never saved, so never reach the student.
 *
 * Rendered inside AdminDashboard's .ad-root, so it uses that file's tokens
 * and .ad-* classes; only the wm-* classes are defined here.
 */

const CRITERIA = [
  ["task", "Task Achievement", "Task Response"],
  ["coherence", "Coherence and Cohesion"],
  ["lexical", "Lexical Resource"],
  ["grammar", "Grammatical Range and Accuracy"],
];
const WHOLE = Array.from({ length: 10 }, (_, i) => i);
const HALF = Array.from({ length: 19 }, (_, i) => i / 2);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const toHalf = (v) => Math.round(v * 2) / 2;
const isBand = (v) => typeof v === "number" && Number.isFinite(v);
function taskBandOf(criteria) {
  const values = CRITERIA.map(([c]) => criteria[c]);
  return values.every(isBand) ? toHalf(values.reduce((a, b) => a + b, 0) / 4) : null;
}
function writingBandOf(t1, t2) {
  if (isBand(t1) && isBand(t2)) return toHalf((t1 + 2 * t2) / 3);
  return isBand(t2) ? t2 : isBand(t1) ? t1 : null;
}
const show = (v) => (isBand(v) ? v.toFixed(1) : "—");
const overlaps = (list, start, end, exceptId) => list.some((a) => a.id !== exceptId && start < a.end && a.start < end);
const newId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export default function WritingMarking({ sessionId, data, onClose, onSaved }) {
  const saved = data.marks?.writing?.tasks || [];
  const [tasks, setTasks] = useState(() =>
    data.tasks.map((t) => {
      const prev = saved.find((s) => s?.id === t.id);
      return {
        criteria: { ...(prev?.criteria || {}) },
        override: prev && prev.band !== taskBandOf(prev.criteria || {}) ? prev.band : null,
        feedback: prev?.feedback || "",
        annotations: prev?.annotations || [],
        suggestions: [], // AI grammar check, not yet accepted
        suggestion: null, // AI band suggestion
        suggesting: false,
        checking: false,
        error: "",
        promptOpen: false,
      };
    })
  );
  const [speaking, setSpeaking] = useState(data.marks?.speaking?.band ?? null);
  const [email, setEmail] = useState(data.studentEmail || "");
  const [delivery, setDelivery] = useState({ sentAt: data.feedbackSentAt || null, url: data.feedbackUrl || null });
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [saveState, setSaveState] = useState(null); // { ok, message }
  const [composer, setComposer] = useState(null); // { task, start, end, top, left, editId?, category, comment, correction, error }
  const [active, setActive] = useState(null); // { task, id }

  const setTask = (i, patch) => setTasks((prev) => prev.map((t, j) => (j === i ? { ...t, ...(typeof patch === "function" ? patch(t) : patch) } : t)));
  const bandOf = (t) => (isBand(t.override) ? t.override : taskBandOf(t.criteria));
  const writing = writingBandOf(bandOf(tasks[0] || { criteria: {} }), tasks[1] ? bandOf(tasks[1]) : null);
  const overall = [data.reading, data.listening, writing, speaking].every(isBand)
    ? toHalf((data.reading + data.listening + writing + speaking) / 4)
    : null;
  const pendingSuggestions = tasks.reduce((n, t) => n + t.suggestions.length, 0);

  const suggest = async (i) => {
    setTask(i, { suggesting: true, error: "" });
    try {
      const s = await adminFetch(`/api/sessions/${sessionId}/writing/assess`, { method: "POST", body: JSON.stringify({ taskId: data.tasks[i].id }) });
      setTask(i, (t) => ({
        suggesting: false,
        suggestion: s,
        criteria: { ...s.criteria },
        override: null,
        feedback: t.feedback || [...(s.strengths || []).map((x) => `+ ${x}`), ...(s.improvements || []).map((x) => `- ${x}`)].join("\n"),
      }));
    } catch (e) {
      setTask(i, { suggesting: false, error: e.message });
    }
  };

  const checkGrammar = async (i) => {
    setTask(i, { checking: true, error: "" });
    try {
      const taken = tasks[i].annotations.map(({ start, end }) => ({ start, end }));
      const res = await adminFetch(`/api/sessions/${sessionId}/writing/grammar`, { method: "POST", body: JSON.stringify({ taskId: data.tasks[i].id, taken }) });
      setTask(i, (t) => ({
        checking: false,
        suggestions: res.annotations.filter((a) => !overlaps(t.annotations, a.start, a.end)),
        error: res.annotations.length ? "" : "The grammar check found nothing to flag.",
      }));
    } catch (e) {
      setTask(i, { checking: false, error: e.message });
    }
  };

  const acceptSuggestion = (i, id) => setTask(i, (t) => {
    const s = t.suggestions.find((a) => a.id === id);
    return { suggestions: t.suggestions.filter((a) => a.id !== id), annotations: s ? [...t.annotations, s] : t.annotations };
  });
  const dismissSuggestion = (i, id) => setTask(i, (t) => ({ suggestions: t.suggestions.filter((a) => a.id !== id) }));
  const acceptAll = (i) => setTask(i, (t) => ({ annotations: [...t.annotations, ...t.suggestions], suggestions: [] }));
  const deleteAnnotation = (i, id) => setTask(i, (t) => ({ annotations: t.annotations.filter((a) => a.id !== id) }));

  // Selecting words in an essay opens the composer under the selection.
  const essayWraps = useRef([]);
  const openComposer = (i, { start, end, rect }) => {
    const wrap = essayWraps.current[i]?.getBoundingClientRect();
    if (!wrap) return;
    const all = [...tasks[i].annotations, ...tasks[i].suggestions];
    const hit = all.find((a) => start < a.end && a.start < end);
    const top = rect.bottom - wrap.top + 8;
    const left = Math.max(0, Math.min(rect.left - wrap.left, wrap.width - 340));
    if (hit) {
      setComposer({ task: i, start, end, top, left, error: "These words already have a comment — select different words, or edit that one below." });
      return;
    }
    setComposer({ task: i, start, end, top, left, category: "grammar", comment: "", correction: "", error: "" });
  };
  const editAnnotation = (i, a) => {
    const el = typeof document !== "undefined" && document.getElementById(`ae-mark-${a.id}`);
    const wrap = essayWraps.current[i]?.getBoundingClientRect();
    const rect = el?.getBoundingClientRect();
    setComposer({
      task: i, start: a.start, end: a.end, editId: a.id,
      top: rect && wrap ? rect.bottom - wrap.top + 8 : 0,
      left: rect && wrap ? Math.max(0, Math.min(rect.left - wrap.left, wrap.width - 340)) : 0,
      category: a.category, comment: a.comment, correction: a.correction, error: "",
    });
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const commitComposer = () => {
    const c = composer;
    if (!c || c.category === undefined) return setComposer(null);
    if (!c.comment.trim() && !c.correction.trim()) return setComposer({ ...c, error: "Write a comment or a correction." });
    const text = data.tasks[c.task].text;
    const item = { id: c.editId || newId(), start: c.start, end: c.end, quote: text.slice(c.start, c.end), category: c.category, comment: c.comment.trim(), correction: c.category === "good" ? "" : c.correction.trim() };
    setTask(c.task, (t) => ({ annotations: c.editId ? t.annotations.map((a) => (a.id === c.editId ? item : a)) : [...t.annotations, item] }));
    setActive({ task: c.task, id: item.id });
    setComposer(null);
    window.getSelection()?.removeAllRanges();
  };
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && setComposer(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pick = (i, id) => {
    setActive({ task: i, id });
    document.getElementById(`wm-note-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const save = async () => {
    setSaving(true);
    setSaveState(null);
    try {
      const body = {
        tasks: data.tasks.map((t, i) => ({
          id: t.id,
          criteria: tasks[i].criteria,
          band: isBand(tasks[i].override) ? tasks[i].override : null,
          feedback: tasks[i].feedback,
          annotations: tasks[i].annotations,
        })),
        speakingBand: speaking,
      };
      const res = await adminFetch(`/api/sessions/${sessionId}/marks`, { method: "PUT", body: JSON.stringify(body) });
      const unreviewed = pendingSuggestions ? ` ${pendingSuggestions} AI suggestion${pendingSuggestions === 1 ? "" : "s"} you haven't accepted weren't included.` : "";
      setSaveState({
        ok: !res.sheet.startsWith("failed"),
        message: (res.sheet === "updated" ? "Saved, and the student's row in the Google Sheet is updated."
          : res.sheet === "none" ? "Saved."
          : `Saved here, but the Google Sheet couldn't be updated: ${res.sheet.slice(8)}`) + unreviewed,
      });
      onSaved && onSaved(res.results);
      return true;
    } catch (e) {
      setSaveState({ ok: false, message: e.message });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveAndSend = async () => {
    if (!EMAIL_RE.test(email.trim())) {
      setSaveState({ ok: false, message: "Enter the student's email address to send their marked writing." });
      return;
    }
    if (!(await save())) return;
    setSending(true);
    try {
      const res = await adminFetch(`/api/sessions/${sessionId}/feedback/send`, { method: "POST", body: JSON.stringify({ email: email.trim() }) });
      setDelivery({ sentAt: res.feedbackSentAt, url: res.feedbackUrl });
      setEmail(res.email);
      setSaveState({ ok: true, message: `Saved and sent to ${res.email}.` });
      onSaved && onSaved(undefined, { studentEmail: res.email, feedbackSentAt: res.feedbackSentAt });
    } catch (e) {
      setSaveState({ ok: false, message: `Saved, but not sent: ${e.message}` });
    } finally {
      setSending(false);
    }
  };

  const openStudentPage = async () => {
    // Opened before the request so the browser doesn't treat it as a pop-up.
    const win = window.open("", "_blank");
    try {
      if (!(await save())) { win?.close(); return; }
      const res = await adminFetch(`/api/sessions/${sessionId}/feedback/link`, { method: "POST" });
      setDelivery((d) => ({ ...d, url: res.feedbackUrl }));
      if (win) win.location.href = res.feedbackUrl;
    } catch (e) {
      win?.close();
      setSaveState({ ok: false, message: e.message });
    }
  };

  return (
    <div className="ad-modal-overlay" onMouseDown={onClose}>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="ad-modal wm-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ad-modal-head">
          <h2>{data.fullName} — Writing and Speaking</h2>
          <button className="ad-iconbtn" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="wm-summary">
          {[["Reading", data.reading], ["Listening", data.listening], ["Writing", writing], ["Speaking", speaking], ["Overall", overall]].map(([label, value]) => (
            <div key={label} className={`wm-chip ${label === "Overall" ? "strong" : ""}`}><span>{label}</span><strong>{show(value)}</strong></div>
          ))}
        </div>

        <div className="ad-modal-body wm-body" onMouseDown={() => composer && composer.category === undefined && setComposer(null)}>
          {data.tasks.length === 0 && <p className="ad-sub">This exam has no writing section.</p>}
          {data.tasks.map((t, i) => {
            const state = tasks[i];
            const short = t.minWords && t.words < t.minWords;
            const shown = numberAnnotations([...state.annotations, ...state.suggestions.map((a) => ({ ...a, suggested: true }))]);
            return (
              <section className="wm-task" key={t.id}>
                <div className="wm-essay">
                  <div className="wm-task-head">
                    <h3>Task {i + 1}</h3>
                    <span className={`wm-words ${short ? "short" : ""}`}>{t.words} words{t.minWords ? ` · minimum ${t.minWords}` : ""}</span>
                  </div>
                  <button className="wm-prompt-toggle" onClick={() => setTask(i, { promptOpen: !state.promptOpen })}>
                    {state.promptOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />} The task
                  </button>
                  {state.promptOpen && (
                    <div className="wm-prompt">
                      {t.prompt}
                      {t.chartImageUrl && <img src={t.chartImageUrl} alt="Chart for this task" />}
                    </div>
                  )}

                  {t.text ? (
                    <>
                      <div className="wm-tools">
                        <button className="ad-btn ghost small" onClick={() => checkGrammar(i)} disabled={state.checking}>
                          {state.checking ? <Loader2 size={13} className="spin-icon" /> : <SpellCheck size={13} />}
                          {state.checking ? "Checking the language — can take a few minutes…" : "Check grammar with AI"}
                        </button>
                        <span className="wm-hint"><MessageSquarePlus size={13} /> Select words in the essay to comment on them</span>
                      </div>
                      {state.suggestions.length > 0 && (
                        <div className="wm-suggest-bar">
                          <span><Sparkles size={13} /> {state.suggestions.length} AI suggestion{state.suggestions.length === 1 ? "" : "s"} (dashed) — accept the ones you agree with</span>
                          <button className="ad-btn ghost small" onClick={() => acceptAll(i)}><Check size={13} /> Accept all</button>
                          <button className="ad-btn ghost small" onClick={() => setTask(i, { suggestions: [] })}>Dismiss all</button>
                        </div>
                      )}
                      <div className="wm-essay-wrap" ref={(el) => { essayWraps.current[i] = el; }}>
                        <AnnotatedEssay
                          className="wm-text"
                          text={t.text}
                          annotations={shown}
                          activeId={active?.task === i ? active.id : null}
                          onPick={(id) => pick(i, id)}
                          onSelect={(range) => openComposer(i, range)}
                        />
                        {composer?.task === i && (
                          <Composer composer={composer} quote={t.text.slice(composer.start, composer.end)} onChange={setComposer} onSave={commitComposer} onCancel={() => setComposer(null)} />
                        )}
                      </div>
                      {shown.length > 0 && (
                        <ol className="wm-notes">
                          {shown.map((a) => {
                            const cat = CATEGORIES[a.category] || CATEGORIES.grammar;
                            return (
                              <li key={a.id} id={`wm-note-${a.id}`} className={`wm-note ${a.suggested ? "suggested" : ""} ${active?.task === i && active.id === a.id ? "active" : ""}`}
                                style={{ "--ae-c": cat.color, "--ae-soft": cat.soft }}
                                onClick={() => { setActive({ task: i, id: a.id }); document.getElementById(`ae-mark-${a.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }}>
                                <span className="wm-note-n">{a.n}</span>
                                <div className="wm-note-body">
                                  <div className="wm-note-head">
                                    <span className="wm-cat">{cat.label}</span>
                                    {a.suggested && <span className="wm-ai">AI</span>}
                                  </div>
                                  <div className="wm-note-fix">
                                    <span className={a.correction ? "wrong" : ""}>{a.quote}</span>
                                    {a.correction && <> → <strong>{a.correction}</strong></>}
                                  </div>
                                  {a.comment && <p>{a.comment}</p>}
                                </div>
                                <div className="wm-note-actions" onClick={(e) => e.stopPropagation()}>
                                  {a.suggested ? (
                                    <>
                                      <button className="ad-iconbtn" title="Accept" onClick={() => acceptSuggestion(i, a.id)}><Check size={15} /></button>
                                      <button className="ad-iconbtn" title="Dismiss" onClick={() => dismissSuggestion(i, a.id)}><X size={15} /></button>
                                    </>
                                  ) : (
                                    <>
                                      <button className="ad-iconbtn" title="Edit" onClick={() => editAnnotation(i, a)}><Pencil size={14} /></button>
                                      <button className="ad-iconbtn" title="Delete" onClick={() => deleteAnnotation(i, a.id)}><Trash2 size={14} /></button>
                                    </>
                                  )}
                                </div>
                              </li>
                            );
                          })}
                        </ol>
                      )}
                    </>
                  ) : (
                    <div className="wm-text"><span className="ad-muted">Nothing written for this task.</span></div>
                  )}
                </div>

                <div className="wm-marks">
                  <button className="ad-btn ghost small wm-suggest" onClick={() => suggest(i)} disabled={state.suggesting || !t.text}>
                    {state.suggesting ? <Loader2 size={13} className="spin-icon" /> : <Sparkles size={13} />}
                    {state.suggesting ? "Reading the answer — up to a minute or two…" : state.suggestion ? "Suggest again" : "Suggest bands with AI"}
                  </button>
                  {state.error && <div className="wm-error"><AlertTriangle size={13} /> {state.error}</div>}

                  {CRITERIA.map(([key, name, name2]) => (
                    <div className="wm-criterion" key={key}>
                      <label>
                        <span>{i === 1 && name2 ? name2 : name}</span>
                        <select className="ad-input wm-select" value={isBand(state.criteria[key]) ? state.criteria[key] : ""}
                          onChange={(e) => setTask(i, { criteria: { ...state.criteria, [key]: e.target.value === "" ? undefined : Number(e.target.value) } })}>
                          <option value="">—</option>
                          {WHOLE.map((b) => <option key={b} value={b}>{b}</option>)}
                        </select>
                      </label>
                      {state.suggestion?.notes?.[key] && <p className="wm-reason">{state.suggestion.notes[key]}</p>}
                    </div>
                  ))}

                  <div className="wm-band-row">
                    <span>Task band</span>
                    <select className="ad-input wm-select" value={isBand(state.override) ? state.override : "auto"}
                      onChange={(e) => setTask(i, { override: e.target.value === "auto" ? null : Number(e.target.value) })}>
                      <option value="auto">{show(taskBandOf(state.criteria))} (average)</option>
                      {HALF.map((b) => <option key={b} value={b}>{b.toFixed(1)}</option>)}
                    </select>
                  </div>

                  <label className="wm-feedback">
                    <span>Feedback for the student</span>
                    <textarea className="ad-input" rows={5} value={state.feedback} onChange={(e) => setTask(i, { feedback: e.target.value })} placeholder="What went well, what to work on" />
                  </label>
                </div>
              </section>
            );
          })}

          <div className="wm-bottom">
            <section className="wm-speaking">
              <label>
                <span>Speaking band <em>from your speaking test</em></span>
                <select className="ad-input wm-select" value={isBand(speaking) ? speaking : ""} onChange={(e) => setSpeaking(e.target.value === "" ? null : Number(e.target.value))}>
                  <option value="">Not marked yet</option>
                  {HALF.map((b) => <option key={b} value={b}>{b.toFixed(1)}</option>)}
                </select>
              </label>
              <p className="ad-hint">Task bands are the average of the four criteria and the Writing band counts Task 2 twice; the overall band is the average of the four skills, to the nearest half band. AI suggestions are a second opinion, not the mark.</p>
            </section>

            <section className="wm-deliver">
              <label>
                <span>Student's email</span>
                <input className="ad-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="student@example.com" />
              </label>
              <p className="ad-hint">
                {delivery.sentAt ? <>Sent {new Date(delivery.sentAt).toLocaleString()}. Sending again sends the latest marks to the same link. </> : "The student gets a link to their essays with your notes, bands and feedback. "}
                <button className="wm-link" onClick={openStudentPage} disabled={saving || data.tasks.length === 0}><ExternalLink size={12} /> Open the student's page</button>
              </p>
            </section>
          </div>
        </div>

        <div className="ad-modal-footer wm-footer">
          {saveState && <span className={`wm-save-state ${saveState.ok ? "ok" : "bad"}`}>{saveState.ok ? <Check size={13} /> : <AlertTriangle size={13} />} {saveState.message}</span>}
          <button className="ad-btn ghost" onClick={onClose}>Close</button>
          <button className="ad-btn ghost" onClick={save} disabled={saving || sending || data.tasks.length === 0}>
            {saving && !sending ? <Loader2 size={15} className="spin-icon" /> : <Save size={15} />} Save marks
          </button>
          <button className="ad-btn primary" onClick={saveAndSend} disabled={saving || sending || data.tasks.length === 0}>
            {sending ? <Loader2 size={15} className="spin-icon" /> : <Send size={15} />} {delivery.sentAt ? "Save and send again" : "Save and send to student"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Composer({ composer, quote, onChange, onSave, onCancel }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, [composer.start, composer.end]);
  const c = composer;
  const set = (patch) => onChange({ ...c, ...patch, error: "" });
  return (
    <div className="wm-composer" style={{ top: c.top, left: c.left }} onMouseDown={(e) => e.stopPropagation()} onMouseUp={(e) => e.stopPropagation()}>
      {c.category === undefined ? (
        <div className="wm-composer-msg"><AlertTriangle size={13} /> {c.error}<button className="ad-iconbtn" onClick={onCancel}><X size={14} /></button></div>
      ) : (
        <>
          <div className="wm-composer-quote">“{quote.length > 80 ? `${quote.slice(0, 80)}…` : quote}”</div>
          <div className="wm-cats">
            {CATEGORY_KEYS.map((k) => (
              <button key={k} className={`wm-cat-btn ${c.category === k ? "on" : ""}`} style={{ "--ae-c": CATEGORIES[k].color, "--ae-soft": CATEGORIES[k].soft }} onClick={() => set({ category: k })}>
                {CATEGORIES[k].label}
              </button>
            ))}
          </div>
          {c.category !== "good" && (
            <input className="ad-input" placeholder="Correction (optional)" value={c.correction} onChange={(e) => set({ correction: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && onSave()} />
          )}
          <textarea ref={ref} className="ad-input" rows={2} placeholder={c.category === "good" ? "What's good here" : "Comment for the student"} value={c.comment}
            onChange={(e) => set({ comment: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSave(); }} />
          {c.error && <div className="wm-error"><AlertTriangle size={13} /> {c.error}</div>}
          <div className="wm-composer-actions">
            <button className="ad-btn ghost small" onClick={onCancel}>Cancel</button>
            <button className="ad-btn primary small" onClick={onSave}>{c.editId ? "Update" : "Add comment"}</button>
          </div>
        </>
      )}
    </div>
  );
}

const CSS = `
.wm-modal { width:1180px; max-width:96vw; max-height:94vh; }
.wm-summary { display:flex; flex-wrap:wrap; gap:8px; padding:12px 20px; border-bottom:1px solid #eee; background:#fafbfe; }
.wm-chip { display:flex; flex-direction:column; min-width:88px; padding:7px 12px; border:1px solid var(--ad-border); border-radius:9px; background:#fff; }
.wm-chip span { font-size:10px; font-weight:700; letter-spacing:.4px; text-transform:uppercase; color:var(--ad-muted); }
.wm-chip strong { font-size:17px; }
.wm-chip.strong { border-color:#d9d5fb; background:#eeecfd; }
.wm-chip.strong strong { color:#4a40d6; }
.wm-body { display:flex; flex-direction:column; gap:18px; }
.wm-task { display:grid; grid-template-columns:minmax(0,1fr) 320px; gap:20px; padding-bottom:20px; border-bottom:1px solid var(--ad-border); }
.wm-task-head { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
.wm-task-head h3 { margin:0; font-size:15px; }
.wm-words { font-size:11.5px; color:var(--ad-muted); }
.wm-words.short { color:#b3261e; font-weight:600; }
.wm-prompt-toggle { display:inline-flex; align-items:center; gap:4px; margin:6px 0; padding:0; border:0; background:none; font:inherit; font-size:11.5px; font-weight:600; color:var(--ad-purple); cursor:pointer; }
.wm-prompt { margin:0 0 8px; padding:9px 12px; border-radius:8px; background:#faf9ff; font-size:12.5px; line-height:1.6; white-space:pre-wrap; }
.wm-prompt img { display:block; max-width:100%; max-height:320px; margin:10px auto 0; }
.wm-tools { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin:4px 0 8px; }
.wm-hint { display:inline-flex; align-items:center; gap:5px; font-size:11.5px; color:var(--ad-muted); }
.wm-suggest-bar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-bottom:8px; padding:7px 10px; border-radius:8px; background:#f4f2ff; font-size:12px; color:#4a40d6; }
.wm-suggest-bar span { display:inline-flex; align-items:center; gap:6px; margin-right:auto; }
.wm-essay-wrap { position:relative; }
.wm-text { background:#fff; border:1px solid #e7e8f2; border-radius:9px; padding:14px 16px; font-size:14px; line-height:2; }
.wm-composer { position:absolute; z-index:5; width:340px; max-width:100%; display:flex; flex-direction:column; gap:8px; padding:12px; background:#fff; border:1px solid var(--ad-border); border-radius:11px; box-shadow:0 14px 40px rgba(17,29,64,.16); }
.wm-composer-quote { font-size:12px; color:var(--ad-muted); font-style:italic; }
.wm-composer-msg { display:flex; align-items:center; gap:6px; font-size:12px; color:#b3261e; }
.wm-composer-msg .ad-iconbtn { margin-left:auto; }
.wm-composer textarea, .wm-composer input { font-family:inherit; font-size:12.5px; }
.wm-composer textarea { resize:vertical; }
.wm-composer-actions { display:flex; justify-content:flex-end; gap:6px; }
.wm-cats { display:flex; flex-wrap:wrap; gap:5px; }
.wm-cat-btn { padding:4px 9px; border-radius:20px; border:1.5px solid var(--ae-soft); background:#fff; color:var(--ae-c); font:inherit; font-size:11.5px; font-weight:600; cursor:pointer; }
.wm-cat-btn.on { background:var(--ae-c); border-color:var(--ae-c); color:#fff; }
.wm-notes { list-style:none; margin:10px 0 0; padding:0; display:flex; flex-direction:column; gap:6px; }
.wm-note { display:flex; gap:10px; align-items:flex-start; padding:9px 10px; border:1px solid var(--ad-border); border-left:3px solid var(--ae-c); border-radius:8px; background:#fff; cursor:pointer; font-size:12.5px; }
.wm-note.suggested { border-style:dashed; border-left-style:solid; background:#fcfcff; }
.wm-note.active { box-shadow:0 0 0 2px var(--ae-soft); border-color:var(--ae-c); }
.wm-note-n { flex-shrink:0; min-width:20px; height:20px; padding:0 5px; border-radius:10px; background:var(--ae-c); color:#fff; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; }
.wm-note.suggested .wm-note-n { background:#fff; color:var(--ae-c); box-shadow:inset 0 0 0 1px var(--ae-c); }
.wm-note-body { flex:1; min-width:0; }
.wm-note-head { display:flex; gap:6px; align-items:center; margin-bottom:2px; }
.wm-cat { font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.4px; color:var(--ae-c); }
.wm-ai { font-size:9.5px; font-weight:700; padding:1px 5px; border-radius:4px; background:#eeecfd; color:#4a40d6; }
.wm-note-fix .wrong { text-decoration:line-through; color:var(--ad-muted); }
.wm-note-fix strong { color:#17803d; }
.wm-note-body p { margin:3px 0 0; color:#3d4358; line-height:1.5; }
.wm-note-actions { display:flex; gap:2px; flex-shrink:0; }
.wm-marks { display:flex; flex-direction:column; gap:10px; }
.wm-suggest { justify-content:center; }
.wm-criterion label, .wm-band-row, .wm-speaking label { display:flex; align-items:center; justify-content:space-between; gap:10px; font-size:12px; font-weight:600; }
.wm-select { width:auto; min-width:84px; padding:6px 8px; }
.wm-reason { margin:4px 0 0; font-size:11.5px; line-height:1.5; color:var(--ad-muted); }
.wm-band-row { padding-top:8px; border-top:1px dashed var(--ad-border); }
.wm-feedback { display:flex; flex-direction:column; gap:5px; font-size:12px; font-weight:600; }
.wm-feedback textarea { font-family:inherit; font-size:12.5px; line-height:1.55; resize:vertical; }
.wm-error { display:flex; gap:6px; align-items:flex-start; font-size:11.5px; color:#b3261e; background:#fdeceb; padding:7px 10px; border-radius:7px; }
.wm-bottom { display:grid; grid-template-columns:1fr 1fr; gap:24px; }
.wm-speaking, .wm-deliver { display:flex; flex-direction:column; gap:8px; }
.wm-speaking em { font-style:normal; font-weight:400; color:var(--ad-muted); margin-left:6px; }
.wm-deliver label { display:flex; flex-direction:column; gap:5px; font-size:12px; font-weight:600; }
.wm-link { display:inline-flex; align-items:center; gap:4px; padding:0; border:0; background:none; font:inherit; font-weight:600; color:var(--ad-purple); cursor:pointer; }
.wm-link:disabled { opacity:.5; cursor:default; }
.wm-footer { align-items:center; flex-wrap:wrap; }
.wm-save-state { margin-right:auto; display:inline-flex; align-items:center; gap:6px; font-size:12px; }
.wm-save-state.ok { color:#1e7a34; }
.wm-save-state.bad { color:#b3261e; }
@media (max-width: 860px) { .wm-task, .wm-bottom { grid-template-columns:1fr; } .wm-composer { width:auto; left:0 !important; right:0; } }
`;
