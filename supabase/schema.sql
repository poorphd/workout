-- Workout check-in app schema
-- Paste into the Supabase SQL Editor and run.

-- ── members: Slack account <-> display nickname mapping ──
create table if not exists members (
  slack_user_id text primary key,      -- Slack user ID (U01ABC...)
  slack_name    text,                  -- Slack display name (for reference)
  nickname      text not null unique,  -- nickname used in the app (병철, 정주 …)
  weekly_goal   int,                   -- weekly workout goal (null if unset)
  is_admin      boolean not null default false,
  created_at    timestamptz not null default now()
);

-- ── check-in records ──
create table if not exists checkins (
  id            bigint generated always as identity primary key,
  checkin_date  date not null,         -- check-in date (KST)
  nickname      text not null,         -- who (same value as members.nickname)
  slack_user_id text,                  -- set for bot check-ins (null for imported history)
  workout       text,                  -- optional: workout type/description (free text)
  duration_min  int,                   -- optional: workout duration in minutes
  calories      int,                   -- optional: calories burned
  created_at    timestamptz not null default now()
  -- multiple check-ins per day are allowed; ranking counts distinct days
);

create index if not exists checkins_date_idx on checkins (checkin_date);
create index if not exists checkins_nick_idx on checkins (nickname);

-- ── RLS: dashboard (anon) reads only; writes go through the Edge Function (service_role) ──
alter table checkins enable row level security;
alter table members  enable row level security;

-- allow the dashboard to read via the anon key
drop policy if exists "public read checkins" on checkins;
create policy "public read checkins" on checkins
  for select using (true);

drop policy if exists "public read members" on members;
create policy "public read members" on members
  for select using (true);

-- No INSERT/UPDATE/DELETE policies are defined
--   → the anon key cannot write. The Edge Function writes using the
--     service_role key, which bypasses RLS.

-- ── channel thread tracking (stores the day's parent message thread_ts) ──
create table if not exists daily_threads (
  thread_date date not null,
  channel     text not null,
  thread_ts   text not null,
  created_at  timestamptz not null default now(),
  primary key (thread_date, channel)
);
alter table daily_threads enable row level security; -- no policy = service_role only

-- ── DM conversation state for the check-in flow ──
create table if not exists checkin_sessions (
  slack_user_id text primary key,
  step          text not null,
  data          jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now()
);
alter table checkin_sessions enable row level security; -- no policy = service_role only
