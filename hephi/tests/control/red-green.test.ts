/**
 * T17: red-before-green runtime gate.
 *
 * These tests use a temporary Git checkout and the real runner/verifier, with the native
 * bash tool replaced by a fixture (so no host is involved). They prove the local gate only:
 * the host encodings (H1–H5/A2) and the real DSH Worker are still unverified.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActivationContract } from '../../src/control/activation.js'
import type { VerificationCheck } from '../../src/contracts/checks.js'
import { parseTaskCard } from '../../src/contracts/task.js'
import { retryFailureCount, runCheck, type CheckTools } from '../../src/control/check-runner.js'
import { appendResolution, checkRunDir, readRuns, type CheckRunRecord } from '../../src/control/check-store.js'
import { createEvidenceVerifier } from '../../src/control/evidence-verifier.js'

const run = promisify(execFile)
const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

const BUILD: VerificationCheck = {
  id: 'build', kind: 'build', purpose: 'build', command: 'true', args: [], cwd: '.',
  required: true, timeoutMs: 5000,
}
const TEST_FILE = 'tests/app.test.js'
const IMPL_FILE = 'src/app.js'
const SESSION = 'worker-session'

// ---- temporary Git checkout -------------------------------------------------

async function git(dir: string, args: string[]): Promise<string> {
  return (await run('git', args, { cwd: dir })).stdout
}

async function initRepo(): Promise<{ dir: string; baseSha: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'hephi-redgreen-repo-'))
  cleanup.push(dir)
  await run('git', ['init', '-b', 'main', dir])
  await run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir })
  await run('git', ['config', 'user.name', 'Red green test'], { cwd: dir })
  await run('git', ['remote', 'add', 'origin', 'git@github.com:example/red-green.git'], { cwd: dir })
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, IMPL_FILE), 'module.exports = 1\n')
  await run('git', ['add', '.'], { cwd: dir })
  await run('git', ['commit', '-m', 'base'], { cwd: dir })
  const baseSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
  return { dir, baseSha }
}

async function commit(dir: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, file)), { recursive: true })
    await writeFile(join(dir, file), content)
  }
  await run('git', ['add', '-A'], { cwd: dir })
  await run('git', ['commit', '-m', message], { cwd: dir })
  return (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
}

/** base → red: add the failing acceptance test only (the repo stays at the red commit). */
async function redRepo(): Promise<{ dir: string; baseSha: string; redSha: string }> {
  const { dir, baseSha } = await initRepo()
  const redSha = await commit(dir, { [TEST_FILE]: "test('adds', () => {})\n" }, 'red: add failing acceptance test')
  return { dir, baseSha, redSha }
}

/** The green commit is created only after the red run, so the red record names the red commit. */
async function commitGreen(r: { dir: string }, files: Record<string, string> = { [IMPL_FILE]: 'module.exports = 2\n' }): Promise<string> {
  return commit(r.dir, files, 'green: implement')
}

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hephi-redgreen-state-'))
  cleanup.push(dir)
  return dir
}

// ---- contracts --------------------------------------------------------------

function taskCard(kind: 'code' | 'refactor' = 'code') {
  return parseTaskCard({
    version: 3, kind, goal: 'implement add', outOfScope: [],
    acceptance: [{
      id: 'AC1', text: 'add returns the sum', check: 'build', paths: ['**'],
      ...(kind === 'code' ? { tests: [TEST_FILE] } : {}),
    }],
    protect: [],
  })
}

function contract(
  r: { dir: string; baseSha: string }, overrides: Partial<ActivationContract> = {}, kind: 'code' | 'refactor' = 'code',
): ActivationContract {
  return {
    enabled: true, ticketId: 'ticket-1', repository: 'example/red-green', issueNumber: 42,
    workspace: r.dir, baseRef: 'main', baseSha: r.baseSha, allowedPaths: ['**'], requirePullRequest: false,
    verification: { version: 1, checks: [{ ...BUILD }] }, contractHash: 'sha256:test',
    task: taskCard(kind), ...overrides,
  }
}

function legacyContract(r: { dir: string; baseSha: string }, version: 1 | 2): ActivationContract {
  const card = parseTaskCard({
    version, goal: 'legacy task',
    acceptance: [{ id: 'AC1', text: 'behaviour kept', check: 'build', paths: ['**'] }],
    protect: [],
  })
  return contract(r, { task: card })
}

// ---- fake native bash tool --------------------------------------------------

type Outcome = { exitCode?: number | null; timedOut?: boolean; aborted?: boolean; text?: string }

function nativeTools(outcome: Outcome = {}): CheckTools {
  const value = {
    kind: 'foreground', cwd: '.', exitCode: outcome.exitCode === undefined ? 0 : outcome.exitCode,
    signal: null, timedOut: outcome.timedOut === true, aborted: outcome.aborted === true, timeoutMs: 5000,
    stdout: { text: outcome.text ?? 'ok\n', truncated: false }, stderr: { text: '', truncated: false },
  }
  return { execute: async () => ({ isError: false, content: [], value } as never) }
}

const redTools = () => nativeTools({ exitCode: 1, text: 'red: acceptance test fails\n' })
const greenTools = () => nativeTools({ exitCode: 0, text: 'green: acceptance test passes\n' })

// ---- runner / verifier helpers ---------------------------------------------

function outer(): ToolExecution {
  return {
    callId: 'outer-check' as never, rootCallId: 'outer-check' as never, name: 'hephi_check',
    agent: { id: SESSION } as never, arguments: { checkId: 'build' }, signal: new AbortController().signal, token: Symbol('check') as never,
  }
}

function ready(workspace: string, sessionId = SESSION): ToolExecution {
  return {
    callId: 'ready-call' as never, rootCallId: 'ready-call' as never, name: 'orchestrator_report',
    arguments: { state: 'ready' }, signal: new AbortController().signal, token: Symbol('ready') as never,
    agent: { session: { header: { cwd: workspace, id: sessionId } } } as never,
  }
}

const redRun = (state: string, c: ActivationContract, tools: CheckTools = redTools()) =>
  runCheck({ stateDir: state, contract: c, checkId: 'build', outer: outer(), tools, phase: 'red' })
const greenRun = (state: string, c: ActivationContract, tools: CheckTools = greenTools()) =>
  runCheck({ stateDir: state, contract: c, checkId: 'build', outer: outer(), tools })

const verdict = (state: string, c: ActivationContract, allowOperatorResolutions = false) =>
  createEvidenceVerifier({ stateDir: state, allowOperatorResolutions })(c, ready(c.workspace))

async function lastDecision(state: string): Promise<Record<string, unknown>> {
  const text = await readFile(join(state, 'hephi', 'ticket-1', 'decisions.jsonl'), 'utf8')
  return JSON.parse(text.trim().split('\n').at(-1)!) as Record<string, unknown>
}

// ---- AT-30..AT-39 -----------------------------------------------------------

describe('T17 red-before-green gate', () => {
  it('AT-30: phase persists, old records without phase stay ordinary, red runs never count as retries', async () => {
    const r = await redRepo()
    const state = await stateDir()
    const c = contract(r)
    const red = await redRun(state, c)
    expect(red.phase).toBe('red')
    expect(red.status).toBe('blocked')
    expect(red.exitCode).toBe(1)
    const redFile = join(checkRunDir(state, 'ticket-1', red.runId), 'run.json')
    expect(JSON.parse(await readFile(redFile, 'utf8')).phase).toBe('red')

    await commitGreen(r)
    const green = await greenRun(state, c)
    expect(green.phase).toBeUndefined()
    expect(JSON.parse(await readFile(join(checkRunDir(state, 'ticket-1', green.runId), 'run.json'), 'utf8')))
      .not.toHaveProperty('phase')

    // A record written before T17 (no phase) is read as an ordinary check, not as red.
    const legacy = JSON.parse(await readFile(redFile, 'utf8')) as Record<string, unknown>
    delete legacy.phase
    await writeFile(redFile, JSON.stringify(legacy, null, 2))
    expect((await readRuns(state, 'ticket-1')).find(record => record.runId === red.runId)?.phase).toBeUndefined()

    // The C4.5 counter ignores red runs entirely: no increment, and a red pass never clears it.
    const base = {
      version: 3 as const, pluginCommit: 'plugin', ticketId: 'ticket-1', contractHash: 'sha256:test',
      checkId: 'build', sessionId: SESSION, callId: 'call', innerCallId: 'inner', argv: ['true'], cwd: '.',
      startedAt: '2026-01-01T00:00:00.000Z', sequence: 1,
      before: { baseCommit: 'a'.repeat(40), patchHash: 'sha256:test', changedFiles: [] as string[] },
    }
    const blocked = (runId: string, extra: Partial<CheckRunRecord> = {}): CheckRunRecord => ({ ...base, runId, status: 'blocked', exitCode: 1, reason: 'check did not exit successfully: 1', ...extra })
    const passed = (runId: string, extra: Partial<CheckRunRecord> = {}): CheckRunRecord => ({ ...base, runId, status: 'passed', exitCode: 0, ...extra })
    expect(retryFailureCount([blocked('r1', { phase: 'red' })], 'build', 'sha256:test')).toBe(0)
    expect(retryFailureCount([blocked('r1'), passed('r2', { phase: 'red' }), blocked('r3')], 'build', 'sha256:test')).toBe(2)
    // A legacy record without phase still counts.
    expect(retryFailureCount([blocked('r1')], 'build', 'sha256:test')).toBe(1)
  })

  it('AT-31: no red-phase record denies ready with ready.red-missing', async () => {
    const r = await redRepo()
    await commitGreen(r)
    const state = await stateDir()
    const c = contract(r)
    expect((await greenRun(state, c)).status).toBe('passed')
    const result = await verdict(state, c)
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('ready.red-missing') })
    expect((await lastDecision(state)).rule).toBe('ready.red-missing')
  })

  it('AT-35: red then green at the same tests passes ready', async () => {
    const r = await redRepo()
    const state = await stateDir()
    const c = contract(r)
    const red = await redRun(state, c)
    expect(red.reason).toBe('red run failed as expected: exit code 1')
    await commitGreen(r)
    expect((await greenRun(state, c)).status).toBe('passed')
    expect(await verdict(state, c)).toEqual({ ok: true })
    expect((await lastDecision(state)).rule).toBe('ready.pass')
  })

  it('AT-32: implementation code in the red commit denies ready with ready.red-impl-files', async () => {
    const { dir, baseSha } = await initRepo()
    await commit(dir, { [TEST_FILE]: "test('adds', () => {})\n", [IMPL_FILE]: 'module.exports = 9\n' }, 'red: tests plus implementation')
    const state = await stateDir()
    const c = contract({ dir, baseSha })
    expect((await redRun(state, c)).status).toBe('blocked')
    await commit(dir, { [IMPL_FILE]: 'module.exports = 2\n' }, 'green: implement')
    expect((await greenRun(state, c)).status).toBe('passed')
    const result = await verdict(state, c)
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('ready.red-impl-files') })
    if (!result.ok) expect(result.reason).toContain(IMPL_FILE)
    expect((await lastDecision(state)).rule).toBe('ready.red-impl-files')
  })

  it('AT-33: acceptance tests changed after the red run deny ready with ready.red-tests-changed', async () => {
    const { dir, baseSha } = await initRepo()
    await commit(dir, { [TEST_FILE]: "test('adds', () => {})\n" }, 'red: add failing acceptance test')
    const state = await stateDir()
    const c = contract({ dir, baseSha })
    expect((await redRun(state, c)).status).toBe('blocked')
    await commit(dir, { [TEST_FILE]: "test('adds', () => { expect(1).toBe(1) })\n", [IMPL_FILE]: 'module.exports = 2\n' }, 'green: implement and edit the test')
    expect((await greenRun(state, c)).status).toBe('passed')
    const result = await verdict(state, c)
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('ready.red-tests-changed') })
    if (!result.ok) expect(result.reason).toContain(TEST_FILE)
    expect((await lastDecision(state)).rule).toBe('ready.red-tests-changed')
  })

  it('AT-34: a red run that changes the source during the check is not red evidence', async () => {
    const r = await redRepo()
    const state = await stateDir()
    const c = contract(r)
    const mutating: CheckTools = {
      execute: async () => {
        await writeFile(join(r.dir, IMPL_FILE), 'module.exports = 777\n')
        return { isError: false, content: [], value: {
          kind: 'foreground', cwd: '.', exitCode: 1, signal: null, timedOut: false, aborted: false, timeoutMs: 5000,
          stdout: { text: 'red\n', truncated: false }, stderr: { text: '', truncated: false },
        } } as never
      },
    }
    const red = await redRun(state, c, mutating)
    expect(red.status).toBe('blocked')
    expect(red.reason).toContain('red run changed the source tree')
    expect(red.after).toBeDefined()
    await run('git', ['checkout', '--', IMPL_FILE], { cwd: r.dir })
    await commitGreen(r)
    expect((await greenRun(state, c)).status).toBe('passed')
    expect(await verdict(state, c)).toEqual({ ok: false, reason: expect.stringContaining('ready.red-missing') })
  })

  it('AT-36: a refactor task has no red gate, but a broken acceptance check still denies ready', async () => {
    const r = await redRepo()
    await commitGreen(r)
    const state = await stateDir()
    const c = contract(r, {}, 'refactor')
    await greenRun(state, c, redTools()) // the acceptance check fails on the current HEAD
    const result = await verdict(state, c)
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('missing, failed or stale evidence') })
    expect((await lastDecision(state)).rule).toBe('ready.evidence-missing')
  })

  it('AT-37: version 1 and version 2 task cards keep the green-only behavior (no red gate)', async () => {
    const r = await redRepo()
    await commitGreen(r)
    const state = await stateDir()
    const v2 = legacyContract(r, 2)
    expect((await greenRun(state, v2)).status).toBe('passed')
    expect(await verdict(state, v2)).toEqual({ ok: true })
    expect((await lastDecision(state)).rule).toBe('ready.pass')
    const v1 = legacyContract(r, 1)
    expect(await verdict(state, v1)).toEqual({ ok: true })
    expect((await lastDecision(state)).rule).toBe('ready.pass')
  })

  it('AT-38: a red run that exits 0 is not red evidence', async () => {
    const r = await redRepo()
    const state = await stateDir()
    const c = contract(r)
    const red = await redRun(state, c, nativeTools({ exitCode: 0 }))
    expect(red.status).toBe('blocked')
    expect(red.reason).toContain('red run exited 0')
    expect(red.after).toBeDefined()
    await commitGreen(r)
    expect((await greenRun(state, c)).status).toBe('passed')
    expect(await verdict(state, c)).toEqual({ ok: false, reason: expect.stringContaining('ready.red-missing') })
  })

  it('AT-39: timeout, cancellation and unknown red runs are not red evidence', async () => {
    const r = await redRepo()
    await commitGreen(r)
    const c = contract(r)
    const cases: Array<[string, CheckTools, 'unknown']> = [
      ['timeout', nativeTools({ exitCode: 0, timedOut: true }), 'unknown'],
      ['cancellation', nativeTools({ exitCode: 0, aborted: true }), 'unknown'],
      ['unknown result', { execute: async () => ({ isError: true, content: [], value: undefined } as never) }, 'unknown'],
    ]
    for (const [name, tools, expectedStatus] of cases) {
      const state = await stateDir()
      // The green run comes first so the interrupted red run below is the only unfinished one.
      expect((await greenRun(state, c)).status, name).toBe('passed')
      const red = await redRun(state, c, tools)
      expect(red.status, name).toBe(expectedStatus)
      // Unfinished runs block ready until an operator resolution exists; the red gate
      // still refuses them as evidence afterwards.
      await appendResolution(state, {
        ticketId: 'ticket-1', contractHash: 'sha256:test', runId: red.runId,
        basis: 'host-terminal', hostQuery: 'ps: process gone', operator: 'operator@example.invalid',
      })
      expect(await verdict(state, c, true), name).toEqual({ ok: false, reason: expect.stringContaining('ready.red-missing') })
    }
  })
})
