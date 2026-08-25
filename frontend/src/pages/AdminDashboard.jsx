import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  LayoutGrid, Plus, Play, Square, Clock, Users, FileText,
  CheckCircle2, Circle, Copy, ExternalLink, X, Loader2,
  BookOpen, Headphones, PenLine, Search, LogOut, DoorOpen,
  UploadCloud, FileJson, Download, Check, BarChart3, GraduationCap,
  Settings, ClipboardList, UserRound, Save, Camera, ImagePlus, Music,
} from "lucide-react";
import { adminFetch, clearToken, setToken } from "../lib/adminApi";
import AdminLogin from "./AdminLogin";
import AdminTestRoom from "./AdminTestRoom";

/**
 * AdminDashboard.jsx — the moderator-facing app: create/manage exams, run
 * live test-day moderation (AdminTestRoom.jsx), and review completed tests.
 *
 * Wired to real endpoints from backend/src/routes/exams.js:
 *   GET    /api/exams
 *   POST   /api/exams              (raw JSON matching docs/exam-json-schema.md)
 *   POST   /api/exams/:id/start    (activates the start code — does NOT
 *                                    start any student's clock; see AdminTestRoom)
 *   POST   /api/exams/:id/stop
 *   GET    /api/exams/:id/sessions
 *   GET    /api/exams/:id/roster   (used by AdminTestRoom)
 *   POST   /api/uploads            (used by CreateExamModal's "Upload media"
 *                                    tab — audio/image assets for exam JSON)
 *
 * No auth wired yet (matches the backend's current state) — every admin sees
 * every exam. Fine for a single-center pilot; needs a center_id scope once
 * multi-tenant auth exists (see store.js schema.sql comments).
 */

const SECTION_ICON = { reading: BookOpen, listening: Headphones, writing: PenLine };

// Top-level export: gates the real dashboard behind AdminLogin, checking any
// stored token against GET /api/auth/me on mount so a stale/expired token
// bounces back to login instead of showing a broken dashboard.
export default function AdminDashboardGate() {
  const [authState, setAuthState] = useState("checking"); // checking | out | in
  const [admin, setAdmin] = useState(null);

  useEffect(() => {
    adminFetch("/api/auth/me")
      .then((data) => { setAdmin(data.admin); setAuthState("in"); })
      .catch(() => setAuthState("out"));
  }, []);

  if (authState === "checking") {
    return <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "sans-serif", color: "#999", fontSize: 13 }}>Loading…</div>;
  }
  if (authState === "out") {
    return <AdminLogin onSuccess={(a) => { setAdmin(a); setAuthState("in"); }} />;
  }
  return <AdminDashboard admin={admin} onAdminUpdated={setAdmin} onLogout={() => { clearToken(); setAuthState("out"); }} />;
}

function AdminDashboard({ admin, onAdminUpdated, onLogout }) {
  const [view, setView] = useState("exams"); // "exams" | "sessions" | "testroom" | "profile"
  const [selectedExam, setSelectedExam] = useState(null);
  const [exams, setExams] = useState(null); // null = loading
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [profilePhoto, setProfilePhoto] = useState("");

  useEffect(() => {
    setProfilePhoto(window.localStorage.getItem("testly-profile-photo") || "");
  }, []);

  const loadExams = useCallback(async () => {
    try {
      const data = await adminFetch("/api/exams", {}, onLogout);
      setExams(data);
    } catch (e) {
      setError(e.message);
      setExams([]);
    }
  }, [onLogout]);

  useEffect(() => { loadExams(); }, [loadExams]);

  const openSessions = (exam) => {
    setSelectedExam(exam);
    setView("sessions");
  };

  const openTestRoom = (exam) => {
    setSelectedExam(exam);
    setView("testroom");
  };

  const filtered = (exams || []).filter((e) =>
    e.title.toLowerCase().includes(search.toLowerCase()) &&
    (statusFilter === "all" || e.status === statusFilter)
  );
  const counts = (exams || []).reduce((result, exam) => {
    result.total += 1;
    result[exam.status] = (result[exam.status] || 0) + 1;
    return result;
  }, { total: 0, draft: 0, active: 0, closed: 0 });

  return (
    <div className="ad-root">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <Sidebar view={view} setView={(v) => { setView(v); setSelectedExam(null); }} admin={admin} profilePhoto={profilePhoto} onLogout={onLogout} />

      <main className="ad-main">
        {view === "exams" && (
          <>
            <div className="ad-topbar">
              <div>
                <h1>Exams</h1>
                <p className="ad-sub">Create mock tests and manage active test sessions.</p>
              </div>
              <button className="ad-btn primary" onClick={() => setShowCreate(true)}>
                <Plus size={16} /> New exam
              </button>
            </div>

            <div className="ad-stats">
              <Stat icon={ClipboardList} label="Total exams" value={counts.total} cls="violet" />
              <Stat icon={BarChart3} label="Live exams" value={counts.active} cls="green" />
              <Stat icon={FileText} label="Drafts" value={counts.draft} cls="amber" />
              <Stat icon={CheckCircle2} label="Closed" value={counts.closed} cls="slate" />
            </div>

            <div className="ad-toolbar">
              <div className="ad-search">
                <Search size={15} />
                <input placeholder="Search exams…" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <select className="ad-filter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter exams by status">
                <option value="all">All statuses</option>
                <option value="active">Live</option>
                <option value="draft">Draft</option>
                <option value="closed">Closed</option>
              </select>
            </div>

            {error && <div className="ad-error">{error}</div>}

            {exams === null ? (
              <LoadingGrid />
            ) : filtered.length === 0 ? (
              <EmptyState onCreate={() => setShowCreate(true)} hasSearch={!!search} />
            ) : (
              <div className="ad-grid">
                {filtered.map((exam) => (
                  <ExamCard
                    key={exam.examId}
                    exam={exam}
                    onChanged={loadExams}
                    onOpenSessions={openSessions}
                    onOpenTestRoom={openTestRoom}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {view === "sessions" && selectedExam && (
          <SessionsView exam={selectedExam} onBack={() => setView("exams")} />
        )}

        {view === "testroom" && selectedExam && (
          <AdminTestRoom exam={selectedExam} onBack={() => setView("exams")} />
        )}

        {view === "profile" && (
          <ProfileView admin={admin} profilePhoto={profilePhoto} onPhotoChanged={setProfilePhoto} onUpdated={onAdminUpdated} />
        )}
      </main>

      {showCreate && (
        <CreateExamModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); loadExams(); }}
        />
      )}
    </div>
  );
}

function Stat({ icon: Icon, label, value, cls }) {
  return <div className={`ad-stat ${cls}`}><div className="ad-stat-icon"><Icon size={18} /></div><div><span>{label}</span><strong>{value}</strong></div></div>;
}

function ProfileView({ admin, profilePhoto, onPhotoChanged, onUpdated }) {
  const [fullName, setFullName] = useState(admin?.fullName || "");
  const [email, setEmail] = useState(admin?.email || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const initials = (fullName || email || "A").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();

  const choosePhoto = (event) => {
    const file = event.target.files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const photo = reader.result;
      window.localStorage.setItem("testly-profile-photo", photo);
      onPhotoChanged(photo);
    };
    reader.readAsDataURL(file);
  };

  const saveProfile = async (event) => {
    event.preventDefault();
    setError("");
    setMessage("");
    setSaving(true);
    try {
      const data = await adminFetch("/api/auth/me", {
        method: "PATCH",
        body: JSON.stringify({
          fullName,
          email,
          ...(newPassword ? { currentPassword, newPassword } : {}),
        }),
      });
      setToken(data.token);
      onUpdated(data.admin);
      setCurrentPassword("");
      setNewPassword("");
      setMessage("Profile updated successfully.");
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ad-profile-page">
      <div className="ad-topbar">
        <div><h1>Profile</h1><p className="ad-sub">Manage your account details and sign-in security.</p></div>
      </div>
      <form className="ad-profile-form" onSubmit={saveProfile}>
        <section className="ad-profile-hero">
          <label className="ad-photo-picker" title="Choose a profile photo">
            {profilePhoto ? <img src={profilePhoto} alt="Profile" /> : <span>{initials}</span>}
            <span className="ad-photo-camera"><Camera size={13} /></span>
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={choosePhoto} />
          </label>
          <div><h2>{fullName || "Administrator"}</h2><p>{email}</p></div>
        </section>
        <div className="ad-profile-section"><h3>Account details</h3><p className="ad-profile-help">These details identify you in the Testly workspace.</p>
          <div className="ad-profile-fields"><label>Full name<input value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Your full name" /></label><label>Email address<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label></div>
        </div>
        <div className="ad-profile-section"><h3>Password</h3><p className="ad-profile-help">Leave these fields blank to keep your current password.</p>
          <div className="ad-profile-fields"><label>Current password<input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" /></label><label>New password<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={8} autoComplete="new-password" /></label></div>
        </div>
        <div className="ad-profile-actions">
          {(error || message) && <div className={`ad-profile-status ${error ? "error" : "success"}`}>{error || message}</div>}
          <button className="ad-btn primary" type="submit" disabled={saving}>{saving ? <Loader2 size={15} className="spin-icon" /> : <Save size={15} />}{saving ? "Saving…" : "Save changes"}</button>
        </div>
      </form>
    </div>
  );
}

// ---------------- Sidebar ----------------
function Sidebar({ view, setView, admin, profilePhoto, onLogout }) {
  const initials = (admin?.fullName || admin?.email || "A").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  return (
    <aside className="ad-sidebar">
      <div className="ad-logo"><img src="/images/testly-logo-light.png" alt="Testly" /><span>Admin</span></div>
      <div className="ad-nav-label">DASHBOARD</div>
      <nav>
        <button className={`ad-nav-item ${view === "exams" ? "active" : ""}`} onClick={() => setView("exams")}>
          <LayoutGrid size={17} /> Exams
        </button>
        <button className="ad-nav-item muted" disabled><GraduationCap size={17} /> Students</button>
        <button className="ad-nav-item muted" disabled><BarChart3 size={17} /> Reports</button>
      </nav>
      <div className="ad-nav-label ad-nav-label-manage">MANAGE</div>
      <nav>
        <button className="ad-nav-item muted" disabled><Settings size={17} /> Settings</button>
      </nav>
      <div className="ad-sidebar-footer">
        <button className={`ad-profile-link ${view === "profile" ? "active" : ""}`} onClick={() => setView("profile")}>
          <span className="ad-avatar">{profilePhoto ? <img src={profilePhoto} alt="" /> : initials}</span>
          <span className="ad-profile-copy"><strong>{admin?.fullName || "Administrator"}</strong><small title={admin?.email}>{admin?.email}</small></span>
          <UserRound size={14} />
        </button>
        <button className="ad-nav-item logout" onClick={onLogout}>
          <LogOut size={16} /> Log out
        </button>
      </div>
    </aside>
  );
}

// ---------------- Exam card ----------------
function ExamCard({ exam, onChanged, onOpenSessions, onOpenTestRoom }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Draft -> tapping "Start test" activates the code AND opens the live room
  // in one motion, since a moderator who starts a test obviously wants to be
  // in the room watching for waiting students right after.
  const startAndOpen = async () => {
    setBusy(true);
    try {
      await adminFetch(`/api/exams/${exam.examId}/start`, { method: "POST" });
      await onChanged();
      onOpenTestRoom({ ...exam, status: "active" });
    } catch {
      // swallow — could show a toast; kept minimal here
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await adminFetch(`/api/exams/${exam.examId}/stop`, { method: "POST" });
      onChanged();
    } catch {
      // swallow
    } finally {
      setBusy(false);
    }
  };

  const copyCode = () => {
    navigator.clipboard?.writeText(exam.startCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className={`ad-card status-${exam.status}`}>
      <div className="ad-card-head">
        <StatusBadge status={exam.status} />
        <div className="ad-card-sections">
          {exam.sectionTypes.map((t) => {
            const Ico = SECTION_ICON[t];
            return Ico ? <Ico key={t} size={14} className="ad-section-ico" /> : null;
          })}
        </div>
      </div>

      <h3 className="ad-card-title">{exam.title}</h3>

      <button className="ad-code-row" onClick={copyCode} title="Copy start code">
        <span className="ad-code">{exam.startCode}</span>
        <Copy size={13} />
        {copied && <span className="ad-copied">Copied</span>}
      </button>

      <div className="ad-card-footer">
        <button className="ad-btn ghost small" onClick={() => onOpenSessions(exam)}>
          <Users size={14} /> Sessions
        </button>

        {exam.status === "active" ? (
          <div className="ad-card-active-actions">
            <button className="ad-btn ghost small" onClick={stop} disabled={busy} title="Stop test">
              {busy ? <Loader2 size={13} className="spin-icon" /> : <Square size={13} />}
            </button>
            <button className="ad-btn small primary" onClick={() => onOpenTestRoom(exam)}>
              <DoorOpen size={13} /> Test room
            </button>
          </div>
        ) : (
          <button
            className="ad-btn small primary"
            onClick={startAndOpen}
            disabled={busy || exam.status === "closed"}
          >
            {busy ? <Loader2 size={14} className="spin-icon" /> : <><Play size={13} /> Start test</>}
          </button>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    draft: { label: "Draft", cls: "draft" },
    active: { label: "Live", cls: "active" },
    closed: { label: "Closed", cls: "closed" },
  };
  const s = map[status] || map.draft;
  return <span className={`ad-badge ${s.cls}`}>{s.cls === "active" && <span className="ad-pulse" />}{s.label}</span>;
}

// ---------------- Sessions (completed tests) view ----------------
function SessionsView({ exam, onBack }) {
  const [sessions, setSessions] = useState(null);

  useEffect(() => {
    let cancelled = false;
    adminFetch(`/api/exams/${exam.examId}/sessions`)
      .then((data) => !cancelled && setSessions(data))
      .catch(() => !cancelled && setSessions([]));
    return () => { cancelled = true; };
  }, [exam.examId]);

  return (
    <div className="ad-sessions">
      <button className="ad-back" onClick={onBack}>Back to exams</button>
      <div className="ad-topbar">
        <div>
          <h1>{exam.title}</h1>
          <p className="ad-sub">Completed and in-progress sessions for this exam.</p>
        </div>
      </div>

      {sessions === null ? (
        <LoadingGrid rows />
      ) : sessions.length === 0 ? (
        <div className="ad-empty">
          <FileText size={32} />
          <p>No students have started this test yet.</p>
        </div>
      ) : (
        <table className="ad-table">
          <thead>
            <tr>
              <th>Student</th>
              <th>Status</th>
              <th>Reading</th>
              <th>Listening</th>
              <th>Writing / Speaking</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.sessionId}>
                <td className="ad-student">{s.fullName || "—"}</td>
                <td>
                  {s.status === "completed" ? (
                    <span className="ad-inline-badge done"><CheckCircle2 size={13} /> Completed</span>
                  ) : s.status === "pending_admission" ? (
                    <span className="ad-inline-badge pending"><Circle size={13} /> Waiting to be admitted</span>
                  ) : (
                    <span className="ad-inline-badge pending"><Circle size={13} /> In progress</span>
                  )}
                </td>
                <td>{s.results?.reading ? `${s.results.reading.rawScore}/${s.results.reading.total} · Band ${s.results.reading.band}` : "—"}</td>
                <td>{s.results?.listening ? `${s.results.listening.rawScore}/${s.results.listening.total} · Band ${s.results.listening.band}` : "—"}</td>
                <td><span className="ad-manual-tag">Grade in Sheet</span></td>
                <td>
                  {s.sheetUrl ? (
                    <a className="ad-btn ghost small" href={s.sheetUrl} target="_blank" rel="noopener noreferrer">
                      <ExternalLink size={13} /> Open
                    </a>
                  ) : (
                    <button className="ad-btn ghost small" disabled title={s.status === "completed" ? "Sheets write hasn't landed yet — check the exam has a sheetId set" : "Available once this student finishes"}>
                      <ExternalLink size={13} /> Open
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------- Create exam modal ----------------
function CreateExamModal({ onClose, onCreated }) {
  const [mode, setMode] = useState("upload"); // "upload" | "paste" | "generate"
  const [title, setTitle] = useState("");
  const [jsonText, setJsonText] = useState("");
  const [fileName, setFileName] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [topic, setTopic] = useState("");
  const [error, setError] = useState("");
  const [errorDetails, setErrorDetails] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef(null);

  const readFile = (file) => {
    setError("");
    setErrorDetails([]);
    if (!file.name.toLowerCase().endsWith(".json")) {
      setError("That's not a .json file.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setJsonText(reader.result);
      setFileName(file.name);
    };
    reader.onerror = () => setError("Couldn't read that file.");
    reader.readAsText(file);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) readFile(file);
  };

  const submit = async () => {
    setError("");
    setErrorDetails([]);
    setSubmitting(true);
    try {
      if (mode === "upload" || mode === "paste") {
        if (!jsonText.trim()) throw new Error(mode === "upload" ? "Choose a .json file first." : "Paste your exam JSON first.");
        let parsed;
        try {
          parsed = JSON.parse(jsonText);
        } catch {
          throw new Error("That's not valid JSON — check for a trailing comma or missing bracket.");
        }
        if (title.trim()) parsed.title = title.trim();
        await adminFetch("/api/exams", { method: "POST", body: JSON.stringify(parsed) });
      } else {
        await adminFetch("/api/exams/generate", { method: "POST", body: JSON.stringify({ title, topic }) });
      }
      onCreated();
    } catch (e) {
      setError(e.message);
      if (e.details) setErrorDetails(e.details);
    } finally {
      setSubmitting(false);
    }
  };

  // Parse once per jsonText change — reused for both the summary preview
  // AND the media-slot detector below, so they never disagree with each other.
  let parsedJson = null;
  if ((mode === "upload" || mode === "paste") && jsonText.trim()) {
    try { parsedJson = JSON.parse(jsonText); } catch { parsedJson = null; }
  }
  const preview = parsedJson && Array.isArray(parsedJson.sections)
    ? parsedJson.sections.map((s) => {
        const partCount = (s.parts || []).length;
        const qCount = (s.parts || []).reduce((n, p) => n + (p.questions?.length || p.items?.length || 0), 0);
        const hasAudio = s.type === "listening" && (s.parts || []).some((p) => p.audioUrl);
        const hasMap = (s.parts || []).some((p) => (p.questions || []).some((q) => q.type === "map"));
        return { type: s.type, partCount, qCount, hasAudio, hasMap };
      })
    : null;

  // Called by MediaSlotsPanel whenever a file finishes uploading onto a
  // specific slot — writes the returned URL directly into the JSON at that
  // exact path, then re-serializes it back into jsonText. No copy/paste,
  // no admin having to remember which file goes where — the slot IS the
  // destination.
  const applyMediaUrl = (path, url) => {
    if (!parsedJson) return;
    const next = JSON.parse(JSON.stringify(parsedJson)); // deep clone, don't mutate state in place
    let cursor = next;
    for (let i = 0; i < path.length - 1; i++) cursor = cursor[path[i]];
    cursor[path[path.length - 1]] = url;
    setJsonText(JSON.stringify(next, null, 2));
  };

  return (
    <div className="ad-modal-overlay" onMouseDown={onClose}>
      <div className="ad-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ad-modal-head">
          <h2>Create a new exam</h2>
          <button className="ad-iconbtn" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="ad-modal-tabs">
          <button className={mode === "upload" ? "active" : ""} onClick={() => setMode("upload")}>Upload JSON file</button>
          <button className={mode === "paste" ? "active" : ""} onClick={() => setMode("paste")}>Paste JSON</button>
          <button className={mode === "generate" ? "active" : ""} onClick={() => setMode("generate")}>
            AI generate <span className="ad-soon">soon</span>
          </button>
        </div>

        <div className="ad-modal-body">
          <label className="ad-label">Exam title (optional — overrides the JSON's title)</label>
          <input className="ad-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="IELTS Academic Mock Test 12" />

          {mode === "upload" && (
            <>
              <label className="ad-label">Exam JSON file</label>
              <div
                className={`ad-dropzone ${dragOver ? "over" : ""} ${fileName ? "filled" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,application/json"
                  style={{ display: "none" }}
                  onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])}
                />
                {fileName ? (
                  <><FileJson size={22} /><span>{fileName}</span><span className="ad-dropzone-sub">Click to choose a different file</span></>
                ) : (
                  <><UploadCloud size={22} /><span>Drop a .json file here, or click to browse</span></>
                )}
              </div>

              <a
                className="ad-template-link"
                href="/docs/sample-exam-template.json"
                download
                onClick={(e) => e.stopPropagation()}
              >
                <Download size={13} /> Download a starter template (reading + listening w/ audio + map + writing)
              </a>
              <p className="ad-hint">Must match the schema in <code>docs/exam-json-schema.md</code>. Audio/map images can be blank for now — attach them below once the JSON loads.</p>
            </>
          )}

          {mode === "paste" && (
            <>
              <label className="ad-label">Exam JSON</label>
              <textarea
                className="ad-textarea"
                placeholder='{ "title": "...", "sections": [ ... ] }'
                value={jsonText}
                onChange={(e) => { setJsonText(e.target.value); setFileName(""); }}
              />
              <p className="ad-hint">Must match the schema in <code>docs/exam-json-schema.md</code> — a <code>sections[]</code> array with reading/listening/writing entries and answer keys included.</p>
            </>
          )}

          {mode === "generate" && (
            <>
              <label className="ad-label">Topic</label>
              <input className="ad-input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. climate change, urban planning" />
              <p className="ad-hint">
                AI generation isn't implemented yet (<code>examGenerator.js</code> is a stub). Once it's built, it will
                call ElevenLabs during generation and write each part's <code>audioUrl</code> in automatically — the
                per-part attach step below is only needed for manually-built exams like the ones you're testing with now.
              </p>
            </>
          )}

          {parsedJson && (mode === "upload" || mode === "paste") && (
            <MediaSlotsPanel exam={parsedJson} onAttached={applyMediaUrl} />
          )}

          {preview && (
            <div className="ad-preview">
              <div className="ad-preview-title"><Check size={13} /> Valid JSON — {preview.length} section(s)</div>
              {preview.map((s, i) => {
                const Ico = SECTION_ICON[s.type] || FileText;
                return (
                  <div className="ad-preview-row" key={i}>
                    <Ico size={13} />
                    <span className="ad-preview-type">{s.type}</span>
                    <span className="ad-preview-detail">{s.partCount} part(s), {s.qCount} question(s)</span>
                    {s.hasAudio && <span className="ad-preview-tag">audio</span>}
                    {s.hasMap && <span className="ad-preview-tag">map</span>}
                  </div>
                );
              })}
            </div>
          )}

          {error && (
            <div className="ad-error">
              {error}
              {errorDetails.length > 0 && (
                <ul className="ad-error-list">
                  {errorDetails.map((d, i) => <li key={i}>{d}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="ad-modal-footer">
          <button className="ad-btn ghost" onClick={onClose}>Cancel</button>
          <button className="ad-btn primary" onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 size={15} className="spin-icon" /> : null}
            {submitting ? "Creating…" : "Create exam"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------- Media slots panel (inside the New Exam modal) ----------------
// Walks the already-parsed exam JSON and finds every place that needs a
// hosted file — each listening part's audioUrl, each map question's
// imageUrl — and renders a dedicated upload slot for exactly that spot.
// Dropping a file there uploads it (POST /api/uploads) and writes the
// returned URL straight into the JSON via onAttached(path, url) — the admin
// never sees a raw URL to copy or a field name to remember. This only
// matters for manually-built/testing exams; once examGenerator.js calls
// ElevenLabs during AI generation, the AI writes audioUrl itself and this
// panel has nothing to show (no slots detected -> panel renders nothing).
function MediaSlotsPanel({ exam, onAttached }) {
  const slots = [];
  (exam.sections || []).forEach((section, si) => {
    if (section.type === "listening") {
      (section.parts || []).forEach((part, pi) => {
        slots.push({
          key: `audio-${si}-${pi}`,
          kind: "audio",
          label: part.title || `Listening Part ${pi + 1}`,
          currentUrl: part.audioUrl || null,
          path: ["sections", si, "parts", pi, "audioUrl"],
        });
      });
    }
    (section.parts || []).forEach((part, pi) => {
      (part.questions || []).forEach((q, qi) => {
        if (q.type === "map") {
          slots.push({
            key: `map-${si}-${pi}-${qi}`,
            kind: "image",
            label: `${part.title || `Part ${pi + 1}`} — map question ${q.n ?? qi + 1}`,
            currentUrl: q.imageUrl || null,
            path: ["sections", si, "parts", pi, "questions", qi, "imageUrl"],
          });
        }
      });
    });
  });

  if (slots.length === 0) return null;

  return (
    <div className="ad-slots">
      <p className="ad-label" style={{ marginTop: 18 }}>Attach media to this exam</p>
      {slots.map((slot) => (
        <MediaSlot key={slot.key} slot={slot} onAttached={onAttached} />
      ))}
    </div>
  );
}

function MediaSlot({ slot, onAttached }) {
  const [status, setStatus] = useState("idle"); // idle | uploading | done | error
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const inputRef = useRef(null);
  const accept = slot.kind === "audio" ? "audio/mpeg,audio/wav" : "image/png,image/jpeg,image/webp";
  const Icon = slot.kind === "audio" ? Music : ImagePlus;

  const upload = async (file) => {
    setStatus("uploading");
    setError("");
    setFileName(file.name);
    try {
      const form = new FormData();
      form.append("file", file);
      const data = await adminFetch("/api/uploads", { method: "POST", body: form });
      onAttached(slot.path, data.url);
      setStatus("done");
    } catch (e) {
      setStatus("error");
      setError(e.message);
    }
  };

  const hasSomething = slot.currentUrl || status === "done";

  return (
    <div className={`ad-slot ${hasSomething ? "filled" : ""} ${status}`}>
      <div className="ad-slot-icon"><Icon size={15} /></div>
      <div className="ad-slot-info">
        <span className="ad-slot-label">{slot.label}</span>
        <span className="ad-slot-status">
          {status === "uploading" && "Uploading…"}
          {status === "done" && `Attached — ${fileName}`}
          {status === "error" && error}
          {status === "idle" && (hasSomething ? "Already set in JSON — upload to replace" : `No ${slot.kind} attached yet`)}
        </span>
      </div>
      <input ref={inputRef} type="file" accept={accept} style={{ display: "none" }}
        onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      <button className="ad-slot-btn" onClick={() => inputRef.current?.click()} disabled={status === "uploading"}>
        {status === "uploading" ? <Loader2 size={13} className="spin-icon" /> : hasSomething ? "Replace" : "Attach"}
      </button>
    </div>
  );
}

// ---------------- Loading / empty states ----------------
function LoadingGrid({ rows }) {
  if (rows) {
    return (
      <div className="ad-skel-rows">
        {[1, 2, 3].map((i) => <div key={i} className="ad-skel-row" />)}
      </div>
    );
  }
  return (
    <div className="ad-grid">
      {[1, 2, 3, 4].map((i) => <div key={i} className="ad-card skel" />)}
    </div>
  );
}

function EmptyState({ onCreate, hasSearch }) {
  return (
    <div className="ad-empty">
      <FileText size={32} />
      <p>{hasSearch ? "No exams match your search." : "No exams yet — create your first one to get a start code."}</p>
      {!hasSearch && (
        <button className="ad-btn primary" onClick={onCreate}><Plus size={15} /> New exam</button>
      )}
    </div>
  );
}

// ---------------- Styles ----------------
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap');
* { box-sizing:border-box; }
html, body, #__next { width:100%; min-height:100%; margin:0; }
.ad-root { --ad-bg:#f8f9fc; --ad-surface:#fff; --ad-border:#e8eaf2; --ad-text:#111d40; --ad-muted:#6f7890; --ad-sidebar:#101d45; --ad-purple:#5b50e6; display:flex; min-height:100vh; font-family:"Poppins",-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; background:var(--ad-bg); color:var(--ad-text); }

.ad-sidebar { width:220px; flex-shrink:0; background:var(--ad-sidebar); color:#fff; padding:24px 14px; display:flex; flex-direction:column; min-height:100vh; }
.ad-logo { display:flex; align-items:center; margin:0 10px 36px; }
.ad-logo img { width:112px; }
.ad-logo span { color:#aeb8da; font-size:11px; font-weight:600; margin-left:7px; padding-left:7px; border-left:1px solid #54618a; }
.ad-nav-label { color:#9ca9cf; font-size:9px; font-weight:700; letter-spacing:1px; margin:0 12px 10px; }
.ad-nav-label-manage { margin-top:30px; }
.ad-nav-item { display:flex; align-items:center; gap:10px; width:100%; padding:10px 12px; border-radius:8px; border:none; background:none; font:inherit; font-size:12.5px; font-weight:600; color:#c4cbe1; cursor:pointer; transition:background-color .2s ease, color .2s ease, transform .2s ease; }
.ad-nav-item:hover { background:#1e2d5b; color:#fff; transform:translateX(2px); }
.ad-nav-item.active { background:var(--ad-purple); color:#fff; box-shadow:0 6px 16px rgba(91,80,230,.25); }
.ad-nav-item.muted { opacity:.8; }
.ad-nav-item:disabled { cursor:default; }
.ad-nav-item:disabled:hover { background:none; color:#c4cbe1; transform:none; }
.ad-sidebar-footer { margin-top:auto; padding-top:16px; border-top:1px solid #293762; }
.ad-profile-link { width:100%; display:flex; align-items:center; gap:9px; padding:8px; margin-bottom:7px; border:0; border-radius:9px; background:transparent; color:#fff; text-align:left; cursor:pointer; transition:background-color .2s ease; }
.ad-profile-link:hover, .ad-profile-link.active { background:#1e2d5b; }
.ad-avatar, .ad-profile-avatar { display:flex; align-items:center; justify-content:center; flex-shrink:0; border-radius:50%; background:#8d87ff; color:#fff; font-weight:800; }
.ad-avatar { width:31px; height:31px; font-size:10px; }
.ad-avatar img, .ad-profile-avatar img { width:100%; height:100%; object-fit:cover; border-radius:50%; }
.ad-profile-copy { min-width:0; flex:1; }
.ad-profile-copy strong, .ad-profile-copy small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ad-profile-copy strong { font-size:10.5px; }
.ad-profile-copy small { color:#9ca9cf; font-size:9px; margin-top:2px; }
.ad-admin-email { font-size:10.5px; color:#9ca9cf; padding:0 12px 10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ad-nav-item.logout { color:#ff9a9a; }
.ad-nav-item.logout:hover { background:#382a4b; color:#ffb0b0; }

.ad-main { flex:1; min-width:0; width:100%; padding:32px 38px; max-width:1280px; }
.ad-topbar { display:flex; align-items:flex-start; justify-content:space-between; margin-bottom:24px; }
.ad-topbar h1 { font-size:25px; letter-spacing:-.5px; margin:0 0 4px; }
.ad-sub { color:var(--ad-muted); font-size:12px; margin:0; }

.ad-stats { display:grid; grid-template-columns:repeat(4, 1fr); gap:14px; margin-bottom:20px; }
.ad-stat { display:flex; align-items:center; gap:12px; padding:14px 16px; background:var(--ad-surface); border:1px solid var(--ad-border); border-radius:11px; }
.ad-stat-icon { width:36px; height:36px; display:flex; align-items:center; justify-content:center; border-radius:9px; }
.ad-stat span { display:block; color:var(--ad-muted); font-size:10px; font-weight:600; }
.ad-stat strong { display:block; color:var(--ad-text); font-size:21px; line-height:1.25; }
.ad-stat.violet .ad-stat-icon { background:#eeecfd; color:#5b50e6; }
.ad-stat.green .ad-stat-icon { background:#e5f7ed; color:#25854d; }
.ad-stat.amber .ad-stat-icon { background:#fff3dc; color:#b47a16; }
.ad-stat.slate .ad-stat-icon { background:#eef0f5; color:#6f7890; }

.ad-toolbar { display:flex; gap:12px; margin-bottom:22px; }
.ad-search { display:flex; align-items:center; gap:8px; background:var(--ad-surface); border:1px solid var(--ad-border); border-radius:8px; padding:9px 12px; max-width:none; width:100%; color:#8a92a6; transition:border-color .15s ease; }
.ad-search:focus-within { border-color:var(--ad-purple); }
.ad-search input { border:none; outline:none; background:none; font:inherit; font-size:12px; width:100%; color:var(--ad-text); }
.ad-filter { background:var(--ad-surface); border:1px solid var(--ad-border); border-radius:8px; padding:0 14px; color:var(--ad-text); font:inherit; font-size:12px; min-width:150px; }

.ad-btn { display:inline-flex; align-items:center; gap:7px; font-size:13.5px; font-weight:600; padding:9px 16px; border-radius:8px; border:1.5px solid transparent; cursor:pointer; transition:background-color .15s ease, border-color .15s ease, opacity .15s ease, transform .1s ease; }
.ad-btn:active { transform:scale(0.97); }
.ad-btn.primary { background:var(--ad-purple); color:#fff; box-shadow:0 5px 12px rgba(91,80,230,.17); }
.ad-btn.primary:hover { background:#4a40d6; }
.ad-btn.primary:disabled { opacity:.5; cursor:not-allowed; }
.ad-btn.ghost { background:var(--ad-surface); color:var(--ad-text); border-color:var(--ad-border); }
.ad-btn.ghost:hover { border-color:#bbb; }
.ad-btn.ghost:disabled { opacity:.4; cursor:not-allowed; }
a.ad-btn { text-decoration:none; }
.ad-btn.danger { background:#fdeceb; color:#b3261e; }
.ad-btn.danger:hover { background:#fbdedc; }
.ad-btn.small { padding:6px 12px; font-size:12.5px; }

.ad-error { background:#fdeceb; color:#b3261e; padding:10px 14px; border-radius:8px; font-size:13px; margin-bottom:16px; }
.ad-success { background:#e6f7ed; color:#1f7a45; padding:10px 14px; border-radius:8px; font-size:13px; margin-bottom:16px; }
.ad-error-list { margin:8px 0 0; padding-left:18px; font-size:12px; line-height:1.7; }

.ad-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(270px, 1fr)); gap:18px; }
.ad-card { background:var(--ad-surface); border:1px solid var(--ad-border); border-radius:12px; padding:20px; display:flex; flex-direction:column; gap:12px; transition:box-shadow .2s ease, transform .2s ease; animation:cardIn .3s ease; }
.ad-card:hover { box-shadow:0 4px 18px rgba(0,0,0,.06); transform:translateY(-1px); }
.ad-card.skel { height:168px; background:linear-gradient(90deg,#f2f2f2 25%,#f8f8f8 37%,#f2f2f2 63%); background-size:400% 100%; animation:shimmer 1.4s ease infinite; border:1px solid #f0f0f0; }
@keyframes shimmer { 0% { background-position:100% 0; } 100% { background-position:0 0; } }
@keyframes cardIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }

.ad-card-head { display:flex; align-items:center; justify-content:space-between; }
.ad-card-sections { display:flex; gap:6px; color:#999; }
.ad-card-title { font-size:14px; font-weight:700; margin:0; line-height:1.4; }

.ad-badge { display:inline-flex; align-items:center; gap:6px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.4px; padding:4px 9px; border-radius:12px; }
.ad-badge.draft { background:#f0f0f0; color:#777; }
.ad-badge.active { background:#e3f5e8; color:#1e7a34; }
.ad-badge.closed { background:#f0f0f0; color:#999; }
.ad-pulse { width:6px; height:6px; border-radius:50%; background:#2f8a4a; animation:pulseDot 1.4s ease-in-out infinite; }
@keyframes pulseDot { 0%,100% { opacity:1; } 50% { opacity:.3; } }

.ad-code-row { display:flex; align-items:center; gap:8px; background:#f6f6f6; border:1px dashed #ddd; border-radius:8px; padding:8px 12px; cursor:pointer; align-self:flex-start; position:relative; color:#444; transition:background-color .15s ease; }
.ad-code-row:hover { background:#efefef; }
.ad-code { font-weight:700; letter-spacing:2px; font-size:13px; }
.ad-copied { position:absolute; right:-8px; top:-26px; background:#1a1a1a; color:#fff; font-size:11px; padding:3px 8px; border-radius:5px; animation:cardIn .15s ease; }

.ad-card-footer { display:flex; justify-content:space-between; gap:8px; margin-top:auto; }
.ad-card-active-actions { display:flex; gap:6px; }

.ad-empty { display:flex; flex-direction:column; align-items:center; gap:12px; color:#888; padding:60px 0; text-align:center; }
.ad-empty p { font-size:14px; max-width:280px; }

.ad-profile-page { width:100%; max-width:none; }
.ad-profile-form { width:100%; background:var(--ad-surface); border:1px solid var(--ad-border); border-radius:14px; overflow:hidden; }
.ad-profile-hero { display:flex; align-items:center; gap:16px; padding:25px 28px; background:linear-gradient(120deg,#f1efff,#fff 68%); border-bottom:1px solid var(--ad-border); }
.ad-photo-picker { position:relative; display:flex; align-items:center; justify-content:center; width:70px; height:70px; border-radius:50%; background:#8d87ff; color:#fff; font-size:22px; font-weight:800; cursor:pointer; box-shadow:0 8px 18px rgba(91,80,230,.2); }
.ad-photo-picker img { width:100%; height:100%; object-fit:cover; border-radius:50%; }
.ad-photo-picker input { position:absolute; width:1px; height:1px; opacity:0; pointer-events:none; }
.ad-photo-camera { position:absolute; right:-1px; bottom:0; display:flex; align-items:center; justify-content:center; width:24px; height:24px; border:2px solid #fff; border-radius:50%; background:var(--ad-purple); color:#fff; }
.ad-profile-hero h2 { margin:0 0 4px; font-size:19px; }
.ad-profile-hero p { margin:0; color:var(--ad-muted); font-size:12px; }
.ad-profile-section { padding:24px 28px; border-bottom:1px solid var(--ad-border); }
.ad-profile-section h3 { margin:0 0 4px; font-size:14px; }
.ad-profile-help { color:var(--ad-muted); font-size:11.5px; margin:0 0 18px; }
.ad-profile-fields { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
.ad-profile-fields label { display:flex; flex-direction:column; gap:7px; color:var(--ad-text); font-size:11.5px; font-weight:700; }
.ad-profile-fields input { width:100%; padding:11px 12px; border:1px solid var(--ad-border); border-radius:8px; background:var(--ad-bg); color:var(--ad-text); font:inherit; font-size:12.5px; font-weight:400; }
.ad-profile-fields input:focus { outline:none; border-color:var(--ad-purple); box-shadow:0 0 0 3px rgba(91,80,230,.1); }
.ad-profile-actions { display:flex; align-items:center; justify-content:flex-end; gap:16px; padding:18px 28px; }
.ad-profile-status { margin-right:auto; padding:8px 11px; border-radius:7px; font-size:11.5px; }
.ad-profile-status.success { background:#e6f7ed; color:#1f7a45; }
.ad-profile-status.error { background:#fdeceb; color:#b3261e; }

.ad-back { background:none; border:none; color:#666; font-size:13px; cursor:pointer; padding:0 0 14px; }
.ad-back:hover { color:#1a1a1a; }

.ad-table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #ececec; border-radius:12px; overflow:hidden; font-size:13.5px; }
.ad-table th { text-align:left; background:#fafafa; padding:11px 14px; font-size:11.5px; text-transform:uppercase; letter-spacing:.4px; color:#888; border-bottom:1px solid #ececec; }
.ad-table td { padding:12px 14px; border-bottom:1px solid #f2f2f2; }
.ad-table tr:last-child td { border-bottom:none; }
.ad-student { font-weight:600; }
.ad-inline-badge { display:inline-flex; align-items:center; gap:5px; font-size:12.5px; font-weight:600; }
.ad-inline-badge.done { color:#1e7a34; }
.ad-inline-badge.pending { color:#b98900; }
.ad-manual-tag { font-size:11.5px; color:#999; background:#f4f4f4; padding:3px 8px; border-radius:6px; }
.ad-skel-rows { display:flex; flex-direction:column; gap:8px; }
.ad-skel-row { height:44px; border-radius:8px; background:linear-gradient(90deg,#f2f2f2 25%,#f8f8f8 37%,#f2f2f2 63%); background-size:400% 100%; animation:shimmer 1.4s ease infinite; }

.ad-modal-overlay { position:fixed; inset:0; background:rgba(20,20,20,.45); display:flex; align-items:center; justify-content:center; z-index:100; animation:fadeIn .15s ease; }
@keyframes fadeIn { from { opacity:0; } to { opacity:1; } }
.ad-modal { background:#fff; width:560px; max-width:92vw; max-height:86vh; border-radius:14px; display:flex; flex-direction:column; animation:modalIn .2s ease; overflow:hidden; }
@keyframes modalIn { from { opacity:0; transform:translateY(8px) scale(.98); } to { opacity:1; transform:translateY(0) scale(1); } }
.ad-modal-head { display:flex; justify-content:space-between; align-items:center; padding:18px 20px; border-bottom:1px solid #eee; }
.ad-modal-head h2 { font-size:16px; margin:0; }
.ad-iconbtn { background:none; border:none; cursor:pointer; color:#666; display:flex; }
.ad-modal-tabs { display:flex; gap:4px; padding:12px 20px 0; }
.ad-modal-tabs button { background:none; border:none; padding:8px 4px; margin-right:18px; font-size:13px; font-weight:600; color:#999; cursor:pointer; border-bottom:2px solid transparent; display:flex; align-items:center; gap:6px; }
.ad-modal-tabs button.active { color:var(--ad-purple); border-bottom-color:var(--ad-purple); }
.ad-soon { font-size:9.5px; background:#f0f0f0; color:#999; padding:2px 6px; border-radius:8px; text-transform:uppercase; }
.ad-modal-body { padding:16px 20px; overflow-y:auto; flex:1; }
.ad-label { display:block; font-size:12px; font-weight:700; color:#555; margin:14px 0 6px; }
.ad-label:first-child { margin-top:0; }
.ad-input { width:100%; padding:9px 12px; border:1.5px solid #ddd; border-radius:7px; font-size:13.5px; transition:border-color .15s ease; }
.ad-input:focus { outline:none; border-color:var(--ad-purple); }
.ad-textarea { width:100%; height:220px; padding:10px 12px; border:1.5px solid #ddd; border-radius:7px; font-size:12.5px; font-family:"SF Mono",Consolas,monospace; resize:vertical; transition:border-color .15s ease; }
.ad-textarea:focus { outline:none; border-color:var(--ad-purple); }
.ad-hint { font-size:12px; color:#888; margin-top:8px; line-height:1.6; }
.ad-hint code { background:#f4f4f4; padding:1px 5px; border-radius:4px; }

.ad-dropzone { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; border:1.5px dashed #ccc; border-radius:10px; padding:28px 16px; cursor:pointer; color:#888; text-align:center; transition:border-color .15s ease, background-color .15s ease; }
.ad-dropzone:hover, .ad-dropzone.over { border-color:var(--ad-purple); background:#faf9ff; color:var(--ad-purple); }
.ad-dropzone.filled { border-style:solid; border-color:#2f8a4a; color:#1e7a34; background:#f3faf4; }
.ad-dropzone span { font-size:13px; font-weight:600; }
.ad-dropzone-sub { font-size:11px !important; font-weight:400 !important; color:#999 !important; }
.ad-template-link { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:#555; text-decoration:none; margin-top:10px; }
.ad-template-link:hover { color:var(--ad-purple); text-decoration:underline; }

.ad-slots { display:flex; flex-direction:column; gap:8px; margin-top:6px; }
.ad-slot { display:flex; align-items:center; gap:11px; padding:11px 13px; background:var(--ad-bg); border:1px solid var(--ad-border); border-radius:9px; transition:border-color .15s ease, background-color .15s ease; }
.ad-slot.filled { border-color:#cfe8d8; background:#f6fbf7; }
.ad-slot.uploading { border-color:var(--ad-purple); background:#faf9ff; }
.ad-slot.error { border-color:#f3cfcf; background:#fdf7f7; }
.ad-slot-icon { width:32px; height:32px; flex-shrink:0; display:flex; align-items:center; justify-content:center; border-radius:8px; background:#eeecfd; color:var(--ad-purple); }
.ad-slot.filled .ad-slot-icon { background:#e3f5e8; color:#1e7a34; }
.ad-slot-info { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.ad-slot-label { font-size:12.5px; font-weight:700; color:var(--ad-text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ad-slot-status { font-size:11px; color:var(--ad-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ad-slot.error .ad-slot-status { color:#b3261e; }
.ad-slot-btn { flex-shrink:0; display:flex; align-items:center; gap:5px; background:#fff; border:1px solid var(--ad-border); padding:7px 13px; border-radius:7px; font-size:11.5px; font-weight:700; cursor:pointer; color:var(--ad-text); transition:border-color .15s ease, background-color .15s ease; }
.ad-slot-btn:hover:not(:disabled) { border-color:var(--ad-purple); background:#faf9ff; }
.ad-slot-btn:disabled { opacity:.6; cursor:not-allowed; }

.ad-preview { background:#f8f9f8; border:1px solid #e6ece7; border-radius:8px; padding:12px 14px; margin-top:14px; }
.ad-preview-title { display:flex; align-items:center; gap:6px; font-size:12.5px; font-weight:700; color:#1e7a34; margin-bottom:8px; }
.ad-preview-row { display:flex; align-items:center; gap:8px; font-size:12.5px; padding:4px 0; color:#444; }
.ad-preview-type { font-weight:700; text-transform:capitalize; min-width:64px; }
.ad-preview-detail { color:#777; }
.ad-preview-tag { margin-left:auto; background:#e8edff; color:#3a4fd6; font-size:10px; font-weight:700; text-transform:uppercase; padding:2px 7px; border-radius:8px; }
.ad-modal-footer { display:flex; justify-content:flex-end; gap:10px; padding:16px 20px; border-top:1px solid #eee; }

.spin-icon { animation:spin .8s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
@media (max-width: 760px) { .ad-sidebar { width:178px; } .ad-main { padding:24px 20px; } .ad-stats { grid-template-columns:repeat(2,1fr); } .ad-profile-fields { grid-template-columns:1fr; } }
`;