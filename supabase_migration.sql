-- Run this once in Supabase Dashboard → SQL Editor.
-- It is safe to re-run: all definitions use IF NOT EXISTS / OR REPLACE.

create extension if not exists pgcrypto;

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) > 0),
  apo_name text,
  scrum_master_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) > 0),
  area text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) > 0),
  email text,
  role text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sprints (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  goal text,
  start_date date not null,
  end_date date not null check (end_date >= start_date),
  status text not null default 'planned' check (status in ('planned', 'active', 'completed')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.task_comments (
  id uuid primary key default gen_random_uuid(), task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade, author_name text, body text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  team_id uuid references public.teams(id) on delete set null, entity_type text not null, entity_id text,
  action text not null, details jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  team_id uuid references public.teams(id) on delete set null, title text not null, body text, type text default 'info',
  is_read boolean not null default false, created_at timestamptz not null default now()
);
create table if not exists public.time_approvals (
  id uuid primary key default gen_random_uuid(), time_entry_id uuid not null unique references public.time_entries(id) on delete cascade,
  team_id uuid references public.teams(id) on delete set null, submitted_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','approved','returned')),
  reviewer_note text, reviewed_by uuid references auth.users(id) on delete set null, reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists public.team_availability (
  id uuid primary key default gen_random_uuid(), team_id uuid not null references public.teams(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade, member_id uuid references public.team_members(id) on delete set null,
  title text not null, starts_at timestamptz not null, ends_at timestamptz not null, kind text default 'leave',
  created_at timestamptz not null default now()
);
create table if not exists public.task_templates (
  id uuid primary key default gen_random_uuid(), team_id uuid references public.teams(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade, name text not null, description text,
  default_estimate numeric default 0, tags text, checklist jsonb not null default '[]'::jsonb, created_at timestamptz not null default now()
);
create table if not exists public.file_links (
  id uuid primary key default gen_random_uuid(), file_id uuid not null references public.files(id) on delete cascade,
  entity_type text not null check (entity_type in ('task','note','meeting','comment')), entity_id uuid not null,
  version_number integer not null default 1, created_at timestamptz not null default now()
);
create table if not exists public.integration_connections (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('slack','teams','google_calendar','outlook','github','jira')),
  webhook_url text, settings jsonb not null default '{}'::jsonb, is_enabled boolean not null default false,
  created_at timestamptz not null default now(), unique(owner_id, provider)
);
create table if not exists public.backup_snapshots (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  label text, snapshot jsonb not null, created_at timestamptz not null default now()
);

-- An active timer is one row per user and kind (task/work), so it restores on every device.
create table if not exists public.timer_states (
  user_id uuid not null references auth.users(id) on delete cascade,
  timer_kind text not null check (timer_kind in ('task', 'work')),
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, timer_kind)
);

create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  path text,
  url text,
  type text,
  size bigint,
  folder text default 'root',
  uploaded_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.emails (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  from_email text not null,
  to_email text not null,
  subject text not null,
  body text default '',
  labels text,
  is_read boolean not null default false,
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Existing records can now be associated with a team. Department is derived through the team.
alter table public.tasks add column if not exists team_id uuid references public.teams(id) on delete set null;
alter table public.tasks add column if not exists sprint_id uuid references public.sprints(id) on delete set null;
alter table public.notes add column if not exists team_id uuid references public.teams(id) on delete set null;
alter table public.meetings add column if not exists team_id uuid references public.teams(id) on delete set null;
alter table public.files add column if not exists team_id uuid references public.teams(id) on delete set null;
alter table public.emails add column if not exists team_id uuid references public.teams(id) on delete set null;

-- These columns are used by the UI. The ADD statements make this work even when the old
-- emails/files tables were created with a smaller schema.
alter table public.emails add column if not exists labels text;
alter table public.emails add column if not exists is_read boolean not null default false;
alter table public.emails add column if not exists sent_at timestamptz not null default now();
alter table public.emails add column if not exists created_at timestamptz not null default now();
alter table public.emails add column if not exists updated_at timestamptz not null default now();
alter table public.files add column if not exists path text;
alter table public.files add column if not exists url text;
alter table public.files add column if not exists folder text default 'root';
alter table public.files add column if not exists uploaded_at timestamptz not null default now();
alter table public.files add column if not exists created_at timestamptz not null default now();

create index if not exists teams_owner_id_idx on public.teams(owner_id);
create index if not exists departments_team_id_idx on public.departments(team_id);
create index if not exists team_members_team_id_idx on public.team_members(team_id);
create index if not exists files_user_id_uploaded_at_idx on public.files(user_id, uploaded_at desc);
create index if not exists emails_user_id_sent_at_idx on public.emails(user_id, sent_at desc);
create index if not exists tasks_team_id_idx on public.tasks(team_id);
create index if not exists tasks_sprint_id_idx on public.tasks(sprint_id);
create index if not exists notifications_user_id_idx on public.notifications(user_id, is_read, created_at desc);
create index if not exists activity_log_team_id_idx on public.activity_log(team_id, created_at desc);

alter table public.teams enable row level security;
alter table public.departments enable row level security;
alter table public.team_members enable row level security;
alter table public.timer_states enable row level security;
alter table public.sprints enable row level security;
alter table public.task_comments enable row level security;
alter table public.activity_log enable row level security;
alter table public.notifications enable row level security;
alter table public.time_approvals enable row level security;
alter table public.team_availability enable row level security;
alter table public.task_templates enable row level security;
alter table public.file_links enable row level security;
alter table public.integration_connections enable row level security;
alter table public.backup_snapshots enable row level security;
alter table public.files enable row level security;
alter table public.emails enable row level security;

drop policy if exists "teams own rows" on public.teams;
create policy "teams own rows" on public.teams for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "departments own rows" on public.departments;
create policy "departments own rows" on public.departments for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "team members own rows" on public.team_members;
create policy "team members own rows" on public.team_members for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "timer states own rows" on public.timer_states;
create policy "timer states own rows" on public.timer_states for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "sprints own rows" on public.sprints;
create policy "sprints own rows" on public.sprints for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "comments own rows" on public.task_comments;
create policy "comments own rows" on public.task_comments for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "activity own rows" on public.activity_log;
create policy "activity own rows" on public.activity_log for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "notifications own rows" on public.notifications;
create policy "notifications own rows" on public.notifications for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "approvals own rows" on public.time_approvals;
create policy "approvals own rows" on public.time_approvals for all using (submitted_by = auth.uid() or reviewed_by = auth.uid()) with check (submitted_by = auth.uid() or reviewed_by = auth.uid());
drop policy if exists "availability own rows" on public.team_availability;
create policy "availability own rows" on public.team_availability for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "templates own rows" on public.task_templates;
create policy "templates own rows" on public.task_templates for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "file links own rows" on public.file_links;
create policy "file links own rows" on public.file_links for all using (exists (select 1 from public.files f where f.id = file_id and f.user_id = auth.uid())) with check (exists (select 1 from public.files f where f.id = file_id and f.user_id = auth.uid()));
drop policy if exists "integrations own rows" on public.integration_connections;
create policy "integrations own rows" on public.integration_connections for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "backups own rows" on public.backup_snapshots;
create policy "backups own rows" on public.backup_snapshots for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "files own rows" on public.files;
create policy "files own rows" on public.files for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "emails own rows" on public.emails;
create policy "emails own rows" on public.emails for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Storage bucket and RLS. Files are stored under <auth.uid()>/<folder>/<filename>.
insert into storage.buckets (id, name, public) values ('files', 'files', false) on conflict (id) do update set public = false;
drop policy if exists "files storage select own" on storage.objects;
create policy "files storage select own" on storage.objects for select using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "files storage insert own" on storage.objects;
create policy "files storage insert own" on storage.objects for insert with check (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "files storage update own" on storage.objects;
create policy "files storage update own" on storage.objects for update using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "files storage delete own" on storage.objects;
create policy "files storage delete own" on storage.objects for delete using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
