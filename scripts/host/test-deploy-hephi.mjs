#!/usr/bin/env node
// P8 假宿主自动化测试：只使用临时目录、假 start 脚本、假状态响应和临时 git 仓库。
// 不访问 3082/3083，不创建 Issue/PR，不触碰真实 release。
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const repoRoot = resolve(new URL('../..', import.meta.url).pathname)
const script = join(repoRoot, 'scripts/host/deploy-hephi.sh')
const FULL = (c) => c.repeat(40)
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

let failures = 0
const results = []
function check(name, condition, detail = '') {
  if (condition) { results.push(`PASS ${name}`); return }
  failures += 1
  results.push(`FAIL ${name}${detail ? ` :: ${detail}` : ''}`)
}
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout ?? 60_000, env: { ...process.env, ...(opts.env ?? {}) }, cwd: opts.cwd })
  return { code: res.status ?? 1, out: `${res.stdout ?? ''}${res.stderr ?? ''}${res.error ? `spawn-error: ${res.error.message}` : ''}`, signal: res.signal, status: res.status }
}

// 异步执行：deploy 需要访问本进程内起的假宿主 HTTP 服务，同步 spawn 会阻塞事件循环导致假宿主无法应答。
function runAsync(cmd, args, opts = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...(opts.env ?? {}) }, cwd: opts.cwd })
    let out = ''
    let timedOut = false
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { out += chunk })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, opts.timeout ?? 60_000)
    child.on('error', (err) => { clearTimeout(timer); resolveRun({ code: 1, out: `${out}spawn-error: ${err.message}`, signal: null, status: null }) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) out += '\n[harness] timed out'
      resolveRun({ code: code ?? 1, out, signal, status: code })
    })
  })
}

// ---- 可重复的假宿主世界：每次 initWorld() 建独立临时目录 + 独立假宿主服务 ----
let root; let instance; let releases; let repo; let server; let base; let state; let A; let B
let deployEnv = {}

function healthPayload() {
  const ready = () => ({ state: 'ready', detail: 'ready', at: new Date().toISOString() })
  const health = {
    runtime: ready(), relay: ready(), notice: ready(), launch: ready(), delivery: ready(),
    assessment: ready(), reply: ready(), evals: ready(), models: ready(), github: ready(),
  }
  if (state.health === 'github-starting') health.github = { state: 'starting', detail: 'starting', at: new Date().toISOString() }
  if (state.health === 'always-bad') health.github = { state: 'error', detail: state.healthDetail ?? 'boom', at: new Date().toISOString() }
  // 假宿主语义：start.sh 真正跑起来之前（写 started.marker；pauseOnStart 世界还要写 resumed.marker）不报 ready。
  // 否则 deploy 的健康门禁会早于 start.sh 执行就通过，harness 会读到启动前的过渡态（paused 回到 true、
  // 或在进程尚未读取 start.sh 时改写脚本，导致旧进程执行了新脚本）。
  const bootPending = Boolean(state.marker) && !existsSync(state.marker)
  const resumePending = state.pauseOnStart && !existsSync(join(instance, 'resumed.marker'))
  if (bootPending || resumePending) {
    health.runtime = { state: 'starting', detail: 'waiting for start', at: new Date().toISOString() }
  }
  return health
}

// ---- F5：假宿主 marker 必须来自真实 activationMarker()，不能手写字符串对齐部署正则 ----
// hephi 的 engines 要求 Node >= 22.19，可直接导入 TypeScript 源（原生 type stripping）；
// 若真实构建产物存在则优先用 lib，二者生成的都是同一个 activationMarker()。
async function loadRealActivationMarker() {
  const built = join(repoRoot, 'hephi', 'lib', 'version.mjs')
  const source = join(repoRoot, 'hephi', 'src', 'version.ts')
  const file = existsSync(built) ? built : source
  const loaded = await import(pathToFileURL(file).href)
  if (typeof loaded.activationMarker !== 'function') throw new Error(`the real activationMarker() was not found in ${file}`)
  return loaded.activationMarker
}
const realActivationMarker = await loadRealActivationMarker()
// 直接复用 deploy-hephi.sh 里真正执行的 marker 解析正则（F5“同一解析函数”）：
// 不复制第二份手写正则，部署脚本一旦漂移，本套件的格式断言会跟着失败。
function deployActivationMarkerPattern() {
  const source = readFileSync(join(repoRoot, 'scripts', 'host', 'deploy-hephi.sh'), 'utf8')
  const found = /const match = \/(.+)\/\.exec\(raw\.trim\(\)\)/.exec(source)
  if (!found) throw new Error('cannot find the activation marker parser in deploy-hephi.sh')
  return new RegExp(found[1])
}
const ACTIVATION_MARKER_PATTERN = deployActivationMarkerPattern()

// 用真实生成器产出的行做模板：只把两个运行时字段（commit/pid）替换成 shell 展开，
// 字段顺序、前缀、插件名与分隔符全部来自真实 activationMarker()，格式漂移会自动反映到假宿主。
// 源码运行（未构建）时 pluginCommit() 需要 HEPHI_BUILD_COMMIT 才能产出 40hex；真实 release
// 构建由 tsdown 注入 __HEPHI_COMMIT__，此处用哨兵 40hex 模拟“已构建的生成器”。
const MARKER_SENTINEL_COMMIT = FULL('0')
function realMarkerSample(entry) {
  const previous = process.env.HEPHI_BUILD_COMMIT
  process.env.HEPHI_BUILD_COMMIT = MARKER_SENTINEL_COMMIT
  try { return realActivationMarker(entry) } finally {
    if (previous === undefined) delete process.env.HEPHI_BUILD_COMMIT
    else process.env.HEPHI_BUILD_COMMIT = previous
  }
}
function markerShellTemplate(entry, sample) {
  const fields = ACTIVATION_MARKER_PATTERN.exec(sample)
  if (!fields) throw new Error(`the real activationMarker(${entry}) output does not match the deploy parser: ${sample}`)
  // 用 split/join 而不是 String.replace（替换串里的 $$ 会被当成特殊模式，变成单个 $）。
  return sample.split(`commit=${fields[3]}`).join('commit=$sha').split(`pid=${fields[4]}`).join('pid=$$')
}
const realIndexMarkerSample = realMarkerSample('index')
const realToolsMarkerSample = realMarkerSample('tools')
const indexMarkerTemplate = markerShellTemplate('index', realIndexMarkerSample)
const toolsMarkerTemplate = markerShellTemplate('tools', realToolsMarkerSample)

// 格式漂移负例：真实生成器/解析器一旦偏离部署脚本口径，这些断言必须失败（新增负例可反向验证）。
function checkActivationMarkerContract() {
  const real = realIndexMarkerSample
  const concreteIndex = indexMarkerTemplate.replace('$sha', FULL('a')).replace('$$', '4242')
  const concreteTools = toolsMarkerTemplate.replace('$sha', FULL('a')).replace('$$', '4242')
  check('F5 real activationMarker output matches the deploy parser', ACTIVATION_MARKER_PATTERN.test(real), real)
  check('F5 fake-host index marker derived from the real generator matches the deploy parser', ACTIVATION_MARKER_PATTERN.test(concreteIndex), concreteIndex)
  check('F5 fake-host tools marker derived from the real generator matches the deploy parser', ACTIVATION_MARKER_PATTERN.test(concreteTools), concreteTools)
  // 格式漂移负例（测试内构造）：部署脚本必须拒绝这些形状；正例通过而负例不通过才算对齐。
  const drifted = [
    concreteIndex.replace('entry=index', 'entry='), // 缺 entry
    concreteIndex.replace(/commit=[0-9a-f]{40}/, 'commit=unknown'), // commit 非 40hex
    concreteIndex.replace('pid=', 'pid=x'), // pid 非数字
    concreteIndex.replace('plugin=', 'plugin=bad name '), // 插件名含空格
    concreteIndex.replace('[hephi-activation]', '[hephi-activation-x]'), // 前缀漂移
    `${concreteIndex} extra=1`, // 多余字段
  ]
  check('F5 deploy parser rejects every drifted marker format', drifted.every((line) => !ACTIVATION_MARKER_PATTERN.test(line)), JSON.stringify(drifted))
}

function writeStart(scriptBody) {
  const file = join(instance, 'start.sh')
  writeFileSync(file, `#!/bin/sh\n${scriptBody}\n`)
  run('chmod', ['+x', file])
}
function normalStart() {
  const resume = state.pauseOnStart ? `\n: > "${instance}/resumed.marker"` : ''
  writeStart(`echo started >> "${instance}/start.log"\n${activationMarkers()}\n: > "${instance}/started.marker"${resume}\nexec sleep 3600`)
}

// 假宿主激活标识：行内容由真实 activationMarker() 模板生成（F5），start.sh 只负责在运行时
// 填入当前指针 SHA 与自身 pid；不再手写任何 marker 字符串。
function activationMarkers() {
  return [
    `sha=$(basename "$(dirname "$(readlink "${instance}/hephi/lib")")")`,
    `echo "${indexMarkerTemplate}"`,
    `echo "${toolsMarkerTemplate}"`,
  ].join('\n')
}

// 普通目录迁移/恢复失败注入：只在 deploy 的 PATH 前置一个 node 垫片，第 N 次 renameSync 调用失败。
function nodeShimSource() {
  return [
    '#!/bin/sh',
    'if [ -n "${HARNESS_RENAME_FAIL_AT:-}" ]; then',
    '  case "$*" in',
    '    *renameSync*)',
    '      n=$(cat "$HARNESS_RENAME_COUNTER" 2>/dev/null || echo 0)',
    '      n=$((n + 1))',
    '      printf "%s" "$n" > "$HARNESS_RENAME_COUNTER"',
    '      if [ "$n" = "$HARNESS_RENAME_FAIL_AT" ]; then echo "injected pointer rename failure" >&2; exit 42; fi',
    '      ;;',
    '  esac',
    'fi',
    'exec "$HARNESS_REAL_NODE" "$@"',
    '',
  ].join('\n')
}

// 旧普通 lib 目录恢复 mv 失败注入：只在 deploy 的 PATH 前置一个 mv 垫片。
// 仅当「源参数含 .migration- 且目标参数等于实载 lib 路径」时失败，即 set_pointer 的恢复 mv。
function mvShimSource() {
  return [
    '#!/bin/sh',
    'first="$1"; last=""',
    'for a in "$@"; do last="$a"; done',
    'if [ -n "${HARNESS_MV_BLOCK_SOURCE_TAG:-}" ] && [ -n "${HARNESS_MV_BLOCK_TARGET:-}" ]; then',
    '  case "$first" in',
    '    *"$HARNESS_MV_BLOCK_SOURCE_TAG"*)',
    '      if [ "$last" = "$HARNESS_MV_BLOCK_TARGET" ]; then echo "injected old-lib restore mv failure" >&2; exit 1; fi',
    '      ;;',
    '  esac',
    'fi',
    'exec /bin/mv "$@"',
    '',
  ].join('\n')
}

async function initWorld(options = {}) {
  const { plainLib = false, pauseOnStart = false } = options
  deployEnv = {}
  root = mkdtempSync(join(tmpdir(), 'hephi-r3-'))
  instance = join(root, 'instance')
  releases = join(instance, 'releases', 'hephi')
  repo = join(root, 'repo')
  const bin = join(root, 'bin')
  for (const dir of [instance, join(instance, 'logs'), join(instance, 'hephi'), releases, repo, join(repo, 'hephi'), bin]) mkdirSync(dir, { recursive: true })
  // 实载插件目录契约（deploy-hephi.sh 的 --hephi 校验）：目录本身必须有 package.json，
  // 且 name 为 hephi-superagent-plugin；lib 才是指向不可变 release 的指针。
  writeFileSync(join(instance, 'hephi', 'package.json'), JSON.stringify({
    name: 'hephi-superagent-plugin', version: '0.0.0', private: true,
  }, null, 2))
  if (plainLib) {
    mkdirSync(join(instance, 'hephi', 'lib'), { recursive: true })
    writeFileSync(join(instance, 'hephi', 'lib', 'legacy.mjs'), 'export const legacy = 1\n')
  }
  writeFileSync(join(bin, 'node'), nodeShimSource())
  run('chmod', ['+x', join(bin, 'node')])
  writeFileSync(join(bin, 'mv'), mvShimSource())
  run('chmod', ['+x', join(bin, 'mv')])

  state = {
    paused: true,
    load: { running: 0, queued: 0, startupReservations: 0, effects: 0, jobs: 0, subagents: 0, unknown: 0 },
    tickets: 0,
    health: 'ok',
    healthDetail: null,
    failState: false,
    onState: null,
    marker: null,
    pauseOnStart,
  }
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/orchestrator/api/state') {
      // 场景钩子：按当前指针/阶段切换假宿主行为（例如 target 阶段坏健康、restore 阶段 /state 全部 503）。
      if (state.onState) state.onState()
      if (state.failState) { res.statusCode = 503; res.end('{}'); return }
      const resumed = state.pauseOnStart && existsSync(join(instance, 'resumed.marker'))
      res.end(JSON.stringify({ paused: resumed ? false : state.paused, load: state.load, health: healthPayload() }))
      return
    }
    if (url.pathname === '/orchestrator/api/tickets') {
      res.end(JSON.stringify(Array.from({ length: state.tickets }, (_, i) => ({ id: `t${i}` }))))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })

  writeStart('#!/bin/sh\nexit 1') // placeholder before scenarios
  writeFileSync(join(instance, 'host.pid'), '999999\n')
  normalStart()
  state.marker = join(instance, 'started.marker')

  // stub plugin repository: git archive + frozen install + pnpm check must succeed.
  // 真实生产依赖（file: 本地包）用于验证发布包依赖打包；不访问网络，离线可复现。
  writeFileSync(join(repo, 'hephi', 'package.json'), JSON.stringify({
    name: 'stub-hephi', version: '0.0.0', private: true, type: 'module',
    dependencies: { 'stub-dep': 'file:./vendor/stub-dep' },
    scripts: { check: 'node build.mjs' },
  }, null, 2))
  mkdirSync(join(repo, 'hephi', 'vendor', 'stub-dep'), { recursive: true })
  writeFileSync(join(repo, 'hephi', 'vendor', 'stub-dep', 'package.json'), JSON.stringify({ name: 'stub-dep', version: '1.0.0', type: 'module', main: 'index.js' }, null, 2))
  writeFileSync(join(repo, 'hephi', 'vendor', 'stub-dep', 'index.js'), "export const VALUE = 'stub-dep-ok'\n")
  writeFileSync(join(repo, 'hephi', 'build.mjs'), [
    "import { mkdirSync, writeFileSync } from 'node:fs'",
    "mkdirSync('lib', { recursive: true })",
    "writeFileSync('lib/index.mjs', `import { VALUE } from 'stub-dep'\\nexport function describePlugin(){return {name:'stub',version:'0.0.0',commit:${JSON.stringify(process.env.HEPHI_BUILD_COMMIT ?? 'unknown')},dep:VALUE}}\\nexport function apply(){}\\n`)",
    "writeFileSync('lib/tools.mjs', `export const name = 'stub/tools'\\nexport function apply(){}\\n`)",
    '',
  ].join('\n'))
  const stubLockfile = run('pnpm', ['install', '--lockfile-only', '--offline'], { cwd: join(repo, 'hephi') })
  if (!existsSync(join(repo, 'hephi', 'pnpm-lock.yaml'))) throw new Error(`stub lockfile was not generated: ${stubLockfile.out}`)
  run('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo })
  run('git', ['config', 'user.name', 'deploy test'], { cwd: repo })
  run('git', ['add', '.'], { cwd: repo })
  run('git', ['commit', '-q', '-m', 'A'], { cwd: repo })
  A = run('git', ['rev-parse', 'HEAD'], { cwd: repo }).out.trim()
  writeFileSync(join(repo, 'hephi', 'VERSION.txt'), 'B\n')
  run('git', ['add', '.'], { cwd: repo })
  run('git', ['commit', '-q', '-m', 'B'], { cwd: repo })
  B = run('git', ['rev-parse', 'HEAD'], { cwd: repo }).out.trim()

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  base = `http://127.0.0.1:${server.address().port}`
}

function killPid(pid) {
  try { if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
}
function readPid(file) {
  try { return Number(readFileSync(file, 'utf8').trim()) } catch { return 0 }
}
async function closeWorld() {
  // 清理本世界启动的真实假宿主/子进程/effect writer，避免 sleep 进程泄漏。
  for (const file of [join(instance ?? '', 'host.pid'), join(instance ?? '', 'child.pid'), join(root ?? '', 'late-writer.pid'), join(root ?? '', 'auto-restart.pid')]) killPid(readPid(file))
  if (server) { await new Promise((resolveClose) => server.close(resolveClose)); server = null }
  if (root) { rmSync(root, { recursive: true, force: true }) }
  deployEnv = {}
}

// ---- F-02：§4.5 停机式排空夹具（真实 WAL effects 库 + 真实进程模拟停机）----
function effectsDbPath() { return join(instance, 'state', 'orchestrator.sqlite') }
function createEffectsDatabase(rows = 0) {
  mkdirSync(join(instance, 'state'), { recursive: true })
  const db = new DatabaseSync(effectsDbPath())
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA wal_autocheckpoint=0')
  db.exec('CREATE TABLE IF NOT EXISTS effect(kind TEXT)')
  for (let index = 0; index < rows; index += 1) db.exec("INSERT INTO effect VALUES ('started')")
  return db
}
function hostPidValue() { return readPid(join(instance, 'host.pid')) }
function pidAlive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true } catch { return false } }
function writeHook(name, body) {
  const file = join(root, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  run('chmod', ['+x', file])
  return file
}
// 假宿主由测试用 `nohup ... &` 异步拉起。--drain effects 现在强制要求 --stop-command
// （默认 SIGINT 路径已删除），所有场景都通过 stop hook 发送 SIGTERM 模拟宿主 stop 脚本；
// 真实停机方式由 H0 用 dsh-superagent stop CLI 验证，不是 SIGINT。
function defaultStopHook() {
  return writeHook('stop-term.sh', [`pid=$(cat "${join(instance, 'host.pid')}")`, 'kill -TERM "$pid" 2>/dev/null || true', 'exit 0'].join('\n'))
}
function effectsDeployArgs(extra = [], options = {}) {
  const stop = extra.includes('--stop-command') ? [] : ['--stop-command', defaultStopHook()]
  const wait = options.waitSeconds === undefined ? [] : ['--auto-restart-wait', String(options.waitSeconds)]
  return ['--drain', 'effects', '--target', B, '--previous', A, '--effects-db', effectsDbPath(), '--stop-timeout', '2', ...stop, ...wait, ...extra]
}

async function deploy(extra, timeout = 120_000) {
  const flags = process.env.HARNESS_DEBUG ? ['-x', script] : [script]
  return runAsync('sh', [...flags, '--instance', instance, '--host', base, '--host-version', 'host-1.0.0', '--repo', repo, '--hephi', join(instance, 'hephi'), '--releases', releases, '--timeout', '6', '--node', process.execPath, ...extra], { timeout, env: deployEnv })
}
// 不传 --hephi（验证默认值缺失时的 fail-closed UX）。
async function deployWithoutHePhi(extra = [], timeout = 60_000) {
  const flags = process.env.HARNESS_DEBUG ? ['-x', script] : [script]
  return runAsync('sh', [...flags, '--instance', instance, '--host', base, '--host-version', 'host-1.0.0', '--repo', repo, '--releases', releases, '--timeout', '6', '--node', process.execPath, ...extra], { timeout, env: deployEnv })
}
// 模拟“当前实载版本是 legacy”：直接把指针指向该 release（不改运行中的假宿主）。
function pointAt(sha) {
  const link = join(instance, 'hephi', 'lib')
  rmSync(link, { force: true })
  symlinkSync(join(releaseDir(sha), 'lib'), link)
}
function pointer() { try { return readlinkSync(join(instance, 'hephi', 'lib')) } catch { return '' } }
function releaseDir(sha) { return join(releases, sha) }
async function waitForStarts(expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (starts() < expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
  }
  return starts()
}
function starts() { return existsSync(join(instance, 'start.log')) ? readFileSync(join(instance, 'start.log'), 'utf8').trim().split('\n').filter(Boolean).length : 0 }
function readRecords(kind) {
  const dir = join(instance, 'logs')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json') && (!kind || name.startsWith(`${kind}-`)))
    .map((name) => { try { return JSON.parse(readFileSync(join(dir, name), 'utf8')) } catch { return null } })
    .filter(Boolean)
}
function commitRepo(message) {
  run('git', ['add', '.'], { cwd: repo })
  const commit = run('git', ['commit', '-q', '-m', message], { cwd: repo })
  if (commit.code !== 0) throw new Error(`cannot commit stub repo: ${commit.out}`)
  return run('git', ['rev-parse', 'HEAD'], { cwd: repo }).out.trim()
}
function legacyRelease(sha) {
  const dir = join(releases, sha)
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'lib', 'index.mjs'), 'export function describePlugin(){ return { name: "legacy", version: "0.0.0", commit: "legacy" } }\n')
  writeFileSync(join(dir, 'lib', 'tools.mjs'), 'export function apply() {}\n')
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    formatVersion: 1, pluginCommit: sha, sourceTree: sha, entrySha256: sha256(join(dir, 'lib', 'index.mjs')),
    builtAt: new Date().toISOString(), buildCommand: 'legacy release fixture', hostVersion: 'host-1.0.0', source: 'legacy-fixture',
  }, null, 2))
  return dir
}
function renameFailEnv(at) {
  const counter = join(root, 'rename-counter')
  writeFileSync(counter, '0')
  return {
    PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
    HARNESS_RENAME_FAIL_AT: String(at),
    HARNESS_RENAME_COUNTER: counter,
    HARNESS_REAL_NODE: process.execPath,
  }
}
// N1c/X3：迁移第二步（symlink rename）失败 + 旧普通目录恢复 mv 也失败的双重故障注入。
function migrationRestoreFailEnv() {
  const counter = join(root, 'rename-counter')
  writeFileSync(counter, '0')
  return {
    PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
    HARNESS_RENAME_FAIL_AT: '1',
    HARNESS_RENAME_COUNTER: counter,
    HARNESS_REAL_NODE: process.execPath,
    HARNESS_MV_BLOCK_SOURCE_TAG: '.migration-',
    HARNESS_MV_BLOCK_TARGET: join(instance, 'hephi', 'lib'),
  }
}
function treeHash(dir) {
  const rows = []
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      const stat = lstatSync(p)
      if (stat.isSymbolicLink()) rows.push(`${p.slice(dir.length)}:link:${readlinkSync(p)}`)
      else if (stat.isDirectory()) walk(p)
      else rows.push(`${p.slice(dir.length)}:${sha256(p)}`)
    }
  }
  walk(dir)
  return createHash('sha256').update(rows.join('\n')).digest('hex')
}

async function runMainSuite() {
  checkActivationMarkerContract()
  await initWorld()
  try {
    // R3-T01 首次发布
  const t1 = await deploy(['--target', A])
  check('R3-T01 first publish exits 0', t1.code === 0, JSON.stringify(t1))
  await waitForStarts(1)
  if (!existsSync(join(releaseDir(A), 'meta.json'))) {
    console.log('--- first publish output ---\n' + t1.out)
    throw new Error('first publish did not create a release')
  }
  const metaA = JSON.parse(readFileSync(join(releaseDir(A), 'meta.json'), 'utf8'))
  check('R3-T01 release A lib exists', existsSync(join(releaseDir(A), 'lib', 'index.mjs')))
  check('R3-T01 meta fields complete', metaA.formatVersion === 2 && metaA.pluginCommit === A && /^[0-9a-f]{64}$/.test(metaA.entrySha256) && metaA.hostVersion === 'host-1.0.0' && /^[0-9a-f]{40}$/.test(metaA.sourceTree) && typeof metaA.builtAt === 'string' && metaA.buildCommand.includes('pnpm check'), JSON.stringify(metaA))
  check('R3-T01 pointer points to release A', pointer() === join(releaseDir(A), 'lib'), pointer())
  // T1：发布包自带同一冻结 lockfile 的生产依赖，且源码工作区 node_modules 不参与。
  const lockfileA = join(repo, 'hephi', 'pnpm-lock.yaml')
  check('T1 release A packages the frozen production dependency', existsSync(join(releaseDir(A), 'node_modules', 'stub-dep', 'package.json')) && existsSync(join(releaseDir(A), 'package.json')) && existsSync(join(releaseDir(A), 'pnpm-lock.yaml')), JSON.stringify(metaA.dependencies))
  check('T1 release A records dependency provenance', metaA.dependencies && metaA.dependencies.lockfileSha256 === sha256(lockfileA) && metaA.dependencies.resolved['stub-dep'] === '1.0.0' && /^[0-9a-f]{64}$/.test(String(metaA.dependencies.nodeModulesSha256)), JSON.stringify(metaA.dependencies))
  check('T1 release A records entry hashes for index and tools', metaA.entries && metaA.entries.index === sha256(join(releaseDir(A), 'lib', 'index.mjs')) && metaA.entries.tools === sha256(join(releaseDir(A), 'lib', 'tools.mjs')), JSON.stringify(metaA.entries))
  check('T1 release A declares the two-entry activation marker', metaA.activation && metaA.activation.markerVersion === 1 && metaA.activation.entries.join(',') === 'index,tools', JSON.stringify(metaA.activation))
  check('T1 source archive has no node_modules', !existsSync(join(repo, 'hephi', 'node_modules')), join(repo, 'hephi', 'node_modules'))
  const importCheck = run(process.execPath, ['--input-type=module', '-e', `
import { readFileSync } from 'node:fs'
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const index = await import('./lib/index.mjs')
const tools = await import('./lib/tools.mjs')
const resolved = {}
for (const name of Object.keys(pkg.dependencies ?? {})) resolved[name] = import.meta.resolve(name)
process.stdout.write(JSON.stringify({ commit: index.describePlugin().commit, dep: index.describePlugin().dep, toolsApply: typeof tools.apply, deps: Object.keys(resolved) }))
`], { cwd: releaseDir(A) })
  check('T1 published release imports index/tools and resolves deps outside the source tree', importCheck.code === 0 && JSON.parse(importCheck.out).commit === A && JSON.parse(importCheck.out).dep === 'stub-dep-ok' && JSON.parse(importCheck.out).toolsApply === 'function' && JSON.parse(importCheck.out).deps.includes('stub-dep'), importCheck.out)

  // R3-T02 同 SHA 重发
  writeFileSync(join(releaseDir(A), 'sentinel'), 'keep')
  const hashA = treeHash(releaseDir(A))
  const startsBefore = starts()
  const t2 = await deploy(['--target', A])
  check('R3-T02 republish fails', t2.code !== 0 && /already loaded and immutable/.test(t2.out), t2.out)
  check('R3-T02 sentinel and release unchanged', existsSync(join(releaseDir(A), 'sentinel')) && treeHash(releaseDir(A)) === hashA)
  check('R3-T02 no restart', starts() === startsBefore, `starts ${startsBefore} -> ${starts()}`)

  // R3-T03 target 缺失
  const missing = FULL('f')
  const t3 = await deploy(['--target', missing])
  check('R3-T03 missing target fails before switch', t3.code !== 0 && pointer() === join(releaseDir(A), 'lib') && starts() === startsBefore, `code=${t3.code} starts ${startsBefore}->${starts()} ${t3.out}`)

  // R3-T04 meta commit 与目录不符
  const badMeta = join(releases, FULL('a'))
  mkdirSync(join(badMeta, 'lib'), { recursive: true })
  const metaCopy = { ...metaA, pluginCommit: A }
  writeFileSync(join(badMeta, 'lib', 'index.mjs'), readFileSync(join(releaseDir(A), 'lib', 'index.mjs')))
  writeFileSync(join(badMeta, 'meta.json'), JSON.stringify(metaCopy))
  const t4 = await deploy(['--target', FULL('a')])
  check('R3-T04 meta/dir SHA mismatch rejected', t4.code !== 0 && pointer() === join(releaseDir(A), 'lib') && starts() === startsBefore, `code=${t4.code} starts ${startsBefore}->${starts()} ${t4.out}`)

  // R3-T05 内容篡改
  const tampered = join(releases, FULL('b'))
  mkdirSync(join(tampered, 'lib'), { recursive: true })
  writeFileSync(join(tampered, 'lib', 'index.mjs'), 'tampered')
  writeFileSync(join(tampered, 'meta.json'), JSON.stringify({ ...metaA, pluginCommit: FULL('b') }))
  const t5 = await deploy(['--target', FULL('b')])
  check('R3-T05 content tamper rejected', t5.code !== 0 && /entry hash mismatch/.test(t5.out), t5.out)

  // R3-T06 A → B 正常切换
  const t6 = await deploy(['--target', B, '--previous', A])
  check('R3-T06 switch to B exits 0', t6.code === 0, t6.out)
  check('R3-T06 pointer is B', pointer() === join(releaseDir(B), 'lib'), pointer())
  check('R3-T06 release A unchanged', treeHash(releaseDir(A)) === hashA)
  const hashB = treeHash(releaseDir(B))

  // R3-T07 B → A 顺序回切
  const t7 = await deploy(['--target', A, '--previous', B])
  check('R3-T07 switch back to A exits 0', t7.code === 0, t7.out)
  check('R3-T07 pointer is A; both immutable', pointer() === join(releaseDir(A), 'lib') && treeHash(releaseDir(A)) === hashA && treeHash(releaseDir(B)) === hashB)

  // R3-T11 dry-run
  const startsDry = starts()
  const t11 = await deploy(['--target', B, '--dry-run'])
  check('R3-T11 dry-run exits 0 and does not switch/restart', t11.code === 0 && /dry-run/.test(t11.out) && pointer() === join(releaseDir(A), 'lib') && starts() === startsDry, t11.out)

  // R3-T12 进行中 Ticket
  state.tickets = 1
  const t12 = await deploy(['--target', B, '--previous', A])
  check('R3-T12 open tickets refuse', t12.code !== 0 && /open Tickets/.test(t12.out), t12.out)
  state.tickets = 0

  // R3-T13 移除绕过入口
  const t13 = await deploy(['--target', B, '--allow-open-tickets'])
  check('R3-T13 --allow-open-tickets is an unknown argument', t13.code === 2 && /unknown argument/.test(t13.out), t13.out)

  // R3-T13b T20 事故回归：--skip-tests 分支曾漏掉 shift，参数解析 while 循环对其永不消耗，
  // 纯内建空转（无子进程/无 sleep/高 CPU）。回归判据：带 --skip-tests 的调用必须快速到达
  // 正常校验并 exit 2（这里给不存在的 instance 目录），而不是挂死到超时。
  const t13b = run('sh', [script, '--instance', join(tmpdir(), 'hephi-missing-instance'), '--host', base, '--host-version', 'probe', '--skip-tests'], { timeout: 20_000 })
  check('R3-T13b --skip-tests is consumed by the argument loop (no infinite spin)', t13b.code === 2 && /instance directory not found/.test(t13b.out) && t13b.status === 2, `code=${t13b.code} status=${t13b.status} signal=${t13b.signal} ${t13b.out.slice(0, 120)}`)

  // R3-T14 hostVersion 必填
  const t14a = run('sh', [script, '--instance', instance, '--host', base, '--repo', repo, '--hephi', join(instance, 'hephi'), '--releases', releases, '--target', B], { timeout: 120_000 })
  const t14b = run('sh', [script, '--instance', instance, '--host', base, '--host-version', '', '--repo', repo, '--hephi', join(instance, 'hephi'), '--releases', releases, '--target', B], { timeout: 120_000 })
  check('R3-T14 missing/empty hostVersion rejected', t14a.code === 2 && t14b.code === 2 && pointer() === join(releaseDir(A), 'lib'), `${t14a.code}/${t14b.code}`)

  // R3-T15 drain 字段：分别非零/未知都拒绝
  const baseLoad = { ...state.load }
  for (const field of ['running', 'queued', 'startupReservations', 'effects', 'jobs', 'subagents', 'unknown']) {
    state.load = { ...baseLoad, [field]: 1 }
    const res = await deploy(['--target', B, '--previous', A])
    check(`R3-T15 nonzero ${field} refused`, res.code !== 0 && res.out.includes(field), res.out)
    state.load = { ...baseLoad }
    delete state.load[field]
    const unknown = await deploy(['--target', B, '--previous', A])
    check(`R3-T15 unknown ${field} refused`, unknown.code !== 0 && unknown.out.includes(field), unknown.out)
    state.load = { ...baseLoad }
  }

  // R3-T08 重启失败自动恢复 previous
  state.health = 'marker'
  writeStart(`echo attempt >> "${instance}/start.log"
if [ ! -f "${instance}/fail-once-used" ]; then : > "${instance}/fail-once-used"; exit 1; fi
${activationMarkers()}
: > "${instance}/started.marker"
exec sleep 3600`)
  rmSync(join(instance, 'started.marker'), { force: true })
  const t8 = await deploy(['--target', B, '--previous', A])
  check('R3-T08 restart failure exits nonzero', t8.code !== 0, t8.out)
  check('R3-T08 auto-restores A and stays paused', pointer() === join(releaseDir(A), 'lib') && /previous build restored/.test(t8.out), `${pointer()} ${t8.out}`)
  state.health = 'ok'
  normalStart()

  // R3-T09 健康失败（github=starting）自动恢复
  state.health = 'github-starting'
  // 让目标 B 的切换阶段健康失败；恢复 A 后需要健康通过，用临时切换窗口模拟：先坏 1.5 秒
  const startedAt = Date.now()
  const origHealth = healthPayload
  // 简化：用 always-bad 模拟目标阶段失败，恢复阶段仍失败会走 T10；这里单独用 github-starting 并手动放行恢复：改为先失败一次
  state.health = 'github-starting'
  const t9 = await deploy(['--target', B, '--previous', A], 120_000)
  check('R3-T09 github=starting is not accepted as success', t9.code !== 0, t9.out)
  check('R3-T09 pointer restored to A', pointer() === join(releaseDir(A), 'lib'), pointer())
  state.health = 'ok'

  // R3-T10 回滚也失败
  state.health = 'always-bad'
  const t10 = await deploy(['--target', B, '--previous', A])
  check('R3-T10 double failure exits nonzero', t10.code !== 0, t10.out)
  check('R3-T10 stays paused with both attempts recorded', /both failed|kept paused/.test(t10.out))
  state.health = 'ok'

  // R3-T17 记录完整
  const logs = readdirSync(join(instance, 'logs')).filter((name) => name.endsWith('.json'))
  const records = logs.map((name) => JSON.parse(readFileSync(join(instance, 'logs', name), 'utf8')))
  const okDeploy = records.find((r) => r.action === 'deploy' && r.result === 'ok' && r.target === B && r.previous === A)
  const failedDeploy = records.find((r) => r.action === 'deploy' && r.result !== 'ok')
  check('R3-T17 success record complete', okDeploy && okDeploy.target === B && okDeploy.previous === A && okDeploy.hostVersion === 'host-1.0.0' && okDeploy.health === 'all-required-ready' && okDeploy.paused === true && typeof okDeploy.at === 'string', JSON.stringify(okDeploy))
  check('R3-T17 failure record complete', failedDeploy && typeof failedDeploy.target === 'string' && failedDeploy.hostVersion === 'host-1.0.0' && typeof failedDeploy.at === 'string', JSON.stringify(failedDeploy))
  check('R3-T17 success record uses real paused/load/health readback', okDeploy && okDeploy.paused === true && okDeploy.load && okDeploy.load.running === 0 && okDeploy.healthReadback && Object.keys(okDeploy.healthReadback).length === 10 && okDeploy.healthReadback.github.state === 'ready', JSON.stringify(okDeploy))
  check('T1 success record keeps activation and import-probe evidence', Boolean(okDeploy) && okDeploy.activation === 'verified' && /"ok":true/.test(String(okDeploy.importProbe)) && String(okDeploy.activationEvidence).includes('index') && okDeploy.nodeVersion === process.version, JSON.stringify(okDeploy && { activation: okDeploy.activation, importProbe: okDeploy.importProbe, nodeVersion: okDeploy.nodeVersion }))
  const restoredDeploy = records.find((r) => r.action === 'deploy' && r.result === 'failed-restored-previous')
  check('R3-T08 restored record keeps both health evidences', restoredDeploy && restoredDeploy.restoreHealth === 'all-required-ready' && String(restoredDeploy.targetFailure).length > 2 && restoredDeploy.paused === true, JSON.stringify(restoredDeploy))

  // R3-T06/T16 不可变性总校验
  check('R3-T16 releases A/B unchanged after all scenarios', treeHash(releaseDir(A)) === hashA && treeHash(releaseDir(B)) === hashB)

  // R3-T07 rollback 子命令（显式 target）
  const tRollback = await deploy(['--rollback', '--target', B, '--previous', A])
  check('R3-T07b explicit rollback exits 0', tRollback.code === 0, tRollback.out)
  check('R3-T07b rollback record exists', readdirSync(join(instance, 'logs')).some((name) => name.startsWith('rollback-') && name.endsWith('.json')))
  } finally {
    await closeWorld()
  }
}

async function runNegativeSuite() {
  // N1：首次从普通 lib 目录迁移必须成功，旧内容保留在迁移备份中
  await initWorld({ plainLib: true })
  try {
    const r = await deploy(['--target', A])
    check('N1 plain-lib first deploy exits 0', r.code === 0, r.out)
    check('N1 lib becomes symlink to release A', pointer() === join(releaseDir(A), 'lib'), pointer())
    // set_pointer 的迁移事务把旧普通 lib 目录整体改名到 $hephi/.migration-<ts>-<pid>，备份根即旧 lib 内容。
    const backup = existsSync(join(instance, 'hephi')) ? readdirSync(join(instance, 'hephi')).find((name) => name.startsWith('.migration-')) : undefined
    check('N1 migration backup keeps old lib content', Boolean(backup) && existsSync(join(instance, 'hephi', backup, 'legacy.mjs')) && readFileSync(join(instance, 'hephi', backup, 'legacy.mjs'), 'utf8') === 'export const legacy = 1\n', String(backup))
    const rec = readRecords('deploy').find((x) => x.result === 'ok')
    check('N1 success record keeps migration evidence', Boolean(rec) && String(rec.migration).includes('.migration-'), JSON.stringify(rec))
  } finally {
    await closeWorld()
  }

  // N1b：迁移第二步（symlink rename）失败时必须恢复旧普通目录，且不留失败指针
  await initWorld({ plainLib: true })
  try {
    deployEnv = renameFailEnv(1)
    const r = await deploy(['--target', A])
    check('N1b migration rename failure exits nonzero', r.code !== 0, `code=${r.code} ${r.out}`)
    const libStat = lstatSync(join(instance, 'hephi', 'lib'))
    check('N1b old plain lib directory restored', libStat.isDirectory() && !libStat.isSymbolicLink() && existsSync(join(instance, 'hephi', 'lib', 'legacy.mjs')))
    check('N1b failure record written', readRecords('deploy').some((x) => x.result === 'failed-pointer'), JSON.stringify(readRecords('deploy')))
  } finally {
    await closeWorld()
  }

  // N2：rollback 缺 target／空 target／非法 SHA 一律拒绝且无副作用
  await initWorld()
  try {
    const first = await deploy(['--target', A])
    check('N2 setup: release A loaded', first.code === 0 && pointer() === join(releaseDir(A), 'lib'), first.out)
    const before = pointer()
    const startsBefore = starts()
    const recordsBefore = readRecords().length
    const r1 = await deploy(['--rollback', '--previous', A])
    check('N2 rollback without --target rejected', r1.code !== 0 && /--target/.test(r1.out), r1.out)
    const r2 = await deploy(['--rollback', '--target', '', '--previous', A])
    check('N2 empty rollback target rejected', r2.code !== 0 && /full 40-char SHA/.test(r2.out), r2.out)
    const r3 = await deploy(['--rollback', '--target', 'abc', '--previous', A])
    check('N2 invalid rollback target rejected', r3.code !== 0 && /full 40-char SHA/.test(r3.out), r3.out)
    check('N2 rejected rollbacks have no side effects', pointer() === before && starts() === startsBefore && readRecords().length === recordsBefore, `pointer=${pointer()} starts=${starts()} records=${readRecords().length}`)
  } finally {
    await closeWorld()
  }

  // N3：无 current 指针时用显式 --previous 恢复，且只在真正恢复后才写 failed-restored-previous
  await initWorld()
  try {
    await deploy(['--target', A])
    await deploy(['--target', B])
    await deploy(['--target', A])
    rmSync(join(instance, 'hephi', 'lib'))
    mkdirSync(join(instance, 'hephi', 'lib'), { recursive: true })
    state.health = 'marker'
    writeStart(`echo attempt >> "${instance}/start.log"
if [ ! -f "${instance}/fail-once-used" ]; then : > "${instance}/fail-once-used"; exit 1; fi
${activationMarkers()}
: > "${instance}/started.marker"
exec sleep 3600`)
    rmSync(join(instance, 'started.marker'), { force: true })
    const r = await deploy(['--rollback', '--target', B, '--previous', A])
    check('N3 rollback failure exits nonzero', r.code !== 0, r.out)
    const rec = readRecords('rollback').find((x) => x.result === 'failed-restored-previous')
    check('N3 restore record only after real pointer restore', Boolean(rec) && pointer() === join(releaseDir(A), 'lib') && String(rec.previous).startsWith('previous:'), `${pointer()} ${JSON.stringify(rec)}`)
    check('N3 record keeps target failure health evidence', Boolean(rec) && String(rec.targetFailure).includes('health'), JSON.stringify(rec))
    check('N3 record keeps restore health evidence', Boolean(rec) && rec.restoreHealth === 'all-required-ready', JSON.stringify(rec))
  } finally {
    await closeWorld()
  }

  // N4：恢复阶段 rename 失败不得绕过双失败记录（不得以 42 原始退出）
  await initWorld()
  try {
    await deploy(['--target', A])
    state.health = 'marker'
    writeStart(`echo attempt >> "${instance}/start.log"
if [ ! -f "${instance}/fail-once-used" ]; then : > "${instance}/fail-once-used"; exit 1; fi
${activationMarkers()}
: > "${instance}/started.marker"
exec sleep 3600`)
    rmSync(join(instance, 'started.marker'), { force: true })
    deployEnv = renameFailEnv(2)
    const r = await deploy(['--target', B, '--previous', A])
    if (process.env.HARNESS_DEBUG) console.error('N4 deploy:', JSON.stringify(r))
    check('N4 recovery rename failure exits nonzero without raw 42', r.code !== 0 && r.code !== 42, `code=${r.code} ${r.out}`)
    const rec = readRecords('deploy').find((x) => x.result === 'failed-twice')
    check('N4 double-failure record written', Boolean(rec), JSON.stringify(readRecords('deploy')))
    check('N4 record keeps both failure evidences', Boolean(rec) && String(rec.targetFailure).length > 2 && String(rec.restoreFailure).includes('pointer restore'), JSON.stringify(rec))
    check('N4 double-failure record keeps real paused readback', Boolean(rec) && rec.paused === true, JSON.stringify(rec))
  } finally {
    await closeWorld()
  }

  // N5：成功路径必须回读真实 paused，不得硬编码 true
  await initWorld({ pauseOnStart: true })
  try {
    const r = await deploy(['--target', A])
    if (process.env.HARNESS_DEBUG) console.error('N5 deploy:', JSON.stringify(r), 'pointer=', pointer(), 'records=', JSON.stringify(readRecords('deploy')))
    check('N5 deploy refuses success when host is not paused', r.code !== 0, r.out)
    const rec = readRecords('deploy').find((x) => x.result === 'failed-not-paused')
    check('N5 record uses real paused readback (false)', Boolean(rec) && rec.paused === false, JSON.stringify(rec))
    check('N5 record keeps health readback', Boolean(rec) && rec.healthReadback && rec.healthReadback.runtime && rec.healthReadback.runtime.state === 'ready', JSON.stringify(rec))
  } finally {
    await closeWorld()
  }
}

// R3.8 返修回归：X1–X3（独立复核发现的双失败语义缺陷）+ P1–P3（外部验证后纳入自动化）。
// 每个场景使用独立世界；假宿主只按「当前指针/阶段」切换行为，不给产品脚本留任何后门。
async function runRemediationSuite() {
  // X1：目标与恢复都健康失败，且假宿主真实返回 paused=false。
  // 失败出口必须回读 paused；不得声称 kept paused，记录 keptPaused=no 与真实 paused。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    if (setup.code !== 0) { check('X1 setup deploys A', false, setup.out); return }
    let targetSeen = false
    state.onState = () => {
      if (pointer() === join(releaseDir(B), 'lib')) targetSeen = true
      if (targetSeen) { state.paused = false; state.health = 'always-bad'; state.healthDetail = 'x1-target-failure' }
    }
    const r = await deploy(['--target', B, '--previous', A, '--timeout', '3'])
    const rec = readRecords('deploy').find((x) => x.result === 'failed-twice')
    check('X1 double failure exits nonzero', r.code !== 0, `code=${r.code} ${r.out}`)
    check('X1 failed-twice keeps real paused=false', Boolean(rec) && rec.paused === false, JSON.stringify(rec))
    check('X1 output does not claim kept paused', !/kept paused/.test(r.out), r.out)
    check('X1 output/record flags host not confirmed paused', /not confirmed paused|NOT confirmed paused|manual takeover/i.test(r.out) || /not confirmed paused|NOT confirmed paused|manual takeover/i.test(String(rec?.error ?? '')), `out=${r.out} rec=${JSON.stringify(rec)}`)
    check('X1 record keeps keptPaused=no', Boolean(rec) && (rec.keptPaused === 'no' || rec.keptPaused === false), JSON.stringify(rec))
  } finally {
    await closeWorld()
  }

  // X2：目标阶段健康失败产生可读状态；恢复阶段 /state 全部不可读（503）。
  // 两次失败必须是独立证据：restoreFailure 不得复用目标阶段字符串。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    if (setup.code !== 0) { check('X2 setup deploys A', false, setup.out); return }
    let targetSeen = false
    state.onState = () => {
      if (pointer() === join(releaseDir(B), 'lib')) {
        targetSeen = true; state.health = 'always-bad'; state.healthDetail = 'target-only-evidence'; state.failState = false
      } else if (targetSeen) {
        state.failState = true
      }
    }
    const r = await deploy(['--target', B, '--previous', A, '--timeout', '3'])
    const rec = readRecords('deploy').find((x) => x.result === 'failed-twice')
    check('X2 restore state unreadable exits nonzero', r.code !== 0, `code=${r.code} ${r.out}`)
    check('X2 failed-twice record written', Boolean(rec), JSON.stringify(readRecords('deploy')))
    check('X2 targetFailure keeps target-phase evidence', Boolean(rec) && String(rec.targetFailure).includes('target-only-evidence'), JSON.stringify(rec))
    check('X2 targetFailureKind recorded', Boolean(rec) && ['stop-timeout', 'state-unreadable', 'health-timeout'].includes(rec.targetFailureKind), JSON.stringify(rec))
    check('X2 restoreFailureKind state-unreadable or restoreFailure unverified', Boolean(rec) && (rec.restoreFailureKind === 'state-unreadable' || rec.restoreFailure === 'unverified'), JSON.stringify(rec))
    check('X2 restoreFailure is not the target-phase string', Boolean(rec) && String(rec.restoreFailure).length > 0 && rec.restoreFailure !== rec.targetFailure, JSON.stringify(rec))
    check('X2 unverified paused path does not claim kept paused', !/kept paused/.test(r.out), r.out)
  } finally {
    await closeWorld()
  }

  // N1c/X3：普通 lib 目录首次迁移时 symlink rename 失败 + 旧目录恢复 mv 也失败（双重故障）。
  // 不得声称 restored/preserved；记录 failed-pointer 且带 migrationRestore=failed 与备份路径。
  await initWorld({ plainLib: true })
  try {
    deployEnv = migrationRestoreFailEnv()
    const r = await deploy(['--target', A])
    check('X3 migration restore double failure exits nonzero', r.code !== 0, `code=${r.code} ${r.out}`)
    const libPath = join(instance, 'hephi', 'lib')
    const libStat = existsSync(libPath) ? lstatSync(libPath) : null
    check('X3 live lib is absent after failed migration restore', !libStat || !libStat.isDirectory(), `libStat=${libStat && (libStat.isSymbolicLink() ? 'symlink' : 'directory')}`)
    const backupName = existsSync(join(instance, 'hephi')) ? readdirSync(join(instance, 'hephi')).find((name) => name.startsWith('.migration-')) : undefined
    const backupPath = backupName ? join(instance, 'hephi', backupName) : ''
    check('X3 migration backup keeps legacy content', Boolean(backupPath) && existsSync(join(backupPath, 'legacy.mjs')) && readFileSync(join(backupPath, 'legacy.mjs'), 'utf8') === 'export const legacy = 1\n', String(backupName))
    const rec = readRecords('deploy').find((x) => x.result === 'failed-pointer')
    check('X3 failed-pointer record marks migrationRestore failed', Boolean(rec) && rec.migrationRestore === 'failed', JSON.stringify(rec))
    check('X3 failed-pointer record carries migration backup path', Boolean(rec) && Boolean(backupPath) && (rec.migrationBackup === backupPath || rec.migration === backupPath), `backup=${backupPath} rec=${JSON.stringify(rec)}`)
    check('X3 output does not claim restored or preserved', !/old lib directory restored/.test(r.out) && !/previous state preserved/.test(r.out), r.out)
    check('X3 output states restore failure and backup path', /NOT restored|restore FAILED|restore failed/i.test(r.out) && Boolean(backupPath) && r.out.includes(backupPath), `backup=${backupPath} out=${r.out}`)
  } finally {
    await closeWorld()
  }

  // P1：F6 动态用例——坏 current 绝不能成为恢复目标。
  // 先发布 B、再发布 A（pointer A，两个 release 都已存在），篡改 A 的 lib/index.mjs（不改 meta），
  // rollback --target B 且不带 --previous；目标 B 启动失败后没有合法恢复目标，必须写 failed-no-previous，
  // pointer 不得回到坏的 A/lib。
  await initWorld()
  try {
    const prebuilt = await deploy(['--target', B])
    const setup = prebuilt.code === 0 ? await deploy(['--target', A]) : prebuilt
    if (setup.code !== 0) { check('P1 setup deploys B then A', false, setup.out); return }
    writeFileSync(join(releaseDir(A), 'lib', 'index.mjs'), 'export const tampered = 1\n')
    state.health = 'always-bad'
    state.healthDetail = 'p1-target-failure'
    const r = await deploy(['--rollback', '--target', B, '--timeout', '3'])
    const rec = readRecords('rollback').find((x) => x.result === 'failed-no-previous')
    check('P1 rollback target failure exits nonzero', r.code !== 0, `code=${r.code} ${r.out}`)
    check('P1 tampered current is not a restore target', pointer() === join(releaseDir(B), 'lib'), pointer())
    check('P1 failed-no-previous record written', Boolean(rec), JSON.stringify(readRecords('rollback')))
  } finally {
    await closeWorld()
  }

  // P2：非法 --previous 必须在读取宿主/切换之前拒绝，且无任何副作用。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    if (setup.code !== 0) { check('P2 setup deploys A', false, setup.out); return }
    const before = pointer()
    const startsBefore = starts()
    const recordsBefore = readRecords().length
    let hostReads = 0
    state.onState = () => { hostReads += 1 }
    const r = await deploy(['--rollback', '--target', B, '--previous', 'abc'])
    check('P2 invalid previous rejected before host read', r.code !== 0 && /previous must be a full 40-char SHA/.test(r.out) && hostReads === 0, `stateReads=${hostReads} ${r.out}`)
    check('P2 invalid previous has no side effects', pointer() === before && starts() === startsBefore && readRecords().length === recordsBefore && hostReads === 0, `pointer=${pointer()} starts ${startsBefore}->${starts()} records ${recordsBefore}->${readRecords().length}`)
  } finally {
    await closeWorld()
  }

  // P3：普通部署 A→B，目标 B 健康失败，恢复 A 后全量健康 ready。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    if (setup.code !== 0) { check('P3 setup deploys A', false, setup.out); return }
    state.onState = () => {
      if (pointer() === join(releaseDir(B), 'lib')) { state.health = 'always-bad'; state.healthDetail = 'p3-target-health-failed' }
      else { state.health = 'ok' }
    }
    const r = await deploy(['--target', B, '--previous', A, '--timeout', '3'])
    const rec = readRecords('deploy').find((x) => x.result === 'failed-restored-previous')
    check('P3 target health failure exits nonzero', r.code !== 0, `code=${r.code} ${r.out}`)
    check('P3 previous release restored as pointer', pointer() === join(releaseDir(A), 'lib'), pointer())
    check('P3 failed-restored-previous keeps restoreHealth all-required-ready', Boolean(rec) && rec.restoreHealth === 'all-required-ready', JSON.stringify(rec))
    check('P3 record keeps real paused=true', Boolean(rec) && rec.paused === true, JSON.stringify(rec))
  } finally {
    await closeWorld()
  }
}


// F-02：§4.5 停机式排空（--drain effects）假宿主回归。
// 真实进程模拟 host.pid 停机；effects DB 用 node:sqlite 构造真实 WAL 库；
// check-effects-db.mjs 是真实调用（不是 mock）。真实停机由宿主 stop 脚本完成（SIGINT 默认路径已删除）。
async function runF02Suite() {
  // F-02-A：全部通过 → 停机式排空成功切换。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    if (setup.code !== 0) { check('F-02 A setup deploys A', false, setup.out); return }
    createEffectsDatabase(0).close()
    const oldPid = hostPidValue()
    const startsBefore = starts()
    const r = await deploy(effectsDeployArgs())
    const rec = readRecords('deploy').find((x) => x.result === 'ok' && x.drainMode === 'effects')
    check('F-02 A stop-based deploy exits 0', r.code === 0, `code=${r.code} ${r.out}`)
    check('F-02 A pointer switched to target B', pointer() === join(releaseDir(B), 'lib'), pointer())
    check('F-02 A target release B was built before stop', existsSync(join(releaseDir(B), 'lib', 'index.mjs')))
    const newPid = hostPidValue()
    check('F-02 A host restarted with a new live pid', newPid !== oldPid && pidAlive(newPid), `old=${oldPid} new=${newPid}`)
    check('F-02 A host was started again after stop', starts() > startsBefore, `starts ${startsBefore} -> ${starts()}`)
    check('F-02 A record keeps running precheck evidence', Boolean(rec) && /"ok":true/.test(rec.precheckJson) && /"total":0/.test(rec.precheckJson), rec && rec.precheckJson)
    check('F-02 A record keeps post-stop copy evidence', Boolean(rec) && /"ok":true/.test(rec.finalCheckJson) && /"journalMode":"wal"/.test(rec.finalCheckJson) && /"total":0/.test(rec.finalCheckJson), rec && rec.finalCheckJson)
    check('F-02 A record keeps managed process table', Boolean(rec) && rec.hostPid === String(oldPid) && rec.processFile !== 'none' && existsSync(rec.processFile) && readFileSync(rec.processFile, 'utf8').includes(String(oldPid)), JSON.stringify(rec))
    check('F-02 A record marks drain mode, health, paused readback and default auto-restart wait=10', Boolean(rec) && rec.drainMode === 'effects' && rec.health === 'all-required-ready' && rec.paused === true && rec.keptPaused === 'yes' && rec.autoRestartWait === '10', JSON.stringify(rec))
  } finally {
    await closeWorld()
  }

  // F-02-B：worker 数 0 但 effect 表有待执行行 → 停机前预检查拒绝，宿主不动。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    if (setup.code !== 0) { check('F-02 B setup deploys A', false, setup.out); return }
    createEffectsDatabase(2).close()
    const oldPid = hostPidValue()
    const before = pointer()
    const r = await deploy(effectsDeployArgs([], { waitSeconds: 1 }))
    const rec = readRecords('deploy').find((x) => x.result === 'failed-drain-precheck')
    check('F-02 B pending effects reject before stop', r.code !== 0, `code=${r.code} ${r.out}`)
    check('F-02 B pointer unchanged and host not stopped', pointer() === before && pidAlive(oldPid), `pointer=${pointer()} oldPidAlive=${pidAlive(oldPid)}`)
    check('F-02 B record keeps precheck evidence with total=2', Boolean(rec) && /"total":2/.test(rec.precheckJson), JSON.stringify(rec))
    check('F-02 B record keeps the process table on a precheck abort', Boolean(rec) && rec.processFile !== 'none' && existsSync(rec.processFile), JSON.stringify(rec))
    check('F-02 B no target release was built', !existsSync(releaseDir(B)))
  } finally {
    await closeWorld()
  }

  // F-02-C：预检查为 0，但停机前（stop hook）新增 effect 且停在未 checkpoint 的 WAL 中
  // → 停机后 copy 模式最终查询必须读到该行并拒绝切换。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    if (setup.code !== 0) { check('F-02 C setup deploys A', false, setup.out); return }
    // keeper 连接让已提交的 WAL 不被 checkpoint 掉；插入用同步子进程，避免后台进程继承 deploy 管道导致 harness 等待。
    const keeper = createEffectsDatabase(0)
    const insertScript = join(root, 'late-insert.cjs')
    writeFileSync(insertScript, [
      "const { DatabaseSync } = require('node:sqlite')",
      'const db = new DatabaseSync(process.argv[2])',
      "db.exec('PRAGMA wal_autocheckpoint=0')",
      'db.exec("INSERT INTO effect VALUES (\'late-effect\')")',
      'db.close()',
    ].join('\n'))
    const hook = writeHook('late-writer.sh', [
      `node "${insertScript}" "${effectsDbPath()}"`,
      `kill -TERM "$(cat "${join(instance, 'host.pid')}")"`,
      'exit 0',
    ].join('\n'))
    const r = await deploy(effectsDeployArgs(['--stop-command', hook], { waitSeconds: 1 }))
    const rec = readRecords('deploy').find((x) => x.result === 'failed-drain-final')
    const walPath = `${effectsDbPath()}-wal`
    check('F-02 C late effects stayed in the uncheckpointed WAL', existsSync(walPath) && statSync(walPath).size > 0, `walExists=${existsSync(walPath)} size=${existsSync(walPath) ? statSync(walPath).size : 0}`)
    check('F-02 C late effect in WAL rejects the switch', r.code !== 0, `code=${r.code} ${r.out}`)
    check('F-02 C pointer stays on the original release A', pointer() === join(releaseDir(A), 'lib'), pointer())
    check('F-02 C record keeps final copy evidence with total=1', Boolean(rec) && /"ok":true/.test(rec.finalCheckJson) && /"total":1/.test(rec.finalCheckJson), rec && rec.finalCheckJson)
    check('F-02 C record keeps zero precheck evidence', Boolean(rec) && /"total":0/.test(rec.precheckJson), rec && rec.precheckJson)
    check('F-02 C original release was restarted to full health', Boolean(rec) && rec.recoverHealth === 'all-required-ready' && pidAlive(hostPidValue()), JSON.stringify(rec))
    keeper.close()
  } finally {
    await closeWorld()
  }

  // F-02-D：停机后最终查询失败/无一致快照（db 损坏）→ 拒绝切换并重启原版本。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    if (setup.code !== 0) { check('F-02 D setup deploys A', false, setup.out); return }
    createEffectsDatabase(0).close()
    const hook = writeHook('corrupt-db.sh', [
      `printf 'this is not a sqlite database\\n' > "${effectsDbPath()}"`,
      `rm -f "${effectsDbPath()}-wal" "${effectsDbPath()}-shm"`,
      `kill -TERM "$(cat "${join(instance, 'host.pid')}")"`,
      'exit 0',
    ].join('\n'))
    const r = await deploy(effectsDeployArgs(['--stop-command', hook], { waitSeconds: 1 }))
    const rec = readRecords('deploy').find((x) => x.result === 'failed-drain-final')
    check('F-02 D corrupt final snapshot rejects the switch', r.code !== 0, `code=${r.code} ${r.out}`)
    check('F-02 D pointer stays on the original release A', pointer() === join(releaseDir(A), 'lib'), pointer())
    check('F-02 D record keeps failed final JSON', Boolean(rec) && /"ok":false/.test(rec.finalCheckJson) && /"error"/.test(rec.finalCheckJson), rec && rec.finalCheckJson)
    check('F-02 D original release was restarted to full health', Boolean(rec) && rec.recoverHealth === 'all-required-ready' && pidAlive(hostPidValue()), JSON.stringify(rec))
  } finally {
    await closeWorld()
  }

  // F-02-E：停机后仍有受管进程残留（宿主启动的子进程）→ 拒绝切换并重启原版本。
  await initWorld()
  try {
    writeStart([
      `echo started >> "${instance}/start.log"`,
      activationMarkers(),
      `if [ ! -f "${instance}/child-spawned" ]; then`,
      `  : > "${instance}/child-spawned"`,
      '  sleep 300 &',
      `  echo $! > "${instance}/child.pid"`,
      'fi',
      `: > "${instance}/started.marker"`,
      'exec sleep 3600',
    ].join('\n'))
    const setup = await deploy(['--target', A])
    if (setup.code !== 0) { check('F-02 E setup deploys A', false, setup.out); return }
    createEffectsDatabase(0).close()
    const childPid = readPid(join(instance, 'child.pid'))
    const r = await deploy(effectsDeployArgs([], { waitSeconds: 1 }))
    const rec = readRecords('deploy').find((x) => x.result === 'failed-drain-residual')
    check('F-02 E leftover managed process rejects the switch', r.code !== 0, `code=${r.code} ${r.out}`)
    check('F-02 E pointer stays on the original release A', pointer() === join(releaseDir(A), 'lib'), pointer())
    check('F-02 E record names the residual pid with its lstart', Boolean(rec) && rec.residualProcesses.includes(String(childPid)) && rec.residualProcesses.includes('|'), JSON.stringify(rec.residualProcesses))
    check('F-02 E residual process is still alive and was recorded', pidAlive(childPid), `childPid=${childPid}`)
    check('F-02 E original release was restarted to full health', Boolean(rec) && rec.recoverHealth === 'all-required-ready' && pidAlive(hostPidValue()), JSON.stringify(rec))
  } finally {
    killPid(readPid(join(instance, 'child.pid')))
    await closeWorld()
  }

  // F-02-F：停机后宿主自动回来（host.pid 出现新存活 pid）→ 只记录并中止，不杀新进程、不再启动第二份实例。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    if (setup.code !== 0) { check('F-02 F setup deploys A', false, setup.out); return }
    createEffectsDatabase(0).close()
    const hook = writeHook('auto-restart.sh', [
      `kill -TERM "$(cat "${join(instance, 'host.pid')}")" 2>/dev/null || true`,
      'sleep 0.5',
      'sleep 3600 >/dev/null 2>&1 &',
      `echo $! > "${join(instance, 'host.pid')}"`,
      `echo $! > "${join(root, 'auto-restart.pid')}"`,
      'exit 0',
    ].join('\n'))
    const startsBefore = starts()
    const r = await deploy(effectsDeployArgs(['--stop-command', hook], { waitSeconds: 1 }))
    const rec = readRecords('deploy').find((x) => x.result === 'failed-drain-auto-restart')
    const autoPid = readPid(join(root, 'auto-restart.pid'))
    check('F-02 F auto restart rejects the switch', r.code !== 0, `code=${r.code} ${r.out}`)
    check('F-02 F pointer stays on the original release A', pointer() === join(releaseDir(A), 'lib'), pointer())
    check('F-02 F record keeps autoRestartedPid, the left-running action and the 1s auto-restart wait', Boolean(rec) && Number(rec.autoRestartedPid) === autoPid && rec.autoRestartAction === 'left-running' && rec.autoRestartWait === '1', JSON.stringify(rec))
    check('F-02 F auto-restarted host is left running without a second start', pidAlive(autoPid) && hostPidValue() === autoPid && starts() === startsBefore, `autoPid=${autoPid} alive=${pidAlive(autoPid)} hostPid=${hostPidValue()} starts ${startsBefore} -> ${starts()}`)
  } finally {
    killPid(readPid(join(root, 'auto-restart.pid')))
    await closeWorld()
  }

  // F-02-G：stop 命令失败/宿主未停 → 拒绝切换，宿主保持原状。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    if (setup.code !== 0) { check('F-02 G setup deploys A', false, setup.out); return }
    createEffectsDatabase(0).close()
    const oldPid = hostPidValue()
    const hook = writeHook('stop-fail.sh', ['echo "injected stop failure" >&2', 'exit 7'].join('\n'))
    const r = await deploy(effectsDeployArgs(['--stop-command', hook], { waitSeconds: 1 }))
    const rec = readRecords('deploy').find((x) => x.result === 'failed-drain-stop')
    check('F-02 G stop failure rejects the switch', r.code !== 0, `code=${r.code} ${r.out}`)
    check('F-02 G pointer unchanged and original host still running', pointer() === join(releaseDir(A), 'lib') && pidAlive(oldPid), `pointer=${pointer()} alive=${pidAlive(oldPid)}`)
    check('F-02 G record keeps the stop command exit code', Boolean(rec) && rec.stopExit === '7', JSON.stringify(rec))
    check('F-02 G record keeps no final evidence (aborted before final query)', Boolean(rec) && rec.finalCheckJson === '', JSON.stringify(rec))
  } finally {
    await closeWorld()
  }

  // F-02-H：新模式下 dry-run 只做 pause 前置 + effect 预检查 + 进程清单，不停机不切换不构建。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    if (setup.code !== 0) { check('F-02 H setup deploys A', false, setup.out); return }
    createEffectsDatabase(0).close()
    const oldPid = hostPidValue()
    const startsBefore = starts()
    const r = await deploy(effectsDeployArgs(['--dry-run'], { waitSeconds: 1 }))
    check('F-02 H dry-run exits 0', r.code === 0 && /dry-run/.test(r.out), `code=${r.code} ${r.out}`)
    check('F-02 H dry-run does not stop or restart the host', hostPidValue() === oldPid && pidAlive(oldPid) && starts() === startsBefore, `pid ${oldPid} -> ${hostPidValue()} starts ${startsBefore} -> ${starts()}`)
    check('F-02 H dry-run does not build or switch', !existsSync(releaseDir(B)) && pointer() === join(releaseDir(A), 'lib'), `pointer=${pointer()}`)
    const managedFiles = readdirSync(join(instance, 'logs')).filter((name) => name.startsWith('managed-') && name.endsWith('.txt'))
    check('F-02 H dry-run records the managed process table', managedFiles.length > 0, JSON.stringify(managedFiles))
    const customProcessFile = join(root, 'custom-managed.txt')
    const custom = await deploy(effectsDeployArgs(['--dry-run', '--process-file', customProcessFile], { waitSeconds: 1 }))
    check('F-02 H --process-file writes the managed table to the requested path', custom.code === 0 && existsSync(customProcessFile) && readFileSync(customProcessFile, 'utf8').includes(String(oldPid)), `code=${custom.code} ${custom.out}`)
  } finally {
    await closeWorld()
  }

  // F-02-I：参数互斥与未知 mode 仍 exit 2。
  await initWorld()
  try {
    const badMode = await deploy(['--drain', 'nope', '--target', A])
    check('F-02 I unknown --drain mode exits 2', badMode.code === 2 && /unknown --drain mode/.test(badMode.out), badMode.out)
    const conflict = await deploy(['--drain', 'effects', '--rollback', '--target', A])
    check('F-02 I --drain effects with --rollback exits 2', conflict.code === 2 && /cannot be combined/.test(conflict.out), conflict.out)
    const noStop = await deploy(['--drain', 'effects', '--target', A, '--effects-db', effectsDbPath()])
    check('F-02 I --drain effects without --stop-command exits 2', noStop.code === 2 && /requires --stop-command/.test(noStop.out), noStop.out)
  } finally {
    await closeWorld()
  }
}


// N1（§4.5 single instance）：假宿主只启动真实进程；单实例扫描不执行生产命令、
// 不证明真实宿主。额外实例进程由测试显式创建/清理，部署脚本不得按 regex 杀未知进程。
function extraInstanceScript(name) {
  const dir = join(instance, name)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'start.sh')
  writeFileSync(file, '#!/bin/sh\nwhile :; do sleep 1; done\n')
  run('chmod', ['+x', file])
  return file
}
function spawnDetached(command, args) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.unref()
  return child.pid
}

async function runN1Suite() {
  // N1-01：正常单实例 → 成功记录带 singleInstance {ok:true, pids:[host.pid], phase:post-start}。
  await initWorld()
  try {
    const r = await deploy(['--target', A])
    const hostPid = hostPidValue()
    const rec = readRecords('deploy').find((x) => x.result === 'ok' && x.target === A)
    check('N1-01 normal single instance deploy exits 0', r.code === 0, `code=${r.code} ${r.out}`)
    check('N1-01 success record keeps singleInstance ok=true with the managed host pid', Boolean(rec) && Boolean(rec.singleInstance) && rec.singleInstance.ok === true && Array.isArray(rec.singleInstance.pids) && rec.singleInstance.pids.length === 1 && rec.singleInstance.pids[0] === hostPid && rec.singleInstance.phase === 'post-start' && typeof rec.singleInstance.checkedAt === 'string', JSON.stringify(rec && rec.singleInstance))
  } finally {
    await closeWorld()
  }

  // N1-02：stop hook 留下匹配进程 → 切换前拒绝；记录 stray pid；不杀未知进程；
  // 恢复启动后的复检仍失败，于是停掉本次恢复启动的宿主并如实记录 single-instance-failed。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    if (setup.code !== 0) { check('N1-02 setup deploys A', false, setup.out); return }
    createEffectsDatabase(0).close()
    const strayScript = extraInstanceScript('stray')
    const strayPidFile = join(root, 'stray.pid')
    const hook = writeHook('leave-stray.sh', [
      `kill -TERM "$(cat "${join(instance, 'host.pid')}")" 2>/dev/null || true`,
      `nohup "${strayScript}" >/dev/null 2>&1 &`,
      `echo $! > "${strayPidFile}"`,
      'exit 0',
    ].join('\n'))
    const r = await deploy(effectsDeployArgs(['--stop-command', hook], { waitSeconds: 1 }))
    const strayPid = readPid(strayPidFile)
    const rec = readRecords('deploy').find((x) => x.result === 'failed-drain-single-instance')
    check('N1-02 a matching process left after stop rejects the switch', r.code !== 0 && pointer() === join(releaseDir(A), 'lib'), `code=${r.code} pointer=${pointer()} ${r.out}`)
    check('N1-02 record keeps singleInstance ok=false, the stray pid and the post-auto-restart phase', Boolean(rec) && Boolean(rec.singleInstance) && rec.singleInstance.ok === false && rec.singleInstance.pids.includes(strayPid) && rec.singleInstance.phase === 'post-auto-restart' && typeof rec.singleInstance.checkedAt === 'string', JSON.stringify(rec && rec.singleInstance))
    check('N1-02 stray process is left running (never killed by pattern)', pidAlive(strayPid), `strayPid=${strayPid} alive=${pidAlive(strayPid)}`)
    check('N1-02 recovery stops its own host instead of running beside the stray', Boolean(rec) && rec.recoverHealth === 'single-instance-failed' && !pidAlive(hostPidValue()) && String(rec.error).includes('single-instance'), JSON.stringify(rec && { recoverHealth: rec.recoverHealth, error: rec.error }))
  } finally {
    killPid(readPid(join(root, 'stray.pid')))
    await closeWorld()
  }

  // N1-03：目标 start.sh 窗口内再拉一个实例 → 启动健康后复检 pids>=2，不切换；
  // 恢复启动后仍看到多余实例 → 复检失败并停掉恢复启动的宿主，记录 failed-twice。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    if (setup.code !== 0) { check('N1-03 setup deploys A', false, setup.out); return }
    const windowScript = extraInstanceScript('window')
    const windowPidFile = join(instance, 'window-extra.pid')
    writeStart([
      `echo attempt >> "${instance}/start.log"`,
      `if [ ! -f "${instance}/window-spawned" ]; then`,
      `  : > "${instance}/window-spawned"`,
      `  nohup "${windowScript}" >/dev/null 2>&1 &`,
      `  echo $! > "${windowPidFile}"`,
      'fi',
      activationMarkers(),
      `: > "${instance}/started.marker"`,
      'exec sleep 3600',
    ].join('\n'))
    rmSync(join(instance, 'started.marker'), { force: true })
    const r = await deploy(['--target', B, '--previous', A])
    const extraPid = readPid(windowPidFile)
    const rec = readRecords('deploy').find((x) => x.result === 'failed-twice')
    check('N1-03 a second instance in the start window fails the deployment', r.code !== 0 && pointer() === join(releaseDir(A), 'lib'), `code=${r.code} pointer=${pointer()} ${r.out}`)
    check('N1-03 record keeps pids>=2 including the extra window instance', Boolean(rec) && Boolean(rec.singleInstance) && rec.singleInstance.ok === false && rec.singleInstance.pids.length >= 2 && rec.singleInstance.pids.includes(extraPid) && rec.singleInstance.phase === 'post-start', JSON.stringify(rec && rec.singleInstance))
    check('N1-03 recovery recheck failed and its own host was stopped', Boolean(rec) && rec.restoreFailureKind === 'single-instance' && !pidAlive(hostPidValue()), JSON.stringify(rec && { restoreFailureKind: rec.restoreFailureKind, restoreFailure: rec.restoreFailure }))
    check('N1-03 extra window instance is left running (never killed by pattern)', pidAlive(extraPid), `extraPid=${extraPid} alive=${pidAlive(extraPid)}`)
  } finally {
    killPid(readPid(join(instance, 'window-extra.pid')))
    await closeWorld()
  }

  // N1-04：无关进程（含命令行匹配 instance 路径但不是 start.sh/bin.js 入口）不误报。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    if (setup.code !== 0) { check('N1-04 setup deploys A', false, setup.out); return }
    createEffectsDatabase(0).close()
    const unrelated = []
    unrelated.push(spawnDetached('/bin/sleep', ['3600']))
    const worker = join(instance, 'worker.js')
    writeFileSync(worker, 'setInterval(() => {}, 1000)\n')
    unrelated.push(spawnDetached(process.execPath, [worker]))
    // 命令行包含 instance 路径与 start.sh，但入口是 node -e：不得计为宿主入口。
    unrelated.push(spawnDetached(process.execPath, ['-e', 'setInterval(() => {}, 1000)', join(instance, 'start.sh')]))
    const r = await deploy(effectsDeployArgs([], { waitSeconds: 1 }))
    const hostPid = hostPidValue()
    const rec = readRecords('deploy').find((x) => x.result === 'ok' && x.drainMode === 'effects')
    check('N1-04 unrelated processes do not block a normal deploy', r.code === 0, `code=${r.code} ${r.out}`)
    check('N1-04 singleInstance counts only the managed host pid', Boolean(rec) && Boolean(rec.singleInstance) && rec.singleInstance.ok === true && rec.singleInstance.pids.length === 1 && rec.singleInstance.pids[0] === hostPid, JSON.stringify(rec && rec.singleInstance))
    for (const pid of unrelated) killPid(pid)
  } finally {
    await closeWorld()
  }

  // N1-05：--instance-pattern 必须是有效 regex，且在读取宿主/切换之前拒绝。
  await initWorld()
  try {
    const before = readRecords().length
    const invalid = await deploy(['--target', A, '--instance-pattern', '(['])
    check('N1-05 an invalid --instance-pattern exits 2 before any host read or switch', invalid.code === 2 && /invalid --instance-pattern/.test(invalid.out) && pointer() === '' && readRecords().length === before, `code=${invalid.code} pointer=${pointer()} ${invalid.out}`)
    const custom = await deploy(['--target', A, '--instance-pattern', 'instance/start\\.sh'])
    const rec = readRecords('deploy').find((x) => x.result === 'ok' && x.target === A)
    check('N1-05 a valid custom --instance-pattern still records a single-instance success', custom.code === 0 && Boolean(rec) && Boolean(rec.singleInstance) && rec.singleInstance.ok === true && rec.singleInstance.pids.length === 1, `code=${custom.code} ${JSON.stringify(rec && rec.singleInstance)} ${custom.out}`)
  } finally {
    await closeWorld()
  }
}

// T1（issue #26）：发布依赖打包、停机前导入探针、双入口激活门禁与旧版本回滚边界。
// 全部是聚焦假宿主测试：stub 仓库用 file: 依赖离线构建，假 start 脚本写激活标识；
// 不访问真实宿主、不证明真实部署通过。
async function runT1Suite() {
  // T1-A：健康 ready 但缺少插件激活标识 → 目标失败并按既有路径恢复旧版本。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    if (setup.code !== 0) { check('T1-A setup deploys A', false, setup.out); return }
    state.health = 'marker'
    writeStart(`echo attempt >> "${instance}/start.log"
if [ ! -f "${instance}/fail-once-used" ]; then : > "${instance}/fail-once-used"; : > "${instance}/started.marker"; exec sleep 3600; fi
${activationMarkers()}
: > "${instance}/started.marker"
exec sleep 3600`)
    rmSync(join(instance, 'started.marker'), { force: true })
    const startsBefore = starts()
    const r = await deploy(['--target', B, '--previous', A])
    const rec = readRecords('deploy').find((x) => x.result === 'failed-restored-previous')
    check('T1-A healthy host without activation markers exits nonzero', r.code !== 0, `code=${r.code} ${r.out}`)
    check('T1-A output names the missing activation markers', /activation markers missing/.test(r.out), r.out)
    check('T1-A target failure kind is activation-missing', Boolean(rec) && rec.targetFailureKind === 'activation-missing', JSON.stringify(rec))
    check('T1-A previous release restored and healthy', pointer() === join(releaseDir(A), 'lib') && Boolean(rec) && rec.restoreHealth === 'all-required-ready', `${pointer()} ${JSON.stringify(rec)}`)
    check('T1-A restore start verified both activation entries', Boolean(rec) && rec.activation === 'verified' && /"index"/.test(String(rec.activationEvidence)) && /"tools"/.test(String(rec.activationEvidence)), JSON.stringify(rec && rec.activationEvidence))
    check('T1-A healthy target did not restart more than once per attempt', starts() >= startsBefore + 2, `starts ${startsBefore} -> ${starts()}`)
  } finally {
    await closeWorld()
  }

  // T1-B：健康 ready 但只缺一个入口标识（tools）也必须失败。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    if (setup.code !== 0) { check('T1-B setup deploys A', false, setup.out); return }
    state.health = 'marker'
    const shaLine = `sha=$(basename "$(dirname "$(readlink "${instance}/hephi/lib")")")`
    writeStart(`echo attempt >> "${instance}/start.log"
if [ ! -f "${instance}/fail-once-used" ]; then
  : > "${instance}/fail-once-used"
  ${shaLine}
  echo "[hephi-activation] entry=index plugin=stub-hephi commit=$sha pid=$$"
  : > "${instance}/started.marker"
  exec sleep 3600
fi
${activationMarkers()}
: > "${instance}/started.marker"
exec sleep 3600`)
    rmSync(join(instance, 'started.marker'), { force: true })
    const r = await deploy(['--target', B, '--previous', A])
    const rec = readRecords('deploy').find((x) => x.result === 'failed-restored-previous')
    check('T1-B one missing entry marker fails the activation gate', r.code !== 0 && Boolean(rec) && rec.targetFailureKind === 'activation-missing', `code=${r.code} ${JSON.stringify(rec)}`)
    check('T1-B restore start writes both entries again', pointer() === join(releaseDir(A), 'lib') && Boolean(rec) && rec.restoreHealth === 'all-required-ready', `${pointer()} ${JSON.stringify(rec)}`)
  } finally {
    await closeWorld()
  }

  // T1-C：旧格式 release（无 activation 元数据）回滚必须成功，并如实记 unverified-legacy。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    if (setup.code !== 0) { check('T1-C setup deploys A', false, setup.out); return }
    const legacySha = FULL('c')
    legacyRelease(legacySha)
    // 旧 release 不可能有激活标识：start 只写健康标识。
    writeStart(`echo attempt >> "${instance}/start.log"\n: > "${instance}/started.marker"\nexec sleep 3600`)
    rmSync(join(instance, 'started.marker'), { force: true })
    const r = await deploy(['--rollback', '--target', legacySha, '--allow-legacy-rollback'])
    const rec = readRecords('rollback').find((x) => x.result === 'ok')
    check('T1-C legacy release rollback still succeeds', r.code === 0, `code=${r.code} ${r.out}`)
    check('T1-C pointer switches to the legacy release', pointer() === join(releaseDir(legacySha), 'lib'), pointer())
    check('T1-C legacy activation is recorded as unverified-legacy', Boolean(rec) && rec.activation === 'unverified-legacy' && rec.importProbe === 'skipped-legacy', JSON.stringify(rec))
  } finally {
    await closeWorld()
  }

  // T1-D：构建成功但 release 导入时缺运行依赖 → 停机前拒绝，宿主/指针不变。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    if (setup.code !== 0) { check('T1-D setup deploys A', false, setup.out); return }
    writeFileSync(join(repo, 'hephi', 'build.mjs'), [
      "import { mkdirSync, writeFileSync } from 'node:fs'",
      "mkdirSync('lib', { recursive: true })",
      "writeFileSync('lib/index.mjs', \"import 'not-packaged-dep'\\nexport function describePlugin(){return {commit: process.env.HEPHI_BUILD_COMMIT}}\\nexport function apply(){}\\n\")",
      "writeFileSync('lib/tools.mjs', \"export function apply(){}\\n\")",
      '',
    ].join('\n'))
    const brokenSha = commitRepo('broken runtime dependency')
    const oldPid = hostPidValue()
    const startsBefore = starts()
    const r = await deploy(['--target', brokenSha, '--previous', A])
    check('T1-D import probe failure rejects before stop', r.code !== 0 && /import probe failed|failed the host-Node import probe/.test(r.out), `code=${r.code} ${r.out}`)
    check('T1-D host and pointer are untouched', pointer() === join(releaseDir(A), 'lib') && hostPidValue() === oldPid && pidAlive(oldPid) && starts() === startsBefore, `pointer=${pointer()} pid=${hostPidValue()} starts ${startsBefore} -> ${starts()}`)
    check('T1-D no published release for the failed import probe', !existsSync(releaseDir(brokenSha)), releaseDir(brokenSha))
  } finally {
    await closeWorld()
  }

  // T1-E：package.json 声明了未写入冻结 lockfile 的依赖 → 构建阶段（停机前）拒绝。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    if (setup.code !== 0) { check('T1-E setup deploys A', false, setup.out); return }
    const pkgFile = join(repo, 'hephi', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    pkg.dependencies['not-in-lockfile'] = '^9.9.9'
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2))
    const unlockedSha = commitRepo('dependency missing from the frozen lockfile')
    const oldPid = hostPidValue()
    const startsBefore = starts()
    const r = await deploy(['--target', unlockedSha, '--previous', A])
    check('T1-E frozen lockfile mismatch rejects before stop', r.code !== 0 && /build failed|ERR_PNPM|lockfile/i.test(r.out), `code=${r.code} ${r.out}`)
    check('T1-E host and pointer are untouched on lockfile failure', pointer() === join(releaseDir(A), 'lib') && hostPidValue() === oldPid && starts() === startsBefore, `pointer=${pointer()} pid=${hostPidValue()} starts ${startsBefore} -> ${starts()}`)
    check('T1-E no published release for the lockfile failure', !existsSync(releaseDir(unlockedSha)), releaseDir(unlockedSha))
  } finally {
    await closeWorld()
  }

  // T1-F：声明 peerDependencies 但未提供 --peer-root → 停机前显式拒绝（peer 解析不得猜测）。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    if (setup.code !== 0) { check('T1-F setup deploys A', false, setup.out); return }
    const pkgFile = join(repo, 'hephi', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    mkdirSync(join(repo, 'hephi', 'vendor', 'stub-peer'), { recursive: true })
    writeFileSync(join(repo, 'hephi', 'vendor', 'stub-peer', 'package.json'), JSON.stringify({ name: 'stub-peer', version: '1.0.0', type: 'module', main: 'index.js' }, null, 2))
    writeFileSync(join(repo, 'hephi', 'vendor', 'stub-peer', 'index.js'), "export const VERSION = 'bundled-1.0.0'\n")
    pkg.dependencies['stub-peer'] = 'file:./vendor/stub-peer'
    pkg.peerDependencies = { 'stub-peer': '^1.0.0' }
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2))
    const lock = run('pnpm', ['install', '--lockfile-only', '--offline'], { cwd: join(repo, 'hephi') })
    if (lock.code !== 0) throw new Error(`cannot refresh the stub lockfile: ${lock.out}`)
    const peerSha = commitRepo('peer dependency without an explicit peer root')
    const oldPid = hostPidValue()
    const startsBefore = starts()
    const r = await deploy(['--target', peerSha, '--previous', A])
    check('T1-F declared peer without --peer-root rejects before stop', r.code !== 0 && /peer-root|peerDependencies/.test(r.out), `code=${r.code} ${r.out}`)
    check('T1-F host untouched on missing peer root', pointer() === join(releaseDir(A), 'lib') && hostPidValue() === oldPid && starts() === startsBefore, `pointer=${pointer()} pid=${hostPidValue()} starts ${startsBefore} -> ${starts()}`)
    check('T1-F no published release without explicit peer resolution', !existsSync(releaseDir(peerSha)), releaseDir(peerSha))
  } finally {
    await closeWorld()
  }

  // T1-G：生产安装已放入同名 peer（peer 同时是生产依赖）时，只在 incoming 内替换为宿主
  // peer 入口；不改构建目录/宿主，且替换有记录。真实 pnpm --prod 对纯 devDeps peer 不安装，
  // 本用例专门覆盖“路径已存在”的边界。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    if (setup.code !== 0) { check('T1-G setup deploys A', false, setup.out); return }
    const hostPeerRoot = join(root, 'host-peers')
    mkdirSync(join(hostPeerRoot, 'stub-peer'), { recursive: true })
    writeFileSync(join(hostPeerRoot, 'stub-peer', 'package.json'), JSON.stringify({ name: 'stub-peer', version: '2.0.0', type: 'module', main: 'index.js' }, null, 2))
    writeFileSync(join(hostPeerRoot, 'stub-peer', 'index.js'), "export const VERSION = 'host-2.0.0'\n")
    mkdirSync(join(repo, 'hephi', 'vendor', 'stub-peer'), { recursive: true })
    writeFileSync(join(repo, 'hephi', 'vendor', 'stub-peer', 'package.json'), JSON.stringify({ name: 'stub-peer', version: '1.0.0', type: 'module', main: 'index.js' }, null, 2))
    writeFileSync(join(repo, 'hephi', 'vendor', 'stub-peer', 'index.js'), "export const VERSION = 'bundled-1.0.0'\n")
    const pkgFile = join(repo, 'hephi', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    pkg.dependencies['stub-peer'] = 'file:./vendor/stub-peer'
    pkg.peerDependencies = { 'stub-peer': '^2.0.0' }
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2))
    const lock = run('pnpm', ['install', '--lockfile-only', '--offline'], { cwd: join(repo, 'hephi') })
    if (lock.code !== 0) throw new Error(`cannot refresh the stub lockfile: ${lock.out}`)
    const peerSha = commitRepo('peer that is also a production dependency')
    const r = await deploy(['--target', peerSha, '--previous', A, '--peer-root', hostPeerRoot])
    const metaG = existsSync(join(releaseDir(peerSha), 'meta.json')) ? JSON.parse(readFileSync(join(releaseDir(peerSha), 'meta.json'), 'utf8')) : null
    const peerLink = join(releaseDir(peerSha), 'node_modules', 'stub-peer')
    check('T1-G deploy with an existing peer path succeeds', r.code === 0, `code=${r.code} ${r.out}`)
    check('T1-G incoming peer entry is replaced by the explicit host peer link', Boolean(metaG) && metaG.dependencies.peers['stub-peer'] === join(hostPeerRoot, 'stub-peer') && metaG.dependencies.peersReplaced.includes('stub-peer') && existsSync(peerLink), JSON.stringify(metaG && metaG.dependencies))
    check('T1-G host peer version wins over the packaged one', existsSync(peerLink) && JSON.parse(readFileSync(join(peerLink, 'package.json'), 'utf8')).version === '2.0.0', peerLink)
  } finally {
    await closeWorld()
  }

  // T1-H：新格式 release 缺 activation 元数据 → 停机前拒绝，禁止静默退回 health-only 门禁。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    if (setup.code !== 0) { check('T1-H setup deploys A', false, setup.out); return }
    const strippedSha = FULL('e')
    const copy = run('cp', ['-R', releaseDir(A), releaseDir(strippedSha)])
    if (copy.code !== 0) throw new Error(`cannot copy the release fixture: ${copy.out}`)
    const metaFile = join(releaseDir(strippedSha), 'meta.json')
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'))
    meta.pluginCommit = strippedSha
    delete meta.activation
    writeFileSync(metaFile, JSON.stringify(meta, null, 2))
    const startsBefore = starts()
    const r = await deploy(['--rollback', '--target', strippedSha])
    check('T1-H new-format release without activation metadata is rejected', r.code !== 0 && /missing activation metadata/.test(r.out), `code=${r.code} ${r.out}`)
    check('T1-H no health-only fallback and no restart', pointer() === join(releaseDir(A), 'lib') && starts() === startsBefore, `pointer=${pointer()} starts ${startsBefore} -> ${starts()}`)
  } finally {
    await closeWorld()
  }
}

// ---- F1：release meta v2 完整性 + legacy 仅显式授权回滚/恢复 ----
// 每个用例复制一个已发布的新格式 release，只改 meta/lib；这些负例必须在停机/切换指针之前被拒绝。
function copyRelease(sourceSha, targetSha, mutate) {
  const copy = run('cp', ['-R', releaseDir(sourceSha), releaseDir(targetSha)])
  if (copy.code !== 0) throw new Error(`cannot copy the release fixture: ${copy.out}`)
  const dir = releaseDir(targetSha)
  const metaFile = join(dir, 'meta.json')
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'))
  meta.pluginCommit = targetSha
  mutate(meta, dir)
  writeFileSync(metaFile, JSON.stringify(meta, null, 2))
  return meta
}

function releaseToolRun(...args) {
  return run(process.execPath, [join(repoRoot, 'scripts/host/release-meta.mjs'), ...args])
}

function inspectRelease(sha) {
  const dir = releaseDir(sha)
  return {
    check: releaseToolRun('check', '--release', dir, '--sha', sha),
    activation: releaseToolRun('activation', '--release', dir),
    checkLegacy: releaseToolRun('check', '--release', dir, '--sha', sha, '--allow-legacy-rollback'),
    activationLegacy: releaseToolRun('activation', '--release', dir, '--allow-legacy-rollback'),
  }
}

function snapshotGateState() {
  return { pointer: pointer(), pid: hostPidValue(), starts: starts() }
}

function gateUntouched(before) {
  return pointer() === before.pointer && hostPidValue() === before.pid && pidAlive(before.pid) && starts() === before.starts
}

function downgradeToLegacy(meta) {
  delete meta.entries
  delete meta.dependencies
  delete meta.activation
  meta.formatVersion = 1
}

function tamperDowngraded(meta, dir) {
  downgradeToLegacy(meta)
  const file = join(dir, 'lib', 'index.mjs')
  writeFileSync(file, `${readFileSync(file, 'utf8')}\nexport const f1Tampered = true\n`)
  meta.entrySha256 = sha256(file)
}

async function expectForwardReject(name, sha) {
  const before = snapshotGateState()
  const r = await deploy(['--target', sha, '--previous', A])
  check(`${name} is rejected before any host change`, r.code !== 0, `code=${r.code} ${r.out}`)
  check(`${name} leaves the host, pointer and start count untouched`, gateUntouched(before), `pointer=${pointer()} pid=${hostPidValue()} starts ${before.starts} -> ${starts()}`)
  return r
}

async function runF1Suite() {
  // F1-A：prepare 输出完整 v2；check 与 activation 判定一致。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    check('F1-A setup deploys A', setup.code === 0, setup.out)
    const metaA2 = existsSync(join(releaseDir(A), 'meta.json')) ? JSON.parse(readFileSync(join(releaseDir(A), 'meta.json'), 'utf8')) : null
    const completeV2 = Boolean(metaA2) && metaA2.formatVersion === 2 &&
      Boolean(metaA2.entries) && /^[0-9a-f]{64}$/.test(String(metaA2.entries.index)) && /^[0-9a-f]{64}$/.test(String(metaA2.entries.tools)) &&
      Boolean(metaA2.dependencies) && /^[0-9a-f]{64}$/.test(String(metaA2.dependencies.lockfileSha256)) && Boolean(metaA2.dependencies.resolved) &&
      Boolean(metaA2.activation) && metaA2.activation.markerVersion === 1 && Array.isArray(metaA2.activation.entries) && metaA2.activation.entries.join(',') === 'index,tools'
    check('F1-A prepare writes a complete formatVersion:2 meta', completeV2, JSON.stringify(metaA2))
    const inspectA = inspectRelease(A)
    check('F1-A complete v2 passes check', inspectA.check.code === 0, inspectA.check.out)
    check('F1-A complete v2 activation requires both entries', inspectA.activation.code === 0 && inspectA.activation.out.trim() === 'required:index,tools', inspectA.activation.out)

    const v2Fixtures = [
      ['F1-B v2 without entries', '1', (meta) => { delete meta.entries }],
      ['F1-C v2 without dependencies', '2', (meta) => { delete meta.dependencies }],
      ['F1-D v2 without activation', '3', (meta) => { delete meta.activation }],
      ['F1-E v2 without all three sections', '4', (meta) => { delete meta.entries; delete meta.dependencies; delete meta.activation }],
    ]
    for (const [name, char, mutate] of v2Fixtures) {
      const sha = FULL(char)
      copyRelease(A, sha, mutate)
      const probe = inspectRelease(sha)
      check(`${name} fails check`, probe.check.code !== 0 && /v2 is incomplete/.test(probe.check.out), probe.check.out)
      check(`${name} activation is invalid, never legacy`, probe.activation.code === 0 && probe.activation.out.trim() === 'invalid', probe.activation.out)
      check(`${name} stays rejected even with explicit legacy authorization`, probe.checkLegacy.code !== 0, probe.checkLegacy.out)
      await expectForwardReject(name, sha)
    }

    // F1-F：未知 formatVersion。
    const unknownSha = FULL('5')
    copyRelease(A, unknownSha, (meta) => { meta.formatVersion = 3 })
    const unknownProbe = inspectRelease(unknownSha)
    check('F1-F unknown formatVersion fails check', unknownProbe.check.code !== 0 && /unsupported release meta format: 3/.test(unknownProbe.check.out), unknownProbe.check.out)
    check('F1-F unknown formatVersion activation is invalid', unknownProbe.activation.code === 0 && unknownProbe.activation.out.trim() === 'invalid', unknownProbe.activation.out)
    await expectForwardReject('F1-F unknown formatVersion', unknownSha)

    // F1-G：降级为 v1（删除三段并改写 formatVersion）→ 正向拒绝。
    const downgradeSha = FULL('6')
    copyRelease(A, downgradeSha, downgradeToLegacy)
    const downgradeProbe = inspectRelease(downgradeSha)
    check('F1-G downgraded legacy fails check without explicit authorization', downgradeProbe.check.code !== 0 && /allow-legacy-rollback/.test(downgradeProbe.check.out), downgradeProbe.check.out)
    check('F1-G downgraded legacy activation is invalid without explicit authorization', downgradeProbe.activation.code === 0 && downgradeProbe.activation.out.trim() === 'invalid', downgradeProbe.activation.out)
    check('F1-G same meta is a valid historical v1 only under explicit authorization', downgradeProbe.checkLegacy.code === 0 && downgradeProbe.activationLegacy.out.trim() === 'legacy', `${downgradeProbe.checkLegacy.out} / ${downgradeProbe.activationLegacy.out}`)
    const downgradeDeploy = await expectForwardReject('F1-G downgraded legacy forward deploy', downgradeSha)
    check('F1-G downgraded legacy never reaches the import probe or health-only gate', !/import probe ok|skipped-legacy|activation: explicitly authorized legacy/.test(downgradeDeploy.out), downgradeDeploy.out)

    // F1-H：降级后再篡改 lib 并重算 legacy 哈希 → 正向仍拒绝（哈希自洽不是授权）。
    const tamperedSha = FULL('7')
    copyRelease(A, tamperedSha, tamperDowngraded)
    const tamperedFile = join(releaseDir(tamperedSha), 'lib', 'index.mjs')
    const tamperedMeta = JSON.parse(readFileSync(join(releaseDir(tamperedSha), 'meta.json'), 'utf8'))
    check('F1-H fixture really changed lib/index.mjs and kept the legacy hash self-consistent', readFileSync(tamperedFile, 'utf8').includes('f1Tampered') && tamperedMeta.entrySha256 === sha256(tamperedFile) && metaA2.entries.index !== sha256(tamperedFile), sha256(tamperedFile))
    const tamperedDeploy = await expectForwardReject('F1-H tampered downgraded legacy forward deploy', tamperedSha)
    check('F1-H tampered downgrade is refused by the format gate, not the legacy hash', /allow-legacy-rollback/.test(tamperedDeploy.out), tamperedDeploy.out)
  } finally {
    await closeWorld()
  }

  // F1-I：legacy 仅显式授权回滚/恢复；正向 legacy target 无法借 flag 通过。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    check('F1-I setup deploys A', setup.code === 0, setup.out)
    const legacySha = FULL('8')
    legacyRelease(legacySha)
    const legacyProbe = inspectRelease(legacySha)
    check('F1-I historical v1 fails check without explicit authorization', legacyProbe.check.code !== 0 && /allow-legacy-rollback/.test(legacyProbe.check.out), legacyProbe.check.out)
    check('F1-I historical v1 activation is invalid without explicit authorization', legacyProbe.activation.code === 0 && legacyProbe.activation.out.trim() === 'invalid', legacyProbe.activation.out)
    check('F1-I historical v1 passes only with explicit authorization', legacyProbe.checkLegacy.code === 0 && legacyProbe.activationLegacy.out.trim() === 'legacy', `${legacyProbe.checkLegacy.out} / ${legacyProbe.activationLegacy.out}`)

    const beforeNoFlag = snapshotGateState()
    const noFlag = await deploy(['--rollback', '--target', legacySha])
    check('F1-I legacy rollback without the flag is rejected', noFlag.code !== 0 && /allow-legacy-rollback/.test(noFlag.out), `code=${noFlag.code} ${noFlag.out}`)
    check('F1-I rejected legacy rollback leaves the host and pointer untouched', gateUntouched(beforeNoFlag), `pointer=${pointer()} pid=${hostPidValue()} starts ${beforeNoFlag.starts} -> ${starts()}`)

    const beforeForward = snapshotGateState()
    const forward = await deploy(['--target', legacySha, '--previous', A, '--allow-legacy-rollback'])
    check('F1-I the flag cannot authorize a forward legacy target', forward.code !== 0 && /target release is invalid/.test(forward.out), `code=${forward.code} ${forward.out}`)
    check('F1-I forward legacy target is refused before any host change', gateUntouched(beforeForward), `pointer=${pointer()} pid=${hostPidValue()} starts ${beforeForward.starts} -> ${starts()}`)

    const strippedSha = FULL('9')
    copyRelease(A, strippedSha, (meta) => { delete meta.activation })
    const beforeStripped = snapshotGateState()
    const strippedRollback = await deploy(['--rollback', '--target', strippedSha, '--allow-legacy-rollback'])
    check('F1-I incomplete v2 stays rejected even with the legacy flag', strippedRollback.code !== 0 && /v2 is incomplete/.test(strippedRollback.out), `code=${strippedRollback.code} ${strippedRollback.out}`)
    check('F1-I rejected incomplete v2 rollback leaves the host and pointer untouched', gateUntouched(beforeStripped), `pointer=${pointer()} pid=${hostPidValue()} starts ${beforeStripped.starts} -> ${starts()}`)

    const ok = await deploy(['--rollback', '--target', legacySha, '--allow-legacy-rollback'])
    const rec = readRecords('rollback').find((x) => x.result === 'ok')
    check('F1-I explicitly authorized historical rollback succeeds', ok.code === 0, `code=${ok.code} ${ok.out}`)
    check('F1-I pointer switches to the legacy release', pointer() === join(releaseDir(legacySha), 'lib'), pointer())
    check('F1-I record marks unverified-legacy and skipped-legacy', Boolean(rec) && rec.activation === 'unverified-legacy' && rec.importProbe === 'skipped-legacy', JSON.stringify(rec))
  } finally {
    await closeWorld()
  }

  // F1-J：previous/current 恢复目标使用同一显式授权；未授权时拒绝回滚。
  await initWorld()
  try {
    const setupA = await deploy(['--target', A])
    check('F1-J setup deploys A', setupA.code === 0, setupA.out)
    const setupB = await deploy(['--target', B, '--previous', A])
    check('F1-J setup deploys B', setupB.code === 0, setupB.out)
    const legacySha = FULL('a')
    legacyRelease(legacySha)
    const beforeNoFlag = snapshotGateState()
    const noFlag = await deploy(['--rollback', '--target', A, '--previous', legacySha])
    check('F1-J legacy restore target without explicit authorization rejects the rollback', noFlag.code !== 0 && /previous release is invalid/.test(noFlag.out), `code=${noFlag.code} ${noFlag.out}`)
    check('F1-J rejected rollback leaves B loaded and the host untouched', pointer() === join(releaseDir(B), 'lib') && gateUntouched(beforeNoFlag), `pointer=${pointer()} starts ${beforeNoFlag.starts} -> ${starts()}`)
    const ok = await deploy(['--rollback', '--target', A, '--previous', legacySha, '--allow-legacy-rollback'])
    check('F1-J the same explicit authorization admits a legacy restore target', ok.code === 0, `code=${ok.code} ${ok.out}`)
    check('F1-J rollback target itself remains the complete v2 release A', pointer() === join(releaseDir(A), 'lib'), pointer())
  } finally {
    await closeWorld()
  }
  // F1-K：旧 prepare 实际产物 formatVersion:1 三段齐全 → 显式回滚仍按完整字段校验并要求
  // required 双入口；三段部分残缺（降级/混合）即使有 flag 也拒绝。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    check('F1-K setup deploys A', setup.code === 0, setup.out)
    const completeV1Sha = FULL('b')
    copyRelease(A, completeV1Sha, (meta, dir) => {
      meta.formatVersion = 1
      // 旧 prepare 的 v1 仍带 entries；让夹具的 lib 也自报夹具 commit，才能走真实导入探针。
      const file = join(dir, 'lib', 'index.mjs')
      writeFileSync(file, readFileSync(file, 'utf8').split(A).join(completeV1Sha))
      meta.entries.index = sha256(file)
      meta.entrySha256 = meta.entries.index
    })
    const completeProbe = inspectRelease(completeV1Sha)
    check('F1-K complete v1 fails check for a forward release', completeProbe.check.code !== 0 && /allow-legacy-rollback/.test(completeProbe.check.out), completeProbe.check.out)
    check('F1-K complete v1 activation is invalid without explicit authorization', completeProbe.activation.code === 0 && completeProbe.activation.out.trim() === 'invalid', completeProbe.activation.out)
    check('F1-K complete v1 under explicit authorization still validates all original fields', completeProbe.checkLegacy.code === 0, completeProbe.checkLegacy.out)
    check('F1-K complete v1 under explicit authorization requires both activation entries', completeProbe.activationLegacy.code === 0 && completeProbe.activationLegacy.out.trim() === 'required:index,tools', completeProbe.activationLegacy.out)

    const beforeForward = snapshotGateState()
    const forward = await deploy(['--target', completeV1Sha, '--previous', A, '--allow-legacy-rollback'])
    check('F1-K the flag cannot authorize a forward complete-v1 target', forward.code !== 0 && /target release is invalid/.test(forward.out), `code=${forward.code} ${forward.out}`)
    check('F1-K forward complete-v1 target is refused before any host change', gateUntouched(beforeForward), `pointer=${pointer()} pid=${hostPidValue()} starts ${beforeForward.starts} -> ${starts()}`)

    const partialSha = FULL('c')
    copyRelease(A, partialSha, (meta) => { meta.formatVersion = 1; delete meta.activation })
    const partialProbe = inspectRelease(partialSha)
    check('F1-K partially upgraded v1 fails check even with explicit authorization', partialProbe.checkLegacy.code !== 0 && /partially upgraded/.test(partialProbe.checkLegacy.out), partialProbe.checkLegacy.out)
    check('F1-K partially upgraded v1 activation is invalid even with explicit authorization', partialProbe.activationLegacy.code === 0 && partialProbe.activationLegacy.out.trim() === 'invalid', partialProbe.activationLegacy.out)

    const beforePartial = snapshotGateState()
    const partialRollback = await deploy(['--rollback', '--target', partialSha, '--allow-legacy-rollback'])
    check('F1-K partially upgraded v1 rollback is refused', partialRollback.code !== 0 && /partially upgraded|release is invalid/.test(partialRollback.out), `code=${partialRollback.code} ${partialRollback.out}`)
    check('F1-K refused partial-v1 rollback leaves the host and pointer untouched', gateUntouched(beforePartial), `pointer=${pointer()} pid=${hostPidValue()} starts ${beforePartial.starts} -> ${starts()}`)

    const beforeNoFlag = snapshotGateState()
    const noFlag = await deploy(['--rollback', '--target', completeV1Sha])
    check('F1-K complete v1 rollback without the flag is rejected', noFlag.code !== 0 && /allow-legacy-rollback/.test(noFlag.out), `code=${noFlag.code} ${noFlag.out}`)
    check('F1-K rejected complete-v1 rollback leaves the host and pointer untouched', gateUntouched(beforeNoFlag), `pointer=${pointer()} pid=${hostPidValue()} starts ${beforeNoFlag.starts} -> ${starts()}`)

    const ok = await deploy(['--rollback', '--target', completeV1Sha, '--allow-legacy-rollback'])
    const rec = readRecords('rollback').find((x) => x.result === 'ok')
    check('F1-K explicitly authorized complete-v1 rollback succeeds', ok.code === 0, `code=${ok.code} ${ok.out}`)
    check('F1-K complete-v1 rollback still verifies both activation entries', Boolean(rec) && rec.activation === 'verified' && /"index"/.test(String(rec.activationEvidence)) && /"tools"/.test(String(rec.activationEvidence)), JSON.stringify(rec && rec.activationEvidence))
    check('F1-K complete-v1 rollback does not skip the import probe as legacy', Boolean(rec) && rec.importProbe !== 'skipped-legacy' && /"ok":true/.test(String(rec.importProbe)), JSON.stringify(rec && rec.importProbe))
    check('F1-K pointer switches to the complete-v1 release', pointer() === join(releaseDir(completeV1Sha), 'lib'), pointer())
  } finally {
    await closeWorld()
  }
}

// ---- F2：release-meta 依赖元数据完整性（tree 哈希必需 + package.json 交叉核对） ----
function f2Meta(dir) {
  return JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
}

async function runF2Suite() {
  // 正例：正常发布包的 check/activation 全过，且 meta 记录非 null 依赖树哈希。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    check('F2 setup deploys A', setup.code === 0, setup.out)
    const meta = f2Meta(releaseDir(A))
    const info = inspectRelease(A)
    check('F2 normal release records the dependency tree hash', typeof meta.dependencies.nodeModulesSha256 === 'string' && /^[0-9a-f]{64}$/.test(meta.dependencies.nodeModulesSha256), JSON.stringify(meta.dependencies.nodeModulesSha256))
    check('F2 normal release passes the release check', info.check.code === 0, `code=${info.check.code} ${info.check.out}`)
    check('F2 normal release requires both activation entries', info.activation.code === 0 && info.activation.out.trim() === 'required:index,tools', info.activation.out)
    check('F2 package.json cross-check covers every packaged production dependency', JSON.stringify(Object.keys(meta.dependencies.resolved)) === JSON.stringify(['stub-dep']), JSON.stringify(meta.dependencies.resolved))
  } finally {
    await closeWorld()
  }

  // 负例 1：tree 哈希 null + node_modules 新增文件（旧实现直接跳过树校验）。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    check('F2-A setup deploys A', setup.code === 0, setup.out)
    const sha = FULL('d')
    copyRelease(A, sha, (meta, dir) => {
      meta.dependencies.nodeModulesSha256 = null
      writeFileSync(join(dir, 'node_modules', 'f2-extra.txt'), 'extra\n')
    })
    const info = inspectRelease(sha)
    check('F2-A null dependency tree hash is rejected (no tree-validation skip)',
      info.check.code !== 0 && /nodeModulesSha256/.test(info.check.out), `code=${info.check.code} ${info.check.out}`)
    check('F2-A activation reports invalid for the incomplete meta', info.activation.code === 0 && info.activation.out.trim() === 'invalid', info.activation.out)
    const before = snapshotGateState()
    const r = await deploy(['--target', sha, '--previous', A])
    check('F2-A forward deploy is rejected before any host change', r.code !== 0 && gateUntouched(before), `code=${r.code} ${r.out}`)
  } finally {
    await closeWorld()
  }

  // 负例 2：截断 dependencies.resolved（删 stub-dep，node_modules 与 package.json 不动）。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    check('F2-B setup deploys A', setup.code === 0, setup.out)
    const sha = FULL('c')
    copyRelease(A, sha, (meta) => {
      delete meta.dependencies.resolved['stub-dep']
    })
    const info = inspectRelease(sha)
    check('F2-B truncated resolved metadata is rejected by the package.json cross-check',
      info.check.code !== 0 && /missing the resolved entry for declared dependency/.test(info.check.out), `code=${info.check.code} ${info.check.out}`)
  } finally {
    await closeWorld()
  }

  // 负例 3：随包 package.json 删依赖，但 meta 仍记录该 resolved 条目（反向交叉核对）。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    check('F2-C setup deploys A', setup.code === 0, setup.out)
    const sha = FULL('b')
    copyRelease(A, sha, (meta, dir) => {
      const pkgFile = join(dir, 'package.json')
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
      delete pkg.dependencies['stub-dep']
      writeFileSync(pkgFile, JSON.stringify(pkg, null, 2))
    })
    const info = inspectRelease(sha)
    check('F2-C a resolved entry not declared by package.json is rejected',
      info.check.code !== 0 && /records a resolved dependency that package.json does not declare/.test(info.check.out), `code=${info.check.code} ${info.check.out}`)
  } finally {
    await closeWorld()
  }

  // 负例 4：peers 记录未被随包 package.json 声明的 peer。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    check('F2-D setup deploys A', setup.code === 0, setup.out)
    const sha = FULL('a')
    copyRelease(A, sha, (meta) => {
      meta.dependencies.peers['ghost-peer'] = 'optional-missing'
    })
    const info = inspectRelease(sha)
    check('F2-D a peer entry not declared by package.json is rejected',
      info.check.code !== 0 && /records a peer that package.json does not declare/.test(info.check.out), `code=${info.check.code} ${info.check.out}`)
  } finally {
    await closeWorld()
  }
}

// 双向证据：同一批负例对旧 main（无修复）与修复分支各跑一次；旧代码必须因“未拒绝”而失败。
async function runF1BidirectionalSuite() {
  const cases = [
    ['downgraded legacy', FULL('6'), downgradeToLegacy],
    ['tampered downgraded legacy', FULL('7'), tamperDowngraded],
  ]
  for (const [name, sha, mutate] of cases) {
    await initWorld()
    try {
      const setup = await deploy(['--target', A])
      check(`F1-bidirectional ${name} setup deploys A`, setup.code === 0, setup.out)
      copyRelease(A, sha, mutate)
      const before = snapshotGateState()
      const r = await deploy(['--target', sha, '--previous', A])
      check(`F1-bidirectional ${name} forward deploy is rejected`, r.code !== 0, `code=${r.code} output=${r.out}`)
      check(`F1-bidirectional ${name} leaves the host, pointer and start count untouched`, gateUntouched(before), `pointer=${pointer()} pid=${hostPidValue()} starts ${before.starts} -> ${starts()}`)
    } finally {
      await closeWorld()
    }
  }
}

// ---- deploy UX：--hephi 实载目录校验 + legacy previous 恢复目标语义 ----
async function runDeployUxSuite() {
  // UX-1：默认 --hephi 目录缺失 → exit 2，且不进入 pause/stop/build（无副作用）。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    check('UX-1 setup deploys A', setup.code === 0, setup.out)
    const beforePid = hostPidValue(); const beforeStarts = starts(); const beforeRecords = readRecords('deploy').length
    const beforePointer = readlinkSync(join(instance, 'hephi', 'lib'))
    renameSync(join(instance, 'hephi'), join(instance, 'hephi-hidden'))
    let r
    try { r = await deployWithoutHePhi(['--target', B, '--previous', A]) } finally { renameSync(join(instance, 'hephi-hidden'), join(instance, 'hephi')) }
    check('UX-1 missing default --hephi exits 2 before pause/stop', r.code === 2, `code=${r.code} ${r.out}`)
    check('UX-1 error names the plugin directory and --hephi hint', /plugin directory not found/.test(r.out) && /--hephi/.test(r.out) && /hephi-superagent-plugin/.test(r.out), r.out)
    check('UX-1 no side effects (pid/starts/pointer/records unchanged)',
      hostPidValue() === beforePid && starts() === beforeStarts && readRecords('deploy').length === beforeRecords
        && readlinkSync(join(instance, 'hephi', 'lib')) === beforePointer,
      `pid=${hostPidValue()} starts=${starts()} records=${readRecords('deploy').length} pointer=${readlinkSync(join(instance, 'hephi', 'lib'))}`)

    // UX-2：显式 --hephi 指向错误目录 → 同样 exit 2 无副作用。
    const badDir = join(root, 'not-a-plugin')
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, 'package.json'), JSON.stringify({ name: 'not-hephi-plugin' }, null, 2))
    const sidePid = hostPidValue(); const sideStarts = starts(); const sidePointer = readlinkSync(join(instance, 'hephi', 'lib'))
    const bad = await deploy(['--target', B, '--previous', A, '--hephi', badDir])
    check('UX-2 explicit --hephi that is not the plugin exits 2 with a clear name check', bad.code === 2 && /is not hephi-superagent-plugin/.test(bad.out), `code=${bad.code} ${bad.out}`)
    check('UX-2 explicit bad --hephi has no side effects', hostPidValue() === sidePid && starts() === sideStarts && readlinkSync(join(instance, 'hephi', 'lib')) === sidePointer, `pid=${hostPidValue()} starts=${starts()}`)
  } finally {
    await closeWorld()
  }

  // UX-3：legacy previous + v2 target 正向部署成功（previous 是恢复目标，不需要 --allow-legacy-rollback）。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    check('UX-3 setup deploys A', setup.code === 0, setup.out)
    const legacySha = FULL('5')
    copyRelease(A, legacySha, downgradeToLegacy)
    pointAt(legacySha)
    createEffectsDatabase(0).close()
    const oldPid = hostPidValue(); const startsBefore = starts()
    const r = await deploy(effectsDeployArgs(['--previous', legacySha]))
    const rec = readRecords('deploy').find((x) => x.result === 'ok' && x.drainMode === 'effects' && x.previous === legacySha)
    check('UX-3 legacy previous + v2 target deploys without --allow-legacy-rollback', r.code === 0, `code=${r.code} ${r.out}`)
    check('UX-3 target B (v2) pointer switched', pointer() === join(releaseDir(B), 'lib'), pointer())
    check('UX-3 record marks previousLegacy=true', Boolean(rec) && rec.previousLegacy === true && rec.previous === legacySha, JSON.stringify(rec))
    check('UX-3 target activation is still strictly verified', Boolean(rec) && rec.activation === 'verified' && /"index"/.test(String(rec.activationEvidence)), JSON.stringify(rec && rec.activationEvidence))
    check('UX-3 host restarted with a new live pid', hostPidValue() !== oldPid && pidAlive(hostPidValue()) && starts() > startsBefore, `old=${oldPid} new=${hostPidValue()} starts ${startsBefore} -> ${starts()}`)
  } finally {
    await closeWorld()
  }

  // UX-4：target 启动失败时恢复 legacy previous → health-only + unverified-legacy。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    check('UX-4 setup deploys A', setup.code === 0, setup.out)
    const legacySha = FULL('4')
    copyRelease(A, legacySha, downgradeToLegacy)
    pointAt(legacySha)
    createEffectsDatabase(0).close()
    // 第一次启动（target B）健康 ready 但没有激活标识 → 切换后失败；第二次启动（恢复 legacy）正常。
    writeStart(`echo attempt >> "${instance}/start.log"
if [ ! -f "${instance}/fail-once-used" ]; then : > "${instance}/fail-once-used"; : > "${instance}/started.marker"; exec sleep 3600; fi
${activationMarkers()}
: > "${instance}/started.marker"
exec sleep 3600`)
    rmSync(join(instance, 'started.marker'), { force: true })
    const r = await deploy(effectsDeployArgs(['--previous', legacySha]))
    const rec = readRecords('deploy').find((x) => x.result === 'failed-drain-start')
    check('UX-4 failed target triggers the abort/restore path', r.code !== 0 && Boolean(rec), `code=${r.code} ${r.out}`)
    check('UX-4 record marks previousLegacy=true for the restore target', Boolean(rec) && rec.previousLegacy === true, JSON.stringify(rec))
    check('UX-4 legacy previous restored in health-only mode (unverified-legacy)',
      Boolean(rec) && rec.recoverHealth === 'all-required-ready' && rec.activation === 'unverified-legacy', JSON.stringify({ recoverHealth: rec && rec.recoverHealth, activation: rec && rec.activation }))
    check('UX-4 pointer restored to the legacy previous release', pointer() === join(releaseDir(legacySha), 'lib'), pointer())
  } finally {
    await closeWorld()
  }

  // UX-5：target 是 legacy 仍然拒绝（正向 target 必须 v2 完整，不接受自动 legacy）。
  await initWorld()
  try {
    const setup = await deploy(['--target', A])
    check('UX-5 setup deploys A', setup.code === 0, setup.out)
    const legacySha = FULL('3')
    copyRelease(A, legacySha, downgradeToLegacy)
    createEffectsDatabase(0).close()
    const oldPid = hostPidValue(); const startsBefore = starts()
    const r = await deploy(effectsDeployArgs(['--target', legacySha, '--previous', A]))
    const rec = readRecords('deploy').find((x) => x.result === 'failed-drain-release')
    check('UX-5 legacy forward target is rejected', r.code !== 0 && Boolean(rec), `code=${r.code} ${r.out}`)
    check('UX-5 rejection requires the explicit legacy rollback flag', /legacy/i.test(r.out) && /allow-legacy-rollback/.test(r.out), r.out)
    check('UX-5 rejection happens before stop (host/pointer/starts untouched)',
      pointer() === join(releaseDir(A), 'lib') && hostPidValue() === oldPid && pidAlive(oldPid) && starts() === startsBefore,
      `pointer=${pointer()} pid=${hostPidValue()} starts ${startsBefore} -> ${starts()}`)
  } finally {
    await closeWorld()
  }
}

const selectors = new Set(process.argv.slice(2))
if (selectors.has('--f1-bidirectional-only')) {
  await runF1BidirectionalSuite()
} else if (selectors.has('--f1-only')) {
  await runF1Suite()
} else {
  await runMainSuite()
  await runNegativeSuite()
  await runRemediationSuite()
  await runF02Suite()
  await runT1Suite()
  await runN1Suite()
  await runF1Suite()
  await runF2Suite()
  await runDeployUxSuite()
}

for (const line of results) console.log(line)
if (failures > 0) {
  console.log(`\nFAILED: ${failures} assertion(s)`)
  process.exit(1)
}
console.log(`\nPASS: ${results.length} assertions (R3 fake-host suite)`)
