#!/usr/bin/env bash
# Delete a Slack thread (parent + bot replies) from a message link — no need to find the ts.
# Copy the message link in Slack (⋮ → Copy link) and pass it in.
# Usage: SLACK_BOT_TOKEN=xoxb-... bash scripts/delete-thread-url.sh "<slack message link>"
# e.g.   SLACK_BOT_TOKEN=xoxb-... bash scripts/delete-thread-url.sh \
#          "https://xxx.slack.com/archives/C0APVNGH6SJ/p1780758406925409"
set -euo pipefail
TOKEN="${SLACK_BOT_TOKEN:?SLACK_BOT_TOKEN env var is required}"
LINK="${1:?paste the Slack message link as the first argument}"

# parse channel id and message id from .../archives/<CHANNEL>/p<digits>
CH=$(printf '%s' "$LINK" | sed -nE 's#.*/archives/([A-Z0-9]+)/.*#\1#p')
PID=$(printf '%s' "$LINK" | sed -nE 's#.*/p([0-9]+).*#\1#p')
if [ -z "$CH" ] || [ -z "$PID" ]; then echo "링크 파싱 실패: $LINK"; exit 1; fi
# ts = the digits with a dot inserted before the last 6
TS="${PID:0:${#PID}-6}.${PID: -6}"
echo "channel=$CH  thread_ts=$TS"

echo "스레드 메시지 조회..."
TSES=$(curl -sS --max-time 20 https://slack.com/api/conversations.replies \
  -H "Authorization: Bearer $TOKEN" -d channel="$CH" -d ts="$TS" -d limit=200 \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('\n'.join(m['ts'] for m in d.get('messages',[])))")

if [ -z "$TSES" ]; then echo "삭제할 메시지가 없어요 (이미 지워졌거나 링크가 부모가 아님)."; exit 0; fi

for t in $TSES; do
  printf "delete %s -> " "$t"
  curl -sS --max-time 20 https://slack.com/api/chat.delete \
    -H "Authorization: Bearer $TOKEN" -d channel="$CH" -d ts="$t"
  echo
  sleep 0.4
done
echo "done"
