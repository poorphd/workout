// Slack /운동 slash command + DM conversation handler (Supabase Edge Function, Deno)
// Deploy: supabase functions deploy slack --no-verify-jwt
//   (Slack doesn't send a Supabase JWT, so disable JWT verification and verify the Slack signature instead)
// Secrets: SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID
//   (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically by Supabase)
//
// Check-in is a Geekbot-style DM conversation: /운동 인증 starts a DM where the bot asks
// duration / calories / photo one at a time; on finish it posts the day's thread comment
// (rank change + weekly goal + the photo) to the channel.
//
// Other subcommands stay one-shot: /운동 취소 | 내기록 | 순위 | 이름변경 <name> | 목표설정 <n>
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SIGNING_SECRET = Deno.env.get("SLACK_SIGNING_SECRET")!;
const BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN")!;
const CHANNEL_ID = Deno.env.get("SLACK_CHANNEL_ID"); // channel for check-in threads
const DASHBOARD_URL = "https://poorphd.github.io/workout/";
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const MONTH_NAMES = ["1월","2월","3월","4월","5월","6월","7월","8월","9월","10월","11월","12월"];

// ── KST date helpers ──
function todayKST(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
const thisMonthKST = () => todayKST().slice(0, 7);
function weekStartKST(): string {
  const [y, m, d] = todayKST().split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)); // back to Monday
  return dt.toISOString().slice(0, 10);
}
// Monday (week bucket key) for an arbitrary YYYY-MM-DD
function weekKey(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}
// Sunday (last day) of the Mon–Sun week containing the date; a week is attributed to this month
function weekSunday(dateStr: string): string { return addDaysKST(weekKey(dateStr), 6); }

// ── Slack signature verification ──
async function verifySlack(req: Request, rawBody: string): Promise<boolean> {
  const ts = req.headers.get("x-slack-request-timestamp");
  const sig = req.headers.get("x-slack-signature");
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${ts}:${rawBody}`));
  const expected = "v0=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ephemeral = (text: string) => json({ response_type: "ephemeral", text });
const empty = () => new Response("", { status: 200 });

const HELP = [
  "*운동 인증 봇 사용법* 💪",
  "• `/운동 인증` — DM에서 대화형으로 인증 (시간·칼로리·사진)",
  "• `/운동 취소` — 오늘 인증 취소",
  "• `/운동 내기록` — 내 이번달 기록",
  "• `/운동 순위` — 이번달 리더보드 (운동 일수)",
  "• `/운동 이름변경 새이름` — 닉네임 변경",
  "• `/운동 목표설정 5` — 주간 목표 일수 설정",
  "• `/운동 추첨 [인원수]` — (관리자) 이번달 경품 추첨",
].join("\n");

// ── small utils ──
function parseMetric(v: string | undefined, max: number): number | null {
  const n = parseInt((v ?? "").replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) && n > 0 && n <= max ? n : null;
}
function detailSuffix(workout: string | null, duration: number | null, calories: number | null): string {
  const parts: string[] = [];
  if (workout) parts.push(`🏋️ ${workout}`);
  if (duration != null) parts.push(`⏱️ ${duration}분`);
  if (calories != null) parts.push(`🔥 ${calories}kcal`);
  return parts.length ? " · " + parts.join(" · ") : "";
}
function longestStreak(dates: string[]): number {
  if (!dates.length) return 0;
  const sorted = [...new Set(dates)].sort();
  const t = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  let best = 1, cur = 1;
  for (let i = 1; i < sorted.length; i++) { cur = (t(sorted[i]) - t(sorted[i - 1])) / 86400000 === 1 ? cur + 1 : 1; if (cur > best) best = cur; }
  return best;
}

async function slackPost(body: Record<string, unknown>): Promise<any> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${BOT_TOKEN}` }, body: JSON.stringify(body),
  });
  return res.json();
}
const dm = (uid: string, text: string) => slackPost({ channel: uid, text });

async function recordCheckin(nickname: string, slackUserId: string, workout: string | null, duration: number | null, calories: number | null): Promise<number> {
  const { error } = await supabase.from("checkins").insert({ checkin_date: todayKST(), nickname, slack_user_id: slackUserId, workout, duration_min: duration, calories });
  if (error) throw error;
  const { count } = await supabase.from("checkins").select("*", { count: "exact", head: true }).eq("checkin_date", todayKST()).eq("nickname", nickname);
  return count ?? 1;
}
async function monthlyDayCounts(ym: string): Promise<Record<string, number>> {
  const { data } = await supabase.from("checkins").select("nickname,checkin_date").gte("checkin_date", `${ym}-01`);
  const days: Record<string, Set<string>> = {};
  for (const r of data ?? []) (days[r.nickname] = days[r.nickname] || new Set()).add(r.checkin_date as string);
  const counts: Record<string, number> = {};
  for (const n in days) counts[n] = days[n].size;
  return counts;
}
async function getMember(slackUserId: string) {
  const { data } = await supabase.from("members").select("nickname, weekly_goal, is_admin").eq("slack_user_id", slackUserId).maybeSingle();
  return data;
}
async function weeklyProgress(nickname: string) {
  const { data: mem } = await supabase.from("members").select("weekly_goal").eq("nickname", nickname).maybeSingle();
  const goal = mem?.weekly_goal ?? null;
  if (!goal) return null;
  const { data } = await supabase.from("checkins").select("checkin_date").eq("nickname", nickname).gte("checkin_date", weekStartKST());
  const count = new Set((data ?? []).map((r) => r.checkin_date as string)).size;
  return { count, goal, pct: Math.round((count / goal) * 100) };
}
async function unclaimedNicknames(): Promise<string[]> {
  const { data: cks } = await supabase.from("checkins").select("nickname");
  const { data: mem } = await supabase.from("members").select("nickname");
  const taken = new Set((mem ?? []).map((m) => m.nickname));
  return [...new Set((cks ?? []).map((c) => c.nickname))].filter((n) => !taken.has(n)).sort();
}

// ── upload DM photos into the channel thread (download from Slack, re-upload; multiple supported) ──
type Photo = { url: string; name: string; mime: string };
async function uploadPhotosToThread(threadTs: string, photos: Photo[], comment: string): Promise<boolean> {
  try {
    const uploaded: { id: string; title: string }[] = [];
    for (const photo of photos) {
      const fileRes = await fetch(photo.url, { headers: { authorization: `Bearer ${BOT_TOKEN}` } });
      const bytes = new Uint8Array(await fileRes.arrayBuffer());
      const ctype = fileRes.headers.get("content-type") || "";
      if (!fileRes.ok || ctype.includes("text/html")) { console.error("download failed (check files:read scope)"); continue; }

      const up = await (await fetch("https://slack.com/api/files.getUploadURLExternal", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${BOT_TOKEN}` },
        body: new URLSearchParams({ filename: photo.name, length: String(bytes.length) }),
      })).json();
      if (!up.ok) { console.error("getUploadURLExternal failed (check files:write scope):", up); continue; }

      const fd = new FormData();
      fd.append("file", new Blob([bytes], { type: photo.mime || "application/octet-stream" }), photo.name);
      await fetch(up.upload_url, { method: "POST", body: fd });
      uploaded.push({ id: up.file_id, title: photo.name });
    }
    if (!uploaded.length) return false;

    const done = await (await fetch("https://slack.com/api/files.completeUploadExternal", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${BOT_TOKEN}` },
      body: JSON.stringify({ files: uploaded, channel_id: CHANNEL_ID, thread_ts: threadTs, initial_comment: comment }),
    })).json();
    if (!done.ok) console.error("completeUploadExternal failed:", done);
    return !!done.ok;
  } catch (e) { console.error("photo upload failed", e); return false; }
}

// shift a YYYY-MM-DD string by delta days
function addDaysKST(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

// yesterday's recap line for the day's parent message
async function yesterdaySummary(date: string): Promise<string> {
  const y = addDaysKST(date, -1);
  const [, ym, yd] = y.split("-").map(Number);
  const { data } = await supabase.from("checkins").select("nickname,duration_min,calories").eq("checkin_date", y);
  const rows = data ?? [];
  if (!rows.length) return `📊 어제(${ym}/${yd})는 인증이 없었어요 😴 오늘 첫 주자가 되어보세요!`;
  const names = [...new Set(rows.map((r) => r.nickname as string))];
  const min = rows.reduce((s, r) => s + (r.duration_min ?? 0), 0);
  const cal = rows.reduce((s, r) => s + (r.calories ?? 0), 0);
  const lines = [`📊 어제(${ym}/${yd}) *${names.length}명* 인증`];
  if (min) lines.push(`⏱️ 합계 ${min}분`);
  if (cal) lines.push(`🔥 합계 ${cal}kcal`);
  lines.push(`🙌 ${names.join(", ")}`);
  return lines.join("\n");
}

// create the day's parent thread (title only) + first reply (yesterday recap + dashboard link)
async function createParent(date: string): Promise<string | null> {
  if (!CHANNEL_ID) return null;
  const [, mm, dd] = date.split("-").map(Number);
  const parent = await slackPost({ channel: CHANNEL_ID, text: `*${mm}월 ${dd}일 운동 인증 스레드* 💪 오늘도 \`/운동 인증\` 으로!` });
  if (!(parent?.ok && parent.ts)) return null;
  const ts = parent.ts;
  await supabase.from("daily_threads").upsert({ thread_date: date, channel: CHANNEL_ID, thread_ts: ts });
  await slackPost({ channel: CHANNEL_ID, thread_ts: ts, text: `${await yesterdaySummary(date)}\n📈 대시보드: ${DASHBOARD_URL}` });
  return ts;
}

// midnight job: create today's thread up front (skips if it already exists)
async function createDailyThread() {
  if (!CHANNEL_ID) return;
  const date = todayKST();
  const { data: existing } = await supabase.from("daily_threads").select("thread_ts").eq("thread_date", date).eq("channel", CHANNEL_ID).maybeSingle();
  if (existing) return;
  await createParent(date);
}

// ── post the check-in thread comment (rank by distinct days; optional photo) ──
async function announceCheckin(nickname: string, workout: string | null, duration: number | null, calories: number | null, todayCount: number, photos: Photo[]) {
  if (!CHANNEL_ID) return;
  const date = todayKST();
  const mm = Number(date.slice(5, 7));
  const ym = date.slice(0, 7);

  const counts = await monthlyDayCounts(ym);
  const myAfter = counts[nickname] ?? 1;
  const others = Object.entries(counts).filter(([n]) => n !== nickname).map(([, c]) => c);
  const rankOf = (val: number) => 1 + others.filter((c) => c > val).length;
  const afterRank = rankOf(myAfter);

  let rankMsg: string;
  if (todayCount > 1) {
    rankMsg = `💪 오늘 ${todayCount}번째 운동! ${mm}월 현재 *${afterRank}위* · ${myAfter}일`;
  } else {
    const before = myAfter - 1;
    if (before <= 0) rankMsg = `🎉 ${mm}월 첫 인증! 현재 *${afterRank}위*`;
    else {
      const br = rankOf(before);
      rankMsg = afterRank < br ? `📈 ${mm}월 순위 *${br}위 → ${afterRank}위* 상승!` : `${mm}월 현재 *${afterRank}위* · ${myAfter}일`;
    }
  }

  // ensure today's thread (cron usually creates it at 00:00; fall back to creating on first check-in)
  const { data: existing } = await supabase.from("daily_threads").select("thread_ts").eq("thread_date", date).eq("channel", CHANNEL_ID).maybeSingle();
  const ts = existing ? existing.thread_ts : await createParent(date);
  if (!ts) return;

  const wp = await weeklyProgress(nickname);
  const header = todayCount > 1 ? `*${nickname}* 님이 오늘 운동을 추가로 인증했어요!` : `*${nickname}* 님이 오늘의 운동을 인증했어요!`;
  const lines = [header];
  if (workout) lines.push(`🏋️ ${workout}`);
  if (duration != null) lines.push(`⏱️ ${duration}분`);
  if (calories != null) lines.push(`🔥 ${calories}kcal`);
  lines.push(rankMsg);
  if (wp) lines.push(`🎯 이번주 목표 달성률 *${wp.pct}%* (${wp.count}/${wp.goal})`);
  const text = lines.join("\n");

  if (photos.length && await uploadPhotosToThread(ts, photos, text)) return; // photos + comment in one
  await slackPost({ channel: CHANNEL_ID, thread_ts: ts, text }); // text only (no photo / upload failed)
}

// ── DM conversation (Geekbot style) ──
const Q = {
  goal: "주당 목표 운동 *일수*를 숫자로 알려주세요 (1~7). 없으면 `skip`.",
  workout: "*어떤 운동*을 했나요? (예: 헬스, 러닝, 수영) 없으면 `skip`.",
  duration: "오늘 운동 *시간(분)*을 숫자로 알려주세요. 없으면 `skip`.",
  calories: "*소모 칼로리(kcal)*를 숫자로 알려주세요. 없으면 `skip`.",
  photo: "마지막으로 *인증 사진*을 올려주세요 📸 (없으면 `skip`).",
};
const qName = (names: string[]) =>
  `처음이시네요! 💪 사용할 *이름*을 입력해주세요.\n${names.length ? `기존 기록이 있으면 그 이름으로: ${names.join(", ")}\n` : ""}새 멤버면 새 이름을 적어주세요.`;

const SKIP = new Set(["skip", "없음", "없어", "없어요", "패스", "pass", "x", "-", "."]);
const isSkip = (t: string) => SKIP.has(t.trim().toLowerCase());
const isCancel = (t: string) => ["취소", "cancel", "그만", "중단"].includes(t.trim().toLowerCase());

async function setSession(uid: string, step: string, data: Record<string, unknown>) {
  await supabase.from("checkin_sessions").upsert({ slack_user_id: uid, step, data, updated_at: new Date().toISOString() });
}
async function clearSession(uid: string) { await supabase.from("checkin_sessions").delete().eq("slack_user_id", uid); }

async function startCheckin(uid: string) {
  const member = await getMember(uid);
  if (member) { await setSession(uid, "workout", {}); await dm(uid, Q.workout); }
  else { await setSession(uid, "name", {}); await dm(uid, qName(await unclaimedNicknames())); }
}

// permalink to today's thread parent message (null if unavailable)
async function todayThreadLink(): Promise<string | null> {
  if (!CHANNEL_ID) return null;
  const { data } = await supabase.from("daily_threads").select("thread_ts").eq("thread_date", todayKST()).eq("channel", CHANNEL_ID).maybeSingle();
  if (!data) return null;
  const r = await (await fetch(`https://slack.com/api/chat.getPermalink?channel=${CHANNEL_ID}&message_ts=${data.thread_ts}`, { headers: { authorization: `Bearer ${BOT_TOKEN}` } })).json();
  return r.ok ? r.permalink : null;
}

async function finalize(uid: string, data: any, photos: Photo[]) {
  let member = await getMember(uid);
  if (!member) {
    await supabase.from("members").upsert({ slack_user_id: uid, nickname: data.name, weekly_goal: data.goal ?? null });
    member = { nickname: data.name, weekly_goal: data.goal ?? null };
  }
  const workout = data.workout ?? null, dur = data.duration ?? null, cal = data.calories ?? null;
  const todayCount = await recordCheckin(member.nickname, uid, workout, dur, cal);
  await announceCheckin(member.nickname, workout, dur, cal, todayCount, photos);
  await clearSession(uid);
  const extra = todayCount > 1 ? ` (오늘 ${todayCount}번째)` : "";
  const link = await todayThreadLink();
  const linkPart = link ? `\n🔗 <${link}|오늘 인증 스레드>` : "";
  await dm(uid, `오늘 운동 인증 완료! 🔥 (${member.nickname})${detailSuffix(workout, dur, cal)}${extra}${linkPart}`);
}

async function handleDM(event: any) {
  const uid = event.user;
  const { data: session } = await supabase.from("checkin_sessions").select("*").eq("slack_user_id", uid).maybeSingle();
  if (!session) return; // no active check-in conversation
  const text = (event.text || "").trim();
  if (isCancel(text)) { await clearSession(uid); await dm(uid, "인증을 취소했어요. 다시 하려면 `/운동 인증`."); return; }
  const data = session.data || {};

  switch (session.step) {
    case "name": {
      if (!text) { await dm(uid, "이름을 입력해주세요."); return; }
      if (text.length > 20) { await dm(uid, "이름이 너무 길어요 (20자 이내)."); return; }
      const { data: clash } = await supabase.from("members").select("slack_user_id").eq("nickname", text).maybeSingle();
      if (clash && clash.slack_user_id !== uid) { await dm(uid, "이미 사용 중인 이름이에요. 다른 이름을 적어주세요."); return; }
      data.name = text; await setSession(uid, "goal", data); await dm(uid, Q.goal); return;
    }
    case "goal": {
      if (isSkip(text)) data.goal = null;
      else { const g = parseInt(text.replace(/[^0-9]/g, ""), 10); if (!(g >= 1 && g <= 7)) { await dm(uid, "1~7 사이 숫자로 알려주세요. 없으면 `skip`."); return; } data.goal = g; }
      await setSession(uid, "workout", data); await dm(uid, Q.workout); return;
    }
    case "workout": {
      data.workout = isSkip(text) ? null : text.slice(0, 40);
      await setSession(uid, "duration", data); await dm(uid, Q.duration); return;
    }
    case "duration": {
      data.duration = isSkip(text) ? null : parseMetric(text, 1440);
      await setSession(uid, "calories", data); await dm(uid, Q.calories); return;
    }
    case "calories": {
      data.calories = isSkip(text) ? null : parseMetric(text, 10000);
      await setSession(uid, "photo", data); await dm(uid, Q.photo); return;
    }
    case "photo": {
      const imgs: Photo[] = (event.files || []).filter((f: any) => (f.mimetype || "").startsWith("image/"))
        .map((f: any) => ({ url: f.url_private, name: f.name || "checkin.jpg", mime: f.mimetype }));
      if (imgs.length) { await finalize(uid, data, imgs); return; }
      if (isSkip(text)) { await finalize(uid, data, []); return; }
      await dm(uid, "사진을 올리거나 `skip` 이라고 답해주세요."); return;
    }
  }
}

// ── slash subcommands ──
async function handleCommand(params: URLSearchParams): Promise<Response> {
  const slackUserId = params.get("user_id")!;
  const text = (params.get("text") ?? "").trim();
  const [sub, ...rest] = text.split(/\s+/).filter(Boolean);
  const member = await getMember(slackUserId);

  if (sub === "인증" || !sub || sub === "도움말") {
    if (sub === "인증") { await startCheckin(slackUserId); return ephemeral("DM으로 인증을 진행해 주세요 👉 (운동봇과의 다이렉트 메시지 확인)"); }
    return ephemeral(HELP);
  }

  if (["취소", "내기록", "이름변경", "목표설정", "추첨"].includes(sub) && !member) {
    return ephemeral("먼저 `/운동 인증` 으로 등록해주세요. 🙂");
  }

  if (sub === "추첨") {
    if (!member!.is_admin) return ephemeral("추첨은 관리자만 실행할 수 있어요.");
    // args (any order): a count (integer) and/or a month (YYYY-MM)
    let ym = thisMonthKST(), numWinners = 1;
    for (const a of rest) {
      if (/^\d{4}-\d{2}$/.test(a)) ym = a;
      else if (/^\d+$/.test(a)) numWinners = Math.max(1, parseInt(a, 10));
    }
    const [yy, mo] = ym.split("-").map(Number);
    const next = mo === 12 ? `${yy + 1}-01-01` : `${yy}-${String(mo + 1).padStart(2, "0")}-01`;
    // widen the window so weeks whose Sunday falls in this month are fully captured (they may start in the prev month)
    const { data } = await supabase.from("checkins").select("nickname,checkin_date")
      .gte("checkin_date", addDaysKST(`${ym}-01`, -7)).lt("checkin_date", addDaysKST(next, 7));
    // bucket by (person, week's Sunday); a week counts for this month if its Sunday is in it; >=3 distinct days = 1 ticket
    const weeks: Record<string, Record<string, Set<string>>> = {};
    for (const r of data ?? []) {
      const sun = weekSunday(r.checkin_date as string);
      if (sun.slice(0, 7) !== ym) continue;
      ((weeks[r.nickname] ??= {})[sun] ??= new Set()).add(r.checkin_date as string);
    }
    const entrants = Object.entries(weeks)
      .map(([n, wkmap]) => ({ n, t: Object.values(wkmap).filter((days) => days.size >= 3).length }))
      .filter((e) => e.t > 0);
    const moName = MONTH_NAMES[mo - 1];
    if (!entrants.length) return ephemeral(`${moName}에 주 3회 이상 인증한 주가 있는 사람이 없어서 추첨할 수 없어요.`);
    const total = entrants.reduce((s, e) => s + e.t, 0);

    // weighted sampling without replacement
    const pool = [...entrants];
    const winners: { n: string; t: number }[] = [];
    const k = Math.min(numWinners, pool.length);
    for (let w = 0; w < k; w++) {
      const tot = pool.reduce((s, e) => s + e.t, 0);
      let pick = Math.floor(Math.random() * tot), idx = 0;
      for (let i = 0; i < pool.length; i++) { if (pick < pool[i].t) { idx = i; break; } pick -= pool[i].t; }
      winners.push(pool[idx]);
      pool.splice(idx, 1);
    }

    // resolve mentions (tag winners we know the Slack id for)
    const { data: mems } = await supabase.from("members").select("nickname,slack_user_id").in("nickname", winners.map((w) => w.n));
    const idOf: Record<string, string> = {};
    for (const m of mems ?? []) if (m.slack_user_id) idOf[m.nickname] = m.slack_user_id;
    const lines = winners.map((w, i) => {
      const who = idOf[w.n] ? `<@${idOf[w.n]}>` : `*${w.n}*`;
      return `${k > 1 ? `${i + 1}. ` : ""}${who} 님 (응모권 ${w.t}장)`;
    });
    if (CHANNEL_ID) {
      const title = k > 1 ? `🎁 *${moName} 운동 경품 추첨!* (${k}명)` : `🎁 *${moName} 운동 경품 추첨!*`;
      await slackPost({ channel: CHANNEL_ID, text: `${title}\n응모 ${entrants.length}명 · 총 응모권 ${total}장 (주 3회 이상 인증한 주마다 1장)\n🎉 당첨:\n${lines.join("\n")}\n축하합니다 👏` });
    }
    return ephemeral(`추첨 완료 🎉 당첨 ${k}명: ${winners.map((w) => w.n).join(", ")}. 채널에 발표했어요.`);
  }

  if (sub === "취소") {
    const { data: del } = await supabase.from("checkins").delete().eq("checkin_date", todayKST()).eq("nickname", member!.nickname).select();
    const n = del?.length ?? 0;
    return ephemeral(n ? `오늘 인증을 취소했어요. (${n}건, ${member!.nickname})` : "오늘은 인증 기록이 없어요.");
  }

  if (sub === "내기록") {
    const { data } = await supabase.from("checkins").select("checkin_date,duration_min,calories").eq("nickname", member!.nickname);
    const rows = data ?? [];
    const dates = rows.map((r) => r.checkin_date as string);
    const ym = thisMonthKST();
    const monthRows = rows.filter((r) => (r.checkin_date as string).startsWith(ym));
    const monthDays = new Set(monthRows.map((r) => r.checkin_date as string)).size;
    const totalDays = new Set(dates).size;
    const sumMin = monthRows.reduce((s, r) => s + (r.duration_min ?? 0), 0);
    const sumKcal = monthRows.reduce((s, r) => s + (r.calories ?? 0), 0);
    const streak = longestStreak(dates);
    const moName = MONTH_NAMES[Number(ym.slice(5, 7)) - 1];
    const wp = await weeklyProgress(member!.nickname);
    const goalLine = wp ? `\n• 이번주 목표: *${wp.count}/${wp.goal}일* (달성률 ${wp.pct}%)` : "";
    const metricLine = (sumMin || sumKcal) ? `\n• ${moName} 운동시간: *${sumMin}분* · 칼로리: *${sumKcal}kcal*` : "";
    return ephemeral(`*${member!.nickname}님의 기록* 📊\n• ${moName} 운동: *${monthDays}일* (${monthRows.length}회)\n• 최장 연속: *${streak}일*\n• 전체 누적: *${totalDays}일*${metricLine}${goalLine}`);
  }

  if (sub === "순위") {
    const ym = thisMonthKST();
    const counts = await monthlyDayCounts(ym);
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!ranked.length) return ephemeral("이번달 인증 기록이 아직 없어요.");
    const medals = ["🥇", "🥈", "🥉"];
    const moName = MONTH_NAMES[Number(ym.slice(5, 7)) - 1];
    const lines = ranked.map(([n, c], i) => `${medals[i] ?? `${i + 1}.`} ${n} — ${c}일`);
    return ephemeral(`*${moName} 운동 순위* 🏆 (운동 일수)\n${lines.join("\n")}`);
  }

  if (sub === "이름변경") {
    const newName = rest.join(" ").trim();
    if (!newName) return ephemeral("바꿀 이름을 입력해주세요. 예: `/운동 이름변경 병철`");
    if (newName.length > 20) return ephemeral("이름이 너무 길어요 (20자 이내).");
    const { data: clash } = await supabase.from("members").select("slack_user_id").eq("nickname", newName).maybeSingle();
    if (clash && clash.slack_user_id !== slackUserId) return ephemeral("이미 사용 중인 이름이에요. 다른 이름을 써주세요.");
    const old = member!.nickname;
    await supabase.from("members").update({ nickname: newName }).eq("slack_user_id", slackUserId);
    await supabase.from("checkins").update({ nickname: newName }).eq("nickname", old);
    return ephemeral(`이름을 *${old}* → *${newName}* 으로 변경했어요. ✅`);
  }

  if (sub === "목표설정") {
    if (!rest[0]) {
      return ephemeral(member!.weekly_goal ? `현재 주간 목표: *${member!.weekly_goal}일*\n변경하려면 \`/운동 목표설정 5\`` : "주간 목표가 없어요. 설정하려면 `/운동 목표설정 5`");
    }
    const n = parseInt(rest[0], 10);
    if (isNaN(n) || n < 1 || n > 7) return ephemeral("1~7 사이 숫자로 입력해주세요. 예: `/운동 목표설정 5`");
    await supabase.from("members").update({ weekly_goal: n }).eq("slack_user_id", slackUserId);
    return ephemeral(`주간 목표 *${n}일* 설정 완료! 💪`);
  }

  return ephemeral(HELP);
}

// run work in the background so we can ACK Slack within 3s
function bg(p: Promise<unknown>) {
  const ed = (globalThis as any).EdgeRuntime;
  if (ed?.waitUntil) ed.waitUntil(p.catch((e) => console.error(e)));
  return ed?.waitUntil ? Promise.resolve() : p.catch((e) => console.error(e));
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });

  // Cron trigger (pg_cron) — no Slack signature; authenticated by a shared secret header
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret) {
    if (cronSecret !== Deno.env.get("CRON_SECRET")) return new Response("forbidden", { status: 403 });
    await bg(createDailyThread());
    return empty();
  }

  const rawBody = await req.text();
  if (!(await verifySlack(req, rawBody))) return new Response("invalid signature", { status: 401 });

  const ct = req.headers.get("content-type") || "";
  // Events API (DM conversation) — JSON body
  if (ct.includes("application/json")) {
    const body = JSON.parse(rawBody);
    if (body.type === "url_verification") return new Response(body.challenge, { status: 200 });
    if (req.headers.get("x-slack-retry-num")) return empty(); // already ACKed; skip retries
    if (body.type === "event_callback") {
      const ev = body.event;
      if (ev?.type === "message" && ev.channel_type === "im" && !ev.bot_id && ev.user && (ev.text !== undefined || ev.files)) {
        await bg(handleDM(ev));
      }
      return empty();
    }
    return empty();
  }

  // Slash commands — form-encoded
  try {
    const params = new URLSearchParams(rawBody);
    if (params.get("command")) return await handleCommand(params);
    return empty();
  } catch (e) {
    console.error(e);
    return ephemeral("앗, 처리 중 오류가 났어요. 잠시 후 다시 시도해주세요.");
  }
});
