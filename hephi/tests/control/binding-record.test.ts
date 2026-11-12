import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActivationContract } from '../../src/control/activation.js'
import type { VerificationCheck } from '../../src/contracts/checks.js'
import {
  bindingRecordProblem,
  bindingRecordSource,
  readBindingRecord,
  validateBindingRecord,
  type BindingRecord,
} from '../../src/control/binding-record.js'
import { checkCommand, runCheck, type NativeJobs } from '../../src/control/check-runner.js'
import { checkRunDir, readRuns, type CheckRunRecord } from '../../src/control/check-store.js'
import { createEvidenceVerifier, type SessionSnapshot } from '../../src/control/evidence-verifier.js'

// B2 four-way delivery binding record (DSH host task order §3.2): consumer-side unit tests.
// These pin the schema, reader and consistency rules only; the ready-gate integration lives
// in the second describe block and never uses a real host.

const BASE_SHA = 'a'.repeat(40)
const HEAD_SHA = 'b'.repeat(40)
const OTHER_SHA = 'c'.repeat(40)
const TICKET = 'ticket-1'
const SESSION = 'worker-session'

function recordValue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    producedAt: '2026-11-12T07:00:00Z',
    producer: 'dsh-host-0.2.1-rc.5',
    ticket: { id: TICKET, repository: 'example/lean-fixture', issue: 42 },
    session: { id: SESSION, origin: 'worker', agentPreset: 'dsh-superagent-worker' },
    execution: { kind: 'foreground', exitCode: 0, toolCallId: 'inner-1', terminalStatus: 'completed', finishedAt: '2026-11-12T07:00:00Z' },
    finalCommit: { sha: HEAD_SHA, baseSha: BASE_SHA, prNumber: 22 },
    ...over,
  }
}

function runValue(over: Partial<CheckRunRecord> = {}): CheckRunRecord {
  return {
    version: 3, pluginCommit: 'plugin', runId: 'run-1', sequence: 1, ticketId: TICKET,
    contractHash: 'sha256:test', checkId: 'build', sessionId: SESSION, callId: 'outer-call-1', innerCallId: 'inner-1',
    argv: ['true'], cwd: '.', startedAt: '2026-11-12T06:59:00Z', finishedAt: '2026-11-12T06:59:01Z',
    status: 'passed', exitCode: 0,
    before: { baseCommit: BASE_SHA, headCommit: HEAD_SHA, patchHash: 'sha256:patch', changedFiles: ['a.txt'] },
    ...over,
  }
}

const expectation = (over: Partial<Parameters<typeof bindingRecordProblem>[1]> = {}) => ({
  ticketId: TICKET,
  sessionId: SESSION,
  headSha: HEAD_SHA,
  baseSha: BASE_SHA,
  usedRuns: [runValue()],
  // B-1/B-2: only the native inner call id counts, and the native Session result kind is
  // authoritative (undefined = unavailable → fail-closed).
  nativeExecutions: [{ innerCallId: 'inner-1', kind: 'foreground' as const }],
  ...over,
})

function validate(over: Record<string, unknown> = {}) {
  return validateBindingRecord(recordValue(over))
}

describe('B2 binding record: schema validation', () => {
  it('accepts a complete foreground record', () => {
    const result = validate()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.record.execution.kind).toBe('foreground')
  })

  it('accepts the host reference example record (paxxie2/g1-at81#5 schema, baseline b830ec95)', () => {
    // Verbatim shape of docs/host-capability-ab/b2-binding-record.example.json in PR #5.
    const example = {
      version: 1,
      producedAt: '2026-11-12T00:00:00.000Z',
      producer: 'dsh-host-example/0.2.2',
      ticket: { id: '0123456789abcdef0123456789abcdef', repository: 'owner/example-repo', issue: 42 },
      session: { id: 'worker-0123456789abcdef0123456789abcdef', origin: 'worker', agentPreset: 'dsh-superagent-worker' },
      execution: {
        toolCallId: 'call_example_0001', kind: 'foreground', exitCode: 0,
        terminalStatus: 'completed', finishedAt: '2026-11-12T00:00:00.000Z',
      },
      finalCommit: {
        sha: '1111111111111111111111111111111111111111',
        baseSha: '2222222222222222222222222222222222222222',
        prNumber: 7,
      },
    }
    const result = validateBindingRecord(example)
    expect(result).toEqual({ ok: true, record: example, warnings: [] })
  })

  it('warns about unknown fields instead of denying them (host may add fields)', () => {
    const result = validate({ hostExtension: { trace: 'x' }, ticket: { id: TICKET, extra: 1 } })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.warnings).toContain('hostExtension')
      expect(result.warnings).toContain('ticket.extra')
    }
  })

  it('accepts empty enhanced strings typed as plain strings by the host schema', () => {
    const result = validate({
      session: { id: SESSION, origin: '', agentPreset: '' },
      execution: { kind: 'foreground', exitCode: 0, toolCallId: 'inner-1', terminalStatus: '' },
    })
    expect(result.ok).toBe(true)
  })

  it('accepts background/promoted records with a Job id and no final exit code', () => {
    for (const kind of ['background', 'promoted'] as const) {
      const result = validate({ execution: { kind, jobId: 'job-1', toolCallId: 'inner-1' } })
      expect(result.ok, kind).toBe(true)
    }
  })

  it('rejects a foreground execution without an integer exit code', () => {
    const result = validate({ execution: { kind: 'foreground', toolCallId: 'inner-1' } })
    expect(result).toEqual({ ok: false, problem: expect.stringContaining('exitCode') })
  })

  it('rejects a foreground execution that also names a Job', () => {
    const result = validate({ execution: { kind: 'foreground', exitCode: 0, jobId: 'job-1', toolCallId: 'inner-1' } })
    expect(result).toEqual({ ok: false, problem: expect.stringContaining('must not name a Job') })
  })

  it('rejects a background/promoted execution that carries a final exit code', () => {
    for (const kind of ['background', 'promoted'] as const) {
      const result = validate({ execution: { kind, jobId: 'job-1', exitCode: 0, toolCallId: 'inner-1' } })
      expect(result, kind).toEqual({ ok: false, problem: expect.stringContaining('must not carry a final exit code') })
    }
  })

  it('rejects background/promoted executions without a Job id', () => {
    const result = validate({ execution: { kind: 'background', toolCallId: 'inner-1' } })
    expect(result).toEqual({ ok: false, problem: expect.stringContaining('jobId') })
  })

  it('rejects an unknown execution kind', () => {
    const result = validate({ execution: { kind: 'detached', toolCallId: 'inner-1' } })
    expect(result.ok).toBe(false)
  })

  it('rejects a non-positive or non-integer version', () => {
    for (const version of [0, -1, 1.5, '1']) {
      const result = validate({ version })
      expect(result.ok, String(version)).toBe(false)
    }
  })

  it('requires 40 lowercase hex commit SHAs', () => {
    for (const sha of ['a'.repeat(39), 'A'.repeat(40), 'z'.repeat(40), `${HEAD_SHA}0`]) {
      const result = validate({ finalCommit: { sha, baseSha: BASE_SHA } })
      expect(result.ok, sha).toBe(false)
    }
    const result = validate({ finalCommit: { sha: HEAD_SHA, baseSha: BASE_SHA } })
    expect(result.ok).toBe(true)
  })

  it('requires an ISO8601 producedAt', () => {
    for (const producedAt of ['2026-11-12', 'yesterday', '2026-11-12T07:00:00', 123]) {
      const result = validate({ producedAt })
      expect(result.ok, String(producedAt)).toBe(false)
    }
    for (const producedAt of ['2026-11-12T07:00:00Z', '2026-11-12T15:00:00+08:00', '2026-11-12T07:00:00.123Z']) {
      expect(validate({ producedAt }).ok, producedAt).toBe(true)
    }
  })

  it('rejects missing four-way fields and empty ids', () => {
    const cases = [
      { ticket: undefined },
      { ticket: { id: '' } },
      { session: undefined },
      { session: { id: '' } },
      { execution: undefined },
      { execution: { kind: 'foreground', exitCode: 0 } },
      { finalCommit: undefined },
      { producer: '' },
      { producedAt: undefined },
    ]
    for (const over of cases) {
      expect(validate(over as Record<string, unknown>).ok, JSON.stringify(over)).toBe(false)
    }
    expect(validateBindingRecord(null).ok).toBe(false)
    expect(validateBindingRecord('record').ok).toBe(false)
  })
})

const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hephi-binding-record-'))
  cleanup.push(dir)
  return dir
}

describe('B2 binding record: reader (never throws)', () => {
  it('reads an explicitly configured record file', async () => {
    const dir = await tempDir()
    const path = join(dir, 'record.json')
    await writeFile(path, JSON.stringify(recordValue()))
    const lookup = await readBindingRecord({ stateDir: dir, ticketId: TICKET, configuredPath: path, env: {} })
    expect(lookup).toMatchObject({ found: true, origin: 'config', path })
  })

  it('treats a configured directory as <dir>/<ticketId>.json', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'records'))
    await writeFile(join(dir, 'records', `${TICKET}.json`), JSON.stringify(recordValue()))
    const lookup = await readBindingRecord({ stateDir: dir, ticketId: TICKET, configuredPath: join(dir, 'records'), env: {} })
    expect(lookup).toMatchObject({ found: true, origin: 'config' })
  })

  it('uses DSH_BINDING_RECORD when no host path is configured', async () => {
    const dir = await tempDir()
    const path = join(dir, 'env-record.json')
    await writeFile(path, JSON.stringify(recordValue()))
    const lookup = await readBindingRecord({ stateDir: dir, ticketId: TICKET, env: { DSH_BINDING_RECORD: path } })
    expect(lookup).toMatchObject({ found: true, origin: 'env', path })
    expect(bindingRecordSource({ stateDir: dir, ticketId: TICKET, env: { DSH_BINDING_RECORD: path } }))
      .toMatchObject({ origin: 'env', configured: true })
  })

  it('falls back to <stateDir>/binding/<ticket>.json', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'binding'))
    await writeFile(join(dir, 'binding', `${TICKET}.json`), JSON.stringify(recordValue()))
    const lookup = await readBindingRecord({ stateDir: dir, ticketId: TICKET, env: {} })
    expect(lookup).toMatchObject({ found: true, origin: 'default' })
    expect(bindingRecordSource({ stateDir: dir, ticketId: TICKET, env: {} }))
      .toMatchObject({ origin: 'default', configured: false })
  })

  it('reports a configured-but-missing record without throwing', async () => {
    const dir = await tempDir()
    const path = join(dir, 'missing.json')
    const lookup = await readBindingRecord({ stateDir: dir, ticketId: TICKET, configuredPath: path, env: {} })
    expect(lookup).toMatchObject({ found: false, reason: 'missing', origin: 'config', path })
    if (!lookup.found) expect(lookup.problem).toContain(`does not exist: ${path}`)
  })

  it('reports a missing conventional record without throwing (fail-closed is decided by the gate)', async () => {
    const dir = await tempDir()
    const path = join(dir, 'binding', `${TICKET}.json`)
    const lookup = await readBindingRecord({ stateDir: dir, ticketId: TICKET, env: {} })
    expect(lookup).toMatchObject({ found: false, reason: 'missing', origin: 'default', path })
  })

  it('reports invalid JSON as unreadable (present file is never skipped)', async () => {
    const dir = await tempDir()
    const configured = join(dir, 'broken.json')
    await writeFile(configured, '{not json')
    expect(await readBindingRecord({ stateDir: dir, ticketId: TICKET, configuredPath: configured, env: {} }))
      .toMatchObject({ found: false, reason: 'unreadable', origin: 'config' })
    const conventionalDir = await tempDir()
    await mkdir(join(conventionalDir, 'binding'))
    await writeFile(join(conventionalDir, 'binding', `${TICKET}.json`), '{not json')
    expect(await readBindingRecord({ stateDir: conventionalDir, ticketId: TICKET, env: {} }))
      .toMatchObject({ found: false, reason: 'unreadable', origin: 'default' })
  })
})

describe('B2 binding record: four-way consistency', () => {
  function parsed(over: Record<string, unknown> = {}): BindingRecord {
    const result = validate(over)
    if (!result.ok) throw new Error(`fixture is not a valid record: ${result.problem}`)
    return result.record
  }

  it('accepts a record matching ticket/session/run/HEAD/base', () => {
    expect(bindingRecordProblem(parsed(), expectation())).toBeUndefined()
  })

  it('accepts a background execution that matches the accepted run Job id and native kind', () => {
    const record = parsed({ execution: { kind: 'background', jobId: 'job-1', toolCallId: 'inner-1' } })
    expect(bindingRecordProblem(record, expectation({
      usedRuns: [runValue({ jobId: 'job-1' })],
      nativeExecutions: [{ innerCallId: 'inner-1', kind: 'background' }],
    }))).toBeUndefined()
  })

  it('accepts a promoted execution that matches the accepted run Job id and native kind', () => {
    const record = parsed({ execution: { kind: 'promoted', jobId: 'job-1', toolCallId: 'inner-1' } })
    expect(bindingRecordProblem(record, expectation({
      usedRuns: [runValue({ jobId: 'job-1' })],
      nativeExecutions: [{ innerCallId: 'inner-1', kind: 'promoted' }],
    }))).toBeUndefined()
  })

  it('B-1: rejects the outer hephi_check call id (only the native inner bash id counts)', () => {
    const record = parsed({ execution: { kind: 'foreground', exitCode: 0, toolCallId: 'outer-call-1' } })
    expect(bindingRecordProblem(record, expectation())).toContain('does not name an accepted native bash execution')
    expect(bindingRecordProblem(record, expectation())).toContain('outer hephi_check call id')
  })

  it('B-1: rejects an inner call id with no confirmed native Session evidence', () => {
    const record = parsed({ execution: { kind: 'foreground', exitCode: 0, toolCallId: 'inner-1' } })
    expect(bindingRecordProblem(record, expectation({ nativeExecutions: [] })))
      .toContain('no confirmed native Session tool/call + tool/result evidence')
  })

  it('B-2: rejects a background record when the native Session result was promoted', () => {
    const record = parsed({ execution: { kind: 'background', jobId: 'job-1', toolCallId: 'inner-1' } })
    expect(bindingRecordProblem(record, expectation({
      usedRuns: [runValue({ jobId: 'job-1' })],
      nativeExecutions: [{ innerCallId: 'inner-1', kind: 'promoted' }],
    }))).toContain('disagrees with the native Session result kind')
  })

  it('B-2: rejects a promoted record when the native Session result was background', () => {
    const record = parsed({ execution: { kind: 'promoted', jobId: 'job-1', toolCallId: 'inner-1' } })
    expect(bindingRecordProblem(record, expectation({
      usedRuns: [runValue({ jobId: 'job-1' })],
      nativeExecutions: [{ innerCallId: 'inner-1', kind: 'background' }],
    }))).toContain('disagrees with the native Session result kind')
  })

  it('B-2: fails closed when the native Session result kind is unavailable', () => {
    const record = parsed({ execution: { kind: 'background', jobId: 'job-1', toolCallId: 'inner-1' } })
    const problem = bindingRecordProblem(record, expectation({
      usedRuns: [runValue({ jobId: 'job-1' })],
      nativeExecutions: [{ innerCallId: 'inner-1' }],
    }))
    expect(problem).toContain('native Session result kind')
    expect(problem).toContain('refusing to guess')
  })

  it('B-2: rejects a foreground record when the native Session result was a Job kind', () => {
    const record = parsed({ execution: { kind: 'foreground', exitCode: 0, toolCallId: 'inner-1' } })
    expect(bindingRecordProblem(record, expectation({ nativeExecutions: [{ innerCallId: 'inner-1', kind: 'background' }] })))
      .toContain('disagrees with the native Session result kind')
  })

  it('rejects a ticket.id that differs from the contract ticket', () => {
    const record = parsed({ ticket: { id: 'ticket-other' } })
    expect(bindingRecordProblem(record, expectation())).toContain('ticket.id')
  })

  it('rejects a session.id that differs from the current Worker Session', () => {
    const record = parsed({ session: { id: 'worker-other' } })
    expect(bindingRecordProblem(record, expectation())).toContain('session.id')
  })

  it('rejects an execution whose toolCallId names no accepted run', () => {
    const record = parsed({ execution: { kind: 'foreground', exitCode: 0, toolCallId: 'inner-unknown' } })
    expect(bindingRecordProblem(record, expectation())).toContain('does not name an accepted native bash execution')
  })

  it('rejects a foreground exit code that differs from the accepted run', () => {
    const record = parsed({ execution: { kind: 'foreground', exitCode: 1, toolCallId: 'inner-1' } })
    expect(bindingRecordProblem(record, expectation())).toContain('disagrees with the accepted check run')
  })

  it('rejects a foreground execution for a run recorded as a Job', () => {
    const record = parsed({ execution: { kind: 'foreground', exitCode: 0, toolCallId: 'inner-1' } })
    expect(bindingRecordProblem(record, expectation({
      usedRuns: [runValue({ jobId: 'job-1' })],
      nativeExecutions: [{ innerCallId: 'inner-1', kind: 'foreground' }],
    }))).toContain('execution is foreground but the accepted check run names Job')
  })

  it('rejects a background Job id that differs from the accepted run', () => {
    const record = parsed({ execution: { kind: 'background', jobId: 'job-other', toolCallId: 'inner-1' } })
    expect(bindingRecordProblem(record, expectation({
      usedRuns: [runValue({ jobId: 'job-1' })],
      nativeExecutions: [{ innerCallId: 'inner-1', kind: 'background' }],
    }))).toContain('disagrees with the accepted check run')
  })

  it('rejects a finalCommit.sha that differs from the verified candidate HEAD', () => {
    const record = parsed({ finalCommit: { sha: OTHER_SHA, baseSha: BASE_SHA } })
    expect(bindingRecordProblem(record, expectation())).toContain('finalCommit.sha')
  })

  it('rejects a finalCommit.baseSha that differs from the contract baseSha', () => {
    const record = parsed({ finalCommit: { sha: HEAD_SHA, baseSha: OTHER_SHA } })
    expect(bindingRecordProblem(record, expectation())).toContain('finalCommit.baseSha')
  })

  it('fails closed when the verified candidate HEAD is unavailable', () => {
    const record = parsed()
    expect(bindingRecordProblem(record, expectation({ headSha: undefined }))).toContain('verified candidate HEAD is unavailable')
  })
})

// ---------------------------------------------------------------------------------------
// B2 ready-gate integration: real git repository + real runCheck records, fixture Session.
// These prove the binding-off path is byte-for-byte unchanged and that a binding-effective
// ready report is denied (ready.binding-record) whenever the four-way record is absent or
// disagrees. They never use a real DSH host or network.
// ---------------------------------------------------------------------------------------

const exec = promisify(execFile)
const buildCheck: VerificationCheck = {
  id: 'build', kind: 'build', purpose: 'build', command: 'true', args: [], cwd: '.', required: true, timeoutMs: 5000,
}
const WORKER_SESSION = 'worker-session'

async function gitRepo(): Promise<{ dir: string; baseSha: string; headSha: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'hephi-binding-repo-'))
  await exec('git', ['init', '-b', 'main', dir])
  await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir })
  await exec('git', ['config', 'user.name', 'Binding test'], { cwd: dir })
  await exec('git', ['remote', 'add', 'origin', 'git@github.com:example/lean-fixture.git'], { cwd: dir })
  await writeFile(join(dir, 'a.txt'), 'base\n')
  await exec('git', ['add', '.'], { cwd: dir })
  await exec('git', ['commit', '-m', 'base'], { cwd: dir })
  const baseSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
  await writeFile(join(dir, 'a.txt'), 'patched\n')
  await exec('git', ['add', '.'], { cwd: dir })
  await exec('git', ['commit', '-m', 'patch'], { cwd: dir })
  const headSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
  return { dir, baseSha, headSha }
}

function gateContract(dir: string, baseSha: string): ActivationContract {
  return {
    enabled: true, ticketId: TICKET, repository: 'example/lean-fixture', issueNumber: 42,
    workspace: dir, baseRef: 'main', baseSha, allowedPaths: ['**'], requirePullRequest: false,
    verification: { version: 1, checks: [buildCheck] }, contractHash: 'sha256:test',
  }
}

function checkOuter(): ToolExecution {
  return {
    callId: 'outer-call-1' as never, rootCallId: 'outer-call-1' as never, name: 'hephi_check',
    agent: { id: WORKER_SESSION } as never, arguments: { checkId: 'build' },
    signal: new AbortController().signal, token: Symbol('check') as never,
  }
}

function readyReport(dir: string): ToolExecution {
  return {
    callId: 'ready-call' as never, rootCallId: 'ready-call' as never, name: 'orchestrator_report',
    arguments: { state: 'ready' }, signal: new AbortController().signal, token: Symbol('ready') as never,
    agent: { session: { header: { cwd: dir, id: WORKER_SESSION } } } as never,
  }
}

function foregroundTools() {
  return {
    execute: async () => ({
      isError: false as const, content: [],
      value: {
        kind: 'foreground', cwd: '/work', exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000,
        stdout: { text: 'ok\n', truncated: false }, stderr: { text: '', truncated: false },
      },
    }),
  }
}

/** A Session snapshot with exactly the native call/result the recorded checks claim. */
function boundSnapshot(stateDir: string, contract: ActivationContract, records: CheckRunRecord[], sessionId = WORKER_SESSION): SessionSnapshot {
  const events: SessionSnapshot['events'] = []
  for (const record of records) {
    const command = checkCommand(contract.baseSha, record.argv[0]!, record.argv.slice(1), checkRunDir(stateDir, contract.ticketId, record.runId))
    events.push({ seq: events.length, type: 'tool/call', data: { name: 'bash', callId: record.innerCallId, arguments: JSON.stringify({ command, workdir: record.cwd }) } })
    events.push({
      seq: events.length, type: 'tool/result',
      data: {
        message: {
          toolCallId: record.innerCallId, isError: false, content: [],
          value: {
            kind: 'foreground', cwd: '/work', exitCode: 0, signal: null, timedOut: false, aborted: false,
            stdout: { text: 'ok\n', truncated: false }, stderr: { text: '', truncated: false },
          },
        },
      },
    })
  }
  return { session: { id: sessionId }, inheritedEventCount: 0, events }
}

function recordJson(contract: ActivationContract, used: readonly CheckRunRecord[], headSha: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    producedAt: '2026-11-12T07:00:00Z',
    producer: 'dsh-host-test',
    ticket: { id: contract.ticketId },
    session: { id: WORKER_SESSION },
    execution: { kind: 'foreground', exitCode: 0, toolCallId: used[0]!.innerCallId },
    finalCommit: { sha: headSha, baseSha: contract.baseSha },
    ...over,
  }
}

async function lastDecision(stateDir: string, ticketId: string): Promise<any> {
  const text = await readFile(join(stateDir, 'hephi', ticketId, 'decisions.jsonl'), 'utf8')
  return JSON.parse(text.trim().split('\n').at(-1)!)
}

async function gateSetup() {
  const r = await gitRepo()
  const stateDir = await mkdtemp(join(tmpdir(), 'hephi-binding-gate-'))
  cleanup.push(r.dir, stateDir)
  const contract = gateContract(r.dir, r.baseSha)
  await runCheck({ stateDir, contract, checkId: 'build', outer: checkOuter(), tools: foregroundTools() })
  const used = await readRuns(stateDir, contract.ticketId)
  const snapshot = boundSnapshot(stateDir, contract, used)
  const verifier = (options: { bindingOn?: boolean; recordPath?: string; jobs?: NativeJobs } = {}) =>
    createEvidenceVerifier({
      stateDir,
      readSession: async () => snapshot,
      requireSessionBinding: options.bindingOn !== false,
      ...(options.recordPath === undefined ? {} : { bindingRecordPath: options.recordPath }),
      ...(options.jobs === undefined ? {} : { jobs: options.jobs }),
    })
  return { r, stateDir, contract, used, snapshot, verifier }
}

describe('B2 binding record: ready gate (fixture integration)', () => {
  it('allows a binding-on ready report whose four-way record matches the accepted run', async () => {
    const x = await gateSetup()
    const path = join(x.stateDir, 'record.json')
    await writeFile(path, JSON.stringify(recordJson(x.contract, x.used, x.r.headSha)))
    const result = await x.verifier({ recordPath: path })(x.contract, readyReport(x.r.dir))
    expect(result).toEqual({ ok: true })
    expect(await lastDecision(x.stateDir, x.contract.ticketId)).toMatchObject({ rule: 'ready.pass', effectiveDecision: 'allow' })
  })

  it('reads the conventional <stateDir>/binding/<ticket>.json deployment path', async () => {
    const x = await gateSetup()
    await mkdir(join(x.stateDir, 'binding'), { recursive: true })
    await writeFile(join(x.stateDir, 'binding', `${x.contract.ticketId}.json`), JSON.stringify(recordJson(x.contract, x.used, x.r.headSha)))
    expect(await x.verifier()(x.contract, readyReport(x.r.dir))).toEqual({ ok: true })
  })

  it('locates the record through DSH_BINDING_RECORD (environment only locates, it never skips)', async () => {
    const x = await gateSetup()
    const path = join(x.stateDir, 'env-record.json')
    await writeFile(path, JSON.stringify(recordJson(x.contract, x.used, x.r.headSha)))
    const previous = process.env.DSH_BINDING_RECORD
    process.env.DSH_BINDING_RECORD = path
    try {
      expect(await x.verifier()(x.contract, readyReport(x.r.dir))).toEqual({ ok: true })
    } finally {
      if (previous === undefined) delete process.env.DSH_BINDING_RECORD
      else process.env.DSH_BINDING_RECORD = previous
    }
  })

  it('denies a binding-on ready report when no record exists (fail-closed, even unconfigured)', async () => {
    const x = await gateSetup()
    const result = await x.verifier()(x.contract, readyReport(x.r.dir))
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('binding is on but no binding record is available') })
    expect((result as { reason: string }).reason).toContain(join(x.stateDir, 'binding', `${x.contract.ticketId}.json`))
    expect(await lastDecision(x.stateDir, x.contract.ticketId)).toMatchObject({ rule: 'ready.binding-record', effectiveDecision: 'deny' })
  })

  it('denies when a configured record path exists in configuration but not on disk', async () => {
    const x = await gateSetup()
    const missing = join(x.stateDir, 'configured', 'record.json')
    const result = await x.verifier({ recordPath: missing })(x.contract, readyReport(x.r.dir))
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('binding is on but no binding record is available') })
    expect((result as { reason: string }).reason).toContain(missing)
  })

  it('denies a record whose ticket.id disagrees with the contract (reason names the element)', async () => {
    const x = await gateSetup()
    const path = join(x.stateDir, 'record.json')
    await writeFile(path, JSON.stringify(recordJson(x.contract, x.used, x.r.headSha, { ticket: { id: 'ticket-other' } })))
    const result = await x.verifier({ recordPath: path })(x.contract, readyReport(x.r.dir))
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('ticket.id') })
    expect(await lastDecision(x.stateDir, x.contract.ticketId)).toMatchObject({ rule: 'ready.binding-record' })
  })

  it('denies a record whose session.id disagrees with the current Worker Session', async () => {
    const x = await gateSetup()
    const path = join(x.stateDir, 'record.json')
    await writeFile(path, JSON.stringify(recordJson(x.contract, x.used, x.r.headSha, { session: { id: 'worker-other' } })))
    const result = await x.verifier({ recordPath: path })(x.contract, readyReport(x.r.dir))
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('session.id') })
  })

  it('denies an execution that disagrees with the accepted check run', async () => {
    const x = await gateSetup()
    const path = join(x.stateDir, 'record.json')
    await writeFile(path, JSON.stringify(recordJson(x.contract, x.used, x.r.headSha, {
      execution: { kind: 'foreground', exitCode: 1, toolCallId: x.used[0]!.innerCallId },
    })))
    const result = await x.verifier({ recordPath: path })(x.contract, readyReport(x.r.dir))
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('execution') })
    expect((result as { reason: string }).reason).toContain('accepted check run')
  })

  it('denies a finalCommit.sha that differs from the verified candidate HEAD', async () => {
    const x = await gateSetup()
    const path = join(x.stateDir, 'record.json')
    await writeFile(path, JSON.stringify(recordJson(x.contract, x.used, x.r.headSha, {
      finalCommit: { sha: 'd'.repeat(40), baseSha: x.contract.baseSha },
    })))
    const result = await x.verifier({ recordPath: path })(x.contract, readyReport(x.r.dir))
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('finalCommit.sha') })
  })

  it('denies a finalCommit.baseSha that differs from the contract baseSha', async () => {
    const x = await gateSetup()
    const path = join(x.stateDir, 'record.json')
    await writeFile(path, JSON.stringify(recordJson(x.contract, x.used, x.r.headSha, {
      finalCommit: { sha: x.r.headSha, baseSha: 'e'.repeat(40) },
    })))
    const result = await x.verifier({ recordPath: path })(x.contract, readyReport(x.r.dir))
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('finalCommit.baseSha') })
  })

  it('denies a record missing required metadata (producer / version) instead of passing it', async () => {
    const x = await gateSetup()
    for (const field of ['producer', 'version', 'producedAt'] as const) {
      const path = join(x.stateDir, `record-without-${field}.json`)
      const value = recordJson(x.contract, x.used, x.r.headSha)
      delete value[field]
      await writeFile(path, JSON.stringify(value))
      const result = await x.verifier({ recordPath: path })(x.contract, readyReport(x.r.dir))
      expect(result, field).toMatchObject({ ok: false, reason: expect.stringContaining('binding record schema mismatch') })
      expect((result as { reason: string }).reason, field).toContain(field)
    }
  })

  it('accepts unknown host fields with a warning (never a false denial)', async () => {
    const x = await gateSetup()
    const path = join(x.stateDir, 'record.json')
    await writeFile(path, JSON.stringify(recordJson(x.contract, x.used, x.r.headSha, {
      hostExtension: { trace: 'x' },
      execution: { kind: 'foreground', exitCode: 0, toolCallId: x.used[0]!.innerCallId, hostField: true },
    })))
    expect(await x.verifier({ recordPath: path })(x.contract, readyReport(x.r.dir))).toEqual({ ok: true })
    const validation = validateBindingRecord(JSON.parse(await readFile(path, 'utf8')))
    expect(validation.ok).toBe(true)
    if (validation.ok) expect(validation.warnings).toContain('hostExtension')
  })

  it('binding off: never reads the record and adds no rule (zero regression)', async () => {
    const x = await gateSetup()
    // A record that would definitely be rejected if the gate were active.
    const path = join(x.stateDir, 'record.json')
    await writeFile(path, JSON.stringify(recordJson(x.contract, x.used, x.r.headSha, { ticket: { id: 'ticket-other' } })))
    const off = createEvidenceVerifier({ stateDir: x.stateDir })
    // No Session reader and no binding: the ready report passes exactly as before.
    expect(await off(x.contract, readyReport(x.r.dir))).toEqual({ ok: true })
    expect(await lastDecision(x.stateDir, x.contract.ticketId)).toMatchObject({ rule: 'ready.pass', effectiveDecision: 'allow' })
    const text = await readFile(join(x.stateDir, 'hephi', x.contract.ticketId, 'decisions.jsonl'), 'utf8')
    expect(text).not.toContain('ready.binding-record')
  })
})

  it('binding off: readBindingRecord is never called even with bad records at all three lookup paths', async () => {
    const x = await gateSetup()
    // Place a malformed record at the default path (<stateDir>/binding/<ticket>.json)
    const defaultPath = join(x.stateDir, 'binding', x.contract.ticketId + '.json')
    await mkdir(dirname(defaultPath), { recursive: true })
    await writeFile(defaultPath, '{invalid json')
    // Place another bad record at an explicit config path
    const configPath = join(x.stateDir, 'config-binding.json')
    await writeFile(configPath, '{also invalid')

    const spyModule = await import('../../src/control/binding-record.js')
    const spy = vi.spyOn(spyModule, 'readBindingRecord')

    const off = createEvidenceVerifier({ stateDir: x.stateDir, bindingRecordPath: configPath })
    expect(await off(x.contract, readyReport(x.r.dir))).toEqual({ ok: true })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('readyRule classifies binding-record deny even when reason path contains rate-limit text', async () => {
    // The reason string includes the file path; if that path happens to contain
    // "rate limit", the old heuristic would misclassify as ready.github-unavailable.
    const { readyRule } = await import('../../src/control/evidence-verifier.js')
    expect(readyRule('ready.binding-record: /some/rate limit/path/record.json: ticket mismatch')).toBe('ready.binding-record')
  })
