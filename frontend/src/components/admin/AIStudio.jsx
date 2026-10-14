import React, { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/router";
import {
  Sparkles, ArrowUp, RotateCcw, BookOpen, Headphones, PenLine, Calculator, Check, Loader2,
  AlertTriangle, Eye, FileSearch, LayoutGrid, X, Circle, Wand2, Info, Pencil, Paperclip,
} from "lucide-react";
import { adminFetch, adminStream } from "../../lib/adminApi";
import MathText from "../shared/MathText";

/**
 * AIStudio.jsx — create an exam by talking to an assistant.
 *
 * Left: the chat. Right: the blueprint the assistant is shaping, then the
 * live progress of the build, then the finished draft. The backend keeps no
 * conversation state (see backend/src/services/studioAgent.js), so this
 * component owns the transcript and sends it back with each message; it is
 * kept in localStorage so a refresh mid-build doesn't lose the thread.
 *
 * Rendered inside AdminDashboard's .ad-root, so it reuses that file's
 * tokens (--ad-purple, --ad-border, …) and .ad-btn styles; only the
 * studio-specific classes (ai-*) are defined here.
 */

const STARTERS = [
  { icon: BookOpen, title: "Full IELTS Academic mock", text: "Build a full IELTS Academic mock: Reading, Listening and Writing at real test difficulty." },
  { icon: Calculator, title: "Digital SAT practice test", text: "Create a full-length digital SAT practice test with both sections." },
  { icon: PenLine, title: "Reading paper for band 7+", text: "I need a hard IELTS Academic Reading paper for students aiming at band 7 or higher." },
  { icon: Headphones, title: "Short listening practice", text: "Make a short IELTS Listening practice with two parts about university life." },
];

const SECTION_META = {
  reading: { icon: BookOpen, name: "Reading" },
  listening: { icon: Headphones, name: "Listening" },
  writing: { icon: PenLine, name: "Writing" },
  "reading-writing": { icon: BookOpen, name: "Reading and Writing" },
  math: { icon: Calculator, name: "Math" },
};

const TOOL_LABEL = {
  set_blueprint: "Updated the blueprint",
  build_exam: "Started the build",
  get_exam: "Looked at the exam",
  revise_exam: "Started a rewrite",
};

const READING_QUESTIONS = [13, 26, 40];

function sectionSummary(section) {
  if (section.type === "reading") return `${section.parts} passage${section.parts > 1 ? "s" : ""} · ${READING_QUESTIONS[section.parts - 1]} questions · ${section.parts * 20} min`;
  if (section.type === "listening") return `${section.parts} part${section.parts > 1 ? "s" : ""} · ${section.parts * 10} questions · with audio`;
  if (section.type === "writing") return "Task 1 and Task 2 · 60 min";
  if (section.type === "reading-writing") return "3 adaptive modules · 27 questions each · 32 min";
  return "3 adaptive modules · 22 questions each · 35 min";
}

function topicLabel(section, index) {
  if (section.type === "reading") return `Passage ${index + 1}`;
  if (section.type === "listening") return `Part ${index + 1}`;
  if (section.type === "writing") return `Task ${index + 1}`;
  return "Focus";
}

let idSeq = 0;
const nextId = () => `m${Date.now().toString(36)}${idSeq++}`;

// Just enough formatting for chat replies: paragraphs, "- " lists and **bold**.
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
  return (
    <>
      {blocks.map((block, i) =>
        Array.isArray(block)
          ? <ul key={i}>{block.map((li, j) => <li key={j}>{inline(li)}</li>)}</ul>
          : <p key={i}>{inline(block)}</p>
      )}
    </>
  );
}

export default function AIStudio({ admin, onExamsChanged, onGoToExams }) {
  const router = useRouter();
  const storageKey = `testly-ai-studio:${admin?.adminId || "admin"}`;

  const [status, setStatus] = useState(null); // GET /api/ai/status, null while loading
  const [messages, setMessages] = useState([]); // what the chat shows
  const [history, setHistory] = useState([]); // what the model is sent (opaque)
  const [blueprint, setBlueprint] = useState(null);
  const [examId, setExamId] = useState(null);
  const [job, setJob] = useState(null);
  const [examInfo, setExamInfo] = useState(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [starting, setStarting] = useState(false);
  const [panelError, setPanelError] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [restored, setRestored] = useState(false);

  // Things done in the panel since the last message, passed to the assistant
  // with the next one so it isn't working from a stale picture.
  const pendingEvents = useRef([]);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const lastJobStatus = useRef(null);
  const fileRef = useRef(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    adminFetch("/api/ai/status").then(setStatus).catch(() => setStatus({ configured: false, unreachable: true }));
  }, []);

  // Restore the conversation after a refresh.
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
    } catch {
      // unreadable saved state — start fresh
    }
    setRestored(true);
  }, [storageKey]);

  useEffect(() => {
    if (!restored || sending) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ messages, history, blueprint, examId, pendingEvents: pendingEvents.current }));
    } catch {
      // storage full or unavailable — the chat still works for this visit
    }
  }, [restored, sending, messages, history, blueprint, examId, storageKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Grow the composer with its text, up to the CSS max-height.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  const addNote = useCallback((text, tone) => {
    setMessages((prev) => [...prev, { id: nextId(), role: "note", text, tone }]);
  }, []);

  // Follow the build or rewrite running on this conversation's exam.
  const loadJob = useCallback(async (id) => {
    try {
      const data = await adminFetch(`/api/ai/jobs/${id}`);
      setJob(data.job);
      setExamInfo(data.exam);
      return data;
    } catch {
      // The exam was deleted from the Exams page — forget it.
      setExamId(null);
      setJob(null);
      setExamInfo(null);
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
    };
    tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [examId, loadJob, job?.startedAt]);

  // When a job finishes, tell the moderator in the chat and queue a note for
  // the assistant.
  useEffect(() => {
    const previous = lastJobStatus.current;
    lastJobStatus.current = job ? `${job.startedAt}:${job.status}` : null;
    if (!job || !previous || previous !== `${job.startedAt}:running` || job.status === "running") return;
    const what = { revise: "rewrite", import: "import of the uploaded paper" }[job.kind] || "build";
    if (job.status === "done") {
      addNote({ revise: "The rewrite is saved to the draft.", import: "The paper is digitised and saved as a draft. Check it against the original." }[job.kind] || "The exam is built and saved as a draft.", "ok");
      pendingEvents.current.push(`The ${what} finished and the draft is saved.${job.warnings.length ? ` Warnings: ${job.warnings.join(" ")}` : ""}`);
    } else {
      addNote(`The ${what} didn't finish: ${job.error}`, "error");
      pendingEvents.current.push(`The ${what} failed: ${job.error}`);
    }
    onExamsChanged && onExamsChanged();
  }, [job, addNote, onExamsChanged]);

  const send = async (text) => {
    const content = (text ?? input).trim();
    if (!content || sending || !status?.configured) return;
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
        else if (event === "blueprint") setBlueprint(data.blueprint);
        else if (event === "job") { setExamId(data.examId); setJob(data.job); setPanelError(""); onExamsChanged && onExamsChanged(); }
        else if (event === "done") {
          finished = true;
          pendingEvents.current = [];
          setHistory((prev) => [...prev, ...data.turn]);
          if (data.blueprint) setBlueprint(data.blueprint);
          patchReply((m) => ({ ...m, streaming: false }));
        } else if (event === "error") {
          throw new Error(data.message);
        }
      });
      if (!finished) throw new Error("The connection dropped before the reply finished.");
    } catch (e) {
      // The turn isn't added to the transcript, so sending again is a clean
      // retry; both halves are marked failed so the retry replaces them.
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
      setExamId(data.examId);
      setJob(data.job);
      addNote("Build started — you can keep chatting while it runs.");
      pendingEvents.current.push(`The moderator pressed Build; exam ${data.examId} is being built from the current blueprint.`);
      onExamsChanged && onExamsChanged();
    } catch (e) {
      setPanelError(e.details ? `${e.message} ${e.details.join(" ")}` : e.message);
    } finally {
      setStarting(false);
    }
  };

  // Attach a paper: the server digitises the PDF into a draft exam as a
  // background job, shown in the panel like a build.
  const importPaper = async (file) => {
    if (!file || importing) return;
    setImporting(true);
    setPanelError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const data = await adminFetch("/api/ai/import", { method: "POST", body: form });
      setBlueprint(null);
      setExamId(data.examId);
      setJob(data.job);
      addNote(`Reading "${file.name}" — this takes a few minutes.`);
      pendingEvents.current.push(`The moderator attached a paper as a PDF ("${file.name}"); it is being digitised into exam ${data.examId}.`);
      onExamsChanged && onExamsChanged();
    } catch (e) {
      addNote(`Couldn't read "${file.name}": ${e.message}`, "error");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const reset = () => {
    setMessages([]);
    setHistory([]);
    setBlueprint(null);
    setExamId(null);
    setJob(null);
    setExamInfo(null);
    setPanelError("");
    pendingEvents.current = [];
    try { window.localStorage.removeItem(storageKey); } catch { /* nothing to clear */ }
    inputRef.current?.focus();
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const busy = job?.status === "running";
  const ready = !!status?.configured;

  return (
    <div className="ai-studio">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="ad-topbar ai-topbar">
        <div>
          <h1>AI Studio</h1>
          <p className="ad-sub">Describe the mock you need. The assistant plans it with you, then writes it.</p>
        </div>
        {messages.length > 0 && (
          <button className="ad-btn ghost" onClick={reset} disabled={sending}>
            <RotateCcw size={15} /> New chat
          </button>
        )}
      </div>

      <div className="ai-layout">
        <section className="ai-chat">
          <div className="ai-scroll" ref={scrollRef}>
            {status && !ready && (
              <div className="ai-setup">
                <Info size={16} />
                <div>
                  <strong>{status.unreachable ? "The server can't be reached right now." : "AI Studio isn't switched on for this server yet."}</strong>
                  {!status.unreachable && <p>Ask whoever runs your Testly server to add an AI key to the backend (<code>ANTHROPIC_API_KEY</code>, or the free <code>GEMINI_API_KEY</code> and <code>GROQ_API_KEY</code>) and restart it. Uploading exams as ZIP or JSON works as before.</p>}
                </div>
              </div>
            )}

            {messages.length === 0 ? (
              <div className="ai-welcome">
                <div className="ai-welcome-mark"><Sparkles size={22} /></div>
                <h2>What are we building?</h2>
                <p>Say it the way you would to a colleague: which test, how hard, and anything your students need practice with. Or attach a paper you already have as a PDF, and it will be digitised.</p>
                <div className="ai-starters">
                  {STARTERS.map((s) => (
                    <button key={s.title} className="ai-starter" onClick={() => send(s.text)} disabled={!ready || sending}>
                      <span className="ai-starter-icon"><s.icon size={16} /></span>
                      <span><strong>{s.title}</strong><small>{s.text}</small></span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m) => {
                if (m.role === "note") {
                  return <div key={m.id} className={`ai-note ${m.tone || ""}`}>{m.tone === "error" ? <AlertTriangle size={13} /> : m.tone === "ok" ? <Check size={13} /> : <Wand2 size={13} />}{m.text}</div>;
                }
                if (m.role === "user") {
                  return <div key={m.id} className="ai-row user"><div className="ai-bubble user">{m.text}</div></div>;
                }
                return (
                  <div key={m.id} className="ai-row">
                    <div className="ai-avatar"><Sparkles size={14} /></div>
                    <div className="ai-reply">
                      {m.text && <div className="ai-bubble"><RichText text={m.text} /></div>}
                      {m.streaming && !m.text && <div className="ai-bubble ai-typing"><span /><span /><span /></div>}
                      {m.tools?.length > 0 && (
                        <div className="ai-tools">
                          {[...new Set(m.tools)].map((t) => <span key={t} className="ai-tool"><Check size={11} />{TOOL_LABEL[t] || t}</span>)}
                        </div>
                      )}
                      {m.failed && (
                        <div className="ai-failed">
                          <AlertTriangle size={13} /> {m.error}
                          <button onClick={() => send(m.retryText)} disabled={sending}>Try again</button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="ai-composer">
            <input ref={fileRef} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => importPaper(e.target.files?.[0])} />
            <button className="ai-attach" onClick={() => fileRef.current?.click()} disabled={!ready || !status?.pdf || importing || busy}
              title={status?.pdf === false ? "Reading PDFs needs a Claude or Gemini key on the server" : "Attach a paper as a PDF to digitise it"} aria-label="Attach a PDF">
              {importing ? <Loader2 size={16} className="spin-icon" /> : <Paperclip size={16} />}
            </button>
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={ready ? "Describe the exam or ask for a change…" : "AI Studio is not available"}
              disabled={!ready}
              maxLength={6000}
            />
            <button className="ai-send" onClick={() => send()} disabled={!ready || sending || !input.trim()} aria-label="Send">
              {sending ? <Loader2 size={16} className="spin-icon" /> : <ArrowUp size={17} />}
            </button>
          </div>
        </section>

        <aside className="ai-panel">
          {!blueprint && !examId ? (
            <div className="ai-panel-empty">
              <div className="ai-ghost"><span /><span /><span /></div>
              <strong>The exam plan appears here</strong>
              <p>Sections, topics and timing, ready for you to approve before anything is written.</p>
            </div>
          ) : (
            <>
              {panelError && <div className="ad-error ai-panel-error">{panelError}</div>}

              {examId && !busy && examInfo?.status === "draft" && (
                <div className="ai-done">
                  <div className="ai-done-head"><span className="ai-done-check"><Check size={14} /></span><div><strong>Draft ready</strong><small>{examInfo.title}</small></div></div>
                  <div className="ai-done-actions">
                    <button className="ad-btn primary small" onClick={() => setReviewOpen(true)}><FileSearch size={14} /> Review with answers</button>
                    <button className="ad-btn ghost small" onClick={() => router.push(`/admin-preview/${examId}`)}><Eye size={14} /> Student view</button>
                    <button className="ad-btn ghost small" onClick={() => router.push(`/admin-editor/${examId}`)}><Pencil size={14} /> Edit</button>
                    <button className="ad-btn ghost small" onClick={onGoToExams}><LayoutGrid size={14} /> Exams</button>
                  </div>
                  <p className="ai-fineprint">
                    {job?.kind === "import"
                      ? "Digitised from your PDF. Check it against the original before students sit it, and use Edit to add any figures or audio it needs."
                      : "AI-written content should be read by a teacher before students sit it. Ask for changes in the chat, for example \"make passage 2 harder\", or fix things yourself with Edit."}
                  </p>
                </div>
              )}

              {job && (job.status !== "done" || job.notes.length > 0 || job.warnings.length > 0) && <Progress job={job} />}

              {examInfo?.status === "generation_failed" && !job && (
                <div className="ad-error ai-panel-error">{examInfo.generationError}</div>
              )}

              {blueprint && <Blueprint blueprint={blueprint} compact={!!examId} />}

              {blueprint && !busy && (
                <div className="ai-build">
                  <button className="ad-btn primary ai-build-btn" onClick={build} disabled={starting || sending || !ready}>
                    {starting ? <Loader2 size={15} className="spin-icon" /> : <Sparkles size={15} />}
                    {examId ? "Build again as a new exam" : "Build this exam"}
                  </button>
                  {!examId && (
                    <p className="ai-fineprint">
                      {status?.provider === "compat"
                        ? "Runs on free AI models: allow 5 to 20 minutes, and only a few builds fit in a day. The result is saved as a draft."
                        : "Takes a few minutes and uses your centre's AI credits. The result is saved as a draft."}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </aside>
      </div>

      {reviewOpen && examId && <ReviewModal examId={examId} onClose={() => setReviewOpen(false)} />}
    </div>
  );
}

// ---------------- Blueprint card ----------------
function Blueprint({ blueprint, compact }) {
  // Once the exam exists the plan is reference material: fold the detail
  // away so the build's progress and result stay in view.
  const [open, setOpen] = useState(false);
  const detailed = !compact || open;
  const kind = blueprint.testType === "sat" ? "Digital SAT" : `IELTS ${blueprint.variant === "general" ? "General Training" : "Academic"}`;
  const level = { easy: "Easier than the real test", medium: "Real test difficulty", hard: "Harder than the real test" }[blueprint.difficulty];
  return (
    <div className="ai-blueprint">
      <div className="ai-panel-label">Blueprint</div>
      <h3>{blueprint.title}</h3>
      <div className="ai-chips"><span className="ai-chip strong">{kind}</span><span className="ai-chip">{level}</span></div>
      {blueprint.sections.map((section) => {
        const meta = SECTION_META[section.type];
        return (
          <div className="ai-section" key={section.type}>
            <div className="ai-section-head">
              <span className="ai-section-icon"><meta.icon size={15} /></span>
              <div><strong>{meta.name}</strong><small>{sectionSummary(section)}</small></div>
            </div>
            {detailed && section.topics.length > 0 && (
              <ul className="ai-topics">
                {section.topics.map((topic, i) => <li key={i}><span>{topicLabel(section, i)}</span>{topic}</li>)}
              </ul>
            )}
            {detailed && section.notes && <p className="ai-section-notes">{section.notes}</p>}
          </div>
        );
      })}
      {compact && (
        <button className="ai-toggle" onClick={() => setOpen(!open)}>{open ? "Hide topics" : "Show topics"}</button>
      )}
    </div>
  );
}

// ---------------- Build / rewrite progress ----------------
function Progress({ job }) {
  const finished = job.steps.filter((s) => s.status === "done").length;
  const running = job.status === "running";
  const groups = [];
  job.steps.forEach((step) => {
    const last = groups[groups.length - 1];
    if (last && last.name === step.group) last.steps.push(step);
    else groups.push({ name: step.group, steps: [step] });
  });

  return (
    <div className={`ai-progress ${job.status}`}>
      <div className="ai-progress-head">
        <div className="ai-panel-label">{{ revise: "Rewrite", import: "Import" }[job.kind] || "Build"}</div>
        <span>{running ? `${finished} of ${job.steps.length} done` : job.status === "done" ? "Finished" : "Stopped"}</span>
      </div>
      {running && <div className="ai-bar"><span style={{ width: `${Math.max(4, (finished / job.steps.length) * 100)}%` }} /></div>}

      {(running || job.status === "failed") && groups.map((group) => (
        <div className="ai-step-group" key={group.name}>
          <div className="ai-step-group-name">{group.name}</div>
          {group.steps.map((step) => (
            <div className={`ai-step ${step.status}`} key={step.id}>
              <span className="ai-step-icon">
                {step.status === "running" ? <Loader2 size={13} className="spin-icon" />
                  : step.status === "done" ? <Check size={12} />
                  : step.status === "failed" ? <X size={12} />
                  : <Circle size={9} />}
              </span>
              <div>
                <span className="ai-step-label">{step.label}{step.hint ? <em> · {step.hint}</em> : null}</span>
                {step.detail && (step.status === "running" || step.status === "failed") && <small>{step.detail}</small>}
              </div>
            </div>
          ))}
        </div>
      ))}

      {job.status === "failed" && <div className="ad-error ai-panel-error">{job.error}</div>}
      {job.status === "done" && job.notes.map((note, i) => <div className="ai-job-line ok" key={`n${i}`}><Check size={13} />{note}</div>)}
      {job.status !== "running" && job.warnings.map((warning, i) => <div className="ai-job-line warn" key={`w${i}`}><AlertTriangle size={13} />{warning}</div>)}
    </div>
  );
}

// ---------------- Review modal: every question with its answer ----------------
function ReviewModal({ examId, onClose }) {
  const [exam, setExam] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState(0);

  useEffect(() => {
    adminFetch(`/api/exams/${examId}`).then(setExam).catch((e) => setError(e.message));
  }, [examId]);

  const section = exam?.sections?.[tab];
  return (
    <div className="ad-modal-overlay" onMouseDown={onClose}>
      <div className="ad-modal ai-review" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ad-modal-head">
          <h2>{exam?.title || "Review"}</h2>
          <button className="ad-iconbtn" onClick={onClose}><X size={18} /></button>
        </div>
        {exam && (
          <div className="ad-modal-tabs">
            {exam.sections.map((s, i) => (
              <button key={s.type} className={tab === i ? "active" : ""} onClick={() => setTab(i)}>{SECTION_META[s.type]?.name || s.type}</button>
            ))}
          </div>
        )}
        <div className="ad-modal-body ai-review-body">
          {error && <div className="ad-error">{error}</div>}
          {!exam && !error && <p className="ai-fineprint">Loading…</p>}
          {section && Array.isArray(section.modules) && section.modules.map((mod) => (
            <div className="ai-rv-part" key={mod.id}>
              <h4>{mod.stage === "module1" ? "Module 1" : `Module 2 · ${mod.difficulty === "hard" ? "harder" : "easier"}`}<small>{mod.questions.length} questions · {mod.durationMinutes} min</small></h4>
              {mod.questions.map((q) => <ReviewQuestion key={q.id} q={q} math={section.type === "math"} />)}
            </div>
          ))}
          {section && section.type === "reading" && section.parts.map((part) => (
            <div className="ai-rv-part" key={part.id}>
              <h4>{part.title}</h4>
              <div className="ai-rv-passage">{part.passage.map((p, i) => <p key={i}>{p}</p>)}</div>
              {part.questions.map((q) => <ReviewQuestion key={q.id} q={q} />)}
            </div>
          ))}
          {section && section.type === "listening" && section.parts.map((part) => (
            <div className="ai-rv-part" key={part.id}>
              <h4>{part.title}</h4>
              {part.audioUrl ? <audio controls src={part.audioUrl} className="ai-rv-audio" /> : <div className="ai-job-line warn"><AlertTriangle size={13} />No audio recorded for this part yet.</div>}
              <details className="ai-rv-script"><summary>Script</summary><p>{part.transcript}</p></details>
              {(part.items || []).map((item, i) => (
                <div key={i} className="ai-rv-item">
                  {item.label && <strong>{item.label}</strong>}
                  {item.lines.map((line, j) => line.n === undefined
                    ? <div key={j} className="ai-rv-line">{line.pre} {line.text}</div>
                    : <div key={j} className="ai-rv-line"><span className="ai-rv-n">{line.n}</span>{line.pre} <span className="ai-rv-answer">{[].concat(line.answer ?? "—").join(" / ")}</span> {line.post}</div>)}
                </div>
              ))}
              {(part.questions || []).map((q) => <ReviewQuestion key={q.id} q={q} />)}
            </div>
          ))}
          {section && section.type === "writing" && section.parts.map((part, i) => (
            <div className="ai-rv-part" key={part.id}>
              <h4>Task {i + 1}<small>{part.instructions}</small></h4>
              <p className="ai-rv-prompt">{part.prompt}</p>
              {part.chartImageUrl && <img src={part.chartImageUrl} alt="Chart for this task" className="ai-rv-chart" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ReviewQuestion({ q, math }) {
  const show = (text) => (math ? <MathText text={text} /> : text);
  if (q.type === "table") {
    return (
      <div className="ai-rv-q">
        {q.groupTitle && <div className="ai-rv-group">{q.groupTitle}{q.groupInstructions ? ` — ${q.groupInstructions}` : ""}</div>}
        <table className="ai-rv-table">
          <thead><tr>{q.table.headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
          <tbody>
            {q.table.rows.map((row, ri) => (
              <tr key={ri}>{row.map((cell, ci) => {
                const gap = q.gaps.find((g) => g.cellMarker === cell);
                return <td key={ci}>{gap ? <><span className="ai-rv-n">{gap.n}</span><span className="ai-rv-answer">{[].concat(gap.answer).join(" / ")}</span></> : cell}</td>;
              })}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (q.type === "map") {
    return (
      <div className="ai-rv-q">
        {q.groupTitle && <div className="ai-rv-group">{q.groupTitle}{q.groupInstructions ? ` — ${q.groupInstructions}` : ""}</div>}
        {q.imageUrl && <img src={q.imageUrl} alt="Diagram" className="ai-rv-chart" />}
        {q.points.map((pt) => <div key={pt.id} className="ai-rv-line"><span className="ai-rv-n">{pt.n}</span><span className="ai-rv-answer">{[].concat(pt.answer).join(" / ")}</span></div>)}
      </div>
    );
  }
  const letters = q.optionLetters || (q.options || []).map((_, i) => String.fromCharCode(65 + i));
  return (
    <div className="ai-rv-q">
      {q.groupTitle && <div className="ai-rv-group">{q.groupTitle}{q.groupInstructions ? ` — ${q.groupInstructions}` : ""}</div>}
      {q.passage && <p className="ai-rv-qpassage">{q.passage}</p>}
      <div className="ai-rv-line">
        <span className="ai-rv-n">{q.n}</span>
        {q.type === "gap-fill"
          ? <span>{q.before} <span className="ai-rv-answer">{[].concat(q.answer).join(" / ")}</span> {q.after}</span>
          : <span>{show(q.prompt)}</span>}
      </div>
      {q.type === "mcq" && (
        <ul className="ai-rv-options">
          {q.options.map((opt, i) => <li key={i} className={opt === q.answer ? "correct" : ""}><span>{letters[i]}</span><div>{show(opt)}</div></li>)}
        </ul>
      )}
      {q.type === "matching" && (
        <ul className="ai-rv-options">
          {q.options.map((opt, i) => <li key={i} className={String(letters[i]) === String(q.answer) ? "correct" : ""}><span>{letters[i]}</span>{opt}</li>)}
        </ul>
      )}
      {(q.type === "tfng" || q.type === "grid-in") && <div className="ai-rv-key">Answer: <span className="ai-rv-answer">{show(q.answer)}</span></div>}
    </div>
  );
}

const CSS = `
.ai-studio { display:flex; flex-direction:column; height:calc(100vh - 64px); min-height:560px; }
.ai-topbar { flex-shrink:0; margin-bottom:18px; }
.ai-layout { flex:1; min-height:0; display:grid; grid-template-columns:minmax(0,1fr) 372px; gap:18px; }

.ai-chat { display:flex; flex-direction:column; min-height:0; background:var(--ad-surface); border:1px solid var(--ad-border); border-radius:14px; overflow:hidden; }
.ai-scroll { flex:1; min-height:0; overflow-y:auto; padding:22px 24px 8px; display:flex; flex-direction:column; gap:14px; }

.ai-setup { display:flex; gap:10px; background:#fff6e5; color:#8a5a00; border:1px solid #f5deac; padding:12px 14px; border-radius:10px; font-size:12.5px; line-height:1.55; }
.ai-setup svg { flex-shrink:0; margin-top:2px; }
.ai-setup p { margin:3px 0 0; }
.ai-setup code { background:rgba(138,90,0,.1); padding:1px 5px; border-radius:4px; font-size:11.5px; }

.ai-welcome { margin:auto; width:100%; max-width:560px; text-align:center; padding:12px 0 26px; animation:cardIn .3s ease; }
.ai-welcome-mark { width:46px; height:46px; margin:0 auto 14px; display:flex; align-items:center; justify-content:center; border-radius:13px; background:var(--ad-purple); color:#fff; box-shadow:0 8px 20px rgba(91,80,230,.28); }
.ai-welcome h2 { margin:0 0 6px; font-size:20px; letter-spacing:-.3px; }
.ai-welcome p { margin:0 auto 22px; max-width:420px; color:var(--ad-muted); font-size:12.5px; line-height:1.6; }
.ai-starters { display:grid; grid-template-columns:1fr 1fr; gap:10px; text-align:left; }
.ai-starter { display:flex; gap:11px; align-items:flex-start; text-align:left; padding:13px 14px; background:var(--ad-bg); border:1px solid var(--ad-border); border-radius:11px; font:inherit; color:var(--ad-text); cursor:pointer; transition:border-color .15s ease, background-color .15s ease, transform .15s ease; }
.ai-starter:hover:not(:disabled) { border-color:var(--ad-purple); background:#faf9ff; transform:translateY(-1px); }
.ai-starter:disabled { opacity:.55; cursor:not-allowed; }
.ai-starter-icon { flex-shrink:0; width:30px; height:30px; display:flex; align-items:center; justify-content:center; border-radius:8px; background:#eeecfd; color:var(--ad-purple); }
.ai-starter strong { display:block; font-size:12.5px; margin-bottom:3px; }
.ai-starter small { display:block; color:var(--ad-muted); font-size:11px; line-height:1.5; }

.ai-row { display:flex; gap:10px; align-items:flex-start; animation:cardIn .2s ease; }
.ai-row.user { justify-content:flex-end; }
.ai-avatar { flex-shrink:0; width:28px; height:28px; display:flex; align-items:center; justify-content:center; border-radius:8px; background:#eeecfd; color:var(--ad-purple); margin-top:2px; }
.ai-reply { min-width:0; max-width:86%; display:flex; flex-direction:column; gap:7px; align-items:flex-start; }
.ai-bubble { background:var(--ad-bg); border:1px solid var(--ad-border); border-radius:4px 13px 13px 13px; padding:10px 14px; font-size:13px; line-height:1.65; color:var(--ad-text); overflow-wrap:anywhere; }
.ai-bubble.user { max-width:78%; background:var(--ad-purple); border-color:var(--ad-purple); color:#fff; border-radius:13px 13px 4px 13px; white-space:pre-wrap; }
.ai-bubble p { margin:0 0 8px; }
.ai-bubble p:last-child, .ai-bubble ul:last-child { margin-bottom:0; }
.ai-bubble ul { margin:0 0 8px; padding-left:18px; }
.ai-bubble li { margin-bottom:3px; }
.ai-typing { display:flex; gap:4px; padding:14px; }
.ai-typing span { width:6px; height:6px; border-radius:50%; background:#aeb3c7; animation:aiDot 1.2s ease-in-out infinite; }
.ai-typing span:nth-child(2) { animation-delay:.15s; }
.ai-typing span:nth-child(3) { animation-delay:.3s; }
@keyframes aiDot { 0%,60%,100% { opacity:.3; transform:translateY(0); } 30% { opacity:1; transform:translateY(-3px); } }
.ai-tools { display:flex; flex-wrap:wrap; gap:6px; }
.ai-tool { display:inline-flex; align-items:center; gap:5px; font-size:10.5px; font-weight:600; color:#4a40d6; background:#eeecfd; padding:3px 9px; border-radius:10px; }
.ai-failed { display:flex; align-items:center; flex-wrap:wrap; gap:7px; font-size:12px; color:#b3261e; background:#fdeceb; padding:8px 11px; border-radius:8px; }
.ai-failed button { border:0; background:none; color:#b3261e; font:inherit; font-weight:700; text-decoration:underline; cursor:pointer; padding:0; }
.ai-note { align-self:center; display:inline-flex; align-items:center; gap:6px; font-size:11.5px; font-weight:600; color:var(--ad-muted); background:var(--ad-bg); border:1px solid var(--ad-border); padding:5px 12px; border-radius:14px; max-width:92%; }
.ai-note.ok { color:#1e7a34; background:#f3faf4; border-color:#cfe8d8; }
.ai-note.error { color:#b3261e; background:#fdf7f7; border-color:#f3cfcf; }

.ai-attach { flex-shrink:0; width:34px; height:34px; display:flex; align-items:center; justify-content:center; border:0; border-radius:10px; background:none; color:var(--ad-muted); cursor:pointer; transition:background-color .15s ease, color .15s ease; }
.ai-attach:hover:not(:disabled) { background:#eeecfd; color:var(--ad-purple); }
.ai-attach:disabled { opacity:.35; cursor:not-allowed; }
.ai-composer { flex-shrink:0; display:flex; align-items:flex-end; gap:6px; margin:10px 16px 16px; padding:8px 8px 8px 8px; border:1.5px solid var(--ad-border); border-radius:13px; background:var(--ad-surface); transition:border-color .15s ease, box-shadow .15s ease; }
.ai-composer:focus-within { border-color:var(--ad-purple); box-shadow:0 0 0 3px rgba(91,80,230,.1); }
.ai-composer textarea { flex:1; border:0; outline:0; resize:none; background:none; font:inherit; font-size:13px; line-height:1.55; color:var(--ad-text); padding:6px 0; max-height:140px; }
.ai-composer textarea::placeholder { color:#9aa1b5; }
.ai-send { flex-shrink:0; width:34px; height:34px; display:flex; align-items:center; justify-content:center; border:0; border-radius:10px; background:var(--ad-purple); color:#fff; cursor:pointer; transition:background-color .15s ease, opacity .15s ease, transform .1s ease; }
.ai-send:hover:not(:disabled) { background:#4a40d6; }
.ai-send:active:not(:disabled) { transform:scale(.95); }
.ai-send:disabled { opacity:.35; cursor:not-allowed; }

.ai-panel { min-height:0; overflow-y:auto; display:flex; flex-direction:column; gap:14px; }
.ai-panel > * { flex-shrink:0; }
.ai-panel-empty { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; gap:6px; padding:28px; border:1.5px dashed #d5d9e6; border-radius:14px; color:var(--ad-muted); }
.ai-panel-empty strong { color:var(--ad-text); font-size:13.5px; }
.ai-panel-empty p { margin:0; font-size:12px; line-height:1.6; max-width:240px; }
.ai-ghost { display:flex; flex-direction:column; gap:7px; width:120px; margin-bottom:12px; }
.ai-ghost span { height:9px; border-radius:5px; background:#e6e8f2; }
.ai-ghost span:nth-child(2) { width:78%; }
.ai-ghost span:nth-child(3) { width:52%; }

.ai-blueprint, .ai-progress, .ai-done { background:var(--ad-surface); border:1px solid var(--ad-border); border-radius:14px; padding:18px; animation:cardIn .25s ease; }
.ai-panel-label { font-size:9.5px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:var(--ad-muted); }
.ai-blueprint h3 { margin:6px 0 10px; font-size:15.5px; line-height:1.35; letter-spacing:-.2px; }
.ai-chips { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:6px; }
.ai-chip { font-size:10.5px; font-weight:600; padding:3px 9px; border-radius:10px; background:#eef0f5; color:#5b6178; }
.ai-chip.strong { background:#eeecfd; color:#4a40d6; }
.ai-section { padding:14px 0 0; margin-top:14px; border-top:1px solid var(--ad-border); }
.ai-section-head { display:flex; align-items:center; gap:10px; }
.ai-section-icon { flex-shrink:0; width:30px; height:30px; display:flex; align-items:center; justify-content:center; border-radius:8px; background:#eeecfd; color:var(--ad-purple); }
.ai-section-head strong { display:block; font-size:12.5px; }
.ai-section-head small { display:block; font-size:11px; color:var(--ad-muted); margin-top:1px; }
.ai-topics { list-style:none; margin:10px 0 0; padding:0; display:flex; flex-direction:column; gap:6px; }
.ai-topics li { font-size:12px; line-height:1.5; color:var(--ad-text); display:flex; gap:8px; }
.ai-topics li span { flex-shrink:0; min-width:58px; font-size:10.5px; font-weight:600; color:var(--ad-muted); padding-top:1.5px; }
.ai-section-notes { margin:9px 0 0; padding:8px 10px; background:var(--ad-bg); border-radius:8px; font-size:11.5px; line-height:1.55; color:#5b6178; }

.ai-toggle { margin-top:12px; padding:0; border:0; background:none; font:inherit; font-size:11.5px; font-weight:600; color:var(--ad-purple); cursor:pointer; }
.ai-toggle:hover { text-decoration:underline; }
.ai-build { display:flex; flex-direction:column; gap:8px; }
.ai-build-btn { justify-content:center; padding:11px 16px; }
.ai-fineprint { margin:0; font-size:11px; line-height:1.55; color:var(--ad-muted); }
.ai-panel-error { margin:0; font-size:12px; line-height:1.5; }

.ai-progress-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
.ai-progress-head > span { font-size:11px; font-weight:600; color:var(--ad-muted); }
.ai-progress.done .ai-progress-head > span { color:#1e7a34; }
.ai-progress.failed .ai-progress-head > span { color:#b3261e; }
.ai-bar { height:5px; border-radius:3px; background:#eef0f5; overflow:hidden; margin-bottom:6px; }
.ai-bar span { display:block; height:100%; border-radius:3px; background:var(--ad-purple); transition:width .5s ease; }
.ai-step-group { margin-top:12px; }
.ai-step-group-name { font-size:11px; font-weight:700; color:var(--ad-text); margin-bottom:5px; }
.ai-step { display:flex; gap:9px; align-items:flex-start; padding:4px 0; font-size:12px; color:var(--ad-muted); }
.ai-step-icon { flex-shrink:0; width:18px; height:18px; display:flex; align-items:center; justify-content:center; border-radius:50%; color:#c3c8d8; }
.ai-step.running { color:var(--ad-text); }
.ai-step.running .ai-step-icon { color:var(--ad-purple); }
.ai-step.done .ai-step-icon { background:#e3f5e8; color:#1e7a34; }
.ai-step.failed { color:#b3261e; }
.ai-step.failed .ai-step-icon { background:#fdeceb; color:#b3261e; }
.ai-step-label { font-weight:600; }
.ai-step-label em { font-style:normal; font-weight:400; color:var(--ad-muted); }
.ai-step small { display:block; font-size:10.5px; margin-top:1px; color:var(--ad-muted); }
.ai-step.failed small { color:#b3261e; }
.ai-job-line { display:flex; gap:7px; align-items:flex-start; font-size:11.5px; line-height:1.5; padding:7px 10px; border-radius:8px; margin-top:8px; }
.ai-job-line svg { flex-shrink:0; margin-top:2px; }
.ai-job-line.ok { background:#f3faf4; color:#1e7a34; }
.ai-job-line.warn { background:#fff8ee; color:#8a5a00; }

.ai-done-head { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
.ai-done-check { flex-shrink:0; width:28px; height:28px; display:flex; align-items:center; justify-content:center; border-radius:50%; background:#e3f5e8; color:#1e7a34; }
.ai-done-head strong { display:block; font-size:13px; }
.ai-done-head small { display:block; font-size:11px; color:var(--ad-muted); }
.ai-done-actions { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px; }

.ai-review { width:860px; max-width:94vw; max-height:90vh; }
.ai-review-body { font-size:13px; line-height:1.6; }
.ai-rv-part { padding-bottom:18px; margin-bottom:18px; border-bottom:1px solid var(--ad-border); }
.ai-rv-part:last-child { border-bottom:0; margin-bottom:0; }
.ai-rv-part h4 { margin:0 0 10px; font-size:14px; }
.ai-rv-part h4 small { display:block; font-size:11px; font-weight:400; color:var(--ad-muted); margin-top:2px; }
.ai-rv-passage { background:var(--ad-bg); border:1px solid var(--ad-border); border-radius:10px; padding:12px 16px; max-height:240px; overflow-y:auto; margin-bottom:14px; font-size:12.5px; }
.ai-rv-passage p { margin:0 0 9px; }
.ai-rv-passage p:first-child { font-weight:700; }
.ai-rv-q { padding:8px 0; border-top:1px solid #f1f2f7; }
.ai-rv-group { font-size:11.5px; font-weight:600; color:#4a40d6; margin:6px 0 8px; }
.ai-rv-qpassage { margin:0 0 8px; padding:9px 12px; background:var(--ad-bg); border-radius:8px; font-size:12.5px; white-space:pre-wrap; }
.ai-rv-line { display:flex; gap:8px; align-items:baseline; padding:2px 0; white-space:pre-wrap; }
.ai-rv-n { flex-shrink:0; min-width:22px; height:20px; padding:0 5px; display:inline-flex; align-items:center; justify-content:center; border-radius:6px; background:#eef0f5; color:#5b6178; font-size:11px; font-weight:700; margin-right:2px; }
.ai-rv-answer { background:#e3f5e8; color:#1e7a34; font-weight:700; padding:1px 7px; border-radius:6px; }
.ai-rv-key { font-size:12px; color:var(--ad-muted); margin:4px 0 0 30px; }
.ai-rv-options { list-style:none; margin:6px 0 0 30px; padding:0; display:flex; flex-direction:column; gap:3px; }
.ai-rv-options li { display:flex; gap:8px; padding:4px 9px; border-radius:7px; font-size:12.5px; }
.ai-rv-options li span { flex-shrink:0; font-weight:700; color:var(--ad-muted); min-width:16px; }
.ai-rv-options li.correct { background:#e3f5e8; color:#1e7a34; font-weight:600; }
.ai-rv-options li.correct span { color:#1e7a34; }
.ai-rv-table { border-collapse:collapse; font-size:12.5px; margin:4px 0; }
.ai-rv-table th, .ai-rv-table td { border:1px solid var(--ad-border); padding:6px 10px; text-align:left; }
.ai-rv-table th { background:var(--ad-bg); }
.ai-rv-audio { width:100%; height:36px; margin-bottom:10px; }
.ai-rv-script { margin-bottom:12px; font-size:12.5px; }
.ai-rv-script summary { cursor:pointer; font-weight:600; color:#4a40d6; }
.ai-rv-script p { white-space:pre-wrap; background:var(--ad-bg); border-radius:8px; padding:10px 14px; margin:8px 0 0; max-height:220px; overflow-y:auto; }
.ai-rv-item { margin-bottom:10px; }
.ai-rv-prompt { white-space:pre-wrap; margin:0 0 10px; }
.ai-rv-chart { display:block; max-width:100%; border:1px solid var(--ad-border); border-radius:8px; }

@media (max-width: 1080px) {
  .ai-studio { height:auto; }
  .ai-layout { grid-template-columns:1fr; }
  .ai-chat { height:70vh; min-height:440px; }
  .ai-panel { overflow:visible; }
}
@media (max-width: 760px) {
  .ai-chat { height:68vh; min-height:400px; }
  .ai-topbar { flex-direction:row !important; align-items:center !important; }
  .ai-composer { margin:8px 10px 10px; }
  .ai-done-actions .ad-btn { flex:1 1 auto; justify-content:center; }
  .ai-starters { grid-template-columns:1fr; }
  .ai-scroll { padding:16px 14px 6px; }
  .ai-reply { max-width:100%; }
}
`;
