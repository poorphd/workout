-- Daily 00:00 KST job: ask the Edge Function to create that day's check-in thread
-- (parent message = yesterday's recap + dashboard link). Run once in the SQL Editor.
-- Replace <CRON_SECRET> with the same value you set as the function secret CRON_SECRET.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- remove any previous schedule with this name, then (re)create it
select cron.unschedule('daily-workout-thread')
where exists (select 1 from cron.job where jobname = 'daily-workout-thread');

select cron.schedule(
  'daily-workout-thread',
  '0 15 * * *',                       -- 15:00 UTC = 00:00 KST
  $$
  select net.http_post(
    url     := 'https://hfyjkvypmunvfkwhmhsv.supabase.co/functions/v1/slack',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<CRON_SECRET>'),
    body    := jsonb_build_object('type', 'daily_thread')
  );
  $$
);
