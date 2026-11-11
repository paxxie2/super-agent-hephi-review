#!/usr/bin/env node
/** Build recoveries.jsonl for T11 from the captured raw transcripts. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ev = process.argv[2]
if (!ev) throw new Error('usage: node build-recoveries.mjs <evidence-dir>')
const raw = join(ev, 'raw')
const read = p => { try { return readFileSync(join(raw, p), 'utf8') } catch { return undefined } }
const clean = p => (read(p) ?? '').trimEnd()
const code = p => Number((read(p) ?? 'NaN').trim())
const json = p => JSON.parse(read(p))

const facts = read('00-host-facts/host-facts.txt') ?? ''
const host = {
  port: 3085,
  pid: Number((facts.match(/33924\s+zm\s+/) ? 33924 : NaN)),
  pluginCommit: (facts.match(/hephi-activation\][^\n]*commit=([0-9a-f]{40})/) ?? [])[1],
  cliPath: (facts.match(/hephi-review\/hephi\/lib\/cli\.mjs/) ?? [])[0] ? '/Users/zm/dsh-instances/g1-exp/hephi-review/hephi/lib/cli.mjs' : undefined,
  cliSha256: (facts.match(/([0-9a-f]{64})  \/Users\/zm\/dsh-instances\/g1-exp\/hephi-review\/hephi\/lib\/cli\.mjs/) ?? [])[1],
}
const operatorConfig = {
  path: '/Users/zm/dsh-instances/g1-exp/operator-config.json',
  mode: (facts.match(/-rw-------@[^\n]*operator-config\.json/) ? '0600' : undefined),
  content: '{"allowOperatorResolutions": true}',
}
const root = (read('tmp-root.env') ?? '').match(/ROOT=(.+)/)?.[1]?.trim()
const ticketId = '46aa3f5947c125330ef14d8014a88477'

function attempt(dir, label) {
  return {
    label,
    command: clean(`${dir}/command.txt`),
    exitCode: code(`${dir}/exit-code.txt`),
    stdout: clean(`${dir}/stdout.txt`),
    stderr: clean(`${dir}/stderr.txt`),
  }
}

function resolutionFor(scenarioDir, runId) {
  const lines = (read(`${scenarioDir}/resolutions.jsonl`) ?? '').split('\n').filter(Boolean)
  const row = lines.map(line => JSON.parse(line)).find(entry => entry.runId === runId)
  if (!row) throw new Error(`no resolution for ${runId} in ${scenarioDir}`)
  return row
}

function recordStatus(scenarioDir) {
  return json(`${scenarioDir}/record-status-after-recovery.json`)
}

function sha(scenarioDir, name) {
  const value = (read(`${scenarioDir}/${name}`) ?? '').trim()
  return value.split(/\s+/)[0]
}

function sameSha(scenarioDir) {
  return sha(scenarioDir, 'run-json-before.sha256') === sha(scenarioDir, 'run-json-after-recovery.sha256')
}

const rows = []

// ① still running -> refuse; recovery after operator stop + terminal confirmation
{
  const d = '01-still-running'
  const runId = '11111111-aaaa-4bbb-8ccc-111111111111'
  const resolution = resolutionFor(d, runId)
  const status = recordStatus(d)
  rows.push({
    schema: 't11-recovery/1', kind: 'recovery', scenario: 'still-running',
    scenarioZh: '仍在运行：宿主仍报告该执行在运行',
    ticketId, runId, host,
    recordBefore: { status: 'running', exitCode: null, finishedAt: null },
    hostQueryBefore: clean(`${d}/host-query-running.txt`),
    firstFailure: attempt(`${d}/attempt1-refused`, 'refused while the host reports running'),
    recovery: attempt(`${d}/attempt2-recovery`, 'operator stopped the process and confirmed a terminal state'),
    idempotentRepeat: attempt(`${d}/attempt3-idempotent-repeat`, 'repeat after recovery'),
    postState: {
      ...status,
      passEvidence: false,
      runJsonSha256Before: sha(d, 'run-json-before.sha256'),
      runJsonSha256After: sha(d, 'run-json-after-recovery.sha256'),
      runJsonUnchanged: sameSha(d),
      resolutionsAppended: 1,
    },
    resolution: { basis: resolution.basis, operator: resolution.operator, at: resolution.at, runId: resolution.runId, contractHash: resolution.contractHash },
    authorization: { operator: 't11-recovery-operator', operatorConfig, acceptRisk: false, authorizes: 'operator CLI in the host shell (task-21; G1 operator channel)' },
    rawDir: `raw/${d}`,
  })
}

// ② host query unavailable -> explicit risk acceptance required
{
  const d = '02-query-unavailable'
  const runId = '22222222-aaaa-4bbb-8ccc-222222222222'
  const resolution = resolutionFor(d, runId)
  rows.push({
    schema: 't11-recovery/1', kind: 'recovery', scenario: 'query-unavailable',
    scenarioZh: '查询不可用：宿主 Job/进程查询失败',
    ticketId, runId, host,
    recordBefore: { status: 'unknown', exitCode: null, finishedAt: null },
    hostQueryBefore: clean(`${d}/host-query-unavailable.txt`),
    hostQueryFailure: { command: 'curl -sS --max-time 3 http://127.0.0.1:65000/', exitCode: code(`${d}/curl.exit-code`), stderr: clean(`${d}/curl.stderr`) },
    firstFailure: attempt(`${d}/attempt1-refused-no-risk-acceptance`, 'refused without explicit risk acceptance'),
    guardFailure: attempt(`${d}/attempt2-refused-wrong-basis`, 'refused with host-terminal basis while the query was unavailable'),
    recovery: attempt(`${d}/attempt3-recovery-risk-accepted`, 'operator explicitly accepted the risk'),
    postState: {
      ...recordStatus(d),
      passEvidence: false,
      runJsonSha256Before: sha(d, 'run-json-before.sha256'),
      runJsonSha256After: sha(d, 'run-json-after-recovery.sha256'),
      runJsonUnchanged: sameSha(d),
      resolutionsAppended: 1,
    },
    resolution: { basis: resolution.basis, operator: resolution.operator, at: resolution.at, contractHash: resolution.contractHash },
    authorization: { operator: 't11-recovery-operator', operatorConfig, acceptRisk: true, authorizes: 'manual confirmation marked operator-risk-accepted (query unavailable)' },
    rawDir: `raw/${d}`,
  })
}

// ③ host confirmed end but output/exit code lost -> resolve allowed, never passing evidence
{
  const d = '03-result-lost'
  const runId = '33333333-aaaa-4bbb-8ccc-333333333333'
  const resolution = resolutionFor(d, runId)
  const status = recordStatus(d)
  rows.push({
    schema: 't11-recovery/1', kind: 'recovery', scenario: 'result-lost',
    scenarioZh: '已结束但结果丢失：宿主确认结束，输出/退出码不可得',
    ticketId, runId, host,
    recordBefore: { status: 'unknown', exitCode: null, finishedAt: 'set', outputLog: 'absent' },
    hostQueryBefore: clean(`${d}/host-query-confirmed-ended.txt`),
    injectedFailure: {
      label: 'host confirmed the execution ended, but output/exit code were lost',
      command: null,
      exitCode: null,
      stdout: '',
      stderr: 'run.json stays status=unknown, exitCode=null, finishedAt set; the run directory has only run.json (no output.log, no outputHash)',
    },
    recovery: attempt(`${d}/attempt1-recovery`, 'host-terminal resolution for the lost result'),
    postState: {
      ...status,
      passEvidence: false,
      outputLogCreated: false,
      runJsonUnchanged: sameSha(d),
      runJsonSha256Before: sha(d, 'run-json-before.sha256'),
      runJsonSha256After: sha(d, 'run-json-after-recovery.sha256'),
      note: 'resolution only restores rerun eligibility; the old execution has no output.log and no exit code, so it cannot be passing evidence',
    },
    resolution: { basis: resolution.basis, operator: resolution.operator, at: resolution.at, contractHash: resolution.contractHash },
    authorization: { operator: 't11-recovery-operator', operatorConfig, acceptRisk: false, authorizes: 'host-terminal confirmation recorded from the real process query' },
    rawDir: `raw/${d}`,
  })
}

// ④ leftover running after a host crash -> confirm no process, then treat as ended/unknown
{
  const d = '04-leftover-running'
  const runId = '44444444-aaaa-4bbb-8ccc-444444444444'
  const resolution = resolutionFor(d, runId)
  rows.push({
    schema: 't11-recovery/1', kind: 'recovery', scenario: 'leftover-running',
    scenarioZh: '遗留 running：宿主已结束该执行，但记录停在 running',
    ticketId, runId, host,
    recordBefore: { status: 'running', exitCode: null, finishedAt: null },
    hostQueryBefore: clean(`${d}/host-query-leftover.txt`),
    firstFailure: attempt(`${d}/attempt1-refused-no-host-query`, 'refused without host-query evidence'),
    guardFailure: attempt(`${d}/attempt2-refused-status-running`, 'refused while the operator still classified it as running'),
    recovery: attempt(`${d}/attempt3-recovery`, 'host query confirmed no such process; recorded host-terminal'),
    idempotentRepeat: attempt(`${d}/attempt4-idempotent-repeat`, 'repeat after recovery'),
    postState: {
      ...recordStatus(d),
      passEvidence: false,
      runJsonUnchanged: sameSha(d),
      runJsonSha256Before: sha(d, 'run-json-before.sha256'),
      runJsonSha256After: sha(d, 'run-json-after-recovery.sha256'),
      resolutionsAppended: 1,
    },
    resolution: { basis: resolution.basis, operator: resolution.operator, at: resolution.at, contractHash: resolution.contractHash },
    authorization: { operator: 't11-recovery-operator', operatorConfig, acceptRisk: false, authorizes: 'first queried the host process, then recorded the operator decision' },
    rawDir: `raw/${d}`,
  })
}

// ⑤ operator gate: authorization channel enforcement
{
  const d = '05-operator-gate'
  rows.push({
    schema: 't11-recovery/1', kind: 'authorization-gate', scenario: 'operator-gate',
    scenarioZh: '授权通道：无配置/权限过宽/仅环境变量均不得启用解除',
    ticketId, runId: '33333333-aaaa-4bbb-8ccc-333333333333', host,
    hostQueryBefore: 'see raw/03-result-lost/host-query-confirmed-ended.txt',
    firstFailure: attempt(`${d}/attempt1-refused-no-config`, 'refused without operator config'),
    guardFailure: attempt(`${d}/attempt2-refused-group-readable-config`, 'refused with a group-readable operator config'),
    envOnlyFailure: attempt(`${d}/attempt3-refused-env-only`, 'refused when only HEPHI_ALLOW_OPERATOR_RESOLUTIONS=1 is set'),
    postState: { resolutionsAppended: 0, passEvidence: false },
    authorization: { operatorConfig, acceptRisk: false, note: 'process environment is not an enable channel; a 0600 operator-owned config is required' },
    rawDir: `raw/${d}`,
  })
}

const out = rows.map(row => JSON.stringify(row)).join('\n') + '\n'
writeFileSync(join(ev, 'recoveries.jsonl'), out)
console.log(`wrote ${rows.length} records to ${join(ev, 'recoveries.jsonl')}`)
