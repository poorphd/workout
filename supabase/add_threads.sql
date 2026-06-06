-- Channel thread tracking table (stores the day's parent message thread_ts)
-- Run this in the Supabase SQL Editor after schema.sql.
create table if not exists daily_threads (
  thread_date date not null,
  channel     text not null,
  thread_ts   text not null,
  created_at  timestamptz not null default now(),
  primary key (thread_date, channel)
);

-- Enable RLS with no policy → service_role (Edge Function) only (dashboard doesn't read it)
alter table daily_threads enable row level security;
