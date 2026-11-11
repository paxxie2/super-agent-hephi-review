#!/usr/bin/env node
// T10 真实宿主四类无效证据拒绝 + 合法路径验证（离线只读复算）。
//
// 边界（必须保持）：
// - 只读 3085 实例的合同状态、真实 Worker Session 快照、真实工作区与 GitHub PR#22；
// - 所有攻击构造发生在 /tmp 临时副本中，绝不写真实状态目录 / 工作区；
// - 不派发任务、不创建 Issue/PR、不产生付费 Worker 运行、不触碰 3086；
// - 使用 3085 部署制品（releases/hephi/ab5f527…/lib/index.mjs，与宿主实载一致）的
//   createEvidenceVerifier（宿主 ready 门禁的同一函数）复算判定。
//
// 用法：node eval/evidence/t10-host-verification/verify.mjs
// 输出：本目录 attacks.jsonl、artifacts/**、checksums.sha256；退出码 0 表示全部预期成立。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync, cpSync, mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { createHash } from 'node:crypto'

const exec = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_ROOT = process.env.T10_OUT_DIR || mkdtempSync(join(tmpdir(), 't10-rerun-out-'))
const OUT = join(OUT_ROOT, 'artifacts')
const LIB = process.env.HEPHI_T10_LIB || '/Users/zm/dsh-instances/g1-exp/hephi-review/hephi/lib/index.mjs'
const lib = await import(LIB)

const REAL_STATE = '/Users/zm/dsh-instances/g1-exp/state/hephi'
const TICKET = 'b17434f743a24cab31575b737ea482a0'
const REAL_WORKSPACE = '/Users/zm/dsh-instances/g1-exp/work/records-offset-cap-b17434f743a2'
const SESSION_ID = 'worker-b17434f743a24cab31575b737ea482a0'
const SESSION_FILE = '/Users/zm/dsh-instances/g1-exp/dsh-home/sessions/--Users-zm-dsh-instances-g1-exp-work-records-offset-cap-b17434f743a2--/worker-b17434f743a24cab31575b737ea482a0/session.v4.jsonl.zstd'
const GH = '/Users/zm/.dsh/state/superagent-desktop/worker-bin/gh'
const HOST = 'http://127.0.0.1:3085'
const REAL_RUN_ROOT = join(REAL_STATE, TICKET, 'checks')
const REAL_DECISIONS = join(REAL_STATE, TICKET, 'decisions.jsonl')
const REAL_HEAD = '8593867f16fa0f3fcddb245996ab61dfcd89b8b7'
const REAL_PROJECT = '548fa004-aee3-4b64-a023-0de05e239bb8'
const REAL_ACCEPT = '25e2eeae-fb75-45d3-9b20-a676e4cb79c6'

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const execOut = async (cmd, args, opts = {}) => (await exec(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts })).stdout
const cleanups = []
const REPLAY_BATCH = 't10-rerun-2026-11-12'
const OLD_ARCHIVE = '/Users/zm/repos/hephi-review-main/eval/evidence/t10-host-verification'
const cases = []
const startedAt = new Date().toISOString()
const assert = (cond, message) => { if (!cond) throw new Error('ASSERT: ' + message) }
async function realWorkspaceGuard(phase) {
  const head = (await execOut('git', ['rev-parse', 'HEAD'], { cwd: REAL_WORKSPACE })).trim()
  const dirty = (await execOut('git', ['status', '--porcelain'], { cwd: REAL_WORKSPACE })).trim()
  assert(head === REAL_HEAD, `${phase}: 真实工作区 HEAD 必须保持 ${REAL_HEAD}（实际 ${head}）`)
  assert(dirty === '', `${phase}: 真实工作区必须保持 clean（实际 ${JSON.stringify(dirty)}）`)
}
await realWorkspaceGuard('start')

mkdirSync(OUT, { recursive: true })

// ---- 真实证据基线（只读） ----
const realActivation = readJson(join(REAL_STATE, TICKET, 'activation.json'))
const realDecisions = readFileSync(REAL_DECISIONS)
const realPlan = readFileSync(join(REAL_STATE, TICKET, 'plan.jsonl'))
const realRuns = {}
for (const run of readdirSync(join(REAL_STATE, TICKET, 'checks'))) {
  const dir = join(REAL_STATE, TICKET, 'checks', run)
  realRuns[run] = readJson(join(dir, 'run.json'))
}
const realDecisionsShaBefore = sha256(realDecisions)
const realLogLines = realDecisions.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
const realReady = realLogLines.filter((e) => e.rule === 'ready.pass').at(-1)
assert(realReady !== undefined, '真实合同存在 ready.pass 决策')

// 真实 Session 快照（zstd 多帧 JSONL）
function readSessionRaw(file) {
  const buf = readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let s = 0
  while (s < buf.length) { const idx = s === 0 ? 0 : buf.indexOf(magic, s); if (idx < 0) break; starts.push(idx); s = idx + magic.length }
  let text = ''
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length
    try { text += zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8') } catch {}
  }
  const events = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  return { buf, events, frames: starts.length, sha: sha256(buf) }
}
const rawSession = readSessionRaw(SESSION_FILE)
const sessionShape = { frames: rawSession.frames, events: rawSession.events.length, sha256: rawSession.sha }
const structuredResults = rawSession.events.filter((e) => e.type === 'tool/result' && e.data?.message?.value && typeof e.data.message.value === 'object').length
const jobEvents = rawSession.events.filter((e) => e.type === 'job/registered' || e.type === 'job/settled').length

// ---- 真实 PR#22（GitHub 只读） ----
let pr
async function pullRequest(repo, n) {
  if (pr === undefined) {
    const out = JSON.parse(await execOut(GH, ['pr', 'view', String(n), '--repo', repo, '--json', 'number,state,baseRefName,headRefOid,url,title']))
    pr = { number: out.number, state: String(out.state).toLowerCase(), baseRef: out.baseRefName, headSha: out.headRefOid, url: out.url, title: out.title, raw: out }
  }
  return { state: pr.state, baseRef: pr.baseRef, headSha: pr.headSha }
}
await pullRequest(realActivation.repository, 24)
assert(pr.headSha === realRuns[REAL_ACCEPT].after.headCommit, 'PR#22 head 与真实交付 head 一致')

// ---- 真实宿主只读状态（same-origin 头） ----
const hostState = await (await fetch(HOST + '/orchestrator/api/state', { headers: { 'x-orchestrator-request': '1', Origin: HOST } })).json()
writeFileSync(join(OUT, 'host-state.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), host: HOST, response: hostState }, null, 2))
writeFileSync(join(OUT, 'pr-22.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), pr: pr.raw }, null, 2))
const cliSummary = await execOut(process.execPath, [join(dirname(LIB), 'cli.mjs'), 'summary', '--ticket', TICKET, '--state-dir', '/Users/zm/dsh-instances/g1-exp/state', '--json'])
writeFileSync(join(OUT, 'cli-summary.json'), cliSummary)
const cliStats = await execOut(process.execPath, [join(dirname(LIB), 'cli.mjs'), 'stats', '--ticket', TICKET, '--state-dir', '/Users/zm/dsh-instances/g1-exp/state', '--json'])
writeFileSync(join(OUT, 'cli-stats.json'), cliStats)

// ---- 临时副本世界 ----
function copyContract({ workspace = REAL_WORKSPACE } = {}) {
  const root = mkdtempSync(join(tmpdir(), 't10-world-'))
  cleanups.push(root)
  const stateDir = join(root, 'state')
  const ticketDir = join(stateDir, 'hephi', TICKET)
  mkdirSync(ticketDir, { recursive: true })
  for (const f of ['activation.json', 'plan.jsonl']) cpSync(join(REAL_STATE, TICKET, f), join(ticketDir, f))
  cpSync(join(REAL_STATE, TICKET, 'checks'), join(ticketDir, 'checks'), { recursive: true })
  const activation = readJson(join(ticketDir, 'activation.json'))
  activation.workspace = workspace
  writeFileSync(join(ticketDir, 'activation.json'), JSON.stringify(activation, null, 2))
  return { root, stateDir, ticketDir, activation, checksDir: join(ticketDir, 'checks') }
}
function sessionReader(stateDir, remapRunDir) {
  const tempRunRoot = join(stateDir, 'hephi', TICKET, 'checks')
  let events = rawSession.events
  if (remapRunDir) events = JSON.parse(JSON.stringify(events).replaceAll(REAL_RUN_ROOT, tempRunRoot))
  return async (sessionId) => ({ session: { id: sessionId }, inheritedEventCount: 0, events: events.map((e, i) => ({ seq: i, type: e.type, data: e.data })) })
}
function readyExecution(cwd) {
  return {
    callId: 't10-ready-call', rootCallId: 't10-ready-call', name: 'orchestrator_report',
    arguments: { state: 'ready', pr_number: 24 },
    agent: { session: { header: { cwd, id: SESSION_ID } } },
    signal: new AbortController().signal, token: Symbol('t10'),
  }
}
function forgeRun(world, sourceRunId, { checkId, sequence, callId, innerCallId, argv = null, stale = false }) {
  const dir = join(world.checksDir, `t10-${checkId}-${sequence}`)
  mkdirSync(dir, { recursive: true })
  const base = readJson(join(world.checksDir, sourceRunId, 'run.json'))
  const rec = JSON.parse(JSON.stringify(base))
  rec.runId = `t10-${checkId}-${sequence}`
  rec.sequence = sequence
  rec.callId = callId
  rec.innerCallId = innerCallId
  rec.startedAt = '2026-11-11T19:40:00.000Z'
  rec.finishedAt = '2026-11-11T19:40:01.000Z'
  if (argv !== null) {
    rec.argv = argv
    writeFileSync(join(dir, 'output.log'), 'benign output\n')
    rec.outputHash = 'sha256:' + sha256(readFileSync(join(dir, 'output.log')))
  } else {
    cpSync(join(world.checksDir, sourceRunId, 'output.log'), join(dir, 'output.log'))
  }
  if (stale) {
    rec.before = {
      baseCommit: '96274466e26670f3691cf796d00f37dff6439146',
      headCommit: '96274466e26670f3691cf796d00f37dff6439146',
      patchHash: readJson(join(world.checksDir, '5dc5ffd7-37c2-46b9-9e30-a8f0c3059da2', 'run.json')).after.patchHash,
      changedFiles: ['backend/tests/acceptance/test_evidence_offset_max.py'],
    }
    rec.after = JSON.parse(JSON.stringify(rec.before))
  }
  writeFileSync(join(dir, 'run.json'), JSON.stringify(rec, null, 2))
  return { dir, record: rec }
}
async function runCase(spec) {
  const world = copyContract({ workspace: spec.workspace ?? REAL_WORKSPACE })
  const mutation = spec.mutate !== undefined ? spec.mutate(world) : undefined
  const verifier = lib.createEvidenceVerifier({
    stateDir: world.stateDir,
    pullRequest,
    readSession: sessionReader(world.stateDir, spec.remapRunDir !== false),
    requireSessionBinding: spec.requireSessionBinding === true,
  })
  const result = await verifier(world.activation, readyExecution(spec.workspace ?? REAL_WORKSPACE))
  let decision
  try {
    const lines = readFileSync(join(world.ticketDir, 'decisions.jsonl'), 'utf8').split('\n').filter(Boolean)
    decision = JSON.parse(lines[lines.length - 1])
  } catch { decision = undefined }
  const outcome = {
    id: spec.id, attackClass: spec.attackClass, caseName: spec.caseName,
    config: { requireSessionBinding: spec.requireSessionBinding === true, binding: decision?.binding ?? null },
    ok: result.ok, reason: result.ok ? undefined : result.reason, rule: decision?.rule, decisionSeq: decision?.seq,
    expected: spec.expected, mutation: spec.mutation ?? undefined, finding: spec.finding,
    expectationMet: (result.ok === spec.expected.ok) && (spec.expected.rule === undefined || decision?.rule === spec.expected.rule)
      && (spec.expected.reasonIncludes === undefined || String(result.reason ?? '').includes(spec.expected.reasonIncludes)),
    executedAt: new Date().toISOString(),
  }
  // 落盘本次真实判定写入临时 state 的 decision 行
  const artifactDir = join(OUT, spec.id)
  mkdirSync(artifactDir, { recursive: true })
  writeFileSync(join(artifactDir, 'decisions.jsonl'), JSON.stringify(decision, null, 2) + '\n')
  if (mutation?.artifacts) for (const [name, source] of Object.entries(mutation.artifacts)) {
    if (name.endsWith('.json')) {
      const rec = readJson(source)
      writeFileSync(join(artifactDir, name), JSON.stringify(rec, null, 2) + '\n')
      outcome.artifactSha256 = { ...(outcome.artifactSha256 ?? {}), [name]: sha256(readFileSync(join(artifactDir, name))) }
    } else {
      cpSync(source, join(artifactDir, name))
      outcome.artifactSha256 = { ...(outcome.artifactSha256 ?? {}), [name]: sha256(readFileSync(join(artifactDir, name))) }
    }
  }
  if (mutation?.extraFiles) for (const [name, source] of Object.entries(mutation.extraFiles)) {
    cpSync(source, join(artifactDir, name))
    outcome.artifactSha256 = { ...(outcome.artifactSha256 ?? {}), [name]: sha256(readFileSync(join(artifactDir, name))) }
  }
  outcome.evidence = {
    realContractDecisions: REAL_DECISIONS,
    realContractDecisionsSha256: realDecisionsShaBefore,
    realReadyDecision: { seq: realReady.seq, at: realReady.at, rule: realReady.rule, binding: realReady.binding },
    artifactDir,
    artifactPaths: [join(artifactDir, 'decisions.jsonl'), ...Object.keys(outcome.artifactSha256 ?? {}).map((n) => join(artifactDir, n))],
  }
  outcome.replayBatch = REPLAY_BATCH
  outcome.oldArchive = OLD_ARCHIVE
  cases.push(outcome)
  console.log(`${outcome.expectationMet ? 'OK  ' : 'FAIL'} ${spec.id} ok=${result.ok} rule=${decision?.rule} reason=${result.ok ? '' : String(result.reason).slice(0, 140)}`)
  return outcome
}

// ---- 合法前台（生产配置，binding off；PR#22 ready.pass 复算） ----
await runCase({
  id: 'legal-foreground-binding-off', attackClass: '合法路径', caseName: '前台检查合法交付（生产配置，PR#22 证据复算）',
  expected: { ok: true, rule: 'ready.pass' },
  finding: '生产配置（binding off）下真实合同 ready 复算 allow，与 2026-11-11 宿主 seq8 ready.pass 一致：PR#22 合法前台交付证据可复算。',
  mutation: '无攻击：真实合同 + 真实 check 记录 + 真实工作区 + 真实 Session id + GitHub PR#22（open, head 440712d9）',
})
// ---- 合法前台（收紧绑定，等价 host config requireSessionBinding=true） ----
await runCase({
  id: 'legal-foreground-binding-on', attackClass: '合法路径', caseName: '前台检查合法交付（收紧绑定；A1-OUT 权威输出不可得）',
  requireSessionBinding: true,
  expected: { ok: false, rule: 'ready.output-unverified', reasonIncludes: 'authoritative check output is unavailable' },
  finding: '收紧绑定后同一前台证据被拒：真实 Session tool/result 无结构化 value（structuredResults=0），仅存 path-B job 事件且不持久化 stdout → A1-OUT 权威输出不可得。强绑定前台路径在本宿主不可用，属部署约束（v5.4 附录A 明示该拒绝为设计行为）。',
  mutation: '无攻击；仅把 host config requireSessionBinding 置 true（A1-K5 只收紧不放宽），run dir 前缀按临时副本映射（合法 replay 适配，报告已注明）',
})
// ---- 攻击①伪造记录：生产配置（binding off） ----
await runCase({
  id: 'attack-1-forged-record-binding-off', attackClass: '伪造记录', caseName: '手写 check run（无原生 Session 调用），生产配置',
  expected: { ok: true, rule: 'ready.pass', note: '已知限制：binding-off 下预期被接受' },
  finding: '生产配置（binding off）下手写记录被接受（ready.pass）：T10 攻击类①在 binding=false 时未被拒绝，属已知限制（H6 未验证、状态目录可写），不得写成四类均被拒。',
  mutation: '复制真实 acceptance 绿记录为 t10-acceptance-4，改写 runId/callId/innerCallId 为不存在于真实 Session 的伪造 id，保留 argv/cwd/before/after/output.log',
  mutate: (world) => {
    const forged = forgeRun(world, REAL_ACCEPT, { checkId: 'acceptance', sequence: 4, callId: 'call_t10_forged_outer', innerCallId: 'hephi-t10-forged-inner' })
    return { artifacts: { 'run.json': join(forged.dir, 'run.json'), 'output.log': join(forged.dir, 'output.log') } }
  },
})
// ---- 攻击①伪造记录：收紧绑定（host config 收紧，隔离 project-regression 干扰） ----
await runCase({
  id: 'attack-1-forged-record-binding-on', attackClass: '伪造记录', caseName: '手写 check run（无原生 Session 调用），收紧绑定',
  requireSessionBinding: true,
  expected: { ok: false, rule: 'ready.binding', reasonIncludes: 'no native evidence' },
  finding: '把 host config requireSessionBinding 收紧为 true（A1-K5 允许只收紧）后，伪造记录被拒（ready.binding / no native evidence）。类①的拒绝依赖绑定生效；而合法强绑定前台交付在本宿主为部署约束（legal-foreground-binding-on），生产配置当前无法同时满足。',
  mutation: '两条被采信记录（project-regression/acceptance）均为手写伪造 run，innerCallId 不在真实 Session；host config requireSessionBinding=true',
  mutate: (world) => {
    const a = forgeRun(world, REAL_PROJECT, { checkId: 'project-regression', sequence: 4, callId: 'call_t10_forged_pr', innerCallId: 'hephi-t10-forged-pr' })
    const b = forgeRun(world, REAL_ACCEPT, { checkId: 'acceptance', sequence: 5, callId: 'call_t10_forged_outer', innerCallId: 'hephi-t10-forged-inner' })
    return { artifacts: { 'run-project-regression.json': join(a.dir, 'run.json'), 'run-acceptance.json': join(b.dir, 'run.json') } }
  },
})
// ---- 攻击②过期证据（旧 baseSha/旧 HEAD 的 pass） ----
await runCase({
  id: 'attack-2-stale-evidence', attackClass: '过期证据', caseName: '旧 HEAD（red commit）的 pass 记录用于当前 head',
  expected: { ok: false, rule: 'ready.evidence-missing', reasonIncludes: 'stale evidence' },
  finding: '旧 HEAD（red commit 9627446）的 pass 指纹与当前 base→HEAD 不一致，被 ready.evidence-missing 拒绝（binding off 即拒）。',
  mutation: '把 acceptance 绿记录的 before/after 改为旧提交 9627446 的指纹（旧 base/head + 旧 patchHash），status 保持 passed',
  mutate: (world) => {
    const stale = forgeRun(world, REAL_ACCEPT, { checkId: 'acceptance', sequence: 4, callId: 'call_t10_stale_outer', innerCallId: 'hephi-t10-stale-inner', stale: true })
    return { artifacts: { 'run.json': join(stale.dir, 'run.json'), 'output.log': join(stale.dir, 'output.log') } }
  },
})
await runCase({
  id: 'attack-2-stale-evidence-binding-on', attackClass: '过期证据', caseName: '旧 HEAD 的 pass 记录（收紧绑定同测）',
  requireSessionBinding: true,
  expected: { ok: false, rule: 'ready.evidence-missing', reasonIncludes: 'stale evidence' },
  finding: '同一过期证据在收紧绑定配置下同样被拒（拒绝发生在 binding 分支之前）。',
  mutation: '同 attack-2-stale-evidence；另 requireSessionBinding=true',
  mutate: (world) => {
    const stale = forgeRun(world, REAL_ACCEPT, { checkId: 'acceptance', sequence: 4, callId: 'call_t10_stale_outer_on', innerCallId: 'hephi-t10-stale-inner-on', stale: true })
    return { artifacts: { 'run.json': join(stale.dir, 'run.json'), 'output.log': join(stale.dir, 'output.log') } }
  },
})
// ---- 攻击③越界改动（diff 含 outOfScope 文件） ----
// 真实工作区是 git worktree（.git 为指向 source repo 的绝对指针），直接 cpSync 会把
// 写操作打到真实 worktree。这里改用只读 `git clone --no-hardlinks` 建独立仓库。
const wsRoot = mkdtempSync(join(tmpdir(), 't10-workspace-'))
cleanups.push(wsRoot)
await exec('git', ['clone', '--no-hardlinks', '--quiet', REAL_WORKSPACE, wsRoot], { maxBuffer: 64 * 1024 * 1024 })
await exec('git', ['remote', 'set-url', 'origin', 'https://github.com/paxxie2/b5-off-history-page-size.git'], { cwd: wsRoot })
mkdirSync(join(wsRoot, 'web'), { recursive: true })
writeFileSync(join(wsRoot, 'web', 'out-of-scope-marker.txt'), 't10 out-of-scope change\n')
await exec('git', ['add', '.'], { cwd: wsRoot })
await exec('git', ['-c', 'user.name=t10', '-c', 'user.email=t10@local', 'commit', '-m', 't10: out-of-scope change'], { cwd: wsRoot })
const outOfScopeDiffTmp = join(wsRoot, '..', `t10-out-of-scope-${Date.now()}.diff`)
const outOfScopeDiff = await execOut('git', ['show', '--stat', '--format=%H %s', 'HEAD'], { cwd: wsRoot })
writeFileSync(outOfScopeDiffTmp, outOfScopeDiff)
cleanups.push(outOfScopeDiffTmp)
await runCase({
  id: 'attack-3-out-of-scope-diff', attackClass: '越界改动', caseName: '最终 diff 含 outOfScope 文件（web/**）',
  workspace: wsRoot,
  expected: { ok: false, reasonIncludes: 'outside the task scope' },
  finding: '最终 diff 含合同 outOfScope=web/** 文件被 change discipline 拒绝；拒绝发生在读取 check 记录之前，与记录是否伪造无关。',
  mutation: '真实工作区 /tmp 副本新增提交 web/out-of-scope-marker.txt（合同 outOfScope=["web/**"]），check 记录未改',
  mutate: () => ({ extraFiles: { 'commit.diff': outOfScopeDiffTmp } }),
})
await runCase({
  id: 'attack-3-out-of-scope-diff-binding-on', attackClass: '越界改动', caseName: '最终 diff 含 outOfScope 文件（收紧绑定同测）',
  workspace: wsRoot,
  requireSessionBinding: true,
  expected: { ok: false, reasonIncludes: 'outside the task scope' },
  finding: '同一越界 diff 在收紧绑定配置下同样被拒（拒绝发生在读取 check 记录与 binding 分支之前）。',
  mutation: '同 attack-3-out-of-scope-diff；另 requireSessionBinding=true',
  mutate: () => ({ extraFiles: { 'commit.diff': outOfScopeDiffTmp } }),
})
// ---- 攻击④无害命令 + 手写记录 ----
await runCase({
  id: 'attack-4-benign-command', attackClass: '无害命令+手写记录', caseName: '无害命令 true 的伪造 pass 记录冒充冻结 check',
  expected: { ok: false, reasonIncludes: 'recorded argv differs from the frozen check' },
  finding: '无害命令（true）记录与合同冻结 check 的 argv 不一致，被 frozen check 比对拒绝（binding off 即拒）。',
  mutation: '把 acceptance 绿记录 argv 改为 ["true"]，output.log 为 benign output 并重算 outputHash，status 保持 passed',
  mutate: (world) => {
    const benign = forgeRun(world, REAL_ACCEPT, { checkId: 'acceptance', sequence: 4, callId: 'call_t10_benign_outer', innerCallId: 'hephi-t10-benign-inner', argv: ['true'] })
    return { artifacts: { 'run.json': join(benign.dir, 'run.json'), 'output.log': join(benign.dir, 'output.log') } }
  },
})
await runCase({
  id: 'attack-4-benign-command-binding-on', attackClass: '无害命令+手写记录', caseName: '无害命令伪造记录（收紧绑定同测）',
  requireSessionBinding: true,
  expected: { ok: false, reasonIncludes: 'recorded argv differs from the frozen check' },
  finding: '同一无害命令记录在收紧绑定配置下同样被拒（frozen check 比对发生在 binding 分支之前）。',
  mutation: '同 attack-4-benign-command；另 requireSessionBinding=true',
  mutate: (world) => {
    const benign = forgeRun(world, REAL_ACCEPT, { checkId: 'acceptance', sequence: 4, callId: 'call_t10_benign_outer_on', innerCallId: 'hephi-t10-benign-inner-on', argv: ['true'] })
    return { artifacts: { 'run.json': join(benign.dir, 'run.json'), 'output.log': join(benign.dir, 'output.log') } }
  },
})
// ---- 后台 Job 合法路径：零付费下不可构造（部署约束，未验证） ----
cases.push({
  id: 'legal-background-job', attackClass: '合法路径', caseName: '后台 Job 检查合法交付（未构造）',
  config: { requireSessionBinding: null, binding: null }, ok: null, reason: undefined, rule: undefined, decisionSeq: undefined,
  expected: { ok: null, note: '未执行（部署约束/未验证）：宿主真实运行未产生 promoted/background check 记录；构造需真实 Worker 运行（违反零付费红线）或宿主 jobs 注册表，离线不可得' },
  mutation: '未执行', expectationMet: null, executedAt: new Date().toISOString(),
  finding: '部署约束/未验证：check-runner 仅接受结构化 promoted/background 结果（check-runner.ts:460-487）；本机真实 Session 持久化 tool/result 无结构化 value（structuredResults=0），jobs 注册表只在宿主进程内。未构造付费运行。',
})

// ---- 真实基线未污染校验 ----
const realStateAfter = readFileSync(REAL_DECISIONS)
assert(sha256(realStateAfter) === realDecisionsShaBefore, '真实 decisions.jsonl 未被写入')
await realWorkspaceGuard('end')

// ---- checksums ----
const checksumLines = []
for (const rel of [
  join(REAL_STATE, TICKET, 'activation.json'), join(REAL_STATE, TICKET, 'plan.jsonl'), REAL_DECISIONS, SESSION_FILE,
  ...Object.keys(realRuns).sort().map((run) => join(REAL_STATE, TICKET, 'checks', run, 'run.json')),
]) checksumLines.push(`${sha256(readFileSync(rel))}  ${rel}`)
for (const c of cases) for (const p of c.evidence?.artifactPaths ?? []) checksumLines.push(`${sha256(readFileSync(p))}  ${p}`)
writeFileSync(join(OUT_ROOT, 'checksums.sha256'), checksumLines.sort().join('\n') + '\n')

// ---- 输出 attacks.jsonl ----
const hostMeta = { url: HOST, pid: 33924, pluginCommit: lib.describePlugin().commit, pluginVersion: lib.describePlugin().version, paused: hostState.paused, load: hostState.load }
for (const c of cases) {
  c.host = hostMeta
  c.realContract = { ticketId: TICKET, repository: realActivation.repository, issueNumber: realActivation.issueNumber, baseSha: realActivation.baseSha, contractHash: realActivation.contractHash, headCommit: realRuns[REAL_ACCEPT].after.headCommit }
  c.sessionSnapshot = { path: SESSION_FILE, ...sessionShape, structuredToolResultValues: structuredResults, jobEvents }
  c.pr = { number: pr.number, state: pr.state, baseRef: pr.baseRef, headSha: pr.headSha, url: pr.url }
}
writeFileSync(join(OUT_ROOT, 'attacks.jsonl'), cases.map((c) => JSON.stringify(c)).join('\n') + '\n')

// ---- 清理临时世界 ----
for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })

const failed = cases.filter((c) => c.expectationMet === false)
console.log(`\nCASES ${cases.length} expectationFailed=${failed.length}`)
console.log('OUT_ROOT ' + OUT_ROOT)
console.log('real decisions sha256 unchanged:', realDecisionsShaBefore)
process.exit(failed.length === 0 ? 0 : 1)
