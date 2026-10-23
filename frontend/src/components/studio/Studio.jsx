import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Sparkles, ArrowUp, Plus, BookOpen, Headphones, PenLine, Calculator, Check, Loader2, AlertTriangle,
  X, Circle, Paperclip, Download, Printer, Rocket, PanelRight, Menu, Copy, Eye, EyeOff, LogOut,
  FileText, ListChecks, MessageSquare, FileJson,
} from "lucide-react";
import { adminFetch, adminStream } from "../../lib/adminApi";
import ExamPaper, { sectionLabel, SectionBody } from "./ExamPaper";

/**
 * Studio.jsx — Testly Studio: a single-screen, ChatGPT-style place to make
 * an exam by talking. Chat on the left; on the right a "canvas" that shows
 * the plan, then the live build, then the finished paper. From the top bar
 * the exam can be downloaded as JSON, hosted on Testly (a live start code)
 * or printed (paper, answer key, or both).
 *
 * It talks to the same backend as the admin dashboard's AI Studio
 * (/api/ai/chat, /build, /import, /jobs/:id): the server keeps no
 * conversation state, so this component owns the transcript and sends it
 * back each turn, and keeps it in localStorage across refreshes.
 */

const STARTERS = [
  { icon: BookOpen, title: "IELTS Academic mock", text: "Build a full IELTS Academic mock: Reading, Listening and Writing at real test difficulty." },
  { icon: Calculator, title: "Digital SAT practice test", text: "Create a full-length digital SAT practice test with both sections." },
  { icon: PenLine, title: "Hard Reading paper", text: "I need a hard IELTS Academic Reading paper for students aiming at band 7 or higher." },
  { icon: Headphones, title: "Short Listening set", text: "Make a short IELTS Listening practice with two parts about university life." },
];

const SECTION_ICON = { reading: BookOpen, listening: Headphones, writing: PenLine, "reading-writing": BookOpen, math: Calculator };
const READING_QUESTIONS = [13, 26, 40];

const TOOL_LABEL = {
  set_blueprint: "Updated the plan",
  build_exam: "Started the build",
  get_exam: "Looked at the exam",
  revise_exam: "Started a rewrite",
};

function sectionSummary(section) {
  if (section.type === "reading") return `${section.parts} passage${section.parts > 1 ? "s" : ""} · ${READING_QUESTIONS[section.parts - 1]} questions · ${section.parts * 20} min`;
  if (section.type === "listening") return `${section.parts} part${section.parts > 1 ? "s" : ""} · ${section.parts * 10} questions · with audio`;
  if (section.type === "writing") return "Task 1 and Task 2 · 60 min";
  if (section.type === "reading-writing") return "3 adaptive modules · 27 questions each";
  return "3 adaptive modules · 22 questions each";
}

let idSeq = 0;
const nextId = () => `m${Date.now().toString(36)}${idSeq++}`;

function RichText({ text }) {
  const blocks = [];
  let list = null;
  for (const line of text.split("\n")) {
    const item = line.match(/^\s*(?:[-•*]|\d+\.)\s+(.*)$/);
    if (item) {
      if (!list) { list = []; blocks.push(list); }
      list.push(item[1]);
    } else {
      list = null;
      if (line.trim()) blocks.push(line);
    }
  }
  const inline = (s) => s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : part
  );
  return blocks.map((block, i) =>
    Array.isArray(block)
      ? <ul key={i}>{block.map((li, j) => <li key={j}>{inline(li)}</li>)}</ul>
      : <p key={i}>{inline(block)}</p>
  );
}

function slug(s) {
  return String(s || "exam").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "exam";
}

export default function Studio({ admin, onLogout }) {
  const storageKey = `testly-studio:${admin?.adminId || "admin"}`;

  const [status, setStatus] = useState(null);
  const [messages, setMessages] = useState([]);
  const [history, setHistory] = useState([]);
  const [blueprint, setBlueprint] = useState(null);
  const [examId, setExamId] = useState(null);
  const [job, setJob] = useState(null);
  const [examInfo, setExamInfo] = useState(null);
  const [exam, setExam] = useState(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [starting, setStarting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [panelError, setPanelError] = useState("");
  const [restored, setRestored] = useState(false);
  const [recent, setRecent] = useState([]);

  const [tab, setTab] = useState("plan"); // plan | paper
  const [canvasOpen, setCanvasOpen] = useState(true);
  const [sideOpen, setSideOpen] = useState(false);
  const [showAnswers, setShowAnswers] = useState(true);
  const [sectionTab, setSectionTab] = useState(0);
  const [printMenu, setPrintMenu] = useState(false);
  const [printMode, setPrintMode] = useState("paper");
  const [host, setHost] = useState(null); // { step: "confirm" | "busy" | "done" | "error", ... }
  const [toast, setToast] = useState("");

  const pendingEvents = useRef([]);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const lastJobStatus = useRef(null);

  const ready = !!status?.configured;
  const busy = job?.status === "running";
  const hasWork = !!(blueprint || examId);
  const chatting = messages.length > 0;

  // On a phone the canvas is a full-screen sheet, so don't pop it open by itself.
  useEffect(() => { if (window.innerWidth <= 900) setCanvasOpen(false); }, []);
  const openCanvas = useCallback(() => { if (window.innerWidth > 900) setCanvasOpen(true); }, []);

  const flash = useCallback((text) => {
    setToast(text);
    setTimeout(() => setToast(""), 2400);
  }, []);

  const loadRecent = useCallback(() => {
    adminFetch("/api/exams").then((list) => setRecent(Array.isArray(list) ? list : [])).catch(() => {});
  }, []);

  useEffect(() => {
    adminFetch("/api/ai/status").then(setStatus).catch(() => setStatus({ configured: false, unreachable: true }));
    loadRecent();
  }, [loadRecent]);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(storageKey) || "null");
      if (saved) {
        setMessages((saved.messages || []).map((m) => ({ ...m, streaming: false })));
        setHistory(saved.history || []);
        setBlueprint(saved.blueprint || null);
        setExamId(saved.examId || null);
        pendingEvents.current = saved.pendingEvents || [];
      }
    } catch { /* unreadable saved state — start fresh */ }
    setRestored(true);
  }, [storageKey]);

  useEffect(() => {
    if (!restored || sending) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ messages, history, blueprint, examId, pendingEvents: pendingEvents.current }));
    } catch { /* storage full — chat still works this visit */ }
  }, [restored, sending, messages, history, blueprint, examId, storageKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  const addNote = useCallback((text, tone) => {
    setMessages((prev) => [...prev, { id: nextId(), role: "note", text, tone }]);
  }, []);

  const loadExam = useCallback(async (id) => {
    try {
      const data = await adminFetch(`/api/exams/${id}`);
      if (Array.isArray(data.sections) && data.sections.length) setExam(data);
      else setExam(null);
      return data;
    } catch {
      return null;
    }
  }, []);

  const loadJob = useCallback(async (id) => {
    try {
      const data = await adminFetch(`/api/ai/jobs/${id}`);
      setJob(data.job);
      setExamInfo(data.exam);
      return data;
    } catch {
      setExamId(null); setJob(null); setExamInfo(null); setExam(null);
      return null;
    }
  }, []);

  useEffect(() => {
    if (!examId) return undefined;
    let stopped = false;
    let timer;
    const tick = async () => {
      const data = await loadJob(examId);
      if (stopped || !data) return;
      if (data.job?.status === "running") timer = setTimeout(tick, 2500);
      else loadExam(examId);
    };
    tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [examId, loadJob, loadExam, job?.startedAt]);

  // A finished job: tell the user in the chat and queue a note for the assistant.
  useEffect(() => {
    const previous = lastJobStatus.current;
    lastJobStatus.current = job ? `${job.startedAt}:${job.status}` : null;
    if (!job || !previous || previous !== `${job.startedAt}:running` || job.status === "running") return;
    const what = { revise: "rewrite", import: "import of the uploaded paper" }[job.kind] || "build";
    if (job.status === "done") {
      addNote({ revise: "The rewrite is saved.", import: "The paper is digitised. Check it against the original." }[job.kind] || "Your exam is built and saved as a draft.", "ok");
      pendingEvents.current.push(`The ${what} finished and the draft is saved.${job.warnings.length ? ` Warnings: ${job.warnings.join(" ")}` : ""}`);
      setTab("paper");
    } else {
      addNote(`The ${what} didn't finish: ${job.error}`, "error");
      pendingEvents.current.push(`The ${what} failed: ${job.error}`);
    }
    loadRecent();
  }, [job, addNote, loadRecent]);

  useEffect(() => { if (exam && tab === "plan" && !blueprint) setTab("paper"); }, [exam, tab, blueprint]);
  useEffect(() => { setSectionTab(0); }, [exam?.examId]);

  const send = async (text) => {
    const content = (text ?? input).trim();
    if (!content || sending || !ready) return;
    setInput("");
    setSending(true);
    const replyId = nextId();
    setMessages((prev) => [
      ...prev.filter((m) => !m.failed),
      { id: nextId(), role: "user", text: content, turn: replyId },
      { id: replyId, role: "assistant", text: "", tools: [], streaming: true },
    ]);
    const patchReply = (fn) => setMessages((prev) => prev.map((m) => (m.id === replyId ? fn(m) : m)));
    const events = pendingEvents.current;
    let finished = false;
    try {
      await adminStream("/api/ai/chat", { message: content, history, events, blueprint, examId }, (event, data) => {
        if (event === "text") patchReply((m) => ({ ...m, text: m.text + data.delta }));
        else if (event === "tool") { if (data.ok) patchReply((m) => ({ ...m, tools: [...m.tools, data.name] })); }
        else if (event === "blueprint") { setBlueprint(data.blueprint); setTab("plan"); openCanvas(); }
        else if (event === "job") { setExamId(data.examId); setJob(data.job); setPanelError(""); setTab("plan"); openCanvas(); loadRecent(); }
        else if (event === "done") {
          finished = true;
          pendingEvents.current = [];
          setHistory((prev) => [...prev, ...data.turn]);
          if (data.blueprint) setBlueprint(data.blueprint);
          patchReply((m) => ({ ...m, streaming: false }));
        } else if (event === "error") throw new Error(data.message);
      });
      if (!finished) throw new Error("The connection dropped before the reply finished.");
    } catch (e) {
      setMessages((prev) => prev.map((m) => {
        if (m.id === replyId) return { ...m, streaming: false, failed: true, error: e.message, retryText: content };
        return m.turn === replyId ? { ...m, failed: true } : m;
      }));
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const build = async () => {
    if (!blueprint || starting) return;
    setStarting(true);
    setPanelError("");
    try {
      const data = await adminFetch("/api/ai/build", { method: "POST", body: JSON.stringify({ blueprint }) });
      setExam(null);
      setExamId(data.examId);
      setJob(data.job);
      addNote("Build started. You can keep chatting while it runs.");
      pendingEvents.current.push(`The user pressed Build; exam ${data.examId} is being built from the current plan.`);
      loadRecent();
    } catch (e) {
      setPanelError(e.details ? `${e.message} ${e.details.join(" ")}` : e.message);
    } finally {
      setStarting(false);
    }
  };

  const importPaper = async (file) => {
    if (!file || importing) return;
    setImporting(true);
    setPanelError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const data = await adminFetch("/api/ai/import", { method: "POST", body: form });
      setBlueprint(null); setExam(null);
      setExamId(data.examId);
      setJob(data.job);
      setTab("plan"); openCanvas();
      addNote(`Reading "${file.name}". This takes a few minutes.`);
      pendingEvents.current.push(`The user attached a paper as a PDF ("${file.name}"); it is being digitised into exam ${data.examId}.`);
      loadRecent();
    } catch (e) {
      addNote(`Couldn't read "${file.name}": ${e.message}`, "error");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const reset = () => {
    setMessages([]); setHistory([]); setBlueprint(null); setExamId(null); setJob(null); setExamInfo(null); setExam(null);
    setPanelError(""); setInput(""); setSideOpen(false);
    pendingEvents.current = [];
    try { window.localStorage.removeItem(storageKey); } catch { /* nothing to clear */ }
    inputRef.current?.focus();
  };

  const openExam = (id) => {
    setSideOpen(false);
    setBlueprint(null); setExam(null); setJob(null);
    setExamId(id); setTab("paper"); setCanvasOpen(true);
  };

  const downloadJson = async () => {
    if (!examId) return;
    try {
      const full = exam || (await loadExam(examId));
      if (!full) throw new Error("Nothing to download yet.");
      // The server fills in ids, codes and timestamps on creation; leave them out so the file re-uploads cleanly.
      const { examId: _id, startCode: _code, status: _status, createdAt: _c, updatedAt: _u, centerId: _center, ...content } = full;
      const blob = new Blob([JSON.stringify(content, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${slug(full.title)}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      flash("JSON downloaded");
    } catch (e) {
      flash(e.message);
    }
  };

  const printNow = (mode) => {
    setPrintMenu(false);
    setPrintMode(mode);
    setTimeout(() => window.print(), 80);
  };

  const goLive = async () => {
    setHost({ step: "busy" });
    try {
      const data = await adminFetch(`/api/exams/${examId}/start`, { method: "POST" });
      setHost({ step: "done", code: data.startCode });
      loadRecent();
    } catch (e) {
      setHost({ step: "error", message: e.message });
    }
  };

  const copy = (text) => {
    navigator.clipboard?.writeText(text).then(() => flash("Copied"), () => flash("Couldn't copy"));
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };

  const examReady = !!exam && !busy;
  const canStartHosting = examReady && examInfo?.status === "draft";
  const section = exam?.sections?.[sectionTab];

  const composer = (
    <div className="st-composer">
      <input ref={fileRef} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => importPaper(e.target.files?.[0])} />
      <textarea
        ref={inputRef} rows={1} value={input} maxLength={6000}
        onChange={(e) => setInput(e.target.value)} onKeyDown={onKeyDown}
        placeholder={ready ? "Describe the exam, or ask for a change" : "Studio isn't available right now"}
        disabled={!ready}
      />
      <div className="st-composer-bar">
        <button className="st-round ghost" onClick={() => fileRef.current?.click()} disabled={!ready || !status?.pdf || importing || busy}
          title={status?.pdf === false ? "Reading PDFs needs a Claude or Gemini key on the server" : "Attach a paper as a PDF"} aria-label="Attach a PDF">
          {importing ? <Loader2 size={17} className="st-spin" /> : <Paperclip size={17} />}
        </button>
        <span className="st-composer-hint">{input.length > 5000 ? `${6000 - input.length} left` : "Enter to send · Shift+Enter for a new line"}</span>
        <button className="st-round send" onClick={() => send()} disabled={!ready || sending || !input.trim()} aria-label="Send">
          {sending ? <Loader2 size={17} className="st-spin" /> : <ArrowUp size={18} strokeWidth={2.4} />}
        </button>
      </div>
    </div>
  );

  return (
    <div className={`st-root ${chatting ? "chatting" : "welcome"} ${hasWork && canvasOpen ? "with-canvas" : ""}`}>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      {sideOpen && <div className="st-scrim" onClick={() => setSideOpen(false)} />}
      <aside className={`st-side ${sideOpen ? "open" : ""}`}>
        <div className="st-brand">
          <img src="/images/testly-logo-light.png" alt="Testly" />
          <span>Studio</span>
        </div>
        <button className="st-new" onClick={reset} disabled={sending}><Plus size={16} /> New chat</button>
        <div className="st-side-label">Your exams</div>
        <nav className="st-recent">
          {recent.length === 0 && <p className="st-empty-note">Exams you build show up here.</p>}
          {recent.slice(0, 40).map((e) => (
            <button key={e.examId} className={e.examId === examId ? "active" : ""} onClick={() => openExam(e.examId)}>
              <span className="st-recent-title">{e.title}</span>
              <span className={`st-dot ${e.status}`} title={e.status} />
            </button>
          ))}
        </nav>
        <div className="st-me">
          <div className="st-avatar">{(admin?.fullName || admin?.email || "?").slice(0, 1).toUpperCase()}</div>
          <div className="st-me-text"><strong>{admin?.fullName || "Your account"}</strong><small>{admin?.email}</small></div>
          <button className="st-icon" onClick={onLogout} title="Sign out" aria-label="Sign out"><LogOut size={16} /></button>
        </div>
      </aside>

      <main className="st-main">
        <header className="st-top">
          <button className="st-icon only-narrow" onClick={() => setSideOpen(true)} aria-label="Menu"><Menu size={18} /></button>
          <div className="st-title">
            <strong>{exam?.title || blueprint?.title || "New exam"}</strong>
            {examInfo?.status && <span className={`st-pill ${examInfo.status}`}>{examInfo.status === "active" ? "live" : examInfo.status.replace("_", " ")}</span>}
          </div>
          <div className="st-actions">
            <button className="st-btn" onClick={downloadJson} disabled={!examReady} title="Download the exam as JSON"><FileJson size={15} /><span>JSON</span></button>
            <div className="st-menu-wrap">
              <button className="st-btn" onClick={() => setPrintMenu((v) => !v)} disabled={!examReady}><Printer size={15} /><span>Print</span></button>
              {printMenu && (
                <>
                  <div className="st-menu-scrim" onClick={() => setPrintMenu(false)} />
                  <div className="st-menu">
                    <button onClick={() => printNow("paper")}><FileText size={15} /> Question paper</button>
                    <button onClick={() => printNow("key")}><ListChecks size={15} /> Answer key</button>
                    <button onClick={() => printNow("both")}><Printer size={15} /> Both</button>
                  </div>
                </>
              )}
            </div>
            <button className="st-btn primary" onClick={() => setHost({ step: "confirm" })} disabled={!canStartHosting}><Rocket size={15} /><span>Host on Testly</span></button>
            {hasWork && <button className={`st-icon ${canvasOpen ? "on" : ""}`} onClick={() => setCanvasOpen((v) => !v)} title="Toggle the canvas" aria-label="Toggle the canvas"><PanelRight size={18} /></button>}
          </div>
        </header>

        <div className="st-body">
          <section className="st-chat">
            <div className="st-scroll" ref={scrollRef}>
              <div className="st-thread">
                {status && !ready && (
                  <div className="st-setup">
                    <AlertTriangle size={16} />
                    <div>
                      <strong>{status.unreachable ? "The server can't be reached right now." : "AI isn't switched on for this server yet."}</strong>
                      {!status.unreachable && <p>Add an AI key (<code>ANTHROPIC_API_KEY</code>, <code>GEMINI_API_KEY</code> or <code>GROQ_API_KEY</code>) to the backend and restart it.</p>}
                    </div>
                  </div>
                )}

                {!chatting && (
                  <div className="st-hero">
                    <div className="st-mark"><Sparkles size={22} /></div>
                    <h1>What are we building today?</h1>
                    <p>Describe the exam you need, or attach a paper you already have. Download it, print it, or put it live on Testly.</p>
                  </div>
                )}

                {messages.map((m) => {
                  if (m.role === "note") {
                    return <div key={m.id} className={`st-note ${m.tone || ""}`}>{m.tone === "error" ? <AlertTriangle size={13} /> : m.tone === "ok" ? <Check size={13} /> : <Sparkles size={13} />}{m.text}</div>;
                  }
                  if (m.role === "user") {
                    return <div key={m.id} className="st-msg user"><div className="st-bubble">{m.text}</div></div>;
                  }
                  return (
                    <div key={m.id} className="st-msg assistant">
                      <div className="st-spark"><Sparkles size={14} /></div>
                      <div className="st-reply">
                        {m.text && <div className="st-prose"><RichText text={m.text} /></div>}
                        {m.streaming && !m.text && <div className="st-typing"><span /><span /><span /></div>}
                        {m.tools?.length > 0 && (
                          <div className="st-tools">
                            {[...new Set(m.tools)].map((t) => <span key={t}><Check size={11} />{TOOL_LABEL[t] || t}</span>)}
                          </div>
                        )}
                        {m.failed && (
                          <div className="st-failed">
                            <AlertTriangle size={13} /> {m.error}
                            <button onClick={() => send(m.retryText)} disabled={sending}>Try again</button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="st-dock">
              <div className="st-dock-inner">
                {composer}
                {!chatting && (
                  <div className="st-starters">
                    {STARTERS.map((s) => (
                      <button key={s.title} onClick={() => send(s.text)} disabled={!ready || sending}>
                        <s.icon size={15} /><span>{s.title}</span>
                      </button>
                    ))}
                  </div>
                )}
                {chatting && <p className="st-fine">AI-written exams should be read by a teacher before students sit them.</p>}
              </div>
            </div>
          </section>

          {hasWork && (
            <aside className={`st-canvas ${canvasOpen ? "open" : ""}`}>
              <div className="st-canvas-head">
                <div className="st-tabs">
                  <button className={tab === "plan" ? "on" : ""} onClick={() => setTab("plan")}>Plan</button>
                  <button className={tab === "paper" ? "on" : ""} onClick={() => setTab("paper")} disabled={!exam}>Paper</button>
                </div>
                {tab === "paper" && exam && (
                  <button className="st-btn small" onClick={() => setShowAnswers((v) => !v)}>
                    {showAnswers ? <EyeOff size={14} /> : <Eye size={14} />}{showAnswers ? "Hide answers" : "Show answers"}
                  </button>
                )}
                <button className="st-icon only-narrow" onClick={() => setCanvasOpen(false)} aria-label="Close"><X size={18} /></button>
              </div>

              <div className="st-canvas-body">
                {tab === "plan" && (
                  <>
                    {panelError && <div className="st-error">{panelError}</div>}
                    {job && <Progress job={job} />}
                    {examInfo?.status === "generation_failed" && !job && <div className="st-error">{examInfo.generationError}</div>}
                    {blueprint && <Blueprint blueprint={blueprint} />}
                    {blueprint && !busy && (
                      <div className="st-build">
                        <button className="st-btn primary big" onClick={build} disabled={starting || sending || !ready}>
                          {starting ? <Loader2 size={16} className="st-spin" /> : <Sparkles size={16} />}
                          {examId ? "Build again as a new exam" : "Build this exam"}
                        </button>
                        {!examId && <p className="st-fine">Takes a few minutes. The result is saved as a draft you can edit.</p>}
                      </div>
                    )}
                    {!blueprint && !job && examInfo && <p className="st-empty-note">Open the Paper tab to read this exam.</p>}
                  </>
                )}

                {tab === "paper" && exam && (
                  <>
                    <div className="st-sections">
                      {exam.sections.map((s, i) => {
                        const Icon = SECTION_ICON[s.type] || BookOpen;
                        return <button key={s.id || s.type} className={i === sectionTab ? "on" : ""} onClick={() => setSectionTab(i)}><Icon size={14} />{sectionLabel(s)}</button>;
                      })}
                    </div>
                    <div className={`ep ${showAnswers ? "with-answers" : ""}`}>
                      {section && <SectionBody section={section} showAnswers={showAnswers} />}
                    </div>
                  </>
                )}
              </div>
            </aside>
          )}
        </div>
      </main>

      {host && (
        <div className="st-modal-scrim" onMouseDown={() => host.step !== "busy" && setHost(null)}>
          <div className="st-modal" onMouseDown={(e) => e.stopPropagation()}>
            {host.step === "confirm" && (
              <>
                <div className="st-modal-icon"><Rocket size={20} /></div>
                <h2>Host “{exam?.title}” on Testly?</h2>
                <p>This turns on the exam&apos;s start code. Students open the Testly exam page, enter the code, and you admit them from the Test Room. After it&apos;s live, the content can no longer be edited.</p>
                <div className="st-modal-actions">
                  <button className="st-btn" onClick={() => setHost(null)}>Not yet</button>
                  <button className="st-btn primary" onClick={goLive}>Go live</button>
                </div>
              </>
            )}
            {host.step === "busy" && <div className="st-modal-busy"><Loader2 size={22} className="st-spin" /> Going live…</div>}
            {host.step === "done" && (
              <>
                <div className="st-modal-icon ok"><Check size={20} /></div>
                <h2>Your exam is live</h2>
                <p>Share this code and the link with your students.</p>
                <button className="st-code" onClick={() => copy(host.code)}>{host.code}<Copy size={16} /></button>
                <button className="st-link" onClick={() => copy(`${window.location.origin}/exam`)}>{typeof window !== "undefined" ? `${window.location.origin}/exam` : "/exam"}<Copy size={13} /></button>
                <div className="st-modal-actions">
                  <button className="st-btn" onClick={() => setHost(null)}>Done</button>
                  <a className="st-btn primary" href="/admin">Open the Test Room</a>
                </div>
              </>
            )}
            {host.step === "error" && (
              <>
                <div className="st-modal-icon bad"><AlertTriangle size={20} /></div>
                <h2>Couldn&apos;t go live</h2>
                <p>{host.message}</p>
                <div className="st-modal-actions"><button className="st-btn" onClick={() => setHost(null)}>Close</button></div>
              </>
            )}
          </div>
        </div>
      )}

      {toast && <div className="st-toast">{toast}</div>}

      {/* What window.print() produces; hidden on screen. */}
      {exam && (
        <div className="st-print" aria-hidden="true">
          {(printMode === "paper" || printMode === "both") && <ExamPaper exam={exam} printable />}
          {(printMode === "key" || printMode === "both") && (
            <div className={printMode === "both" ? "st-print-break" : ""}><ExamPaper exam={exam} printable showAnswers /></div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------- Plan ----------------
function Blueprint({ blueprint }) {
  const kind = blueprint.testType === "sat" ? "Digital SAT" : `IELTS ${blueprint.variant === "general" ? "General Training" : "Academic"}`;
  const level = { easy: "Easier than the real test", medium: "Real test difficulty", hard: "Harder than the real test" }[blueprint.difficulty];
  return (
    <div className="st-card">
      <div className="st-label">Plan</div>
      <h3>{blueprint.title}</h3>
      <div className="st-chips"><span className="strong">{kind}</span>{level && <span>{level}</span>}</div>
      {blueprint.sections.map((section) => {
        const Icon = SECTION_ICON[section.type] || BookOpen;
        return (
          <div className="st-plan-section" key={section.type}>
            <div className="st-plan-head">
              <span className="st-plan-icon"><Icon size={15} /></span>
              <div><strong>{sectionLabel(section)}</strong><small>{sectionSummary(section)}</small></div>
            </div>
            {section.topics?.length > 0 && (
              <ul>{section.topics.map((topic, i) => <li key={i}>{topic}</li>)}</ul>
            )}
            {section.notes && <p className="st-plan-notes">{section.notes}</p>}
          </div>
        );
      })}
    </div>
  );
}

function Progress({ job }) {
  const finished = job.steps.filter((s) => s.status === "done").length;
  const running = job.status === "running";
  const groups = [];
  job.steps.forEach((step) => {
    const last = groups[groups.length - 1];
    if (last && last.name === step.group) last.steps.push(step);
    else groups.push({ name: step.group, steps: [step] });
  });
  if (job.status === "done" && !job.notes.length && !job.warnings.length) return null;
  return (
    <div className={`st-card ${job.status}`}>
      <div className="st-card-head">
        <div className="st-label">{{ revise: "Rewrite", import: "Import" }[job.kind] || "Build"}</div>
        <span>{running ? `${finished} of ${job.steps.length}` : job.status === "done" ? "Finished" : "Stopped"}</span>
      </div>
      {running && <div className="st-bar"><span style={{ width: `${Math.max(4, (finished / job.steps.length) * 100)}%` }} /></div>}
      {(running || job.status === "failed") && groups.map((group) => (
        <div className="st-step-group" key={group.name}>
          <div className="st-step-group-name">{group.name}</div>
          {group.steps.map((step) => (
            <div className={`st-step ${step.status}`} key={step.id}>
              <span className="st-step-icon">
                {step.status === "running" ? <Loader2 size={13} className="st-spin" />
                  : step.status === "done" ? <Check size={12} />
                  : step.status === "failed" ? <X size={12} />
                  : <Circle size={8} />}
              </span>
              <div>
                <span>{step.label}{step.hint ? <em> · {step.hint}</em> : null}</span>
                {step.detail && (step.status === "running" || step.status === "failed") && <small>{step.detail}</small>}
              </div>
            </div>
          ))}
        </div>
      ))}
      {job.status === "failed" && <div className="st-error">{job.error}</div>}
      {job.status === "done" && job.notes.map((note, i) => <div className="st-line ok" key={`n${i}`}><Check size={13} />{note}</div>)}
      {job.status !== "running" && job.warnings.map((w, i) => <div className="st-line warn" key={`w${i}`}><AlertTriangle size={13} />{w}</div>)}
    </div>
  );
}

// ---------------- Styles ----------------
const CSS = `
:root { --st-bg:#0c0d11; --st-side:#090a0d; --st-panel:#111318; --st-raise:#171a21; --st-raise2:#1e222b;
  --st-line:rgba(255,255,255,.07); --st-line2:rgba(255,255,255,.12); --st-text:#eceef3; --st-dim:#a3a9b8; --st-faint:#6b7180;
  --st-accent:#8f87ff; --st-accent2:#5b50e6; --st-ok:#4ade80; --st-warn:#fbbf24; --st-bad:#f87171; }
html, body { background:var(--st-bg); overflow:hidden; }
.st-root { position:fixed; inset:0; display:grid; grid-template-columns:268px 1fr; background:var(--st-bg); color:var(--st-text);
  font-family:'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif; font-size:15px; line-height:1.55; -webkit-font-smoothing:antialiased; }
.st-root *, .st-root *::before, .st-root *::after { box-sizing:border-box; }
.st-root button { font:inherit; color:inherit; cursor:pointer; }
.st-root button:disabled { cursor:not-allowed; }
.st-root ::-webkit-scrollbar { width:10px; height:10px; } .st-root ::-webkit-scrollbar-thumb { background:rgba(255,255,255,.1); border-radius:10px; border:3px solid transparent; background-clip:content-box; }
.st-root ::-webkit-scrollbar-thumb:hover { background:rgba(255,255,255,.2); background-clip:content-box; border:3px solid transparent; }
.st-spin { animation:st-rot .9s linear infinite; } @keyframes st-rot { to { transform:rotate(360deg); } }

/* sidebar */
.st-side { background:var(--st-side); border-right:1px solid var(--st-line); display:flex; flex-direction:column; padding:14px 10px 10px; min-height:0; }
.st-brand { display:flex; align-items:center; gap:10px; padding:6px 8px 16px; }
.st-brand img { height:22px; width:auto; display:block; }
.st-brand span { font-size:11px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:var(--st-accent); padding:3px 8px; border:1px solid rgba(143,135,255,.35); border-radius:99px; background:rgba(143,135,255,.08); }
.st-new { display:flex; align-items:center; gap:10px; width:100%; padding:10px 12px; border-radius:12px; border:1px solid var(--st-line); background:var(--st-raise); font-weight:500; transition:background .15s,border-color .15s; }
.st-new:hover:not(:disabled) { background:var(--st-raise2); border-color:var(--st-line2); }
.st-side-label { margin:20px 10px 6px; font-size:11px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; color:var(--st-faint); }
.st-recent { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:1px; min-height:0; }
.st-recent button { display:flex; align-items:center; justify-content:space-between; gap:10px; text-align:left; width:100%; background:none; border:0; padding:8px 10px; border-radius:10px; color:var(--st-dim); font-size:14px; }
.st-recent button:hover { background:rgba(255,255,255,.05); color:var(--st-text); }
.st-recent button.active { background:rgba(255,255,255,.08); color:var(--st-text); }
.st-recent-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.st-dot { width:7px; height:7px; border-radius:50%; flex:none; background:var(--st-faint); }
.st-dot.active { background:var(--st-ok); box-shadow:0 0 0 3px rgba(74,222,128,.15); } .st-dot.generating { background:var(--st-warn); } .st-dot.generation_failed { background:var(--st-bad); }
.st-empty-note { color:var(--st-faint); font-size:13px; padding:4px 10px; margin:0; }
.st-me { display:flex; align-items:center; gap:10px; padding:10px 8px 4px; border-top:1px solid var(--st-line); margin-top:8px; }
.st-avatar { width:32px; height:32px; border-radius:50%; background:linear-gradient(135deg,var(--st-accent2),#a78bfa); display:grid; place-items:center; font-weight:600; font-size:14px; flex:none; }
.st-me-text { min-width:0; flex:1; display:flex; flex-direction:column; } .st-me-text strong { font-size:13px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .st-me-text small { color:var(--st-faint); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

/* main + top bar */
.st-main { display:flex; flex-direction:column; min-width:0; min-height:0; position:relative; }
.st-top { height:56px; flex:none; display:flex; align-items:center; gap:12px; padding:0 16px; }
.st-title { display:flex; align-items:center; gap:10px; min-width:0; flex:1; }
.st-title strong { font-weight:600; font-size:15px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.st-pill { font-size:11px; padding:2px 9px; border-radius:99px; background:rgba(255,255,255,.07); color:var(--st-dim); text-transform:capitalize; flex:none; }
.st-pill.active { background:rgba(74,222,128,.14); color:var(--st-ok); } .st-pill.generation_failed { background:rgba(248,113,113,.14); color:var(--st-bad); }
.st-actions { display:flex; align-items:center; gap:8px; }
.st-btn { display:inline-flex; align-items:center; gap:7px; padding:8px 13px; border-radius:10px; border:1px solid var(--st-line2); background:transparent; font-size:13.5px; font-weight:500; text-decoration:none; transition:background .15s,border-color .15s,opacity .15s; white-space:nowrap; }
.st-btn:hover:not(:disabled) { background:rgba(255,255,255,.06); }
.st-btn:disabled { opacity:.38; }
.st-btn.primary { background:linear-gradient(180deg,#6a60f0,var(--st-accent2)); border-color:rgba(143,135,255,.5); color:#fff; box-shadow:0 1px 0 rgba(255,255,255,.18) inset, 0 6px 20px -8px rgba(91,80,230,.8); }
.st-btn.primary:hover:not(:disabled) { background:linear-gradient(180deg,#766df5,#6a60f0); }
.st-btn.small { padding:5px 10px; font-size:12.5px; } .st-btn.big { padding:12px 18px; font-size:15px; width:100%; justify-content:center; border-radius:12px; }
.st-icon { width:36px; height:36px; display:grid; place-items:center; border-radius:10px; background:none; border:0; color:var(--st-dim); }
.st-icon:hover { background:rgba(255,255,255,.07); color:var(--st-text); } .st-icon.on { color:var(--st-accent); background:rgba(143,135,255,.1); }
.only-narrow { display:none; }
.st-menu-wrap { position:relative; } .st-menu-scrim { position:fixed; inset:0; z-index:20; }
.st-menu { position:absolute; right:0; top:calc(100% + 6px); z-index:21; min-width:190px; padding:6px; border-radius:14px; background:var(--st-raise2); border:1px solid var(--st-line2); box-shadow:0 20px 50px -10px rgba(0,0,0,.7); animation:st-pop .12s ease-out; }
.st-menu button { display:flex; align-items:center; gap:10px; width:100%; padding:9px 11px; border-radius:9px; background:none; border:0; text-align:left; font-size:14px; }
.st-menu button:hover { background:rgba(255,255,255,.07); }
@keyframes st-pop { from { opacity:0; transform:translateY(-4px) scale(.98); } }

/* body: chat + canvas */
.st-body { flex:1; min-height:0; display:flex; }
.st-chat { flex:1; min-width:0; display:flex; flex-direction:column; position:relative; }
.st-chat::before { content:""; position:absolute; inset:0; pointer-events:none; opacity:0; transition:opacity .5s;
  background:radial-gradient(60% 50% at 50% 28%, rgba(111,98,255,.22), transparent 70%), radial-gradient(40% 35% at 78% 8%, rgba(167,139,250,.12), transparent 70%); }
.st-root.welcome .st-chat::before { opacity:1; }
.st-scroll { flex:1; overflow-y:auto; min-height:0; position:relative; }
.st-thread { max-width:760px; margin:0 auto; padding:12px 24px 24px; display:flex; flex-direction:column; gap:22px; }
.st-root.welcome .st-scroll { flex:0 0 auto; overflow:visible; }
.st-root.welcome .st-chat { justify-content:center; padding-bottom:6vh; }

.st-hero { text-align:center; padding:0 0 4px; animation:st-rise .6s cubic-bezier(.2,.7,.2,1); }
.st-mark { width:52px; height:52px; margin:0 auto 22px; border-radius:16px; display:grid; place-items:center; color:#fff;
  background:linear-gradient(145deg,#7a70ff,#4b3fd6); box-shadow:0 0 0 1px rgba(255,255,255,.14) inset, 0 18px 50px -10px rgba(91,80,230,.9); }
.st-hero h1 { margin:0; font-size:clamp(28px,4.4vw,40px); font-weight:650; letter-spacing:-.03em; line-height:1.15;
  background:linear-gradient(180deg,#fff 30%,#b7b2ff); -webkit-background-clip:text; background-clip:text; color:transparent; }
.st-hero p { margin:14px auto 0; max-width:520px; color:var(--st-dim); font-size:16px; }
@keyframes st-rise { from { opacity:0; transform:translateY(10px); } }

.st-msg { display:flex; gap:14px; animation:st-rise .3s ease-out; }
.st-msg.user { justify-content:flex-end; }
.st-bubble { max-width:82%; background:var(--st-raise2); border:1px solid var(--st-line); padding:10px 16px; border-radius:20px 20px 6px 20px; white-space:pre-wrap; overflow-wrap:anywhere; }
.st-spark { width:28px; height:28px; border-radius:50%; flex:none; display:grid; place-items:center; color:var(--st-accent); background:rgba(143,135,255,.12); border:1px solid rgba(143,135,255,.28); margin-top:1px; }
.st-reply { min-width:0; flex:1; }
.st-prose p { margin:0 0 10px; } .st-prose p:last-child { margin-bottom:0; }
.st-prose ul { margin:4px 0 10px; padding-left:20px; } .st-prose li { margin:3px 0; } .st-prose strong { font-weight:600; color:#fff; }
.st-typing { display:flex; gap:5px; padding:10px 0; } .st-typing span { width:7px; height:7px; border-radius:50%; background:var(--st-accent); opacity:.4; animation:st-blink 1.2s infinite; }
.st-typing span:nth-child(2) { animation-delay:.18s; } .st-typing span:nth-child(3) { animation-delay:.36s; }
@keyframes st-blink { 50% { opacity:1; transform:translateY(-3px); } }
.st-tools { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
.st-tools span { display:inline-flex; align-items:center; gap:5px; font-size:12px; color:var(--st-dim); padding:3px 10px; border-radius:99px; border:1px solid var(--st-line); background:rgba(255,255,255,.03); }
.st-tools svg { color:var(--st-ok); }
.st-note { align-self:center; display:inline-flex; align-items:center; gap:7px; font-size:13px; color:var(--st-dim); padding:5px 13px; border-radius:99px; background:rgba(255,255,255,.04); border:1px solid var(--st-line); }
.st-note.ok { color:var(--st-ok); background:rgba(74,222,128,.07); border-color:rgba(74,222,128,.2); } .st-note.error { color:var(--st-bad); background:rgba(248,113,113,.07); border-color:rgba(248,113,113,.22); }
.st-failed { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:8px; font-size:13.5px; color:var(--st-bad); }
.st-failed button { background:none; border:1px solid var(--st-line2); color:var(--st-text); border-radius:8px; padding:3px 10px; font-size:13px; }
.st-setup { display:flex; gap:12px; padding:14px 16px; border-radius:14px; border:1px solid rgba(251,191,36,.3); background:rgba(251,191,36,.06); color:var(--st-warn); font-size:14px; }
.st-setup p { margin:4px 0 0; color:var(--st-dim); } .st-setup code { font-family:ui-monospace,monospace; font-size:12.5px; }

/* composer */
.st-dock { flex:none; padding:0 24px 14px; position:relative; }
.st-dock-inner { max-width:760px; margin:0 auto; }
.st-composer { background:var(--st-raise); border:1px solid var(--st-line2); border-radius:26px; padding:14px 14px 10px 20px; box-shadow:0 20px 60px -20px rgba(0,0,0,.8), 0 0 0 0 rgba(143,135,255,0); transition:border-color .2s, box-shadow .2s; }
.st-composer:focus-within { border-color:rgba(143,135,255,.55); box-shadow:0 20px 60px -20px rgba(0,0,0,.8), 0 0 0 4px rgba(143,135,255,.1); }
.st-composer textarea { width:100%; background:none; border:0; outline:0; resize:none; color:var(--st-text); font:inherit; font-size:16px; line-height:1.5; max-height:200px; padding:2px 0; display:block; }
.st-composer textarea::placeholder { color:var(--st-faint); }
.st-composer-bar { display:flex; align-items:center; gap:10px; margin-top:6px; }
.st-composer-hint { flex:1; font-size:12px; color:var(--st-faint); }
.st-round { width:36px; height:36px; border-radius:50%; display:grid; place-items:center; border:0; flex:none; transition:transform .12s, background .15s, opacity .15s; }
.st-round.ghost { background:transparent; color:var(--st-dim); border:1px solid var(--st-line2); } .st-round.ghost:hover:not(:disabled) { background:rgba(255,255,255,.07); color:var(--st-text); }
.st-round.send { background:#fff; color:#0c0d11; } .st-round.send:hover:not(:disabled) { transform:scale(1.06); } .st-round.send:disabled { background:rgba(255,255,255,.14); color:var(--st-faint); }
.st-starters { display:flex; flex-wrap:wrap; gap:8px; justify-content:center; margin-top:18px; }
.st-starters button { display:inline-flex; align-items:center; gap:8px; padding:9px 15px; border-radius:99px; background:rgba(255,255,255,.035); border:1px solid var(--st-line); color:var(--st-dim); font-size:14px; transition:all .15s; }
.st-starters button:hover:not(:disabled) { background:rgba(143,135,255,.1); border-color:rgba(143,135,255,.4); color:var(--st-text); transform:translateY(-1px); }
.st-starters svg { color:var(--st-accent); }
.st-fine { text-align:center; font-size:12px; color:var(--st-faint); margin:10px 0 0; }
.st-root.welcome .st-dock { padding-bottom:0; }

/* canvas */
.st-canvas { width:0; opacity:0; overflow:hidden; flex:none; display:flex; flex-direction:column; background:var(--st-panel); border-left:1px solid var(--st-line); transition:width .35s cubic-bezier(.2,.7,.2,1), opacity .25s; }
.st-canvas.open { width:min(520px,44vw); opacity:1; }
.st-canvas > * { min-width:min(520px,44vw); }
.st-canvas-head { display:flex; align-items:center; gap:10px; padding:10px 14px; border-bottom:1px solid var(--st-line); flex:none; }
.st-tabs { display:flex; gap:2px; padding:3px; background:rgba(255,255,255,.05); border-radius:11px; margin-right:auto; }
.st-tabs button { background:none; border:0; padding:5px 16px; border-radius:8px; font-size:13.5px; color:var(--st-dim); font-weight:500; }
.st-tabs button.on { background:var(--st-raise2); color:var(--st-text); box-shadow:0 1px 3px rgba(0,0,0,.4); } .st-tabs button:disabled { opacity:.35; }
.st-canvas-body { flex:1; overflow-y:auto; padding:16px; min-height:0; display:flex; flex-direction:column; gap:14px; }
.st-card { background:var(--st-raise); border:1px solid var(--st-line); border-radius:16px; padding:16px; animation:st-rise .35s ease-out; }
.st-card h3 { margin:2px 0 10px; font-size:18px; font-weight:600; letter-spacing:-.01em; }
.st-card-head { display:flex; align-items:center; justify-content:space-between; font-size:12.5px; color:var(--st-dim); }
.st-label { font-size:11px; font-weight:600; letter-spacing:.12em; text-transform:uppercase; color:var(--st-accent); }
.st-chips { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px; } .st-chips span { font-size:12px; padding:3px 10px; border-radius:99px; background:rgba(255,255,255,.06); color:var(--st-dim); } .st-chips .strong { background:rgba(143,135,255,.14); color:#c9c5ff; }
.st-plan-section { padding:12px 0; border-top:1px solid var(--st-line); }
.st-plan-head { display:flex; align-items:center; gap:11px; } .st-plan-head div { display:flex; flex-direction:column; } .st-plan-head small { color:var(--st-faint); font-size:12.5px; }
.st-plan-icon { width:30px; height:30px; border-radius:9px; display:grid; place-items:center; color:var(--st-accent); background:rgba(143,135,255,.12); }
.st-plan-section ul { margin:10px 0 0 41px; padding:0; list-style:none; } .st-plan-section li { position:relative; color:var(--st-dim); font-size:13.5px; padding:2px 0 2px 14px; } .st-plan-section li::before { content:""; position:absolute; left:0; top:11px; width:5px; height:5px; border-radius:50%; background:var(--st-accent); opacity:.6; }
.st-plan-notes { margin:8px 0 0 41px; font-size:13px; color:var(--st-faint); }
.st-bar { height:5px; background:rgba(255,255,255,.07); border-radius:9px; overflow:hidden; margin:12px 0 4px; } .st-bar span { display:block; height:100%; border-radius:9px; background:linear-gradient(90deg,var(--st-accent2),#a78bfa); transition:width .6s ease; background-size:200% 100%; animation:st-slide 2s linear infinite; }
@keyframes st-slide { to { background-position:-200% 0; } }
.st-step-group { margin-top:12px; } .st-step-group-name { font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--st-faint); font-weight:600; margin-bottom:4px; }
.st-step { display:flex; gap:10px; padding:3px 0; font-size:13.5px; color:var(--st-faint); } .st-step.running { color:var(--st-text); } .st-step.done { color:var(--st-dim); } .st-step.failed { color:var(--st-bad); }
.st-step small { display:block; color:var(--st-faint); font-size:12px; } .st-step em { font-style:normal; color:var(--st-faint); }
.st-step-icon { width:18px; height:18px; display:grid; place-items:center; flex:none; margin-top:2px; } .st-step.done .st-step-icon { color:var(--st-ok); } .st-step.running .st-step-icon { color:var(--st-accent); }
.st-line { display:flex; gap:8px; align-items:flex-start; font-size:13px; margin-top:8px; } .st-line.ok { color:var(--st-ok); } .st-line.warn { color:var(--st-warn); }
.st-error { padding:10px 13px; border-radius:12px; font-size:13.5px; color:var(--st-bad); background:rgba(248,113,113,.08); border:1px solid rgba(248,113,113,.25); }
.st-build { margin-top:2px; } .st-build .st-fine { margin-top:10px; }

/* paper inside the canvas */
.st-sections { display:flex; gap:6px; flex-wrap:wrap; }
.st-sections button { display:inline-flex; align-items:center; gap:7px; padding:6px 13px; border-radius:99px; background:rgba(255,255,255,.04); border:1px solid var(--st-line); color:var(--st-dim); font-size:13px; }
.st-sections button.on { background:rgba(143,135,255,.14); border-color:rgba(143,135,255,.4); color:#fff; }
.ep { color:var(--st-text); font-size:14px; line-height:1.6; }
.ep h1 { font-size:22px; margin:0 0 6px; } .ep h2 { font-size:17px; margin:26px 0 10px; } .ep h3 { font-size:15px; margin:0 0 10px; color:#fff; }
.ep small { font-weight:400; color:var(--st-faint); }
.ep-part { padding:18px; margin-bottom:14px; border:1px solid var(--st-line); border-radius:16px; background:var(--st-raise); }
.ep-passage { margin:0 0 12px; color:#d5d8e2; }
.ep-instr, .ep-hint { color:var(--st-faint); font-size:13px; margin:0 0 10px; } .ep-hint { margin-left:8px; font-size:12px; }
.ep-group { margin:16px 0 8px; display:flex; flex-direction:column; gap:2px; } .ep-group strong { color:var(--st-accent); font-size:13px; } .ep-group span { color:var(--st-dim); font-size:13px; }
.ep-question { margin:0 0 10px; } .ep-q, .ep-q p { margin:0; } .ep-q > p { margin:0; }
.ep-n { display:inline-grid; place-items:center; min-width:24px; height:22px; padding:0 6px; margin-right:9px; border-radius:7px; background:rgba(255,255,255,.08); font-size:12px; font-weight:600; color:#fff; }
.ep-qpassage { display:block; padding:8px 12px; margin:6px 0 8px; border-left:2px solid var(--st-line2); color:var(--st-dim); font-style:normal; }
.ep-answer { display:inline-block; margin-left:8px; padding:1px 9px; border-radius:7px; font-size:12.5px; font-weight:600; color:var(--st-ok); background:rgba(74,222,128,.1); border:1px solid rgba(74,222,128,.22); }
.ep-blank { display:inline-block; min-width:80px; border-bottom:1.5px solid var(--st-line2); margin:0 4px; text-align:center; }
.ep-options { margin:6px 0 4px 34px; padding:0; color:var(--st-dim); } .ep-options li { margin:2px 0; } .ep-options li.right { color:var(--st-ok); font-weight:500; } .ep-options b { margin-right:6px; }
.ep-bank { list-style:none; padding:10px 14px; margin:8px 0; border-radius:12px; background:rgba(255,255,255,.04); display:grid; gap:2px; font-size:13px; color:var(--st-dim); } .ep-bank b { color:#fff; margin-right:6px; }
.ep-notes { margin:0 0 10px; } .ep-notes p { margin:2px 0; } .ep-notes strong { display:block; margin-bottom:2px; }
.ep-scroll { overflow-x:auto; } .ep-table { border-collapse:collapse; width:100%; font-size:13px; } .ep-table th, .ep-table td { border:1px solid var(--st-line2); padding:7px 10px; text-align:left; } .ep-table th { background:rgba(255,255,255,.05); }
.ep-transcript { margin-top:10px; color:var(--st-dim); font-size:13px; } .ep-transcript summary { cursor:pointer; color:var(--st-accent); }

/* modal + toast */
.st-modal-scrim { position:fixed; inset:0; z-index:50; background:rgba(4,5,8,.7); backdrop-filter:blur(6px); display:grid; place-items:center; padding:20px; animation:st-fade .15s; }
@keyframes st-fade { from { opacity:0; } }
.st-modal { width:min(440px,100%); background:var(--st-raise); border:1px solid var(--st-line2); border-radius:22px; padding:28px; text-align:center; box-shadow:0 40px 90px -20px rgba(0,0,0,.9); animation:st-pop .2s ease-out; }
.st-modal h2 { margin:14px 0 8px; font-size:20px; letter-spacing:-.01em; } .st-modal p { margin:0 0 18px; color:var(--st-dim); font-size:14.5px; }
.st-modal-icon { width:46px; height:46px; margin:0 auto; border-radius:14px; display:grid; place-items:center; color:#fff; background:linear-gradient(145deg,#7a70ff,#4b3fd6); } .st-modal-icon.ok { background:rgba(74,222,128,.16); color:var(--st-ok); } .st-modal-icon.bad { background:rgba(248,113,113,.16); color:var(--st-bad); }
.st-modal-actions { display:flex; gap:10px; justify-content:center; margin-top:6px; }
.st-modal-busy { display:flex; gap:12px; align-items:center; justify-content:center; padding:20px; color:var(--st-dim); }
.st-code { display:flex; align-items:center; justify-content:center; gap:14px; width:100%; margin:0 0 10px; padding:16px; border-radius:16px; border:1px dashed rgba(143,135,255,.5); background:rgba(143,135,255,.08); font-family:ui-monospace,'JetBrains Mono',monospace; font-size:34px; letter-spacing:.2em; font-weight:700; color:#fff; }
.st-link { display:inline-flex; align-items:center; gap:8px; background:none; border:0; color:var(--st-dim); font-size:13.5px; margin-bottom:20px; } .st-link:hover { color:#fff; }
.st-toast { position:fixed; bottom:28px; left:50%; transform:translateX(-50%); z-index:60; background:#fff; color:#0c0d11; padding:9px 18px; border-radius:99px; font-size:14px; font-weight:500; box-shadow:0 12px 40px -8px rgba(0,0,0,.7); animation:st-rise .2s; }
.st-scrim { display:none; }

/* print */
.st-print { display:none; }
@media print {
  html, body { background:#fff !important; overflow:visible !important; height:auto !important; }
  .st-root { position:static !important; display:block !important; background:#fff !important; color:#000 !important; }
  .st-root > :not(.st-print) { display:none !important; }
  .st-print { display:block !important; color:#000; font:11pt/1.5 Georgia,'Times New Roman',serif; }
  .st-print .ep { color:#000; font-size:11pt; }
  .st-print .ep h1 { font-size:20pt; border-bottom:2px solid #000; padding-bottom:6px; } .st-print .ep-title p { margin:6px 0 18px; color:#444; }
  .st-print .ep h2 { font-size:15pt; margin:22px 0 8px; page-break-before:always; } .st-print .ep-section:first-of-type h2 { page-break-before:auto; }
  .st-print .ep h3 { color:#000; }
  .st-print .ep-part { background:none; border:0; padding:0; border-radius:0; margin-bottom:16px; }
  .st-print .ep-question { page-break-inside:avoid; }
  .st-print .ep-passage { color:#000; text-align:justify; }
  .st-print .ep-n { background:none; border:1px solid #000; color:#000; }
  .st-print .ep-group strong { color:#000; } .st-print .ep-group span, .st-print .ep-instr, .st-print .ep-hint, .st-print .ep-options { color:#222; }
  .st-print .ep-answer { color:#000; background:none; border:1px solid #000; } .st-print .ep-options li.right { color:#000; font-weight:700; }
  .st-print .ep-blank { border-bottom:1px solid #000; min-width:110px; } .st-print .ep-bank { background:none; border:1px solid #999; color:#000; } .st-print .ep-bank b { color:#000; }
  .st-print .ep-table th, .st-print .ep-table td { border-color:#000; background:none; }
  .st-print .ep-transcript { display:none; }
  .st-print-break { page-break-before:always; }
  @page { margin:16mm; }
}

/* narrow screens: sidebar becomes a drawer, canvas an overlay */
@media (max-width: 900px) {
  .st-root { grid-template-columns:1fr; }
  .only-narrow { display:grid; }
  .st-side { position:fixed; z-index:40; inset:0 auto 0 0; width:280px; transform:translateX(-100%); transition:transform .25s ease; box-shadow:20px 0 60px rgba(0,0,0,.6); }
  .st-side.open { transform:none; }
  .st-scrim { display:block; position:fixed; inset:0; z-index:39; background:rgba(0,0,0,.55); }
  .st-canvas { position:fixed; z-index:30; inset:56px 0 0 0; width:auto !important; transform:translateY(100%); opacity:1; border-left:0; border-top:1px solid var(--st-line2); border-radius:20px 20px 0 0; transition:transform .3s ease; }
  .st-canvas.open { transform:none; } .st-canvas > * { min-width:0; }
  .st-actions .st-btn span { display:none; } .st-actions .st-btn { padding:8px 10px; }
  .st-actions .st-btn.primary span { display:inline; }
  .st-dock, .st-thread { padding-left:14px; padding-right:14px; }
}
@media (max-width: 520px) { .st-actions .st-btn.primary span { display:none; } .st-title .st-pill { display:none; } }
`;
