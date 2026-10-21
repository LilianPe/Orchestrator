#!/usr/bin/env bash
# Runs every variant of the scenario; full outputs in results/<label>/run.txt.
set -uo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here"
rm -rf results
run() {
  local opt=$1 label=$2; shift 2
  mkdir -p "results/$label"
  env "$@" bash shared/run-scenario.sh "$opt" "$label" > "results/$label/run.txt" 2>&1
  echo "exit $?" >> "results/$label/run.txt"
  echo "== $label"
  grep -E '^\{"received|recovered|NOT DONE|^rejeu|^exit' "results/$label/run.txt"
}
run maison maison
run dbos dbos
run maison maison-sans-cle IGNORE_IDEMPOTENCY=1
run dbos dbos-sans-cle IGNORE_IDEMPOTENCY=1
run dbos dbos-nouveau-code WORKER2_APPVERSION=v2 WAIT_ITER=40
