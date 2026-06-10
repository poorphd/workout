// Manually insert a check-in into Supabase (bypasses the Slack bot — no thread comment).
// Writes need the service_role key (RLS bypass).
//
// Usage:
//   SUPABASE_SERVICE_ROLE_KEY=... node scripts/add-checkin.mjs --name 병철 \
//     [--date 2026-06-10] [--workout 헬스] [--min 60] [--cal 300]
//
//   --name     required, the nickname (match an existing one to merge with their records)
//   --date     optional, YYYY-MM-DD (default: today KST)
//   --workout  optional, workout type/description
//   --min      optional, duration in minutes
//   --cal      optional, calories
const URL = process.env.SUPABASE_URL || "https://hfyjkvypmunvfkwhmhsv.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error("env SUPABASE_SERVICE_ROLE_KEY is required (Project Settings → API → service_role)"); process.exit(1); }

// parse "--flag value" args
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[++i];
}

const name = args.name;
if (!name) { console.error("--name <nickname> is required"); process.exit(1); }

const todayKST = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const date = args.date || todayKST();
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error(`--date must be YYYY-MM-DD (got "${date}")`); process.exit(1); }

const row = { checkin_date: date, nickname: name, slack_user_id: null };
if (args.workout) row.workout = args.workout;
if (args.min) row.duration_min = parseInt(args.min, 10);
if (args.cal) row.calories = parseInt(args.cal, 10);

const res = await fetch(`${URL}/rest/v1/checkins`, {
  method: "POST",
  headers: { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json", Prefer: "return=representation" },
  body: JSON.stringify(row),
});
const body = await res.json();
if (!res.ok) { console.error("insert failed:", res.status, body); process.exit(1); }
console.log("inserted:", JSON.stringify(body[0] ?? body));
