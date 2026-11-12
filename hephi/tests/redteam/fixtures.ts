/**
 * A6 红队本地套件的共享夹具。
 *
 * 所有夹具只用临时目录里的自建 git 仓库与 stateDir，不连接真实宿主、不写真实状态目录。
 * 这里的“原生执行”是合成的 Session 快照（模拟级），因此本套件只能声称：
 * 「已列举的本地场景没有被绕过」，**不能**声称“证据不可伪造”或真实宿主已验收。
 * 真实宿主形状（H1–H5 / A2）仍未验证；相关用例在 README 与断言旁标注。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { afterEach } from 'vitest'
import type { ActivationContract } from '../../src/control/activation.js'
import type { VerificationCheck } from '../../src/contracts/checks.js'
import { checkCommand, runCheck, type NativeJobs, type NativeJobView } from '../../src/control/check-runner.js'
import { OPERATOR_RESOLUTIONS_ENV, readRuns, type CheckRunRecord } from '../../src/control/check-store.js'
import { createEvidenceVerifier, type SessionSnapshot } from '../../src/control/evidence-verifier.js'
import { sha256 } from '../../src/verification/fingerprint.js'

const run = promisify(execFile)

export const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

/** The Worker Session id the fixture scripts use in check records and ready reports. */
export const SESSION = 'worker-session'
export const TICKET = 'ticket-1'

export const checks: VerificationCheck[] = [
  { id: 'build', kind: 'build', purpose: 'build', command: 'true', args: [], cwd: '.', required: true, timeoutMs: 5000 },
  { id: 'unit', kind: 'test', purpose: 'unit', command: 'true', args: ['--unit'], cwd: '.', required: true, timeoutMs: 5000 },
]

export type RepoFixture = { dir: string; baseSha: string; headSha: string }

/** A throwaway Git checkout with one committed in-scope patch on top of `base`. */
export async function repo(): Promise<RepoFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'hephi-redteam-repo-'))
  cleanup.push(dir)
  await run('git', ['init', '-b', 'main', dir])
  await run('git', ['config', 'user.email', 'redteam@example.invalid'], { cwd: dir })
  await run('git', ['config', 'user.name', 'redteam'], { cwd: dir })
  await run('git', ['remote', 'add', 'origin', 'git@github.com:example/redteam-fixture.git'], { cwd: dir })
  await mkdir(join(dir, 'src'))
  await mkdir(join(dir, 'docs'))
  await writeFile(join(dir, 'src/app.js'), 'module.exports = 1\n')
  await writeFile(join(dir, 'docs/notes.md'), 'notes\n')
  await run('git', ['add', '.'], { cwd: dir })
  await run('git', ['commit', '-m', 'base'], { cwd: dir })
  const baseSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
  await writeFile(join(dir, 'src/app.js'), 'module.exports = 2\n')
  await run('git', ['add', '.'], { cwd: dir })
  await run('git', ['commit', '-m', 'patch'], { cwd: dir })
  const headSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
  return { dir, baseSha, headSha }
}

export async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hephi-redteam-state-'))
  cleanup.push(dir)
  return dir
}

export function contract(r: RepoFixture, overrides: Partial<ActivationContract> = {}): ActivationContract {
  return {
    enabled: true, ticketId: TICKET, repository: 'example/redteam-fixture', issueNumber: 42,
    workspace: r.dir, baseRef: 'main', baseSha: r.baseSha, allowedPaths: ['**'], requirePullRequest: false,
    verification: { version: 1, checks: checks.map(check => ({ ...check })) },
    contractHash: `sha256:${'a'.repeat(64)}`,
    ...overrides,
  }
}

/**
 * T07: the run directory lives under the fixture's temporary stateDir, which the
 * contract does not carry. Register contract → stateDir in a WeakMap so the
 * synthetic Session commands stay byte-identical to the ones runCheck emits,
 * without changing any call site of `callEvent`/`boundSnapshot`.
 *
 * Some tests derive a new contract object by spreading the fixture contract
 * (`{ ...f.c, … }`), which is a different identity; a secondary key on the
 * throwaway repo path + ticket + base commit keeps those commands consistent too.
 */
const stateDirOf = new WeakMap<ActivationContract, string>()
const stateDirByCheckout = new Map<string, string>()
const checkoutKey = (c: ActivationContract) => `${c.workspace}\n${c.ticketId}\n${c.baseSha}`

function runDirOf(c: ActivationContract, record: CheckRunRecord): string | undefined {
  const stateDir = stateDirOf.get(c) ?? stateDirByCheckout.get(checkoutKey(c))
  return stateDir === undefined ? undefined : join(stateDir, 'hephi', c.ticketId, 'checks', record.runId)
}

/** Contract with a frozen binding requirement (format v3). */
export function bindingContract(c: ActivationContract, requireSessionBinding = true): ActivationContract {
  const bound = { ...c, version: 3, evidence: { requireSessionBinding } }
  const stateDir = stateDirOf.get(c)
  if (stateDir !== undefined) stateDirOf.set(bound, stateDir)
  return bound
}

export type Fixture = { r: RepoFixture; stateDir: string; c: ActivationContract }

export async function fixture(overrides: Partial<ActivationContract> = {}): Promise<Fixture> {
  const r = await repo()
  const sd = await stateDir()
  const c = contract(r, overrides)
  stateDirOf.set(c, sd)
  stateDirByCheckout.set(checkoutKey(c), sd)
  return { r, stateDir: sd, c }
}

export function outer(checkId: string): ToolExecution {
  return {
    callId: `outer-${checkId}` as never, rootCallId: `outer-${checkId}` as never, name: 'hephi_check',
    agent: { id: SESSION } as never, arguments: { checkId }, signal: new AbortController().signal, token: Symbol(checkId) as never,
  }
}

export function ready(workspace: string, sessionId: string = SESSION): ToolExecution {
  return {
    callId: 'ready-call' as never, rootCallId: 'ready-call' as never, name: 'orchestrator_report',
    arguments: { state: 'ready' },
    signal: new AbortController().signal, token: Symbol('ready') as never,
    agent: { session: { header: { cwd: workspace, id: sessionId } } } as never,
  }
}

/** Fake node on the host side: a successful foreground bash result the runner records. */
export function nativeTools(exitCode = 0) {
  return {
    execute: async () => ({
      isError: false as const, content: [], value: {
        kind: 'foreground', cwd: '/work', exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 5000,
        stdout: { text: 'ok\n', truncated: false }, stderr: { text: '', truncated: false },
      },
    }),
  }
}

export async function execute(f: Fixture, checkId: string, tools = nativeTools(), contractOverride?: ActivationContract): Promise<CheckRunRecord> {
  return runCheck({
    stateDir: f.stateDir, contract: contractOverride ?? f.c, checkId, outer: outer(checkId), tools,
    allowOperatorResolutions: false,
  })
}

/** Run every frozen check successfully; returns the records in sequence order. */
export async function runAll(f: Fixture, tools = nativeTools(), contractOverride?: ActivationContract): Promise<CheckRunRecord[]> {
  for (const id of ['build', 'unit']) await execute(f, id, tools, contractOverride)
  return readRuns(f.stateDir, (contractOverride ?? f.c).ticketId)
}

export type VerifyOptions = {
  binding?: boolean
  readSession?: (id: string) => Promise<SessionSnapshot>
  jobs?: NativeJobs
  allowOperatorResolutions?: boolean
}

/** Checks the contract actually consumes at ready (required checks + acceptance items). */
function neededCheckIds(c: ActivationContract): Set<string> {
  const needed = new Set(c.verification.checks.filter(check => check.required).map(check => check.id))
  for (const item of c.task?.acceptance ?? []) needed.add(item.check)
  return needed
}

/**
 * B2 (DSH host task order §3.2): a binding-effective ready report now also requires the
 * host's four-way delivery binding record. The red-team suite models an honest deployment
 * (B1 + B2 delivered), so a matching record is written before each binding-on verification;
 * the attack cases still deny earlier in the chain. The consumer gate itself (missing /
 * mismatched record, binding-off zero regression) is covered by
 * tests/control/binding-record.test.ts.
 */
async function writeBindingRecordFixture(stateDir: string, contract: ActivationContract): Promise<void> {
  const needed = neededCheckIds(contract)
  const records = await readRuns(stateDir, contract.ticketId)
  const record = [...records].reverse().find(item => needed.has(item.checkId)
    && item.contractHash === contract.contractHash && item.status === 'passed' && item.exitCode === 0)
  if (record === undefined || record.before.headCommit === undefined) return
  const execution = record.jobId === undefined
    ? { kind: 'foreground' as const, exitCode: record.exitCode!, toolCallId: record.innerCallId }
    : { kind: 'background' as const, jobId: record.jobId, toolCallId: record.innerCallId }
  await mkdir(join(stateDir, 'binding'), { recursive: true })
  await writeFile(join(stateDir, 'binding', `${contract.ticketId}.json`), JSON.stringify({
    version: 1,
    producedAt: '2026-11-12T07:00:00Z',
    producer: 'redteam-fixture',
    ticket: { id: contract.ticketId },
    session: { id: SESSION },
    execution,
    finalCommit: { sha: record.before.headCommit, baseSha: contract.baseSha },
  }))
}

export function verifier(f: { stateDir: string }, options: VerifyOptions = {}) {
  const verify = createEvidenceVerifier({
    stateDir: f.stateDir,
    readSession: options.readSession,
    requireSessionBinding: options.binding === true,
    jobs: options.jobs,
    allowOperatorResolutions: options.allowOperatorResolutions,
  })
  if (options.binding !== true) return verify
  return async (contract: ActivationContract, execution: ToolExecution) => {
    await writeBindingRecordFixture(f.stateDir, contract)
    return verify(contract, execution)
  }
}

// ---- 合成 Session 快照：路径 A（结构化 tool/call + tool/result.value） ----------------

export type SessionEvent = SessionSnapshot['events'][number]
export type NativeValue = Record<string, unknown>

export function foregroundValue(over: NativeValue = {}): NativeValue {
  return {
    kind: 'foreground', cwd: '/work', exitCode: 0, signal: null, timedOut: false, aborted: false,
    stdout: { text: 'ok\n', truncated: false }, stderr: { text: '', truncated: false }, ...over,
  }
}

export function callEvent(record: CheckRunRecord, c: ActivationContract, seq: number,
  over: { command?: string; workdir?: string; callId?: string; name?: string } = {}): SessionEvent {
  const definition = c.verification.checks.find(check => check.id === record.checkId)!
  // T07: the frozen command now carries HEPHI_RUN_DIR; derive the same run dir the
  // runner used (registered by `fixture()`), falling back to no prefix only for a
  // contract that never belonged to a fixture (no state directory exists then).
  const runDir = runDirOf(c, record)
  return {
    seq, type: 'tool/call',
    data: {
      name: over.name ?? 'bash', callId: over.callId ?? record.innerCallId,
      arguments: JSON.stringify({
        command: over.command ?? checkCommand(c.baseSha, definition.command, definition.args, runDir),
        workdir: over.workdir ?? record.cwd,
      }),
    },
  }
}

export function resultEvent(record: CheckRunRecord, seq: number, value: unknown, over: { isError?: boolean } = {}): SessionEvent {
  return { seq, type: 'tool/result', data: { message: { toolCallId: record.innerCallId, isError: over.isError ?? false, content: [], value } } }
}

export function snapshotOf(events: SessionEvent[], sessionId: string = SESSION, inheritedEventCount = 0): SessionSnapshot {
  return { session: { id: sessionId }, inheritedEventCount, events }
}

/** A Session snapshot with exactly the native calls/results the records claim (path A). */
export function boundSnapshot(sessionId: string, records: CheckRunRecord[], c: ActivationContract): SessionSnapshot {
  const events: SessionEvent[] = []
  for (const record of records) {
    events.push(callEvent(record, c, events.length))
    events.push(resultEvent(record, events.length, foregroundValue()))
  }
  return snapshotOf(events, sessionId)
}

export type JobRead = { chunks: { at: number; text: string }[]; lossy: boolean }

export function fakeJobs(over: { views?: Record<string, NativeJobView>; reads?: Record<string, JobRead>; getThrows?: boolean } = {}): NativeJobs {
  return {
    get: (id: string) => {
      if (over.getThrows) throw new Error('unknown Job')
      const view = over.views?.[id]
      if (!view) throw new Error('unknown Job')
      return view
    },
    wait: async () => { throw new Error('the verifier must not wait for a Job') },
    readAt: (id: string) => {
      const read = over.reads?.[id]
      if (!read) throw new Error('Job output cleared')
      return read
    },
    kill: () => 'already-finished' as const,
  }
}

export async function lastDecision(state: string, ticketId: string): Promise<any> {
  const text = await readFile(join(state, 'hephi', ticketId, 'decisions.jsonl'), 'utf8')
  return JSON.parse(text.trim().split('\n').at(-1)!)
}

const runDir = (f: Fixture, record: CheckRunRecord) => join(f.stateDir, 'hephi', f.c.ticketId, 'checks', record.runId)

/** Rewrite one stored record (attacker model: the state directory is writable). */
export async function rewriteRecord(f: Fixture, record: CheckRunRecord, patch: Partial<CheckRunRecord>): Promise<CheckRunRecord> {
  const next = { ...record, ...patch }
  await writeFile(join(runDir(f, record), 'run.json'), JSON.stringify(next, null, 2))
  return next
}

export async function writeOutputLog(f: Fixture, record: CheckRunRecord, text: string): Promise<void> {
  await writeFile(join(runDir(f, record), 'output.log'), text)
}

export { sha256 }
export { OPERATOR_RESOLUTIONS_ENV, readResolutions, resolutionsPath } from '../../src/control/check-store.js'

/**
 * A3 operator config for the CLI: a mode-0600 JSON file whose path is placed in
 * HEPHI_OPERATOR_CONFIG. The process environment (including the legacy
 * HEPHI_ALLOW_OPERATOR_RESOLUTIONS switch) is not an enable channel.
 */
export async function operatorConfigEnv(enabled = true): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env[OPERATOR_RESOLUTIONS_ENV]
  delete env.HEPHI_OPERATOR_CONFIG
  if (!enabled) return env
  const dir = await mkdtemp(join(tmpdir(), 'hephi-redteam-operator-'))
  cleanup.push(dir)
  const file = join(dir, 'operator.json')
  await writeFile(file, JSON.stringify({ allowOperatorResolutions: true }), { mode: 0o600 })
  env.HEPHI_OPERATOR_CONFIG = file
  return env
}
