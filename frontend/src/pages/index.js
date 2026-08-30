import Link from "next/link";
import { useEffect, useState } from "react";
import { LayoutGrid, User, FileText, Moon, Sun } from "lucide-react";
import { COLORS as BASE_COLORS } from "../lib/theme";

const COLORS = { ...BASE_COLORS, textMuted: BASE_COLORS.navyMuted };

export default function Home() {
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => {
    setDarkMode(window.localStorage.getItem("testly-theme") === "dark");
  }, []);

  const toggleTheme = () => {
    setDarkMode((current) => {
      const next = !current;
      window.localStorage.setItem("testly-theme", next ? "dark" : "light");
      return next;
    });
  };

  return (
    <div className={`lp-root ${darkMode ? "dark" : ""}`}>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <div className="lp-circle" />
      <div className="lp-dots">
        {Array.from({ length: 16 }).map((_, index) => <span key={index} />)}
      </div>
      <div className="lp-triangle" />

      <header className="lp-header">
        <div className="lp-logo">
          <img src={darkMode ? "/images/testly-logo-light.png" : "/images/testly-logo.png"} alt="Testly" />
        </div>
        <div className="lp-header-actions">
          <button
            className="lp-theme-toggle"
            onClick={toggleTheme}
            aria-label={`Switch to ${darkMode ? "light" : "dark"} mode`}
            title={`Switch to ${darkMode ? "light" : "dark"} mode`}
          >
            <span className="lp-theme-thumb">{darkMode ? <Moon size={13} /> : <Sun size={13} />}</span>
          </button>
          <a className="lp-doc-btn" href="/docs/exam-json-schema.md" target="_blank" rel="noopener noreferrer">
            <FileText size={15} /> Documentation
          </a>
        </div>
      </header>

      <main className="lp-hero">
        <span className="lp-badge">IELTS</span>
        <h1>
          <span className="lp-hero-lead">Run better</span><br />
          <span className="lp-hero-main">IELTS mock exams<span className="lp-dot">.</span></span>
        </h1>
        <p className="lp-sub">
          Testly is the all-in-one platform for educational centers to
          create, manage and run IELTS mock tests with confidence.
        </p>

        <div className="lp-cards">
          <div className="lp-card">
            <div className="lp-card-icon"><LayoutGrid size={22} /></div>
            <span className="lp-card-eyebrow">FOR CENTERS</span>
            <h2>Admin Portal</h2>
            <p>Create exams, manage students, and run live sessions.</p>
            <Link href="/admin" className="lp-btn primary">
              Go to Admin Portal
            </Link>
          </div>

          <div className="lp-card">
            <div className="lp-card-icon"><User size={22} /></div>
            <span className="lp-card-eyebrow">FOR STUDENTS</span>
            <h2>Take a Test</h2>
            <p>Enter your start code and take your IELTS mock test.</p>
            <Link href="/exam" className="lp-btn ghost">
              Go to Test
            </Link>
          </div>
        </div>
      </main>

      <footer className="lp-footer">
        <div className="lp-logo lp-logo-footer">
          <img src="/images/testly-logo-light.png" alt="Testly" />
        </div>
        <span className="lp-footer-copy">© {new Date().getFullYear()} Testly. All rights reserved.</span>
        <span className="lp-footer-tag">Built for educational excellence.</span>
      </footer>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800;900&display=swap');
* { box-sizing: border-box; }
html, body, #__next { width:100%; min-height:100%; margin:0; }
.lp-root { --lp-bg:${COLORS.bg}; --lp-surface:#fff; --lp-border:${COLORS.border}; --lp-text:${COLORS.navy}; --lp-muted:${COLORS.textMuted}; --lp-soft:${COLORS.purpleSoft}; --lp-footer:${COLORS.navy}; position:relative; width:100%; min-height:100dvh; background:var(--lp-bg); font-family:"Poppins",sans-serif; color:var(--lp-text); overflow-x:hidden; display:flex; flex-direction:column; transition:background-color .35s ease, color .35s ease; }
.lp-root.dark { --lp-bg:#141725; --lp-surface:#202438; --lp-border:#343952; --lp-text:#f5f6ff; --lp-muted:#aeb4ca; --lp-soft:#302d5b; --lp-footer:#0d1020; }
.lp-circle { position:absolute; left:-260px; top:23.5vh; width:450px; height:450px; border:90px solid #F1F0FC; border-radius:50%; z-index:0; }
.lp-root.dark .lp-circle { border-color:#242741; }
.lp-dots { position:absolute; top:134px; right:38px; display:grid; grid-template-columns:repeat(4, 1fr); gap:18px; z-index:0; }
.lp-dots span { width:4px; height:4px; border-radius:50%; background:${COLORS.purple}; opacity:.35; }
.lp-triangle { position:absolute; right:0; bottom:0; width:480px; height:501px; background:${COLORS.purple}; clip-path:polygon(100% 0, 100% 100%, 0 100%); z-index:0; }
.lp-header { position:relative; z-index:2; display:flex; align-items:center; justify-content:space-between; padding:10px 56px; }
.lp-logo { display:flex; align-items:center; gap:9px; font-size:19px; font-weight:800; letter-spacing:-.2px; }
.lp-header .lp-logo img { width:220px; }
.lp-header-actions { display:flex; align-items:center; gap:10px; }
.lp-theme-toggle { position:relative; width:44px; height:25px; padding:3px; border:1px solid var(--lp-border); border-radius:999px; background:var(--lp-soft); cursor:pointer; transition:background-color .35s ease, border-color .35s ease; }
.lp-theme-thumb { display:flex; align-items:center; justify-content:center; width:17px; height:17px; border-radius:50%; background:${COLORS.purple}; color:#fff; transform:translateX(0); transition:transform .3s cubic-bezier(.4,0,.2,1), background-color .3s ease; }
.lp-root.dark .lp-theme-thumb { transform:translateX(17px); background:#8d87ff; }
.lp-doc-btn { display:flex; align-items:center; gap:7px; background:var(--lp-surface); border:1px solid var(--lp-border); color:var(--lp-text); font-size:13px; font-weight:600; padding:9px 16px; border-radius:9px; text-decoration:none; transition:border-color .15s ease, box-shadow .15s ease, background-color .35s ease, color .35s ease; }
.lp-doc-btn:hover { border-color:${COLORS.purple}; box-shadow:0 2px 8px rgba(91,80,230,.12); }
.lp-hero { position:relative; z-index:2; flex:1 0 auto; display:flex; flex-direction:column; align-items:center; text-align:center; padding:clamp(28px, 8vh, 64px) 24px; }
.lp-badge { display:inline-block; background:${COLORS.purpleSoft}; color:${COLORS.purple}; font-size:11.5px; font-weight:800; letter-spacing:.5px; padding:6px 16px; border-radius:20px; margin-bottom:24px; animation:lpFadeIn .5s ease; }
.lp-hero h1 { font-size:64px; line-height:1; font-weight:800; letter-spacing:0; margin:0 0 24px; animation:lpFadeIn .6s ease .05s both; }
.lp-hero-lead { display:inline-block; }
.lp-hero-main { display:inline-block; }
.lp-dot { color:${COLORS.purple}; }
.lp-sub { max-width:520px; font-size:16px; line-height:1.6; color:var(--lp-muted); margin:0 0 44px; animation:lpFadeIn .6s ease .1s both; }
@keyframes lpFadeIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
.lp-cards { display:flex; gap:24px; max-width:900px; width:100%; animation:lpFadeIn .6s ease .15s both; }
.lp-card { flex:1; background:var(--lp-surface); border:1px solid var(--lp-border); border-radius:16px; padding:32px 28px; text-align:left; display:flex; flex-direction:column; box-shadow:0 1px 3px rgba(17,29,64,.04); transition:transform .2s ease, box-shadow .2s ease, background-color .35s ease, border-color .35s ease; }
.lp-card:hover { transform:translateY(-2px); box-shadow:0 10px 28px rgba(17,29,64,.08); }
.lp-card-icon { width:52px; height:52px; border-radius:14px; background:${COLORS.purpleSoft}; color:${COLORS.purple}; display:flex; align-items:center; justify-content:center; margin-bottom:18px; }
.lp-card-eyebrow { font-size:11px; font-weight:800; letter-spacing:.6px; color:${COLORS.purple}; margin-bottom:6px; }
.lp-card h2 { font-size:22px; font-weight:800; margin:0 0 10px; letter-spacing:-.3px; }
.lp-card p { font-size:14px; line-height:1.6; color:var(--lp-muted); margin:0 0 26px; flex:1; transition:color .35s ease; }
.lp-btn { display:flex; align-items:center; justify-content:center; gap:8px; font-size:14.5px; font-weight:700; padding:13px 20px; border-radius:10px; text-decoration:none; transition:background-color .15s ease, transform .1s ease, box-shadow .15s ease; }
.lp-btn:active { transform:scale(0.98); }
.lp-btn.primary { background:${COLORS.purple}; color:#fff; box-shadow:0 4px 14px rgba(91,80,230,.28); }
.lp-btn.primary:hover { background:#4a40d6; }
.lp-btn.ghost { background:var(--lp-surface); color:${COLORS.purple}; border:1px solid var(--lp-border); }
.lp-btn.ghost:hover { border-color:${COLORS.purple}; background:${COLORS.purpleSoft}; }
.lp-footer { position:relative; z-index:2; margin-top:auto; background:var(--lp-footer); color:#fff; display:flex; align-items:center; justify-content:space-between; padding:4px 56px; flex-wrap:wrap; gap:12px; transition:background-color .35s ease; }
.lp-logo-footer img { width:100px; height:50px; }
.lp-footer-copy { font-size:12.5px; color:#B7BBD6; }
.lp-footer-tag { font-size:12.5px; color:#B7BBD6; }
@media (max-width: 720px) {
  .lp-hero h1 { font-size:42px; letter-spacing:-1.5px; }
  .lp-cards { flex-direction:column; }
  .lp-header { padding:10px 24px; }
  .lp-footer { padding:4px 24px; }
  .lp-header-actions { gap:7px; }
  .lp-doc-btn { padding:9px 11px; }
  .lp-triangle { width:100%; height:52vh; }
}
`;