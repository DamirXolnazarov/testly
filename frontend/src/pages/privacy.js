/**
 * privacy.js
 * Privacy Policy. Written to accurately describe what this codebase
 * actually does — verified directly against the code (localStorage keys,
 * what's sent to Supabase, the Google Sheets integration) rather than
 * boilerplate. Update this if data handling changes; don't let it drift
 * out of sync with reality.
 */
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { COLORS } from "../lib/theme";

export default function Privacy() {
  return (
    <div className="doc-root">
      <style dangerouslySetInnerHTML={{ __html: `
        html, body, #__next { width:100%; min-height:100%; margin:0; }
        *, *::before, *::after { box-sizing:border-box; }
        .doc-root { min-height:100dvh; background:${COLORS.bg}; font-family:"Poppins",sans-serif; color:${COLORS.navy}; }
        .doc-header { display:flex; align-items:center; gap:10px; padding:20px clamp(20px, 5vw, 56px); border-bottom:1px solid ${COLORS.border}; background:#fff; }
        .doc-back { display:flex; align-items:center; gap:6px; color:${COLORS.navyMuted}; text-decoration:none; font-size:13.5px; font-weight:600; }
        .doc-back:hover { color:${COLORS.purple}; }
        .doc-body { max-width:760px; margin:0 auto; padding:clamp(24px, 5vw, 56px) 20px 80px; line-height:1.7; }
        .doc-body h1 { font-size:clamp(26px, 5vw, 34px); font-weight:800; margin:0 0 6px; }
        .doc-updated { font-size:13px; color:${COLORS.navyMuted}; margin:0 0 30px; }
        .doc-body h2 { font-size:clamp(18px, 3.5vw, 20px); font-weight:800; margin:32px 0 12px; }
        .doc-body p { font-size:14.5px; color:#333a52; margin:0 0 14px; }
        .doc-body ul { margin:0 0 14px; padding-left:22px; }
        .doc-body li { font-size:14.5px; color:#333a52; margin-bottom:8px; }
        .doc-body a { color:${COLORS.purple}; }
      ` }} />
      <header className="doc-header">
        <Link href="/" className="doc-back"><ArrowLeft size={15} /> Back to Testly</Link>
      </header>
      <main className="doc-body">
        <h1>Privacy Policy</h1>
        <p className="doc-updated">Last updated: {new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</p>

        <p>
          Testly is a platform educational centers use to run IELTS mock exams. This page explains what
          information the platform collects, why, and how it's stored — for both center administrators and
          the students who take exams through a center's exam link.
        </p>

        <h2>What we store, and why</h2>
        <ul>
          <li><strong>Admin accounts.</strong> Email and a securely hashed password, used to log in to the admin dashboard. A login session token is kept in your browser's local storage so you stay signed in.</li>
          <li><strong>Exam content.</strong> The reading, listening, and writing content an admin creates or generates, including correct answers, stored so exams can be delivered to students and graded.</li>
          <li><strong>Student exam sessions.</strong> A student's full name (entered at check-in), their answers, and their timing data for the exam they take — no account or sign-up is required for students; a center-issued start code is the only "login."</li>
          <li><strong>Exam results.</strong> Reading and Listening are graded automatically; Writing and Speaking are graded manually by the center's own staff. Results for a given exam are written to a Google Sheet that the exam's admin connects and controls — that sheet is owned and managed by the center, not by Testly.</li>
          <li><strong>A few local browser preferences.</strong> Light/dark mode choice, and — for admins — a locally-cached profile photo. These stay in your browser and are not sent to our servers.</li>
          <li><strong>Exam resume support.</strong> If a student's browser closes or refreshes mid-exam, a session identifier is kept locally so their in-progress exam can resume from where they left off.</li>
        </ul>

        <h2>What we don't do</h2>
        <ul>
          <li>We don't use advertising or analytics trackers.</li>
          <li>We don't sell or share personal data with third parties for marketing purposes.</li>
          <li>We don't use tracking cookies. The only browser storage used is the functional, first-party kind described above — things like staying logged in, remembering your theme, and letting an exam resume after a refresh. None of it is used to track you across other sites.</li>
        </ul>

        <h2>Third-party services we rely on</h2>
        <p>
          Exam data is stored using Supabase (database and file storage). If an admin connects a Google Sheet
          to an exam, results are written there using Google's API, under the permissions that admin's own
          Google account grants. If an admin uses AI-assisted exam generation, exam content may be processed
          by the AI provider configured for that center (for example Anthropic or OpenAI) and by ElevenLabs
          for generated audio — solely to produce the exam content itself, not to build advertising profiles.
        </p>

        <h2>Data retention and control</h2>
        <p>
          Exam content and results are retained for as long as the center that owns the exam keeps it in
          the platform. An admin can delete an exam they created; deleting an exam that has already run
          also removes its stored student sessions. If you're a student with a question about your own
          exam data, the educational center that administered your exam is the right first point of contact,
          since they control the exam and its results.
        </p>

        <h2>Changes to this policy</h2>
        <p>
          If how the platform handles data changes meaningfully, this page will be updated and the date
          above will reflect that.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about this policy can be directed to the educational center that provided your exam
          access, or to Testly directly through the center's admin.
        </p>
      </main>
    </div>
  );
}
