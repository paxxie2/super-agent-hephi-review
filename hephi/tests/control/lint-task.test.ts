import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { main as cliMain, type CliIo } from '../../src/cli.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const CHECK_TASK = join(REPO_ROOT, 'eval', 'check-task.mjs')
const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rmSync(path, { recursive: true, force: true })))
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: message => out.push(message), err: message => err.push(message) }, out, err }
}

async function lintTask(bundle: unknown): Promise<{ code: number; out: string; err: string; json: Record<string, unknown> | null }> {
  const dir = tempDir('hephi-lint-focus-')
  const file = join(dir, 'task.json')
  writeFileSync(file, typeof bundle === 'string' ? bundle : JSON.stringify(bundle, null, 2))
  const captured = captureIo()
  const code = await cliMain(['lint-task', file], process.env, captured.io)
  const out = captured.out.join('\n')
  let json: Record<string, unknown> | null = null
  if (out.trim().startsWith('{')) {
    try { json = JSON.parse(out) as Record<string, unknown> } catch { json = null }
  }
  return { code, out, err: captured.err.join('\n'), json }
}

function check(name: string, kind: 'build' | 'test', purpose: string, required = true): Record<string, unknown> {
  return { id: name, kind, purpose, command: 'node', args: ['scripts/test.js'], cwd: '.', required, timeoutMs: 60000 }
}

function bundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ticketId: 'ticket-1',
    allowedPaths: ['src/**'],
    checks: [check('full-regression', 'test', 'full regression suite')],
    task: {
      version: 1,
      goal: 'fix a defect',
      outOfScope: [],
      acceptance: [{ id: 'a1', text: 'behaviour', check: 'full-regression', paths: ['src/**'] }],
    },
    ...overrides,
  }
}

function focusRules(result: { out: string }): string[] {
  return result.out.split('\n').filter(line => line.startsWith('focus: ')).map(line => line.split(' ')[1] ?? '')
}

function checkTaskCli(args: string[]): { code: number; out: string; err: string } {
  try {
    const stdout = execFileSync(process.execPath, [CHECK_TASK, ...args], { encoding: 'utf8', stdio: 'pipe' })
    return { code: 0, out: stdout, err: '' }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { code: failure.status ?? 1, out: failure.stdout ?? '', err: failure.stderr ?? '' }
  }
}

function envTask(prefix: string, mutate: (dir: string, task: Record<string, unknown>) => void): string {
  const dir = tempDir(prefix)
  cpSync(join(REPO_ROOT, 'eval', 'tasks', 'example'), dir, { recursive: true })
  const file = join(dir, 'task.json')
  const task = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  task.environment = { offline: true, lockfile: 'package-lock.json', commandsMustMatchOffline: false }
  mutate(dir, task)
  writeFileSync(file, `${JSON.stringify(task, null, 2)}\n`, 'utf8')
  return dir
}

describe('hephi lint-task — C4.8 focus hints (advisory only)', () => {
  it('a well-scoped bundle has no focus hints and still exits 0', async () => {
    const result = await lintTask(bundle())
    expect(result.code).toBe(0)
    expect(result.out).toContain('HEPHI task lint: PASS')
    expect(result.out).not.toContain('focus:')
    expect(result.err).toBe('')
  })

  it('focus.required-too-many fires when more than five checks are required', async () => {
    const checks = Array.from({ length: 6 }, (_, index) => check(`required-${index + 1}`, 'test', index === 0 ? 'full regression suite' : `unit ${index + 1}`))
    const result = await lintTask(bundle({ checks, task: { version: 1, goal: 'g', acceptance: [{ id: 'a1', text: 'x', check: 'required-1', paths: ['src/**'] }] } }))
    expect(result.code).toBe(0)
    expect(focusRules(result)).toContain('focus.required-too-many')
    expect(result.out).toMatch(/focus: focus\.required-too-many 6 required checks/)
  })

  it('focus.check-not-required fires when acceptance names a non-required check', async () => {
    const result = await lintTask(bundle({
      checks: [check('full-regression', 'test', 'full regression suite'), check('unit-extra', 'test', 'extra unit', false)],
      task: {
        version: 1,
        goal: 'g',
        acceptance: [
          { id: 'a1', text: 'x', check: 'full-regression', paths: ['src/**'] },
          { id: 'a2', text: 'y', check: 'unit-extra', paths: ['src/**'] },
        ],
      },
    }))
    expect(result.code).toBe(0)
    expect(focusRules(result)).toContain('focus.check-not-required')
  })

  it('focus.acceptance-check-not-test fires when one check is shared by more than five acceptance items', async () => {
    const acceptance = Array.from({ length: 6 }, (_, index) => ({
      id: `a${index + 1}`, text: `item ${index + 1}`, check: 'full-regression', paths: ['src/**'],
    }))
    const result = await lintTask(bundle({
      task: { version: 1, goal: 'g', acceptance },
    }))
    expect(result.code).toBe(0)
    expect(focusRules(result)).toContain('focus.acceptance-check-not-test')
    expect(result.out).toMatch(/shared by 6 acceptance items/)
  })

  it('focus.broad-scope fires for broad globs and reports the rule', async () => {
    const result = await lintTask(bundle({ allowedPaths: ['**'] }))
    expect(result.code).toBe(0)
    expect(focusRules(result)).toContain('focus.broad-scope')
  })

  it('focus.no-regression fires when no required test check looks like the full regression', async () => {
    const result = await lintTask(bundle({
      checks: [check('unit-price', 'test', 'unit tests for pricing')],
      task: { version: 1, goal: 'g', acceptance: [{ id: 'a1', text: 'x', check: 'unit-price', paths: ['src/**'] }] },
    }))
    expect(result.code).toBe(0)
    expect(focusRules(result)).toContain('focus.no-regression')
  })

  it('focus.unused-check fires for checks neither required nor referenced', async () => {
    const result = await lintTask(bundle({
      checks: [check('full-regression', 'test', 'full regression suite'), check('unused', 'test', 'never used', false)],
    }))
    expect(result.code).toBe(0)
    expect(focusRules(result)).toContain('focus.unused-check')
  })

  it('focus.tests-outside-paths fires when an acceptance item names tests outside its own paths', async () => {
    const v3 = (paths: string[]) => bundle({
      allowedPaths: ['src/**', 'tests/**'],
      task: {
        version: 3, kind: 'code', goal: 'fix a defect', outOfScope: ['nothing else'],
        acceptance: [{ id: 'a1', text: 'behaviour', check: 'full-regression', paths, tests: ['tests/price.test.js'] }],
      },
    })
    const outside = await lintTask(v3(['src/price.js']))
    expect(outside.code).toBe(0)
    expect(focusRules(outside)).toContain('focus.tests-outside-paths')
    expect(outside.out).toContain('tests/price.test.js')
    const inside = await lintTask(v3(['src/price.js', 'tests/price.test.js']))
    expect(inside.code).toBe(0)
    expect(focusRules(inside)).not.toContain('focus.tests-outside-paths')
  })

  it('--json exposes focus entries as {rule,message}', async () => {
    const dir = tempDir('hephi-lint-focus-json-')
    const file = join(dir, 'task.json')
    writeFileSync(file, JSON.stringify(bundle({
      checks: [check('unit-price', 'test', 'unit tests')],
      task: { version: 1, goal: 'g', acceptance: [{ id: 'a1', text: 'x', check: 'unit-price', paths: ['src/**'] }] },
    }), null, 2))
    const captured = captureIo()
    const code = await cliMain(['lint-task', file, '--json'], process.env, captured.io)
    expect(code).toBe(0)
    const payload = JSON.parse(captured.out.join('\n')) as { focus: Array<{ rule: string; message: string }> }
    expect(Array.isArray(payload.focus)).toBe(true)
    expect(payload.focus.some(item => item.rule === 'focus.no-regression' && typeof item.message === 'string')).toBe(true)
  })

  // B1.1/T03: tests-outside-paths 提示语义 — 只读测试可作验收证据；确需编辑才补 paths。
  const v3Card = (paths: string[]) => bundle({
    allowedPaths: ['src/**', 'tests/**'],
    task: {
      version: 3, kind: 'code', goal: 'fix a defect', outOfScope: ['nothing else'],
      acceptance: [{ id: 'a1', text: 'behaviour', check: 'full-regression', paths, tests: ['tests/price.test.js'] }],
    },
  })

  it('B1.1/T03 read-only baseline tests: hint stays advisory (exit 0) and says they can remain acceptance evidence', async () => {
    const result = await lintTask(v3Card(['src/price.js']))
    expect(result.code).toBe(0) // focus hints are advisory and never fail the lint
    expect(focusRules(result)).toContain('focus.tests-outside-paths')
    expect(result.out).toContain('existing tests that already fail on the baseline can remain read-only acceptance evidence')
  })

  it('B1.1/T03 tests that need editing: hint is actionable — add to paths only then', async () => {
    const result = await lintTask(v3Card(['src/price.js']))
    expect(result.code).toBe(0)
    expect(result.out).toContain('add them to paths only if the task requires creating or updating them')
    expect(result.out).toContain('tests/price.test.js')
  })

  it('B1.1/T03 explicitly authorized cross-file change: adding the test to paths clears the hint', async () => {
    const result = await lintTask(v3Card(['src/price.js', 'tests/price.test.js']))
    expect(result.code).toBe(0)
    expect(focusRules(result)).not.toContain('focus.tests-outside-paths')
    expect(result.out).toContain('HEPHI task lint: PASS')
  })
})

describe('check-task — C4.6 optional environment block', () => {
  it('valid offline environment with lockfile passes --dry-run', () => {
    const dir = envTask('hephi-env-ok-', (dir) => {
      writeFileSync(join(dir, 'package-lock.json'), '{}\n')
    })
    const result = checkTaskCli([dir, '--dry-run'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('PASS structure')
  })

  it('undeclared environment keeps the old behavior (no enforcement)', () => {
    const dir = tempDir('hephi-env-none-')
    cpSync(join(REPO_ROOT, 'eval', 'tasks', 'example'), dir, { recursive: true })
    const result = checkTaskCli([dir, '--dry-run'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('PASS structure')
  })

  it('online install command in offline environment fails and lists the command', () => {
    const dir = envTask('hephi-env-online-', (dir) => {
      writeFileSync(join(dir, 'package-lock.json'), '{}\n')
      writeFileSync(join(dir, 'hidden-test.sh'), '#!/bin/sh\nnpm install lodash\nexit 1\n')
    })
    const result = checkTaskCli([dir, '--dry-run'])
    expect(result.code).toBe(1)
    expect(result.out).toContain('npm install lodash')
  })

  it('missing lockfile is reported as a dry-run warning (full mode enforces it in --self-test)', () => {
    const dir = envTask('hephi-env-missing-', () => {})
    const result = checkTaskCli([dir, '--dry-run'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('lockfile')
  })

  it('check-task --self-test covers valid offline, missing lockfile, online command and undeclared', () => {
    const result = checkTaskCli(['--self-test'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('environment 合法 offline')
    expect(result.out).toContain('environment offline 但缺 lockfile')
    expect(result.out).toContain('environment offline 但 hidden-test 含 npm install')
    expect(result.out).toContain('未声明 environment')
  })
})
