import React, { useEffect, useState } from "react";
import { CheckCircle2, X } from "lucide-react";
import { COLORS } from "../../lib/theme";

/**
 * ResultsScreen.jsx — shown after a student submits (or on resume into an
 * already-completed session). Deliberately shows no scores, for IELTS or
 * SAT: the centre shares results itself. Just a thank-you, then a
 * Bluebook-style "how did it go?" popup with five emoji ratings and an
 * optional comment, saved through POST /api/sessions/:id/student-feedback
 * and shown to the admin in the sessions table.
 *
 * Design: same Testly-branded surface category as WaitingRoom.jsx and
 * PreTestFlow.jsx — matches the brand system in theme.js (Poppins, navy/
 * purple, dark-mode-aware).
 */

export const FEEDBACK_RATINGS = [
  { value: 1, emoji: "😫", label: "Very hard" },
  { value: 2, emoji: "🙁", label: "Not great" },
  { value: 3, emoji: "😐", label: "Okay" },
  { value: 4, emoji: "🙂", label: "Good" },
  { value: 5, emoji: "😍", label: "Loved it" },
];

const doneKey = (sid) => `testly_feedback_done_${sid}`;
const readDone = (sid) => { try { return !!sid && localStorage.getItem(doneKey(sid)) === "1"; } catch { return false; } };
const writeDone = (sid) => { try { if (sid) localStorage.setItem(doneKey(sid), "1"); } catch { /* private mode — fine */ } };

export default function ResultsScreen({ fullName, sessionId }) {
  const [darkMode, setDarkMode] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setDarkMode(window.localStorage.getItem("testly-theme") === "dark");
    const already = readDone(sessionId);
    setDone(already);
    if (already || !sessionId) return;
    const t = setTimeout(() => setModalOpen(true), 700);
    return () => clearTimeout(t);
  }, [sessionId]);

  return (
    <div className={`rs-root ${darkMode ? "dark" : ""}`}>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="rs-orbit" />
      <div className="rs-dots-decor" />

      <img className="rs-logo" src={darkMode ? "/images/testly-logo-light.png" : "/images/testly-logo.png"} alt="Testly" />

      <div className="rs-card">
        <div className="rs-icon"><CheckCircle2 size={24} /></div>
        <p className="rs-kicker">TEST COMPLETE</p>
        <h1>{fullName ? `Thank you, ${fullName}!` : "Thank you!"}</h1>
        <p className="rs-sub">
          Your test has been submitted and your answers are saved.
          Your teacher will share your results with you.
        </p>
        {sessionId && !done && !modalOpen && (
          <button type="button" className="rs-link" onClick={() => setModalOpen(true)}>Tell us how the test went</button>
        )}
        {done && <p className="rs-hint">Thanks for your feedback. You can close this page now.</p>}
      </div>

      {modalOpen && (
        <FeedbackModal
          sessionId={sessionId}
          onClose={() => setModalOpen(false)}
          onSent={() => { writeDone(sessionId); setDone(true); }}
        />
      )}
    </div>
  );
}

function FeedbackModal({ sessionId, onClose, onSent }) {
  const [rating, setRating] = useState(null);
  const [comment, setComment] = useState("");
  const [state, setState] = useState("idle"); // idle | sending | sent | error

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && state !== "sending") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, state]);

  const send = async () => {
    if (!rating) return;
    setState("sending");
    try {
      const r = await fetch(`/api/sessions/${sessionId}/student-feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, comment }),
      });
      if (!r.ok) throw new Error(String(r.status));
      setState("sent");
      onSent();
      setTimeout(onClose, 1600);
    } catch {
      setState("error");
    }
  };

  return (
    <div className="fb-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && state !== "sending") onClose(); }}>
      <div className="fb-modal" role="dialog" aria-modal="true" aria-labelledby="fb-title">
        {state === "sent" ? (
          <div className="fb-thanks">
            <div className="fb-thanks-emoji">🙏</div>
            <h2>Thanks for your feedback!</h2>
            <p>It helps us make the next test better.</p>
          </div>
        ) : (
          <>
            <button type="button" className="fb-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
            <h2 id="fb-title">How was your test experience?</h2>
            <p className="fb-sub">Takes five seconds. Only your test centre sees your answer.</p>
            <div className="fb-emojis" role="radiogroup" aria-label="Rating">
              {FEEDBACK_RATINGS.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  role="radio"
                  aria-checked={rating === r.value}
                  className={`fb-emoji ${rating === r.value ? "on" : ""} ${rating && rating !== r.value ? "dim" : ""}`}
                  onClick={() => setRating(r.value)}
                >
                  <span className="fb-emoji-face">{r.emoji}</span>
                  <span className="fb-emoji-label">{r.label}</span>
                </button>
              ))}
            </div>
            {rating && (
              <textarea
                className="fb-comment"
                placeholder="Anything you'd like to tell us? (optional)"
                value={comment}
                maxLength={2000}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
                autoFocus
              />
            )}
            {state === "error" && <p className="fb-error">Couldn't send that. Check your connection and try again.</p>}
            <div className="fb-actions">
              <button type="button" className="fb-skip" onClick={onClose} disabled={state === "sending"}>Not now</button>
              <button type="button" className="fb-send" onClick={send} disabled={!rating || state === "sending"}>
                {state === "sending" ? "Sending…" : "Send feedback"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap');
* { box-sizing:border-box; }
.rs-root { --rs-bg:${COLORS.bg}; --rs-surface:#fff; --rs-border:${COLORS.border}; --rs-text:${COLORS.navy}; --rs-muted:${COLORS.navyMuted}; --rs-soft:${COLORS.purpleSoft}; position:relative; min-height:100vh; overflow:hidden; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:26px; background:var(--rs-bg); color:var(--rs-text); font-family:"Poppins",-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; padding:24px; transition:background-color .35s ease, color .35s ease; }
.rs-root.dark { --rs-bg:#141725; --rs-surface:#202438; --rs-border:#343952; --rs-text:#f5f6ff; --rs-muted:#aeb4ca; --rs-soft:#302d5b; }

.rs-orbit { position:absolute; width:460px; height:460px; right:-280px; top:-140px; border:80px solid var(--rs-soft); border-radius:50%; opacity:.7; z-index:0; }
.rs-dots-decor { position:absolute; left:60px; bottom:70px; width:76px; height:76px; opacity:.5; background-image:radial-gradient(#9c93f5 1.8px, transparent 1.8px); background-size:16px 16px; z-index:0; }

.rs-logo { position:relative; z-index:1; width:150px; }

.rs-card { position:relative; z-index:1; width:460px; max-width:100%; background:var(--rs-surface); border:1px solid var(--rs-border); border-radius:18px; padding:36px 34px; text-align:center; box-shadow:0 18px 60px rgba(17,29,64,.07); animation:rsIn .3s ease; transition:background-color .35s ease, border-color .35s ease; }
@keyframes rsIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }

.rs-icon { width:50px; height:50px; margin:0 auto 16px; border-radius:14px; background:#e3f5e8; color:#1e7a34; display:flex; align-items:center; justify-content:center; box-shadow:0 8px 18px rgba(30,122,52,.15); }
.rs-kicker { color:${COLORS.purple}; font-size:10px; font-weight:800; letter-spacing:1.4px; margin:0 0 8px; }
.rs-card h1 { font-size:20px; letter-spacing:-.3px; margin:0 0 8px; }
.rs-sub { font-size:13.5px; color:var(--rs-muted); line-height:1.6; margin:0; }
.rs-hint { font-size:12px; color:var(--rs-muted); margin:18px 0 0; line-height:1.6; }
.rs-link { margin-top:20px; background:none; border:1px solid var(--rs-border); color:${COLORS.purple}; font:inherit; font-size:13px; font-weight:600; padding:9px 16px; border-radius:10px; cursor:pointer; }
.rs-link:hover { background:var(--rs-soft); }

.fb-backdrop { position:fixed; inset:0; z-index:50; background:rgba(17,23,45,.45); display:flex; align-items:center; justify-content:center; padding:16px; animation:fbFade .2s ease; }
@keyframes fbFade { from { opacity:0; } to { opacity:1; } }
.fb-modal { position:relative; width:520px; max-width:100%; background:var(--rs-surface); color:var(--rs-text); border:1px solid var(--rs-border); border-radius:18px; padding:32px 28px 24px; text-align:center; box-shadow:0 24px 70px rgba(17,29,64,.25); animation:fbUp .25s ease; }
@keyframes fbUp { from { opacity:0; transform:translateY(12px) scale(.98); } to { opacity:1; transform:none; } }
.fb-close { position:absolute; top:14px; right:14px; background:none; border:none; color:var(--rs-muted); cursor:pointer; padding:6px; border-radius:8px; display:flex; }
.fb-close:hover { background:var(--rs-bg); color:var(--rs-text); }
.fb-modal h2 { font-size:19px; margin:0 0 6px; letter-spacing:-.2px; }
.fb-sub { font-size:12.5px; color:var(--rs-muted); margin:0 0 22px; line-height:1.5; }
.fb-emojis { display:flex; justify-content:space-between; gap:6px; margin-bottom:18px; }
.fb-emoji { flex:1; display:flex; flex-direction:column; align-items:center; gap:6px; background:var(--rs-bg); border:2px solid transparent; border-radius:14px; padding:12px 4px 10px; cursor:pointer; font:inherit; color:var(--rs-text); transition:transform .15s ease, border-color .15s ease, opacity .15s ease, background-color .15s ease; }
.fb-emoji:hover { transform:translateY(-2px); }
.fb-emoji.on { border-color:${COLORS.purple}; background:var(--rs-soft); transform:translateY(-2px); }
.fb-emoji.dim { opacity:.5; }
.fb-emoji-face { font-size:34px; line-height:1; }
.fb-emoji-label { font-size:11.5px; font-weight:600; color:var(--rs-muted); }
.fb-emoji.on .fb-emoji-label { color:var(--rs-text); }
.fb-comment { width:100%; resize:vertical; min-height:72px; border:1px solid var(--rs-border); background:var(--rs-bg); color:var(--rs-text); border-radius:10px; padding:10px 12px; font:inherit; font-size:13.5px; margin-bottom:14px; }
.fb-comment:focus { outline:none; border-color:${COLORS.purple}; }
.fb-error { color:#c0392b; font-size:12.5px; margin:0 0 12px; }
.fb-actions { display:flex; gap:10px; }
.fb-skip, .fb-send { flex:1; font:inherit; font-size:14px; font-weight:600; border-radius:10px; padding:12px; cursor:pointer; }
.fb-skip { background:none; border:1px solid var(--rs-border); color:var(--rs-text); }
.fb-skip:hover { background:var(--rs-bg); }
.fb-send { background:${COLORS.purple}; border:none; color:#fff; }
.fb-send:disabled { opacity:.45; cursor:default; }
.fb-thanks { padding:12px 0 8px; }
.fb-thanks-emoji { font-size:44px; margin-bottom:10px; }
.fb-thanks p { font-size:13px; color:var(--rs-muted); margin:6px 0 0; }

@media (max-width:480px) {
  .fb-modal { padding:28px 16px 18px; }
  .fb-emoji-face { font-size:28px; }
  .fb-emoji-label { font-size:10px; }
}
`;
