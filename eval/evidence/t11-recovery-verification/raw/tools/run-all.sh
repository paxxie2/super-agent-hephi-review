#!/bin/bash
# T11 recovery verification runner (real deployed CLI on a /tmp state-dir copy).
# Writes raw command transcripts under $ROOT/raw; the real 3085/3086 state and
# processes are only READ (except a temporary sleep process owned by this script).
set -u
INSTANCE=/Users/zm/dsh-instances/g1-exp
REPO=/Users/zm/repos/hephi-review-main
CLI=$INSTANCE/hephi-review/hephi/lib/cli.mjs
OPCFG=$INSTANCE/operator-config.json
TICKET=46aa3f5947c125330ef14d8014a88477
REAL_STATE=$INSTANCE/state/hephi/$TICKET
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ROOT=/tmp/t11-recovery-$STAMP
R=$ROOT/raw
STATE=$ROOT/state
TICKET_DIR=$STATE/hephi/$TICKET
mkdir -p "$ROOT"/{raw,queries}
echo "ROOT=$ROOT" > "$ROOT/ROOT.env"
echo "STAMP=$STAMP" >> "$ROOT/ROOT.env"
# ---- helpers -------------------------------------------------------------
capture() { # capture <dir> <cmd...>
  local dir=$1; shift
  mkdir -p "$dir"
  printf '%q ' "$@" > "$dir/command.txt"; echo >> "$dir/command.txt"
  "$@" > "$dir/stdout.txt" 2> "$dir/stderr.txt"
  echo $? > "$dir/exit-code.txt"
}
run_json() { # run_json <runId> -> path
  echo "$TICKET_DIR/checks/$1/run.json"
}
hash_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
scan_absent() { # scan_absent <out> <marker>
  ps -ax -o pid=,command= > "$ROOT/ps-table.txt"
  local pat
  pat=$(cat "$2")
  python3 /tmp/t11-tools/scan-process.py "$ROOT/ps-table.txt" "$pat" > "$1" 2>&1
  echo "scan-exit=$?" >> "$1"
}


# ---- 00 read-only host facts + real-state baseline -----------------------
mkdir -p "$R/00-host-facts"
{
  echo "# T11 host facts (read-only) captured at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "## evidence repo HEAD"; git -C "$REPO" rev-parse HEAD; git -C "$REPO" status --porcelain
  echo "## 3085 host process"; ps -o pid=,user=,command= -p 33924
  echo "## 3085 http status (no token)"; curl -s -o /dev/null -w "http=%{http_code}\n" --max-time 3 http://127.0.0.1:3085/ || true
  echo "## 3086 frozen control (read-only probe; not touched)"; curl -s -o /dev/null -w "http=%{http_code}\n" --max-time 3 http://127.0.0.1:3086/ || true
  echo "## activation marker"; grep "hephi-activation" "$INSTANCE/logs/host.log" | tail -3
  echo "## CLI"; ls -l "$CLI"; shasum -a 256 "$CLI"
  echo "## operator config"; ls -l "$OPCFG"; cat "$OPCFG"
  echo "## resolve CLI usage (deployed ab5f527 build)"
  node "$CLI" resolve --help 2>&1 | head -30
} > "$R/00-host-facts/host-facts.txt" 2>&1
find "$REAL_STATE" -type f | sort | while read -r f; do printf "%s  %s\n" "$(hash_of "$f")" "${f#$REAL_STATE/}"; done > "$R/00-host-facts/real-state-before.txt"


# ---- seed a state-dir COPY from the real 3085 ticket (read-only real state) ----
mkdir -p "$TICKET_DIR/checks"
cp "$REAL_STATE/activation.json" "$TICKET_DIR/activation.json"
cp "$REAL_STATE/plan.jsonl" "$TICKET_DIR/plan.jsonl"
cp "$REAL_STATE/decisions.jsonl" "$TICKET_DIR/decisions.jsonl"
node /tmp/t11-tools/build-records.mjs \
  "$REAL_STATE/checks/ebeafca7-80ac-4497-a320-bd20722ca101/run.json" \
  "$STATE" "$TICKET" > "$R/00-seeded-records.json" 2>&1

run_still_running=11111111-aaaa-4bbb-8ccc-111111111111
run_unavailable=22222222-aaaa-4bbb-8ccc-222222222222
run_result_lost=33333333-aaaa-4bbb-8ccc-333333333333
run_leftover=44444444-aaaa-4bbb-8ccc-444444444444

# =========================================================================
# ① 仍在运行：host still reports the execution as running -> refuse unblock
# =========================================================================
D=$R/01-still-running; mkdir -p "$D"
json1=$(run_json "$run_still_running")
hash_of "$json1" > "$D/run-json-before.sha256"
sleep 240 >/dev/null 2>&1 &
check_pid=$!
echo "$check_pid" > "$D/check-process.pid"
sleep 0.3
{
  echo "# host process query at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "\$ ps -o pid=,ppid=,user=,command= -p $check_pid"
  ps -o pid=,ppid=,user=,command= -p "$check_pid"
  echo "\$ ps -o pid=,user=,command= -p 33924"
  ps -o pid=,user=,command= -p 33924
} > "$D/host-query-running.txt" 2>&1
capture "$D/attempt1-refused" node "$CLI" resolve --ticket "$TICKET" --run "$run_still_running" \
  --basis host-terminal --status running --host-query-file "$D/host-query-running.txt" \
  --operator t11-recovery-operator --state-dir "$STATE" --operator-config "$OPCFG"
ls -l "$TICKET_DIR/resolutions.jsonl" > "$D/resolutions-absent-after-refusal.txt" 2>&1 || true
hash_of "$json1" > "$D/run-json-after-refusal.sha256"

# operator requests stop, waits for the process to end, then queries again
kill "$check_pid" 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$check_pid" 2>/dev/null || break; sleep 0.2; done
{
  echo "# host process query after operator stop request at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "\$ ps -o pid=,command= -p $check_pid"
  ps -o pid=,command= -p "$check_pid" || echo "ps exit=$? (no process with the recorded pid $check_pid)"
  echo "\$ ps -o pid=,user=,command= -p 33924"
  ps -o pid=,user=,command= -p 33924
} > "$D/host-query-terminal.txt" 2>&1
capture "$D/attempt2-recovery" node "$CLI" resolve --ticket "$TICKET" --run "$run_still_running" \
  --basis host-terminal --status terminated --host-query-file "$D/host-query-terminal.txt" \
  --operator t11-recovery-operator --state-dir "$STATE" --operator-config "$OPCFG"
cp "$TICKET_DIR/resolutions.jsonl" "$D/resolutions.jsonl"
hash_of "$json1" > "$D/run-json-after-recovery.sha256"
python3 -c "import json;d=json.load(open('$json1'));print(json.dumps({'status':d['status'],'exitCode':d['exitCode'],'finishedAt':d.get('finishedAt')},ensure_ascii=False))" > "$D/record-status-after-recovery.json"
# idempotent repeat
cp "$TICKET_DIR/resolutions.jsonl" "$D/resolutions-before-repeat.jsonl"
capture "$D/attempt3-idempotent-repeat" node "$CLI" resolve --ticket "$TICKET" --run "$run_still_running" \
  --basis host-terminal --status terminated --host-query-file "$D/host-query-terminal.txt" \
  --operator t11-recovery-operator --state-dir "$STATE" --operator-config "$OPCFG"
cp "$TICKET_DIR/resolutions.jsonl" "$D/resolutions-after-repeat.jsonl"

# =========================================================================
# ② 查询不可用：host query unavailable -> explicit risk acceptance required
# =========================================================================
D=$R/02-query-unavailable; mkdir -p "$D"
json2=$(run_json "$run_unavailable")
hash_of "$json2" > "$D/run-json-before.sha256"
# a real failed host query against a closed local port
{ echo "\$ curl -sS --max-time 3 http://127.0.0.1:65000/"; } > "$D/host-query-unavailable.txt"
curl -sS --max-time 3 http://127.0.0.1:65000/ > "$D/curl.stdout" 2> "$D/curl.stderr"
echo $? > "$D/curl.exit-code"
{
  echo "host query command: curl -sS --max-time 3 http://127.0.0.1:65000/"
  echo "host query exit: $(cat "$D/curl.exit-code")"
  echo "host query stderr: $(cat "$D/curl.stderr")"
  echo "conclusion: host Job/process query unavailable (connection refused)"
} >> "$D/host-query-unavailable.txt"
capture "$D/attempt1-refused-no-risk-acceptance" node "$CLI" resolve --ticket "$TICKET" --run "$run_unavailable" \
  --basis operator-risk-accepted --status unavailable --host-query-file "$D/host-query-unavailable.txt" \
  --operator t11-recovery-operator --state-dir "$STATE" --operator-config "$OPCFG"
capture "$D/attempt2-refused-wrong-basis" node "$CLI" resolve --ticket "$TICKET" --run "$run_unavailable" \
  --basis host-terminal --status unavailable --host-query-file "$D/host-query-unavailable.txt" \
  --operator t11-recovery-operator --state-dir "$STATE" --operator-config "$OPCFG"
capture "$D/attempt3-recovery-risk-accepted" node "$CLI" resolve --ticket "$TICKET" --run "$run_unavailable" \
  --basis operator-risk-accepted --status unavailable --accept-risk --host-query-file "$D/host-query-unavailable.txt" \
  --operator t11-recovery-operator --state-dir "$STATE" --operator-config "$OPCFG"
cp "$TICKET_DIR/resolutions.jsonl" "$D/resolutions.jsonl"
hash_of "$json2" > "$D/run-json-after-recovery.sha256"
python3 -c "import json;d=json.load(open('$json2'));print(json.dumps({'status':d['status'],'exitCode':d['exitCode'],'finishedAt':d.get('finishedAt')},ensure_ascii=False))" > "$D/record-status-after-recovery.json"

# =========================================================================
# ③ 已结束但结果丢失：host confirms end, output/exit code lost -> allowed,
#    but the execution can never become passing evidence
# =========================================================================
D=$R/03-result-lost; mkdir -p "$D"
json3=$(run_json "$run_result_lost")
hash_of "$json3" > "$D/run-json-before.sha256"
echo "hephi-t11-acceptance-33333333" > "$D/process-marker.txt"
{
  echo "# host process query at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "\$ ps -o pid=,user=,command= -p 33924"
  ps -o pid=,user=,command= -p 33924
  echo "\$ scan ps -ax for the recorded inner call marker"
  scan_absent "$D/process-scan.txt" "$D/process-marker.txt"
  cat "$D/process-scan.txt"
  echo "\$ ls -l $TICKET_DIR/checks/$run_result_lost"
  ls -l "$TICKET_DIR/checks/$run_result_lost"
} > "$D/host-query-confirmed-ended.txt" 2>&1
cp "$D/process-scan.txt" "$D/process-scan-copy.txt"
capture "$D/attempt1-recovery" node "$CLI" resolve --ticket "$TICKET" --run "$run_result_lost" \
  --basis host-terminal --status terminated --host-query-file "$D/host-query-confirmed-ended.txt" \
  --operator t11-recovery-operator --state-dir "$STATE" --operator-config "$OPCFG"
cp "$TICKET_DIR/resolutions.jsonl" "$D/resolutions.jsonl"
hash_of "$json3" > "$D/run-json-after-recovery.sha256"
ls -l "$TICKET_DIR/checks/$run_result_lost" > "$D/run-dir-after-recovery.txt" 2>&1 || true
python3 -c "import json;d=json.load(open('$json3'));print(json.dumps({'status':d['status'],'exitCode':d['exitCode'],'hasOutputLog':False,'cannotBePassEvidence':d['status']!='passed' and d['exitCode']!=0},ensure_ascii=False))" > "$D/record-status-after-recovery.json"

# =========================================================================
# ④ 遗留 running：host crashed, running record left behind; confirm no process
#    then treat as ended with unknown result
# =========================================================================
D=$R/04-leftover-running; mkdir -p "$D"
json4=$(run_json "$run_leftover")
hash_of "$json4" > "$D/run-json-before.sha256"
echo "hephi-t11-acceptance-44444444" > "$D/process-marker.txt"
{
  echo "# host process query at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "\$ ps -o pid=,user=,command= -p 33924"
  ps -o pid=,user=,command= -p 33924
  echo "\$ scan ps -ax for the recorded inner call marker"
  scan_absent "$D/process-scan.txt" "$D/process-marker.txt"
  cat "$D/process-scan.txt"
} > "$D/host-query-leftover.txt" 2>&1
cp "$D/process-scan.txt" "$D/process-scan-copy.txt"
: > "$D/no-host-query.txt"
capture "$D/attempt1-refused-no-host-query" node "$CLI" resolve --ticket "$TICKET" --run "$run_leftover" \
  --basis host-terminal --status terminated --host-query-file "$D/no-host-query.txt" \
  --operator t11-recovery-operator --state-dir "$STATE" --operator-config "$OPCFG"
capture "$D/attempt2-refused-status-running" node "$CLI" resolve --ticket "$TICKET" --run "$run_leftover" \
  --basis host-terminal --status running --host-query-file "$D/host-query-leftover.txt" \
  --operator t11-recovery-operator --state-dir "$STATE" --operator-config "$OPCFG"
capture "$D/attempt3-recovery" node "$CLI" resolve --ticket "$TICKET" --run "$run_leftover" \
  --basis host-terminal --status terminated --host-query-file "$D/host-query-leftover.txt" \
  --operator t11-recovery-operator --state-dir "$STATE" --operator-config "$OPCFG"
cp "$TICKET_DIR/resolutions.jsonl" "$D/resolutions.jsonl"
cp "$TICKET_DIR/resolutions.jsonl" "$D/resolutions-before-repeat.jsonl"
capture "$D/attempt4-idempotent-repeat" node "$CLI" resolve --ticket "$TICKET" --run "$run_leftover" \
  --basis host-terminal --status terminated --host-query-file "$D/host-query-leftover.txt" \
  --operator t11-recovery-operator --state-dir "$STATE" --operator-config "$OPCFG"
cp "$TICKET_DIR/resolutions.jsonl" "$D/resolutions-after-repeat.jsonl"
hash_of "$json4" > "$D/run-json-after-recovery.sha256"
python3 -c "import json;d=json.load(open('$json4'));print(json.dumps({'status':d['status'],'exitCode':d['exitCode'],'finishedAt':d.get('finishedAt')},ensure_ascii=False))" > "$D/record-status-after-recovery.json"

# =========================================================================
# ⑤ Operator gate evidence: no config -> disabled; bad mode -> rejected;
#    environment variable is not an enable channel
# =========================================================================
D=$R/05-operator-gate; mkdir -p "$D"
cp "$OPCFG" "$D/operator-config-0644.json"; chmod 0644 "$D/operator-config-0644.json"
{
  echo "# operator config used by all successful attempts"
  ls -l "$OPCFG"; cat "$OPCFG"
  echo "# copied config used for the negative case (wrong mode)"
  ls -l "$D/operator-config-0644.json"
} > "$D/operator-config-facts.txt" 2>&1
capture "$D/attempt1-refused-no-config" node "$CLI" resolve --ticket "$TICKET" --run "$run_result_lost" \
  --basis host-terminal --status terminated --host-query-file "$R/03-result-lost/host-query-confirmed-ended.txt" \
  --operator t11-recovery-operator --state-dir "$STATE"
capture "$D/attempt2-refused-group-readable-config" node "$CLI" resolve --ticket "$TICKET" --run "$run_result_lost" \
  --basis host-terminal --status terminated --host-query-file "$R/03-result-lost/host-query-confirmed-ended.txt" \
  --operator t11-recovery-operator --state-dir "$STATE" --operator-config "$D/operator-config-0644.json"
( export HEPHI_ALLOW_OPERATOR_RESOLUTIONS=1; capture "$D/attempt3-refused-env-only" node "$CLI" resolve --ticket "$TICKET" --run "$run_result_lost" \
  --basis host-terminal --status terminated --host-query-file "$R/03-result-lost/host-query-confirmed-ended.txt" \
  --operator t11-recovery-operator --state-dir "$STATE" )

# =========================================================================
# ⑥ Real state untouched + final state-dir snapshot
# =========================================================================
D=$R/06-real-state-untouched; mkdir -p "$D"
find "$REAL_STATE" -type f | sort | while read -r f; do printf '%s  %s\n' "$(hash_of "$f")" "${f#$REAL_STATE/}"; done > "$D/real-state-after.txt"
if diff -q "$R/00-host-facts/real-state-before.txt" "$D/real-state-after.txt" > /dev/null; then
  echo "PASS: real 3085 ticket state files unchanged (before == after)" > "$D/real-state-diff.txt"
else
  echo "FAIL: real 3085 ticket state changed during the runs" > "$D/real-state-diff.txt"
  diff "$R/00-host-facts/real-state-before.txt" "$D/real-state-after.txt" >> "$D/real-state-diff.txt" 2>&1 || true
fi
ls -l "$REAL_STATE/resolutions.jsonl" > "$D/real-resolutions-absent.txt" 2>&1 || true
find "$TICKET_DIR" -type f | sort | while read -r f; do printf '%s  %s\n' "$(hash_of "$f")" "${f#$TICKET_DIR/}"; done > "$D/temp-state-final.txt"

echo "DONE root=$ROOT"
