import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActivationContract } from '../../src/control/activation.js'
import type { VerificationCheck } from '../../src/contracts/checks.js'
import { checkCommand, runCheck, type NativeJobView, type NativeJobs } from '../../src/control/check-runner.js'
import { sha256 } from '../../src/verification/fingerprint.js'
import { createEvidenceVerifier, sessionBindingProblem, type SessionSnapshot } from '../../src/control/evidence-verifier.js'
import { appendResolution, checkRunDir, readRuns, type CheckRunRecord } from '../../src/control/check-store.js'
import { allowedPath } from '../../src/control/repository.js'
import { pluginCommit } from '../../src/version.js'

const run = promisify(execFile)
const build: VerificationCheck = {
  id: 'build', kind: 'build', purpose: 'build', command: 'true', args: [], cwd: '.',
  required: true, timeoutMs: 5000
}
const test: VerificationCheck = {
  id: 'unit', kind: 'test', purpose: 'test', command: 'pytest', args: [], cwd: '.',
  required: true, timeoutMs: 5000,

}

async function repo(): Promise<{ dir: string; baseSha: string; headSha: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'hephi-ready-repo-'))
  await run('git', ['init', '-b', 'main', dir])
  await run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir })
  await run('git', ['config', 'user.name', 'Ready test'], { cwd: dir })
  await run('git', ['remote', 'add', 'origin', 'git@github.com:example/lean-fixture.git'], { cwd: dir })
  await writeFile(join(dir, 'a.txt'), 'base\n')
  await run('git', ['add', '.'], { cwd: dir })
  await run('git', ['commit', '-m', 'base'], { cwd: dir })
  const baseSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
  await writeFile(join(dir, 'a.txt'), 'patched\n')
  await run('git', ['add', '.'], { cwd: dir })
  await run('git', ['commit', '-m', 'patch'], { cwd: dir })
  const headSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
  return { dir, baseSha, headSha }
}

function contract(dir: string, baseSha: string, allowedPaths = ['**'], requirePullRequest = false, checks: VerificationCheck[] = [build, test]): ActivationContract {
  return {
    enabled: true, ticketId: 'ticket-1', repository: 'example/lean-fixture', issueNumber: 42,
    workspace: dir, baseRef: 'main', baseSha, allowedPaths, requirePullRequest,
    verification: { version: 1, checks }, contractHash: 'sha256:test',
  }
}

/**
 * T07: the frozen check command now carries HEPHI_RUN_DIR=<stateDir>/hephi/<ticketId>/checks/<runId>,
 * so a synthetic Session command must be rebuilt with the same run directory. `setup()` registers its
 * temporary state directory here; the contract identity is primary and the base commit is the fallback
 * for contracts derived with `{ ...c }` (which lose the identity but keep workspace/ticket/base).
 */
const stateDirOf = new WeakMap<ActivationContract, string>()
const stateDirByBase = new Map<string, string>()

function registerStateDir(c: ActivationContract, stateDir: string): void {
  stateDirOf.set(c, stateDir)
  stateDirByBase.set(c.baseSha, stateDir)
}

/** The run directory the runner used for this record, or undefined for an unregistered base commit. */
function runDirOf(c: ActivationContract, record: CheckRunRecord): string | undefined {
  const stateDir = stateDirOf.get(c) ?? stateDirByBase.get(c.baseSha)
  return stateDir === undefined ? undefined : checkRunDir(stateDir, c.ticketId, record.runId)
}

function outer(checkId: string): ToolExecution {
  return {
    callId: `outer-${checkId}` as never, rootCallId: `outer-${checkId}` as never, name: 'hephi_check',
    agent: { id: 'worker-session' } as never, arguments: { checkId }, signal: new AbortController().signal, token: Symbol(checkId) as never,
  }
}

function ready(workspace: string, prNumber?: number, sessionId: string = 'worker-session'): ToolExecution {
  return {
    callId: 'ready-call' as never, rootCallId: 'ready-call' as never, name: 'orchestrator_report',
    arguments: { state: 'ready', ...(prNumber === undefined ? {} : { pr_number: prNumber }) },
    signal: new AbortController().signal, token: Symbol('ready') as never,
    // A real DSH ready report always carries the Worker Session header; A1-K4 requires it.
    agent: { session: { header: { cwd: workspace, id: sessionId } } } as never,
  }
}

/**
 * A Session snapshot containing exactly the native bash calls/results that the check
 * records claim (the host bash tool is a fixture in this suite). This is the shape
 * sessionBindingProblem looks for; it is not a real DSH Session recording.
 */
function boundSnapshot(sessionId: string, records: CheckRunRecord[], baseSha: string): SessionSnapshot {
  const events: SessionSnapshot['events'] = []
  for (const record of records) {
    const stateDir = stateDirByBase.get(baseSha)
    const command = checkCommand(baseSha, record.argv[0]!, record.argv.slice(1),
      stateDir === undefined ? undefined : checkRunDir(stateDir, record.ticketId, record.runId))
    events.push({ seq: events.length, type: 'tool/call', data: { name: 'bash', callId: record.innerCallId, arguments: JSON.stringify({ command, workdir: record.cwd }) } })
    // A1-BIND branches on this structured value; A1-OUT re-hashes its stdout/stderr.
    events.push({ seq: events.length, type: 'tool/result', data: { message: { toolCallId: record.innerCallId, isError: false, content: [], value: foregroundValue() } } })
  }
  return { session: { id: sessionId }, inheritedEventCount: 0, events }
}

/** Contracts are validated by activation.ts, not by the verifier; this sets the fields the verifier reads. */
function bindingContract(contract: ActivationContract, requireSessionBinding: boolean): ActivationContract {
  return { ...contract, version: 3, evidence: { requireSessionBinding } }
}

// ---- A1-BIND / A1-OUT fixtures: synthetic Session snapshots, no real host ----
type SessionEvent = SessionSnapshot['events'][number]
type NativeValue = Record<string, unknown>
type JobRead = { chunks: { at: number; text: string }[]; lossy: boolean }

/** The structured value a successful fixture foreground bash result carries. */
function foregroundValue(over: NativeValue = {}): NativeValue {
  return {
    kind: 'foreground', cwd: '/work', exitCode: 0, signal: null, timedOut: false, aborted: false,
    stdout: { text: 'ok\n', truncated: false }, stderr: { text: '', truncated: false }, ...over,
  }
}
/** The structured value a promoted/background fixture bash result carries. */
function backgroundValue(jobId = 'job-1', over: NativeValue = {}): NativeValue {
  return { kind: 'background', jobId, ...over }
}
function callEvent(record: CheckRunRecord, contract: ActivationContract, seq: number,
  over: { command?: string; workdir?: string; callId?: string; name?: string } = {}): SessionEvent {
  const definition = contract.verification.checks.find(check => check.id === record.checkId)!
  return {
    seq, type: 'tool/call',
    data: {
      name: over.name ?? 'bash', callId: over.callId ?? record.innerCallId,
      arguments: JSON.stringify({
        command: over.command ?? checkCommand(contract.baseSha, definition.command, definition.args, runDirOf(contract, record)),
        workdir: over.workdir ?? record.cwd,
      }),
    },
  }
}
function resultEvent(record: CheckRunRecord, seq: number, value: unknown, over: { isError?: boolean } = {}): SessionEvent {
  return { seq, type: 'tool/result', data: { message: { toolCallId: record.innerCallId, isError: over.isError ?? false, content: [], value } } }
}
function snapshotOf(events: SessionEvent[], sessionId = 'worker-session', inheritedEventCount = 0): SessionSnapshot {
  return { session: { id: sessionId }, inheritedEventCount, events }
}
function nativeEvents(records: CheckRunRecord[], contract: ActivationContract,
  valueFor: (record: CheckRunRecord) => unknown = () => foregroundValue()): SessionEvent[] {
  const events: SessionEvent[] = []
  for (const record of records) {
    events.push(callEvent(record, contract, events.length))
    events.push(resultEvent(record, events.length, valueFor(record)))
  }
  return events
}
function bindingVerifier(stateDir: string, snapshot: SessionSnapshot, jobs?: NativeJobs) {
  return createEvidenceVerifier({ stateDir, readSession: async () => snapshot, requireSessionBinding: true, jobs })
}

/**
 * B2: a binding-effective ready report now also requires the host's four-way binding
 * record. These fixtures write the matching record so the historical A1-BIND/A1-OUT cases
 * keep their original expectation; the gate itself (missing/mismatched record, binding-off
 * zero regression) is covered by tests/control/binding-record.test.ts.
 */
async function writeBindingRecord(stateDir: string, contract: ActivationContract, over: {
  execution?: { kind: 'foreground'; exitCode: number; toolCallId: string }
    | { kind: 'background' | 'promoted'; jobId: string; toolCallId: string }
} = {}): Promise<void> {
  const records = await readRuns(stateDir, contract.ticketId)
  const record = [...records].reverse().find(item => item.status === 'passed' && item.exitCode === 0)
  if (record === undefined || record.before.headCommit === undefined) throw new Error('binding-record fixture: no accepted run with a HEAD commit')
  const execution = over.execution ?? { kind: 'foreground' as const, exitCode: 0, toolCallId: record.innerCallId }
  await mkdir(join(stateDir, 'binding'), { recursive: true })
  await writeFile(join(stateDir, 'binding', `${contract.ticketId}.json`), JSON.stringify({
    version: 1,
    producedAt: '2026-11-12T07:00:00Z',
    producer: 'evidence-verifier-fixture',
    ticket: { id: contract.ticketId },
    session: { id: 'worker-session' },
    execution,
    finalCommit: { sha: record.before.headCommit, baseSha: contract.baseSha },
  }))
}
function fakeJobs(over: { views?: Record<string, NativeJobView>; reads?: Record<string, JobRead>; getThrows?: boolean } = {}): NativeJobs {
  return {
    get: (id: string) => {
      if (over.getThrows) throw new Error('unknown Job')
      const view = over.views?.[id]
      if (!view) throw new Error('unknown Job')
      return view
    },
    wait: async () => { throw new Error('verifier must not wait for a Job') },
    readAt: (id: string) => {
      const read = over.reads?.[id]
      if (!read) throw new Error('Job output cleared')
      return read
    },
    kill: () => 'already-finished' as const,
  }
}
async function lastDecision(stateDir: string, ticketId: string): Promise<any> {
  const text = await readFile(join(stateDir, 'hephi', ticketId, 'decisions.jsonl'), 'utf8')
  return JSON.parse(text.trim().split('\n').at(-1)!)
}
function jobRegisteredEvent(record: CheckRunRecord, contract: ActivationContract, seq: number, over: {
  jobId?: string; owner?: string; command?: string; workdir?: string; withArguments?: boolean; rootCallId?: string; kind?: string
} = {}): SessionEvent {
  const definition = contract.verification.checks.find(check => check.id === record.checkId)!
  const command = over.command ?? checkCommand(contract.baseSha, definition.command, definition.args, runDirOf(contract, record))
  const data: any = {
    jobId: over.jobId ?? 'job-1', owner: over.owner ?? 'worker-session', kind: over.kind ?? 'bash',
    label: command, toolCall: { callId: record.innerCallId, rootCallId: over.rootCallId ?? record.callId },
  }
  if (over.withArguments) data.arguments = JSON.stringify({ command, workdir: over.workdir ?? record.cwd })
  return { seq, type: 'job/registered', data }
}
function jobSettledEvent(record: CheckRunRecord, seq: number, over: {
  jobId?: string; owner?: string; status?: string; detail?: string | null
} = {}): SessionEvent {
  return {
    seq, type: 'job/settled',
    data: {
      jobId: over.jobId ?? 'job-1', owner: over.owner ?? 'worker-session', kind: 'bash',
      toolCall: { callId: record.innerCallId, rootCallId: record.callId },
      status: over.status ?? 'completed',
      ...(over.detail === null ? {} : { detail: over.detail ?? 'exit code: 0' }),
    },
  }
}
function jobEvents(record: CheckRunRecord, contract: ActivationContract, over: {
  registered?: Parameters<typeof jobRegisteredEvent>[3]; settled?: Parameters<typeof jobSettledEvent>[2]
} = {}): SessionEvent[] {
  return [jobRegisteredEvent(record, contract, 0, over.registered), jobSettledEvent(record, 1, over.settled)]
}

/** A single-check contract with one build record converted into a completed/cleared background Job. */
async function backgroundFixture(jobOutput = 'job output\n') {
  const x = await setup(); await x.execute('build'); await x.execute('unit')
  const c: ActivationContract = { ...x.c, verification: { version: 1, checks: [build] } }
  const target = (await readRuns(x.stateDir, x.c.ticketId)).find(record => record.checkId === 'build')!
  const record: CheckRunRecord = { ...target, jobId: 'job-1', exitCode: 0, outputHash: sha256(jobOutput) }
  const dir = checkRunDir(x.stateDir, x.c.ticketId, target.runId)
  await writeFile(join(dir, 'output.log'), jobOutput)
  await writeFile(join(dir, 'run.json'), JSON.stringify(record))
  return { x, c, record, jobOutput }
}

function nativeTools(exitCode = 0) {
  return {
    execute: async (input: any) => {
      return {
        isError: false as const, content: [],
        value: {
          kind: 'foreground', cwd: '/work', exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1000,
          stdout: { text: 'ok\n', truncated: false }, stderr: { text: '', truncated: false },
        },
      }
    },
  }
}

// Focused integration tests: real Git and filesystem; native tool results are fixtures.
// These do not prove a DSH Worker or GitHub end-to-end delivery.
const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
async function setup() {
  const r = await repo(); const stateDir = await mkdtemp(join(tmpdir(), 'hephi-lean-'))
  cleanup.push(r.dir, stateDir)
  const c = contract(r.dir, r.baseSha)
  registerStateDir(c, stateDir)
  const execute = (checkId: string, tools = nativeTools()) =>
    runCheck({ stateDir, contract: c, checkId, outer: outer(checkId), tools })
  const verify = () => createEvidenceVerifier({ stateDir })(c, ready(r.dir))
  return { r, stateDir, c, execute, verify }
}
describe('synchronous evidence MVP (fixture integration)', () => {
  it('uses standard recursive globs for root, nested, Chinese and spaced paths', () => {
    for (const file of ['foo.ts', 'src/foo.ts', '目录/有 空格.ts']) expect(allowedPath(file, ['**/*.ts'])).toBe(true)
    expect(allowedPath('src/foo.js', ['**/*.ts'])).toBe(false)
    expect(allowedPath('outside.ts', ['src/**'])).toBe(false)
  })
  it('requires successful exit in recorded evidence', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    const record = (await readRuns(x.stateDir, x.c.ticketId)).at(-1)!
    const file = join(checkRunDir(x.stateDir, x.c.ticketId, record.runId), 'run.json')
    await writeFile(file, JSON.stringify({ ...record, exitCode: 1 }))
    expect((await x.verify()).ok).toBe(false)
    await writeFile(file, JSON.stringify(record))
    expect(await x.verify()).toEqual({ ok: true })
  })
  it('requires each frozen check and accepts bound evidence without executing tests at ready', async () => {
    const x = await setup()
    expect((await x.verify()).ok).toBe(false)
    expect((await x.execute('build')).status).toBe('passed')
    expect((await x.verify()).ok).toBe(false)
    expect((await x.execute('unit')).status).toBe('passed')
    expect(await x.verify()).toEqual({ ok: true })
    const records = await readRuns(x.stateDir, x.c.ticketId)
    expect(records.map(r => r.sequence)).toEqual([1, 2])
    await writeFile(join(checkRunDir(x.stateDir, x.c.ticketId, records[1]!.runId), 'output.log'), 'tampered')
    expect((await x.verify()).ok).toBe(false)
  })
  it('rejects changed source, contract and PR head', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    x.c.contractHash = 'changed'; expect((await x.verify()).ok).toBe(false); x.c.contractHash = 'sha256:test'
    x.c.requirePullRequest = true
    const verify = createEvidenceVerifier({ stateDir: x.stateDir, pullRequest: async () => ({ state: 'open', baseRef: 'main', headSha: 'wrong' }) })
    expect((await verify(x.c, ready(x.r.dir, 1))).ok).toBe(false)
    x.c.requirePullRequest = false
    await writeFile(join(x.r.dir, 'a.txt'), 'later change')
    expect((await x.verify()).ok).toBe(false)
  })
  it('blocks nonzero exits and preserves failures across retries', async () => {
    const x = await setup(); await x.execute('build')
    for (const [i, code] of [1, 2, 127].entries()) {
      expect((await x.execute('unit', nativeTools(code))).status).toBe('blocked')
      expect((await x.verify()).ok).toBe(false)
      expect((await x.execute('unit')).status).toBe('passed')
      expect(await x.verify()).toEqual({ ok: true })
      expect(await readRuns(x.stateDir, x.c.ticketId)).toHaveLength(3 + i * 2)
    }
  })
  it('does not use an earlier pass after a later failing check', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    await x.execute('unit', nativeTools(1))
    expect((await x.verify()).ok).toBe(false)
  })
  it('records a real foreground project command failure and retry without XML (local integration)', async () => {
    const x = await setup()
    const check = x.c.verification.checks[1]!
    check.command = process.execPath
    check.args = ['-e', 'require("node:assert/strict").equal(require("node:fs").readFileSync("a.txt", "utf8"), process.env.EXPECTED)']
    const realTools = (expected: string) => ({ execute: async (input: any) => {
      let exitCode = 0, stdout = '', stderr = ''
      try {
        const result = await run('sh', ['-c', input.arguments.command], {
          cwd: input.arguments.workdir, env: { ...process.env, EXPECTED: expected }, timeout: 5000,
        })
        stdout = result.stdout; stderr = result.stderr
      } catch (error: any) {
        if (!Number.isInteger(error.code)) throw error
        exitCode = error.code; stdout = error.stdout; stderr = error.stderr
      }
      return { isError: false as const, content: [], value: { kind: 'foreground', exitCode, stdout: { text: stdout }, stderr: { text: stderr } } }
    } })
    await x.execute('build')
    expect((await x.execute('unit', realTools('wrong') as never)).status).toBe('blocked')
    expect((await x.verify()).ok).toBe(false)
    expect((await x.execute('unit', realTools('patched\n') as never)).status).toBe('passed')
    expect(await x.verify()).toEqual({ ok: true })
    expect((await readRuns(x.stateDir, x.c.ticketId)).map(r => r.status)).toEqual(['passed', 'blocked', 'passed'])
  })
  it('blocks background or uncertain execution without claiming completion', async () => {
    const x = await setup()
    const tools = { execute: async () => ({ isError: false, content: [], value: { kind: 'background', jobId: 'job-1' } }) }
    expect((await x.execute('build', tools as never)).status).toBe('unknown')
    await expect(x.execute('build')).rejects.toThrow('operator resolution')
    expect((await x.verify()).ok).toBe(false)
  })

  it('A3: an enabled operator resolution unblocks re-runs but never turns the old unknown run into passing evidence', async () => {
    const x = await setup()
    const tools = { execute: async () => ({ isError: false, content: [], value: { kind: 'background', jobId: 'job-1' } }) }
    expect((await x.execute('build', tools as never)).status).toBe('unknown')
    const unknown = (await readRuns(x.stateDir, x.c.ticketId)).at(-1)!
    const blocked = await createEvidenceVerifier({ stateDir: x.stateDir })(x.c, ready(x.r.dir))
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.reason).toContain('operator resolution')
    const appended = await appendResolution(x.stateDir, {
      ticketId: x.c.ticketId, contractHash: x.c.contractHash, runId: unknown.runId,
      basis: 'host-terminal', hostQuery: 'ps: pid gone', operator: 'operator@example.invalid',
    })
    expect(appended.appended).toBe(true)
    // The resolution only restores the right to re-run: the unfinished record is still not evidence.
    const stillNotEvidence = await createEvidenceVerifier({ stateDir: x.stateDir, allowOperatorResolutions: true })(x.c, ready(x.r.dir))
    expect(stillNotEvidence.ok).toBe(false)
    if (!stillNotEvidence.ok) expect(stillNotEvidence.reason).toContain('missing, failed or stale evidence')
    const rerun = (checkId: string) => runCheck({
      stateDir: x.stateDir, contract: x.c, checkId, outer: outer(checkId), tools: nativeTools(), allowOperatorResolutions: true,
    })
    expect((await rerun('build')).status).toBe('passed')
    expect((await rerun('unit')).status).toBe('passed')
    expect(await createEvidenceVerifier({ stateDir: x.stateDir, allowOperatorResolutions: true })(x.c, ready(x.r.dir))).toEqual({ ok: true })
  })

  it('rejects evidence whose recorded argv differs from the frozen check', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    const record = (await readRuns(x.stateDir, x.c.ticketId)).at(-1)!
    const file = join(checkRunDir(x.stateDir, x.c.ticketId, record.runId), 'run.json')
    await writeFile(file, JSON.stringify({ ...record, argv: [...record.argv, '--skip-required-assertion'] }))
    expect((await x.verify()).ok).toBe(false)
    await writeFile(file, JSON.stringify(record))
    expect(await x.verify()).toEqual({ ok: true })
  })
  it('rejects evidence whose recorded cwd differs from the frozen check directory', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    const record = (await readRuns(x.stateDir, x.c.ticketId)).at(-1)!
    const file = join(checkRunDir(x.stateDir, x.c.ticketId, record.runId), 'run.json')
    await writeFile(file, JSON.stringify({ ...record, cwd: tmpdir() }))
    expect((await x.verify()).ok).toBe(false)
  })


  it('rejects evidence recorded by another plugin build and delivers again after a rerun', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    const record = (await readRuns(x.stateDir, x.c.ticketId)).at(-1)!
    const file = join(checkRunDir(x.stateDir, x.c.ticketId, record.runId), 'run.json')
    await writeFile(file, JSON.stringify({ ...record, pluginCommit: 'another-build' }))
    expect((await x.verify()).ok).toBe(false)
    await writeFile(file, JSON.stringify(record))
    expect(await x.verify()).toEqual({ ok: true })
  })
  it('rejects a contract frozen by another plugin build', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    const original = x.c.plugin
    x.c.plugin = { version: '0.1.0', commit: 'another-build' }
    expect((await x.verify()).ok).toBe(false)
    x.c.plugin = original
    expect(await x.verify()).toEqual({ ok: true })
  })
  it('refuses check records written before plugin commit tracking', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    const record = (await readRuns(x.stateDir, x.c.ticketId)).at(-1)!
    const file = join(checkRunDir(x.stateDir, x.c.ticketId, record.runId), 'run.json')
    await writeFile(file, JSON.stringify({ ...record, version: 2 }))
    await expect(readRuns(x.stateDir, x.c.ticketId)).rejects.toThrow('unsupported or corrupt check evidence')
  })


  it('U-K5-04: a contract requirement is enforced even when the host configuration is off', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    const contract = bindingContract(x.c, true)
    // Without a Session reader the frozen requirement cannot be satisfied.
    expect(await createEvidenceVerifier({ stateDir: x.stateDir })(contract, ready(x.r.dir, undefined, 'worker-session')))
      .toMatchObject({ ok: false, reason: expect.stringContaining('requires a Session reader') })
    // With a reader but no native call in the Session it is still refused.
    const records = await readRuns(x.stateDir, contract.ticketId)
    const empty: SessionSnapshot = { session: { id: 'worker-session' }, inheritedEventCount: 0, events: [] }
    expect(await createEvidenceVerifier({ stateDir: x.stateDir, readSession: async () => empty })(contract, ready(x.r.dir, undefined, 'worker-session')))
      .toMatchObject({ ok: false, reason: expect.stringContaining('expected one native call') })
    // Legal: the native calls exist and the Session ids agree. B2 is part of a binding-on deployment.
    await writeBindingRecord(x.stateDir, contract)
    const verify = createEvidenceVerifier({ stateDir: x.stateDir, readSession: async () => boundSnapshot('worker-session', records, contract.baseSha) })
    expect(await verify(contract, ready(x.r.dir, undefined, 'worker-session'))).toEqual({ ok: true })
  })

  it('U-K5-05: the host configuration can tighten a contract that leaves binding off, never relax it', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    const records = await readRuns(x.stateDir, x.c.ticketId)
    const empty: SessionSnapshot = { session: { id: 'worker-session' }, inheritedEventCount: 0, events: [] }
    const relaxed = bindingContract(x.c, false)
    // host on + no native call -> refused (host tightened the contract)
    expect(await createEvidenceVerifier({ stateDir: x.stateDir, readSession: async () => empty, requireSessionBinding: true })(relaxed, ready(x.r.dir, undefined, 'worker-session')))
      .toMatchObject({ ok: false })
    // host on + native calls -> allowed (B2 binding record included)
    await writeBindingRecord(x.stateDir, relaxed)
    expect(await createEvidenceVerifier({ stateDir: x.stateDir, readSession: async () => boundSnapshot('worker-session', records, relaxed.baseSha), requireSessionBinding: true })(relaxed, ready(x.r.dir, undefined, 'worker-session')))
      .toEqual({ ok: true })
    // contract on + host off is still refused (host cannot relax the contract)
    expect(await createEvidenceVerifier({ stateDir: x.stateDir, readSession: async () => empty })(bindingContract(x.c, true), ready(x.r.dir, undefined, 'worker-session')))
      .toMatchObject({ ok: false })
  })

  it('U-K4-01: a check record written by another Worker Session is rejected with binding on or off', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    const records = await readRuns(x.stateDir, x.c.ticketId)
    // Binding off (default): no Session reader is involved, the record's own sessionId is enough.
    expect(await createEvidenceVerifier({ stateDir: x.stateDir })(x.c, ready(x.r.dir, undefined, 'other-session')))
      .toMatchObject({ ok: false, reason: expect.stringContaining('check record belongs to Session') })
    // Binding on: the snapshot claims to be the ready Session, so only the record's
    // sessionId can expose that the evidence came from another Worker Session.
    const verify = createEvidenceVerifier({ stateDir: x.stateDir, readSession: async id => boundSnapshot(id, records, x.c.baseSha), requireSessionBinding: true })
    expect(await verify(x.c, ready(x.r.dir, undefined, 'other-session')))
      .toMatchObject({ ok: false, reason: expect.stringContaining('check record belongs to Session') })
    // A ready report without a Worker Session id cannot prove ownership: fail closed.
    expect(await createEvidenceVerifier({ stateDir: x.stateDir })(x.c, ready(x.r.dir, undefined, '')))
      .toMatchObject({ ok: false, reason: expect.stringContaining('no Worker Session') })
  })

  it('U-K4-02: evidence recorded by the same Worker Session passes with binding on or off', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    const records = await readRuns(x.stateDir, x.c.ticketId)
    // Binding off: the matching record sessionId is the only requirement.
    expect(await createEvidenceVerifier({ stateDir: x.stateDir })(x.c, ready(x.r.dir))).toEqual({ ok: true })
    // Binding on: the native call/result and the B2 binding record must also be present.
    await writeBindingRecord(x.stateDir, x.c)
    const verify = createEvidenceVerifier({ stateDir: x.stateDir, readSession: async id => boundSnapshot(id, records, x.c.baseSha), requireSessionBinding: true })
    expect(await verify(x.c, ready(x.r.dir, undefined, 'worker-session'))).toEqual({ ok: true })
  })

  it('U-K5-06: ready decisions record the real binding policy in the decision log', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    const file = join(x.stateDir, 'hephi', x.c.ticketId, 'decisions.jsonl')
    const last = async () => JSON.parse((await readFile(file, 'utf8')).trim().split('\n').at(-1)!)
    // v1/v2 contract (no frozen value) with host off: contract=null, effective=false.
    expect((await x.verify()).ok).toBe(true)
    expect(await last()).toMatchObject({ version: 1, binding: { contract: null, host: false, effective: false } })
    // v3 contract requiring binding while host is off: effective=true, logged as such.
    expect((await createEvidenceVerifier({ stateDir: x.stateDir })(bindingContract(x.c, true), ready(x.r.dir, undefined, 'worker-session'))).ok).toBe(false)
    expect(await last()).toMatchObject({ version: 1, binding: { contract: true, host: false, effective: true }, effectiveDecision: 'deny' })
    // v3 contract leaving binding off while host is on: effective=true.
    expect((await createEvidenceVerifier({ stateDir: x.stateDir, readSession: async () => ({ session: { id: 'worker-session' }, inheritedEventCount: 0, events: [] }), requireSessionBinding: true })(bindingContract(x.c, false), ready(x.r.dir, undefined, 'worker-session'))).ok).toBe(false)
    expect(await last()).toMatchObject({ binding: { contract: false, host: true, effective: true } })
  })

  it('records ready decisions in the per-ticket decision log', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    expect((await x.verify()).ok).toBe(true)
    const file = join(x.stateDir, 'hephi', x.c.ticketId, 'decisions.jsonl')
    const read = async () => (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const passed = (await read()).at(-1)
    expect(passed).toMatchObject({ version: 1, tool: 'orchestrator_report', rule: 'ready.pass', effectiveDecision: 'allow', wouldDecision: 'allow', mode: 'enforce' })
    await writeFile(join(x.r.dir, 'a.txt'), 'later change')
    expect((await x.verify()).ok).toBe(false)
    const denied = (await read()).at(-1)
    expect(denied).toMatchObject({ tool: 'orchestrator_report', effectiveDecision: 'deny', wouldDecision: 'deny' })
    expect(denied.rule).toMatch(/^ready\./)
    expect(denied.seq).toBe((await read()).at(-2).seq + 1)
  })

})

// ---------------------------------------------------------------------------------------
// A1-BIND / A1-OUT: fixture Session snapshots (no real host). The expected command and
// directory come from the frozen contract; the branch comes from the structured Session
// result value; the authoritative output must match record.outputHash.
// H1-H5 host encodings are still unverified: these tests pin the planned shapes only.
// ---------------------------------------------------------------------------------------
describe('A1-BIND: the Session must prove the native execution', () => {
  it('U-BIND-F1: a legal foreground execution matching the frozen check passes', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    const records = await readRuns(x.stateDir, x.c.ticketId)
    await writeBindingRecord(x.stateDir, x.c)
    expect(await bindingVerifier(x.stateDir, snapshotOf(nativeEvents(records, x.c)))(x.c, ready(x.r.dir))).toEqual({ ok: true })
  })

  it('U-BIND-F2: a Session call that ran a different command is rejected', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    const records = await readRuns(x.stateDir, x.c.ticketId)
    const events = nativeEvents(records, x.c)
    events[0] = { ...callEvent(records[0]!, x.c, events[0]!.seq, { command: 'true' }) }
    expect(await bindingVerifier(x.stateDir, snapshotOf(events))(x.c, ready(x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('different command or directory') })
  })

  it('U-BIND-F3: a Session call that ran in a different directory is rejected', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    const records = await readRuns(x.stateDir, x.c.ticketId)
    const events = nativeEvents(records, x.c)
    events[0] = { ...callEvent(records[0]!, x.c, events[0]!.seq, { workdir: tmpdir() }) }
    expect(await bindingVerifier(x.stateDir, snapshotOf(events))(x.c, ready(x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('different command or directory') })
  })

  it('U-BIND-F4: a foreground result without a confirmed clean exit is rejected', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    const records = await readRuns(x.stateDir, x.c.ticketId)
    const verifyValue = async (valueFor: (record: CheckRunRecord) => unknown) =>
      bindingVerifier(x.stateDir, snapshotOf(nativeEvents(records, x.c, valueFor)))(x.c, ready(x.r.dir))
    expect(await verifyValue(() => foregroundValue({ exitCode: 1 })))
      .toMatchObject({ ok: false, reason: expect.stringContaining('exit code 1 differs from the record') })
    expect(await verifyValue(() => foregroundValue({ timedOut: true })))
      .toMatchObject({ ok: false, reason: expect.stringContaining('cancelled or timed out') })
    expect(await verifyValue(() => foregroundValue({ aborted: true })))
      .toMatchObject({ ok: false, reason: expect.stringContaining('cancelled or timed out') })
    expect(await verifyValue(() => foregroundValue({ signal: 'SIGTERM' })))
      .toMatchObject({ ok: false, reason: expect.stringContaining('cancelled or timed out') })
    // A foreground result cannot back a record that names a Job.
    const bg = await backgroundFixture()
    expect(await bindingVerifier(bg.x.stateDir, snapshotOf(nativeEvents([bg.record], bg.c, () => foregroundValue())))(bg.c, ready(bg.x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('names a Job') })
  })

  it('U-BIND-B1: a promoted Job completed with exit code 0 is bound', async () => {
    const { x, c, record, jobOutput } = await backgroundFixture()
    const events = [callEvent(record, c, 0), resultEvent(record, 1, { kind: 'promoted', jobId: 'job-1' })]
    const jobs = fakeJobs({
      views: { 'job-1': { status: 'completed', detail: 'exit code: 0; 1.2s' } },
      reads: { 'job-1': { chunks: [{ at: 0, text: jobOutput }], lossy: false } },
    })
    await writeBindingRecord(x.stateDir, c, { execution: { kind: 'promoted', jobId: 'job-1', toolCallId: record.innerCallId } })
    expect(await bindingVerifier(x.stateDir, snapshotOf(events), jobs)(c, ready(x.r.dir))).toEqual({ ok: true })
  })

  it('U-BIND-B2: a background Job completed with exit code 0 is bound', async () => {
    const { x, c, record, jobOutput } = await backgroundFixture()
    const events = [callEvent(record, c, 0), resultEvent(record, 1, backgroundValue())]
    const jobs = fakeJobs({
      views: { 'job-1': { status: 'completed', detail: 'exit code: 0' } },
      reads: { 'job-1': { chunks: [{ at: 0, text: jobOutput }], lossy: false } },
    })
    await writeBindingRecord(x.stateDir, c, { execution: { kind: 'background', jobId: 'job-1', toolCallId: record.innerCallId } })
    expect(await bindingVerifier(x.stateDir, snapshotOf(events), jobs)(c, ready(x.r.dir))).toEqual({ ok: true })
  })

  it('U-BIND-B3: a Session Job id that differs from the record is rejected', async () => {
    const { x, c, record } = await backgroundFixture()
    const events = [callEvent(record, c, 0), resultEvent(record, 1, backgroundValue('job-2'))]
    expect(await bindingVerifier(x.stateDir, snapshotOf(events), fakeJobs())(c, ready(x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('differs from the recorded Job') })
  })

  it('U-BIND-B4: a Job cleared before ready is rejected and logged as ready.job-unavailable', async () => {
    const { x, c, record } = await backgroundFixture()
    const events = [callEvent(record, c, 0), resultEvent(record, 1, backgroundValue())]
    expect(await bindingVerifier(x.stateDir, snapshotOf(events), fakeJobs({ getThrows: true }))(c, ready(x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('Job terminal state is unavailable') })
    expect((await lastDecision(x.stateDir, c.ticketId)).rule).toBe('ready.job-unavailable')
  })

  it('U-BIND-B5: a host without a Job registry rejects background evidence as ready.job-unavailable', async () => {
    const { x, c, record } = await backgroundFixture()
    const events = [callEvent(record, c, 0), resultEvent(record, 1, backgroundValue())]
    expect(await bindingVerifier(x.stateDir, snapshotOf(events), undefined)(c, ready(x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('host Job registry is not mounted') })
    expect((await lastDecision(x.stateDir, c.ticketId)).rule).toBe('ready.job-unavailable')
  })

  it('U-BIND-B6: a Job that terminated with a non-completed status is rejected', async () => {
    const { x, c, record } = await backgroundFixture()
    const events = [callEvent(record, c, 0), resultEvent(record, 1, backgroundValue())]
    const jobs = fakeJobs({ views: { 'job-1': { status: 'failed', detail: 'exit code: 1' } } })
    expect(await bindingVerifier(x.stateDir, snapshotOf(events), jobs)(c, ready(x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('terminal status is failed') })
  })

  it('U-BIND-B7: a completed Job without the documented exit-code detail is rejected', async () => {
    const { x, c, record } = await backgroundFixture()
    const events = [callEvent(record, c, 0), resultEvent(record, 1, backgroundValue())]
    const jobs = fakeJobs({ views: { 'job-1': { status: 'completed', detail: 'done' } } })
    expect(await bindingVerifier(x.stateDir, snapshotOf(events), jobs)(c, ready(x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('not the documented exit-code form') })
  })

  it('U-BIND-B8: a Job exit code that is not 0 is rejected', async () => {
    const { x, c, record } = await backgroundFixture()
    const events = [callEvent(record, c, 0), resultEvent(record, 1, backgroundValue())]
    const jobs = fakeJobs({ views: { 'job-1': { status: 'completed', detail: 'exit code: 1' } } })
    expect(await bindingVerifier(x.stateDir, snapshotOf(events), jobs)(c, ready(x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('does not confirm a successful check') })
  })

  it('U-BIND-B9: a background Session result cannot back a record without a Job id', async () => {
    const { x, c, record } = await backgroundFixture()
    const dir = checkRunDir(x.stateDir, c.ticketId, record.runId)
    const noJob: CheckRunRecord = { ...record }
    delete noJob.jobId
    await writeFile(join(dir, 'run.json'), JSON.stringify(noJob))
    const events = [callEvent(record, c, 0), resultEvent(record, 1, backgroundValue())]
    expect(await bindingVerifier(x.stateDir, snapshotOf(events), fakeJobs())(c, ready(x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('record names no Job') })
  })

  it('U-BIND-X1: a native call inherited from a parent Session is not evidence', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    const records = await readRuns(x.stateDir, x.c.ticketId)
    const events = nativeEvents(records, x.c)
    expect(await bindingVerifier(x.stateDir, snapshotOf(events, 'worker-session', events.length))(x.c, ready(x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('found 0') })
  })
})

describe('A1-OUT: authoritative output hash', () => {
  it('U-OUT-01: foreground authoritative output matches record.outputHash and output.log', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    const records = await readRuns(x.stateDir, x.c.ticketId)
    await writeBindingRecord(x.stateDir, x.c)
    expect(await bindingVerifier(x.stateDir, snapshotOf(nativeEvents(records, x.c)))(x.c, ready(x.r.dir))).toEqual({ ok: true })
  })

  it('U-OUT-02: Session output that differs from the record is rejected as ready.output-unverified', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    const records = await readRuns(x.stateDir, x.c.ticketId)
    const events = nativeEvents(records, x.c, () => foregroundValue({ stdout: { text: 'tampered\n', truncated: false } }))
    expect(await bindingVerifier(x.stateDir, snapshotOf(events))(x.c, ready(x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('authoritative check output differs') })
    expect((await lastDecision(x.stateDir, x.c.ticketId)).rule).toBe('ready.output-unverified')
    // Contract boundary: binding off keeps only output.log <-> record.outputHash (unchanged).
    expect(await createEvidenceVerifier({ stateDir: x.stateDir })(x.c, ready(x.r.dir))).toEqual({ ok: true })
  })

  it('U-OUT-03: truncated foreground output cannot be verified and is rejected', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    const records = await readRuns(x.stateDir, x.c.ticketId)
    const events = nativeEvents(records, x.c, () => foregroundValue({ stdout: { text: 'ok\n', truncated: true } }))
    expect(await bindingVerifier(x.stateDir, snapshotOf(events))(x.c, ready(x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('authoritative check output is unavailable') })
    expect((await lastDecision(x.stateDir, x.c.ticketId)).rule).toBe('ready.output-unverified')
  })

  it('U-OUT-04: lossy or cleared Job output cannot be verified and is rejected', async () => {
    const { x, c, record, jobOutput } = await backgroundFixture()
    const events = [callEvent(record, c, 0), resultEvent(record, 1, backgroundValue())]
    const lossy = fakeJobs({
      views: { 'job-1': { status: 'completed', detail: 'exit code: 0' } },
      reads: { 'job-1': { chunks: [{ at: 0, text: jobOutput }], lossy: true } },
    })
    expect(await bindingVerifier(x.stateDir, snapshotOf(events), lossy)(c, ready(x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('output was lost (lossy)') })
    expect((await lastDecision(x.stateDir, c.ticketId)).rule).toBe('ready.output-unverified')
    // Cleared Job output (readAt throws) is equally unverifiable.
    const cleared = fakeJobs({ views: { 'job-1': { status: 'completed', detail: 'exit code: 0' } } })
    expect(await bindingVerifier(x.stateDir, snapshotOf(events), cleared)(c, ready(x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('output is not readable') })
    expect((await lastDecision(x.stateDir, c.ticketId)).rule).toBe('ready.output-unverified')
  })
})

// ---------------------------------------------------------------------------------------
// B2 four-way record strictness (Kimi execution review B-1/B-2). The record must name the
// native **inner** bash call (the outer hephi_check call id is not native evidence), and its
// execution kind must equal the Session's native result kind; background and promoted are
// never merged (an unavailable native kind is fail-closed).
// ---------------------------------------------------------------------------------------
describe('B2 binding record: B-1/B-2 strictness (fixture integration)', () => {
  it('B-1: a record naming the outer hephi_check call id is denied', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    const records = await readRuns(x.stateDir, x.c.ticketId)
    await writeBindingRecord(x.stateDir, x.c, { execution: { kind: 'foreground', exitCode: 0, toolCallId: records[0]!.callId } })
    const result = await bindingVerifier(x.stateDir, snapshotOf(nativeEvents(records, x.c)))(x.c, ready(x.r.dir))
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('outer hephi_check call id') })
    expect((await lastDecision(x.stateDir, x.c.ticketId)).rule).toBe('ready.binding-record')
  })

  it('B-1: a record whose inner call id has no native Session tool/call is denied', async () => {
    // setup() runs both frozen checks; the Session below keeps only the build execution.
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    const records = await readRuns(x.stateDir, x.c.ticketId)
    const build = records.find(record => record.checkId === 'build')!
    await writeBindingRecord(x.stateDir, x.c, { execution: { kind: 'foreground', exitCode: 0, toolCallId: build.innerCallId } })
    const result = await bindingVerifier(x.stateDir, snapshotOf(nativeEvents([build], x.c)))(x.c, ready(x.r.dir))
    // A1-BIND refuses the missing native call before the B2 gate can be reached; still a deny.
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toContain('no native evidence')
  })

  it('B-2: a promoted record against a background native result is denied', async () => {
    const { x, c, record, jobOutput } = await backgroundFixture()
    const events = [callEvent(record, c, 0), resultEvent(record, 1, backgroundValue())]
    const jobs = fakeJobs({
      views: { 'job-1': { status: 'completed', detail: 'exit code: 0' } },
      reads: { 'job-1': { chunks: [{ at: 0, text: jobOutput }], lossy: false } },
    })
    await writeBindingRecord(x.stateDir, c, { execution: { kind: 'promoted', jobId: 'job-1', toolCallId: record.innerCallId } })
    const result = await bindingVerifier(x.stateDir, snapshotOf(events), jobs)(c, ready(x.r.dir))
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('disagrees with the native Session result kind') })
    expect((await lastDecision(x.stateDir, c.ticketId)).rule).toBe('ready.binding-record')
  })

  it('B-2: a background record against a promoted native result is denied', async () => {
    const { x, c, record, jobOutput } = await backgroundFixture()
    const events = [callEvent(record, c, 0), resultEvent(record, 1, { kind: 'promoted', jobId: 'job-1' })]
    const jobs = fakeJobs({
      views: { 'job-1': { status: 'completed', detail: 'exit code: 0' } },
      reads: { 'job-1': { chunks: [{ at: 0, text: jobOutput }], lossy: false } },
    })
    await writeBindingRecord(x.stateDir, c, { execution: { kind: 'background', jobId: 'job-1', toolCallId: record.innerCallId } })
    const result = await bindingVerifier(x.stateDir, snapshotOf(events), jobs)(c, ready(x.r.dir))
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('disagrees with the native Session result kind') })
    expect((await lastDecision(x.stateDir, c.ticketId)).rule).toBe('ready.binding-record')
  })
})

// ---------------------------------------------------------------------------------------
// Path B: the historical real-host shape (A2 Round 2 observations). The internal dispatch
// leaves job/registered (toolCall.callId=innerCallId, rootCallId=outer) and job/settled
// (textual `exit code: N`) but no tool/call, tool/result or structured message.value.
// Shape assumptions are pending the current-candidate host probe (H1/H2/H3).
// ---------------------------------------------------------------------------------------
describe('A1-BIND path B: job/registered + job/settled evidence', () => {
  it('U-BIND-J1: a background Job binds through the real-host Job events (workdir absent is noted, not guessed)', async () => {
    const { x, c, record, jobOutput } = await backgroundFixture()
    const events = jobEvents(record, c)
    const jobs = fakeJobs({
      views: { 'job-1': { status: 'completed', detail: 'exit code: 0' } },
      reads: { 'job-1': { chunks: [{ at: 0, text: jobOutput }], lossy: false } },
    })
    const snapshot = snapshotOf(events)
    // A1-BIND still binds the real-host path-B execution.
    expect(await sessionBindingProblem(snapshot, 'worker-session', c, record, { stateDir: x.stateDir, workspace: x.r.dir, jobs })).toBeUndefined()
    await writeBindingRecord(x.stateDir, c, { execution: { kind: 'background', jobId: 'job-1', toolCallId: record.innerCallId } })
    // B2 (Kimi B-2): path-B job events cannot prove background vs promoted, so a binding-on
    // ready report is fail-closed instead of merging the two kinds.
    expect(await bindingVerifier(x.stateDir, snapshot, jobs)(c, ready(x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('native Session result kind') })
  })

  it('U-BIND-J2: a Job whose raw arguments carry a matching workdir also binds', async () => {
    const { x, c, record, jobOutput } = await backgroundFixture()
    const events = jobEvents(record, c, { registered: { withArguments: true } })
    const jobs = fakeJobs({
      views: { 'job-1': { status: 'completed', detail: 'exit code: 0' } },
      reads: { 'job-1': { chunks: [{ at: 0, text: jobOutput }], lossy: false } },
    })
    const snapshot = snapshotOf(events)
    expect(await sessionBindingProblem(snapshot, 'worker-session', c, record, { stateDir: x.stateDir, workspace: x.r.dir, jobs })).toBeUndefined()
    await writeBindingRecord(x.stateDir, c, { execution: { kind: 'background', jobId: 'job-1', toolCallId: record.innerCallId } })
    expect(await bindingVerifier(x.stateDir, snapshot, jobs)(c, ready(x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('native Session result kind') })
  })

  it('U-BIND-J3: a Job id in the Session events that differs from the record is rejected', async () => {
    const { x, c, record } = await backgroundFixture()
    const events = jobEvents(record, c, { registered: { jobId: 'job-2' }, settled: { jobId: 'job-2' } })
    expect(await bindingVerifier(x.stateDir, snapshotOf(events), fakeJobs())(c, ready(x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('differs from the recorded Job') })
  })

  it('U-BIND-J4: Job events owned by another Session are rejected', async () => {
    const { x, c, record } = await backgroundFixture()
    const events = jobEvents(record, c, { registered: { owner: 'other-session' }, settled: { owner: 'other-session' } })
    expect(await bindingVerifier(x.stateDir, snapshotOf(events), fakeJobs())(c, ready(x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('another Session') })
  })

  it('U-BIND-J5: a job/settled exit code that differs from the record is rejected', async () => {
    const { x, c, record } = await backgroundFixture()
    const events = jobEvents(record, c, { settled: { detail: 'exit code: 1' } })
    expect(await bindingVerifier(x.stateDir, snapshotOf(events), fakeJobs())(c, ready(x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('exit code 1 differs from the record') })
  })

  it('U-BIND-J6: a job/settled without a parseable exit code is rejected', async () => {
    const { x, c, record } = await backgroundFixture()
    const events = jobEvents(record, c, { settled: { detail: null } })
    expect(await bindingVerifier(x.stateDir, snapshotOf(events), fakeJobs())(c, ready(x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('not the documented exit-code form') })
  })

  it('U-BIND-J7: structured evidence and Job events present at once are rejected as ambiguous', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    const records = await readRuns(x.stateDir, x.c.ticketId)
    const events = [...nativeEvents(records, x.c), ...jobEvents(records[0]!, x.c)]
    expect(await bindingVerifier(x.stateDir, snapshotOf(events))(x.c, ready(x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('both structured tool/result evidence and job/registered+job/settled evidence') })
  })

  it('U-BIND-J8: missing workdir is annotated but a mismatched command still fails', async () => {
    const { x, c, record } = await backgroundFixture()
    const events = jobEvents(record, c, { registered: { command: 'true' } })
    expect(await bindingVerifier(x.stateDir, snapshotOf(events), fakeJobs())(c, ready(x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/different command.*workdir: absent/) })
  })

  it('U-BIND-J9: a foreground record can only produce ready.output-unverified on path B (no structured output)', async () => {
    const x = await setup(); await x.execute('build'); await x.execute('unit')
    const c: ActivationContract = { ...x.c, verification: { version: 1, checks: [build] } }
    const record = (await readRuns(x.stateDir, x.c.ticketId)).find(item => item.checkId === 'build')!
    const events = jobEvents(record, c)
    const result = await bindingVerifier(x.stateDir, snapshotOf(events), fakeJobs())(c, ready(x.r.dir))
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('authoritative check output is unavailable') })
    // The foreground record names no Job, so no structured stdout/stderr can be trusted; the
    // denial is categorised as unverified output, and the absent workdir is still surfaced.
    expect(result).toMatchObject({ reason: expect.stringContaining('workdir: absent') })
    expect((await lastDecision(x.stateDir, c.ticketId)).rule).toBe('ready.output-unverified')
  })

  it('U-BIND-J10: a non-completed job/settled status is rejected', async () => {
    const { x, c, record } = await backgroundFixture()
    const events = jobEvents(record, c, { settled: { status: 'failed', detail: 'exit code: 1' } })
    expect(await bindingVerifier(x.stateDir, snapshotOf(events), fakeJobs())(c, ready(x.r.dir)))
      .toMatchObject({ ok: false, reason: expect.stringContaining('terminal status is failed') })
  })
})
