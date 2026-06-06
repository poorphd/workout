-- Conversation state for the DM-based check-in flow (Geekbot style)
create table if not exists checkin_sessions (
  slack_user_id text primary key,
  step          text not null,                 -- next expected answer: name/goal/duration/calories/photo
  data          jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now()
);
alter table checkin_sessions enable row level security; -- no policy = service_role only
