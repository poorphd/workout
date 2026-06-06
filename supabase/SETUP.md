# Slack Check-in Bot — Setup Guide

`/운동` slash command → Supabase Edge Function → Postgres → GitHub Pages dashboard.
Follow the steps in order. Everything fits within free tiers.

---

## 1. Supabase project

1. Sign up at https://supabase.com → **New project** (region: Northeast Asia (Seoul) recommended)
2. Left sidebar **SQL Editor** → paste the contents of `supabase/schema.sql` and Run (creates tables)
3. New query → paste `supabase/seed.sql` and Run (imports the historical check-ins)
4. **Project Settings → API** — note these three values:
   - `Project URL`         (e.g. https://xxxx.supabase.co)
   - `anon public` key      → for the dashboard (safe to expose)
   - `service_role` key     → for the Edge Function (**secret — never put it in the frontend**)

## 2. Deploy the Edge Function with the Supabase CLI

```bash
# install (mac)
brew install supabase/tap/supabase

# log in & link the project
supabase login
supabase link --project-ref <project ref>     # ref = the xxxx in the Project URL

# deploy (Slack does not send a Supabase JWT, so disable JWT verification)
supabase functions deploy slack --no-verify-jwt
```

After deploying, the function URL is:
`https://<ref>.supabase.co/functions/v1/slack`  → **used in the next step**

## 3. Create the Slack app

1. https://api.slack.com/apps → **Create New App → From scratch** (pick the workspace)
2. **Slash Commands → Create New Command**
   - Command: `/운동` (if Slack rejects it, use `/workout` — the code is command-name agnostic)
   - Request URL: `https://<ref>.supabase.co/functions/v1/slack`
   - Save
3. **Interactivity & Shortcuts → On**
   - Request URL: the same function URL
4. **OAuth & Permissions → Scopes → Bot Token Scopes** — add:
   - `commands`
   - `chat:write`
   - `channels:history` (needed by the message-cleanup scripts)
5. **App Home** → set a Bot Display Name + username (creates the bot user)
6. **Install to Workspace**
   - Installs immediately, or shows "request admin approval" → ask a workspace admin
7. After install, note these two values:
   - **Basic Information → Signing Secret**
   - **OAuth & Permissions → Bot User OAuth Token** (`xoxb-...`)

## 3-1. Channel notifications (thread comment on check-in)

- Invite the bot to the target channel: run `/invite @<bot>` in that channel
- Find the channel ID: right-click the channel name → "Copy link" → the `C0XXXX...` in the URL
- Create the `daily_threads` table: run `supabase/add_threads.sql` in the SQL Editor
  (already included if you ran the latest `schema.sql`)
- Add the weekly-goal column: run `supabase/add_goal.sql`

## 4. Set the Edge Function secrets

```bash
supabase secrets set \
  SLACK_SIGNING_SECRET=<Signing Secret from step 3> \
  SLACK_BOT_TOKEN=<xoxb-... token> \
  SLACK_CHANNEL_ID=<C0... channel ID>

# redeploy so the secrets take effect
supabase functions deploy slack --no-verify-jwt
```
> `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by Supabase, so they don't need to be set.

## 5. Test

Use the subcommands in any Slack channel:

| Input | Action |
|-------|--------|
| `/운동 인증` | Check in for today (first-time users get a name-picker modal) |
| `/운동 취소` | Cancel today's check-in |
| `/운동 내기록` | Your monthly count / longest streak |
| `/운동 순위` | This month's leaderboard |
| `/운동 이름변경 <name>` | Change nickname |
| `/운동 목표설정 <n>` | Set weekly goal (achievement % shown on check-in) |
| `/운동` or `/운동 도움말` | Help |

- **First-time user**: `/운동 인증` → name modal (pick existing or enter new) → "인증하기"
- Running `/운동 인증` again the same day shows "이미 인증했어요 ✅"

## 6. Connect the dashboard

`index.html` reads from Supabase using the `Project URL` + `anon` key from step 1
(embedded directly in the file; the anon key is public read-only).

---

### Values to keep handy
- [ ] Supabase Project URL
- [ ] Supabase anon key
- [ ] Supabase service_role key (secret)
- [ ] Slack Signing Secret
- [ ] Slack Bot Token (xoxb-)
- [ ] Slack Channel ID (C0...)
