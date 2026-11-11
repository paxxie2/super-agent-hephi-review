import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActivationContract } from '../../src/control/activation.js'
import { appendPlan, readPlan } from '../../src/control/plan-store.js'
import { disciplineProblems, summarizeChanges, advisoryBudgetWarnings, type ChangeSummary } from '../../src/control/discipline.js'

// B2 执行中护栏机制验证（v5.4 B2.1，口径按真实存在的机制，b4b74ad）：
// ① 计划宽度：PlanSummary.files（声明文件并集）+ entries（版本计数），readPlan 只合并本 contractHash；
// ② 增量改动感知：summarizeChanges 从 git diff 统计 files/changedLines/deleted/added；
// ③ 合法不误拦：in-scope 多文件改动 disciplineProblems=[]，且计划宽度比值可由两侧 files.length 计算。
// 硬预算误拦（ADVISORY_BUDGET vs 显式 budget）已由 budget-advisory.test.ts 9 条覆盖，此处不重复。

const run = promisify(execFile)
const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(p => rm(p, { recursive: true, force: true }))) })

async function gitRepo(): Promise<{ dir: string; baseSha: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'hephi-b2-repo-'))
  cleanup.push(dir)
  await run('git', ['init', '-b', 'main', dir])
  await run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir })
  await run('git', ['config', 'user.name', 'B2 guardrail test'], { cwd: dir })
  await writeFile(join(dir, 'src-a.js'), 'a1\na2\n')
  await writeFile(join(dir, 'src-b.js'), 'b1\n')
  await run('git', ['add', '.'], { cwd: dir })
  await run('git', ['commit', '-m', 'base'], { cwd: dir })
  const baseSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
  return { dir, baseSha }
}

async function commit(dir: string, message: string): Promise<void> {
  await run('git', ['add', '.'], { cwd: dir })
  await run('git', ['commit', '-m', message], { cwd: dir })
}

const acceptance = [{ id: 'a1', text: 'fix', check: 'tests', paths: ['src/**', 'lib/**', 'tests/**'] }]
const contract = (task: ActivationContract['task']): ActivationContract =>
  ({ allowedPaths: ['src/**', 'lib/**', 'tests/**'], task } as unknown as ActivationContract)

describe('B2 ① plan width: PlanSummary files union + entries count (readPlan)', () => {
  it('merges appended plan versions into a deduplicated files union and counts entries', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-b2-state-'))
    cleanup.push(stateDir)
    const hash = 'sha256:contract-a'
    await appendPlan(stateDir, 'ticket-1', { contractHash: hash, files: ['src/price.js', 'src/util.js'] })
    await appendPlan(stateDir, 'ticket-1', { contractHash: hash, files: ['src/price.js', 'tests/price.test.ts'] })
    const plan = await readPlan(stateDir, 'ticket-1', hash)
    expect(plan).toBeDefined()
    expect(plan!.files.sort()).toEqual(['src/price.js', 'src/util.js', 'tests/price.test.ts'])
    expect(plan!.entries).toBe(2)
    expect(plan!.contractHash).toBe(hash)
  })

  it('a plan for a different contract hash never applies (width is per-contract)', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-b2-state-'))
    cleanup.push(stateDir)
    await appendPlan(stateDir, 'ticket-1', { contractHash: 'sha256:contract-a', files: ['src/price.js'] })
    expect(await readPlan(stateDir, 'ticket-1', 'sha256:contract-b')).toBeUndefined()
    expect((await readPlan(stateDir, 'ticket-1', 'sha256:contract-a'))!.entries).toBe(1)
  })
})

describe('B2 ② incremental change awareness: summarizeChanges from a real git diff', () => {
  it('counts modified, added and deleted files and their changed lines', async () => {
    const r = await gitRepo()
    // modify src-a.js (2 removed, 1 added), add lib/new.js (3 lines), delete src-b.js (1 line)
    await writeFile(join(r.dir, 'src-a.js'), 'a1\n')
    await mkdir(join(r.dir, 'lib'))
    await writeFile(join(r.dir, 'lib', 'new.js'), 'n1\nn2\nn3\n')
    await run('git', ['rm', '-q', 'src-b.js'], { cwd: r.dir })
    await commit(r.dir, 'changes')
    const summary = await summarizeChanges(r.dir, r.baseSha)
    expect(summary.files.sort()).toEqual(['lib/new.js', 'src-a.js', 'src-b.js'])
    // src-a: +0/-1 (line a2 removed), lib/new.js: +3/-0, src-b.js deletion: +0/-1 → 5 changed lines
    expect(summary.changedLines).toBe(5)
    expect(summary.added).toEqual(['lib/new.js'])
    expect(summary.deleted).toEqual(['src-b.js'])
  })

  it('a clean workspace at the base commit reports an empty change summary', async () => {
    const r = await gitRepo()
    const summary = await summarizeChanges(r.dir, r.baseSha)
    expect(summary).toEqual({ files: [], changedLines: 0, deleted: [], added: [] })
  })
})

describe('B2 ③ legal changes are not falsely blocked', () => {
  const inScopeChanges = (): ChangeSummary => ({
    files: ['src/price.js', 'src/util.js', 'lib/new.js'], changedLines: 120, deleted: [], added: ['lib/new.js'],
  })

  it('an in-scope multi-file change without a budget has no discipline problems', async () => {
    const c = contract({ version: 3, kind: 'code', goal: 'g', outOfScope: [], acceptance, protect: [] })
    expect(disciplineProblems(c, inScopeChanges())).toEqual([])
  })

  it('plan width vs actual change width is computable from the recorded fields', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-b2-state-'))
    cleanup.push(stateDir)
    const hash = 'sha256:contract-a'
    await appendPlan(stateDir, 'ticket-1', { contractHash: hash, files: ['src/price.js', 'src/util.js', 'lib/new.js'] })
    const plan = await readPlan(stateDir, 'ticket-1', hash)
    const actual = inScopeChanges()
    // Both widths are recorded numbers, so the coverage ratio is a plain computation.
    expect(plan!.files.length).toBe(3)
    expect(actual.files.every(file => plan!.files.includes(file))).toBe(true)
    expect(actual.files.length / plan!.files.length).toBe(1)
  })

  it('a no-budget change inside the advisory limits raises neither problems nor warnings', async () => {
    const c = contract({ version: 3, kind: 'code', goal: 'g', outOfScope: [], acceptance, protect: [] })
    const changes = inScopeChanges()
    expect(disciplineProblems(c, changes)).toEqual([])
    expect(advisoryBudgetWarnings(c, changes)).toEqual([])
  })
})
