import React, { useEffect, useState } from "react";
import { Clock3, Pause, CheckCircle2, Check, Headphones, BellOff, Wifi } from "lucide-react";
import { COLORS } from "../lib/theme";

/**
 * WaitingRoom.jsx — shown between PreTestFlow and the actual exam. The
 * student has finished the instructions and their code was valid, but the
 * session is "pending_admission" until a moderator admits them from the
 * admin dashboard's live roster (AdminTestRoom.jsx). This is the deliberate
 * gate: a valid code alone shouldn't be enough to start the clock — a human
 * proctor confirms who's actually present first.
 *
 * Purely presentational — ExamSession.jsx owns the polling logic that
 * detects admission and moves the student forward automatically. Nothing
 * here needs to be clicked; it just needs to not feel like the app is stuck.
 *
 * Design: explicitly in-scope per the design spec ("Student Pre-Test →
 * Waiting Room" is listed as a Testly-branded surface) — same visual
 * language as PreTestFlow.jsx / AdminLogin.jsx.
 */

const VARIANTS = {
  waiting: {
    icon: Clock3,
    kicker: "WAITING ROOM",
    title: "Waiting for your test administrator",
    body: (name, exam) => (
      <>
        {name ? <>Hi {name} — you're</> : <>You're</>} checked in{exam ? <> for <b>{exam}</b></> : null}. Your test begins as soon as your administrator admits you.
      </>
    ),
    hint: "Keep this tab open — you'll be moved in automatically.",
  },
  paused: {
    icon: Pause,
    kicker: "TEST PAUSED",
    title: "The exam is paused",
    body: (name) => (
      <>
        {name ? <>Hi {name}. </> : null}
        Your administrator paused the test. Your answers are saved and your clock is on hold — it continues when they resume.
      </>
    ),
    hint: "Keep this page open — the test resumes on its own.",
  },
  closed: {
    icon: CheckCircle2,
    kicker: "SESSION ENDED",
    title: "The exam has finished",
    body: (name) => <>{name ? <>Hi {name}. </> : null}Your administrator has ended this test session. You can close this page.</>,
    hint: null,
  },
};

const STEPS = ["Checked in", "Admission", "Test begins"];
const TIPS = [
  [Headphones, "Put on your headphones and check the volume."],
  [BellOff, "Silence your phone and close other tabs."],
  [Wifi, "Stay on a stable connection until the test ends."],
];

function formatElapsed(sec) {
  const m = Math.floor(sec / 60);
  return `${m}:${String(sec % 60).padStart(2, "0")}`;
}

export default function WaitingRoom({ fullName, examTitle, variant = "waiting" }) {
  const [darkMode, setDarkMode] = useState(false);
  const [online, setOnline] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const v = VARIANTS[variant] || VARIANTS.waiting;
  const Icon = v.icon;
  const live = variant !== "closed";

  useEffect(() => {
    setDarkMode(window.localStorage.getItem("testly-theme") === "dark");
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [live]);

  return (
    <div className={`wr-root ${darkMode ? "dark" : ""}`}>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="wr-orbit" />
      <div className="wr-dots-decor" />

      <img className="wr-logo" src={darkMode ? "/images/testly-logo-light.png" : "/images/testly-logo.png"} alt="Testly" />

      <div className="wr-card" role="status" aria-live="polite">
        <div className="wr-icon-wrap">
          <Icon size={24} />
          {live && <span className="wr-pulse-ring" />}
        </div>
        <p className="wr-kicker">{v.kicker}</p>
        <h2>{v.title}</h2>
        <p className="wr-sub">{v.body(fullName, examTitle)}</p>

        {variant === "waiting" && (
          <ol className="wr-steps" aria-label="Progress">
            {STEPS.map((label, i) => (
              <li key={label} className={i === 0 ? "done" : i === 1 ? "current" : ""}>
                <span className="wr-step-dot">{i === 0 ? <Check size={12} strokeWidth={3} /> : i + 1}</span>
                <span className="wr-step-label">{label}</span>
              </li>
            ))}
          </ol>
        )}

        {live && (
          <div className="wr-status-row">
            <span className={`wr-pill ${online ? "ok" : "bad"}`}>
              <span className="wr-pill-dot" />
              {online ? "Connected" : "Connection lost — reconnecting…"}
            </span>
            <span className="wr-elapsed">{variant === "paused" ? "Paused for" : "Waiting"} {formatElapsed(elapsed)}</span>
          </div>
        )}

        {variant === "waiting" && (
          <ul className="wr-tips">
            {TIPS.map(([TipIcon, text]) => (
              <li key={text}><TipIcon size={15} /> {text}</li>
            ))}
          </ul>
        )}

        {v.hint && <p className="wr-hint">{v.hint}</p>}
      </div>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap');
* { box-sizing:border-box; }
.wr-root { --wr-bg:${COLORS.bg}; --wr-surface:#fff; --wr-border:${COLORS.border}; --wr-text:${COLORS.navy}; --wr-muted:${COLORS.navyMuted}; --wr-soft:${COLORS.purpleSoft}; position:relative; min-height:100vh; overflow:hidden; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:26px; background:var(--wr-bg); color:var(--wr-text); font-family:"Poppins",-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; padding:24px; transition:background-color .35s ease, color .35s ease; }
.wr-root.dark { --wr-bg:#141725; --wr-surface:#202438; --wr-border:#343952; --wr-text:#f5f6ff; --wr-muted:#aeb4ca; --wr-soft:#302d5b; }

.wr-orbit { position:absolute; width:460px; height:460px; left:-280px; bottom:-160px; border:80px solid var(--wr-soft); border-radius:50%; opacity:.7; z-index:0; }
.wr-dots-decor { position:absolute; right:64px; top:80px; width:76px; height:76px; opacity:.5; background-image:radial-gradient(#9c93f5 1.8px, transparent 1.8px); background-size:16px 16px; z-index:0; }

.wr-logo { position:relative; z-index:1; width:150px; }

.wr-card { position:relative; z-index:1; width:440px; max-width:100%; background:var(--wr-surface); border:1px solid var(--wr-border); border-radius:18px; padding:38px 34px; text-align:center; box-shadow:0 18px 60px rgba(17,29,64,.07); animation:wrIn .3s ease; transition:background-color .35s ease, border-color .35s ease; }
@keyframes wrIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }

.wr-icon-wrap { position:relative; width:52px; height:52px; margin:0 auto 18px; border-radius:14px; background:${COLORS.purple}; color:#fff; display:flex; align-items:center; justify-content:center; box-shadow:0 8px 18px rgba(91,80,230,.22); }
.wr-pulse-ring { position:absolute; inset:-6px; border-radius:16px; border:2px solid ${COLORS.purple}; opacity:0; animation:wrPulse 2.2s ease-out infinite; }
@keyframes wrPulse { 0% { opacity:.5; transform:scale(0.9); } 100% { opacity:0; transform:scale(1.3); } }

.wr-kicker { color:${COLORS.purple}; font-size:10px; font-weight:800; letter-spacing:1.4px; margin:0 0 8px; }
.wr-card h2 { font-size:19px; letter-spacing:-.3px; margin:0 0 10px; }
.wr-sub { font-size:13.5px; color:var(--wr-muted); line-height:1.6; margin:0 0 22px; }

.wr-dots { display:flex; justify-content:center; gap:6px; margin-bottom:18px; }
.wr-dots span { width:7px; height:7px; border-radius:50%; background:${COLORS.purple}; opacity:.35; animation:wrDot 1.2s ease-in-out infinite; }
.wr-dots span:nth-child(2) { animation-delay:.15s; }
.wr-dots span:nth-child(3) { animation-delay:.3s; }
@keyframes wrDot { 0%, 80%, 100% { opacity:.3; transform:translateY(0); } 40% { opacity:1; transform:translateY(-3px); } }
.wr-hint { font-size:11px; color:var(--wr-muted); margin:0; }

.wr-steps { list-style:none; display:flex; justify-content:space-between; position:relative; margin:0 6px 22px; padding:0; }
.wr-steps::before { content:""; position:absolute; top:11px; left:12%; right:12%; height:2px; background:var(--wr-border); }
.wr-steps li { position:relative; flex:1; display:flex; flex-direction:column; align-items:center; gap:6px; font-size:11px; font-weight:600; color:var(--wr-muted); }
.wr-step-dot { width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center; background:var(--wr-surface); border:2px solid var(--wr-border); font-size:11px; font-weight:700; z-index:1; }
.wr-steps li.done .wr-step-dot { background:#1f9d62; border-color:#1f9d62; color:#fff; }
.wr-steps li.current .wr-step-dot { border-color:${COLORS.purple}; color:${COLORS.purple}; box-shadow:0 0 0 4px var(--wr-soft); }
.wr-steps li.current, .wr-steps li.done { color:var(--wr-text); }

.wr-status-row { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; padding:10px 12px; margin-bottom:16px; border:1px solid var(--wr-border); border-radius:10px; font-size:12px; }
.wr-pill { display:inline-flex; align-items:center; gap:7px; font-weight:600; }
.wr-pill-dot { width:8px; height:8px; border-radius:50%; background:currentColor; }
.wr-pill.ok { color:#1f9d62; } .wr-pill.ok .wr-pill-dot { animation:wrBlink 1.8s ease-in-out infinite; }
.wr-pill.bad { color:#c0392b; }
@keyframes wrBlink { 50% { opacity:.35; } }
.wr-elapsed { color:var(--wr-muted); font-variant-numeric:tabular-nums; }

.wr-tips { list-style:none; margin:0 0 16px; padding:14px 16px; text-align:left; background:var(--wr-soft); border-radius:10px; display:flex; flex-direction:column; gap:9px; }
.wr-tips li { display:flex; align-items:center; gap:10px; font-size:12px; color:var(--wr-text); }
.wr-tips svg { flex:none; color:${COLORS.purple}; }
@media (prefers-reduced-motion: reduce) { .wr-pulse-ring, .wr-dots span, .wr-pill-dot { animation:none !important; } }
`;
