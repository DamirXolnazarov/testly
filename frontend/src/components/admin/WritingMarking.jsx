import React, { useState } from "react";
import { X, Sparkles, Loader2, Check, AlertTriangle, ChevronDown, ChevronUp, Save } from "lucide-react";
import { adminFetch } from "../../lib/adminApi";

/**
 * WritingMarking.jsx — the teacher marks a student's IELTS Writing (and
 * enters their Speaking band) after the test.
 *
 * For each task: the essay beside four criterion bands, which the teacher
 * sets, optionally starting from an AI suggestion with a reason for each
 * band. The task band, the Writing band and the overall band are worked
 * out as they go (same rules as backend/src/services/ieltsBands.js), and
 * any of the task bands can be overridden. Saving (PUT
 * /api/sessions/:id/marks) stores the marks on the student's results and
 * fills in their Google Sheet row.
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

export default function WritingMarking({ sessionId, data, onClose, onSaved }) {
  const saved = data.marks?.writing?.tasks || [];
  const [tasks, setTasks] = useState(() =>
    data.tasks.map((t) => {
      const prev = saved.find((s) => s?.id === t.id);
      return {
        criteria: { ...(prev?.criteria || {}) },
        override: prev && prev.band !== taskBandOf(prev.criteria || {}) ? prev.band : null,
        feedback: prev?.feedback || "",
        suggestion: null,
        suggesting: false,
        error: "",
        promptOpen: false,
      };
    })
  );
  const [speaking, setSpeaking] = useState(data.marks?.speaking?.band ?? null);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState(null); // { ok, message }

  const setTask = (i, patch) => setTasks((prev) => prev.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const bandOf = (t) => (isBand(t.override) ? t.override : taskBandOf(t.criteria));
  const writing = writingBandOf(bandOf(tasks[0] || { criteria: {} }), tasks[1] ? bandOf(tasks[1]) : null);
  const overall = [data.reading, data.listening, writing, speaking].every(isBand)
    ? toHalf((data.reading + data.listening + writing + speaking) / 4)
    : null;

  const suggest = async (i) => {
    setTask(i, { suggesting: true, error: "" });
    try {
      const s = await adminFetch(`/api/sessions/${sessionId}/writing/assess`, { method: "POST", body: JSON.stringify({ taskId: data.tasks[i].id }) });
      setTasks((prev) => prev.map((t, j) => (j === i ? {
        ...t,
        suggesting: false,
        suggestion: s,
        criteria: { ...s.criteria },
        override: null,
        feedback: t.feedback || [...(s.strengths || []).map((x) => `+ ${x}`), ...(s.improvements || []).map((x) => `- ${x}`)].join("\n"),
      } : t)));
    } catch (e) {
      setTask(i, { suggesting: false, error: e.message });
    }
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
        })),
        speakingBand: speaking,
      };
      const res = await adminFetch(`/api/sessions/${sessionId}/marks`, { method: "PUT", body: JSON.stringify(body) });
      setSaveState({
        ok: !res.sheet.startsWith("failed"),
        message: res.sheet === "updated" ? "Saved, and the student's row in the Google Sheet is updated."
          : res.sheet === "none" ? "Saved."
          : `Saved here, but the Google Sheet couldn't be updated: ${res.sheet.slice(8)}`,
      });
      onSaved && onSaved(res.results);
    } catch (e) {
      setSaveState({ ok: false, message: e.message });
    } finally {
      setSaving(false);
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

        <div className="ad-modal-body wm-body">
          {data.tasks.length === 0 && <p className="ad-sub">This exam has no writing section.</p>}
          {data.tasks.map((t, i) => {
            const state = tasks[i];
            const short = t.minWords && t.words < t.minWords;
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
                  {state.promptOpen && <p className="wm-prompt">{t.prompt}</p>}
                  <div className="wm-text">{t.text || <span className="ad-muted">Nothing written for this task.</span>}</div>
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
                    <textarea className="ad-input" rows={4} value={state.feedback} onChange={(e) => setTask(i, { feedback: e.target.value })} placeholder="What went well, what to work on" />
                  </label>
                </div>
              </section>
            );
          })}

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
        </div>

        <div className="ad-modal-footer wm-footer">
          {saveState && <span className={`wm-save-state ${saveState.ok ? "ok" : "bad"}`}>{saveState.ok ? <Check size={13} /> : <AlertTriangle size={13} />} {saveState.message}</span>}
          <button className="ad-btn ghost" onClick={onClose}>Close</button>
          <button className="ad-btn primary" onClick={save} disabled={saving || data.tasks.length === 0}>
            {saving ? <Loader2 size={15} className="spin-icon" /> : <Save size={15} />} Save marks
          </button>
        </div>
      </div>
    </div>
  );
}

const CSS = `
.wm-modal { width:1080px; max-width:96vw; max-height:92vh; }
.wm-summary { display:flex; flex-wrap:wrap; gap:8px; padding:12px 20px; border-bottom:1px solid #eee; background:#fafbfe; }
.wm-chip { display:flex; flex-direction:column; min-width:88px; padding:7px 12px; border:1px solid var(--ad-border); border-radius:9px; background:#fff; }
.wm-chip span { font-size:10px; font-weight:700; letter-spacing:.4px; text-transform:uppercase; color:var(--ad-muted); }
.wm-chip strong { font-size:17px; }
.wm-chip.strong { border-color:#d9d5fb; background:#eeecfd; }
.wm-chip.strong strong { color:#4a40d6; }
.wm-body { display:flex; flex-direction:column; gap:18px; }
.wm-task { display:grid; grid-template-columns:minmax(0,1fr) 330px; gap:18px; padding-bottom:18px; border-bottom:1px solid var(--ad-border); }
.wm-task-head { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
.wm-task-head h3 { margin:0; font-size:15px; }
.wm-words { font-size:11.5px; color:var(--ad-muted); }
.wm-words.short { color:#b3261e; font-weight:600; }
.wm-prompt-toggle { display:inline-flex; align-items:center; gap:4px; margin:6px 0; padding:0; border:0; background:none; font:inherit; font-size:11.5px; font-weight:600; color:var(--ad-purple); cursor:pointer; }
.wm-prompt { margin:0 0 8px; padding:9px 12px; border-radius:8px; background:#faf9ff; font-size:12.5px; line-height:1.6; white-space:pre-wrap; }
.wm-text { white-space:pre-wrap; background:#f7f8fc; border:1px solid #e7e8f2; border-radius:9px; padding:12px 14px; font-size:13.5px; line-height:1.75; max-height:460px; overflow-y:auto; }
.wm-marks { display:flex; flex-direction:column; gap:10px; }
.wm-suggest { justify-content:center; }
.wm-criterion label, .wm-band-row, .wm-speaking label { display:flex; align-items:center; justify-content:space-between; gap:10px; font-size:12px; font-weight:600; }
.wm-select { width:auto; min-width:84px; padding:6px 8px; }
.wm-reason { margin:4px 0 0; font-size:11.5px; line-height:1.5; color:var(--ad-muted); }
.wm-band-row { padding-top:8px; border-top:1px dashed var(--ad-border); }
.wm-feedback { display:flex; flex-direction:column; gap:5px; font-size:12px; font-weight:600; }
.wm-feedback textarea { font-family:inherit; font-size:12.5px; line-height:1.55; resize:vertical; }
.wm-error { display:flex; gap:6px; align-items:flex-start; font-size:11.5px; color:#b3261e; background:#fdeceb; padding:7px 10px; border-radius:7px; }
.wm-speaking { display:flex; flex-direction:column; gap:8px; max-width:520px; }
.wm-speaking em { font-style:normal; font-weight:400; color:var(--ad-muted); margin-left:6px; }
.wm-footer { align-items:center; }
.wm-save-state { margin-right:auto; display:inline-flex; align-items:center; gap:6px; font-size:12px; }
.wm-save-state.ok { color:#1e7a34; }
.wm-save-state.bad { color:#b3261e; }
@media (max-width: 860px) { .wm-task { grid-template-columns:1fr; } }
`;
