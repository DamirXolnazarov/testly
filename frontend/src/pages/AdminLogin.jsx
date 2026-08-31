import React, { useState, useRef, useEffect } from "react";
import { Lock, Loader2 } from "lucide-react";
import { setToken } from "../lib/adminApi";
import { COLORS } from "../lib/theme";

/**
 * AdminLogin.jsx — gates AdminDashboard.jsx. On success, stores the JWT
 * (via adminApi.setToken) and calls onSuccess() so the parent can swap to
 * the dashboard. No "forgot password" / registration flow — admins are
 * created via backend/scripts/create-admin.js, matching the no-public-
 * registration decision in routes/auth.js.
 */

export default function AdminLogin({ onSuccess }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const emailRef = useRef(null);

  useEffect(() => {
    emailRef.current?.focus();
    setDarkMode(window.localStorage.getItem("testly-theme") === "dark");
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Login failed.");
      setToken(data.token);
      onSuccess(data.admin);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`al-root ${darkMode ? "dark" : ""}`}>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="al-orbit" />
      <div className="al-dots" />
      <header className="al-header">
        <img src={darkMode ? "/images/testly-logo-light.png" : "/images/testly-logo.png"} alt="Testly" />
        <span>ADMIN ACCESS</span>
      </header>
      <form className="al-card" onSubmit={submit}>
        <div className="al-icon"><Lock size={19} /></div>
        <p className="al-kicker">WELCOME BACK</p>
        <h1>Sign in to Testly</h1>
        <p className="al-sub">Sign in to manage exams and test sessions.</p>

        <label className="al-label">Email</label>
        <input
          ref={emailRef}
          className="al-input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          required
        />

        <label className="al-label">Password</label>
        <input
          className="al-input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />

        {error && <div className="al-error">{error}</div>}

        <button className="al-btn" type="submit" disabled={loading}>
          {loading ? <Loader2 size={15} className="spin-icon" /> : null}
          {loading ? "Signing in…" : "Sign in"}
        </button>
        <p className="al-footer-note">Secure workspace for test coordinators</p>
        <p className="al-footer-note">
          Don't have an account? <a href="/request-access" className="al-request-link">Request access</a>
        </p>
      </form>
      <footer className="al-page-footer">© {new Date().getFullYear()} Testly</footer>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800;900&display=swap');
* { box-sizing:border-box; }
html, body, #__next { width:100%; min-height:100%; margin:0; }
.al-root { --al-bg:#f7f8fc; --al-surface:#fff; --al-border:#e7e8f2; --al-text:#111d40; --al-muted:#697087; --al-soft:#eeecfd; min-height:100vh; position:relative; overflow-x:hidden; display:flex; align-items:center; justify-content:center; background:var(--al-bg); color:var(--al-text); font-family:"Poppins",-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; transition:background-color .35s ease, color .35s ease; }
.al-root.dark { --al-bg:#141725; --al-surface:#202438; --al-border:#343952; --al-text:#f5f6ff; --al-muted:#aeb4ca; --al-soft:#302d5b; }
.al-header { position:absolute; top:28px; left:48px; right:48px; display:flex; align-items:center; justify-content:space-between; z-index:1; }
.al-header img { width:150px; }
.al-header span { color:var(--al-muted); font-size:10px; font-weight:700; letter-spacing:1.5px; }
.al-orbit { position:absolute; width:520px; height:520px; left:-310px; top:50%; transform:translateY(-50%); border:90px solid var(--al-soft); border-radius:50%; opacity:.72; }
.al-dots { position:absolute; right:72px; bottom:94px; width:82px; height:82px; opacity:.55; background-image:radial-gradient(#9c93f5 1.8px, transparent 1.8px); background-size:18px 18px; }
.al-card { position:relative; z-index:1; width:390px; background:var(--al-surface); border:1px solid var(--al-border); border-radius:18px; padding:34px 32px 26px; display:flex; flex-direction:column; box-shadow:0 18px 60px rgba(17,29,64,.08); animation:alIn .35s ease; transition:background-color .35s ease, border-color .35s ease, box-shadow .35s ease; }
@keyframes alIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
.al-icon { width:40px; height:40px; border-radius:11px; background:${COLORS.purple}; color:#fff; display:flex; align-items:center; justify-content:center; margin-bottom:22px; box-shadow:0 7px 16px rgba(91,80,230,.22); }
.al-kicker { color:${COLORS.purple}; font-size:10px; font-weight:800; letter-spacing:1.4px; margin:0 0 8px; }
.al-card h1 { font-size:25px; line-height:1.15; letter-spacing:-.5px; margin:0 0 7px; }
.al-sub { font-size:13px; line-height:1.5; color:var(--al-muted); margin:0 0 27px; }
.al-label { font-size:11.5px; font-weight:700; color:var(--al-text); margin-bottom:7px; }
.al-input { width:100%; padding:12px 13px; background:transparent; color:var(--al-text); border:1.5px solid var(--al-border); border-radius:9px; font:inherit; font-size:13.5px; margin-bottom:17px; transition:border-color .15s ease, box-shadow .15s ease, background-color .35s ease; }
.al-input:focus { outline:none; border-color:${COLORS.purple}; box-shadow:0 0 0 3px rgba(91,80,230,.12); }
.al-error { background:#fdeceb; color:#b3261e; font-size:12.5px; padding:9px 12px; border-radius:7px; margin-bottom:14px; }
.al-btn { display:flex; align-items:center; justify-content:center; gap:8px; background:${COLORS.purple}; color:#fff; border:none; padding:12px; border-radius:9px; font:inherit; font-size:13px; font-weight:700; cursor:pointer; box-shadow:0 7px 16px rgba(91,80,230,.2); transition:background-color .15s ease, opacity .15s ease, transform .15s ease; }
.al-btn:hover { background:${COLORS.purpleHover}; transform:translateY(-1px); }
.al-btn:disabled { opacity:.6; cursor:not-allowed; }
.al-footer-note { color:var(--al-muted); font-size:11px; text-align:center; margin:21px 0 0; }
.al-request-link { color:var(--al-text); font-weight:700; text-decoration:none; }
.al-request-link:hover { color:#5B50E6; }
.al-page-footer { position:absolute; bottom:24px; color:var(--al-muted); font-size:11px; }
.spin-icon { animation:spin .8s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
@media (max-width: 520px) { .al-header { left:24px; right:24px; top:20px; } .al-header img { width:125px; } .al-card { width:calc(100% - 40px); padding:28px 24px 22px; } .al-orbit { left:-360px; } .al-dots { right:22px; bottom:72px; } }
`;