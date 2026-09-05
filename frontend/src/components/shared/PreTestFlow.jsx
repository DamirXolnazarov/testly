import React, { useState, useEffect, useRef } from "react";
import { Check, Loader2 } from "lucide-react";
import { COLORS } from "../../lib/theme";

/**
 * PreTestFlow — everything a student goes through between logging in and the
 * exam actually starting:
 *
 *   1. Full name confirmation
 *   2. Test rules / "official things" screens (identity, conduct, technical checks)
 *   3. System check (mic optional since no speaking, audio + connectivity check
 *      for listening)
 *   4. Start code entry (admin must have tapped "Start Test" server-side first —
 *      wrong/inactive code shows inline error, not a redirect)
 *
 * On completion, calls onComplete({ fullName, startCode }) — the parent wires
 * that to a real POST /api/sessions call per backend/src/routes/sessions.js.
 *
 * Design: this is one of the explicitly-in-scope Testly-branded surfaces
 * (per the design spec — "we can brand this because it happens before the
 * IELTS replica"). Same visual language as AdminLogin.jsx (Poppins, navy/
 * purple, dark-mode-ready CSS variables). Once the actual exam starts,
 * Testly branding hands off entirely to the plain IELTS CD replica — this
 * file has zero dependency on IELTSCDReplica.jsx, by design.
 */

const STEPS = ["name", "rules", "check", "code"];

export default function PreTestFlow({ onComplete, validateStartCode }) {
  const [step, setStep] = useState(0);
  const [fullName, setFullName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [checks, setChecks] = useState({ connection: null, audio: null });
  const [startCode, setStartCode] = useState("");
  const [codeError, setCodeError] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => {
    setDarkMode(window.localStorage.getItem("testly-theme") === "dark");
  }, []);

  // Real connection check: a live GET /api/health round trip, not a timer.
  // Audio can't be verified silently from JS (no API tells us a speaker
  // actually produced sound) — instead we play a real tone and ask the
  // student to confirm they heard it, and let them retry or explicitly
  // report silence, which fails the check instead of hiding the problem.
  useEffect(() => {
    if (STEPS[step] !== "check") return;
    setChecks({ connection: null, audio: null });
    let cancelled = false;
    fetch("/api/health")
      .then((res) => { if (!cancelled) setChecks((c) => ({ ...c, connection: res.ok ? "ok" : "error" })); })
      .catch(() => { if (!cancelled) setChecks((c) => ({ ...c, connection: "error" })); });
    return () => { cancelled = true; };
  }, [step]);

  const playTestTone = () => {
    setChecks((c) => ({ ...c, audio: "playing" }));
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 440;
      gain.gain.setValueAtTime(0.001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.9);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.9);
      osc.onended = () => { ctx.close(); setChecks((c) => (c.audio === "playing" ? { ...c, audio: "played" } : c)); };
    } catch (e) {
      setChecks((c) => ({ ...c, audio: "error" }));
    }
  };

  const canNext = () => {
    const s = STEPS[step];
    if (s === "name") return fullName.trim().length > 1;
    if (s === "rules") return agreed;
    if (s === "check") return checks.connection === "ok" && checks.audio === "ok";
    return true;
  };

  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  const submitCode = async () => {
    if (startCode.trim().length < 4) {
      setCodeError("Enter the code your test administrator gave you.");
      return;
    }
    setCodeError("");
    setVerifying(true);
    try {
      const ok = validateStartCode ? await validateStartCode(startCode.trim(), fullName.trim()) : true;
      setVerifying(false);
      if (!ok) {
        setCodeError("That code isn't active yet. Check with your test administrator.");
        return;
      }
      onComplete && onComplete({ fullName: fullName.trim(), startCode: startCode.trim() });
    } catch (e) {
      setVerifying(false);
      setCodeError("Couldn't verify the code. Check your connection and try again.");
    }
  };

  return (
    <div className={`ptf-root ${darkMode ? "dark" : ""}`}>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="ptf-orbit" />
      <div className="ptf-dots-decor" />

      <div className="ptf-header">
        <img src={darkMode ? "/images/testly-logo-light.png" : "/images/testly-logo.png"} alt="Testly" />
        <div className="ptf-steps">
          {STEPS.map((s, i) => (
            <div key={s} className={`ptf-step-dot ${i === step ? "active" : ""} ${i < step ? "done" : ""}`} />
          ))}
        </div>
      </div>

      <div className="ptf-card" key={step}>
        {STEPS[step] === "name" && <NameStep fullName={fullName} setFullName={setFullName} onEnter={() => canNext() && next()} />}
        {STEPS[step] === "rules" && <RulesStep agreed={agreed} setAgreed={setAgreed} />}
        {STEPS[step] === "check" && <CheckStep checks={checks} onPlayTone={playTestTone} onConfirmAudio={(heard) => setChecks((c) => ({ ...c, audio: heard ? "ok" : "error" }))} />}
        {STEPS[step] === "code" && (
          <CodeStep
            startCode={startCode}
            setStartCode={setStartCode}
            error={codeError}
            verifying={verifying}
            onSubmit={submitCode}
          />
        )}

        <div className="ptf-nav">
          <button className="ptf-btn ghost" onClick={back} disabled={step === 0}>Back</button>
          {STEPS[step] !== "code" ? (
            <button className="ptf-btn primary" disabled={!canNext()} onClick={next}>Continue</button>
          ) : (
            <button className="ptf-btn primary" disabled={verifying} onClick={submitCode}>
              {verifying ? <Loader2 size={14} className="spin-icon" /> : null}
              {verifying ? "Checking…" : "Start test"}
            </button>
          )}
        </div>
      </div>

      <p className="ptf-footer-note">Secure workspace for test takers</p>
    </div>
  );
}

function NameStep({ fullName, setFullName, onEnter }) {
  const ref = useRef(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="ptf-step">
      <p className="ptf-kicker">STEP 1 OF 4</p>
      <h2>Confirm your full name</h2>
      <p className="ptf-sub">Enter your name exactly as it appears on your official ID. This will be printed on your results.</p>
      <input
        ref={ref}
        className="ptf-input"
        placeholder="Full name"
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onEnter()}
      />
    </div>
  );
}

function RulesStep({ agreed, setAgreed }) {
  const rules = [
    "You must remain at your seat for the entire duration of each section unless permitted by your invigilator.",
    "No phones, smartwatches, or other electronic devices are permitted during the test.",
    "The Listening audio plays once only — it cannot be paused or rewound.",
    "You must complete Reading, Listening, and Writing within the time allotted for each section; time will not be added.",
    "Any attempt to communicate with another test taker will result in disqualification.",
  ];
  return (
    <div className="ptf-step">
      <p className="ptf-kicker">STEP 2 OF 4</p>
      <h2>Before you begin</h2>
      <p className="ptf-sub">Please read the test conditions carefully.</p>
      <ul className="ptf-rules">
        {rules.map((r, i) => <li key={i}>{r}</li>)}
      </ul>
      <label className="ptf-check-row">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        I have read and understood the test conditions above.
      </label>
    </div>
  );
}

function CheckStep({ checks, onPlayTone, onConfirmAudio }) {
  return (
    <div className="ptf-step">
      <p className="ptf-kicker">STEP 3 OF 4</p>
      <h2>System check</h2>
      <p className="ptf-sub">Making sure everything's ready before you start.</p>
      <div className="ptf-checklist">
        <div className="ptf-check-item">
          <StatusDot state={checks.connection} />
          <span>Internet connection</span>
          {checks.connection === "error" && <span className="ptf-check-hint">Couldn't reach the server — check your connection.</span>}
        </div>

        <div className="ptf-check-item ptf-check-item-audio">
          <StatusDot state={checks.audio === "ok" ? "ok" : checks.audio === "playing" ? "pending" : checks.audio} />
          <span>Audio playback (required for Listening)</span>
          {checks.audio == null && (
            <button type="button" className="ptf-mini-btn" onClick={onPlayTone}>Play test sound</button>
          )}
          {checks.audio === "played" && (
            <span className="ptf-audio-confirm">
              Did you hear the tone?
              <button type="button" className="ptf-mini-btn" onClick={() => onConfirmAudio(true)}>Yes</button>
              <button type="button" className="ptf-mini-btn ghost" onClick={() => onConfirmAudio(false)}>No</button>
            </span>
          )}
          {checks.audio === "error" && (
            <span className="ptf-check-hint">
              Check your volume and output device, then try again.
              <button type="button" className="ptf-mini-btn" onClick={onPlayTone}>Retry</button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusDot({ state }) {
  if (state === "ok") return <span className="ptf-dot ok"><Check size={12} strokeWidth={3} /></span>;
  if (state === "error") return <span className="ptf-dot error">!</span>;
  return <span className="ptf-dot pending"><Loader2 size={12} className="spin-icon" /></span>;
}

function CodeStep({ startCode, setStartCode, error, verifying, onSubmit }) {
  const ref = useRef(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="ptf-step">
      <p className="ptf-kicker">STEP 4 OF 4</p>
      <h2>Enter your test start code</h2>
      <p className="ptf-sub">Your test administrator will provide this once the test session opens.</p>
      <input
        ref={ref}
        className={`ptf-input code ${error ? "err" : ""}`}
        placeholder="e.g. 4K9P2R"
        value={startCode}
        onChange={(e) => { setStartCode(e.target.value.toUpperCase()); }}
        onKeyDown={(e) => e.key === "Enter" && onSubmit()}
        maxLength={8}
      />
      {error && <p className="ptf-error">{error}</p>}
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap');
* { box-sizing:border-box; }
.ptf-root { --ptf-bg:${COLORS.bg}; --ptf-surface:#fff; --ptf-border:${COLORS.border}; --ptf-text:${COLORS.navy}; --ptf-muted:${COLORS.navyMuted}; --ptf-soft:${COLORS.purpleSoft}; position:relative; min-height:100vh; overflow:hidden; display:flex; flex-direction:column; align-items:center; background:var(--ptf-bg); color:var(--ptf-text); font-family:"Poppins",-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; padding:36px 24px 28px; transition:background-color .35s ease, color .35s ease; }
.ptf-root.dark { --ptf-bg:#141725; --ptf-surface:#202438; --ptf-border:#343952; --ptf-text:#f5f6ff; --ptf-muted:#aeb4ca; --ptf-soft:#302d5b; }

.ptf-orbit { position:absolute; width:460px; height:460px; left:-280px; top:-120px; border:80px solid var(--ptf-soft); border-radius:50%; opacity:.7; z-index:0; }
.ptf-dots-decor { position:absolute; right:56px; bottom:64px; width:76px; height:76px; opacity:.5; background-image:radial-gradient(#9c93f5 1.8px, transparent 1.8px); background-size:16px 16px; z-index:0; }

.ptf-header { position:relative; z-index:1; width:100%; max-width:520px; display:flex; align-items:center; justify-content:space-between; margin-bottom:34px; }
.ptf-header img { width:150px; }
.ptf-steps { display:flex; gap:8px; }
.ptf-step-dot { width:7px; height:7px; border-radius:50%; background:var(--ptf-border); transition:background-color .3s ease, transform .3s ease; }
.ptf-step-dot.active { background:${COLORS.purple}; transform:scale(1.35); }
.ptf-step-dot.done { background:${COLORS.purple}; }

.ptf-card { position:relative; z-index:1; width:100%; max-width:520px; background:var(--ptf-surface); border:1px solid var(--ptf-border); border-radius:18px; padding:32px 32px 26px; box-shadow:0 18px 60px rgba(17,29,64,.07); animation:ptfIn .3s ease; transition:background-color .35s ease, border-color .35s ease; }
@keyframes ptfIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }

.ptf-kicker { color:${COLORS.purple}; font-size:10px; font-weight:800; letter-spacing:1.4px; margin:0 0 10px; }
.ptf-step h2 { font-size:22px; letter-spacing:-.4px; margin:0 0 8px; }
.ptf-sub { font-size:13.5px; color:var(--ptf-muted); line-height:1.6; margin-bottom:22px; }

.ptf-input { width:100%; font-size:15px; padding:13px 14px; background:transparent; color:var(--ptf-text); border:1.5px solid var(--ptf-border); border-radius:9px; font-family:inherit; transition:border-color .15s ease, box-shadow .15s ease; }
.ptf-input:focus { outline:none; border-color:${COLORS.purple}; box-shadow:0 0 0 3px rgba(91,80,230,.12); }
.ptf-input.code { text-align:center; letter-spacing:4px; font-weight:700; font-size:19px; text-transform:uppercase; }
.ptf-input.err { border-color:#b3261e; }
.ptf-error { color:#b3261e; font-size:12.5px; margin-top:10px; }

.ptf-rules { font-size:13.5px; line-height:1.8; padding-left:20px; margin-bottom:20px; color:var(--ptf-text); }
.ptf-check-row { display:flex; align-items:flex-start; gap:10px; font-size:13.5px; background:var(--ptf-soft); padding:14px; border-radius:9px; cursor:pointer; color:var(--ptf-text); }
.ptf-check-row input { margin-top:2px; width:16px; height:16px; accent-color:${COLORS.purple}; }

.ptf-checklist { display:flex; flex-direction:column; gap:12px; }
.ptf-check-item { display:flex; align-items:center; gap:12px; flex-wrap:wrap; font-size:13.5px; padding:12px 14px; background:var(--ptf-bg); border:1px solid var(--ptf-border); border-radius:9px; }
.ptf-dot { width:20px; height:20px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:800; flex-shrink:0; }
.ptf-dot.ok { background:#e3f5e8; color:#1e7a34; animation:dotPop .3s ease; }
.ptf-dot.pending { background:var(--ptf-soft); color:${COLORS.purple}; }
.ptf-dot.error { background:#fbe4e2; color:#b3261e; }
.ptf-check-hint { display:flex; align-items:center; gap:8px; font-size:12px; color:#b3261e; flex-basis:100%; }
.ptf-audio-confirm { display:flex; align-items:center; gap:8px; font-size:12.5px; color:var(--ptf-muted); flex-basis:100%; }
.ptf-mini-btn { font-family:inherit; font-size:12px; font-weight:700; padding:6px 12px; border-radius:7px; border:1.5px solid ${COLORS.purple}; background:${COLORS.purple}; color:#fff; cursor:pointer; }
.ptf-mini-btn.ghost { background:transparent; color:${COLORS.purple}; }
.ptf-mini-btn:hover { opacity:.85; }
@keyframes dotPop { from { transform:scale(0.5); opacity:0; } to { transform:scale(1); opacity:1; } }
.spin-icon { animation:spin .8s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }

.ptf-nav { display:flex; justify-content:space-between; margin-top:26px; }
.ptf-btn { display:flex; align-items:center; gap:7px; padding:11px 22px; border-radius:9px; font-size:13.5px; font-weight:700; cursor:pointer; border:1.5px solid transparent; font-family:inherit; transition:background-color .15s ease, opacity .15s ease, transform .1s ease; }
.ptf-btn:active { transform:scale(0.97); }
.ptf-btn.primary { background:${COLORS.purple}; color:#fff; box-shadow:0 7px 16px rgba(91,80,230,.2); }
.ptf-btn.primary:hover:not(:disabled) { background:${COLORS.purpleHover}; }
.ptf-btn.primary:disabled { opacity:.4; cursor:not-allowed; }
.ptf-btn.ghost { background:transparent; color:var(--ptf-text); border-color:var(--ptf-border); }
.ptf-btn.ghost:disabled { opacity:.35; cursor:not-allowed; }

.ptf-footer-note { position:relative; z-index:1; color:var(--ptf-muted); font-size:11px; margin-top:22px; }

@media (max-width: 560px) {
  .ptf-orbit { left:-320px; top:-160px; }
  .ptf-card { padding:26px 22px 22px; }
}
`;