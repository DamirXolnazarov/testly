import React, { useEffect, useState } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import { Loader2, Printer, ChevronDown, ChevronUp, MessageSquareQuote } from "lucide-react";
import { COLORS } from "../../lib/theme";
import AnnotatedEssay, { CATEGORIES, CATEGORY_KEYS, numberAnnotations } from "../../components/shared/AnnotatedEssay";

/**
 * /feedback/[token] — a student's marked IELTS Writing, at the private link
 * their teacher emailed them from the marking screen
 * (components/admin/WritingMarking.jsx). Read-only: each essay with the
 * teacher's annotations, the criterion and task bands, the teacher's notes,
 * and the bands for the whole test. Data: GET /api/feedback/:token
 * (backend/src/routes/feedback.js). Prints cleanly, for teachers who hand
 * it out in class.
 */

const CRITERIA = [
  ["task", "Task Achievement", "Task Response"],
  ["coherence", "Coherence & Cohesion"],
  ["lexical", "Lexical Resource"],
  ["grammar", "Grammatical Range & Accuracy"],
];
const isBand = (v) => typeof v === "number" && Number.isFinite(v);
const show = (v) => (isBand(v) ? v.toFixed(1) : "—");

export default function FeedbackPage() {
  const router = useRouter();
  const { token } = router.query;
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) return;
    fetch(`/api/feedback/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || "Could not load this feedback.");
        setReport(body);
      })
      .catch((e) => setError(e.message));
  }, [token]);

  return (
    <div className="fb-root">
      <Head>
        <title>{report ? `${report.examTitle} — writing feedback` : "Writing feedback"} · Testly</title>
        <meta name="robots" content="noindex" />
      </Head>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <header className="fb-top">
        <img src="/images/testly-logo.png" alt="Testly" />
        {report && <button className="fb-print" onClick={() => window.print()}><Printer size={15} /> Print</button>}
      </header>

      {error ? (
        <div className="fb-state"><h1>This link doesn't work</h1><p>{error} Ask your teacher to send it again.</p></div>
      ) : !report ? (
        <div className="fb-state"><Loader2 size={22} className="fb-spin" /></div>
      ) : (
        <Report report={report} />
      )}
    </div>
  );
}

function Report({ report }) {
  const counts = {};
  for (const t of report.tasks) for (const a of t.annotations) counts[a.category] = (counts[a.category] || 0) + 1;
  const date = report.takenAt ? new Date(report.takenAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : null;
  const skills = [["Reading", report.bands.reading], ["Listening", report.bands.listening], ["Writing", report.bands.writing], ["Speaking", report.bands.speaking]];

  return (
    <main className="fb-main">
      <section className="fb-hero">
        <div>
          <p className="fb-kicker">Writing feedback</p>
          <h1>{report.fullName}</h1>
          <p className="fb-meta">{report.examTitle}{date ? ` · ${date}` : ""}</p>
        </div>
        <div className="fb-bands">
          {skills.filter(([, v]) => isBand(v)).map(([label, v]) => (
            <div key={label} className={`fb-band ${label === "Writing" ? "hl" : ""}`}><span>{label}</span><strong>{show(v)}</strong></div>
          ))}
          {isBand(report.bands.overall) && <div className="fb-band overall"><span>Overall</span><strong>{show(report.bands.overall)}</strong></div>}
        </div>
      </section>

      {Object.keys(counts).length > 0 && (
        <div className="fb-legend">
          {CATEGORY_KEYS.filter((k) => counts[k]).map((k) => (
            <span key={k} className="fb-legend-item" style={{ "--ae-c": CATEGORIES[k].color, "--ae-soft": CATEGORIES[k].soft }}>
              <i /> {CATEGORIES[k].label} <b>{counts[k]}</b>
            </span>
          ))}
        </div>
      )}

      {report.tasks.map((t, i) => <TaskCard key={t.id} task={t} index={i} />)}

      <p className="fb-foot">Bands follow the public IELTS Writing band descriptors. Task 2 counts twice as much as Task 1 in your Writing band.</p>
    </main>
  );
}

function TaskCard({ task, index }) {
  const [promptOpen, setPromptOpen] = useState(false);
  const [active, setActive] = useState(null);
  const notes = numberAnnotations(task.annotations);
  const short = task.minWords && task.words < task.minWords;

  const pick = (id, from) => {
    setActive(id);
    const el = document.getElementById(from === "essay" ? `fb-note-${id}` : `ae-mark-${id}`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  return (
    <section className="fb-task">
      <div className="fb-task-head">
        <div>
          <h2>Task {task.number}</h2>
          <span className={`fb-words ${short ? "short" : ""}`}>{task.words} words{task.minWords ? ` · minimum ${task.minWords}` : ""}</span>
        </div>
        <div className="fb-task-band"><span>Task band</span><strong>{show(task.band)}</strong></div>
      </div>

      <div className="fb-criteria">
        {CRITERIA.map(([key, name, name2]) => (
          <div key={key} className="fb-criterion">
            <span>{index === 1 && name2 ? name2 : name}</span>
            <strong>{isBand(task.criteria[key]) ? task.criteria[key] : "—"}</strong>
          </div>
        ))}
      </div>

      <button className="fb-prompt-toggle" onClick={() => setPromptOpen(!promptOpen)}>
        {promptOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />} The task you were set
      </button>
      <div className={`fb-prompt ${promptOpen ? "open" : ""}`}>
        {task.prompt}
        {task.chartImageUrl && <img src={task.chartImageUrl} alt="Chart for this task" />}
      </div>

      <div className="fb-work">
        <div className="fb-essay">
          {task.text
            ? <AnnotatedEssay text={task.text} annotations={notes} activeId={active} onPick={(id) => pick(id, "essay")} />
            : <p className="fb-muted">Nothing was written for this task.</p>}
        </div>
        {notes.length > 0 && (
          <ol className="fb-notes">
            {notes.map((a) => {
              const cat = CATEGORIES[a.category] || CATEGORIES.grammar;
              return (
                <li key={a.id} id={`fb-note-${a.id}`} className={`fb-note ${active === a.id ? "active" : ""}`} style={{ "--ae-c": cat.color, "--ae-soft": cat.soft }} onClick={() => pick(a.id, "note")}>
                  <span className="fb-note-n">{a.n}</span>
                  <div>
                    <span className="fb-cat">{cat.label}</span>
                    <div className="fb-fix">
                      <span className={a.correction ? "wrong" : ""}>{a.quote}</span>
                      {a.correction && <> → <strong>{a.correction}</strong></>}
                    </div>
                    {a.comment && <p>{a.comment}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {task.feedback && (
        <div className="fb-teacher">
          <h3><MessageSquareQuote size={16} /> From your teacher</h3>
          <p>{task.feedback}</p>
        </div>
      )}
    </section>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap');
* { box-sizing:border-box; }
body { margin:0; background:${COLORS.bg}; }
.fb-root { min-height:100vh; background:${COLORS.bg}; color:${COLORS.navy}; font-family:"Poppins",-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; padding:0 20px 48px; }
.fb-top { max-width:1080px; margin:0 auto; display:flex; align-items:center; justify-content:space-between; padding:22px 0; }
.fb-top img { width:128px; }
.fb-print { display:inline-flex; align-items:center; gap:7px; padding:9px 16px; border-radius:9px; border:1.5px solid ${COLORS.border}; background:#fff; color:${COLORS.navy}; font:inherit; font-size:13px; font-weight:600; cursor:pointer; }
.fb-print:hover { border-color:${COLORS.purple}; color:${COLORS.purple}; }
.fb-state { max-width:520px; margin:80px auto; text-align:center; color:${COLORS.navyMuted}; }
.fb-state h1 { color:${COLORS.navy}; font-size:22px; }
.fb-spin { animation:fbspin .8s linear infinite; color:${COLORS.purple}; }
@keyframes fbspin { to { transform:rotate(360deg); } }
.fb-main { max-width:1080px; margin:0 auto; display:flex; flex-direction:column; gap:18px; }
.fb-hero { display:flex; flex-wrap:wrap; align-items:flex-end; justify-content:space-between; gap:20px; padding:28px 30px; background:#fff; border:1px solid ${COLORS.border}; border-radius:18px; }
.fb-kicker { margin:0 0 6px; font-size:10.5px; font-weight:800; letter-spacing:1.4px; text-transform:uppercase; color:${COLORS.purple}; }
.fb-hero h1 { margin:0; font-size:28px; letter-spacing:-.5px; }
.fb-meta { margin:4px 0 0; color:${COLORS.navyMuted}; font-size:14px; }
.fb-bands { display:flex; flex-wrap:wrap; gap:8px; }
.fb-band { display:flex; flex-direction:column; align-items:center; min-width:82px; padding:9px 12px; border:1px solid ${COLORS.border}; border-radius:12px; }
.fb-band span { font-size:10px; font-weight:700; letter-spacing:.5px; text-transform:uppercase; color:${COLORS.navyMuted}; }
.fb-band strong { font-size:22px; }
.fb-band.hl { border-color:#d9d5fb; }
.fb-band.overall { background:${COLORS.purple}; border-color:${COLORS.purple}; color:#fff; }
.fb-band.overall span { color:rgba(255,255,255,.8); }
.fb-legend { display:flex; flex-wrap:wrap; gap:14px; font-size:12.5px; color:${COLORS.navyMuted}; padding:0 4px; }
.fb-legend-item { display:inline-flex; align-items:center; gap:6px; }
.fb-legend-item i { width:14px; height:10px; border-radius:3px; background:var(--ae-soft); border-bottom:2px solid var(--ae-c); }
.fb-legend-item b { color:${COLORS.navy}; }
.fb-task { padding:26px 30px; background:#fff; border:1px solid ${COLORS.border}; border-radius:18px; }
.fb-task-head { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; }
.fb-task-head h2 { margin:0; font-size:20px; }
.fb-words { font-size:12.5px; color:${COLORS.navyMuted}; }
.fb-words.short { color:#b3261e; font-weight:600; }
.fb-task-band { display:flex; flex-direction:column; align-items:center; padding:8px 16px; border-radius:12px; background:${COLORS.purpleSoft}; }
.fb-task-band span { font-size:10px; font-weight:700; letter-spacing:.5px; text-transform:uppercase; color:${COLORS.purple}; }
.fb-task-band strong { font-size:24px; color:${COLORS.purpleHover}; }
.fb-criteria { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:8px; margin:18px 0 12px; }
.fb-criterion { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:10px 12px; border-radius:10px; background:${COLORS.bg}; font-size:12px; font-weight:600; color:${COLORS.navyMuted}; }
.fb-criterion strong { font-size:18px; color:${COLORS.navy}; }
.fb-prompt-toggle { display:inline-flex; align-items:center; gap:5px; padding:0; border:0; background:none; font:inherit; font-size:12.5px; font-weight:600; color:${COLORS.purple}; cursor:pointer; }
.fb-prompt { display:none; margin-top:8px; padding:12px 14px; border-radius:10px; background:#faf9ff; font-size:13px; line-height:1.65; white-space:pre-wrap; }
.fb-prompt.open { display:block; }
.fb-prompt img { display:block; max-width:100%; max-height:360px; margin:12px auto 0; }
.fb-work { display:grid; grid-template-columns:minmax(0,1fr) 320px; gap:22px; margin-top:16px; align-items:start; }
.fb-essay { font-size:15px; line-height:2.05; }
.fb-muted { color:${COLORS.navyMuted}; }
.fb-notes { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; position:sticky; top:16px; max-height:calc(100vh - 32px); overflow-y:auto; }
.fb-note { display:flex; gap:10px; padding:10px 12px; border:1px solid ${COLORS.border}; border-left:3px solid var(--ae-c); border-radius:9px; font-size:13px; cursor:pointer; transition:box-shadow .15s ease; }
.fb-note.active { box-shadow:0 0 0 2px var(--ae-soft); border-color:var(--ae-c); }
.fb-note-n { flex-shrink:0; min-width:20px; height:20px; padding:0 5px; border-radius:10px; background:var(--ae-c); color:#fff; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; }
.fb-cat { font-size:10.5px; font-weight:700; letter-spacing:.4px; text-transform:uppercase; color:var(--ae-c); }
.fb-fix .wrong { text-decoration:line-through; color:${COLORS.navyMuted}; }
.fb-fix strong { color:#17803d; }
.fb-note p { margin:3px 0 0; color:#3d4358; line-height:1.5; }
.fb-teacher { margin-top:20px; padding:16px 18px; border-radius:12px; background:${COLORS.purpleSoft}; }
.fb-teacher h3 { display:flex; align-items:center; gap:7px; margin:0 0 6px; font-size:14px; color:${COLORS.purpleHover}; }
.fb-teacher p { margin:0; font-size:14px; line-height:1.7; white-space:pre-wrap; }
.fb-foot { text-align:center; font-size:12px; color:${COLORS.navyMuted}; }
@media (max-width: 820px) {
  .fb-work { grid-template-columns:1fr; }
  .fb-notes { position:static; max-height:none; }
  .fb-criteria { grid-template-columns:repeat(2, minmax(0,1fr)); }
  .fb-hero, .fb-task { padding:20px; }
  .fb-hero h1 { font-size:23px; }
}
@media print {
  .fb-root { background:#fff; padding:0; }
  .fb-print, .fb-prompt-toggle { display:none; }
  .fb-prompt { display:block; }
  .fb-hero, .fb-task { border:0; padding:12px 0; break-inside:auto; }
  .fb-task { break-before:page; }
  .fb-notes { position:static; max-height:none; overflow:visible; }
  .fb-band.overall, .fb-task-band, .fb-teacher, .fb-note-n, .fb-legend-item i { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
}
`;
