## Testly — Platform Overview

Testly is a B2B mock-exam platform for educational centers running **IELTS and SAT** prep. Two roles: **admins** (test moderators at the center) and **students** (test-takers). Admins build/import exams and run live proctored test sessions; students take a close replica of the real test interface — the **IELTS Computer-Delivered** UI (Reading, Listening, Writing) or the **SAT Bluebook** UI (Reading-Writing, Math, with Module 1 → Module 2 adaptive routing) — with results auto-graded where possible and handed off to the center for manual Writing/Speaking scoring.

No student accounts — a start code from the admin is the only "login" a student needs.

## All pages

### `/` — Landing (dev-only)
Two links, admin and student. Not meant for real users — a real deployment would send students straight to `/exam` and admins to `/admin` directly.

### `/admin` — gated by `AdminLogin`

**AdminLogin**
Email + password. No self sign-up — admin accounts are created via a CLI script, not a public form.

**AdminDashboard** (the main admin app, sidebar + content area)
- **Exams view** (default): grid of exam cards — title, status (Draft/Live/Closed), start code (click to copy), section icons. "New exam" opens a modal with ways to create one: **upload a ZIP** (JSON + media), **upload a .json file** (drag-and-drop, with a live preview of what's inside and a downloadable starter template), **paste JSON** directly, or **Create with AI**, which hands off to AI Studio. Every submission is validated server-side with specific, per-question error messages.
- **AI Studio** (sidebar, and "Create with AI" on the Exams page): a chat with an assistant on the left, and on the right the exam **blueprint** it proposes (test type, sections, topics, notes), then live **build progress**, then the finished draft with a **Review with answers** view. Covers IELTS (Academic / General Training; 1–3 reading passages, 1–4 listening parts, writing) and the digital SAT (both sections, all three adaptive modules each). After a build the admin can ask for one passage / part / module to be rewritten. A paper the centre already has can be attached as a PDF (paperclip in the chat): `POST /api/ai/import` → `paperImporter.js` reads it with a PDF-capable model (`pdfReader.js`: Claude or Gemini) — an outline first, then one request per passage / part / task / module — and saves a draft, cutting each figure out of the PDF (`pdfFigures.js`: the model reports the page and box, pdf.js renders and crops it, blank margins and grazed text are trimmed) and attaching it as the SAT question's image or the writing task's chart, and flagging what it can't carry (figures it couldn't locate, listening audio, answers with no key) for the teacher to fix in the test editor. Draft preview (`/admin-preview/[examId]`) shows SAT drafts too, module by module, through `SATBluebook`'s `preview` mode. Frontend: `components/admin/AIStudio.jsx`. Backend: `routes/ai.js` → `studioAgent.js` (tool-use loop: `set_blueprint`, `build_exam`, `get_exam`, `revise_exam`) → `examBuilder.js` (background jobs) → `examGenerator.js` (one model call per passage / part / module, each validated, then an answer-key second pass). The chat transcript lives in the browser (localStorage); build jobs live in backend memory. Which AI runs it is decided by `aiProvider.js`: Claude (`claudeClient.js`) when `ANTHROPIC_API_KEY` is set, otherwise a pool of free Gemini and Groq models (`openaiCompatClient.js`) that fall over to each other as their small daily allowances run out. Reading passages and listening parts are written in two requests (text, then questions) and SAT modules one skill area at a time, because weaker models can't hold a whole unit in one request.
- **Test editor** (`/admin-editor/[examId]`, `components/admin/ExamEditor.jsx`; opened from "Edit test" on the draft preview, the pencil on a draft's card, or AI Studio): edits everything about an exam without JSON — passages, scripts, prompts, every question with its options and answer key; add / delete / reorder / renumber questions, parts and whole sections; upload or replace listening audio (per part or one recording for the section), writing charts, diagram images and SAT question figures; record listening audio from the script (`POST /api/ai/tts`). Saves the whole exam with `PATCH /api/exams/:id`, which runs the validator and refuses content edits on a live exam.
- **Sessions view**: table of every student who's attempted a given exam — name, status, Reading/Listening scores once graded, and a link straight to that student's row in the center's Google Sheet (once configured).
- **Test Room** (the live moderation view, opened when an admin starts a test): three live-updating columns — **Waiting**, **In progress**, **Completed**. Waiting students need an explicit "Admit" tap (or "Admit all") before their exam clock starts — a valid code alone isn't enough to begin.

### `/exam` — the entire student journey, one URL, several stages in sequence
1. **PreTestFlow** — confirm full name → read test-day rules (checkbox to agree) → a quick connection/audio check → enter the start code.
2. **WaitingRoom** — shown after the code is accepted, before an admin admits them. Polls quietly in the background; nothing to click.
3. **IELTSCDReplica** — the actual test, admitted students only. Three modules in sequence:
   - **Reading**: passage + text highlighting/notes, six question types (multiple choice, true/false/not given, gap-fill, matching, table, map), a live countdown that turns amber → red as time runs low, part-by-part navigation.
   - **Listening**: real audio playback (or a timed simulation if no audio file is set yet) with a one-time "can't pause or rewind" gate, note-completion style questions.
   - **Writing**: prompt + chart, a word counter that goes from amber to green once the minimum is hit.
   - SAT Math is drawn as mathematics by `components/shared/MathText.jsx`: content stores maths as plain text (`x^2`, `sqrt(x + 1)`, `(3x + 1)/(x - 2)`, `x_1`, `<=`, `pi`) and the component displays exponents, stacked fractions, roots and symbols. Display only — stored text and answer matching are unchanged.
   - All answers autosave in the background; refreshing or closing the tab and coming back resumes exactly where they left off, clock included.
4. **ResultsScreen** — shown after submitting. Real Reading/Listening scores and bands (auto-graded); Writing/Speaking clearly marked "pending — graded by your administrator," never faked as a number.

## What's genuinely still missing (so a design spec doesn't over-scope for it)
No map/table/mcq question types inside Listening yet (reading-only for now).

**Now built (the old overview said these didn't exist — they do):** SAT support end-to-end (`SATBluebook.jsx`, `satScoring.js`, `satAnswerMatch.js`, Module 1→2 adaptive routing); AI exam generation (AI Studio, above; `POST /api/exams/generate` remains as a no-conversation shortcut through the same builder); listening audio (`ttsService.js`: Gemini text-to-speech with two voices for conversations, or ElevenLabs); map-image generation + vision verification (`mapImageService.js`, `imageGenClient.js`). Set the relevant API keys in `backend/.env` (see `.env.example`) for these to actually run.

Send over the design spec whenever you're ready — happy to work from it directly against these pages.