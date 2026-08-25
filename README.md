# Testly — IELTS Mock Exam Platform

## Architecture

```
testly/
├── frontend/                     # Next.js (React) app — admin + student
│   └── src/
│       ├── pages/                # /admin/*, /student/*, /exam/[sessionId]
│       └── components/
│           ├── shared/           # IELTSCDReplica.jsx — the CD-look-alike UI shell
│           ├── reading/          # reading-specific question renderers
│           ├── listening/        # audio player, no-pause/rewind gate
│           └── writing/          # word-counted editor, chart renderer
├── backend/                      # Node/Express (or Next API routes) — swap as needed
│   └── src/
│       ├── routes/               # /api/exams, /api/sessions, /api/grade, /api/audio
│       ├── services/
│       │   ├── examGenerator.js  # calls Claude/OpenAI to produce Exam JSON per docs/exam-json-schema.md
│       │   ├── ttsService.js     # ElevenLabs integration — text -> hosted audio URL
│       │   ├── grader.js         # auto-grades reading/listening against answer key
│       │   └── sheetsService.js  # writes completed-test rows to Google Sheets
│       └── models/               # DB models: User, Exam, Session, Answer, Result
└── docs/
    └── exam-json-schema.md       # the JSON contract every piece of the system agrees on
```

## Core flows

1. **Admin authors an exam** → `examGenerator.js` (AI agent) produces Exam JSON
   per the schema → admin reviews/edits → saved with a `startCode`.
2. **Admin starts test day** → taps "Start Test" → session opens, students can
   now enter the `startCode`.
3. **Student logs in** → enters full name, does the intro/consent screens →
   enters `startCode` → test begins, timer starts server-side (source of truth,
   not client clock).
4. **Student takes test** → `IELTSCDReplica` renders each section from Exam
   JSON (student version, no answer keys). Reading/Listening answers autosave
   to backend on change (debounced) so nothing is lost on refresh/crash.
5. **Test ends** (timer expiry or manual submit) → backend runs `grader.js` on
   reading/listening → writes a row to Google Sheets via `sheetsService.js` →
   marks session "completed" → appears in admin dashboard's Completed Tests tab.
6. **Admin grades writing/speaking** → opens the same Google Sheet row (linked
   from the dashboard) → fills in band scores manually.

## Build order (suggested)
1. Exam JSON schema + admin exam editor (can start as a raw JSON upload/paste UI)
2. Student auth + start-code gate + session state machine
3. Reading module wired to real backend session (autosave, submit)
4. Listening module + ElevenLabs pipeline
5. Writing module
6. Grader + Google Sheets write-back
7. Admin dashboard: create exam, start test day, completed tests list, links to sheet rows

## What's included in this drop
- `frontend/src/components/shared/IELTSCDReplica.jsx` — working Reading /
  Listening / Writing UI replica (front-end only, uses local component state —
  needs wiring to backend session API).
- `docs/exam-json-schema.md` — the data contract for everything above.
- Stub files in `backend/src/` — signatures + comments only, not implemented,
  so you have a clear place to drop in real logic.

## Not yet built (next steps)
- Backend API (auth, sessions, autosave, submit, timer enforcement)
- examGenerator.js actual AI prompt + JSON validation
- ttsService.js actual ElevenLabs calls
- grader.js actual matching logic + sheetsService.js actual Sheets API auth/write
- Admin dashboard pages
- Map/matching question type renderers (stubbed in schema, not yet in UI)