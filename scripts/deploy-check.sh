#!/bin/bash
# T03 部署前状态检查（只读；不改任何宿主状态）
# 五项检查，每项输出 PASS/FAIL 与一行依据；任一 FAIL 则整体退出码 1。
# 说明：本脚本只读文件/接口，不触发部署、不修改配置。
set -u

EXPERIMENT="${EXPERIMENT_ROOT:-/Users/zm/dsh-instances/experiment}"
SUPERAGENT="$EXPERIMENT/superagent"
DELIVERY="$SUPERAGENT/prompts/team/delivery.md"
TICKETS_BASE="${TICKETS_BASE:-http://127.0.0.1:3083}"
CURL_MAX=5
fails=0

pass() { printf '[%s] %s: PASS\n' "$1" "$2"; printf '      basis: %s\n' "$3"; }
fail() { printf '[%s] %s: FAIL\n' "$1" "$2"; printf '      basis: %s\n' "$3"; fails=$((fails + 1)); }

# ---- 1) 当前生效 delivery 提示与 revision --------------------------------
check1() {
  local basis rev sha size
  if [ ! -r "$DELIVERY" ]; then
    fail "1/5" "delivery prompt & revision" "delivery.md 不可读: $DELIVERY"
    return
  fi
  size=$(wc -c < "$DELIVERY" | tr -d ' ')
  sha=$(shasum -a 256 "$DELIVERY" 2>/dev/null | awk '{print $1}')
  rev=$(git -C "$SUPERAGENT" log -1 --format=%H -- prompts/team/delivery.md 2>/dev/null)
  if [ -n "$rev" ] && printf '%s' "$rev" | grep -Eq '^[0-9a-f]{40}$'; then
    pass "1/5" "delivery prompt & revision" "delivery.md bytes=$size sha256=$sha revision=$rev (git -C superagent log -1 -- prompts/team/delivery.md)"
  else
    fail "1/5" "delivery prompt & revision" "delivery.md 可读(bytes=$size) 但 git revision 取不到或非 40-hex: '${rev}'"
  fi
}

# ---- 2) 提示未配置 merge CLI（auto-merge 启用语义） ----------------------
# 判别规则（从简）：
#   a) 只看含 "auto-merge"/"auto merge"/"merge CLI" 的行；
#   b) 纯撤回说明（只出现 --disable-auto 的行）不算启用；
#   c) “启用”要求出现具体 merge CLI 的命令（如 `gh pr merge ... --auto`），
#      占位符 `<merge CLI>` 不算具体命令；文件明确写 "names no merge CLI" 时视为未配置。
check2() {
  local basis concrete disable draft
  if [ ! -r "$DELIVERY" ]; then
    fail "2/5" "no merge CLI configured for auto-merge" "delivery.md 不可读: $DELIVERY"; return
  fi
  concrete=$(grep -nE '`[A-Za-z0-9_.-]+ (pr|mr) merge[^`]*--auto' "$DELIVERY" 2>/dev/null \
             | grep -v '<merge CLI>' || true)
  disable=$(grep -c -- '--disable-auto' "$DELIVERY" 2>/dev/null || true)
  draft=$(grep -nE 'names no merge CLI|merge CLI this section names' "$DELIVERY" 2>/dev/null | head -2 || true)
  if [ -n "$concrete" ]; then
    fail "2/5" "no merge CLI configured for auto-merge" "发现具体 CLI 的 auto-merge 启用命令: $(printf '%s' "$concrete" | head -2 | tr '\n' ';')"
  else
    basis="未发现具体 merge CLI 的 --auto 启用命令"
    [ -n "$draft" ] && basis="${basis}；文件声明: $(printf '%s' "$draft" | head -1 | cut -c1-80)"
    basis="${basis}；--disable-auto 出现 ${disable:-0} 次（仅撤回说明，不计启用）；占位符 <merge CLI> 不算已配置"
    pass "2/5" "no merge CLI configured for auto-merge" "$basis"
  fi
}

# ---- 3) 无运行/等待/blocked/待修复 HEPHI 工单 ---------------------------
# 路径探测顺序：/api/、/api/status、/api/tickets、/orchestrator/api/tickets
# （实测 /api/* 返回 401，orchestrator 命名空间可用；脚本记录实际使用路径）。
check3() {
  local probe last_code last_exit path body total active sample basis
  local -a probes=( "/api/" "/api/status" "/api/tickets" "/orchestrator/api/tickets" )
  last_code=""; last_exit=""; path=""
  for p in "${probes[@]}"; do
    body=$(curl -s -m "$CURL_MAX" -o /tmp/deploy-check-tickets.$$ -w '%{http_code}' \
             -H 'x-orchestrator-request: 1' "${TICKETS_BASE}${p}" 2>/dev/null)
    last_exit=$?
    last_code="$body"
    if [ "$last_exit" -eq 0 ] && [ "$body" = "200" ]; then path="$p"; break; fi
  done
  if [ -z "$path" ]; then
    fail "3/5" "no running/waiting/blocked HEPHI tickets" "FAIL:unreachable 探测 /api/、/api/status、/api/tickets、/orchestrator/api/tickets 均非 200（最后 http=$last_code, curl_exit=${last_exit}，base=${TICKETS_BASE}；未猜测）"
    rm -f /tmp/deploy-check-tickets.$$
    return
  fi
  total=$(node -e 'try{const fs=require("fs");const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log(Array.isArray(d)?d.length:(Array.isArray(d.items)?d.items.length:0))}catch(e){console.log("ERR")}' /tmp/deploy-check-tickets.$$ 2>/dev/null || echo ERR)
  if [ "$total" = "ERR" ]; then
    fail "3/5" "no running/waiting/blocked HEPHI tickets" "endpoint http=200 path=$path 但 JSON 解析失败"
    rm -f /tmp/deploy-check-tickets.$$; return
  fi
  active=$(node -e '
    const fs=require("fs");const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const items=Array.isArray(d)?d:Array.isArray(d.items)?d.items:[];
    const terminalStage=new Set(["done","closed","merged","ended","cancelled","canceled"]);
    const terminalState=new Set(["closed","done","merged","cancelled","canceled"]);
    const act=items.filter(t=>{
      const st=(t.state||"").toLowerCase(); const sg=(t.stage||"").toLowerCase();
      const rep=((t.assignments&&t.assignments.length?t.assignments[t.assignments.length-1].report:null)||{}).state||"";
      if(terminalState.has(st)) return false;
      if(terminalStage.has(sg)) return false;
      return true; // open/person/running/waiting/blocked/待修复均计为未决
    });
    console.log(act.length);
    if(act.length) console.error(act.slice(0,3).map(t=>`${t.id||"?"}:${t.stage||"?"}/${t.state||"?"} ${(t.title||"").slice(0,40)}`).join(" | "));
  ' /tmp/deploy-check-tickets.$$ 2>/tmp/deploy-check-tickets.$$.detail || echo ERR)
  sample=$(cat /tmp/deploy-check-tickets.$$.detail 2>/dev/null | head -1)
  if [ "$active" = "ERR" ]; then
    fail "3/5" "no running/waiting/blocked HEPHI tickets" "endpoint http=200 path=$path 但工单分类失败"
  elif [ "$active" = "0" ]; then
    pass "3/5" "no running/waiting/blocked HEPHI tickets" "endpoint=$path total=$total active=0（terminal 状态已排除）"
  else
    fail "3/5" "no running/waiting/blocked HEPHI tickets" "endpoint=$path total=$total active=${active}（stage=open/person 等未决均计入；样例: ${sample:-n/a}）"
  fi
  rm -f /tmp/deploy-check-tickets.$$ /tmp/deploy-check-tickets.$$.detail
}

# ---- 4) 项目配置无审批人 ------------------------------------------------
check4() {
  local files hits n
  files=$(find "$EXPERIMENT/project-config" -maxdepth 1 -name '*.json' -type f 2>/dev/null | sort)
  n=$(printf '%s\n' "$files" | grep -c . || true)
  if [ "$n" -eq 0 ]; then
    fail "4/5" "no approvers in project config" "未找到 $EXPERIMENT/project-config/*.json（无法确认）"; return
  fi
  hits=$(grep -nH '"approvers"' $files 2>/dev/null || true)
  if [ -n "$hits" ]; then
    fail "4/5" "no approvers in project config" "发现 approvers 配置: $(printf '%s' "$hits" | head -3 | tr '\n' ';')"
  else
    pass "4/5" "no approvers in project config" "扫描 $n 个 project-config/*.json，无 \"approvers\" 键（files=$(printf '%s' "$files" | xargs -n1 basename | tr '\n' ',' | sed 's/,$//')）"
  fi
}

# ---- 5) 实载版本 = 最新部署记录 ----------------------------------------
# 指定路径 /experiment/hephi/lib（本机实际布局中不存在时，按只读探测到的部署根
# /experiment/hephi-review/hephi/lib 回退；依据中明确写出所用路径与回退事实）。
check5() {
  local lib link commit meta meta_commit logf log_commit basis
  local -a libs=( "$EXPERIMENT/hephi/lib" "$EXPERIMENT/hephi-review/hephi/lib" )
  lib=""
  for cand in "${libs[@]}"; do
    if [ -L "$cand" ] || [ -d "$cand" ]; then lib="$cand"; break; fi
  done
  if [ -z "$lib" ]; then
    fail "5/5" "loaded release equals deploy record" "找不到 hephi lib（尝试: ${libs[*]}）；无法读取实载版本"; return
  fi
  link=$(readlink "$lib" 2>/dev/null)
  if [ -z "$link" ]; then
    fail "5/5" "loaded release equals deploy record" "$lib 不是符号链接（readlink 为空），无法确认实载 revision"; return
  fi
  commit=$(basename "$(dirname "$link")")
  meta="$EXPERIMENT/releases/hephi/$commit/meta.json"
  if [ ! -r "$meta" ]; then
    fail "5/5" "loaded release equals deploy record" "lib=$lib -> ${link}；对应 meta 不可读: $meta"; return
  fi
  meta_commit=$(node -e 'try{const m=require(process.argv[1]);console.log(m.pluginCommit||m.commit||"")}catch(e){console.log("")}' "$meta" 2>/dev/null)
  logf=$(ls -t "$EXPERIMENT"/logs/deploy-*.json 2>/dev/null | head -1)
  if [ -z "$logf" ]; then
    fail "5/5" "loaded release equals deploy record" "lib=$lib commit=${commit}；未找到 $EXPERIMENT/logs/deploy-*.json 部署记录"; return
  fi
  log_commit=$(node -e 'try{const d=require(process.argv[1]);console.log(d.target||d.commit||d.targetCommit||"")}catch(e){console.log("")}' "$logf" 2>/dev/null)
  basis="lib=${lib} -> ${link}; meta.commit=${meta_commit:-missing} (${meta})"
  [ "$lib" != "$EXPERIMENT/hephi/lib" ] && basis="$basis; 指定路径 $EXPERIMENT/hephi/lib 不存在，使用只读探测到的部署布局"
  basis="$basis; 最新 deploy=$(basename "$logf") commit=${log_commit:-missing}"
  if [ -z "$meta_commit" ] || [ -z "$log_commit" ]; then
    fail "5/5" "loaded release equals deploy record" "$basis"
  elif [ "$meta_commit" = "$log_commit" ] && [ "$meta_commit" = "$commit" ]; then
    pass "5/5" "loaded release equals deploy record" "$basis; 三者一致"
  else
    fail "5/5" "loaded release equals deploy record" "$basis; 不一致（loaded=$commit/ meta=$meta_commit / deploy=${log_commit}）"
  fi
}

echo "deploy-check: T03 部署前状态检查（只读） $(date '+%Y-%m-%dT%H:%M:%S%z')"
echo "host=$TICKETS_BASE experiment=$EXPERIMENT"
check1
check2
check3
check4
check5
echo "-----"
if [ "$fails" -eq 0 ]; then
  echo "RESULT: PASS (5/5)"
  exit 0
else
  echo "RESULT: FAIL (${fails}/5 checks failed)"
  exit 1
fi
