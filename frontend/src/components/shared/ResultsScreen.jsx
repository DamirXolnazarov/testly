import React, { useEffect, useState } from "react";
import { CheckCircle2, BookOpen, Headphones, PenLine, Mic } from "lucide-react";
import { COLORS } from "../../lib/theme";

/**
 * ResultsScreen.jsx — shown after a student submits (or on resume into an
 * already-completed session). Reading/Listening show the real auto-graded
 * band from grader.js; Writing/Speaking are explicitly marked as pending —
 * never faked as a number, since those are graded manually by the admin
 * afterward (see docs/exam-json-schema.md's grading contract).
 *
 * Design: same Testly-branded surface category as WaitingRoom.jsx and
 * PreTestFlow.jsx — matches the brand system in theme.js (Poppins, navy/
 * purple, dark-mode-aware).
 */

export default function ResultsScreen({ fullName, results }) {
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => {
    setDarkMode(window.localStorage.getItem("testly-theme") === "dark");
  }, []);

  const reading = results?.reading;
  const listening = results?.listening;
  const hasAnyAutoGraded = reading || listening;

  return (
    <div className={`rs-root ${darkMode ? "dark" : ""}`}>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="rs-orbit" />
      <div className="rs-dots-decor" />

      <img className="rs-logo" src={darkMode ? "/images/testly-logo-light.png" : "/images/testly-logo.png"} alt="Testly" />

      <div className="rs-card">
        <div className="rs-icon"><CheckCircle2 size={24} /></div>
        <p className="rs-kicker">TEST COMPLETE</p>
        <h1>Test submitted</h1>
        <p className="rs-sub">
          {fullName ? <>Nice work, {fullName}.</> : "Nice work."} Here's what's ready now —
          the rest will be added once your administrator reviews it.
        </p>

        {hasAnyAutoGraded && (
          <div className="rs-scores">
            <ScoreRow icon={<BookOpen size={16} />} label="Reading" result={reading} />
            <ScoreRow icon={<Headphones size={16} />} label="Listening" result={listening} />
            <PendingRow icon={<PenLine size={16} />} label="Writing" />
            <PendingRow icon={<Mic size={16} />} label="Speaking" />
          </div>
        )}

        <p className="rs-hint">
          Your final overall band will be available from your test administrator once
          Writing and Speaking are graded.
        </p>
      </div>
    </div>
  );
}

function ScoreRow({ icon, label, result }) {
  if (!result) return <PendingRow icon={icon} label={label} />;
  return (
    <div className="rs-row">
      <span className="rs-row-label">{icon} {label}</span>
      <span className="rs-row-detail">{result.rawScore}/{result.total} correct</span>
      <span className="rs-row-band">Band {result.band}</span>
    </div>
  );
}

function PendingRow({ icon, label }) {
  return (
    <div className="rs-row pending">
      <span className="rs-row-label">{icon} {label}</span>
      <span className="rs-row-detail">Graded by your administrator</span>
      <span className="rs-row-band pending">Pending</span>
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
.rs-sub { font-size:13.5px; color:var(--rs-muted); line-height:1.6; margin:0 0 24px; }

.rs-scores { display:flex; flex-direction:column; gap:8px; text-align:left; margin-bottom:20px; }
.rs-row { display:flex; align-items:center; gap:10px; padding:11px 14px; background:var(--rs-bg); border:1px solid var(--rs-border); border-radius:9px; font-size:13px; animation:rsRowIn .25s ease; color:var(--rs-text); }
@keyframes rsRowIn { from { opacity:0; transform:translateX(-4px); } to { opacity:1; transform:translateX(0); } }
.rs-row.pending { opacity:.75; }
.rs-row-label { display:flex; align-items:center; gap:8px; font-weight:600; min-width:110px; }
.rs-row-detail { flex:1; color:var(--rs-muted); font-size:12px; }
.rs-row-band { font-weight:700; color:#1e7a34; font-size:12.5px; background:#e3f5e8; padding:3px 9px; border-radius:8px; }
.rs-row-band.pending { color:var(--rs-muted); background:var(--rs-soft); }

.rs-hint { font-size:11.5px; color:var(--rs-muted); margin:0; line-height:1.6; }
`;