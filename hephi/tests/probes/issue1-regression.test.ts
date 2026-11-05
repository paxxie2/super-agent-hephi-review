import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { prepareActivation } from '../../src/control/activation.js'
import { readRuns } from '../../src/control/check-store.js'
import { disciplineProblems, summarizeChanges } from '../../src/control/discipline.js'
import { mountWorkerGate } from '../../src/control/worker-mount.js'
import { apply } from '../../src/index.js'
import { check, cleanup, commitAll, git, project, readyCall, snapshot, verifier, type Project } from './harness.js'

// Regression tests for issue #1. Each block names the acceptance criterion it covers.
const run = promisify(execFile)
const fix = (dir: string) => writeFile(join(dir, 'src/price.js'), 'exports.total = (a, b) => a + b\n')

describe('acceptance does not depend on a base run (criteria 1, 2, 7)', () => {
  it('a behaviour-preserving rewrite is accepted', async () => {
    const p = await project({ check: 'tests' })
    await writeFile(join(p.dir, 'src/price.js'), 'exports.total = function (a, b) { return a - b }\n'); await commitAll(p.dir, 'rewrite')
    expect(await check(p, 'tests')).toBe('passed')
    expect(await verifier(p)(p.contract, readyCall(p.dir))).toEqual({ ok: true })
  })

  it('a check broken by a missing module fails on HEAD instead of posing as reproduction, and runs once', async () => {
    const p = await project()
    await writeFile(join(p.dir, 'src/price.js'), "module.exports = require('./missing.js')\n"); await commitAll(p.dir, 'broken')
    expect(await check(p, 'tests')).toBe('passed')
    expect(await check(p, 'price')).toBe('blocked')
    expect(p.events.filter(e => e.type === 'tool/call')).toHaveLength(2)
    expect(await verifier(p)(p.contract, readyCall(p.dir))).toMatchObject({ ok: false, reason: 'missing, failed or stale evidence: price' })
  })

  it('an acceptance check that was never run cannot be skipped', async () => {
    const p = await project()
    await fix(p.dir); await commitAll(p.dir, 'fix')
    expect(await check(p, 'tests')).toBe('passed')
    expect(await verifier(p)(p.contract, readyCall(p.dir))).toMatchObject({ ok: false, reason: 'missing, failed or stale evidence: price' })
  })

  it('an indentation change in Python is a change, not a formatting-only edit to reject', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hephi-py-')); cleanup.push(dir)
    await git(dir, 'init', '-q'); await git(dir, 'config', 'user.email', 'a@b'); await git(dir, 'config', 'user.name', 't')
    await mkdir(join(dir, 'src')); await writeFile(join(dir, 'src/a.py'), 'if x:\n    y()\nz()\n'); await commitAll(dir, 'base')
    const base = await git(dir, 'rev-parse', 'HEAD')
    await writeFile(join(dir, 'src/a.py'), 'if x:\n    y()\n    z()\n'); await commitAll(dir, 'indent')
    const p = await project({ paths: ['src/**'] })
    expect(disciplineProblems(p.contract, await summarizeChanges(dir, base))).toEqual([])
  })
})

describe('Session binding (criterion 3)', () => {
  async function delivered(): Promise<Project> {
    const p = await project()
    await fix(p.dir); await commitAll(p.dir, 'fix')
    expect([await check(p, 'tests'), await check(p, 'price')]).toEqual(['passed', 'passed'])
    return p
  }
  const verdict = (p: Project, events: Project['events'], options: { id?: string; inherited?: number } = {}) =>
    verifier(p, id => snapshot(events, options.id ?? id, options.inherited ?? 0))(p.contract, readyCall(p.dir))
  const map = (events: Project['events'], f: (e: Project['events'][number]) => Project['events'][number] | undefined) =>
    events.map(f).filter((e): e is Project['events'][number] => e !== undefined)

  it('accepts the genuine bash call and result', async () => {
    const p = await delivered()
    expect(await verdict(p, p.events)).toEqual({ ok: true })
  })

  it('rejects an edit error event that only shares the call id', async () => {
    const p = await delivered()
    const forged = p.events.map(e => ({ seq: e.seq, type: 'tool/result', data: { name: 'edit', isError: true, message: { toolCallId: e.data.callId ?? e.data.message?.toolCallId, isError: true } } }))
    expect(await verdict(p, forged)).toMatchObject({ ok: false, reason: expect.stringContaining('expected one native call') })
  })

  it('rejects a non-bash call', async () => {
    const p = await delivered()
    expect(await verdict(p, map(p.events, e => e.type === 'tool/call' ? { ...e, data: { ...e.data, name: 'edit' } } : e))).toMatchObject({ ok: false, reason: expect.stringContaining('not bash') })
  })

  it('rejects an error result', async () => {
    const p = await delivered()
    expect(await verdict(p, map(p.events, e => e.type === 'tool/result' ? { ...e, data: { message: { ...e.data.message, isError: true } } } : e))).toMatchObject({ ok: false, reason: expect.stringContaining('is an error') })
  })

  it('rejects a call with no terminal result', async () => {
    const p = await delivered()
    expect(await verdict(p, p.events.filter(e => e.type !== 'tool/result'))).toMatchObject({ ok: false, reason: expect.stringContaining('found 0') })
  })

  it('rejects a result whose exit code differs from the record', async () => {
    const p = await delivered()
    const altered = map(p.events, e => e.type === 'tool/result' ? { ...e, data: { message: { ...e.data.message, content: [{ type: 'text', text: '{"exitCode":1}' }] } } } : e)
    expect(await verdict(p, altered)).toMatchObject({ ok: false, reason: expect.stringContaining('exit code 1 differs') })
  })

  it('rejects a different command or directory', async () => {
    const p = await delivered()
    const moved = map(p.events, e => e.type === 'tool/call' ? { ...e, data: { ...e.data, arguments: JSON.stringify({ ...JSON.parse(e.data.arguments), workdir: '/tmp' }) } } : e)
    expect(await verdict(p, moved)).toMatchObject({ ok: false, reason: expect.stringContaining('different command or directory') })
  })

  it('rejects another Session and events inherited from a parent Session', async () => {
    const p = await delivered()
    expect(await verdict(p, p.events, { id: 'other-session' })).toMatchObject({ ok: false, reason: expect.stringContaining('different Session') })
    expect(await verdict(p, p.events, { inherited: p.events.length })).toMatchObject({ ok: false, reason: expect.stringContaining('found 0') })
  })

  it('the plugin entry passes the binding requirement through to ready', async () => {
    const p = await delivered()
    const readyFor = async (config: { requireSessionBinding: boolean }) => {
      let preExecute: ((e: ToolExecution, next: () => Promise<unknown>) => Promise<any>) | undefined
      const agent = {
        session: { header: { id: `worker-${p.contract.ticketId}`, agentPreset: 'dsh-superagent-worker', cwd: p.dir } },
        ctx: {
          on: (name: string, fn: typeof preExecute) => { if (name === 'tools/pre-execute') preExecute = fn; return () => true },
          tools: { register: () => () => true, guard: () => () => true },
          systemPrompt: { section: () => () => true },
        },
      }
      const ctx = { get: () => undefined, on: () => () => true, effect: () => undefined, agents: { list: () => [agent] } }
      apply(ctx as unknown as Context, { stateDir: p.stateDir, ...config })
      const call = { ...readyCall(p.dir), agent } as unknown as ToolExecution
      return preExecute!(call, async () => ({ kind: 'allow' }))
    }
    expect(await readyFor({ requireSessionBinding: true })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('sessionQuery service is unavailable') })
    expect(await readyFor({ requireSessionBinding: false })).toEqual({ kind: 'allow' })
  })

  it('rejects a ready report without a Session id when binding is required', async () => {
    const p = await delivered()
    expect(await verifier(p)(p.contract, readyCall(p.dir, null as never))).toMatchObject({ ok: false, reason: expect.stringContaining('no Worker Session') })
  })
})

describe('retry after a check that never started (criteria 4, 5)', () => {
  it('a missing cwd is recorded as a not-started failure and can be retried after the fix', async () => {
    const p = await project({ paths: ['src/**', 'tests/**'] }, [{ id: 'sub', kind: 'test', purpose: 'nested', command: 'true', args: [], cwd: 'src/sub', required: false }])
    await fix(p.dir); await commitAll(p.dir, 'fix')
    expect(await check(p, 'sub')).toBe('blocked')
    expect(p.events).toHaveLength(0)
    const [first] = await readRuns(p.stateDir, p.contract.ticketId)
    expect(first.reason).toMatch(/^check not started: /)
    await mkdir(join(p.dir, 'src/sub')); await writeFile(join(p.dir, 'src/sub/keep.js'), '\n'); await commitAll(p.dir, 'add sub')
    expect(await check(p, 'sub')).toBe('passed')
    expect((await readRuns(p.stateDir, p.contract.ticketId)).map(r => r.status)).toEqual(['blocked', 'passed'])
  })

  it('an execution that may still be running stays closed and leaves the workspace in place', async () => {
    const p = await project()
    await fix(p.dir); await commitAll(p.dir, 'fix')
    p.tools.execute = async () => { throw new Error('host connection lost after launch') }
    expect(await check(p, 'price')).toBe('unknown')
    expect(await check(p, 'price')).toContain('operator resolution')
    expect(await verifier(p)(p.contract, readyCall(p.dir))).toMatchObject({ ok: false, reason: expect.stringContaining('operator resolution') })
    await expect(access(join(p.dir, 'src/price.js'))).resolves.toBeUndefined()
  })
})

describe('direct edit guard uses the real checkout (criterion 6)', () => {
  async function mounted(layout: 'root' | 'nested') {
    const container = await mkdtemp(join(tmpdir(), 'hephi 工作 区-')); cleanup.push(container)
    const checkout = layout === 'root' ? container : join(container, 'repo')
    await mkdir(join(checkout, 'src', '价格 模块'), { recursive: true })
    await run('git', ['init', '-q'], { cwd: checkout })
    const outside = await mkdtemp(join(tmpdir(), 'hephi-outside-')); cleanup.push(outside)
    await symlink(outside, join(checkout, 'src', 'escape'))
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-guard-')); cleanup.push(stateDir)
    const card = { version: 1, goal: 'g', acceptance: [{ id: 'AC1', text: 't', check: 'tests', paths: ['src/**'] }] }
    await prepareActivation({
      HEPHI_ENABLED: '1', HEPHI_STATE_DIR: stateDir, HEPHI_BASE_COMMIT: 'a'.repeat(40), HEPHI_ALLOWED_PATHS: 'src/**,docs/**',
      DSH_SUPERAGENT_TICKET: 't1', DSH_SUPERAGENT_DIR: container, DSH_SUPERAGENT_GITHUB_REPOSITORY: 'e/p', DSH_SUPERAGENT_GITHUB_NUMBER: '1',
      HEPHI_ISSUE_BODY: ['```hephi-task', JSON.stringify(card), '```'].join('\n'),
      HEPHI_VERIFICATION_CHECKS: JSON.stringify({ version: 1, checks: [{ id: 'tests', kind: 'test', purpose: 'p', command: 'true', args: [] }] }),
    })
    let preExecute: ((e: ToolExecution, next: () => Promise<unknown>) => Promise<any>) | undefined
    const agent = {
      session: { header: { id: 'worker-t1', agentPreset: 'dsh-superagent-worker', cwd: checkout } },
      ctx: {
        on: (name: string, fn: typeof preExecute) => { if (name === 'tools/pre-execute') preExecute = fn; return () => true },
        tools: { register: () => () => true, guard: () => () => true },
        systemPrompt: { section: () => () => true },
      },
    } as unknown as Agent
    mountWorkerGate({} as Context, agent, { stateDir })
    const decide = async (name: string, args: unknown) => {
      const result = await preExecute!({ name, arguments: args, token: Symbol(), callId: 'c' } as unknown as ToolExecution, async () => ({ kind: 'allow' }))
      return result.kind === 'deny' ? result.reason as string : 'allow'
    }
    return { checkout, outside, decide }
  }

  for (const layout of ['root', 'nested'] as const) {
    it(`resolves paths against the ${layout} checkout`, async () => {
      const { checkout, outside, decide } = await mounted(layout)
      expect(await decide('edit', { path: 'src/价格 模块/总价.js' })).toBe('allow')
      expect(await decide('write', { file_path: join(checkout, 'src/new file.js') })).toBe('allow')
      expect(await decide('write', { filePath: 'docs/a.md' })).toContain('task scope does not include docs/a.md')
      expect(await decide('write', { path: 'anything/src/price.js' })).toContain('does not include anything/src/price.js')
      expect(await decide('write', { path: '/etc/passwd' })).toContain('outside the Worker checkout')
      expect(await decide('write', { path: '../x/src/a.js' })).toContain('outside the Worker checkout')
      expect(await decide('write', { path: join(outside, 'src/a.js') })).toContain('outside the Worker checkout')
      expect(await decide('write', { path: 'src/escape/a.js' })).toContain('outside the Worker checkout')
      expect(await decide('write', { content: 'x' })).toBe('allow')
      expect(await decide('bash', { command: 'true' })).toBe('allow')
    })
  }
})
