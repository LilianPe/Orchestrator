#!/usr/bin/env bash
# Same scenario for both options. Usage: bash shared/run-scenario.sh <maison|dbos> [label]
# Needs the throwaway container: docker run --rm -d --name orc129-pg -e POSTGRES_PASSWORD=spike -p 55432:5432 postgres:17-alpine
# IGNORE_IDEMPOTENCY=1 makes the fake API ignore the Idempotency-Key (control run).
# WORKER2_ENV="VAR=value ..." is added to the environment of the restarted worker only.
# Results land in results/<label>/.
set -euo pipefail
opt=$1
label=${2:-$opt}
here=$(cd "$(dirname "$0")/.." && pwd)
out="$here/results/$label"
mkdir -p "$out"
db="spike_${label//-/_}"
export DATABASE_URL="postgres://postgres:spike@127.0.0.1:55432/$db"
export FAKE_API_LOG="$out/fake-api.jsonl"
api_url=http://127.0.0.1:4129
cd "$here/$opt"

step() { printf '\n=== %s\n' "$*"; }
sql() { docker exec orc129-pg psql -qAt -U postgres -d "$db" -c "$1"; }
# wait_for <seconds> <command...>: polls every 0.1 s, fails after the timeout.
wait_for() {
  local deadline=$(($(date +%s) + $1)); shift
  until "$@"; do [ "$(date +%s)" -lt "$deadline" ] || return 1; sleep 0.1; done
}
applied() { grep -q '"applied"' "$FAKE_API_LOG"; }
ticket_done() { [ "$(sql "select count(*) from tickets where state->>'status' = 'done'")" = 1 ]; }

pids=()
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  for f in "$out"/worker-*.log; do [ -e "$f" ] && { echo "--- $(basename "$f")"; cat "$f"; }; done
}
trap cleanup EXIT

step "fresh database $db"
docker exec orc129-pg psql -qAt -U postgres -c "drop database if exists $db with (force)" -c "create database $db"

rm -f "$FAKE_API_LOG"
node ../shared/fake-api.ts & pids+=($!)
wait_for 10 curl -sf "$api_url/stats" -o /dev/null

step "setup"
node main.ts setup

step "webhook delivered twice (same delivery id)"
node main.ts send 1
node main.ts send 1

step "worker 1 starts; kill -9 as soon as the external API has applied the effect"
node main.ts worker > "$out/worker-1.log" 2>&1 & w=$!
wait_for 30 applied || { echo "EFFECT NEVER APPLIED"; kill $w; exit 1; }
kill -9 $w
wait $w 2>/dev/null || true
echo "worker 1 killed (-9) while the API holds its response"

step "worker 2 restarts (env: ${WORKER2_ENV:-none})"
start=$(date +%s.%N)
# shellcheck disable=SC2086
env ${WORKER2_ENV:-} node main.ts worker > "$out/worker-2.log" 2>&1 & pids+=($!)
recovered=yes
wait_for "${RECOVERY_TIMEOUT:-60}" ticket_done || recovered=no
end=$(date +%s.%N)
if [ $recovered = yes ]; then
  printf 'recovered to done in %.1f s after restart\n' "$(echo "$end - $start" | bc)"
else
  printf 'TICKET NOT DONE %.0f s after restart\n' "$(echo "$end - $start" | bc)"
fi

step "external API calls"
curl -s "$api_url/stats" | tee "$out/stats.json"; echo
grep -v listening "$FAKE_API_LOG"

step "state"
node main.ts status | tee "$out/status.json"

[ $recovered = yes ] || exit 1

step "replay of the journal"
node main.ts replay | tee "$out/replay.txt"

step "negative control: tamper with one recorded decision, the replay must report it"
sql "update journal set decision = jsonb_set(decision, '{state,commentId}', '\"comment-forged\"') where seq = 2"
node main.ts replay | tee "$out/replay-tampered.txt"
