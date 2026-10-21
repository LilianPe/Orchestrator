#!/usr/bin/env bash
# Same scenario for both options. Usage: bash shared/run-scenario.sh <maison|dbos> [label]
# Needs the throwaway container: docker run --rm -d --name orc129-pg -e POSTGRES_PASSWORD=spike -p 55432:5432 postgres:17-alpine
# IGNORE_IDEMPOTENCY=1 makes the fake API ignore the Idempotency-Key (control run).
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
cd "$here/$opt"

step() { printf '\n=== %s\n' "$*"; }

step "fresh database $db"
docker exec orc129-pg psql -qAt -U postgres -c "drop database if exists $db with (force)" -c "create database $db"

node ../shared/fake-api.ts & api=$!
trap 'kill $api 2>/dev/null || true' EXIT
until grep -q listening "$FAKE_API_LOG" 2>/dev/null; do sleep 0.1; done

step "setup"
node main.ts setup

step "webhook delivered twice (same delivery id)"
node main.ts send 1
node main.ts send 1

step "worker 1 starts; kill -9 as soon as the external API has applied the effect"
node main.ts worker > "$out/worker-1.log" 2>&1 & w=$!
until grep -q '"applied"' "$FAKE_API_LOG"; do sleep 0.05; done
kill -9 $w
wait $w 2>/dev/null || true
echo "worker 1 killed (-9) while the API holds its response"
cat "$out/worker-1.log"

step "worker 2 restarts"
start=$(date +%s.%N)
# WORKER2_APPVERSION simulates a deploy of new code between the crash and the restart (DBOS only).
${WORKER2_APPVERSION:+env DBOS__APPVERSION=$WORKER2_APPVERSION} node main.ts worker > "$out/worker-2.log" 2>&1 & w=$!
for _ in $(seq 1 "${WAIT_ITER:-300}"); do node main.ts done && break; sleep 0.2; done
end=$(date +%s.%N)
node main.ts done || { echo "TICKET NOT DONE after restart"; kill $w; exit 1; }
kill $w; wait $w 2>/dev/null || true
cat "$out/worker-2.log"
printf 'recovered to done in %.1f s after restart\n' "$(echo "$end - $start" | bc)"

step "external API calls"
curl -s 127.0.0.1:${FAKE_API_PORT:-4129}/stats | tee "$out/stats.json"; echo
grep -v listening "$FAKE_API_LOG"

step "state"
node main.ts status | tee "$out/status.json"

step "replay of the journal"
node main.ts replay | tee "$out/replay.txt"

step "negative control: tamper with one recorded decision, the replay must report it"
docker exec orc129-pg psql -qAt -U postgres -d "$db" \
  -c "update journal set decision = jsonb_set(decision, '{state,commentId}', '\"comment-forged\"') where seq = 2"
node main.ts replay | tee "$out/replay-tampered.txt"
