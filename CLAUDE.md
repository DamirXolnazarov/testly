## Testly — Platform Overview

Testly is a B2B mock-exam platform for educational centers running IELTS prep. Two roles: **admins** (test moderators at the center) and **students** (test-takers). Admins build/import exams and run live proctored test sessions; students take a pixel-close replica of the real IELTS Computer-Delivered interface — Reading, Listening, Writing — with results auto-graded where possible and handed off to the center for manual Writing/Speaking scoring.

No student accounts — a start code from the admin is the only "login" a student needs.

## All pages

### `/` — Landing (dev-only)
Two links, admin and student. Not meant for real users — a real deployment would send students straight to `/exam` and admins to `/admin` directly.

### `/admin` — gated by `AdminLogin`

**AdminLogin**
Email + password. No self sign-up — admin accounts are created via a CLI script, not a public form.

**AdminDashboard** (the main admin app, sidebar + content area)
- **Exams view** (default): grid of exam cards — title, status (Draft/Live/Closed), start code (click to copy), section icons. "New exam" opens a modal with three ways to create one: **upload a .json file** (drag-and-drop, with a live preview of what's inside and a downloadable starter template), **paste JSON** directly, or **AI-generate** (visibly labeled "soon" — not built yet). Every submission is validated server-side with specific, per-question error messages.
- **Sessions view**: table of every student who's attempted a given exam — name, status, Reading/Listening scores once graded, and a link straight to that student's row in the center's Google Sheet (once configured).
- **Test Room** (the live moderation view, opened when an admin starts a test): three live-updating columns — **Waiting**, **In progress**, **Completed**. Waiting students need an explicit "Admit" tap (or "Admit all") before their exam clock starts — a valid code alone isn't enough to begin.

### `/exam` — the entire student journey, one URL, several stages in sequence
1. **PreTestFlow** — confirm full name → read test-day rules (checkbox to agree) → a quick connection/audio check → enter the start code.
2. **WaitingRoom** — shown after the code is accepted, before an admin admits them. Polls quietly in the background; nothing to click.
3. **IELTSCDReplica** — the actual test, admitted students only. Three modules in sequence:
   - **Reading**: passage + text highlighting/notes, six question types (multiple choice, true/false/not given, gap-fill, matching, table, map), a live countdown that turns amber → red as time runs low, part-by-part navigation.
   - **Listening**: real audio playback (or a timed simulation if no audio file is set yet) with a one-time "can't pause or rewind" gate, note-completion style questions.
   - **Writing**: prompt + chart, a word counter that goes from amber to green once the minimum is hit.
   - All answers autosave in the background; refreshing or closing the tab and coming back resumes exactly where they left off, clock included.
4. **ResultsScreen** — shown after submitting. Real Reading/Listening scores and bands (auto-graded); Writing/Speaking clearly marked "pending — graded by your administrator," never faked as a number.

## What's genuinely still missing (so a design spec doesn't over-scope for it)
No admin exam *editor* (JSON only, no visual builder), no map/table/mcq question types inside Listening yet (reading-only for now), no AI generation, no real ElevenLabs audio pipeline. Worth knowing before a design spec assumes any of those exist.

Send over the design spec whenever you're ready — happy to work from it directly against these pages.