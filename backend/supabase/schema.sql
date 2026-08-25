-- Testly — Supabase schema
-- Run this in the Supabase SQL editor (or via `supabase db push` with this as a migration).

create extension if not exists "pgcrypto"; -- for gen_random_uuid()

-- ---------------------------------------------------------------------------
-- admin_users: who can log into the admin dashboard
-- ---------------------------------------------------------------------------
create table if not exists admin_users (
  admin_id      uuid primary key default gen_random_uuid(),
  center_id     uuid,                 -- FK to a future "centers" table (multi-tenant)
  email         text not null unique,
  password_hash text not null,        -- bcrypt hash — never store plaintext
  full_name     text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_admin_users_email on admin_users (email);

-- ---------------------------------------------------------------------------
-- exams: one row per admin-created mock test
-- ---------------------------------------------------------------------------
create table if not exists exams (
  exam_id     uuid primary key default gen_random_uuid(),
  center_id   uuid,                          -- FK to a future "centers" table (multi-tenant)
  title       text not null,
  start_code  text not null unique,
  status      text not null default 'draft', -- draft | active | paused | closed
  sections    jsonb not null,                -- full exam JSON incl. answer keys — see docs/exam-json-schema.md
  sheet_id    text,                          -- Google Sheet ID this exam's results write to
  created_by  uuid,                          -- FK to a future "admin_users" table
  created_at  timestamptz not null default now(),
  started_at  timestamptz
);

create index if not exists idx_exams_start_code on exams (start_code);
create index if not exists idx_exams_center on exams (center_id);

-- ---------------------------------------------------------------------------
-- sessions: one row per student attempt
-- ---------------------------------------------------------------------------
create table if not exists sessions (
  session_id    uuid primary key default gen_random_uuid(),
  exam_id       uuid not null references exams(exam_id) on delete cascade,
  full_name     text not null,
  answers       jsonb not null default '{"reading":{},"listening":{},"writing":{}}',
  status        text not null default 'pending_admission', -- pending_admission | in_progress | completed
  admitted_at   timestamptz,   -- when the moderator let this student into the actual exam
  current_section     text,          -- reading | listening | writing — which section the student is on
  section_started_at  timestamptz,   -- server-stamped when they first reach current_section; source of truth for that section's countdown
  started_at    timestamptz not null default now(),
  completed_at  timestamptz,
  results       jsonb, -- { reading: {rawScore, band, perQuestion}, listening: {...} }
  sheet_row_range text -- e.g. "Completed Tests!A5:M5" — where this student's row landed, for the admin's "Open in Sheet" deep link
);

create index if not exists idx_sessions_exam on sessions (exam_id);
create index if not exists idx_sessions_status on sessions (status);

-- ---------------------------------------------------------------------------
-- Row Level Security — service role (backend) bypasses RLS by default.
-- These policies matter once the frontend ever talks to Supabase directly;
-- for now the Node backend uses the service-role key and is unaffected.
-- ---------------------------------------------------------------------------
alter table exams enable row level security;
alter table sessions enable row level security;
alter table admin_users enable row level security;

-- Placeholder: lock everything down until real admin/student auth exists.
-- TODO: replace with real policies once Supabase Auth (or your own auth) is wired,
-- e.g. "admins can select/update exams where center_id = auth.jwt() -> center_id".
create policy "service role only" on exams for all using (false);
create policy "service role only" on sessions for all using (false);
create policy "service role only" on admin_users for all using (false);

-- ---------------------------------------------------------------------------
-- Migration: if you already ran this schema before section-resume support
-- was added, run just this block against your existing database instead of
-- the full file above.
-- ---------------------------------------------------------------------------
-- alter table sessions add column if not exists current_section text;
-- alter table sessions add column if not exists section_started_at timestamptz;

-- ---------------------------------------------------------------------------
-- Migration: moderator admission gate (pending_admission status + admitted_at).
-- Run this if your `sessions` table predates this feature. Existing rows with
-- status 'in_progress' are left as-is (they were already admitted, implicitly).
-- ---------------------------------------------------------------------------
-- alter table sessions add column if not exists admitted_at timestamptz;
-- alter table sessions alter column status set default 'pending_admission';

-- ---------------------------------------------------------------------------
-- Migration: Google Sheets row deep-linking (sheet_row_range).
-- Run this if your `sessions` table predates this feature.
-- ---------------------------------------------------------------------------
-- alter table sessions add column if not exists sheet_row_range text;