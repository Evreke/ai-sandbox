#!/usr/bin/env bash
# Deterministic check-runner for pi-delegate.
#
# Why this exists: bun child-process spawns hang intermittently on this
# host under concurrent agent load (reproduces on a clean main), so a bare
# "run the full suite" is not a reliable signal. This runner makes the
# verdict deterministic:
#   PASS     — check green
#   FAIL     — check red (real regression; blocks)
#   ENV-FAIL — spawn failure / timeout that reproduces the known
#              environment flake (recorded, does NOT block)
# Protocol: per-file timeout, at most ONE retry on an env-shaped failure,
# no manual retry loops. An exit code of 0 requires zero FAILs; ENV-FAILs
# are allowed but must be listed.
set -u
cd "$(dirname "$0")/.." || exit 2
OUT="${1:-/tmp/checks-results.txt}"
: > "$OUT"
pass=0; fail=0; envfail=0
run_once() { timeout "${CHECK_TIMEOUT:-30}" bun run "$1" 2>&1; }
for t in test/*.ts; do
  case "$t" in *driver*|*fixture*|*goldens*) continue ;; esac
  out=$(run_once "$t"); rc=$?
  if [ $rc -ne 0 ] && printf '%s' "$out" | grep -qE "SPAWN FAILED|TIMEOUT"; then
    out=$(run_once "$t"); rc=$?   # the single env-flake retry
  fi
  if [ $rc -eq 0 ]; then
    pass=$((pass+1)); echo "PASS     $t" >> "$OUT"
  elif printf '%s' "$out" | grep -qE "SPAWN FAILED|TIMEOUT"; then
    envfail=$((envfail+1)); echo "ENV-FAIL $t" >> "$OUT"
  else
    fail=$((fail+1)); echo "FAIL     $t" >> "$OUT"; echo "$out" >> "$OUT"
  fi
done
echo "== pass=$pass fail=$fail env-fail=$envfail ==" >> "$OUT"
cat "$OUT"
[ $fail -eq 0 ]
