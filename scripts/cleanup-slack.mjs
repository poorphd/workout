// Delete the bot's own messages (parents + thread replies) in a channel — recent N days only
// Usage: SLACK_BOT_TOKEN=xoxb-... SLACK_CHANNEL_ID=C0... [LOOKBACK_DAYS=3] node scripts/cleanup-slack.mjs
// Scopes needed: chat:write, channels:history (bot must be a channel member)
const TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL = process.env.SLACK_CHANNEL_ID;
const DAYS = Number(process.env.LOOKBACK_DAYS ?? 3);
if (!TOKEN || !CHANNEL) {
  console.error("SLACK_BOT_TOKEN and SLACK_CHANNEL_ID env vars are required.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function slack(method, params) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${TOKEN}` },
      body: new URLSearchParams(params),
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") ?? 5);
      console.log(`  rate limited, waiting ${wait}s...`);
      await sleep((wait + 1) * 1000);
      continue;
    }
    return res.json();
  }
  return { ok: false, error: "rate_limited_giveup" };
}

console.log(`Start: cleaning bot messages from the last ${DAYS} days (channel ${CHANNEL})`);

const auth = await slack("auth.test", {});
if (!auth.ok) { console.error("auth.test failed:", auth.error); process.exit(1); }
const botUserId = auth.user_id;
console.log("bot user id:", botUserId);

const oldest = String(Math.floor(Date.now() / 1000) - DAYS * 86400);
const isBot = (m) => m.user === botUserId || !!m.bot_id;

// Collect top-level messages from the last N days
const tops = [];
let cursor, page = 0;
do {
  const r = await slack("conversations.history", { channel: CHANNEL, oldest, limit: "200", ...(cursor ? { cursor } : {}) });
  if (!r.ok) { console.error("conversations.history failed:", r.error); process.exit(1); }
  tops.push(...r.messages);
  cursor = r.response_metadata?.next_cursor;
  console.log(`  history page ${++page}: ${tops.length} so far`);
} while (cursor);

// Collect ts of bot messages (including thread replies)
const toDelete = new Set();
for (const m of tops) {
  if (m.thread_ts && m.reply_count) {
    let c;
    do {
      const rr = await slack("conversations.replies", { channel: CHANNEL, ts: m.thread_ts, limit: "200", ...(c ? { cursor: c } : {}) });
      if (!rr.ok) break;
      for (const rm of rr.messages) if (isBot(rm)) toDelete.add(rm.ts);
      c = rr.response_metadata?.next_cursor;
    } while (c);
  } else if (isBot(m)) {
    toDelete.add(m.ts);
  }
}

const list = [...toDelete];
console.log(`${list.length} message(s) to delete`);
let ok = 0;
for (const ts of list) {
  const d = await slack("chat.delete", { channel: CHANNEL, ts });
  if (d.ok) ok++;
  else console.warn("  delete failed", ts, d.error);
  await sleep(400);
}
console.log(`Done: deleted ${ok}/${list.length}`);
