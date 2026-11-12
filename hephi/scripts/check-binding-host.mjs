#!/usr/bin/env node
// ROADMAP-95 A2：完整证据链宿主探针（只读、脱敏）。
//
// 目标：核实 A1 绑定的五个环节在真实宿主编码下是否成立：
//   H1 hephi_check 内部 bash 调用是否出现在当前 Worker Session 快照；tool/call 字段名、
//      arguments 形态（原始 JSON 字符串）、workdir 字段；
//   H2 前台 bash 结果的 kind / exitCode 位置；promoted 结果是否带 jobId 且无最终退出码
//      （全量统计快照中全部 bash tool/result；samples 仅人读、不参与判定）；
//   H3 ready 时 jobs.get(jobId, sessionId) 能否取到已完成 Job 终态与 detail；错误 session
//      调用的行为（抛错/undefined）；readAt 的 lossy 语义；
//   H4 check 记录写入的 sessionId（outer.agent.id）与 ready 时 session.header.id 是否相等；
//   H5 Session 前台 stdout/stderr 是否完整（truncated 标记）；完成后 Job 输出是否可读、
//      lossy 何时为真；
//   H6 Worker 能否通过工具影响自己的 Session 快照（提供操作步骤与判定标准）。
//
// 用法（详见 --help）：
//   node hephi/scripts/check-binding-host.mjs --help
//   node hephi/scripts/check-binding-host.mjs                       # 无上下文 → 全 unavailable/manual，exit 2
//   node hephi/scripts/check-binding-host.mjs --session <session.v4.jsonl.zstd> \
//        --check-record <state/hephi/<ticket>/checks/<runId>/run.json> [--host http://127.0.0.1:3083]
//   node hephi/scripts/check-binding-host.mjs --self-test
//
// 退出码：全部 pass=0；有 fail=1；只有 unavailable/manual=2。
// 本脚本只读文件、只做一次 GET /orchestrator/api/state；不修改宿主、不写仓库、不新增依赖。
// 说明：这不是端到端验收。夹具/快照结论 ≠ 真实宿主 A1-BIND 端到端通过。
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const USAGE = `ROADMAP-95 A2 证据链宿主探针（只读、脱敏）

用法：
  node hephi/scripts/check-binding-host.mjs --help
  node hephi/scripts/check-binding-host.mjs [选项]

选项：
  --session <file>         Worker Session 持久化文件（session.vN.jsonl.zstd 或 .jsonl/.json）
                           可在宿主 state dir 下查找：find <dsh-home>/sessions -name 'session.v*.jsonl.zstd'
  --check-record <file>    hephi 检查记录 run.json（state/hephi/<ticket>/checks/<runId>/run.json）
  --host <url>             只读 GET /orchestrator/api/state（默认不访问网络；缺省跳过）
  --manual <spec>          操作者对无法自动探测环节的人工结论，如 H3=pass,H5=pass,H6=fail
                           只接受 H3/H4/H5/H6，值 pass|fail|manual；结果写入报告并参与退出码。
                           人工结论必须附证据（宿主内命令 + 输出），不得无证据回填。
  --job-evidence <file>    一次性真实 DSH profile 内由独立宿主运行时探针调用 ctx.jobs.get/readAt 生成的 JSON。
                          必需 provenance：generatedBy/host/profile/sessionId/jobId/own/foreign；
                           只用于 H3/H5 的运行时证据；不是 A1-BIND 端到端证明。
  --out <file>             额外写出脱敏 JSON 报告（默认只打印）
  --json                   只输出 JSON（人类摘要仍写 stderr）
  --no-redact              不脱敏（仅限操作者本机私有排查；报告不得分享）
  --self-test              用合成数据自测解析/判定逻辑（不访问真实宿主）
  --help                   显示本帮助

无宿主上下文（无 --session/--check-record/--host）时：
  H1–H6 全部输出 unavailable/manual，退出码 2，并打印操作者在宿主上需要执行的命令。

在宿主上的推荐流程：
  1) 找最近一次 Worker Session 快照（见上）与其 check 记录；
  2) 运行本脚本：node hephi/scripts/check-binding-host.mjs --session <f> --check-record <r> --out /tmp/h1h2h4.json
     H1 会同时识别两种宿主编码：path A（内部 bash tool/call + tool/result）与
     path B（内部 job/registered + job/settled，真实宿主历史快照的形态；path A 优先）；
  3) 按输出中的 manual 步骤在宿主内完成 H3/H5/H6；若已用独立的宿主运行时探针
     （一次性 DSH profile 内 ctx.jobs.get/readAt）生成 JSON，用 --job-evidence <file>
     把 H3/H5 的运行时证据只读传入；其余结论用 --manual 回填后复跑；
  4) 把脱敏 JSON、命令与 H1–H6 结论填入 hephi/docs/validation/2026-11-07-evidence-chain-host.md。

限制：本脚本读取的是宿主持久化快照（JSONL+zstd），不是实时 ctx 服务；path B 快照不持久化
Job stdout，不能从快照重建输出；Job 注册表（jobs.get/readAt/lossy）与 Worker 自影响（H6）必须
在宿主内人工探测。--job-evidence 只是可销毁 profile 的运行时证据，不是 A1-BIND 端到端证明。
`

const MANUAL_STEPS = {
  H3: [
    '在宿主内（有 ctx.jobs 的进程/测试插件中）对一个已完成的 check Job 执行：',
    "  view = ctx.jobs.get(record.jobId, record.sessionId)  // 期望 JobView{status:'completed', detail:'exit code: <n>'}",
    '  wrong = () => ctx.jobs.get(record.jobId, <另一个 session id>)  // 记录实际行为：抛错还是 undefined',
    "  read = ctx.jobs.readAt(record.jobId, 0, record.sessionId)  // 记录 chunks/lossy；构造超过 ring 保留窗口的输出触发 lossy=true",
    '把上述结果写成 JSON，作为 --job-evidence <file> 传入本脚本（只读）：',
    '  { generatedBy, host, profile, sessionId, jobId, own: { status, detail, readAt: { text, lossy, truncated?, chunks? } }, foreign: { threw: true, error } 或 { undefined: true } }',
    '注意：只有 own 终态+detail+readAt.text 齐全且 foreign 调用被拒绝（threw 或 undefined）时，H3 才判 pass；字段缺失保持 manual，foreign 被接受则 fail。',
    '判定：能在本 Session 取到终态与 detail、错误 Session 被拒绝（抛错或 undefined 且调用方按失败处理）、lossy 语义明确 → pass；否则 fail。',
    '注意：dsh-jobs 的类型契约写的是“unknown/foreign job 抛错”，但本脚本不能替宿主实测。',
  ],
  H4: [
    '采集（只读）：取 run.json 的 sessionId 与 Session 快照头的 id；',
    "  node -e \"const r=require('<run.json>'); console.log('record sessionId', r.sessionId)\"",
    "  node -e \"const z=require('node:zlib'),fs=require('node:fs'); const b=fs.readFileSync('<session.vN.jsonl.zstd>');/* 按 magic 切帧后取第一条 session 事件 */ console.log(b.subarray(0,4).toString('hex'))\"",
    '更简单：直接用本脚本 --session <快照> --check-record <run.json>，H4 会自动比较 record.sessionId 与 session.header.id；',
    '判定：两者相等 → pass；不等 → fail（A1 计划要求改为写 session.header.id 并升记录格式版本）。',
  ],
  H5: [
    '前台：在 Worker 里跑一条输出超过 stream cap 的 bash，检查 tool/result 是否出现 “[output truncated” 与 spill 路径；',
    '后台：让 check 提升为 Job（长命令），用 ctx.jobs.readAt(jobId, 0, sessionId) 读取：记录 lossy 是否为 true、chunks 是否完整、spillPaths 是否存在；',
    '把 readAt 结果写入 --job-evidence 的 own.readAt（text/lossy/truncated/chunks）；本脚本用该字段判定 H5 的 Job 输出部分。',
    '判定：前台截断有明确标记且 spill 可读、Job 输出可完整读取且 lossy 语义与文档一致 → pass；否则 fail。',
  ],
  H6: [
    '只能在一次性/可销毁的宿主实例上做，禁止在生产实例操作。',
    '步骤：在一个真实 Worker run 中，用 bash/write 工具尝试影响自己的 Session 快照或检查记录：',
    '  a) 读取并尝试追加/改写 <dsh-home>/sessions/**/session.v*.jsonl.zstd；',
    '  b) 尝试改写 state/hephi/<ticket>/checks/<runId>/run.json；',
    '  c) 尝试通过工具调用伪造与 check 同 callId 的事件。',
    '判定：Worker 无法让快照/记录出现未发生的可信事件 → pass；任一成功（或 ready 采信被篡改内容）→ fail，',
    '此时按计划审查 P1-7：A1-BIND 停止，保底只保留 A1-OUT + 文件指纹 + A4 威胁模型，并把 D1 的上限降为 L1/L2。',
  ],
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = process.argv[i + 1]
  return next === undefined || next.startsWith('--') ? fallback : next
}

function maskId(value) {
  const text = String(value ?? '')
  if (text.length <= 14) return text
  return `${text.slice(0, 6)}…${text.slice(-4)}`
}

function redactor(enabled) {
  if (!enabled) return (value) => String(value ?? '')
  const home = homedir()
  return (value) => String(value ?? '')
    .replaceAll(home, '$HOME')
    .replace(/\/Users\/[^/\s]+/g, '$HOME')
    .replace(/\b(worker|orchestrator|session)-[0-9a-f]{8,}\b/gi, (match) => maskId(match))
    .replace(/\b(call|bash|job)_[A-Za-z0-9_-]{8,}\b/g, (match) => maskId(match))
    .replace(/(authorization|token|secret|password|api[_-]?key)(\s*[:=]\s*)\S+/gi, '$1$2***')
}

function ring(id, status, evidence, notes) {
  return { id, status, evidence: evidence ?? null, notes: notes ?? null }
}

function quote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

function expectedCheckCommand(record) {
  if (!record || !Array.isArray(record.argv) || record.argv.length === 0) return null
  const base = record.before?.baseCommit
  if (typeof base !== 'string' || base.length === 0) return null
  return `HEPHI_BASE_COMMIT=${quote(base)} ` + record.argv.map(quote).join(' ')
}

function exitCodeFromDetail(detail) {
  if (typeof detail !== 'string') return null
  const match = /^exit code: (-?\d+)(?:;|$)/.exec(detail)
  return match ? Number(match[1]) : null
}

// dsh-jobs JobStatus：running/stopping 是非终态，其余（completed/killed/failed）为终态。
const TERMINAL_JOB_STATUSES = new Set(['completed', 'killed', 'failed'])

// --job-evidence：一次性宿主 profile 内 ctx.jobs.get/readAt 生成的运行时证据。
// 这里只做形状/provenance 校验；绝不把文件自述当 Session 事件。
function validateJobEvidence(value) {
  const problems = []
  const foreignProblems = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, problems: ['--job-evidence 不是 JSON 对象'], foreignProblems, foreignRejected: false }
  }
  for (const field of ['generatedBy', 'host', 'profile', 'sessionId', 'jobId']) {
    if (typeof value[field] !== 'string' || value[field].length === 0) problems.push(`缺少非空字符串字段 ${field}`)
  }
  const own = value.own
  if (!own || typeof own !== 'object' || Array.isArray(own)) problems.push('缺少 own 对象')
  else {
    if (typeof own.status !== 'string' || own.status.length === 0) problems.push('own.status 缺失或非字符串')
    if (typeof own.detail !== 'string') problems.push('own.detail 缺失或非字符串')
    if (!own.readAt || typeof own.readAt !== 'object' || Array.isArray(own.readAt)) problems.push('own.readAt 缺失')
    else {
      if (typeof own.readAt.text !== 'string') problems.push('own.readAt.text 缺失或非字符串')
      if (typeof own.readAt.lossy !== 'boolean') problems.push('own.readAt.lossy 缺失或非布尔')
      if (own.readAt.truncated !== undefined && typeof own.readAt.truncated !== 'boolean') problems.push('own.readAt.truncated 非布尔')
      if (own.readAt.chunks !== undefined && !Array.isArray(own.readAt.chunks)) problems.push('own.readAt.chunks 非数组')
    }
  }
  const foreign = value.foreign
  let foreignRejected = false
  if (!foreign || typeof foreign !== 'object' || Array.isArray(foreign)) problems.push('缺少 foreign 对象')
  else {
    const threw = foreign.threw === true && typeof foreign.error === 'string'
    const undef = foreign.undefined === true
    foreignRejected = threw || undef
    if (!threw && !undef) foreignProblems.push('foreign 调用未被拒绝：需要 {threw:true,error} 或 {undefined:true}')
  }
  return { ok: problems.length === 0, problems, foreignProblems, foreignRejected }
}

function evaluateJobEvidence(jobEvidence, options = {}) {
  const { record = null, headerId = null, recordSessionId = null, redact = (value) => String(value ?? ''), loadError = null, file = null } = options
  const evidence = {
    file: file ? redact(file) : null,
    generatedBy: null,
    host: null,
    profile: null,
    sessionId: null,
    jobId: null,
    own: null,
    foreign: null,
    provenance: {
      sessionMatchesRecord: null,
      sessionMatchesHeader: null,
      jobMatchesRecord: null,
    },
  }
  if (loadError) {
    return { status: 'manual', evidence, notes: `--job-evidence 读取失败：${loadError}（H3 保持 manual；未采信任何自述结论）`, readAt: null }
  }
  if (!jobEvidence) {
    return { status: 'manual', evidence, notes: '未提供 --job-evidence：H3 的 jobs.get/readAt 与 foreign 行为需在宿主内实测（见 manualSteps.H3）。', readAt: null }
  }
  const validation = validateJobEvidence(jobEvidence)
  evidence.generatedBy = typeof jobEvidence.generatedBy === 'string' ? jobEvidence.generatedBy : null
  evidence.host = typeof jobEvidence.host === 'string' ? redact(jobEvidence.host) : null
  evidence.profile = typeof jobEvidence.profile === 'string' ? redact(jobEvidence.profile) : null
  evidence.sessionId = typeof jobEvidence.sessionId === 'string' ? maskId(jobEvidence.sessionId) : null
  evidence.jobId = typeof jobEvidence.jobId === 'string' ? maskId(jobEvidence.jobId) : null
  const own = jobEvidence.own && typeof jobEvidence.own === 'object' ? jobEvidence.own : null
  const foreign = jobEvidence.foreign && typeof jobEvidence.foreign === 'object' ? jobEvidence.foreign : null
  evidence.own = own ? {
    status: own.status ?? null,
    detailExitCode: exitCodeFromDetail(own.detail),
    detail: typeof own.detail === 'string' ? redact(own.detail).slice(0, 120) : null,
    readAt: own.readAt && typeof own.readAt === 'object' ? {
      textChars: typeof own.readAt.text === 'string' ? own.readAt.text.length : null,
      lossy: own.readAt.lossy ?? null,
      truncated: own.readAt.truncated ?? null,
      chunks: Array.isArray(own.readAt.chunks) ? own.readAt.chunks.length : null,
    } : null,
  } : null
  evidence.foreign = foreign ? {
    threw: foreign.threw === true,
    undefined: foreign.undefined === true,
    error: typeof foreign.error === 'string' ? redact(foreign.error).slice(0, 120) : null,
  } : null
  evidence.provenance.sessionMatchesRecord = recordSessionId
    ? (typeof jobEvidence.sessionId === 'string' && jobEvidence.sessionId === recordSessionId) : null
  evidence.provenance.sessionMatchesHeader = headerId
    ? (typeof jobEvidence.sessionId === 'string' && jobEvidence.sessionId === headerId) : null
  evidence.provenance.jobMatchesRecord = record && typeof record.jobId === 'string' && record.jobId.length > 0
    ? (typeof jobEvidence.jobId === 'string' && jobEvidence.jobId === record.jobId) : null
  const readAt = own && own.readAt && typeof own.readAt === 'object' ? own.readAt : null

  if (!validation.ok) {
    return {
      status: 'manual',
      evidence,
      notes: `--job-evidence 字段不全，H3 保持 manual：${validation.problems.join('；')}`,
      readAt,
    }
  }
  if (evidence.provenance.sessionMatchesRecord === false || evidence.provenance.sessionMatchesHeader === false) {
    return { status: 'fail', evidence, notes: '--job-evidence 的 sessionId 与当前 Session / 记录不一致：不接受为 H3 证据。', readAt }
  }
  if (evidence.provenance.jobMatchesRecord === false) {
    return { status: 'fail', evidence, notes: '--job-evidence 的 jobId 与记录 jobId 不一致：不接受为 H3 证据。', readAt }
  }
  if (!validation.foreignRejected) {
    return { status: 'fail', evidence, notes: `错误 Session 的 jobs.get 未被拒绝：${validation.foreignProblems.join('；')}（H3 fail）。`, readAt }
  }
  const status = own.status
  if (!TERMINAL_JOB_STATUSES.has(status)) {
    return { status: 'fail', evidence, notes: `own.status=${String(status)} 不是终态（需要 completed/killed/failed）；H3 fail。`, readAt }
  }
  const detailExitCode = exitCodeFromDetail(own.detail)
  if (detailExitCode === null) {
    return { status: 'fail', evidence, notes: 'own.detail 不是 “exit code: <n>” 形式；H3 fail。', readAt }
  }
  if (typeof record?.exitCode === 'number' && detailExitCode !== record.exitCode) {
    return { status: 'fail', evidence, notes: `own.detail exit code ${detailExitCode} 与记录 exitCode ${record.exitCode} 不一致；H3 fail。`, readAt }
  }
  return {
    status: 'pass',
    evidence,
    notes: `宿主运行时证据：own 终态 ${status}+detail+readAt.text 可读，foreign 调用被拒绝（${validation.foreignRejected ? 'threw/undefined' : '未记录'}）。这是可销毁 profile 的运行时证据，不是 A1-BIND 端到端证明。`,
    readAt,
  }
}

// ---- Session 快照解析 -------------------------------------------------------

function decompressZstdFrames(buffer) {
  // zstdDecompressSync 只解第一帧；JSONL 快照是每行/每事件一帧，需按 magic 切分。
  const zstd = requireZstd()
  const positions = []
  let cursor = 0
  while ((cursor = buffer.indexOf(ZSTD_MAGIC, cursor)) !== -1) {
    positions.push(cursor)
    cursor += ZSTD_MAGIC.length
  }
  const texts = []
  for (let i = 0; i < positions.length; i += 1) {
    const start = positions[i]
    const end = i + 1 < positions.length ? positions[i + 1] : buffer.length
    texts.push(zstd.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
  }
  // 每帧是一条 JSONL 记录；用换行拼接，避免无结尾换行的帧把两条记录粘在一起。
  return texts.join('\n')
}

function requireZstd() {
  // Node >= 22.15 才有 zstd；旧 Node 给出清晰错误而不是崩栈。
  const zlib = process.getBuiltinModule('node:zlib')
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('当前 Node 不支持 zstd（需要 Node >= 22.15）；请用宿主同版本 Node 运行')
  }
  return zlib
}

function parseEventsText(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const events = []
  const problems = []
  let wrapper = null
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.events)) {
        wrapper = parsed
        events.push(...parsed.events)
      } else if (Array.isArray(parsed)) {
        events.push(...parsed)
      } else {
        events.push(parsed)
      }
    } catch (error) {
      problems.push(`无法解析一行事件：${error.message}`)
    }
  }
  return { events, problems, wrapper }
}

function readSessionSnapshot(file) {
  const buffer = readFileSync(file)
  let format = 'jsonl'
  let text
  if (buffer.subarray(0, 4).equals(ZSTD_MAGIC)) {
    format = 'jsonl.zstd'
    text = decompressZstdFrames(buffer)
  } else {
    text = buffer.toString('utf8')
  }
  const { events, problems, wrapper } = parseEventsText(text)
  const headerEvent = events.find((event) => event && event.type === 'session')
  const header = headerEvent?.data ?? headerEvent ?? wrapper?.session ?? null
  const inheritedEventCount = typeof wrapper?.inheritedEventCount === 'number' ? wrapper.inheritedEventCount : 0
  const headerId = header?.id ?? header?.session?.id ?? null
  return { format, events, header, headerId, inheritedEventCount, problems, bytes: buffer.length }
}

// ---- 各环节分析 -------------------------------------------------------------

function analyzeSession(session) {
  const events = session.events.filter((event) => event && typeof event === 'object')
  const calls = events.filter((event) => event.type === 'tool/call' && event.data)
  const results = events.filter((event) => event.type === 'tool/result' && event.data?.message)
  const jobs = events.filter((event) => event.type === 'job/registered' && event.data)
  const settled = events.filter((event) => event.type === 'job/settled' && event.data)
  const callById = new Map(calls.map((event) => [event.data.callId, event.data]))
  const resultByCallId = new Map(results.map((event) => [event.data.message.toolCallId, event.data.message]))
  const settledByJobId = new Map(settled.map((event) => [event.data.jobId, event.data]))
  const internalJobs = jobs.filter((event) => {
    const toolCall = event.data.toolCall
    return toolCall && typeof toolCall.callId === 'string' && typeof toolCall.rootCallId === 'string' && toolCall.callId !== toolCall.rootCallId
  })
  const bashCalls = calls.filter((event) => event.data.name === 'bash')
  const bashResults = results.filter((event) => callById.get(event.data.message.toolCallId)?.name === 'bash')
  const headerEvent = events.find((event) => event.type === 'session')
  const headerId = headerEvent?.data?.id ?? session.headerId ?? null
  return {
    headerId,
    events, calls, results, jobs, settled, callById, resultByCallId, settledByJobId,
    internalJobs, bashCalls, bashResults,
  }
}

function parseArguments(value) {
  if (value && typeof value === 'object') return { parsed: value, rawType: 'object' }
  if (typeof value !== 'string') return { parsed: null, rawType: typeof value }
  try {
    return { parsed: JSON.parse(value), rawType: 'string' }
  } catch {
    return { parsed: null, rawType: 'string', parseError: true }
  }
}

// path B：真实宿主历史快照的编码——内部 bash dispatch 不产生 tool/call + tool/result，
// 只留下 job/registered（toolCall.callId=innerCallId, rootCallId=record.callId）与
// job/settled（status/detail=exit code）。只采信 Session 事件 + record 标识符；label 必须
// 与 record.argv+before.baseCommit 重建的命令逐字符相等（截断按 fail 处理）。
function pathBEvidence(sessionAnalysis, record, expected) {
  const headerId = sessionAnalysis.headerId ?? null
  const innerCallId = typeof record.innerCallId === 'string' && record.innerCallId.length > 0 ? record.innerCallId : null
  const rootCallId = typeof record.callId === 'string' && record.callId.length > 0 ? record.callId : null
  const registeredForInner = innerCallId
    ? sessionAnalysis.jobs.filter((event) => event.data?.toolCall?.callId === innerCallId)
    : []
  const settledForInner = innerCallId
    ? sessionAnalysis.settled.filter((event) => event.data?.toolCall?.callId === innerCallId)
    : []
  const hasJobEvidence = registeredForInner.length > 0 || settledForInner.length > 0
  const rootCall = rootCallId ? sessionAnalysis.callById.get(rootCallId) : undefined
  const rootCallFound = Boolean(rootCall && rootCall.name === 'hephi_check')
  const linked = registeredForInner.filter((event) => event.data?.toolCall?.rootCallId === rootCallId)
  const registered = (typeof record.jobId === 'string' && record.jobId.length > 0
    ? linked.find((event) => event.data.jobId === record.jobId)
    : linked[0]) ?? null
  const registeredJobId = registered?.data?.jobId
    ?? linked[0]?.data?.jobId
    ?? registeredForInner[0]?.data?.jobId
    ?? null
  const jobId = (typeof record.jobId === 'string' && record.jobId.length > 0)
    ? record.jobId
    : (registeredJobId ?? settledForInner[0]?.data?.jobId ?? null)
  const settled = jobId ? (sessionAnalysis.settledByJobId.get(jobId) ?? null) : null
  const owners = [registered?.data?.owner, settled?.owner]
    .filter((owner) => typeof owner === 'string' && owner.length > 0)
  const ownerMatchesSession = Boolean(headerId) && owners.length > 0 && owners.every((owner) => owner === headerId)
  const label = registered?.data?.label ?? settled?.label ?? null
  const labelMatchesCommand = Boolean(expected) && typeof label === 'string' && label === expected
  const labelTruncated = Boolean(expected) && typeof label === 'string' && !labelMatchesCommand
    && label.length > 0 && label.length < expected.length && expected.startsWith(label)
  const status = settled?.status ?? null
  const exitCode = settled ? exitCodeFromDetail(settled.detail) : null
  const exitCodeMatches = exitCode !== null && (typeof record.exitCode !== 'number' || exitCode === record.exitCode)
  const sessionMatchesRecord = Boolean(headerId) && Boolean(record.sessionId) && headerId === record.sessionId

  const missing = []
  if (!sessionMatchesRecord) {
    missing.push(headerId
      ? `Session 头 id（${maskId(headerId)}）与 record.sessionId（${maskId(record.sessionId)}）不一致`
      : 'Session 快照缺少 header id')
  }
  if (!rootCallFound) missing.push('未找到 callId=record.callId 且 name=hephi_check 的根 tool/call')
  if (innerCallId === null) missing.push('record 缺少 innerCallId')
  else if (registeredForInner.length === 0) missing.push('未找到 toolCall.callId=record.innerCallId 的 job/registered')
  else if (linked.length === 0) missing.push('job/registered 的 toolCall.rootCallId 未指向 record.callId')
  else if (!registered) missing.push('job/registered 的 jobId 与 record.jobId 不一致')
  if (!settled) missing.push(jobId ? '未找到 jobId 匹配的 job/settled' : '未找到 job/settled')
  if (!ownerMatchesSession) {
    missing.push(owners.length === 0
      ? 'job 事件缺少 owner'
      : 'job 事件 owner 不等于 Session 头 id（不是本 Session 的 Job）')
  }
  if (!labelMatchesCommand) {
    missing.push(labelTruncated
      ? 'job label 是期望命令的截断前缀（真实宿主写完整命令；截断不作为 pass）'
      : (expected ? 'job label 与期望命令不逐字符相等' : 'record 缺 argv/before.baseCommit，无法重建期望命令'))
  }
  if (!status || !TERMINAL_JOB_STATUSES.has(status)) missing.push(`job/settled status=${String(status)} 不是终态`)
  if (exitCode === null) missing.push('job/settled detail 不是 “exit code: <n>” 形式')
  else if (!exitCodeMatches) missing.push(`job/settled exit code ${exitCode} 与记录 exitCode ${record.exitCode} 不一致`)

  const ok = missing.length === 0
  return {
    ok,
    fields: {
      encoding: hasJobEvidence ? 'path-B' : null,
      jobId: jobId ? maskId(jobId) : null,
      ownerMatchesSession,
      rootCallFound,
      innerCallFound: false,
      jobRegisteredFound: Boolean(registered),
      jobSettledFound: Boolean(settled),
      labelMatchesCommand,
      exitCode,
      status,
      notes: ok
        ? 'path B 证据完整：根 tool/call、job/registered(inner→root)、job/settled 终态、owner、命令与 exit code 全部匹配。'
        : `path A 缺失；path B 证据不足：${missing.join('；')}。`,
      missing,
    },
  }
}

function h1Ring(sessionAnalysis, record, redact) {
  if (!sessionAnalysis) {
    return ring('H1', 'unavailable', null, '没有 Session 快照：需要一次真实 Worker 运行；见 --help 与 manualSteps。')
  }
  const evidence = {
    encoding: null,
    jobId: null,
    ownerMatchesSession: null,
    rootCallFound: null,
    innerCallFound: null,
    jobRegisteredFound: null,
    jobSettledFound: null,
    labelMatchesCommand: null,
    exitCode: null,
    status: null,
    notes: null,
    toolCallCount: sessionAnalysis.calls.length,
    toolResultCount: sessionAnalysis.results.length,
    internalJobCount: sessionAnalysis.internalJobs.length,
    internalJobSamples: sessionAnalysis.internalJobs.slice(0, 3).map((event) => ({
      jobId: maskId(event.data.jobId),
      callId: maskId(event.data.toolCall?.callId),
      rootCallId: maskId(event.data.toolCall?.rootCallId),
      rootTool: redact(sessionAnalysis.callById.get(event.data.toolCall?.rootCallId)?.name ?? '(root tool/call 不在本 Session 快照中)'),
      label: redact(event.data.label).slice(0, 200),
    })),
    argumentsType: sessionAnalysis.bashCalls.length > 0
      ? [...new Set(sessionAnalysis.bashCalls.map((event) => (typeof event.data.arguments === 'string' ? 'string' : typeof event.data.arguments)))]
      : [],
    workdirFieldPresent: sessionAnalysis.bashCalls.filter((event) => parseArguments(event.data.arguments).parsed
      && Object.prototype.hasOwnProperty.call(parseArguments(event.data.arguments).parsed, 'workdir')).length,
  }
  if (record) {
    const expected = expectedCheckCommand(record)
    const inner = record.innerCallId
    const call = inner ? sessionAnalysis.callById.get(inner) : undefined
    const result = inner ? sessionAnalysis.resultByCallId.get(inner) : undefined
    const args = call ? parseArguments(call.arguments) : { parsed: null }
    evidence.record = {
      version: record.version ?? null,
      sessionId: redact(record.sessionId ?? ''),
      callId: maskId(record.callId),
      innerCallId: maskId(inner),
      expectedCommand: redact(expected ?? '(record 缺 argv/before.baseCommit，无法重建期望命令)').slice(0, 300),
      jobId: record.jobId ? maskId(record.jobId) : null,
    }
    evidence.inner = {
      toolCallFound: Boolean(call),
      toolCallName: call?.name ?? null,
      toolResultFound: Boolean(result),
      argumentsRawType: call ? (typeof call.arguments === 'string' ? 'string' : typeof call.arguments) : null,
      parsedKeys: args.parsed ? Object.keys(args.parsed) : [],
      commandMatches: Boolean(args.parsed && expected && args.parsed.command === expected),
      workdir: args.parsed && Object.prototype.hasOwnProperty.call(args.parsed, 'workdir') ? redact(args.parsed.workdir) : '(缺少 workdir 字段)',
      workdirMatchesRecordCwd: Boolean(args.parsed && record.cwd && args.parsed.workdir === record.cwd),
    }
    evidence.innerCallFound = Boolean(call)
    if (call) {
      // F4: align the probe with the runtime verifier. evidence-verifier treats the two
      // shapes (path A tool/call+tool/result value, path B job/registered+job/settled) as
      // mutually exclusive and REFUSES the ambiguous dual-shape snapshot. The probe must not
      // report a path-A pass when path-B evidence for the same inner call is also present.
      const pathBForInner = [
        ...sessionAnalysis.jobs.filter((event) => event.data?.toolCall?.callId === inner),
        ...sessionAnalysis.settled.filter((event) => event.data?.toolCall?.callId === inner),
      ]
      if (pathBForInner.length > 0) {
        evidence.encoding = 'ambiguous'
        evidence.ambiguous = true
        evidence.pathBJobEventCount = pathBForInner.length
        evidence.notes = '双形状共存：同一 innerCallId 同时存在内部 tool/call 与 job/registered|job/settled 事件；运行时 evidence-verifier 对双形状按 ambiguous 拒绝，A2 探针不得据此报 H1 pass。请人工核对宿主编码或只保留一种形状后复跑。'
        return ring('H1', 'fail', evidence, evidence.notes)
      }
      evidence.encoding = 'path-A'
      const ok = evidence.inner.toolCallFound && evidence.inner.toolCallName === 'bash'
        && evidence.inner.commandMatches && evidence.inner.workdirMatchesRecordCwd
      evidence.notes = ok
        ? 'path A：Session 快照中存在与记录匹配的内部 bash tool/call（命令与 workdir 逐字符一致）。'
        : 'path A：内部 bash tool/call 存在但字段不匹配；需要 name=bash、arguments.command 与 workdir 精确匹配。'
      return ring('H1', ok ? 'pass' : 'fail', evidence, evidence.notes)
    }
    const pathB = pathBEvidence(sessionAnalysis, record, expected)
    Object.assign(evidence, pathB.fields)
    return ring('H1', pathB.ok ? 'pass' : 'fail', evidence, pathB.ok
      ? 'path B：内部 dispatch 没有 tool/call/tool/result，但 job/registered + job/settled 完整绑定根调用、本 Session、完整命令与 exit code；按真实宿主编码判 pass（快照不含 Job stdout，不能重建输出）。'
      : pathB.fields.notes)
  }
  // 没有记录时，只能用内部 dispatcher 的 Job 事件推断编码；不能判定绑定是否成立。
  if (sessionAnalysis.internalJobs.length === 0) {
    return ring('H1', 'unavailable', evidence, '快照中没有 hephi_check 内部 dispatch 的 Job 事件；无法判断内部 bash 调用编码。请提供 --check-record。')
  }
  const missingCalls = sessionAnalysis.internalJobs.filter((event) => !sessionAnalysis.callById.has(event.data.toolCall.callId))
  return ring('H1', missingCalls.length === 0 ? 'pass' : 'fail', {
    ...evidence,
    internalJobsWithoutToolCall: missingCalls.length,
  }, missingCalls.length === 0
    ? '所有内部 dispatch 都能在 Session 快照中找到 tool/call。'
    : '存在内部 Job 事件，但其 callId 在 Session 快照中没有对应 tool/call 事件（嵌套 dispatch 不产生 Session 事件）。')
}

function textOfMessage(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('\n')
}

/**
 * H2（A1-BIND path A）判据：持久化 tool/result 的 message.value 必须带结构化结果，且字段符合判据——
 *   - kind ∈ {foreground, background, promoted}；
 *   - foreground 带整数 exitCode；
 *   - promoted/background 带非空 jobId 且无最终 exitCode。
 * 统计必须覆盖快照中的**全部** bash tool/result：早期实现只取前 5 条作样本、再用样本数与总数比较，
 * 导致 >5 条 bash result 的真实快照即使全部结构化也恒判 fail（R1 验收硬前置缺陷，task-38 修复）。
 * `samples` 仅保留前 5 条供人读，**不参与判定**。
 */
function hasOwnField(value, key) {
  return value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key)
}

function h2Sample(event) {
  const message = event.data.message
  const text = textOfMessage(message)
  const value = message.value
  return {
    callId: maskId(message.toolCallId),
    isError: message.isError ?? null,
    hasStructuredValue: Boolean(value && typeof value === 'object' && typeof value.kind === 'string'),
    // Keep the raw values: the verdict must distinguish "field absent" from an explicit
    // JSON null. `?? null` here would collapse both and let an explicit
    // `{"kind":"promoted","jobId":"j","exitCode":null}` pass H2 (GPT-B3).
    kind: value?.kind,
    exitCodeField: value?.exitCode,
    exitCodePresent: hasOwnField(value, 'exitCode'),
    jobIdField: value?.jobId,
    jobIdPresent: hasOwnField(value, 'jobId'),
    textExitCodeMarker: /\[exit code: -?\d+\]/.exec(text)?.[0] ?? null,
    promotedMarker: /\[still running after \d+ms; moved to background job [^\]]+\]/.exec(text)?.[0] ?? null,
    truncatedMarker: text.includes('[output truncated') ? '[output truncated' : null,
    contentChars: text.length,
  }
}

/** 单条结果的判据违反原因；null = 该条符合判据（仅对已带结构化 value 的结果返回 null 以外之外的值）。 */
function h2CriterionProblem(sample) {
  if (!sample.hasStructuredValue) return 'missing-structured-value'
  if (sample.kind === 'foreground') {
    // Foreground must carry an integer exit code; an explicit null is not an integer.
    return Number.isInteger(sample.exitCodeField) ? null : 'foreground-without-integer-exit-code'
  }
  if (sample.kind === 'promoted' || sample.kind === 'background') {
    if (!sample.jobIdPresent || typeof sample.jobIdField !== 'string' || sample.jobIdField.length === 0) {
      return `${sample.kind}-without-jobId`
    }
    // The frozen contract says a promoted/background result OMITS the final exit code.
    // Any present field (including an explicit JSON null) violates it; only field absence passes.
    if (sample.exitCodePresent) return `${sample.kind}-with-final-exit-code`
    return null
  }
  return 'unknown-kind'
}

function h2Ring(sessionAnalysis, redact) {
  if (!sessionAnalysis) return ring('H2', 'unavailable', null, '没有 Session 快照；无法核对前台结果编码。')
  const all = sessionAnalysis.bashResults
  if (all.length === 0) {
    return ring('H2', 'unavailable', { bashCallCount: sessionAnalysis.bashCalls.length }, '快照中没有 bash tool/result；无法核对。')
  }
  const analyzed = all.map((event) => h2Sample(event))
  const structured = analyzed.filter((sample) => sample.hasStructuredValue)
  const problems = new Map()
  for (const sample of analyzed) {
    const problem = h2CriterionProblem(sample)
    if (problem !== null) problems.set(problem, (problems.get(problem) ?? 0) + 1)
  }
  const kinds = [...new Set(analyzed.map((sample) => sample.kind).filter((kind) => typeof kind === 'string'))]
  const coveredBranches = ['foreground', 'background', 'promoted'].filter((kind) => kinds.includes(kind))
  const uncoveredKinds = ['background', 'promoted'].filter((kind) => !kinds.includes(kind))
  const evidence = {
    // 全量统计（判定依据）：bashResults 的每一条 tool/result 都参与，不是采样窗口。
    bashResultCount: all.length,
    structuredValueCount: structured.length,
    kinds,
    coveredBranches,
    uncoveredKinds,
    problemCounts: Object.fromEntries([...problems.entries()].sort(([a], [b]) => a.localeCompare(b))),
    // 人读样本（前 5 条，不参与判定）。
    samples: analyzed.slice(0, 5),
  }
  const coverageNote = uncoveredKinds.length > 0
    ? ` 未覆盖分支：${uncoveredKinds.join('/')}（本快照无该 kind 的结构化结果；不得据此声称这些分支通过）。`
    : ''
  const missing = problems.get('missing-structured-value') ?? 0
  if (structured.length === 0) {
    return ring('H2', 'fail', evidence, `持久化 tool/result 的 message 不含结构化 value（全部 ${all.length} 条均无 kind/exitCode）；A1 期望的 message.value 在本快照编码下不存在。退出码只以文本标记 [exit code: N] 出现。${coverageNote}`)
  }
  if (problems.size > 0) {
    const summary = [...problems.entries()].map(([reason, count]) => `${reason}=${count}`).join(', ')
    if (missing > 0) {
      return ring('H2', 'fail', evidence, `只有 ${structured.length}/${all.length} 条 bash tool/result 带结构化 value（缺失 ${missing} 条）；编码不统一。字段问题：${summary}。${coverageNote}`)
    }
    return ring('H2', 'fail', evidence, `全部 ${all.length} 条 bash tool/result 都带结构化 value，但字段不符合判据：${summary}。${coverageNote}`)
  }
  return ring('H2', 'pass', evidence, `全部 ${all.length} 条 bash tool/result 都带符合判据的结构化 value（kind/exitCode/jobId 可读）。${coverageNote}`)
}

function h3Ring(sessionAnalysis, redact, context = {}) {
  const hasJobFile = Boolean(context.jobEvidence || context.jobEvidenceError || context.jobEvidenceFile)
  const jobEval = evaluateJobEvidence(context.jobEvidence ?? null, {
    record: context.record ?? null,
    headerId: context.headerId ?? sessionAnalysis?.headerId ?? null,
    recordSessionId: context.recordSessionId ?? context.record?.sessionId ?? null,
    redact,
    loadError: context.jobEvidenceError ?? null,
    file: context.jobEvidenceFile ?? null,
  })
  const forms = sessionAnalysis
    ? sessionAnalysis.settled.slice(0, 20).map((event) => ({
        jobId: maskId(event.data.jobId),
        status: event.data.status,
        cause: event.data.cause,
        detail: redact(event.data.detail ?? '').slice(0, 120),
        detailExitCode: exitCodeFromDetail(event.data.detail),
        finishedAt: event.data.finishedAt ?? null,
      }))
    : []
  const evidence = {
    jobRegisteredCount: sessionAnalysis?.jobs.length ?? null,
    jobSettledCount: sessionAnalysis?.settled.length ?? null,
    settledSamples: forms.slice(0, 5),
    detailExitCodeFormCount: forms.filter((form) => form.detailExitCode !== null).length,
    jobEvidence: hasJobFile ? jobEval.evidence : null,
    note: 'Session 事件证明 Job 终态（status/detail）会随会话持久化；jobs.get/readAt 的实时行为（含错误 session 拒绝与 lossy）由 --job-evidence 运行时证据或 manualSteps.H3 宿主实测提供。',
  }
  if (hasJobFile) return ring('H3', jobEval.status, evidence, jobEval.notes)
  if (!sessionAnalysis) {
    return ring('H3', 'unavailable', evidence, '没有 Session 快照；Job 终态需在宿主内探测。manualSteps.H3 给出步骤；可用 --job-evidence 传入一次性 profile 的运行时证据。')
  }
  return ring('H3', 'manual', evidence, 'manualSteps.H3：在宿主内用 ctx.jobs.get/readAt 实测终态、错误 Session 行为与 lossy；类型契约声称 foreign job 抛错，但需实测确认。也可用 --job-evidence 传入一次性 profile 生成的运行时证据（仍非 A1-BIND 端到端证明）。')
}

function h4Ring(session, record, redact) {
  if (!session || !record) {
    return ring('H4', 'unavailable', {
      hasSession: Boolean(session), hasRecord: Boolean(record),
      recordSessionId: record ? redact(record.sessionId ?? '') : null,
      sessionHeaderId: session ? redact(session.headerId ?? '') : null,
    }, 'H4 需要同时提供 --session 与 --check-record；也可按 manualSteps.H4 手动采集。')
  }
  const recordSessionId = record.sessionId ?? null
  const headerId = session.headerId ?? null
  const evidence = {
    recordVersion: record.version ?? null,
    recordSessionId: redact(recordSessionId ?? ''),
    sessionHeaderId: redact(headerId ?? ''),
    equal: Boolean(recordSessionId) && Boolean(headerId) && recordSessionId === headerId,
    recordHasAgentField: Boolean(record.agent),
    note: 'run.json 的 sessionId 由 check-runner 写入 outer.agent.id；H4 要确认它等于 session.header.id。',
  }
  if (!recordSessionId || !headerId) {
    return ring('H4', 'unavailable', evidence, '记录或快照缺少 id 字段；见 manualSteps.H4。')
  }
  return ring('H4', evidence.equal ? 'pass' : 'fail', evidence, evidence.equal
    ? '记录写入的 sessionId 与 Session 头 id 相等。'
    : '记录写入的 sessionId 与 Session 头 id 不相等：按 A1 计划需改为写 session.header.id 并升记录格式版本。')
}

function h5Ring(sessionAnalysis, redact, context = {}) {
  if (!sessionAnalysis) return ring('H5', 'unavailable', null, '没有 Session 快照；前台/Job 输出完整性需在宿主内探测。')
  const truncated = sessionAnalysis.bashResults.filter((event) => textOfMessage(event.data.message).includes('[output truncated'))
  const samples = sessionAnalysis.bashResults.slice(0, 5).map((event) => {
    const message = event.data.message
    const text = textOfMessage(message)
    return {
      callId: maskId(message.toolCallId),
      chars: text.length,
      truncatedMarker: /\[output truncated[^\]]*\]/.exec(text)?.[0] ?? null,
      spillPathMarker: /full output: ([^\]]+)\]/.exec(text)?.[1] ?? null,
    }
  })
  const evidence = {
    bashResultCount: sessionAnalysis.bashResults.length,
    truncatedResultCount: truncated.length,
    samples,
    jobEvidence: null,
    note: '前台 truncated 标记可从快照核对；Job 输出可读性与 readAt.lossy 需要宿主进程内探测（manualSteps.H5）或 --job-evidence。',
  }
  if (context.jobEvidence) {
    const validation = validateJobEvidence(context.jobEvidence)
    evidence.jobEvidence = {
      file: context.jobEvidenceFile ? redact(context.jobEvidenceFile) : null,
      sessionId: typeof context.jobEvidence.sessionId === 'string' ? maskId(context.jobEvidence.sessionId) : null,
      jobId: typeof context.jobEvidence.jobId === 'string' ? maskId(context.jobEvidence.jobId) : null,
      readAt: context.jobEvidence.own?.readAt && typeof context.jobEvidence.own.readAt === 'object' ? {
        textChars: typeof context.jobEvidence.own.readAt.text === 'string' ? context.jobEvidence.own.readAt.text.length : null,
        lossy: context.jobEvidence.own.readAt.lossy ?? null,
        truncated: context.jobEvidence.own.readAt.truncated ?? null,
        chunks: Array.isArray(context.jobEvidence.own.readAt.chunks) ? context.jobEvidence.own.readAt.chunks.length : null,
      } : null,
    }
    if (!validation.ok) {
      return ring('H5', 'manual', evidence, `--job-evidence 字段不全，H5 的 Job 输出部分保持 manual：${validation.problems.join('；')}`)
    }
    const provenanceMismatch = (context.recordSessionId && context.jobEvidence.sessionId !== context.recordSessionId)
      || (context.headerId && context.jobEvidence.sessionId !== context.headerId)
      || (context.record?.jobId && context.jobEvidence.jobId !== context.record.jobId)
    if (provenanceMismatch) {
      return ring('H5', 'manual', evidence, '--job-evidence 的 sessionId/jobId 与当前 Session/记录不一致，H5 的 Job 输出部分不采信。')
    }
    if (sessionAnalysis.bashResults.length === 0) {
      return ring('H5', 'manual', evidence, '快照中没有前台 bash tool/result，前台完整性无法核对；--job-evidence 的 readAt 只能覆盖 Job 输出部分。')
    }
    if (truncated.length > 0) {
      return ring('H5', 'fail', evidence, `Session 快照中有 ${truncated.length} 条 bash tool/result 带 “[output truncated” 标记；前台输出不完整。`)
    }
    const readAt = context.jobEvidence.own.readAt
    if (readAt.lossy === true) {
      return ring('H5', 'fail', evidence, 'own.readAt.lossy=true：Job 输出已被丢弃，A1-OUT 无法重建完整输出。')
    }
    if (readAt.truncated === true) {
      return ring('H5', 'fail', evidence, 'own.readAt.truncated=true：Job 输出被截断，无法重建完整输出。')
    }
    return ring('H5', 'pass', evidence, '前台快照无 truncation 标记，且 --job-evidence 的 own.readAt lossy=false、truncated!=true、text 可读。这是可销毁 profile 的运行时证据，不是 A1-BIND 端到端证明。')
  }
  return ring('H5', 'manual', evidence, 'manualSteps.H5：在宿主内构造超长/提升为 Job 的命令，实测 truncation、spill、Job readAt 与 lossy；也可用 --job-evidence 传入 readAt 证据。')
}

function h6Ring() {
  return ring('H6', 'manual', { note: '需要真实 Worker 在可销毁实例上进行自影响尝试。' }, 'manualSteps.H6：Worker 尝试改写 Session 快照/检查记录/伪造 callId；任一生效即 fail，并按 P1-7 回退 A1-BIND。')
}

// ---- 宿主状态（只读） -------------------------------------------------------

async function readHostState(url) {
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/orchestrator/api/state`, {
      headers: { 'x-orchestrator-request': '1' },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    const state = await response.json()
    return {
      ok: true,
      paused: state.paused ?? null,
      load: state.load ?? null,
      runtime: state.health?.runtime?.state ?? null,
      health: Object.fromEntries(Object.entries(state.health ?? {}).map(([key, value]) => [key, value?.state ?? null])),
      masterId: maskId(state.masterId ?? ''),
      hasSetup: Boolean(state.setup),
    }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

// ---- 报告 -------------------------------------------------------------------

function manualOverride(spec) {
  const map = {}
  if (!spec) return map
  for (const part of String(spec).split(',')) {
    const [id, status] = part.split('=').map((item) => item.trim())
    if (!id || !status) continue
    if (!['H3', 'H4', 'H5', 'H6'].includes(id)) continue
    if (!['pass', 'fail', 'manual'].includes(status)) continue
    map[id] = status
  }
  return map
}

function summarize(rings) {
  const counts = { pass: 0, fail: 0, unavailable: 0, manual: 0 }
  for (const item of rings) counts[item.status] += 1
  const exitCode = counts.fail > 0 ? 1 : (counts.pass === rings.length ? 0 : 2)
  return { counts, exitCode }
}

async function probe(options) {
  const redact = redactor(!options.noRedact)
  const rings = []
  const operatorCommands = []
  let session = null
  let record = null
  let jobEvidence = null
  let sessionError = null
  let recordError = null
  let jobEvidenceError = null

  if (options.session) {
    try {
      session = readSessionSnapshot(resolve(options.session))
      if (session.problems.length > 0) sessionError = session.problems.slice(0, 3).join('; ')
    } catch (error) {
      sessionError = error.message
    }
  }
  if (options.checkRecord) {
    try {
      record = JSON.parse(readFileSync(resolve(options.checkRecord), 'utf8'))
    } catch (error) {
      recordError = error.message
    }
  }
  if (options.jobEvidence) {
    try {
      jobEvidence = JSON.parse(readFileSync(resolve(options.jobEvidence), 'utf8'))
    } catch (error) {
      jobEvidenceError = error.message
    }
  }
  const host = options.host ? await readHostState(options.host) : null
  const analysis = session ? analyzeSession(session) : null
  const overrides = manualOverride(options.manual)
  const jobContext = {
    jobEvidence,
    jobEvidenceError,
    jobEvidenceFile: options.jobEvidence ? resolve(options.jobEvidence) : null,
    record,
    headerId: session?.headerId ?? null,
    recordSessionId: record?.sessionId ?? null,
  }

  const baseRings = [
    h1Ring(analysis, record, redact),
    h2Ring(analysis, redact),
    h3Ring(analysis, redact, jobContext),
    h4Ring(session, record, redact),
    h5Ring(analysis, redact, jobContext),
    h6Ring(),
  ]
  for (const item of baseRings) {
    if (overrides[item.id] && overrides[item.id] !== item.status) {
      rings.push({ ...item, status: overrides[item.id], notes: `${item.notes ?? ''}（操作者人工结论：${overrides[item.id]}）` })
    } else {
      rings.push(item)
    }
  }

  if (session) {
    operatorCommands.push(
      `# 已在本地解析 Session 快照（只读）：${options.session}`,
      `# 复核内部 dispatch 的 Job 事件：在脱敏 JSON 中查看 rings[H1].evidence.internalJobSamples`,
    )
  } else {
    operatorCommands.push(
      "# 1) 找最近一次 Worker Session 快照（只读）：",
      "find <dsh-home>/sessions -name 'session.v*.jsonl.zstd' -print0 | xargs -0 ls -t | head -5",
      "# 2) 找对应的 check 记录（只读）：",
      'find <state>/hephi -path "*/checks/*/run.json" -print0 | xargs -0 ls -t | head -5',
      '# 3) 运行探针（只读）：',
      'node hephi/scripts/check-binding-host.mjs --session <session.v4.jsonl.zstd> --check-record <run.json> --host http://127.0.0.1:3083 --out /tmp/h1h2h4.json',
      '# 4) 按 manualSteps 在宿主内完成 H3/H5/H6，再回填：',
      'node hephi/scripts/check-binding-host.mjs --session <f> --check-record <r> --manual H3=pass,H5=pass,H6=pass --out /tmp/evidence-chain.json',
    )
  }
  operatorCommands.push(...(MANUAL_STEPS.H3.map((line) => `# H3 ${line}`)))
  operatorCommands.push(...(MANUAL_STEPS.H4.map((line) => `# H4 ${line}`)))
  operatorCommands.push(...(MANUAL_STEPS.H5.map((line) => `# H5 ${line}`)))
  operatorCommands.push(...(MANUAL_STEPS.H6.map((line) => `# H6 ${line}`)))
  operatorCommands.push(
    '# H3/H5 运行时证据（一次性/可销毁 DSH profile 内由独立探针生成只读 JSON）：',
    'node hephi/scripts/check-binding-host.mjs --session <f> --check-record <r> --job-evidence /tmp/job-evidence.json',
    '# 注意：path B 快照不持久化 Job stdout；该文件只证明 ctx.jobs.get/readAt 行为，不是 A1-BIND 端到端证明。',
  )

  const summary = summarize(rings)
  return {
    probe: 'ROADMAP-95 A2 evidence-chain host probe',
    generatedAt: new Date().toISOString(),
    mode: options.session || options.checkRecord || options.host ? 'host-evidence' : 'no-host-context',
    redaction: !options.noRedact,
    inputs: {
      session: options.session ? redact(resolve(options.session)) : null,
      sessionFormat: session?.format ?? null,
      sessionBytes: session?.bytes ?? null,
      sessionEventCount: session?.events.length ?? null,
      sessionHeaderId: session ? redact(session.headerId ?? '') : null,
      sessionParseError: sessionError,
      checkRecord: options.checkRecord ? redact(resolve(options.checkRecord)) : null,
      checkRecordError: recordError,
      jobEvidence: options.jobEvidence ? {
        file: redact(resolve(options.jobEvidence)),
        loaded: Boolean(jobEvidence) && !jobEvidenceError,
        error: jobEvidenceError,
        generatedBy: typeof jobEvidence?.generatedBy === 'string' ? jobEvidence.generatedBy : null,
        host: typeof jobEvidence?.host === 'string' ? redact(jobEvidence.host) : null,
        profile: typeof jobEvidence?.profile === 'string' ? redact(jobEvidence.profile) : null,
        sessionId: typeof jobEvidence?.sessionId === 'string' ? maskId(jobEvidence.sessionId) : null,
        jobId: typeof jobEvidence?.jobId === 'string' ? maskId(jobEvidence.jobId) : null,
        note: '由一次性/可销毁真实 DSH profile 内的 ctx.jobs.get/readAt 生成；只证明运行时 API 行为，不是 A1-BIND 端到端证明。',
      } : null,
      host: host ? { url: redact(options.host), ...host } : null,
    },
    rings,
    summary,
    exitCode: summary.exitCode,
    manualSteps: MANUAL_STEPS,
    operatorCommands,
    limitations: [
      '本脚本不进入宿主 Cordis 进程：jobs.get/readAt/lossy 与 H6 自影响只能由操作者在宿主内人工探测（或由独立的 --job-evidence 运行时探针提供，仍非端到端）。',
      '读取的是持久化 Session 快照（JSONL+zstd），不是实时 ctx 服务；快照结论 ≠ 端到端验收。',
      '快照存在两种宿主编码：path A（内部 bash tool/call + tool/result）与 path B（job/registered + job/settled，真实宿主历史形态）。H1 在 path A 缺失时按 path B 判定；path B 快照不持久化 Job stdout，不能重建输出。',
      '夹具/快照通过 ≠ A1-BIND 真实宿主端到端通过；--job-evidence 是可销毁 profile 的运行时证据，也不等于 A1-BIND 端到端通过；最终结论以 hephi/docs/validation/2026-11-07-evidence-chain-host.md 与 docs/a2-host-evidence-probe.md 记录为准。',
      'Worker 可写 workspace；H6 只能在一次性/可销毁宿主实例上尝试。',
    ],
  }
}

function printHuman(report) {
  const lines = []
  lines.push(`[check-binding-host] ${report.probe}`)
  lines.push(`[check-binding-host] mode=${report.mode} redaction=${report.redaction}`)
  if (report.inputs.session) lines.push(`[check-binding-host] session=${report.inputs.session} (${report.inputs.sessionFormat}, ${report.inputs.sessionEventCount} events)`)
  if (report.inputs.sessionParseError) lines.push(`[check-binding-host] session parse warning: ${report.inputs.sessionParseError}`)
  if (report.inputs.checkRecord) lines.push(`[check-binding-host] check-record=${report.inputs.checkRecord}`)
  if (report.inputs.host) lines.push(`[check-binding-host] host=${report.inputs.host.url} readable=${report.inputs.host.ok}`)
  for (const item of report.rings) {
    lines.push(`${item.id} ${item.status.toUpperCase()} :: ${item.notes ?? ''}`)
    for (const line of JSON.stringify(item.evidence ?? {}, null, 2).split('\n').slice(0, 30)) {
      lines.push(`    ${line}`)
    }
  }
  const { pass, fail, unavailable, manual } = report.summary.counts
  lines.push(`SUMMARY pass=${pass} fail=${fail} unavailable=${unavailable} manual=${manual}`)
  lines.push(`RESULT: ${report.exitCode === 0 ? 'PASS' : report.exitCode === 1 ? 'FAIL' : 'INCOMPLETE（unavailable/manual，需宿主操作者补证据）'}`)
  if (report.mode === 'no-host-context') {
    lines.push('')
    lines.push('在宿主上执行的命令：')
    for (const command of report.operatorCommands) lines.push(`  ${command}`)
  }
  console.log(lines.join('\n'))
}

// ---- 自测 -------------------------------------------------------------------

function selfTest(asJson) {
  const steps = []
  const record = (name, ok, detail) => steps.push({ name, ok: Boolean(ok), detail })
  const rootCallId = 'call_root_self_test_0001'
  const innerCallId = 'hephi-self-test-inner-0001'
  const sessionId = 'worker-self-test-000000000001'
  const command = `HEPHI_BASE_COMMIT=${quote('a'.repeat(40))} 'bash' 'scripts/check.sh'`
  const cwd = '/tmp/self-test-workspace'
  const baseRecord = {
    version: 3,
    runId: 'run-self-test',
    sessionId,
    callId: rootCallId,
    innerCallId,
    argv: ['bash', 'scripts/check.sh'],
    cwd,
    before: { baseCommit: 'a'.repeat(40) },
    status: 'passed',
    exitCode: 0,
  }
  const makeSession = (options = {}) => {
    const {
      innerCall = true, value = true, includeJob = false,
      owner = sessionId, label = command, status = 'completed', detail = 'exit code: 0',
    } = options
    const jobData = {
      jobId: 'bash-self-test-0001',
      owner,
      kind: 'bash',
      label,
      toolCall: { callId: innerCallId, rootCallId },
    }
    return {
      headerId: sessionId,
      events: [
        { type: 'session', data: { type: 'session', version: 4, id: sessionId } },
        { type: 'tool/call', data: { callId: rootCallId, name: 'hephi_check', arguments: '{"checkId":"project-regression"}' } },
        ...(includeJob ? [{ type: 'job/registered', data: { ...jobData } }] : []),
        ...(innerCall
          ? [
              { type: 'tool/call', data: { callId: innerCallId, name: 'bash', arguments: JSON.stringify({ command, workdir: cwd }) } },
              { type: 'tool/result', data: { message: { role: 'tool', toolCallId: innerCallId, isError: false, content: [{ type: 'text', text: '[exit code: 0]' }], ...(value ? { value: { kind: 'foreground', exitCode: 0, timedOut: false, aborted: false, stdout: { text: 'ok', truncated: false }, stderr: { text: '', truncated: false } } } : {}) } } },
            ]
          : []),
        ...(includeJob ? [{ type: 'job/settled', data: { ...jobData, status, cause: 'producer', producerReported: true, detail } }] : []),
        { type: 'tool/result', data: { message: { role: 'tool', toolCallId: rootCallId, isError: false, content: [{ type: 'text', text: '{"status":"passed"}' }] } } },
      ],
    }
  }
  const clone = (value) => JSON.parse(JSON.stringify(value))
  const redact = redactor(true)
  const session = makeSession()
  const analysis = analyzeSession(session)
  const h1 = h1Ring(analysis, baseRecord, redact)
  const h2 = h2Ring(analysis, redact)
  const h4 = h4Ring(session, baseRecord, redact)
  record('合成快照 path A：H1 pass（内部 tool/call 匹配命令与 workdir）', h1.status === 'pass' && h1.evidence?.encoding === 'path-A', JSON.stringify(h1.evidence?.inner))
  record('合成快照：H2 pass（结构化 value 可读）', h2.status === 'pass', JSON.stringify(h2.evidence))
  record('合成快照：H4 pass（sessionId 相等）', h4.status === 'pass', JSON.stringify(h4.evidence))

  // path B：真实宿主历史编码——没有内部 tool/call/tool/result，只有 job/registered + job/settled。
  const pathBSession = makeSession({ innerCall: false, value: false, includeJob: true })
  const pathBAnalysis = analyzeSession(pathBSession)
  const h1B = h1Ring(pathBAnalysis, baseRecord, redact)
  record('合成快照 path B：根调用 + job registered/settled 完整 → H1 pass（encoding=path-B）',
    h1B.status === 'pass' && h1B.evidence?.encoding === 'path-B' && h1B.evidence?.ownerMatchesSession === true
      && h1B.evidence?.labelMatchesCommand === true && h1B.evidence?.exitCode === 0,
    JSON.stringify({ status: h1B.status, encoding: h1B.evidence?.encoding, missing: h1B.evidence?.missing }))

  // F4 负例：双形状共存必须 fail(ambiguous)，与运行时 evidence-verifier 的拒绝对齐。
  const ambiguous = h1Ring(analyzeSession(makeSession({ innerCall: true, includeJob: true })), baseRecord, redact)
  record('负例 F4：path A 与 path B 证据同时存在 → H1 fail（encoding=ambiguous）',
    ambiguous.status === 'fail' && ambiguous.evidence?.encoding === 'ambiguous' && ambiguous.evidence?.ambiguous === true,
    JSON.stringify({ status: ambiguous.status, encoding: ambiguous.evidence?.encoding, pathBJobEventCount: ambiguous.evidence?.pathBJobEventCount }))

  const ownerMismatch = h1Ring(analyzeSession(makeSession({ innerCall: false, includeJob: true, owner: 'worker-other-000000000002' })), baseRecord, redact)
  record('负例 path B：job owner 不是本 Session → H1 fail', ownerMismatch.status === 'fail' && ownerMismatch.evidence?.ownerMatchesSession === false, ownerMismatch.notes)

  const labelMismatch = h1Ring(analyzeSession(makeSession({ innerCall: false, includeJob: true, label: `${command} --extra` })), baseRecord, redact)
  record('负例 path B：job label 与期望命令不逐字符相等 → H1 fail', labelMismatch.status === 'fail' && labelMismatch.evidence?.labelMatchesCommand === false, labelMismatch.notes)

  const labelTruncated = h1Ring(analyzeSession(makeSession({ innerCall: false, includeJob: true, label: command.slice(0, 60) })), baseRecord, redact)
  record('负例 path B：job label 被截断 → H1 fail（不作为 pass）',
    labelTruncated.status === 'fail' && String(labelTruncated.evidence?.notes ?? '').includes('截断'), labelTruncated.notes)

  const exitMismatch = h1Ring(analyzeSession(makeSession({ innerCall: false, includeJob: true, detail: 'exit code: 2' })), baseRecord, redact)
  record('负例 path B：job/settled exit code 与记录不一致 → H1 fail',
    exitMismatch.status === 'fail' && exitMismatch.evidence?.exitCode === 2, exitMismatch.notes)

  const noNative = h1Ring(analyzeSession(makeSession({ innerCall: false, includeJob: false })), baseRecord, redact)
  record('负例：path A 与 path B 都没有 → H1 fail（encoding=null）',
    noNative.status === 'fail' && noNative.evidence?.encoding === null, noNative.notes)

  const noValue = analyzeSession(makeSession({ innerCall: true, value: false }))
  record('负例：tool/result 无结构化 value → H2 fail', h2Ring(noValue, redact).status === 'fail', 'ok')

  // H2 全量统计回归（task-38）：修复前只采样前 5 条 → >5 条真实快照即使全结构化也恒 fail。
  const foregroundValue = (exitCode = 0) => ({
    kind: 'foreground', exitCode, timedOut: false, aborted: false, signal: null,
    stdout: { text: 'ok', truncated: false }, stderr: { text: '', truncated: false },
  })
  const promotedValue = (jobId = 'bash-self-promoted') => ({ kind: 'promoted', jobId, timeoutMs: 1000 })
  const makeMultiBashSession = (values) => {
    const events = [{ type: 'session', data: { type: 'session', version: 4, id: sessionId } }]
    const callIds = values.map((_, index) => `call_bash_self_${index}`)
    for (const callId of callIds) {
      events.push({ type: 'tool/call', data: { callId, name: 'bash', arguments: JSON.stringify({ command, workdir: cwd }) } })
    }
    values.forEach((value, index) => {
      events.push({
        type: 'tool/result',
        data: {
          message: {
            role: 'tool', toolCallId: callIds[index], isError: false,
            content: [{ type: 'text', text: '[exit code: 0]' }],
            ...(value ? { value } : {}),
          },
        },
      })
    })
    return { headerId: sessionId, events }
  }
  const h2Full = (values) => h2Ring(analyzeSession(makeMultiBashSession(values)), redact)

  const h2Seven = h2Full(Array.from({ length: 7 }, () => foregroundValue(0)))
  record('回归（task-38）：>5 条（7 条）全结构化 → H2 pass（全量统计，不再截前 5 条）',
    h2Seven.status === 'pass' && h2Seven.evidence?.bashResultCount === 7 && h2Seven.evidence?.structuredValueCount === 7
      && h2Seven.evidence?.samples?.length === 5,
    JSON.stringify({ status: h2Seven.status, ...h2Seven.evidence }))

  const h2SevenPartial = h2Full([...Array.from({ length: 6 }, () => foregroundValue(0)), null])
  record('回归（task-38）：>5 条（7 条）中 1 条缺结构化 value → H2 fail（6/7，真实缺失仍 fail）',
    h2SevenPartial.status === 'fail' && h2SevenPartial.evidence?.structuredValueCount === 6
      && h2SevenPartial.evidence?.problemCounts?.['missing-structured-value'] === 1,
    JSON.stringify({ status: h2SevenPartial.status, ...h2SevenPartial.evidence }))

  const h2Five = h2Full(Array.from({ length: 5 }, () => foregroundValue(0)))
  record('回归（task-38）：≤5 条（5 条）全结构化 → H2 pass（窗口行为不变）',
    h2Five.status === 'pass' && h2Five.evidence?.samples?.length === 5,
    JSON.stringify({ status: h2Five.status, kinds: h2Five.evidence?.kinds }))

  const h2NoExit = h2Full([foregroundValue(0), { kind: 'foreground', timedOut: false, aborted: false, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }])
  record('回归（task-38）：全结构化但 foreground 缺整数 exitCode → H2 fail（不放宽判据）',
    h2NoExit.status === 'fail' && h2NoExit.evidence?.problemCounts?.['foreground-without-integer-exit-code'] === 1,
    JSON.stringify(h2NoExit.evidence?.problemCounts))

  const h2PromotedExit = h2Full([promotedValue('bash-1'), { kind: 'promoted', jobId: 'bash-2', exitCode: 0 }])
  record('回归（task-38）：promoted 带最终 exitCode → H2 fail',
    h2PromotedExit.status === 'fail' && h2PromotedExit.evidence?.problemCounts?.['promoted-with-final-exit-code'] === 1,
    JSON.stringify(h2PromotedExit.evidence?.problemCounts))

  const h2PromotedNoJob = h2Full([{ kind: 'promoted', timeoutMs: 1000 }])
  record('回归（task-38）：promoted 缺 jobId → H2 fail',
    h2PromotedNoJob.status === 'fail' && h2PromotedNoJob.evidence?.problemCounts?.['promoted-without-jobId'] === 1,
    JSON.stringify(h2PromotedNoJob.evidence?.problemCounts))

  // GPT-B3（task-43）：显式 exitCode:null 与字段缺席必须可区分；非前台分支"字段存在即 fail"。
  const h2PromotedNull = h2Full([{ kind: 'promoted', jobId: 'bash-null-1', exitCode: null }])
  record('负例（GPT-B3）：promoted 显式 exitCode:null → H2 fail（字段存在即违规）',
    h2PromotedNull.status === 'fail' && h2PromotedNull.evidence?.problemCounts?.['promoted-with-final-exit-code'] === 1,
    JSON.stringify({ status: h2PromotedNull.status, problems: h2PromotedNull.evidence?.problemCounts }))

  const h2BackgroundNull = h2Full([{ kind: 'background', jobId: 'bash-null-2', exitCode: null }])
  record('负例（GPT-B3）：background 显式 exitCode:null → H2 fail（字段存在即违规）',
    h2BackgroundNull.status === 'fail' && h2BackgroundNull.evidence?.problemCounts?.['background-with-final-exit-code'] === 1,
    JSON.stringify({ status: h2BackgroundNull.status, problems: h2BackgroundNull.evidence?.problemCounts }))

  const h2PromotedAbsent = h2Full([{ kind: 'promoted', jobId: 'bash-null-3' }])
  record('负例（GPT-B3）：promoted 无 exitCode 字段 → H2 pass（缺席才是合法编码）',
    h2PromotedAbsent.status === 'pass' && h2PromotedAbsent.evidence?.samples?.[0]?.exitCodePresent === false,
    JSON.stringify({ status: h2PromotedAbsent.status, sample: h2PromotedAbsent.evidence?.samples?.[0] }))

  const h2ForegroundNull = h2Full([{ kind: 'foreground', exitCode: null }])
  record('负例（GPT-B3）：foreground 显式 exitCode:null → H2 fail（不是整数）',
    h2ForegroundNull.status === 'fail' && h2ForegroundNull.evidence?.problemCounts?.['foreground-without-integer-exit-code'] === 1,
    JSON.stringify({ status: h2ForegroundNull.status, problems: h2ForegroundNull.evidence?.problemCounts }))

  const h2PromotedOk = h2Full([foregroundValue(0), promotedValue('bash-3')])
  record('回归（task-38）：foreground 合规 + promoted 合规（jobId、无最终 exitCode）→ H2 pass',
    h2PromotedOk.status === 'pass' && h2PromotedOk.evidence?.coveredBranches?.includes('promoted') === true,
    JSON.stringify({ status: h2PromotedOk.status, covered: h2PromotedOk.evidence?.coveredBranches }))

  const h2NoPromoted = h2Full([foregroundValue(0), foregroundValue(1)])
  record('回归（task-38）：无 promoted/background 样本 → evidence.uncoveredKinds 显式标注（不得声称该分支通过）',
    h2NoPromoted.evidence?.uncoveredKinds?.length === 2 && String(h2NoPromoted.notes ?? '').includes('未覆盖分支'),
    JSON.stringify({ uncovered: h2NoPromoted.evidence?.uncoveredKinds, notes: h2NoPromoted.notes }))
  const mismatchRecord = { ...baseRecord, sessionId: 'worker-other-000000000002' }
  record('负例：sessionId 不一致 → H4 fail', h4Ring(session, mismatchRecord, redact).status === 'fail', 'ok')

  // --job-evidence：一次性宿主 profile 内 ctx.jobs.get/readAt 的运行时证据。
  const jobEvidence = {
    generatedBy: 'host-runtime-probe',
    host: 'http://127.0.0.1:0000',
    profile: 'disposable-self-test-profile',
    sessionId,
    jobId: 'bash-self-test-0001',
    own: {
      status: 'completed',
      detail: 'exit code: 0',
      readAt: { text: 'ok\n', lossy: false, truncated: false, chunks: [{ at: 0, text: 'ok\n' }] },
    },
    foreign: { threw: true, error: 'Job belongs to another Session' },
  }
  const h3Pass = h3Ring(analysis, redact, { jobEvidence, record: baseRecord, headerId: sessionId })
  record('job-evidence：own 终态+detail+readAt.text 且 foreign 被拒绝 → H3 pass', h3Pass.status === 'pass', h3Pass.notes)

  const readAtMissing = clone(jobEvidence)
  delete readAtMissing.own.readAt.text
  const h3Manual = h3Ring(analysis, redact, { jobEvidence: readAtMissing, record: baseRecord, headerId: sessionId })
  record('job-evidence：readAt.text 缺失 → H3 manual', h3Manual.status === 'manual', h3Manual.notes)

  const foreignAccepted = clone(jobEvidence)
  foreignAccepted.foreign = { threw: false, returned: true }
  const h3Foreign = h3Ring(analysis, redact, { jobEvidence: foreignAccepted, record: baseRecord, headerId: sessionId })
  record('job-evidence：foreign 调用未被拒绝 → H3 fail', h3Foreign.status === 'fail', h3Foreign.notes)

  const runningEvidence = clone(jobEvidence)
  runningEvidence.own.status = 'running'
  const h3Running = h3Ring(analysis, redact, { jobEvidence: runningEvidence, record: baseRecord, headerId: sessionId })
  record('job-evidence：own 非终态 → H3 fail', h3Running.status === 'fail', h3Running.notes)

  const h5Pass = h5Ring(analysis, redact, { jobEvidence })
  record('job-evidence：readAt lossy=false/truncated!=true → H5 pass', h5Pass.status === 'pass', h5Pass.notes)
  const lossyEvidence = clone(jobEvidence)
  lossyEvidence.own.readAt.lossy = true
  record('job-evidence：readAt.lossy=true → H5 fail', h5Ring(analysis, redact, { jobEvidence: lossyEvidence }).status === 'fail', 'ok')

  // 无上下文整体判定：应全 unavailable/manual 且 exit 2。
  const noContext = summarize([
    ring('H1', 'unavailable'), ring('H2', 'unavailable'), ring('H3', 'manual'),
    ring('H4', 'unavailable'), ring('H5', 'unavailable'), ring('H6', 'manual'),
  ])
  record('无宿主上下文：只有 unavailable/manual → exit 2', noContext.exitCode === 2, JSON.stringify(noContext))

  // zstd 多帧解析（Node>=22.15）。
  try {
    const zlib = requireZstd()
    const frames = [Buffer.from(JSON.stringify({ type: 'session', data: { id: sessionId } })), Buffer.from(JSON.stringify({ type: 'tool/call', data: { callId: rootCallId, name: 'hephi_check', arguments: '{}' } }))]
    const zstdPath = resolve('/tmp', `check-binding-host-self-${process.pid}.jsonl.zstd`)
    writeFileSync(zstdPath, Buffer.concat(frames.map((frame) => zlib.zstdCompressSync(frame))))
    const parsed = readSessionSnapshot(zstdPath)
    unlinkSync(zstdPath)
    record('zstd 多帧 Session 快照解析（2 frames → 2 events）', parsed.events.length === 2 && parsed.headerId === sessionId, `events=${parsed.events.length}`)
  } catch (error) {
    record('zstd 多帧 Session 快照解析', false, error.message)
  }

  const ok = steps.every((step) => step.ok)
  if (asJson) console.log(JSON.stringify({ selfTest: ok, steps }, null, 2))
  else {
    for (const step of steps) console.log(`${step.ok ? 'PASS' : 'FAIL'} ${step.name} :: ${step.detail}`)
    console.log(ok ? 'SELF-TEST: PASS' : 'SELF-TEST: FAIL')
  }
  return ok ? 0 : 1
}

// ---- 入口 -------------------------------------------------------------------

async function main() {
  if (hasFlag('help')) {
    console.log(USAGE)
    return 0
  }
  if (hasFlag('self-test')) {
    return selfTest(hasFlag('json'))
  }
  const options = {
    session: arg('session'),
    checkRecord: arg('check-record'),
    host: arg('host'),
    manual: arg('manual'),
    jobEvidence: arg('job-evidence'),
    out: arg('out'),
    noRedact: hasFlag('no-redact'),
    json: hasFlag('json'),
  }
  const report = await probe(options)
  if (!options.json) printHuman(report)
  else console.log(JSON.stringify(report, null, 2))
  if (options.out) {
    writeFileSync(resolve(options.out), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.error(`[check-binding-host] 脱敏报告已写入 ${options.out}`)
  }
  return report.exitCode
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    console.error(`[check-binding-host] 运行失败：${error.message}`)
    process.exitCode = 2
  })
}

export {
  readSessionSnapshot,
  analyzeSession,
  h1Ring,
  h2Ring,
  h3Ring,
  h4Ring,
  h5Ring,
  h6Ring,
  probe,
  expectedCheckCommand,
  exitCodeFromDetail,
  pathBEvidence,
  validateJobEvidence,
  evaluateJobEvidence,
  TERMINAL_JOB_STATUSES,
}
