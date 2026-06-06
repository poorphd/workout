# 💪 Workout Check-in

Track and visualize daily workout check-ins. Members check in from Slack with
`/운동 인증`; a Supabase Edge Function records it and posts to a channel thread,
and a static dashboard on GitHub Pages reads from the database.

## Architecture

```
Slack  /운동 인증
   └─> Supabase Edge Function (supabase/functions/slack)
         ├─ verifies Slack signature, maps Slack user -> nickname
         ├─ writes the check-in to Postgres (checkins table)
         └─ posts a channel thread comment (rank change + weekly goal %)
GitHub Pages dashboard (index.html)
   └─> reads the checkins table (anon key, read-only) and renders
       leaderboard / contribution heatmap / per-user trends / streaks
```

## Layout

```
index.html                       Dashboard (reads from Supabase)
supabase/
  schema.sql                     Tables (members, checkins, daily_threads) + RLS
  seed.sql                       One-time import of historical check-ins
  add_threads.sql / add_goal.sql Incremental migrations
  functions/slack/index.ts       Slack /운동 bot (Edge Function)
  SETUP.md                       Step-by-step setup guide
scripts/
  cleanup-slack.mjs              Bulk-delete the bot's own channel messages
  delete-thread.sh               Delete a single thread (parent + replies)
```

## Slack commands

| Command | Action |
|---------|--------|
| `/운동 인증` | Start a DM check-in conversation (workout, duration, calories, photo; multiple per day allowed) |
| `/운동 취소` | Cancel today's check-in(s) |
| `/운동 내기록` | Your monthly workout days, longest streak, metrics, weekly goal |
| `/운동 순위` | This month's leaderboard (by distinct workout days) |
| `/운동 이름변경 <name>` | Change your nickname |
| `/운동 목표설정 <n>` | Set a weekly goal in days (check-ins show achievement %) |
| `/운동` or `/운동 도움말` | Help |

Ranking, weekly goals, and streaks all count **distinct workout days**, so checking in
multiple times in one day doesn't inflate them.

## Setup

See [`supabase/SETUP.md`](supabase/SETUP.md) for the full Supabase + Slack setup.

## Local preview

The dashboard needs HTTP (so `fetch` works) — `file://` won't do:

```bash
python3 -m http.server 8765
# open http://localhost:8765
```

The Supabase URL and anon key are embedded in `index.html` (the anon key is a
public, read-only key and is safe to expose).

## Deploy (GitHub Pages)

Pages serves `index.html` from the `main` branch (Settings → Pages → Deploy from
a branch → `main` / root). Any push to `main` republishes; check-in data is read
live from Supabase, so the page does not need to be rebuilt when someone checks in.
