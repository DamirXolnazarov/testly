/**
 * request-access.js
 * Public form for a center to request an admin account. Submits to
 * POST /api/admin-requests (backend/src/routes/adminRequests.js) — this
 * only ever creates a pending request; a real account is created solely
 * when the request is approved via the one-click link sent to
 * ADMIN_NOTIFY_EMAIL, never by anything reachable from this page.
 */
import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, CheckCircle2 } from "lucide-react";
import { COLORS } from "../lib/theme";

const TEST_TYPES = [
  { id: "ielts", label: "IELTS" },
  { id: "sat", label: "SAT" },
];

export default function RequestAccess() {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [organization, setOrganization] = useState("");
  const [testTypes, setTestTypes] = useState([]);
  const [otherTestType, setOtherTestType] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const toggleType = (id) => {
    setTestTypes((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));
  };

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (testTypes.length === 0 && !otherTestType.trim()) {
      setError("Select at least one test type, or describe what you need.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fullName, email, organization, testTypes, otherTestType }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Something went wrong. Please try again.");
      }
      setDone(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ra-root">
      <style dangerouslySetInnerHTML={{ __html: `
        html, body, #__next { width:100%; min-height:100%; margin:0; }
        *, *::before, *::after { box-sizing:border-box; }
        .ra-root { min-height:100dvh; background:${COLORS.bg}; font-family:"Poppins",sans-serif; color:${COLORS.navy}; }
        .ra-header { display:flex; align-items:center; gap:10px; padding:20px clamp(20px, 5vw, 56px); border-bottom:1px solid ${COLORS.border}; background:#fff; }
        .ra-back { display:flex; align-items:center; gap:6px; color:${COLORS.navyMuted}; text-decoration:none; font-size:13.5px; font-weight:600; }
        .ra-back:hover { color:${COLORS.purple}; }
        .ra-body { max-width:560px; margin:0 auto; padding:clamp(28px, 6vw, 52px) 20px 80px; }
        .ra-body h1 { font-size:clamp(24px, 5vw, 30px); font-weight:800; margin:0 0 8px; text-align:center; }
        .ra-sub { font-size:14px; color:${COLORS.navyMuted}; text-align:center; margin:0 0 8px; line-height:1.6; }
        .ra-links { display:flex; justify-content:center; gap:16px; font-size:13px; margin:0 0 32px; }
        .ra-links a { color:${COLORS.purple}; text-decoration:none; font-weight:600; }
        .ra-card { background:#fff; border:1px solid ${COLORS.border}; border-radius:14px; padding:28px; }
        .ra-label { display:block; font-size:12.5px; font-weight:700; color:${COLORS.navyMuted}; margin:16px 0 6px; }
        .ra-label:first-child { margin-top:0; }
        .ra-input { width:100%; padding:11px 13px; border:1px solid ${COLORS.border}; border-radius:9px; font-size:14px; font-family:inherit; color:${COLORS.navy}; background:#fff; }
        .ra-input:focus { outline:none; border-color:${COLORS.purple}; }
        .ra-checks { display:flex; gap:10px; flex-wrap:wrap; }
        .ra-check { display:flex; align-items:center; gap:8px; border:1px solid ${COLORS.border}; border-radius:9px; padding:10px 14px; cursor:pointer; font-size:13.5px; font-weight:600; user-select:none; }
        .ra-check.active { border-color:${COLORS.purple}; background:${COLORS.purpleSoft}; color:${COLORS.purple}; }
        .ra-submit { width:100%; margin-top:22px; background:${COLORS.purple}; color:#fff; border:none; border-radius:9px; padding:13px; font-size:14.5px; font-weight:700; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; font-family:inherit; }
        .ra-submit:hover { background:#4A40D6; }
        .ra-submit:disabled { opacity:.6; cursor:not-allowed; }
        .ra-error { background:#fdeceb; color:#b3261e; font-size:13px; padding:10px 13px; border-radius:8px; margin-top:16px; }
        .ra-done { text-align:center; padding:20px 10px; }
        .ra-done svg { color:#1e7a34; margin-bottom:12px; }
        .ra-done h2 { font-size:19px; margin:0 0 8px; }
        .ra-done p { font-size:14px; color:${COLORS.navyMuted}; line-height:1.6; }
        .spin-icon { animation:ra-spin 0.8s linear infinite; }
        @keyframes ra-spin { to { transform:rotate(360deg); } }
      ` }} />

      <header className="ra-header">
        <Link href="/" className="ra-back"><ArrowLeft size={15} /> Back to Testly</Link>
      </header>

      <div className="ra-body">
        <h1>Request admin access</h1>
        <p className="ra-sub">
          Tell us a bit about your organization and we'll set up your admin account.
        </p>
        <div className="ra-links">
          <Link href="/about">Learn what Testly does</Link>
          <Link href="/docs">Exam JSON schema</Link>
        </div>

        <div className="ra-card">
          {done ? (
            <div className="ra-done">
              <CheckCircle2 size={40} />
              <h2>Request sent</h2>
              <p>We'll review it and email your login credentials to <strong>{email}</strong> once approved.</p>
            </div>
          ) : (
            <form onSubmit={submit}>
              <label className="ra-label">Full name</label>
              <input className="ra-input" value={fullName} onChange={(e) => setFullName(e.target.value)} required />

              <label className="ra-label">Email</label>
              <input className="ra-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />

              <label className="ra-label">Organization</label>
              <input className="ra-input" value={organization} onChange={(e) => setOrganization(e.target.value)} placeholder="Your school or test center's name" required />

              <label className="ra-label">Test types needed</label>
              <div className="ra-checks">
                {TEST_TYPES.map((t) => (
                  <div
                    key={t.id}
                    className={`ra-check ${testTypes.includes(t.id) ? "active" : ""}`}
                    onClick={() => toggleType(t.id)}
                  >
                    {t.label}
                  </div>
                ))}
              </div>
              <input
                className="ra-input"
                style={{ marginTop: 10 }}
                placeholder="Other (optional) — describe what you need"
                value={otherTestType}
                onChange={(e) => setOtherTestType(e.target.value)}
              />

              {error && <div className="ra-error">{error}</div>}

              <button className="ra-submit" type="submit" disabled={submitting}>
                {submitting && <Loader2 size={15} className="spin-icon" />}
                {submitting ? "Sending…" : "Send request"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
