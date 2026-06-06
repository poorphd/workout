#!/usr/bin/env bash
# Delete an entire thread (parent message + bot replies) — uses curl (for envs where node fetch is blocked)
# Usage: SLACK_BOT_TOKEN=xoxb-... bash scripts/delete-thread.sh <channelID> <thread_ts>
# Example: SLACK_BOT_TOKEN=xoxb-... bash scripts/delete-thread.sh C0APVNGH6SJ 1780680710.227379
set -euo pipefail
TOKEN="${SLACK_BOT_TOKEN:?SLACK_BOT_TOKEN env var is required}"
CH="${1:?pass the channel ID as the first argument}"
TS="${2:?pass the thread_ts as the second argument}"

echo "Fetching messages in thread $TS ..."
TSES=$(curl -sS --max-time 20 https://slack.com/api/conversations.replies \
  -H "Authorization: Bearer $TOKEN" \
  -d channel="$CH" -d ts="$TS" -d limit=200 \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('\n'.join(m['ts'] for m in d.get('messages',[])))")

if [ -z "$TSES" ]; then
  echo "No messages to delete (already removed or ts mismatch)."
  exit 0
fi

for t in $TSES; do
  printf "delete %s -> " "$t"
  curl -sS --max-time 20 https://slack.com/api/chat.delete \
    -H "Authorization: Bearer $TOKEN" -d channel="$CH" -d ts="$t"
  echo
  sleep 0.4
done
echo "done"
