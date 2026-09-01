import React, { useState, useEffect, useCallback } from "react";
import { UserCheck, Users, CheckCircle2, Clock3, BookOpen, Headphones, PenLine, Loader2, ExternalLink, Pause, Play, Square } from "lucide-react";
import { adminFetch } from "../lib/adminApi";

/**
 * AdminTestRoom.jsx — the live moderation view. Replaces the old "Start Test
 * just flips a status flag" model: tapping Start Test on the exam card opens
 * this page, where students who've completed PreTestFlow show up in the
 * "Waiting" column and the moderator explicitly admits them (or admits
 * everyone at once) before their exam clock starts.
 *
 * Polls GET /api/exams/:id/roster every few seconds — good enough for a
 * moderator watching one screen during a test window; swap for websockets/
 * Supabase realtime if you want sub-second updates later.
 */

const SECTION_ICON = { reading: BookOpen, listening: Headphones, writing: PenLine };
const POLL_MS = 4000;

export default function AdminTestRoom({ exam, onBack }) {
  const [roster, setRoster] = useState(null); // { pending, inProgress, completed }
  const [admittingId, setAdmittingId] = useState(null);
  const [admittingAll, setAdmittingAll] = useState(false);
  const [error, setError] = useState("");
  const [examStatus, setExamStatus] = useState(exam?.status || "active");
  const [changingStatus, setChangingStatus] = useState(false);
  const examId = exam?.examId;

  const load = useCallback(async () => {
    if (!examId) return;
    try {
      const data = await adminFetch(`/api/exams/${examId}/roster`);
      setRoster(data);
    } catch (e) {
      setError(e.message);
    }
  }, [examId]);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, [load]);

  const admit = async (sessionId) => {
    setAdmittingId(sessionId);
    try {
      await adminFetch(`/api/sessions/${sessionId}/admit`, { method: "POST" });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setAdmittingId(null);
    }
  };

  const admitAll = async () => {
    setAdmittingAll(true);
    try {
      await adminFetch(`/api/exams/${examId}/admit-all`, { method: "POST" });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setAdmittingAll(false);
    }
  };

  const changeExamStatus = async (status) => {
    if (status === "closed" && !window.confirm("Finish this exam? New students will no longer be able to join.")) return;
    setChangingStatus(true);
    try {
      const endpoint = status === "paused" ? "pause" : status === "active" ? "resume" : "stop";
      await adminFetch(`/api/exams/${examId}/${endpoint}`, { method: "POST" });
      setExamStatus(status);
    } catch (e) {
      setError(e.message);
    } finally {
      setChangingStatus(false);
    }
  };

  if (!exam) {
    return null;
  }

  return (
    <div className="tr-root">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <button className="tr-back" onClick={onBack}>Back to exams</button>

      <div className="tr-head">
        <div>
          <h1>{exam.title}</h1>
          <p className="tr-sub">
            {examStatus === "paused" ? "Exam paused" : examStatus === "closed" ? "Exam finished" : "Live test room"} — code <span className="tr-code">{exam.startCode}</span>
          </p>
        </div>
        <div className="tr-controls">
          {roster && roster.pending.length > 0 && <button className="tr-btn primary" onClick={admitAll} disabled={admittingAll || examStatus !== "active"}>{admittingAll ? <Loader2 size={15} className="spin-icon" /> : <UserCheck size={15} />} Admit all waiting ({roster.pending.length})</button>}
          {examStatus === "active" && <button className="tr-btn secondary" onClick={() => changeExamStatus("paused")} disabled={changingStatus}><Pause size={14} /> Pause exam</button>}
          {examStatus === "paused" && <button className="tr-btn primary" onClick={() => changeExamStatus("active")} disabled={changingStatus}><Play size={14} /> Resume exam</button>}
          {examStatus !== "closed" && <button className="tr-btn finish" onClick={() => changeExamStatus("closed")} disabled={changingStatus}><Square size={13} /> Finish exam</button>}
        </div>
      </div>

      {error && <div className="tr-error">{error}</div>}

      {roster === null ? (
        <div className="tr-loading">Loading roster…</div>
      ) : (
        <div className="tr-columns">
          <Column
            title="Waiting"
            icon={<Clock3 size={15} />}
            count={roster.pending.length}
            empty="No one is waiting right now."
          >
            {roster.pending.map((s) => (
              <div className="tr-row" key={s.sessionId}>
                <span className="tr-name">{s.fullName || "—"}</span>
                <button
                  className="tr-btn small primary"
                  onClick={() => admit(s.sessionId)}
                  disabled={admittingId === s.sessionId}
                >
                  {admittingId === s.sessionId ? <Loader2 size={13} className="spin-icon" /> : <UserCheck size={13} />}
                  Admit
                </button>
              </div>
            ))}
          </Column>

          <Column
            title="In progress"
            icon={<Users size={15} />}
            count={roster.inProgress.length}
            empty="No one is currently testing."
          >
            {roster.inProgress.map((s) => {
              const Ico = SECTION_ICON[s.currentSection] || Clock3;
              return (
                <div className="tr-row" key={s.sessionId}>
                  <span className="tr-name">{s.fullName || "—"}</span>
                  <span className="tr-section-tag"><Ico size={12} /> {s.currentSection || "starting…"}</span>
                </div>
              );
            })}
          </Column>

          <Column
            title="Completed"
            icon={<CheckCircle2 size={15} />}
            count={roster.completed.length}
            empty="No one has finished yet."
          >
            {roster.completed.map((s) => (
              <div className="tr-row" key={s.sessionId}>
                <span className="tr-name">{s.fullName || "—"}</span>
                <span className="tr-band">
                  {s.results?.reading ? `R ${s.results.reading.band}` : ""}
                  {s.results?.listening ? ` · L ${s.results.listening.band}` : ""}
                </span>
                {s.sheetUrl && (
                  <a className="tr-sheet-link" href={s.sheetUrl} target="_blank" rel="noopener noreferrer" title="Open in Google Sheet">
                    <ExternalLink size={12} />
                  </a>
                )}
              </div>
            ))}
          </Column>
        </div>
      )}
    </div>
  );
}

function Column({ title, icon, count, empty, children }) {
  const hasChildren = React.Children.count(children) > 0;
  return (
    <div className="tr-col">
      <div className="tr-col-head">
        {icon} {title} <span className="tr-col-count">{count}</span>
      </div>
      <div className="tr-col-body">
        {hasChildren ? children : <p className="tr-empty">{empty}</p>}
      </div>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap');
* { box-sizing:border-box; }
.tr-root { --tr-bg:#f8f9fc; --tr-surface:#fff; --tr-border:#e8eaf2; --tr-text:#111d40; --tr-muted:#6f7890; --tr-purple:#5b50e6; font-family:"Poppins",-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; color:var(--tr-text); }
.tr-back { background:none; border:0; color:var(--tr-muted); font:inherit; font-size:12px; font-weight:600; cursor:pointer; padding:0 0 24px; transition:color .15s ease; }
.tr-back:hover { color:var(--tr-purple); }
.tr-head { display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:30px; gap:24px; }
.tr-controls { display:flex; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:8px; }
.tr-head h1 { font-size:27px; letter-spacing:-.5px; margin:0 0 6px; }
.tr-sub { font-size:12px; color:var(--tr-muted); margin:0; }
.tr-code { font-weight:700; letter-spacing:1.5px; color:#1a1a1a; }
.tr-error { background:#fdeceb; color:#b3261e; padding:10px 14px; border-radius:8px; font-size:13px; margin-bottom:16px; }
.tr-loading { color:#999; font-size:13px; padding:40px 0; text-align:center; }

.tr-btn { display:inline-flex; align-items:center; gap:7px; font-size:13.5px; font-weight:600; padding:9px 16px; border-radius:8px; border:none; cursor:pointer; transition:background-color .15s ease, opacity .15s ease, transform .1s ease; }
.tr-btn:active { transform:scale(0.97); }
.tr-btn.primary { background:#1a1a1a; color:#fff; }
.tr-btn.primary:hover { background:#000; }
.tr-btn.secondary { background:#eeecfd; color:#5147d7; }
.tr-btn.secondary:hover { background:#e3dfff; }
.tr-btn.finish { background:#fdeceb; color:#b3261e; }
.tr-btn.finish:hover { background:#f8d9d7; }
.tr-btn.primary:disabled { opacity:.5; cursor:not-allowed; }
.tr-btn.small { padding:6px 12px; font-size:12px; }

.tr-columns { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:22px; align-items:stretch; }
.tr-col { background:var(--tr-surface); border:1px solid var(--tr-border); border-radius:14px; overflow:hidden; display:flex; flex-direction:column; min-height:390px; box-shadow:0 4px 18px rgba(17,29,64,.035); }
.tr-col-head { display:flex; align-items:center; gap:9px; padding:17px 19px; font-size:13px; font-weight:700; border-bottom:1px solid var(--tr-border); background:#fbfbfe; }
.tr-col-count { margin-left:auto; background:#eeecfd; color:var(--tr-purple); font-size:11px; font-weight:700; padding:3px 9px; border-radius:10px; }
.tr-col-body { padding:13px; flex:1; }
.tr-empty { color:#9aa2b5; font-size:12.5px; text-align:center; padding:90px 12px; }
.tr-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px 12px; border:1px solid transparent; border-radius:9px; transition:background-color .15s ease, border-color .15s ease; animation:trIn .2s ease; }
.tr-row:hover { background:#fafafa; }
@keyframes trIn { from { opacity:0; transform:translateY(2px); } to { opacity:1; transform:translateY(0); } }
.tr-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; font-weight:600; }
.tr-section-tag { display:inline-flex; align-items:center; gap:5px; font-size:11.5px; color:#666; background:#f2f2f2; padding:3px 8px; border-radius:10px; text-transform:capitalize; }
.tr-alert { display:inline-flex; align-items:center; gap:3px; color:#b3261e; font-size:11px; font-weight:700; }
.tr-band { font-size:12px; color:#1e7a34; font-weight:600; }
.tr-sheet-link { display:flex; align-items:center; color:#888; transition:color .15s ease; }
.tr-sheet-link:hover { color:#1a1a1a; }

.spin-icon { animation:spin .8s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
@media (max-width: 900px) { .tr-columns { grid-template-columns:1fr; } .tr-col { min-height:220px; } .tr-empty { padding:45px 12px; } .tr-head { align-items:flex-start; flex-direction:column; } .tr-controls { justify-content:flex-start; } }
`;