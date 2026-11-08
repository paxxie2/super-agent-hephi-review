#!/bin/sh
# P8 部署：不可变构建发布、原子切换、全健康门禁、失败自动回滚、显式实载边界。
#
# 不变量（实现与 test-deploy-hephi.mjs 共同验证）：
# 1. releases/<fullSHA>/ 发布成功后其 lib/ 与 meta.json 永不改写；同 SHA 再发布必须失败。
# 2. 构建在独立临时目录（git archive 干净源码）完成，绝不在实载 $hephi/lib 上构建。
# 3. 实载切换只使用已发布且校验通过的 release；校验失败不得停止当前宿主。
# 4. 切换后的重启或健康失败自动恢复 previous，并再次执行全量健康检查。
# 5. 回滚也失败时保持 paused=true、非零退出、保留现场与两次健康证据，不接新任务。
# 6. 有进行中 Ticket、drain 字段未知或非零时禁止升级；不存在绕过入口。
# 7. 成功退出也不自动恢复派发；由操作者核对后手动恢复。
# 8. 文件哈希只证明磁盘内容，不等于实载 commit；无实载回读入口时 P8 真实验收保持未通过。
# 9. 首次从普通 lib 目录迁移是显式事务：先原子改名旧目录，再改名 symlink；第二步失败必须恢复旧目录。
# 10. 记录中的 paused／load／health 必须来自部署结束时的真实回读；不可读记为 unverified，不得硬编码 true。
# 11. rollback 只接受显式 --target（及显式 --previous），不得隐式取仓库 HEAD；恢复目标必须通过校验。
# 12. 发布包包含同一冻结 lockfile 的生产依赖；peer 只通过显式 --peer-root 链接到宿主提供方，
#     发布前用 --node（宿主 Node）在目标 release 路径实际导入 index/tools，失败发生在停机前。
# 13. 两个 bundle entry 注册后各写一行 [hephi-activation]（含 pluginCommit 与 process.pid）；
#     部署只认本次启动日志偏移之后、新 host.pid、目标 SHA 的两条标识。
# 14. 健康 10 项 ready 但缺少任一激活标识必须失败并走现有恢复/回滚；meta v2 必须完整
#     （entries/dependencies/activation），正向部署绝不接受任何 v1；历史 v1 只在显式
#     --allow-legacy-rollback 的回滚/恢复目标上接受：三段齐全的旧产物仍按完整字段校验
#     并要求 required 双入口激活，三段全无的纯 legacy 才按 health-only 记录 unverified-legacy；
#     部分残缺的 v1 一律拒绝。
#
# 用法：deploy-hephi.sh --instance <dir> --host <url> --host-version <单行值>
#        [--target <40sha>] [--previous <40sha>] [--rollback] [--dry-run]
#        [--allow-legacy-rollback]
#        [--releases <dir>] [--repo <dir>] [--hephi <dir>] [--timeout <秒>]
#        [--drain effects] [--effects-db <path>] --stop-command <command>
#        [--stop-timeout <秒>] [--auto-restart-wait <秒>] [--process-file <path>]
#        [--node <宿主 Node 路径>] [--peer-root <宿主 peer 根目录>]
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
effects_tool="$script_dir/check-effects-db.mjs"
release_tool="$script_dir/release-meta.mjs"

usage() {
  cat >&2 <<'USAGE'
usage: deploy-hephi.sh --instance <dir> --host <url> --host-version <single-line value>
       [--target <40sha>] [--previous <40sha>] [--rollback] [--dry-run]
       [--allow-legacy-rollback]
       [--releases <dir>] [--repo <dir>] [--hephi <dir>] [--timeout <seconds>]
       [--drain effects] [--effects-db <path>] --stop-command <command>
       [--stop-timeout <seconds>] [--auto-restart-wait <seconds>] [--process-file <path>]
       [--node <host Node path>] [--peer-root <host peer package root>]
USAGE
  exit 2
}

instance=""; host=""; host_version=""; target=""; previous=""; rollback="no"; dry_run="no"
target_set="no"; previous_set="no"
allow_legacy_rollback="no"; LEGACY_ACTIVATION="no"
releases=""; repo=""; hephi=""; timeout=120
drain_mode=""; effects_db=""; stop_command=""; stop_timeout=""; auto_restart_wait=""; process_file=""
node_cmd=""; peer_root=""; instance_pattern_input=""
while [ $# -gt 0 ]; do
  case "$1" in
    --instance) [ $# -ge 2 ] || usage; instance="$2"; shift 2 ;;
    --host) [ $# -ge 2 ] || usage; host="$2"; shift 2 ;;
    --host-version) [ $# -ge 2 ] || usage; host_version="$2"; shift 2 ;;
    --target) [ $# -ge 2 ] || usage; target="$2"; target_set="yes"; shift 2 ;;
    --previous) [ $# -ge 2 ] || usage; previous="$2"; previous_set="yes"; shift 2 ;;
    --rollback) rollback="yes"; shift ;;
    --dry-run) dry_run="yes"; shift ;;
    --allow-legacy-rollback) allow_legacy_rollback="yes"; shift ;;
    --releases) [ $# -ge 2 ] || usage; releases="$2"; shift 2 ;;
    --repo) [ $# -ge 2 ] || usage; repo="$2"; shift 2 ;;
    --hephi) [ $# -ge 2 ] || usage; hephi="$2"; shift 2 ;;
    --timeout) [ $# -ge 2 ] || usage; timeout="$2"; shift 2 ;;
    --drain) [ $# -ge 2 ] || usage; drain_mode="$2"; shift 2 ;;
    --effects-db) [ $# -ge 2 ] || usage; effects_db="$2"; shift 2 ;;
    --stop-command) [ $# -ge 2 ] || usage; stop_command="$2"; shift 2 ;;
    --stop-timeout) [ $# -ge 2 ] || usage; stop_timeout="$2"; shift 2 ;;
    --auto-restart-wait) [ $# -ge 2 ] || usage; auto_restart_wait="$2"; shift 2 ;;
    --process-file) [ $# -ge 2 ] || usage; process_file="$2"; shift 2 ;;
    --node) [ $# -ge 2 ] || usage; node_cmd="$2"; shift 2 ;;
    --skip-tests) skip_tests="yes"; shift ;;
    --peer-root) [ $# -ge 2 ] || usage; peer_root="$2"; shift 2 ;;
    --instance-pattern) [ $# -ge 2 ] || usage; instance_pattern_input="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[ -n "$instance" ] && [ -n "$host" ] && [ -n "$host_version" ] || usage
[ -n "$node_cmd" ] || node_cmd=node
if [ -n "$peer_root" ]; then
  [ -d "$peer_root" ] || { echo "peer root is not a directory: $peer_root" >&2; exit 2; }
  peer_root=$(CDPATH= cd -- "$peer_root" && pwd)
fi
[ -f "$release_tool" ] || { echo "release tooling not found: $release_tool" >&2; exit 2; }
node_version=$("$node_cmd" -v 2>/dev/null) || { echo "host Node is not runnable: $node_cmd" >&2; exit 2; }
IMPORT_PROBE="not-run"; ACTIVATION_MODE="unverified"; ACTIVATION_EVIDENCE="not-checked"
lines=$(printf '%s\n' "$host_version" | wc -l | tr -d ' ')
[ "$lines" -eq 1 ] || { echo "host version must be a single-line value" >&2; exit 2; }
printf '%s' "$host_version" | grep -qE '^[[:print:]]+$' || { echo "host version must be a non-empty printable value" >&2; exit 2; }
[ -d "$instance" ] || { echo "instance directory not found: $instance" >&2; exit 2; }
[ -n "$hephi" ] || hephi="$instance/hephi"
[ -n "$repo" ] || repo="$instance"
[ -n "$releases" ] || releases="$instance/releases/hephi"
# --hephi 必须指向“实载插件目录”（含 package.json 与 lib 指针），不是部署脚本猜的默认目录。
# 该检查必须在任何 pause/stop/build 之前：默认值指错时直接 exit 2，避免进入停机流程后
# 才发现 pointerBefore/current 为空、切换无效、回滚无目标（S3 实战失败根因）。
hephi_hint() {
  echo "hint: pass --hephi <loaded plugin directory> (the directory containing package.json and the lib pointer; e.g. <instance>/hephi-review/hephi); the default <instance>/hephi is only correct when the plugin is loaded there" >&2
  echo "hint: for a profile layout try <instance>/node_modules/hephi-superagent-plugin or the profile's node_modules path" >&2
}
if [ ! -d "$hephi" ]; then
  echo "plugin directory not found: $hephi" >&2
  hephi_hint
  exit 2
fi
if [ ! -f "$hephi/package.json" ]; then
  echo "plugin directory has no package.json: $hephi" >&2
  hephi_hint
  exit 2
fi
plugin_pkg_name=$("$node_cmd" -e 'const fs=require("fs");try{const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(typeof p.name==="string"?p.name:"")}catch{process.exit(1)}' "$hephi/package.json" 2>/dev/null) || plugin_pkg_name=""
if [ "$plugin_pkg_name" != "hephi-superagent-plugin" ]; then
  echo "plugin directory is not hephi-superagent-plugin: $hephi (package.json name=${plugin_pkg_name:-<unreadable>})" >&2
  hephi_hint
  exit 2
fi
[ -d "$repo/.git" ] || [ -f "$repo/.git" ] || { echo "not a git repository: $repo" >&2; exit 2; }
[ -f "$instance/host.pid" ] || { echo "missing host.pid: $instance/host.pid" >&2; exit 2; }
host=${host%/}

# §4.5 single-instance matching: only host entry processes (start.sh/bin.js) of this
# instance count. The default is the instance's absolute path as a literal regex; an
# operator-provided --instance-pattern is validated before anything is read or switched.
instance_abs=$(CDPATH= cd -- "$instance" && pwd)
if [ -n "$instance_pattern_input" ]; then
  if ! node -e 'try { new RegExp(process.argv[1]); } catch (error) { process.exit(1) }' "$instance_pattern_input" 2>/dev/null; then
    echo "invalid --instance-pattern regular expression: $instance_pattern_input" >&2
    exit 2
  fi
  instance_pattern="$instance_pattern_input"
else
  instance_pattern=$(node -e 'process.stdout.write(process.argv[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))' "$instance_abs")
fi

# §4.5 停机式排空模式：与默认的 API 字段排空模式互斥，且不能用于 rollback。
if [ -n "$drain_mode" ] && [ "$drain_mode" != "effects" ]; then
  echo "unknown --drain mode: $drain_mode (only effects is supported)" >&2; exit 2
fi
if [ "$drain_mode" = "effects" ] && [ "$rollback" = "yes" ]; then
  echo "--drain effects cannot be combined with --rollback" >&2; exit 2
fi
if [ "$drain_mode" = "effects" ]; then
  [ -n "$effects_db" ] || effects_db="$instance/state/orchestrator.sqlite"
  [ -n "$stop_timeout" ] || stop_timeout="$timeout"
  case "$stop_timeout" in ''|*[!0-9]*) echo "--stop-timeout must be a positive integer" >&2; exit 2 ;; esac
  [ "$stop_timeout" -gt 0 ] || { echo "--stop-timeout must be a positive integer" >&2; exit 2; }
  # 停机必须由宿主自己的 stop 脚本完成：默认 SIGINT 路径未经真实宿主验证，已删除（fail-closed）。
  [ -n "$stop_command" ] || {
    echo "--drain effects requires --stop-command <command> (for example the host's dsh-superagent stop invocation); the unverified default SIGINT path was removed" >&2
    exit 2
  }
  # 自动重启检测窗口：默认 10s（≥H0 观测的 5s），可用 --auto-restart-wait 缩短（测试）或调整。
  [ -n "$auto_restart_wait" ] || auto_restart_wait=10
  case "$auto_restart_wait" in ''|*[!0-9]*) echo "--auto-restart-wait must be a positive integer" >&2; exit 2 ;; esac
  [ "$auto_restart_wait" -gt 0 ] || { echo "--auto-restart-wait must be a positive integer" >&2; exit 2; }
  [ -f "$effects_tool" ] || { echo "effects checker not found: $effects_tool" >&2; exit 2; }
fi
release_sha() { printf '%s' "$1" | sed -n 's#.*/\([0-9a-f]\{40\}\)/lib$#\1#p'; }
is_sha() { printf '%s' "$1" | grep -qE '^[0-9a-f]{40}$'; }
sha256_file() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

read_state() { curl -fsS -H 'x-orchestrator-request: 1' "$host/orchestrator/api/state"; }
read_load() {
  printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(JSON.stringify({paused:j.paused,load:j.load??{},health:j.health??{}}))})'
}

# 全量健康：任一必要服务缺失、starting 或 error 都失败。
health_ok() {
  printf '%s' "$1" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const j=JSON.parse(s); const required=["runtime","relay","notice","launch","delivery","assessment","reply","evals","models","github"];
      const problems=[]; for(const name of required){const h=j.health&&j.health[name]; if(!h||h.state!=="ready")problems.push(name+"="+((h&&h.state)||"missing"));}
      if(problems.length){console.error("unhealthy: "+problems.join(", "));process.exit(1);}
    })' >&2
}

# 排空：known 字段须为 0；未知/缺失字段记为 unverified 并拒绝升级。
drain_ok() {
  printf '%s' "$1" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const j=JSON.parse(s); const load=j.load??{};
      const required=["running","queued"];
      const optional=["startupReservations","effects","jobs","subagents","unknown"];
      const problems=[];
      for(const name of required){ if(!Number.isInteger(load[name])) problems.push("unverified drain field: "+name); else if(load[name]!==0) problems.push("drain field "+name+"="+load[name]); }
      for(const name of optional){ if(load[name]===undefined) problems.push("unverified drain field: "+name); else if(load[name]!==0) problems.push("drain field "+name+"="+load[name]); }
      if(problems.length){console.error(problems.join("; "));process.exit(1);}
    })' >&2
}

open_tickets() {
  curl -fsS -H 'x-orchestrator-request: 1' "$host/orchestrator/api/tickets?state=open&limit=1000" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const list=Array.isArray(j)?j:(j.tickets??j.items??[]);process.stdout.write(String(list.length))})'
}

# 显式 legacy 授权只作用于回滚/恢复目标；调用方从不把该标记用于正向 target。
release_check_tool() {
  rc_allow_legacy="$1"; shift
  if [ "$rc_allow_legacy" = "yes" ]; then
    node "$release_tool" check "$@" --allow-legacy-rollback
  else
    node "$release_tool" check "$@"
  fi
}

release_validate() {
  rv_dir="$1"; rv_expected="${2:-}"; rv_allow_legacy="${3:-no}"
  [ -d "$rv_dir/lib" ] || { echo "release lib missing: $rv_dir/lib" >&2; return 1; }
  [ -f "$rv_dir/meta.json" ] || { echo "release meta missing: $rv_dir/meta.json" >&2; return 1; }
  if [ -z "$rv_expected" ]; then
    rv_expected=$(basename "$rv_dir")
    is_sha "$rv_expected" || { echo "release directory is not a full SHA: $rv_expected" >&2; return 1; }
  fi
  is_sha "$rv_expected" || { echo "expected release SHA is invalid: $rv_expected" >&2; return 1; }
  rv_err="$releases/.release-check-$$-$rv_expected.err"
  release_check_tool "$rv_allow_legacy" --release "$rv_dir" --sha "$rv_expected" >/dev/null 2>"$rv_err" || {
    cat "$rv_err" >&2
    rm -f "$rv_err"
    return 1
  }
  rm -f "$rv_err"
}

# previous/current 只是恢复目标：允许 legacy（formatVersion 1）自动通过校验，不需要操作者
# 额外传 --allow-legacy-rollback；恢复启动时按 health-only 如实记录 unverified-legacy。
# 正向 target 仍必须 v2 完整，绝不走这个 helper（target 校验见调用点）。
# 设置全局 PREVIOUS_LEGACY=yes/no。
PREVIOUS_LEGACY="no"; PREVIOUS_LEGACY_JSON="false"
validate_previous_target() {
  vp_sha="$1"
  PREVIOUS_LEGACY="no"; PREVIOUS_LEGACY_JSON="false"
  [ -n "$vp_sha" ] || return 0
  if release_validate "$releases/$vp_sha" "$vp_sha" >/dev/null 2>&1; then
    return 0
  fi
  if release_validate "$releases/$vp_sha" "$vp_sha" "yes" >/dev/null 2>&1; then
    PREVIOUS_LEGACY="yes"; PREVIOUS_LEGACY_JSON="true"
    echo "previous release $vp_sha is legacy (formatVersion 1); it is only a restore target and will be started in health-only mode if recovery is needed" >&2
    return 0
  fi
  return 1
}

# 目标 release 的导入探针：用宿主 Node 在 release 路径实际导入 index/tools，
# 校验生产依赖与显式 peer 可解析、入口可加载、describePlugin().commit 等于目标 SHA。
# 只有“合法且显式授权”的历史 legacy 才允许跳过并如实标记；invalid/none/未知一律失败。
release_import_probe() {
  rip_dir="$1"; rip_sha="$2"; rip_allow_legacy="${3:-no}"
  if [ "$rip_allow_legacy" = "yes" ]; then
    rip_mode=$(node "$release_tool" activation --release "$rip_dir" --allow-legacy-rollback 2>/dev/null || printf 'none')
  else
    rip_mode=$(node "$release_tool" activation --release "$rip_dir" 2>/dev/null || printf 'none')
  fi
  case "$rip_mode" in
    required:*) : ;;
    legacy)
      if [ "$rip_allow_legacy" = "yes" ]; then
        IMPORT_PROBE="skipped-legacy"
        echo "import probe: skipped (explicitly authorized legacy release without a runtime dependency record): $rip_dir" >&2
        return 0
      fi
      IMPORT_PROBE="failed: legacy release without explicit rollback/restore authorization"
      echo "release import probe failed for $rip_sha: legacy release without explicit --allow-legacy-rollback" >&2
      return 1
      ;;
    *)
      IMPORT_PROBE="failed: activation metadata is $rip_mode"
      echo "release import probe failed for $rip_sha: activation metadata is $rip_mode; invalid/none/unknown releases are never skipped" >&2
      return 1
      ;;
  esac
  [ -f "$rip_dir/package.json" ] || { IMPORT_PROBE="failed: missing package.json"; echo "release import probe failed: missing $rip_dir/package.json" >&2; return 1; }
  out=$( cd "$rip_dir" && "$node_cmd" --input-type=module -e '
import { readFileSync } from "node:fs"
const sha = process.argv[1]
const pkg = JSON.parse(readFileSync("package.json", "utf8"))
const index = await import("./lib/index.mjs")
const tools = await import("./lib/tools.mjs")
const deps = {}
for (const name of Object.keys(pkg.dependencies ?? {})) {
  try { deps[name] = import.meta.resolve(name) } catch (error) {
    throw new Error("production dependency " + name + " does not resolve from the release: " + error.message)
  }
}
const peers = {}
for (const name of Object.keys(pkg.peerDependencies ?? {})) {
  try { peers[name] = import.meta.resolve(name) } catch (error) {
    if (pkg.peerDependenciesMeta?.[name]?.optional === true) { peers[name] = "optional-missing"; continue }
    throw new Error("peer dependency " + name + " does not resolve from the release: " + error.message)
  }
}
if (typeof index.apply !== "function") throw new Error("lib/index.mjs does not export apply()")
if (typeof tools.apply !== "function") throw new Error("lib/tools.mjs does not export apply()")
const describe = typeof index.describePlugin === "function" ? index.describePlugin() : null
if (!describe || describe.commit !== sha) throw new Error("describePlugin().commit=" + (describe && describe.commit) + " does not match release " + sha)
process.stdout.write(JSON.stringify({ ok: true, describe, deps: Object.keys(deps), peers: Object.keys(peers) }))
' "$rip_sha" 2>&1 ) || {
    IMPORT_PROBE="failed: $out"
    echo "release import probe failed for $rip_sha: $out" >&2
    return 1
  }
  IMPORT_PROBE="$out"
  echo "import probe ok ($node_cmd $node_version): $out" >&2
}

# release 的激活门禁模式：required:<entry,...> / legacy / invalid / none。
# legacy 只在显式授权回滚/恢复（第二参数 yes）时才会出现；其余未知/缺字段一律 invalid。
activation_mode_for() {
  am_sha="$1"; am_allow_legacy="${2:-no}"
  [ -n "$am_sha" ] || { printf 'none'; return 0; }
  if [ "$am_allow_legacy" = "yes" ]; then
    node "$release_tool" activation --release "$releases/$am_sha" --allow-legacy-rollback 2>/dev/null || printf 'none'
  else
    node "$release_tool" activation --release "$releases/$am_sha" 2>/dev/null || printf 'none'
  fi
}

host_log_size() {
  if [ -f "$instance/logs/host.log" ]; then wc -c < "$instance/logs/host.log" | tr -d ' '; else printf '0'; fi
}

# 只读本次启动日志偏移之后的内容，要求目标 SHA、新 host.pid 下两条 entry 标识齐全。
activation_check() {
  sha="$1"; pid="$2"; offset="$3"; mode="$4"
  case "$mode" in
    required:*)
      entries=${mode#required:}
      waited=0
      while :; do
        if out=$(node -e '
          const fs = require("fs")
          const [file, offsetText, sha, pidText, entriesText] = process.argv.slice(1)
          let text = ""
          try {
            const size = fs.statSync(file).size
            const start = Number(offsetText) || 0
            if (size > start) {
              const fd = fs.openSync(file, "r")
              const length = size - start
              const buffer = Buffer.alloc(length)
              fs.readSync(fd, buffer, 0, length, start)
              fs.closeSync(fd)
              text = buffer.toString("utf8")
            }
          } catch (error) { console.error("cannot read host log: " + error.message); process.exit(2) }
          const expected = entriesText.split(",").filter(Boolean)
          const found = {}
          for (const raw of text.split("\n")) {
            const match = /^\[hephi-activation\] entry=([a-z-]+) plugin=([^ ]+) commit=([0-9a-f]{40}) pid=([0-9]+)$/.exec(raw.trim())
            if (!match) continue
            if (match[3] !== sha || match[4] !== pidText) continue
            if (!expected.includes(match[1])) continue
            found[match[1]] = (found[match[1]] || 0) + 1
          }
          const missing = expected.filter((name) => !found[name])
          process.stdout.write(JSON.stringify({ ok: missing.length === 0, sha, pid: pidText, logOffset: Number(offsetText) || 0, expectedEntries: expected, found, missing }))
          process.exit(missing.length === 0 ? 0 : 1)
        ' "$instance/logs/host.log" "$offset" "$sha" "$pid" "$entries" 2>/dev/null); then
          ACTIVATION_MODE="verified"
          ACTIVATION_EVIDENCE="$out"
          echo "plugin activation verified ($sha, pid $pid): $out" >&2
          return 0
        fi
        if [ "$waited" -ge 5 ]; then break; fi
        sleep 1; waited=$((waited+1))
      done
      ACTIVATION_MODE="missing"
      ACTIVATION_EVIDENCE="${out:-no activation markers in the current startup log segment}"
      echo "plugin activation markers missing for $sha (pid $pid): $ACTIVATION_EVIDENCE" >&2
      return 1
      ;;
    legacy)
      ACTIVATION_MODE="unverified-legacy"
      ACTIVATION_EVIDENCE="release $sha has no activation metadata and was explicitly authorized for rollback/restore; the 10-service health gate is the only evidence"
      echo "activation: explicitly authorized legacy release $sha (health-only, no markers required)" >&2
      return 0
      ;;
    invalid)
      ACTIVATION_MODE="invalid-metadata"
      ACTIVATION_EVIDENCE="release $sha is not a complete v2 release and has no valid activation metadata; refusing the health-only fallback"
      echo "activation: release $sha is not a complete v2 release; refusing the health-only fallback" >&2
      return 1
      ;;
    *)
      ACTIVATION_MODE="unverified"
      ACTIVATION_EVIDENCE="no release metadata for $sha; refusing the health-only gate"
      echo "activation: no release metadata for $sha; refusing the health-only gate" >&2
      return 1
      ;;
  esac
}



set_pointer() {
  new_lib="$1"
  tmp="$hephi/.lib-new-$$"
  rm -f "$tmp"
  ln -s "$new_lib" "$tmp" || { echo "cannot create temporary symlink: $tmp" >&2; return 1; }
  # 首次迁移：$hephi/lib 仍是普通目录，rename symlink 到目录会 EISDIR，必须先把旧目录原子改名备份。
  if [ -d "$hephi/lib" ] && [ ! -L "$hephi/lib" ]; then
    migration="$hephi/.migration-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    mv "$hephi/lib" "$migration" || { rm -f "$tmp"; echo "cannot move plain lib directory aside: $hephi/lib" >&2; return 1; }
    MIGRATION_BACKUP="$migration"
    if ! node -e 'const fs=require("fs");fs.renameSync(process.argv[1],process.argv[2])' "$tmp" "$hephi/lib"; then
      rm -f "$tmp"
      if mv "$migration" "$hephi/lib" 2>/dev/null; then
        MIGRATION_RESTORE="restored"
        echo "pointer rename failed during plain-directory migration; old lib directory restored (verified mv back)" >&2
      else
        MIGRATION_RESTORE="failed"
        echo "pointer rename failed during plain-directory migration; old lib directory NOT restored; backup retained at $migration; manual takeover required" >&2
      fi
      return 1
    fi
    return 0
  fi
  node -e 'const fs=require("fs");fs.renameSync(process.argv[1],process.argv[2])' "$tmp" "$hephi/lib" \
    || { rm -f "$tmp"; echo "pointer rename failed: $tmp -> $hephi/lib" >&2; return 1; }
}

SNAP_ROOT=""; MIGRATION_BACKUP=""; MIGRATION_RESTORE=""
snapshot_existing_lib() {
  [ -L "$hephi/lib" ] && return 0
  [ -d "$hephi/lib" ] || return 0
  SNAP_ROOT="$releases/.migration-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$SNAP_ROOT"
  cp -R "$hephi/lib" "$SNAP_ROOT/lib"
  echo "snapshot existing lib: $SNAP_ROOT" >&2
}

acquire_lock() {
  lock="$releases/.publish.lock"
  waited=0
  mkdir -p "$releases"
  while ! mkdir "$lock" 2>/dev/null; do
    [ "$waited" -ge 60 ] && { echo "publish lock timeout: $lock" >&2; exit 1; }
    sleep 1; waited=$((waited+1))
  done
  trap 'rmdir "$lock" 2>/dev/null || true; rm -rf "${build_root:-}"' EXIT INT TERM
}

build_release() {
  sha="$1"
  is_sha "$sha" || { echo "target must be a full 40-char SHA: $sha" >&2; exit 2; }
  mkdir -p "$releases"
  acquire_lock
  [ -e "$releases/$sha" ] && { echo "release already exists and is immutable: $releases/$sha" >&2; exit 1; }
  build_root=$(mktemp -d "$releases/.build-$sha-XXXXXX")
  git -C "$repo" archive "$sha" | tar -x -C "$build_root" || { echo "cannot archive commit $sha" >&2; exit 1; }
  [ -d "$build_root/hephi" ] || { echo "archived source has no hephi directory" >&2; exit 1; }
  [ -f "$build_root/hephi/pnpm-lock.yaml" ] || { echo "archived source has no hephi/pnpm-lock.yaml; production dependencies cannot be frozen" >&2; exit 1; }
  build_check='pnpm check'
  if [ "${skip_tests:-}" = "yes" ]; then
    # Explicit operator override: the same tree already passed pnpm check (see the
    # deploy record); rerunning the suite for every retry wastes tens of minutes.
    build_check='pnpm typecheck && pnpm build'
    echo "skip-tests: release gate reduced to typecheck+build by explicit operator flag" >&2
  fi
  ( cd "$build_root/hephi" && HEPHI_BUILD_COMMIT="$sha" pnpm install --frozen-lockfile && HEPHI_BUILD_COMMIT="$sha" sh -c "$build_check" ) || { echo "build failed for $sha" >&2; exit 1; }
  [ -f "$build_root/hephi/lib/index.mjs" ] || { echo "build produced no lib/index.mjs" >&2; exit 1; }
  [ -f "$build_root/hephi/lib/tools.mjs" ] || { echo "build produced no lib/tools.mjs" >&2; exit 1; }
  prod_dep_count=$(node -e 'const p=require(process.argv[1]);process.stdout.write(String(Object.keys(p.dependencies??{}).length))' "$build_root/hephi/package.json")
  if [ "$prod_dep_count" != "0" ]; then
    # 同一冻结 lockfile 的生产依赖单独安装到构建目录再打包；离线执行，缺包即失败。
    ( cd "$build_root/hephi" && pnpm install --prod --frozen-lockfile --offline ) || { echo "cannot package the frozen production dependencies for $sha" >&2; exit 1; }
  fi
  incoming="$releases/.incoming-$sha-$$"
  rm -rf "$incoming"
  mkdir -p "$incoming"
  cp -R "$build_root/hephi/lib" "$incoming/lib"
  cp "$build_root/hephi/package.json" "$incoming/package.json"
  cp "$build_root/hephi/pnpm-lock.yaml" "$incoming/pnpm-lock.yaml"
  if [ "$prod_dep_count" != "0" ]; then
    [ -d "$build_root/hephi/node_modules" ] || { echo "production dependency install produced no node_modules for $sha" >&2; exit 1; }
    cp -R "$build_root/hephi/node_modules" "$incoming/node_modules"
  fi
  tree=$(git -C "$repo" rev-parse "$sha^{tree}")
  if ! meta_out=$(node "$release_tool" prepare --build "$build_root/hephi" --incoming "$incoming" --sha "$sha" --tree "$tree" \
      --host-version "$host_version" --node "$node_cmd" --node-version "$node_version" --peer-root "$peer_root"); then
    rm -rf "$incoming"
    echo "cannot prepare the immutable release package for $sha" >&2
    exit 1
  fi
  echo "release package: $meta_out" >&2
  release_validate "$incoming" "$sha" || { rm -rf "$incoming"; echo "incoming release failed validation" >&2; exit 1; }
  release_import_probe "$incoming" "$sha" || { rm -rf "$incoming"; echo "incoming release failed the host-Node import probe" >&2; exit 1; }
  mv "$incoming" "$releases/$sha"
  rm -rf "$build_root"
}

SINGLE_INSTANCE_RECORD='{"ok":false,"pids":[],"checkedAt":null,"phase":"not-run"}'
SINGLE_INSTANCE_FAILURE_RECORD=""
HOST_PID_LSTART=""

# §4.5 single-instance recheck. Counts only instance host entries (start.sh/bin.js) whose
# command line matches the instance pattern, keeps only root processes, and independently
# verifies the managed host.pid by the lstart captured when this script started it.
# It never kills processes found by the pattern. expect=one requires exactly the managed
# host; expect=none requires no instance at all (used after the stop / auto-restart window).
single_instance_failed() {
  if [ -z "$SINGLE_INSTANCE_FAILURE_RECORD" ]; then SINGLE_INSTANCE_FAILURE_RECORD="$SINGLE_INSTANCE_RECORD"; fi
}
single_instance_check() {
  si_phase="$1"
  si_expect="$2"
  si_checked_at=$(now)
  si_snapshot="$instance/logs/single-instance-$si_phase-$(date -u +%Y%m%dT%H%M%SZ)-$$.txt"
  si_host_pid=""; si_host_lstart_ok="no"
  if [ -f "$instance/host.pid" ]; then si_host_pid=$(cat "$instance/host.pid" 2>/dev/null || true); fi
  if [ -n "$si_host_pid" ]; then
    if pid_running "$si_host_pid"; then
      if [ -n "$HOST_PID_LSTART" ]; then
        si_current_lstart=$(ps -p "$si_host_pid" -o lstart= 2>/dev/null | sed 's/^ *//;s/ *$//' | tr -s ' ' || true)
        if [ -n "$si_current_lstart" ] && [ "$si_current_lstart" = "$HOST_PID_LSTART" ]; then si_host_lstart_ok="yes"; fi
      fi
    else
      si_host_pid=""
    fi
  fi
  if ! ps -ax -o pid=,ppid=,stat=,command= > "$si_snapshot" 2>/dev/null; then
    SINGLE_INSTANCE_RECORD=$(node -e 'process.stdout.write(JSON.stringify({ok:false,pids:[],checkedAt:process.argv[1],phase:process.argv[2]}))' "$si_checked_at" "$si_phase")
    single_instance_failed
    echo "single-instance check could not read the process table (phase=$si_phase)" >&2
    return 1
  fi
  if ! si_result=$(node -e '
const fs = require("fs");
const [file, patternSource, phase, checkedAt, expect, hostPidText, hostLstartOk] = process.argv.slice(1);
const rows = [];
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
  if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), stat: m[3], command: m[4] });
}
let regex;
try { regex = new RegExp(patternSource); } catch (error) { process.stdout.write(JSON.stringify({ ok: false, pids: [], checkedAt, phase })); process.exit(0); }
const baseName = (value) => value.replace(/\\/g, "/").split("/").pop();
const isEntryToken = (token) => { const base = baseName(token); return base === "start.sh" || base === "bin.js"; };
const SHELL = /^(sh|bash|zsh|dash)$/;
const WRAPPER = /^(env|nohup|exec|sudo)$/;
const VALUE_OPTIONS = new Set(["-u","-g","-p","-C","-h","-r","-t","-U","--user","--group","--prompt","--chdir","--host","--role","--type","--unset","--split-string","--close-from","--other-user"]);
function isEntry(command, depth) {
  if (depth > 4) return false;
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  if (isEntryToken(tokens[0])) return true;
  const first = baseName(tokens[0]);
  if (SHELL.test(first)) {
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === "--") return false;
      if (token === "-c") return isEntry(tokens.slice(index + 1).join(" "), depth + 1);
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(token)) return isEntry(tokens.slice(index + 1).join(" "), depth + 1);
      if (token.startsWith("-")) continue;
      return isEntryToken(token);
    }
    return false;
  }
  if (first === "node" || first === "nodejs") {
    for (let index = 1; index < tokens.length; index += 1) {
      if (tokens[index].startsWith("-")) continue;
      return isEntryToken(tokens[index]);
    }
    return false;
  }
  if (WRAPPER.test(first)) {
    let index = 1;
    while (index < tokens.length) {
      const token = tokens[index];
      if (token === "--") { index += 1; continue; }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { index += 1; continue; }
      if (token.startsWith("-")) { if (VALUE_OPTIONS.has(token)) index += 1; index += 1; continue; }
      if (isEntryToken(token)) return true;
      if (SHELL.test(token) || token === "node" || token === "nodejs" || WRAPPER.test(token)) return isEntry(tokens.slice(index).join(" "), depth + 1);
      return false;
    }
    return false;
  }
  return false;
}
const live = rows.filter((row) => !/^Z/.test(row.stat));
const candidates = live.filter((row) => isEntry(row.command, 0) && regex.test(row.command));
const candidatePids = new Set(candidates.map((row) => row.pid));
const parentOf = new Map(rows.map((row) => [row.pid, row.ppid]));
const roots = candidates.filter((row) => {
  let current = row.ppid;
  let depth = 0;
  while (current && depth < 64) { if (candidatePids.has(current)) return false; current = parentOf.get(current); depth += 1; }
  return true;
});
const pids = new Set(roots.map((row) => row.pid));
const hostPid = Number(hostPidText);
const isDescendantOf = (pid, ancestor) => {
  let current = parentOf.get(pid);
  let depth = 0;
  while (current && depth < 64) { if (current === ancestor) return true; current = parentOf.get(current); depth += 1; }
  return false;
};
const hostInAnyRoot = hostPid > 0 && [...candidatePids].some((pid) => hostPid === pid || isDescendantOf(hostPid, pid));
if (expect === "one" && hostPid > 0 && hostLstartOk === "yes" && !hostInAnyRoot) pids.add(hostPid);
const list = [...pids].sort((a, b) => a - b);
// expect=one: exactly one instance root, and the managed host pid must be identity-verified
// (lstart) and belong to that same single instance (root itself or a managed child such as
// bin.js under start.sh). A regex hit alone is never enough.
const ok = expect === "one"
  ? (hostLstartOk === "yes" && hostPid > 0 && list.length === 1 && (list[0] === hostPid || isDescendantOf(hostPid, list[0])))
  : (list.length === 0 && hostPid === 0);
process.stdout.write(JSON.stringify({ ok, pids: list, checkedAt, phase }));
' "$si_snapshot" "$instance_pattern" "$si_phase" "$si_checked_at" "$si_expect" "$si_host_pid" "$si_host_lstart_ok" 2>/dev/null); then
    SINGLE_INSTANCE_RECORD=$(node -e 'process.stdout.write(JSON.stringify({ok:false,pids:[],checkedAt:process.argv[1],phase:process.argv[2]}))' "$si_checked_at" "$si_phase")
    single_instance_failed
    echo "single-instance check could not parse the process table (phase=$si_phase)" >&2
    return 1
  fi
  SINGLE_INSTANCE_RECORD="$si_result"
  if ! printf '%s' "$si_result" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let ok=false;try{ok=JSON.parse(s).ok===true}catch(e){}process.exit(ok?0:1)})'; then
    single_instance_failed
    echo "single-instance check failed (phase=$si_phase): $si_result" >&2
    return 1
  fi
  echo "single-instance check ok (phase=$si_phase, expect=$si_expect): $si_result" >&2
  return 0
}
# Recovery starts recheck the same rule; on failure stop only the host this script just
# started, so a stray instance is never joined by a second one (no pattern-based kill).
# recovery_restart_instance keeps the original restart semantics: stop the managed target
# host first, then start the previous release. recovery_start_instance is only for the
# effects-drain abort path, which already stopped the managed host.
recovery_start_instance() {
  if start_instance; then return 0; fi
  if [ "${FAIL_KIND:-}" = "single-instance" ]; then
    kill_current_host >/dev/null 2>&1 || true
    echo "single-instance recheck failed after the recovery start; stopped the recovered host to avoid running a second instance" >&2
  fi
  return 1
}
recovery_restart_instance() {
  if restart_instance; then return 0; fi
  if [ "${FAIL_KIND:-}" = "single-instance" ]; then
    kill_current_host >/dev/null 2>&1 || true
    echo "single-instance recheck failed after the recovery start; stopped the recovered host to avoid running a second instance" >&2
  fi
  return 1
}

LAST_STATE=""; FAIL_STATE=""; FAIL_KIND=""; HEALTH_STATE=""
# 启动 $instance/start.sh 并等待 10 项全量健康；随后核对本次启动日志偏移之后的插件激活标识。
# 健康 ready 但缺少任一激活标识按启动失败处理，交由既有恢复/回滚路径。
start_instance() {
  LAST_STATE=""; FAIL_STATE=""; FAIL_KIND=""; HEALTH_STATE=""
  activation_sha=$(current_pointer_sha 2>/dev/null || true)
  activation_mode=$(activation_mode_for "$activation_sha" "${LEGACY_ACTIVATION:-no}")
  activation_offset=$(host_log_size)
  nohup "$instance/start.sh" >> "$instance/logs/host.log" 2>&1 &
  echo $! > "$instance/host.pid"
  pid=$!
  HOST_PID_LSTART=$(ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^ *//;s/ *$//' | tr -s ' ' || true)
  waited=0; got_state="no"
  while :; do
    if state=$(read_state 2>/dev/null); then
      LAST_STATE="$state"; got_state="yes"
      if health_ok "$state" 2>/dev/null; then
        if activation_check "$activation_sha" "$pid" "$activation_offset" "$activation_mode"; then
          if ! single_instance_check post-start one; then
            FAIL_STATE="$state"; FAIL_KIND="single-instance"
            return 1
          fi
          HEALTH_STATE="$state"; return 0
        fi
        FAIL_STATE="$state"; FAIL_KIND="activation-missing"
        return 1
      fi
    fi
    if [ "$waited" -ge "$timeout" ]; then
      FAIL_STATE="$LAST_STATE"
      if [ "$got_state" = "yes" ]; then FAIL_KIND="health-timeout"; else FAIL_KIND="state-unreadable"; fi
      echo "instance did not reach full health within ${timeout}s (${FAIL_KIND})" >&2
      return 1
    fi
    sleep 1; waited=$((waited+1))
  done
}
# 每次重启尝试都重置本阶段状态，禁止沿用上一阶段（target/restore）的字符串。
restart_instance() {
  LAST_STATE=""; FAIL_STATE=""; FAIL_KIND=""; HEALTH_STATE=""
  pid=$(cat "$instance/host.pid")
  kill -TERM "$pid" 2>/dev/null || true
  waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$timeout" ]; then
      FAIL_KIND="stop-timeout"; FAIL_STATE="$LAST_STATE"
      echo "instance did not stop within ${timeout}s" >&2
      return 1
    fi
    sleep 1; waited=$((waited+1))
  done
  start_instance
}

# 记录真实宿主状态回读：paused/load/healthReadback 一律来自 read_state；读不到就写 unverified。
record() {
  kind="$1"; action="$2"; result="$3"
  shift 3
  file="$instance/logs/$kind-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
  state=$(read_state 2>/dev/null || true)
  HEPHI_SINGLE_INSTANCE="${SINGLE_INSTANCE_FAILURE_RECORD:-$SINGLE_INSTANCE_RECORD}" node -e '
    const fs=require("fs"); const [file,action,result,hostVersion,state,...pairs]=process.argv.slice(1);
    const extra={}; for(let i=0;i+1<pairs.length;i+=2) extra[pairs[i]]=pairs[i+1]==="true"?true:(pairs[i+1]==="false"?false:pairs[i+1]);
    let paused="unverified", load="unverified", healthReadback="unverified";
    if(state){ try{const j=JSON.parse(state);
      if(typeof j.paused==="boolean") paused=j.paused;
      if(j.load&&typeof j.load==="object") load=j.load;
      if(j.health&&typeof j.health==="object") healthReadback=j.health;
    }catch(e){} }
    const rec={at:new Date().toISOString(), action, result, hostVersion, paused, load, healthReadback, ...extra};
    const single=process.env.HEPHI_SINGLE_INSTANCE;
    if(single){ try{ rec.singleInstance=JSON.parse(single) }catch(e){ rec.singleInstance={ok:false,pids:[],checkedAt:null,phase:"unreadable"} } }
    fs.writeFileSync(file, JSON.stringify(rec,null,2)+"\n");
  ' "$file" "$action" "$result" "$host_version" "$state" "$@"
  echo "record: $file"
}

current_pointer_sha() {
  [ -L "$hephi/lib" ] || return 1
  release_sha "$(readlink "$hephi/lib")"
}
pointer_after() { readlink "$hephi/lib" 2>/dev/null || echo ""; }

# 真实 paused 回读：读不到返回 1（调用方必须按 unverified/失败处理）。
paused_now() {
  s=$(read_state 2>/dev/null || true)
  [ -n "$s" ] || return 1
  printf '%s' "$s" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(String(j.paused))})'
}

fail_keep_paused() {
  echo "$1" >&2
  exit 1
}

# 失败出口统一回读 paused：yes/false/unverified。只有 confirmed true 才允许说 kept paused。
paused_flag() {
  p=$(paused_now 2>/dev/null || true)
  case "$p" in
    true) printf 'yes' ;;
    false) printf 'no' ;;
    *) printf 'unverified' ;;
  esac
}
fail_after_switch() {
  msg="$1"
  flag=$(paused_flag)
  case "$flag" in
    yes) fail_keep_paused "$msg; paused=true verified" ;;
    no) fail_keep_paused "$msg; host is NOT confirmed paused (paused=false); manual takeover required" ;;
    *) fail_keep_paused "$msg; paused state UNVERIFIED; manual takeover required" ;;
  esac
}


# ============================================================================
# §4.5 停机式排空（--drain effects）
#
# 流程（H0/H7 实测结论）：pause API 已 paused=true → 运行中 ro 预检查 effect 表
# （只作预检查，不是最终证据）→ 记录受管进程（host.pid + lstart + 后代）→ 构建
# 目标 release（缩短停机窗口）→ 停止宿主（必须用 --stop-command 执行宿主自己的 stop 脚本）
# → 停机后唯一权威证据：check-effects-db --mode copy（replay WAL、不动原库；
# 禁止 immutable=1 与 sqlite3 -readonly 兜底）→ 残留进程按 pid+lstart 核对 →
# 等待 --auto-restart-wait 秒（默认 10s）确认无自动重启 → 原子切换指针 → start.sh 启动
# → 10 项健康 + paused 回读 → 记录全部证据。
#
# 停止方式：--drain effects 必须显式给 --stop-command（例如
#   --stop-command "python3 <instance>/superagent/scripts/dsh-superagent stop --profile experiment --url http://127.0.0.1:3083 --stop-timeout 30"
# ）。默认 SIGINT 路径已删除：它从未在真实宿主验证，且假宿主套件无法覆盖。
# 中止恢复：已停机则用 $instance/start.sh（H0 实测约 11s 到 10 项健康）；不使用管理器 start（依赖 dsh/tmux）。
#
# 任一中止路径：不切换 release。若已停机则按原版本重启并全量健康检查；非零退出，
# 并把 precheck/final JSON、进程清单、stop 输出写入记录。
# 例外：停机后宿主动重启/被 supervisor 拉起时，只记录并中止，不杀新进程、不再启动第二份实例，
# 记录 autoRestartedPid 与 autoRestartAction="left-running"，交操作者接管。
#
# 构建时机：目标 release 在停机前构建（缩短停机窗口），故 stop/final 等中止路径可能留下
# 未激活的不可变 releases/<sha>；指针与实载不变，这属预期。
# ============================================================================
EFFECT_PRECHECK_JSON=""; EFFECT_FINAL_JSON=""; EFFECT_STOPPED="no"; EFFECT_SWITCHED="no"
EFFECT_STOP_EXIT=""; EFFECT_STOP_OUTPUT=""; EFFECT_OLD_PID=""; AUTO_RESTART_PID=""
EFFECT_LEAVE_RUNNING="no"; EFFECT_AUTO_RESTART_ACTION="none"
EFFECT_RESTORE_TARGET=""; EFFECT_RECOVER_HEALTH="not-attempted"
managed_file="none"; managed_processes=""; managed_count=0; host_pid=""; host_lstart=""
residual_lines="none"; EFFECT_QUERY_FILE=""

# 运行 check-effects-db（不改该工具）；stdout 存入 EFFECT_JSON，退出码存入 EFFECT_CODE。
effects_query() {
  mode="$1"
  [ -f "$effects_tool" ] || { echo "effects checker missing: $effects_tool" >&2; EFFECT_JSON=""; EFFECT_CODE=1; return 1; }
  EFFECT_QUERY_FILE="$instance/logs/effects-$mode-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
  if node "$effects_tool" --db "$effects_db" --mode "$mode" --json > "$EFFECT_QUERY_FILE" 2>"$instance/logs/effects-$mode.err"; then
    EFFECT_CODE=0
  else
    EFFECT_CODE=1
  fi
  EFFECT_JSON=$(cat "$EFFECT_QUERY_FILE" 2>/dev/null || true)
  return 0
}

# 解析 EFFECT_JSON 的 ok/journalMode/total；JSON 非法返回 1。
effects_read_fields() {
  parsed=$(printf '%s' "$EFFECT_JSON" | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      let j; try { j = JSON.parse(s) } catch (e) { process.exit(1) }
      const total = (typeof j.total === "number" && Number.isSafeInteger(j.total)) ? String(j.total) : "NaN";
      process.stdout.write(String(j.ok === true) + "\t" + String(typeof j.journalMode === "string" ? j.journalMode : "") + "\t" + total);
    });' 2>/dev/null) || return 1
  EFFECT_OK=$(printf '%s' "$parsed" | cut -f1)
  EFFECT_JOURNAL=$(printf '%s' "$parsed" | cut -f2)
  EFFECT_TOTAL=$(printf '%s' "$parsed" | cut -f3)
  return 0
}

# 预检查与最终证据的共同判据：ok=true、journalMode=wal、effect 表 total=0。
effects_ok_with_zero() {
  label="$1"
  if ! effects_read_fields; then
    echo "effects $label check: invalid JSON: $EFFECT_JSON" >&2
    return 1
  fi
  if [ "$EFFECT_OK" != "true" ] || [ "$EFFECT_JOURNAL" != "wal" ] || [ "$EFFECT_TOTAL" != "0" ]; then
    echo "effects $label check failed: ok=$EFFECT_OK journal=$EFFECT_JOURNAL total=$EFFECT_TOTAL" >&2
    return 1
  fi
  return 0
}

# 记录受管进程表：ps 全表（pid/ppid/lstart/command），并按 ppid 关系从 host.pid 计算后代。
effects_process_table() {
  managed_ts=$(date -u +%Y%m%dT%H%M%SZ)
  if [ -n "$process_file" ]; then
    managed_file="$process_file"
  else
    managed_file="$instance/logs/managed-$managed_ts-$$.txt"
  fi
  host_pid=$(cat "$instance/host.pid" 2>/dev/null || true)
  host_lstart=""
  if [ -n "$host_pid" ] && kill -0 "$host_pid" 2>/dev/null; then
    host_lstart=$(ps -p "$host_pid" -o lstart= 2>/dev/null | sed 's/^ *//;s/ *$//' | tr -s ' ' || true)
  fi
  # 文件格式按 §4.5 约定：ps -ax -o pid=,lstart=,command=（后代关系另取 ppid 计算）。
  if ! ps -ax -o pid=,lstart=,command= > "$managed_file" 2>/dev/null; then
    echo "cannot record managed process table: $managed_file" >&2
    return 1
  fi
  managed_processes=$(node -e '
    const fs = require("fs");
    const { execFileSync } = require("child_process");
    const [file, root] = process.argv.slice(1);
    if (root === "") process.exit(0);
    const rows = fs.readFileSync(file, "utf8").split("\n").map(line => line.trim()).filter(Boolean).map(line => {
      const parts = line.split(/\s+/);
      return { pid: parts[0], lstart: parts.slice(1, 6).join(" "), command: parts.slice(6).join(" ") };
    });
    let ppidText = "";
    try { ppidText = execFileSync("ps", ["-ax", "-o", "pid=,ppid="], { encoding: "utf8" }); } catch (error) { process.exit(0); }
    const parentOf = new Map();
    for (const line of ppidText.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) parentOf.set(parts[0], parts[1]);
    }
    const byPid = new Map(rows.map(row => [row.pid, row]));
    const out = [];
    const rootRow = byPid.get(root);
    if (rootRow) out.push(rootRow);
    for (const pid of byPid.keys()) {
      if (pid === root) continue;
      let current = pid;
      let depth = 0;
      let descendant = false;
      while (depth < 64) {
        const parent = parentOf.get(current);
        if (parent === undefined) break;
        if (parent === root) { descendant = true; break; }
        current = parent;
        depth += 1;
      }
      if (descendant) out.push(byPid.get(pid));
    }
    process.stdout.write(out.map(row => [row.pid, row.lstart, row.command].join("|")).join("\n"));
  ' "$managed_file" "$host_pid" 2>/dev/null || true)
  if [ -n "$managed_processes" ]; then
    managed_count=$(printf '%s\n' "$managed_processes" | grep -c . || true)
  else
    managed_count=0
  fi
  echo "managed processes: $managed_file (host pid=${host_pid:-none} lstart=${host_lstart:-none} managed=${managed_count})" >&2
}

# 停机后按「pid 仍存在且 lstart 相同」核对残留；pid 复用但 lstart 不同不算残留。
effects_residuals() {
  [ -n "$managed_processes" ] || return 0
  printf '%s\n' "$managed_processes" | while IFS='|' read -r rpid rlstart rcommand; do
    [ -n "$rpid" ] || continue
    pid_running "$rpid" || continue
    now_lstart=$(ps -p "$rpid" -o lstart= 2>/dev/null | sed 's/^ *//;s/ *$//' | tr -s ' ' || true)
    [ -n "$now_lstart" ] || continue
    if [ "$now_lstart" = "$rlstart" ]; then printf '%s|%s|%s\n' "$rpid" "$rlstart" "$rcommand"; fi
  done
}

# pid 是否仍在运行：kill -0 对僵尸进程也成立，故读 ps stat 把 Z 视为已停止。
pid_running() {
  p="$1"
  [ -n "$p" ] || return 1
  kill -0 "$p" 2>/dev/null || return 1
  s=$(ps -p "$p" -o stat= 2>/dev/null | tr -d ' ' || true)
  case "$s" in ''|Z*) return 1 ;; esac
  return 0
}

# 停掉当前 host.pid 进程（用于已停机后清理未通过健康检查的本次启动进程）。
kill_current_host() {
  pid=$(cat "$instance/host.pid" 2>/dev/null || true)
  [ -n "$pid" ] || return 0
  kill -TERM "$pid" 2>/dev/null || true
  waited=0
  while pid_running "$pid"; do
    [ "$waited" -ge "$timeout" ] && return 1
    sleep 1; waited=$((waited+1))
  done
  return 0
}

# 停机：执行必填的 --stop-command（sh -c），记录输出/退出码。
# EFFECT_STOPPED 表示旧 host pid 是否已消失（即使 stop 命令非零，也要据此决定是否重启原版本）。
effects_stop() {
  EFFECT_OLD_PID=$(cat "$instance/host.pid" 2>/dev/null || true)
  [ -n "$EFFECT_OLD_PID" ] || { echo "missing host.pid before stop" >&2; EFFECT_STOPPED="no"; return 1; }
  EFFECT_STOP_EXIT=""; EFFECT_STOP_OUTPUT=""
  if [ -z "$stop_command" ]; then
    # 参数校验已拒绝；这里再 fail-closed 一次，防止被绕过。
    echo "--drain effects requires --stop-command; refusing to stop the host" >&2
    EFFECT_STOPPED="no"; return 1
  fi
  set +e
  EFFECT_STOP_OUTPUT=$(sh -c "$stop_command" 2>&1)
  EFFECT_STOP_EXIT=$?
  set -e
  printf '%s\n' "$EFFECT_STOP_OUTPUT" > "$instance/logs/managed-stop-$(date -u +%Y%m%dT%H%M%SZ)-$$.log" 2>/dev/null || true
  waited=0
  while pid_running "$EFFECT_OLD_PID"; do
    if [ "$waited" -ge "$stop_timeout" ]; then
      echo "host did not stop within ${stop_timeout}s (pid=$EFFECT_OLD_PID)" >&2
      EFFECT_STOPPED="no"; return 1
    fi
    sleep 1; waited=$((waited+1))
  done
  EFFECT_STOPPED="yes"
  if [ "$EFFECT_STOP_EXIT" != "0" ]; then
    echo "stop command failed (exit=$EFFECT_STOP_EXIT)" >&2
    return 1
  fi
  return 0
}

# 停机后等待 --auto-restart-wait 秒（默认 10s），确认宿主没有自动回来（host.pid 出现新的存活 pid）。
effects_no_auto_restart() {
  echo "auto-restart check: waiting ${auto_restart_wait}s before switching" >&2
  sleep "$auto_restart_wait"
  auto_pid=$(cat "$instance/host.pid" 2>/dev/null || true)
  if [ -n "$auto_pid" ] && [ "$auto_pid" != "$EFFECT_OLD_PID" ] && pid_running "$auto_pid"; then
    AUTO_RESTART_PID="$auto_pid"; return 1
  fi
  if [ -n "$EFFECT_OLD_PID" ] && pid_running "$EFFECT_OLD_PID"; then return 1; fi
  return 0
}

# 统一中止出口：若已停机则按原版本重启（必要时先恢复指针）并全量健康检查；
# 记录 precheck/final JSON、进程清单与 stop 输出；最后 fail_after_switch 非零退出。
effects_abort() {
  result="$1"; errors="$2"
  EFFECT_RECOVER_HEALTH="not-attempted"
  # 恢复实例的激活状态必须随记录一起写出（UX-4）：legacy previous 以 health-only 恢复时
  # start_instance/activation_check 会把它置为 unverified-legacy；没有尝试恢复时保持 unverified。
  ACTIVATION_MODE="unverified"; ACTIVATION_EVIDENCE="recovery start not attempted or not verified"
  if [ "$EFFECT_LEAVE_RUNNING" = "yes" ]; then
    # 宿主已自行回来：不杀它、不再启动第二份实例，只记录并交给操作者接管。
    EFFECT_RECOVER_HEALTH="left-running"
    EFFECT_AUTO_RESTART_ACTION="left-running"
    echo "host came back after stop (pid=${AUTO_RESTART_PID:-unknown}); leaving it running for operator takeover" >&2
  elif [ "$EFFECT_STOPPED" = "yes" ]; then
    kill_current_host || true
    if [ "$EFFECT_SWITCHED" = "yes" ] && [ -n "$EFFECT_RESTORE_TARGET" ]; then
      if ! set_pointer "$EFFECT_RESTORE_TARGET"; then
        echo "FATAL: could not restore pointer to ${EFFECT_RESTORE_TARGET}" >&2
      fi
    elif [ "$EFFECT_SWITCHED" = "yes" ]; then
      echo "FATAL: no validated previous release/snapshot to restore the pointer to" >&2
    fi
    # 恢复目标可能是 legacy：自动按 health-only 接受并如实记录 unverified-legacy；
    # 显式 --allow-legacy-rollback 仍可用于 rollback/restore 目标。
    LEGACY_ACTIVATION="$allow_legacy_rollback"
    if [ "${PREVIOUS_LEGACY:-no}" = "yes" ]; then LEGACY_ACTIVATION="yes"; fi
    if recovery_start_instance; then
      EFFECT_RECOVER_HEALTH="all-required-ready"
      p=$(paused_now 2>/dev/null || true)
      if [ "$p" != "true" ]; then echo "warning: restored host did not report paused=true (paused=$p)" >&2; fi
    else
      case "${FAIL_KIND:-}" in
        single-instance)
          EFFECT_RECOVER_HEALTH="single-instance-failed"
          errors="$errors; single-instance recheck failed after the recovery start; the recovered host was stopped and requires operator takeover"
          echo "FATAL: original version reached health but failed the single-instance recheck after the effects-drain abort; recovered host stopped for operator takeover" >&2
          ;;
        *)
          EFFECT_RECOVER_HEALTH="not-restarted"
          echo "FATAL: original version restart failed after effects-drain abort" >&2
          ;;
      esac
    fi
  elif state_now=$(read_state 2>/dev/null) && health_ok "$state_now" 2>/dev/null; then
    EFFECT_RECOVER_HEALTH="all-required-ready"
  else
    EFFECT_RECOVER_HEALTH="not-verified"
  fi
  flag=$(paused_flag)
  record deploy deploy "$result" drainMode effects target "$target" previous "${previous:-$current}" previousLegacy "${PREVIOUS_LEGACY_JSON:-false}" \
    pointerBefore "$pointer_before" pointerAfter "$(pointer_after)" health not-ready \
    precheckJson "${EFFECT_PRECHECK_JSON:-}" finalCheckJson "${EFFECT_FINAL_JSON:-}" \
    processFile "${managed_file:-none}" hostPid "${host_pid:-none}" hostLstart "${host_lstart:-none}" \
    managedCount "${managed_count:-0}" stopExit "${EFFECT_STOP_EXIT:-none}" stopOutput "${EFFECT_STOP_OUTPUT:-}" \
    stopCommand "${stop_command:-none}" autoRestartWait "${auto_restart_wait}" residualProcesses "${residual_lines:-none}" \
    autoRestartedPid "${AUTO_RESTART_PID:-none}" autoRestartAction "$EFFECT_AUTO_RESTART_ACTION" recoverHealth "$EFFECT_RECOVER_HEALTH" \
    activation "$ACTIVATION_MODE" activationEvidence "$ACTIVATION_EVIDENCE" \
    migration "${MIGRATION_BACKUP:-none}" migrationRestore "${MIGRATION_RESTORE:-none}" \
    keptPaused "$flag" error "$errors"
  fail_after_switch "$errors"
}

# §4.5 主流程；所有出口都 exit。
deploy_effects() {
  echo "deploy mode: stop-based drain (--drain effects); effects db: $effects_db" >&2

  # 1) 记录受管进程（含 host.pid 与 lstart；无子进程时 managed=1 也是合法结果）。
  #    先记录，保证任何中止路径（包括 effect 预检查失败）的记录都带进程清单。
  if ! effects_process_table; then
    effects_abort failed-drain-processes "could not record the managed process table"
  fi

  # 2) 运行中 effect 预检查（只作预检查；最终证据在停机后用 copy 模式取）。
  effects_query ro
  EFFECT_PRECHECK_JSON="$EFFECT_JSON"
  if [ "$EFFECT_CODE" != "0" ] || ! effects_ok_with_zero "precheck"; then
    effects_abort failed-drain-precheck "effect precheck before stop failed: ok=${EFFECT_OK:-unknown} journal=${EFFECT_JOURNAL:-unknown} total=${EFFECT_TOTAL:-unknown}"
  fi

  # 3) dry-run：只做 pause 前置 + effect 预检查 + 进程清单，不停机不切换不构建。
  if [ "$dry_run" = "yes" ]; then
    echo "dry-run: drain=effects precheck passed (total=0, journal=wal); managed processes recorded at $managed_file; no stop, no switch, no release build"
    exit 0
  fi

  # 4) 构建/校验目标 release（停机前完成，缩短停机窗口）。
  if [ -d "$releases/$target/lib" ]; then
    release_validate "$releases/$target" || effects_abort failed-drain-release "target release is invalid: $target"
    release_import_probe "$releases/$target" "$target" || effects_abort failed-drain-release "target release failed the host-Node import probe: $target"
  else
    build_release "$target"
    release_validate "$releases/$target" || effects_abort failed-drain-release "new release failed validation: $target"
  fi

  # 5) previous 校验与回滚点（供中止/启动失败时恢复原版本）。
  [ -n "$previous" ] || previous="$current"
  if [ -n "$previous" ]; then
    validate_previous_target "$previous" || effects_abort failed-drain-previous "previous release is invalid: $previous (legacy is allowed only as a restore target)"
  fi
  previous_valid="no"; [ -n "$previous" ] && previous_valid="yes"
  snapshot_existing_lib
  if [ "$previous_valid" = "yes" ]; then
    EFFECT_RESTORE_TARGET="$releases/$previous/lib"
  elif [ -n "$SNAP_ROOT" ] && [ -d "$SNAP_ROOT/lib" ]; then
    EFFECT_RESTORE_TARGET="$SNAP_ROOT/lib"
  fi

  # 6) 停机前重新记录受管进程（构建可能耗时；记录时间点必须紧邻停机）。
  if ! effects_process_table; then
    effects_abort failed-drain-processes "could not refresh the managed process table before stop"
  fi

  # 7) 停机。
  if ! effects_stop; then
    effects_abort failed-drain-stop "host stop failed; stopExit=${EFFECT_STOP_EXIT:-none}"
  fi

  # 8) 停机后最终查询：copy 模式（replay WAL、不动原库）；ok/journalMode/total 全部满足才继续。
  effects_query copy
  EFFECT_FINAL_JSON="$EFFECT_JSON"
  if [ "$EFFECT_CODE" != "0" ] || ! effects_ok_with_zero "final"; then
    effects_abort failed-drain-final "post-stop effect final check failed: ok=${EFFECT_OK:-unknown} journal=${EFFECT_JOURNAL:-unknown} total=${EFFECT_TOTAL:-unknown} exit=$EFFECT_CODE"
  fi

  # 9) 残留进程核对 + 无自动重启确认。
  residual_lines=$(effects_residuals)
  if [ -n "$residual_lines" ]; then
    effects_abort failed-drain-residual "managed processes still alive after stop; no switch performed"
  fi
  if ! effects_no_auto_restart; then
    EFFECT_LEAVE_RUNNING="yes"
    effects_abort failed-drain-auto-restart "host came back after stop (auto-restarted pid=${AUTO_RESTART_PID:-unknown}); no switch performed; left running and requires operator takeover"
  fi
  # 9b) single-instance recheck after the existing auto-restart window, before any switch.
  if ! single_instance_check post-auto-restart none; then
    effects_abort failed-drain-single-instance "single-instance recheck after the auto-restart window failed; no switch performed: $SINGLE_INSTANCE_RECORD"
  fi

  # 10) 原子切换 + 启动 + 全量健康 + paused 回读。
  if ! set_pointer "$releases/$target/lib"; then
    effects_abort failed-drain-pointer "pointer switch failed during stop-based deploy"
  fi
  EFFECT_SWITCHED="yes"
  # 正向 target 的激活门禁不使用 legacy 授权；只有恢复目标才允许显式 legacy。
  LEGACY_ACTIVATION="no"
  if ! start_instance; then
    effects_abort failed-drain-start "target failed to reach full health after stop-based switch"
  fi
  p=$(paused_now) || p=""
  if [ "$p" != "true" ]; then
    flag=$(paused_flag)
    record deploy deploy failed-not-paused drainMode effects target "$target" previous "$previous" previousLegacy "${PREVIOUS_LEGACY_JSON:-false}" \
      pointerBefore "$pointer_before" pointerAfter "$(pointer_after)" health all-required-ready \
      precheckJson "$EFFECT_PRECHECK_JSON" finalCheckJson "$EFFECT_FINAL_JSON" \
      processFile "${managed_file:-none}" hostPid "${host_pid:-none}" hostLstart "${host_lstart:-none}" \
      managedCount "${managed_count:-0}" stopExit "${EFFECT_STOP_EXIT:-none}" stopOutput "${EFFECT_STOP_OUTPUT:-}" \
      migration "${MIGRATION_BACKUP:-none}" autoRestartWait "${auto_restart_wait}" keptPaused "$flag" error "host did not report paused=true after stop-based deploy; manual takeover required"
    fail_keep_paused "host is not paused after stop-based deploy; manual takeover required"
  fi
  record deploy deploy ok drainMode effects target "$target" previous "$previous" previousLegacy "${PREVIOUS_LEGACY_JSON:-false}" \
    pointerBefore "$pointer_before" pointerAfter "$(pointer_after)" health all-required-ready \
    precheckJson "$EFFECT_PRECHECK_JSON" finalCheckJson "$EFFECT_FINAL_JSON" \
    processFile "${managed_file:-none}" hostPid "${host_pid:-none}" hostLstart "${host_lstart:-none}" \
    managedCount "${managed_count:-0}" stopExit "${EFFECT_STOP_EXIT:-none}" stopOutput "${EFFECT_STOP_OUTPUT:-}" \
    stopCommand "${stop_command:-none}" autoRestartWait "${auto_restart_wait}" recoverHealth all-required-ready \
    migration "${MIGRATION_BACKUP:-none}" keptPaused yes \
    activation "$ACTIVATION_MODE" activationEvidence "$ACTIVATION_EVIDENCE" importProbe "$IMPORT_PROBE" nodeVersion "$node_version"
  echo "deploy complete (stop-based drain); host remains paused; effect final check total=0 journal=wal"
  exit 0
}

# ---- main ----
mkdir -p "$releases" "$instance/logs"

# rollback 语义：target／previous 只接受显式完整 SHA，必须在任何默认值/切换之前校验。
if [ "$rollback" = "yes" ]; then
  [ "$target_set" = "yes" ] || fail_keep_paused "--rollback needs an explicit --target release (no implicit HEAD default)"
  is_sha "$target" || fail_keep_paused "--rollback target must be a full 40-char SHA: $target"
  if [ "$previous_set" = "yes" ]; then
    is_sha "$previous" || fail_keep_paused "--rollback previous must be a full 40-char SHA: $previous"
  fi
fi

state=$(read_state) || fail_keep_paused "host state is unreadable: $host"
paused=$(printf '%s' "$state" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(String(j.paused))})')
[ "$paused" = "true" ] || fail_keep_paused "host is not paused; pause and drain before deploying (P8)"
if [ "$drain_mode" = "effects" ]; then
  # §4.5：排空证据来自 effect 表（停机后最终 copy 查询才是权威证据），不再要求 API load 的 5 个未核字段。
  :
else
  drain_ok "$state" || fail_keep_paused "drain check failed; refusing to upgrade"
fi
count=$(open_tickets) || fail_keep_paused "cannot read open tickets; refusing to upgrade"
[ "$count" = "0" ] || fail_keep_paused "there are $count open Tickets; finish them before upgrading (no bypass)"

# 普通部署未指定 target 时才允许取仓库 HEAD；rollback 已在上方强制显式。
if [ -z "$target" ]; then target=$(git -C "$repo" rev-parse HEAD); fi
is_sha "$target" || fail_keep_paused "target must be a full 40-char SHA: $target"

pointer_before=$(pointer_after)
current=$(current_pointer_sha 2>/dev/null || true)

# current 是否通过校验必须单独保存：rollback 可以继续，但绝不允许把未通过校验的 current 当恢复目标。
# current 在回滚流程里是恢复目标，因此 legacy 授权与回滚目标使用同一显式标记。
current_valid="no"
if [ -n "$current" ]; then
  if release_validate "$releases/$current" "$current" "$allow_legacy_rollback" >/dev/null 2>&1; then current_valid="yes"; fi
fi

# 已载入的 release 视为不可变：重复发布同一 SHA 是空操作，直接拒绝且不碰 release/不重启。
if [ "$rollback" != "yes" ] && [ -n "$current" ] && [ "$target" = "$current" ]; then
  fail_keep_paused "release $target is already loaded and immutable; nothing to deploy"
fi

if [ "$rollback" = "yes" ]; then
  # 回滚是显式 legacy 授权唯一生效的入口；正向 target 永远不带该标记。
  release_validate "$releases/$target" "$target" "$allow_legacy_rollback" || fail_keep_paused "rollback target release is invalid: $target"
  release_import_probe "$releases/$target" "$target" "$allow_legacy_rollback" || fail_keep_paused "rollback target release failed the host-Node import probe: $target"
  if [ "$previous_set" = "yes" ]; then
    release_validate "$releases/$previous" "$previous" "$allow_legacy_rollback" || fail_keep_paused "rollback previous release is invalid: $previous"
  fi
  snapshot_existing_lib
  if ! set_pointer "$releases/$target/lib"; then
    flag=$(paused_flag)
    record rollback rollback failed-pointer target "$target" previous "${previous:-$current}" pointerBefore "$pointer_before" pointerAfter "$(pointer_after)" health not-ready migration "${MIGRATION_BACKUP:-none}" migrationRestore "${MIGRATION_RESTORE:-none}" keptPaused "$flag" error "pointer switch failed"
    if [ "${MIGRATION_RESTORE:-}" = "failed" ]; then
      fail_after_switch "rollback pointer switch failed and old lib directory restore FAILED; backup at ${MIGRATION_BACKUP}"
    fi
    fail_after_switch "rollback could not switch the loaded pointer"
  fi
  LEGACY_ACTIVATION="$allow_legacy_rollback"
  if restart_instance; then
    p=$(paused_now) || p=""
    if [ "$p" != "true" ]; then
      flag=$(paused_flag)
      record rollback rollback failed-not-paused target "$target" previous "${previous:-$current}" pointerBefore "$pointer_before" pointerAfter "$(pointer_after)" health all-required-ready keptPaused "$flag" error "host did not report paused=true after rollback; manual takeover required"
      fail_keep_paused "host is not paused after rollback; manual takeover required"
    fi
    record rollback rollback ok target "$target" previous "${previous:-$current}" pointerBefore "$pointer_before" pointerAfter "$(pointer_after)" health all-required-ready loadedCommitReadback unverified migration "${MIGRATION_BACKUP:-none}" keptPaused yes activation "$ACTIVATION_MODE" activationEvidence "$ACTIVATION_EVIDENCE" importProbe "$IMPORT_PROBE" nodeVersion "$node_version"
    echo "rollback complete; host remains paused, verify loaded build then resume via API"
    exit 0
  fi
  # rollback 目标失败：用显式 previous（已校验）或通过校验的 current 恢复；两者都没有就记 failed-no-previous。
  target_fail_state="${FAIL_STATE:-unverified}"; target_fail_kind="${FAIL_KIND:-unknown}"
  restore_target=""; restore_kind=""
  if [ "$previous_set" = "yes" ]; then
    restore_target="$releases/$previous/lib"; restore_kind="previous"
  elif [ "$current_valid" = "yes" ]; then
    restore_target="$releases/$current/lib"; restore_kind="current"
  fi
  if [ -z "$restore_target" ]; then
    flag=$(paused_flag)
    record rollback rollback failed-no-previous target "$target" previous "${previous:-$current}" pointerBefore "$pointer_before" pointerAfter "$(pointer_after)" health not-ready targetFailure "$target_fail_state" targetFailureKind "$target_fail_kind" keptPaused "$flag" error "rollback target failed and no validated previous release exists"
    fail_after_switch "rollback target failed and no validated previous release exists"
  fi
  if ! set_pointer "$restore_target"; then
    flag=$(paused_flag)
    record rollback rollback failed-twice target "$target" previous "$restore_kind:$restore_target" pointerBefore "$pointer_before" pointerAfter "$(pointer_after)" health not-ready targetFailure "$target_fail_state" targetFailureKind "$target_fail_kind" restoreFailure "pointer restore to $restore_target failed" restoreFailureKind pointer-restore-failed keptPaused "$flag" error "rollback target failed and restoring pointer failed"
    fail_after_switch "rollback target failed and restoring the previous pointer failed"
  fi
  if recovery_restart_instance; then
    flag=$(paused_flag)
    record rollback rollback failed-restored-previous target "$target" previous "$restore_kind:$restore_target" pointerBefore "$pointer_before" pointerAfter "$(pointer_after)" health not-ready targetFailure "$target_fail_state" targetFailureKind "$target_fail_kind" restoreHealth all-required-ready keptPaused "$flag" activation "$ACTIVATION_MODE" activationEvidence "$ACTIVATION_EVIDENCE" importProbe "$IMPORT_PROBE" nodeVersion "$node_version" error "rollback target failed; previous build restored"
    fail_after_switch "rollback target failed health; previous build restored"
  fi
  flag=$(paused_flag)
  record rollback rollback failed-twice target "$target" previous "$restore_kind:$restore_target" pointerBefore "$pointer_before" pointerAfter "$(pointer_after)" health not-ready targetFailure "$target_fail_state" targetFailureKind "$target_fail_kind" restoreFailure "${FAIL_STATE:-unverified}" restoreFailureKind "${FAIL_KIND:-unknown}" keptPaused "$flag" error "rollback target and automatic recovery both failed"
  fail_after_switch "rollback failed twice"
fi

if [ "$drain_mode" = "effects" ]; then
  deploy_effects
fi

# 构建或复用不可变 release。正向 target 绝不使用 legacy 授权。
if [ -d "$releases/$target/lib" ]; then
  release_validate "$releases/$target" || fail_keep_paused "target release is invalid: $target"
  release_import_probe "$releases/$target" "$target" || fail_keep_paused "target release failed the host-Node import probe: $target"
else
  build_release "$target"
  release_validate "$releases/$target" || fail_keep_paused "new release failed validation: $target"
fi

if [ "$dry_run" = "yes" ]; then
  echo "dry-run: preconditions, drain and release validation passed for $target; no switch, no restart"
  exit 0
fi

[ -n "$previous" ] || previous="$current"
# previous/current 是恢复目标：legacy 自动通过校验（health-only），但绝不因此放行正向 target。
if [ -n "$previous" ]; then validate_previous_target "$previous" || fail_keep_paused "previous release is invalid: $previous (legacy is allowed only as a restore target)"; fi
previous_valid="no"
if [ -n "$previous" ]; then previous_valid="yes"; fi

snapshot_existing_lib
if [ -z "$previous" ] && [ -z "$SNAP_ROOT" ]; then
  echo "first install: no previous release and no existing lib; a failed switch will keep the host paused" >&2
fi
if ! set_pointer "$releases/$target/lib"; then
  flag=$(paused_flag)
  record deploy deploy failed-pointer target "$target" previous "$previous" pointerBefore "$pointer_before" pointerAfter "$(pointer_after)" health not-ready migration "${MIGRATION_BACKUP:-none}" migrationRestore "${MIGRATION_RESTORE:-none}" keptPaused "$flag" error "pointer switch failed"
  if [ "${MIGRATION_RESTORE:-}" = "failed" ]; then
    fail_after_switch "pointer switch failed and old lib directory restore FAILED; backup at ${MIGRATION_BACKUP}"
  fi
  fail_after_switch "could not switch the loaded pointer"
fi
# 正向 target 的启动门禁不接受 legacy；该标记只用于下面的恢复目标。
LEGACY_ACTIVATION="no"
if restart_instance; then
  p=$(paused_now) || p=""
  if [ "$p" != "true" ]; then
    flag=$(paused_flag)
    record deploy deploy failed-not-paused target "$target" previous "$previous" pointerBefore "$pointer_before" pointerAfter "$(pointer_after)" health all-required-ready loadedCommitReadback unverified migration "${MIGRATION_BACKUP:-none}" keptPaused "$flag" error "host did not report paused=true after switch; manual takeover required"
    fail_keep_paused "host is not paused after switch; manual takeover required"
  fi
  record deploy deploy ok target "$target" previous "$previous" previousLegacy "${PREVIOUS_LEGACY_JSON:-false}" pointerBefore "$pointer_before" pointerAfter "$(pointer_after)" health all-required-ready loadedCommitReadback unverified migration "${MIGRATION_BACKUP:-none}" keptPaused yes activation "$ACTIVATION_MODE" activationEvidence "$ACTIVATION_EVIDENCE" importProbe "$IMPORT_PROBE" nodeVersion "$node_version"
  echo "deploy complete; host remains paused; loaded commit readback is unavailable (disk hash only)"
  exit 0
fi

# 切换后失败：统一错误路径——恢复 previous／快照，重启，全量健康复检，写记录，非零退出。
target_fail_state="${FAIL_STATE:-unverified}"; target_fail_kind="${FAIL_KIND:-unknown}"
restore_target=""; restore_kind=""
if [ "$previous_valid" = "yes" ]; then
  if [ "$PREVIOUS_LEGACY" = "yes" ] || release_validate "$releases/$previous" "$previous" "$allow_legacy_rollback" >/dev/null 2>&1; then
    restore_target="$releases/$previous/lib"; restore_kind="previous"
  fi
elif [ -n "$SNAP_ROOT" ] && [ -d "$SNAP_ROOT/lib" ]; then
  restore_target="$SNAP_ROOT/lib"; restore_kind="snapshot"
fi
if [ -z "$restore_target" ]; then
  flag=$(paused_flag)
  record deploy deploy failed-no-previous target "$target" previous "$previous" pointerBefore "$pointer_before" pointerAfter "$(pointer_after)" health not-ready migration "${MIGRATION_BACKUP:-none}" migrationRestore "${MIGRATION_RESTORE:-none}" targetFailure "$target_fail_state" targetFailureKind "$target_fail_kind" keptPaused "$flag" error "target failed after switch and no validated previous build exists"
  fail_after_switch "target failed after switch and no validated previous build exists"
fi
if ! set_pointer "$restore_target"; then
  flag=$(paused_flag)
  record deploy deploy failed-twice target "$target" previous "$restore_kind:$restore_target" pointerBefore "$pointer_before" pointerAfter "$(pointer_after)" health not-ready migration "${MIGRATION_BACKUP:-none}" migrationRestore "${MIGRATION_RESTORE:-none}" targetFailure "$target_fail_state" targetFailureKind "$target_fail_kind" restoreFailure "pointer restore to $restore_target failed" restoreFailureKind pointer-restore-failed keptPaused "$flag" error "target failed after switch and restoring previous pointer failed"
  fail_after_switch "target failed after switch and restoring the previous pointer failed"
fi
# 恢复目标可能是 legacy：自动按 health-only 接受并如实记录 unverified-legacy。
LEGACY_ACTIVATION="$allow_legacy_rollback"
if [ "${PREVIOUS_LEGACY:-no}" = "yes" ]; then LEGACY_ACTIVATION="yes"; fi
if recovery_restart_instance; then
  flag=$(paused_flag)
  record deploy deploy failed-restored-previous target "$target" previous "$restore_kind:$restore_target" pointerBefore "$pointer_before" pointerAfter "$(pointer_after)" health not-ready migration "${MIGRATION_BACKUP:-none}" migrationRestore "${MIGRATION_RESTORE:-none}" targetFailure "$target_fail_state" targetFailureKind "$target_fail_kind" restoreHealth all-required-ready keptPaused "$flag" activation "$ACTIVATION_MODE" activationEvidence "$ACTIVATION_EVIDENCE" importProbe "$IMPORT_PROBE" nodeVersion "$node_version" error "target failed after switch; previous build restored"
  fail_after_switch "target failed after switch; previous build restored"
fi
flag=$(paused_flag)
record deploy deploy failed-twice target "$target" previous "$restore_kind:$restore_target" pointerBefore "$pointer_before" pointerAfter "$(pointer_after)" health not-ready migration "${MIGRATION_BACKUP:-none}" migrationRestore "${MIGRATION_RESTORE:-none}" targetFailure "$target_fail_state" targetFailureKind "$target_fail_kind" restoreFailure "${FAIL_STATE:-unverified}" restoreFailureKind "${FAIL_KIND:-unknown}" keptPaused "$flag" error "target and automatic recovery both failed"
fail_after_switch "target and automatic recovery both failed"
