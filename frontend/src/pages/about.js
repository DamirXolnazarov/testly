/**
 * about.js
 * "About Testly" — an overview/documentation-style page describing what the
 * platform does, for both educational centers (admins) and students, with a
 * table of contents for quick navigation. Distinct from /docs, which is the
 * technical exam-JSON schema reference for developers/admins building exams
 * by hand — this page is the plain-language "what is this" companion to it.
 */
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { COLORS } from "../lib/theme";

const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "for-centers", label: "For Educational Centers" },
  { id: "for-students", label: "For Students" },
  { id: "question-types", label: "Question Types Supported" },
  { id: "ai-generation", label: "AI-Assisted Exam Generation" },
  { id: "grading", label: "Grading & Results" },
  { id: "resources", label: "Documentation & Resources" },
];

export default function About() {
  return (
    <div className="doc-root">
      <style dangerouslySetInnerHTML={{ __html: `
        html, body, #__next { width:100%; min-height:100%; margin:0; }
        *, *::before, *::after { box-sizing:border-box; }
        .doc-root { min-height:100dvh; background:${COLORS.bg}; font-family:"Poppins",sans-serif; color:${COLORS.navy}; }
        .doc-header { display:flex; align-items:center; gap:10px; padding:20px clamp(20px, 5vw, 56px); border-bottom:1px solid ${COLORS.border}; background:#fff; }
        .doc-back { display:flex; align-items:center; gap:6px; color:${COLORS.navyMuted}; text-decoration:none; font-size:13.5px; font-weight:600; }
        .doc-back:hover { color:${COLORS.purple}; }

        .about-hero { max-width:760px; margin:0 auto; padding:clamp(32px, 6vw, 56px) 20px 12px; text-align:center; }
        .about-logo { width:min(220px, 55vw); height:auto; margin:0 auto 22px; display:block; }
        .about-hero h1 { font-size:clamp(28px, 5vw, 38px); font-weight:800; margin:0 0 12px; }
        .about-hero p { font-size:15.5px; color:${COLORS.navyMuted}; line-height:1.65; max-width:560px; margin:0 auto; }

        .toc-wrap { max-width:760px; margin:34px auto 0; padding:0 20px; }
        .toc-card { background:#fff; border:1px solid ${COLORS.border}; border-radius:14px; padding:18px 22px; }
        .toc-title { font-size:11.5px; font-weight:800; letter-spacing:.6px; text-transform:uppercase; color:${COLORS.purple}; margin:0 0 12px; }
        .toc-list { display:flex; flex-wrap:wrap; gap:8px 18px; margin:0; padding:0; list-style:none; }
        .toc-list a { font-size:13.5px; font-weight:600; color:${COLORS.navy}; text-decoration:none; }
        .toc-list a:hover { color:${COLORS.purple}; }

        .doc-body { max-width:760px; margin:0 auto; padding:36px 20px 80px; line-height:1.7; }
        .doc-body section { margin-bottom:44px; scroll-margin-top:24px; }
        .doc-body h2 { font-size:clamp(19px, 3.5vw, 22px); font-weight:800; margin:0 0 14px; }
        .doc-body p { font-size:14.5px; color:#333a52; margin:0 0 14px; }
        .doc-body ul { margin:0 0 14px; padding-left:22px; }
        .doc-body li { font-size:14.5px; color:#333a52; margin-bottom:8px; }
        .doc-body a { color:${COLORS.purple}; }
        .qtype-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(160px, 1fr)); gap:10px; margin:0 0 8px; }
        .qtype-chip { background:${COLORS.purpleSoft}; color:${COLORS.purple}; font-size:13px; font-weight:700; padding:10px 14px; border-radius:9px; text-align:center; }
        .resource-links { display:flex; flex-wrap:wrap; gap:12px; }
        .resource-link { display:inline-flex; align-items:center; gap:8px; background:#fff; border:1px solid ${COLORS.border}; padding:10px 16px; border-radius:9px; font-size:13.5px; font-weight:700; text-decoration:none; color:${COLORS.navy}; }
        .resource-link:hover { border-color:${COLORS.purple}; }
      ` }} />

      <header className="doc-header">
        <Link href="/" className="doc-back"><ArrowLeft size={15} /> Back to Testly</Link>
      </header>

      <div className="about-hero">
        <img src="/images/testly-logo.png" alt="Testly" className="about-logo" />
        <h1>Run better IELTS mock exams</h1>
        <p>
          Testly is the all-in-one platform for educational centers to create, manage, and run
          full IELTS mock exams — from building the exam itself through to live proctoring
          and results.
        </p>
      </div>

      <div className="toc-wrap">
        <div className="toc-card">
          <p className="toc-title">On this page</p>
          <ul className="toc-list">
            {SECTIONS.map((s) => (
              <li key={s.id}><a href={`#${s.id}`}>{s.label}</a></li>
            ))}
          </ul>
        </div>
      </div>

      <main className="doc-body">
        <section id="overview">
          <h2>Overview</h2>
          <p>
            Testly gives a center everything needed to run an IELTS Academic mock test without
            juggling separate tools for writing the exam, recording audio, proctoring the room, and
            grading results. There are two roles: <strong>admins</strong> (a center's own test
            moderators, who build exams and run live sessions) and <strong>students</strong>
            (test-takers, who need no account at all — a start code from the admin is the only
            "login" required).
          </p>
        </section>

        <section id="for-centers">
          <h2>For Educational Centers</h2>
          <p>An admin can build a new exam four different ways, whichever fits how they work:</p>
          <ul>
            <li><strong>Paste or upload raw JSON</strong> — write or generate the exam JSON directly, then attach any listening audio or map images one slot at a time.</li>
            <li><strong>Upload a ZIP</strong> — bundle the exam JSON together with all its media files in one go; Testly matches each file to the right question automatically.</li>
            <li><strong>AI-generate</strong> — give it a topic and difficulty, and Testly builds a full exam: real passages, real listening audio, real map images, and a Writing section, in about a minute.</li>
            <li><strong>Manual media attach</strong> — a per-question "Attach" button for admins who prefer to build the JSON first and add media after.</li>
          </ul>
          <p>
            Beyond building exams, admins get a live Test Room to admit waiting students (one at a
            time or in bulk), a sessions view showing every student's status and scores, and a
            one-click Google Sheet connection so results land automatically where the center
            already tracks them.
          </p>
        </section>

        <section id="for-students">
          <h2>For Students</h2>
          <p>
            A student enters a center-issued start code, confirms their name, runs through a short
            system check, and waits in a moderator-gated waiting room until the admin admits them.
            From there they move through Reading, Listening, and Writing exactly like the real
            IELTS Computer-Delivered test — a genuine, faithful replica of that interface, not a
            simplified version of it. Every section is server-timed, autosaves as they go, and
            resumes correctly if their browser refreshes mid-exam.
          </p>
        </section>

        <section id="question-types">
          <h2>Question Types Supported</h2>
          <div className="qtype-grid">
            <div className="qtype-chip">True/False/Not Given</div>
            <div className="qtype-chip">Multiple Choice</div>
            <div className="qtype-chip">Gap Fill</div>
            <div className="qtype-chip">Matching</div>
            <div className="qtype-chip">Table Completion</div>
            <div className="qtype-chip">Map/Plan Labeling</div>
          </div>
          <p>All six render in Reading. Listening uses the classic fill-in-the-blank note/table format from the real test.</p>
        </section>

        <section id="ai-generation">
          <h2>AI-Assisted Exam Generation</h2>
          <p>
            Instead of writing an exam by hand, an admin can describe a topic and difficulty and let
            Testly generate the whole thing: three Reading passages, four Listening parts with real
            spoken-word audio, and both Writing tasks — including a real generated image for any map
            question, with its clickable points verified against what's actually drawn so answers
            line up correctly. Generation runs in the background (it takes about a minute for a
            full exam) and the exam appears in the dashboard the moment it's ready.
          </p>
        </section>

        <section id="grading">
          <h2>Grading & Results</h2>
          <p>
            Reading and Listening are graded automatically the instant a student submits, converted
            to an IELTS band score, and written straight to the exam's connected Google Sheet.
            Writing and Speaking aren't auto-gradable, so those are left for the center's own staff
            to grade by ear/eye directly in the same sheet — the admin dashboard links straight to
            each student's exact row so there's no hunting for it.
          </p>
        </section>

        <section id="resources">
          <h2>Documentation & Resources</h2>
          <p>For building exams by hand or integrating with the platform directly:</p>
          <div className="resource-links">
            <Link href="/docs" className="resource-link">Exam JSON Schema →</Link>
            <Link href="/privacy" className="resource-link">Privacy Policy →</Link>
          </div>
        </section>
      </main>
    </div>
  );
}
