// Slack /운동 slash command handler (Supabase Edge Function, Deno)
// Deploy: supabase functions deploy slack --no-verify-jwt
//   (Slack doesn't send a Supabase JWT, so disable JWT verification and verify the Slack signature instead)
// Secrets: SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN
//   (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically by Supabase)
//
// Subcommands:
//   /운동 인증            check in for today (modal: optional time/calories; first-timers also pick a name)
//   /운동 취소            cancel today's check-in
//   /운동 내기록          your monthly count / longest streak
//   /운동 순위            this month's leaderboard
//   /운동 이름변경 <name> change nickname
//   /운동 (도움말)        help
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SIGNING_SECRET = Deno.env.get("SLACK_SIGNING_SECRET")!;
const BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN")!;
const CHANNEL_ID = Deno.env.get("SLACK_CHANNEL_ID"); // channel for check-in threads (no channel = skip notifications)
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const MONTH_NAMES = ["1월","2월","3월","4월","5월","6월","7월","8월","9월","10월","11월","12월"];

// ── KST date helpers ──
function todayKST(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
const thisMonthKST = () => todayKST().slice(0, 7); // YYYY-MM

// Monday of the current week (KST, YYYY-MM-DD)
function weekStartKST(): string {
  const [y, m, d] = todayKST().split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const back = (dt.getUTCDay() + 6) % 7; // Monday = 0
  dt.setUTCDate(dt.getUTCDate() - back);
  return dt.toISOString().slice(0, 10);
}

// ── Slack signature verification ──
async function verifySlack(req: Request, rawBody: string): Promise<boolean> {
  const ts = req.headers.get("x-slack-request-timestamp");
  const sig = req.headers.get("x-slack-signature");
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${ts}:${rawBody}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expected = `v0=${hex}`;
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ephemeral = (text: string) => json({ response_type: "ephemeral", text });
const empty = () => new Response("", { status: 200 });

const HELP = [
  "*운동 인증 봇 사용법* 💪",
  "• `/운동 인증` — 오늘 운동 인증",
  "• `/운동 취소` — 오늘 인증 취소",
  "• `/운동 내기록` — 내 이번달 기록",
  "• `/운동 순위` — 이번달 리더보드",
  "• `/운동 이름변경 새이름` — 닉네임 변경",
  "• `/운동 목표설정 5` — 주간 목표 횟수 설정",
].join("\n");

// ── longest streak (YYYY-MM-DD[] → number of days) ──
function longestStreak(dates: string[]): number {
  if (!dates.length) return 0;
  const sorted = [...new Set(dates)].sort();
  const t = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  let best = 1, cur = 1;
  for (let i = 1; i < sorted.length; i++) {
    const diff = (t(sorted[i]) - t(sorted[i - 1])) / 86400000;
    cur = diff === 1 ? cur + 1 : 1;
    if (cur > best) best = cur;
  }
  return best;
}

// parse an optional positive integer metric (returns null if empty/invalid)
function parseMetric(v: string | undefined, max: number): number | null {
  const n = parseInt((v ?? "").replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) && n > 0 && n <= max ? n : null;
}

// "· 45분 · 300kcal" style suffix (empty if no metrics)
function metricSuffix(duration: number | null, calories: number | null): string {
  const parts: string[] = [];
  if (duration != null) parts.push(`${duration}분`);
  if (calories != null) parts.push(`${calories}kcal`);
  return parts.length ? " · " + parts.join(" · ") : "";
}

// ── record today's check-in (returns false if it already exists) ──
async function recordCheckin(
  nickname: string, slackUserId: string,
  duration: number | null = null, calories: number | null = null,
): Promise<boolean> {
  const { error } = await supabase.from("checkins").insert({
    checkin_date: todayKST(), nickname, slack_user_id: slackUserId,
    duration_min: duration, calories,
  });
  if (error) {
    if (error.code === "23505") return false;
    throw error;
  }
  return true;
}

// update today's metrics on an existing check-in (for the "already checked in" case)
async function updateMetrics(nickname: string, duration: number | null, calories: number | null): Promise<boolean> {
  const patch: Record<string, number> = {};
  if (duration != null) patch.duration_min = duration;
  if (calories != null) patch.calories = calories;
  if (!Object.keys(patch).length) return false;
  await supabase.from("checkins").update(patch)
    .eq("checkin_date", todayKST()).eq("nickname", nickname);
  return true;
}

// ── send a Slack message ──
async function slackPost(body: Record<string, unknown>): Promise<any> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${BOT_TOKEN}` },
    body: JSON.stringify(body),
  });
  return await res.json();
}

// ── post a check-in thread comment to the channel (includes rank change) ──
async function announceCheckin(nickname: string, duration: number | null = null, calories: number | null = null) {
  if (!CHANNEL_ID) return;
  const date = todayKST();
  const [, mm, dd] = date.split("-").map(Number);
  const ym = date.slice(0, 7);

  // this month's counts (after the check-in was recorded)
  const { data } = await supabase.from("checkins").select("nickname").gte("checkin_date", `${ym}-01`);
  const counts: Record<string, number> = {};
  for (const r of data ?? []) counts[r.nickname] = (counts[r.nickname] ?? 0) + 1;
  const myAfter = counts[nickname] ?? 1;
  const others = Object.entries(counts).filter(([n]) => n !== nickname).map(([, c]) => c);
  const rankOf = (val: number) => 1 + others.filter((c) => c > val).length; // tied ranks (Olympic style)
  const afterRank = rankOf(myAfter);
  const myBefore = myAfter - 1;

  let rankMsg: string;
  if (myBefore <= 0) {
    rankMsg = `🎉 ${mm}월 첫 인증! 현재 *${afterRank}위*`;
  } else {
    const beforeRank = rankOf(myBefore);
    rankMsg = afterRank < beforeRank
      ? `📈 ${mm}월 순위 *${beforeRank}위 → ${afterRank}위* 상승!`
      : `${mm}월 현재 *${afterRank}위* · 이번달 ${myAfter}회`;
  }

  // get today's thread (create the parent message if missing)
  let ts: string | null = null;
  const { data: existing } = await supabase
    .from("daily_threads").select("thread_ts")
    .eq("thread_date", date).eq("channel", CHANNEL_ID).maybeSingle();
  if (existing) {
    ts = existing.thread_ts;
  } else {
    const parent = await slackPost({ channel: CHANNEL_ID, text: `*${mm}월 ${dd}일 운동 인증 스레드* 💪` });
    if (parent?.ok && parent.ts) {
      ts = parent.ts;
      await supabase.from("daily_threads").insert({ thread_date: date, channel: CHANNEL_ID, thread_ts: ts });
      // concurrency: if another call created it first, use that ts
      const { data: canon } = await supabase
        .from("daily_threads").select("thread_ts")
        .eq("thread_date", date).eq("channel", CHANNEL_ID).maybeSingle();
      if (canon) ts = canon.thread_ts;
    }
  }
  if (!ts) return;
  const wp = await weeklyProgress(nickname);
  const goalMsg = wp ? `\n🎯 이번주 목표 달성률 *${wp.pct}%* (${wp.count}/${wp.goal})` : "";
  const metricMsg = metricSuffix(duration, calories);
  await slackPost({ channel: CHANNEL_ID, thread_ts: ts, text: `*${nickname}* 님이 오늘의 운동을 인증했어요!${metricMsg}\n${rankMsg}${goalMsg}` });
}

// run the channel notification in the background so the response isn't delayed (waitUntil if available)
function announceBg(nickname: string, duration: number | null = null, calories: number | null = null) {
  const p = announceCheckin(nickname, duration, calories).catch((e) => console.error("announce error", e));
  const ed = (globalThis as any).EdgeRuntime;
  if (ed?.waitUntil) ed.waitUntil(p);
  return ed?.waitUntil ? Promise.resolve() : p;
}

async function getMember(slackUserId: string) {
  const { data } = await supabase
    .from("members").select("nickname, weekly_goal").eq("slack_user_id", slackUserId).maybeSingle();
  return data;
}

// weekly goal progress (null if no goal set)
async function weeklyProgress(nickname: string) {
  const { data: mem } = await supabase
    .from("members").select("weekly_goal").eq("nickname", nickname).maybeSingle();
  const goal = mem?.weekly_goal ?? null;
  if (!goal) return null;
  const { data } = await supabase
    .from("checkins").select("checkin_date").eq("nickname", nickname).gte("checkin_date", weekStartKST());
  const count = (data ?? []).length;
  return { count, goal, pct: Math.round((count / goal) * 100) };
}

// ── historical nicknames not yet claimed (modal options) ──
async function unclaimedNicknames(): Promise<string[]> {
  const { data: cks } = await supabase.from("checkins").select("nickname");
  const { data: mem } = await supabase.from("members").select("nickname");
  const taken = new Set((mem ?? []).map((m) => m.nickname));
  return [...new Set((cks ?? []).map((c) => c.nickname))].filter((n) => !taken.has(n)).sort();
}

// optional workout-metric input blocks (shared by both modals)
function metricBlocks(): unknown[] {
  return [
    {
      type: "input", optional: true, block_id: "duration",
      label: { type: "plain_text", text: "운동 시간 (분)" },
      element: { type: "number_input", is_decimal_allowed: false, action_id: "v", min_value: "1", max_value: "1440" },
    },
    {
      type: "input", optional: true, block_id: "calories",
      label: { type: "plain_text", text: "소모 칼로리 (kcal)" },
      element: { type: "number_input", is_decimal_allowed: false, action_id: "v", min_value: "1", max_value: "10000" },
    },
  ];
}

// ── open the check-in modal (registered users): optional time/calories ──
async function openCheckinModal(triggerId: string) {
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: "오늘 운동을 인증합니다 💪\n아래는 선택 입력이에요 (비워도 됩니다)." } },
    ...metricBlocks(),
  ];
  await fetch("https://slack.com/api/views.open", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${BOT_TOKEN}` },
    body: JSON.stringify({
      trigger_id: triggerId,
      view: {
        type: "modal", callback_id: "checkin",
        title: { type: "plain_text", text: "운동 인증" },
        submit: { type: "plain_text", text: "인증하기" },
        close: { type: "plain_text", text: "취소" },
        blocks,
      },
    }),
  });
}

// ── open the name-picker modal ──
async function openModal(triggerId: string, names: string[]) {
  const blocks: unknown[] = [{
    type: "section",
    text: { type: "mrkdwn", text: "처음이시네요! 💪\n사용할 이름을 정해주세요. 기존 기록이 있으면 목록에서 고르고, 새 멤버면 새 이름을 입력하세요." },
  }];
  if (names.length > 0) {
    blocks.push({
      type: "input", optional: true, block_id: "existing",
      label: { type: "plain_text", text: "기존 이름에서 선택" },
      element: {
        type: "static_select", action_id: "sel",
        placeholder: { type: "plain_text", text: "이름 선택" },
        options: names.slice(0, 100).map((n) => ({ text: { type: "plain_text", text: n }, value: n })),
      },
    });
  }
  blocks.push({
    type: "input", optional: true, block_id: "newname",
    label: { type: "plain_text", text: "새 이름 (신규 멤버)" },
    element: { type: "plain_text_input", action_id: "txt", max_length: 20 },
  });
  blocks.push({
    type: "input", block_id: "goal",
    label: { type: "plain_text", text: "주당 목표 운동 횟수" },
    element: {
      type: "static_select", action_id: "g",
      placeholder: { type: "plain_text", text: "횟수 선택" },
      options: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ text: { type: "plain_text", text: `주 ${n}회` }, value: String(n) })),
    },
  });
  blocks.push(...metricBlocks());

  await fetch("https://slack.com/api/views.open", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${BOT_TOKEN}` },
    body: JSON.stringify({
      trigger_id: triggerId,
      view: {
        type: "modal", callback_id: "register_name",
        title: { type: "plain_text", text: "운동 인증" },
        submit: { type: "plain_text", text: "인증하기" },
        close: { type: "plain_text", text: "취소" },
        blocks,
      },
    }),
  });
}

// ── subcommand handling ──
async function handleCommand(params: URLSearchParams): Promise<Response> {
  const slackUserId = params.get("user_id")!;
  const triggerId = params.get("trigger_id")!;
  const text = (params.get("text") ?? "").trim();
  const [sub, ...rest] = text.split(/\s+/).filter(Boolean);

  const member = await getMember(slackUserId);

  // check-in: unregistered users get the registration modal, registered users get the check-in modal
  if (sub === "인증") {
    if (!member) await openModal(triggerId, await unclaimedNicknames());
    else await openCheckinModal(triggerId);
    return empty();
  }

  // commands other than check-in require registration
  if (["취소", "내기록", "이름변경", "목표설정"].includes(sub) && !member) {
    return ephemeral("먼저 `/운동 인증` 으로 등록해주세요. 🙂");
  }

  if (sub === "취소") {
    const { data: del } = await supabase
      .from("checkins").delete()
      .eq("checkin_date", todayKST()).eq("nickname", member!.nickname).select();
    return ephemeral(del && del.length
      ? `오늘 인증을 취소했어요. (${member!.nickname})`
      : "오늘은 인증 기록이 없어요.");
  }

  if (sub === "내기록") {
    const { data } = await supabase
      .from("checkins").select("checkin_date,duration_min,calories").eq("nickname", member!.nickname);
    const rows = data ?? [];
    const dates = rows.map((r) => r.checkin_date as string);
    const ym = thisMonthKST();
    const monthRows = rows.filter((r) => (r.checkin_date as string).startsWith(ym));
    const monthCount = monthRows.length;
    const sumMin = monthRows.reduce((s, r) => s + (r.duration_min ?? 0), 0);
    const sumKcal = monthRows.reduce((s, r) => s + (r.calories ?? 0), 0);
    const streak = longestStreak(dates);
    const moName = MONTH_NAMES[Number(ym.slice(5, 7)) - 1];
    const wp = await weeklyProgress(member!.nickname);
    const goalLine = wp ? `\n• 이번주 목표: *${wp.count}/${wp.goal}회* (달성률 ${wp.pct}%)` : "";
    const metricLine = (sumMin || sumKcal)
      ? `\n• ${moName} 운동시간: *${sumMin}분* · 칼로리: *${sumKcal}kcal*` : "";
    return ephemeral(
      `*${member!.nickname}님의 기록* 📊\n• ${moName} 인증: *${monthCount}회*\n• 최장 연속: *${streak}일*\n• 전체 누적: *${dates.length}회*${metricLine}${goalLine}`,
    );
  }

  if (sub === "순위") {
    const ym = thisMonthKST();
    const { data } = await supabase
      .from("checkins").select("nickname").gte("checkin_date", `${ym}-01`);
    const cnt: Record<string, number> = {};
    for (const r of data ?? []) cnt[r.nickname] = (cnt[r.nickname] ?? 0) + 1;
    const ranked = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!ranked.length) return ephemeral("이번달 인증 기록이 아직 없어요.");
    const medals = ["🥇", "🥈", "🥉"];
    const moName = MONTH_NAMES[Number(ym.slice(5, 7)) - 1];
    const lines = ranked.map(([n, c], i) => `${medals[i] ?? `${i + 1}.`} ${n} — ${c}회`);
    return ephemeral(`*${moName} 운동 순위* 🏆\n${lines.join("\n")}`);
  }

  if (sub === "이름변경") {
    const newName = rest.join(" ").trim();
    if (!newName) return ephemeral("바꿀 이름을 입력해주세요. 예: `/운동 이름변경 병철`");
    if (newName.length > 20) return ephemeral("이름이 너무 길어요 (20자 이내).");
    const { data: clash } = await supabase
      .from("members").select("slack_user_id").eq("nickname", newName).maybeSingle();
    if (clash && clash.slack_user_id !== slackUserId) {
      return ephemeral("이미 사용 중인 이름이에요. 다른 이름을 써주세요.");
    }
    const old = member!.nickname;
    await supabase.from("members").update({ nickname: newName }).eq("slack_user_id", slackUserId);
    await supabase.from("checkins").update({ nickname: newName }).eq("nickname", old);
    return ephemeral(`이름을 *${old}* → *${newName}* 으로 변경했어요. ✅`);
  }

  if (sub === "목표설정") {
    if (!rest[0]) {
      return ephemeral(member!.weekly_goal
        ? `현재 주간 목표: *${member!.weekly_goal}회*\n변경하려면 \`/운동 목표설정 5\``
        : "주간 목표가 없어요. 설정하려면 `/운동 목표설정 5`");
    }
    const n = parseInt(rest[0], 10);
    if (isNaN(n) || n < 1 || n > 21) return ephemeral("1~21 사이 숫자로 입력해주세요. 예: `/운동 목표설정 5`");
    await supabase.from("members").update({ weekly_goal: n }).eq("slack_user_id", slackUserId);
    return ephemeral(`주간 목표 *${n}회* 설정 완료! 💪`);
  }

  // empty input / help / unknown command
  return ephemeral(HELP);
}

// read optional metrics from a modal's state
function readMetrics(vals: any) {
  return {
    duration: parseMetric(vals.duration?.v?.value, 1440),
    calories: parseMetric(vals.calories?.v?.value, 10000),
  };
}

// ── registration modal submission (first-time user) ──
async function handleRegisterSubmit(payload: any): Promise<Response> {
  const slackUserId = payload.user.id;
  const slackName = payload.user.username ?? payload.user.name ?? "";
  const vals = payload.view.state.values;
  const typed = vals.newname?.txt?.value?.trim();
  const picked = vals.existing?.sel?.selected_option?.value;
  const nickname = typed || picked;
  const goalVal = vals.goal?.g?.selected_option?.value;
  const weekly_goal = goalVal ? parseInt(goalVal, 10) : null;
  const { duration, calories } = readMetrics(vals);

  if (!nickname) {
    return json({ response_action: "errors", errors: { newname: "이름을 선택하거나 입력해주세요." } });
  }
  const { data: clash } = await supabase
    .from("members").select("slack_user_id").eq("nickname", nickname).maybeSingle();
  if (clash && clash.slack_user_id !== slackUserId) {
    return json({ response_action: "errors", errors: { newname: "이미 사용 중인 이름이에요. 다른 이름을 써주세요." } });
  }

  const { error: upErr } = await supabase
    .from("members").upsert({ slack_user_id: slackUserId, slack_name: slackName, nickname, weekly_goal });
  if (upErr) {
    return json({ response_action: "errors", errors: { newname: "등록 중 오류가 났어요. 다시 시도해주세요." } });
  }

  const fresh = await recordCheckin(nickname, slackUserId, duration, calories);
  if (fresh) await announceBg(nickname, duration, calories);
  const goalNote = weekly_goal ? ` (주간 목표 ${weekly_goal}회)` : "";
  await slackPost({ channel: slackUserId, text: `'${nickname}' 이름으로 등록하고 오늘 인증 완료! 🔥${metricSuffix(duration, calories)}${goalNote}` });
  return empty();
}

// ── check-in modal submission (registered user) ──
async function handleCheckinSubmit(payload: any): Promise<Response> {
  const slackUserId = payload.user.id;
  const member = await getMember(slackUserId);
  if (!member) {
    return json({ response_action: "errors", errors: { duration: "먼저 `/운동 인증` 으로 등록해주세요." } });
  }
  const { duration, calories } = readMetrics(payload.view.state.values);
  const fresh = await recordCheckin(member.nickname, slackUserId, duration, calories);
  if (fresh) {
    await announceBg(member.nickname, duration, calories);
    await slackPost({ channel: slackUserId, text: `오늘 운동 인증 완료! 🔥 (${member.nickname})${metricSuffix(duration, calories)}` });
  } else {
    const updated = await updateMetrics(member.nickname, duration, calories);
    await slackPost({ channel: slackUserId, text: updated
      ? `오늘은 이미 인증했어요 ✅ 기록을 업데이트했어요${metricSuffix(duration, calories)} (${member.nickname})`
      : `오늘은 이미 인증했어요 ✅ (${member.nickname})` });
  }
  return empty();
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });
  const rawBody = await req.text();
  if (!(await verifySlack(req, rawBody))) return new Response("invalid signature", { status: 401 });

  const params = new URLSearchParams(rawBody);
  const payloadStr = params.get("payload");
  try {
    if (payloadStr) {
      const payload = JSON.parse(payloadStr);
      if (payload.type === "view_submission") {
        return payload.view?.callback_id === "checkin"
          ? await handleCheckinSubmit(payload)
          : await handleRegisterSubmit(payload);
      }
      return empty();
    }
    if (params.get("command")) return await handleCommand(params);
    return empty();
  } catch (e) {
    console.error(e);
    return ephemeral("앗, 처리 중 오류가 났어요. 잠시 후 다시 시도해주세요.");
  }
});
