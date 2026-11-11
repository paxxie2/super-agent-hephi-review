/**
 * v5.4 §2 执行中护栏的两个新增机制（本地机制测试，不连真实宿主）：
 *
 * ① 增量 diff 反馈（prompt-only）：`hephi_check` 的记录里带 `incrementalChanges`，工具文本追加
 *    一行摘要；不参与任何 deny/allow 判定。
 * ② 计划宽度记录（record-only）：check 记录写 `planWidth`，ready 写 `plan.width` 的 allow 审计行；
 *    不参与、也不改变 ready 判定。
 *
 * 判定不变的口径：同一输入分别在有/无这两项记录时，check 的 status/exitCode/reason 与 ready 的
 * ok/reason 必须完全一致；新增的只有记录字段与审计行。
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActivationContract } from '../../src/control/activation.js'
import type { VerificationCheck } from '../../src/contracts/checks.js'
import { incrementalSummaryLine, runCheck } from '../../src/control/check-runner.js'
import { checkRunDir, readRuns } from '../../src/control/check-store.js'
import { createEvidenceVerifier } from '../../src/control/evidence-verifier.js'
import { appendPlan } from '../../src/control/plan-store.js'
import type { ReadyVerification } from '../../src/control/ready-gate.js'
import { checkResultText } from '../../src/control/worker-mount.js'

const run = promisify(execFile)
const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

const build: VerificationCheck = {
  id: 'build', kind: 'build', purpose: 'build', command: 'true', args: [], cwd: '.',
  required: true, timeoutMs: 5000,
}

/** Base commit, then one patch commit that writes `patched` files. */
async function repo(patched: Record<string, string> = { 'a.txt': 'patched\n' }): Promise<{ dir: string; baseSha: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'hephi-v54-repo-'))
  cleanup.push(dir)
  await run('git', ['init', '-b', 'main', dir])
  await run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir })
  await run('git', ['config', 'user.name', 'v5.4 guardrail test'], { cwd: dir })
  await run('git', ['remote', 'add', 'origin', 'git@github.com:example/v54-guardrails-fixture.git'], { cwd: dir })
  await writeFile(join(dir, 'a.txt'), 'base\n')
  await writeFile(join(dir, 'keep.txt'), 'keep\n')
  await run('git', ['add', '.'], { cwd: dir })
  await run('git', ['commit', '-m', 'base'], { cwd: dir })
  const baseSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
  await commit(dir, patched, 'patch')
  return { dir, baseSha }
}

async function commit(dir: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [path, body] of Object.entries(files)) {
    const target = join(dir, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, body)
  }
  await run('git', ['add', '.'], { cwd: dir })
  await run('git', ['commit', '-m', message], { cwd: dir })
  return (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
}

function contract(dir: string, baseSha: string): ActivationContract {
  return {
    enabled: true, ticketId: 'ticket-1', repository: 'example/v54-guardrails-fixture', issueNumber: 42,
    workspace: dir, baseRef: 'main', baseSha, allowedPaths: ['**'], requirePullRequest: false,
    verification: { version: 1, checks: [{ ...build }] }, contractHash: 'sha256:test',
  }
}

function outer(checkId: string): ToolExecution {
  return {
    callId: `outer-${checkId}` as never, rootCallId: `outer-${checkId}` as never, name: 'hephi_check',
    agent: { id: 'worker-session' } as never, arguments: { checkId }, signal: new AbortController().signal, token: Symbol(checkId) as never,
  }
}

function ready(workspace: string): ToolExecution {
  return {
    callId: 'ready-call' as never, rootCallId: 'ready-call' as never, name: 'orchestrator_report',
    arguments: { state: 'ready' }, signal: new AbortController().signal, token: Symbol('ready') as never,
    agent: { session: { header: { cwd: workspace, id: 'worker-session' } } } as never,
  }
}

function nativeTools(exitCode = 0) {
  return {
    execute: async () => ({
      isError: false as const, content: [],
      value: {
        kind: 'foreground', cwd: '/work', exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1000,
        stdout: { text: 'ok\n', truncated: false }, stderr: { text: '', truncated: false },
      },
    }),
  }
}

function denialReason(result: ReadyVerification): string {
  if (result.ok) throw new Error('expected the ready check to be denied')
  return result.reason
}

type DecisionRow = { rule: string; effectiveDecision: string; wouldDecision: string; mode: string; tool: string; planFiles?: number; changedFiles?: number; ratio?: number }

async function setup(patched?: Record<string, string>) {
  const r = await repo(patched)
  const stateDir = await mkdtemp(join(tmpdir(), 'hephi-v54-state-'))
  cleanup.push(stateDir)
  const c = contract(r.dir, r.baseSha)
  const execute = (checkId: string, tools = nativeTools()) => runCheck({ stateDir, contract: c, checkId, outer: outer(checkId), tools })
  const verify = () => createEvidenceVerifier({ stateDir })(c, ready(r.dir))
  const planFiles = (files: string[]) => appendPlan(stateDir, c.ticketId, { contractHash: c.contractHash, files })
  const decisions = async (): Promise<DecisionRow[]> => {
    try {
      const text = await readFile(join(stateDir, 'hephi', c.ticketId, 'decisions.jsonl'), 'utf8')
      return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as DecisionRow)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
  const tamperOutput = async (): Promise<void> => {
    const record = (await readRuns(stateDir, c.ticketId)).at(-1)!
    await writeFile(join(checkRunDir(stateDir, c.ticketId, record.runId), 'output.log'), 'tampered\n')
  }
  return { r, stateDir, c, execute, verify, planFiles, decisions, tamperOutput }
}

// ---- ① 增量 diff 反馈（prompt-only）----------------------------------------
describe('v5.4 §2 ① incremental change feedback is prompt-only', () => {
  it('records the delta since the previous check and renders exactly one summary line', async () => {
    const x = await setup()
    const first = await x.execute('build')
    expect(first.status).toBe('passed')
    // first check: measured from the contract base (single patched file: +1/-1)
    expect(first.incrementalChanges).toMatchObject({ scope: 'base', files: 1, addedLines: 1, removedLines: 1 })
    expect(first.incrementalChanges!.sinceLastCheckSeconds).toBeUndefined()
    expect(incrementalSummaryLine(first)).toBe('incremental since base: 1 files, +1/-1')

    // three files change between the two checks: a.txt +1 line, two new files +2 and +1
    await commit(x.r.dir, { 'a.txt': 'patched\nsecond\n', 'src/new1.js': '1\n2\n', 'src/new2.js': '3\n' }, 'change between checks')
    const second = await x.execute('build')
    expect(second.status).toBe('passed')
    expect(second.incrementalChanges).toMatchObject({
      scope: 'previous-check', files: 3, addedLines: 4, removedLines: 0,
      fromCommit: first.before.headCommit, toCommit: second.before.headCommit,
    })
    expect(second.incrementalChanges!.sinceLastCheckSeconds).toBeGreaterThanOrEqual(0)
    expect(incrementalSummaryLine(second)).toMatch(/^incremental since last check: 3 files, \+4\/-0 \(\d+s since last check\)$/)

    // the tool text is the JSON result plus exactly one appended human-readable line
    const text = checkResultText(second)
    expect(text.startsWith(JSON.stringify(second))).toBe(true)
    expect(text.split('\n')).toHaveLength(2)
    expect(text).toContain('incremental since last check: 3 files, +4/-0')
    // prompt-only: the presence of the field does not change the check verdict
    expect(second.status).toBe(first.status)
    expect(second.exitCode).toBe(first.exitCode)
  })

  it('reports a zero delta when the workspace did not move between checks (prompt-only)', async () => {
    const x = await setup()
    await x.execute('build')
    const second = await x.execute('build')
    expect(second.status).toBe('passed')
    expect(second.incrementalChanges).toMatchObject({ scope: 'previous-check', files: 0, addedLines: 0, removedLines: 0 })
    expect(incrementalSummaryLine(second)).toContain('incremental since last check: 0 files, +0/-0')
  })

  it('leaves a failing check verdict and reason identical while still recording the delta', async () => {
    const x = await setup()
    const failed = await x.execute('build', nativeTools(1))
    expect(failed.status).toBe('blocked')
    expect(failed.exitCode).toBe(1)
    expect(failed.reason).toContain('check did not exit successfully: 1')
    expect(failed.incrementalChanges).toBeDefined()
    // The delta is feedback only: the same failing command still yields the same verdict/reason.
    const failedAgain = await x.execute('build', nativeTools(1))
    expect(failedAgain.status).toBe(failed.status)
    expect(failedAgain.exitCode).toBe(failed.exitCode)
    expect(failedAgain.reason).toBe(failed.reason)
    expect(checkResultText(failedAgain)).toContain('incremental since last check: 0 files, +0/-0')
  })
})

// ---- ② 计划宽度记录（record-only）------------------------------------------
describe('v5.4 §2 ② plan width is recorded, never enforced', () => {
  const threeFiles = { 'a.txt': 'patched\n', 'src/x.js': 'x\n', 'docs/y.md': 'y\n' }

  it('writes planWidth on the check record and a plan.width allow row without changing ready', async () => {
    const withPlan = await setup(threeFiles)
    // plan declares 5 files, the final diff changes 3 → ratio 0.6
    await withPlan.planFiles(['a.txt', 'src/x.js', 'docs/y.md', 'extra1.md', 'extra2.md'])
    const record = await withPlan.execute('build')
    expect(record.planWidth).toEqual({ planFiles: 5, changedFiles: 3, ratio: 0.6 })

    expect(await withPlan.verify()).toEqual({ ok: true })
    const rows = await withPlan.decisions()
    const widthRows = rows.filter(row => row.rule === 'plan.width')
    expect(widthRows).toHaveLength(1)
    expect(widthRows[0]).toMatchObject({
      effectiveDecision: 'allow', wouldDecision: 'allow', mode: 'enforce', tool: 'orchestrator_report',
      planFiles: 5, changedFiles: 3,
    })
    expect(widthRows[0]!.ratio).toBeCloseTo(0.6)
    expect(rows.at(-1)).toMatchObject({ rule: 'ready.pass', effectiveDecision: 'allow' })

    // identical input without a plan: same allow verdict, and no plan.width row is invented.
    const withoutPlan = await setup(threeFiles)
    await withoutPlan.execute('build')
    expect(await withoutPlan.verify()).toEqual({ ok: true })
    expect((await withoutPlan.decisions()).filter(row => row.rule === 'plan.width')).toHaveLength(0)
  })

  it('keeps existing deny verdicts identical with and without a plan record', async () => {
    const withPlan = await setup(threeFiles)
    await withPlan.planFiles(['a.txt', 'src/x.js', 'docs/y.md'])
    await withPlan.execute('build')
    await withPlan.tamperOutput()
    const planResult = await withPlan.verify()

    const withoutPlan = await setup(threeFiles)
    await withoutPlan.execute('build')
    await withoutPlan.tamperOutput()
    const baselineResult = await withoutPlan.verify()

    expect(planResult.ok).toBe(false)
    expect(baselineResult.ok).toBe(false)
    expect(denialReason(planResult)).toBe(denialReason(baselineResult))
    // The denial path is not extended with a plan.width row (record-only stays out of the verdict).
    expect((await withPlan.decisions()).filter(row => row.rule === 'plan.width')).toHaveLength(0)
    // The ready verdict itself is still recorded exactly as before.
    expect((await withPlan.decisions()).at(-1)).toMatchObject({ rule: 'ready.other', effectiveDecision: 'deny' })
  })

  it('does not change the existing plan.outside-plan denial', async () => {
    const x = await setup(threeFiles)
    await x.planFiles(['a.txt']) // narrower than the final 3-file diff
    await x.execute('build')
    const result = await x.verify()
    expect(result.ok).toBe(false)
    expect(denialReason(result)).toContain('plan.outside-plan')
    expect((await x.decisions()).filter(row => row.rule === 'plan.width')).toHaveLength(0)
    expect((await x.decisions()).at(-1)).toMatchObject({ rule: 'plan.outside-plan', effectiveDecision: 'deny' })
  })
})
