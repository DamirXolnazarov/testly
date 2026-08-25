import React, { useEffect, useState } from "react";
import { Clock3 } from "lucide-react";
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

export default function WaitingRoom({ fullName, examTitle }) {
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => {
    setDarkMode(window.localStorage.getItem("testly-theme") === "dark");
  }, []);

  return (
    <div className={`wr-root ${darkMode ? "dark" : ""}`}>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="wr-orbit" />
      <div className="wr-dots-decor" />

      <img className="wr-logo" src={darkMode ? "/images/testly-logo-light.png" : "/images/testly-logo.png"} alt="Testly" />

      <div className="wr-card">
        <div className="wr-icon-wrap">
          <Clock3 size={24} />
          <span className="wr-pulse-ring" />
        </div>
        <p className="wr-kicker">WAITING ROOM</p>
        <h2>Waiting for your test administrator</h2>
        <p className="wr-sub">
          {fullName ? <>Hi {fullName} — </> : null}
          you're all set{examTitle ? <> for <b>{examTitle}</b></> : null}. Your test will begin
          as soon as your administrator admits you.
        </p>
        <div className="wr-dots">
          <span /><span /><span />
        </div>
        <p className="wr-hint">Keep this tab open — you'll be moved in automatically.</p>
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

.wr-card { position:relative; z-index:1; width:420px; max-width:100%; background:var(--wr-surface); border:1px solid var(--wr-border); border-radius:18px; padding:38px 34px; text-align:center; box-shadow:0 18px 60px rgba(17,29,64,.07); animation:wrIn .3s ease; transition:background-color .35s ease, border-color .35s ease; }
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
`;