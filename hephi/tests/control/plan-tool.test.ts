/**
 * C4.2 正常形式：`hephi_plan` 工具 + write/edit 实时拦截（本地单测，不连真实宿主）。
 *
 * 可声称边界：只证明本地机制（工具注册/拦截/决策日志/合同绑定）与既有 ready 复核未回归；
 * 不证明真实宿主上的工具可见性或模型行为。规则 `plan.recorded` / `plan.outside-plan`
 * 的 decisions-format.md 登记由 Lead 统一补（代码注释已标注 pending）。
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import {
  activationIntentPath, activationPath, loadActivation, prepareActivation,
} from '../../src/control/activation.js'
import { appendPlan, planPath, readPlan } from '../../src/control/plan-store.js'
import { mountWorkerGate } from '../../src/control/worker-mount.js'

const run = promisify(execFile)
const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

const TICKET = 'ticket-1'
const fence = (value: unknown) => ['```hephi-task', JSON.stringify(value, null, 2), '```'].join('\n')

async function repo(): Promise<{ dir: string; baseSha: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'hephi-plan-tool-repo-'))
  cleanup.push(dir)
  await run('git', ['init', '-b', 'main', dir])
  await run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir })
  await run('git', ['config', 'user.name', 'Plan tool test'], { cwd: dir })
  await run('git', ['remote', 'add', 'origin', 'git@github.com:example/plan-tool-fixture.git'], { cwd: dir })
  for (const [path, body] of [
    ['a.txt', 'base\n'],
    ['src/app.js', 'module.exports = 1\n'],
    ['tests/keep.test.js', 'assert.equal(1, 1)\n'],
    ['docs/notes.md', 'notes\n'],
  ] as const) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), body)
  }
  await run('git', ['add', '.'], { cwd: dir })
  await run('git', ['commit', '-m', 'base'], { cwd: dir })
  const baseSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
  await writeFile(join(dir, 'src/app.js'), 'module.exports = 2\n')
  await run('git', ['add', '.'], { cwd: dir })
  await run('git', ['commit', '-m', 'patch'], { cwd: dir })
  return { dir, baseSha }
}

const taskBody = (over: { paths?: string[] } = {}) => fence({
  version: 1,
  goal: 'change the app module',
  outOfScope: [],
  acceptance: [{ id: 'AC1', text: 'app still works', check: 'tests', paths: over.paths ?? ['src/**', 'tests/**'] }],
})

function env(stateDir: string, repoDir: string, baseSha: string, over: {
  issueBody?: string | null; allowedPaths?: string; enforcement?: 'enforce' | 'shadow'; mode?: 'native' | 'staged'; baseRef?: string; requirePlan?: boolean
} = {}): NodeJS.ProcessEnv {
  return {
    HEPHI_ENABLED: '1', HEPHI_STATE_DIR: stateDir, HEPHI_BASE_COMMIT: baseSha,
    HEPHI_ALLOWED_PATHS: over.allowedPaths ?? 'src/**,tests/**',
    DSH_SUPERAGENT_TICKET: TICKET, DSH_SUPERAGENT_DIR: repoDir,
    DSH_SUPERAGENT_GITHUB_REPOSITORY: 'example/plan-tool-fixture', DSH_SUPERAGENT_GITHUB_NUMBER: '7',
    HEPHI_VERIFICATION_CHECKS: JSON.stringify({
      version: 1,
      checks: [{ id: 'tests', kind: 'test', purpose: 'project tests', command: 'true', args: [], required: true, timeoutMs: 5000 }],
      ...(over.requirePlan === undefined ? {} : { requirePlan: over.requirePlan }),
    }),
    // The plan tool needs a frozen task card; tests without one pass `issueBody: null`.
    ...(over.issueBody === null ? {} : { HEPHI_ISSUE_BODY: over.issueBody ?? taskBody() }),
    ...(over.enforcement === undefined ? {} : { HEPHI_ENFORCEMENT: over.enforcement }),
    ...(over.mode === undefined ? {} : { HEPHI_EXECUTION_MODE: over.mode }),
    ...(over.baseRef === undefined ? {} : { HEPHI_BASE_REF: over.baseRef }),
  }
}

type PreExecute = (execution: ToolExecution, next: () => Promise<any>) => Promise<any>
type RegisteredTool = { name: string; execute: (args: any, execution: ToolExecution) => Promise<any> }

function fakeAgent(cwd: string) {
  const listeners = new Map<string, Function>()
  const registered: RegisteredTool[] = []
  const agent = {
    session: { header: { id: 'worker-ticket-1', agentPreset: 'dsh-superagent-worker', cwd } },
    ctx: {
      on: (name: string, listener: Function) => { listeners.set(name, listener); return () => listeners.delete(name) },
      tools: {
        register: (definition: RegisteredTool) => { registered.push(definition); return () => true },
        guard: () => () => true,
      },
      systemPrompt: { section: () => () => true },
      get: () => undefined,
    },
  } as unknown as Agent
  return {
    agent,
    registered,
    callbacks: () => ({ preExecute: listeners.get('tools/pre-execute') as PreExecute | undefined }),
  }
}

function editCall(path: string, callId = 'call-edit'): ToolExecution {
  return { name: 'edit', arguments: { path }, callId, rootCallId: callId, token: Symbol('edit') as never } as unknown as ToolExecution
}
function planCall(files: string[], callId = 'call-plan', note?: string): ToolExecution {
  return {
    name: 'hephi_plan', arguments: { files, ...(note === undefined ? {} : { note }) }, callId, rootCallId: callId,
    token: Symbol('plan') as never,
  } as unknown as ToolExecution
}
async function decisions(stateDir: string): Promise<any[]> {
  const text = await readFile(join(stateDir, 'hephi', TICKET, 'decisions.jsonl'), 'utf8')
  return text.trim().split('\n').map(line => JSON.parse(line))
}
async function rules(stateDir: string): Promise<string[]> {
  return (await decisions(stateDir)).map(entry => entry.rule)
}
async function planTextExists(stateDir: string): Promise<boolean> {
  try { await readFile(planPath(stateDir, TICKET), 'utf8'); return true } catch { return false }
}

async function mount(stateDir: string, repoDir: string) {
  const fake = fakeAgent(repoDir)
  const mounted = mountWorkerGate({} as Context, fake.agent, { stateDir })!
  return { fake, mounted }
}
function planToolOf(fake: ReturnType<typeof fakeAgent>): RegisteredTool | undefined {
  return fake.registered.find(tool => tool.name === 'hephi_plan')
}

describe('C4.2 hephi_plan registration', () => {
  it('PT-01: registers the tool for enforce native and staged Workers (task-card contracts)', async () => {
    const r = await repo()
    const nativeDir = await mkdtemp(join(tmpdir(), 'hephi-plan-tool-state-'))
    cleanup.push(nativeDir)
    await prepareActivation(env(nativeDir, r.dir, r.baseSha))
    const native = await mount(nativeDir, r.dir)
    try { expect(planToolOf(native.fake)?.name).toBe('hephi_plan') } finally { native.mounted.dispose() }
    // Compatibility: a contract without a task card keeps its previous tool surface (no plan tool).
    const noTaskDir = await mkdtemp(join(tmpdir(), 'hephi-plan-tool-state-'))
    cleanup.push(noTaskDir)
    await prepareActivation(env(noTaskDir, r.dir, r.baseSha, { issueBody: null }))
    const noTask = await mount(noTaskDir, r.dir)
    try { expect(planToolOf(noTask.fake)).toBeUndefined() } finally { noTask.mounted.dispose() }
    const stagedDir = await mkdtemp(join(tmpdir(), 'hephi-plan-tool-state-'))
    cleanup.push(stagedDir)
    await prepareActivation(env(stagedDir, r.dir, r.baseSha, { mode: 'staged' }))
    const staged = await mount(stagedDir, r.dir)
    try { expect(planToolOf(staged.fake)?.name).toBe('hephi_plan') } finally { staged.mounted.dispose() }
  })

  it('PT-02: does not register the tool in shadow mode and only records wouldDecision', async () => {
    const r = await repo()
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-plan-tool-state-'))
    cleanup.push(stateDir)
    await prepareActivation(env(stateDir, r.dir, r.baseSha, { enforcement: 'shadow' }))
    const { fake, mounted } = await mount(stateDir, r.dir)
    try {
      expect(planToolOf(fake)).toBeUndefined()
      // shadow: an attempted hephi_plan is observed, never executed (no plan file).
      expect(await fake.callbacks().preExecute!(planCall(['src/app.js']), async () => ({ kind: 'allow' as const }))).toEqual({ kind: 'allow' })
      expect(await planTextExists(stateDir)).toBe(false)
      const recorded = (await decisions(stateDir)).filter(entry => entry.rule === 'plan.recorded')
      expect(recorded.at(-1)).toMatchObject({ mode: 'shadow', effectiveDecision: 'allow', wouldDecision: 'allow' })
      // out-of-scope plan in shadow: recorded as would deny, still allowed.
      await fake.callbacks().preExecute!(planCall(['docs/notes.md']), async () => ({ kind: 'allow' as const }))
      expect((await decisions(stateDir)).filter(entry => entry.rule === 'plan.recorded').at(-1)).toMatchObject({ mode: 'shadow', effectiveDecision: 'allow', wouldDecision: 'deny' })
    } finally { mounted.dispose() }
  })

  it('PT-03: does not register the tool when the contract is unavailable', async () => {
    const r = await repo()
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-plan-tool-state-'))
    cleanup.push(stateDir)
    await mkdir(dirname(activationIntentPath(stateDir, TICKET)), { recursive: true })
    await writeFile(activationIntentPath(stateDir, TICKET), `${TICKET}\n`)
    await writeFile(activationPath(stateDir, TICKET), '{ not a contract')
    const { fake, mounted } = await mount(stateDir, r.dir)
    try { expect(planToolOf(fake)).toBeUndefined() } finally { mounted.dispose() }
  })
})

describe('C4.2 hephi_plan execution', () => {
  it('PT-04: records an appended plan version, returns files/entries and logs plan.recorded', async () => {
    const r = await repo()
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-plan-tool-state-'))
    cleanup.push(stateDir)
    await prepareActivation(env(stateDir, r.dir, r.baseSha))
    const { fake, mounted } = await mount(stateDir, r.dir)
    try {
      const tool = planToolOf(fake)!
      expect(await tool.execute({ files: ['src/app.js'] }, planCall(['src/app.js']))).toEqual({ files: ['src/app.js'], entries: 1 })
      expect(await tool.execute({ files: ['tests/keep.test.js'], note: 'extension' }, planCall(['tests/keep.test.js']))).toEqual({ files: ['tests/keep.test.js'], entries: 2 })
      const contract = await loadActivation(activationPath(stateDir, TICKET))
      expect((await readPlan(stateDir, TICKET, contract.contractHash))?.files).toEqual(['src/app.js', 'tests/keep.test.js'])
      const recorded = (await decisions(stateDir)).filter(entry => entry.rule === 'plan.recorded')
      expect(recorded).toHaveLength(2)
      expect(recorded[0]).toMatchObject({ tool: 'hephi_plan', effectiveDecision: 'allow', wouldDecision: 'allow' })
    } finally { mounted.dispose() }
  })

  it('PT-05: rejects planned files outside the contract allowedPaths and writes nothing', async () => {
    const r = await repo()
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-plan-tool-state-'))
    cleanup.push(stateDir)
    await prepareActivation(env(stateDir, r.dir, r.baseSha))
    const { fake, mounted } = await mount(stateDir, r.dir)
    try {
      await expect(planToolOf(fake)!.execute({ files: ['docs/notes.md'] }, planCall(['docs/notes.md']))).rejects.toThrow(/outside the contract allowedPaths/)
      expect(await planTextExists(stateDir)).toBe(false)
      const denied = (await decisions(stateDir)).filter(entry => entry.rule === 'plan.recorded')
      expect(denied.at(-1)).toMatchObject({ tool: 'hephi_plan', effectiveDecision: 'deny', wouldDecision: 'deny' })
      // 空列表同样拒绝。
      await expect(planToolOf(fake)!.execute({ files: [] }, planCall([]))).rejects.toThrow(/at least one planned file/)
    } finally { mounted.dispose() }
  })
})

describe('C4.2 write/edit interception against the plan', () => {
  it('PT-06: with no plan and requirePlan unset (default OPTIONAL), in-scope writes/edits are allowed', async () => {
    const r = await repo()
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-plan-tool-state-'))
    cleanup.push(stateDir)
    await prepareActivation(env(stateDir, r.dir, r.baseSha))
    const { fake, mounted } = await mount(stateDir, r.dir)
    try {
      // 可声称边界：C4.2 默认未启用（verification.requirePlan 缺省 false）时是 OPTIONAL——
      // 允许不声明计划；这不是“已生效的强制拦截”，明确的绕过路径见 PR25-M1。
      expect(await fake.callbacks().preExecute!(editCall('tests/keep.test.js'), async () => ({ kind: 'allow' as const }))).toEqual({ kind: 'allow' })
    } finally { mounted.dispose() }
  })

  it('PT-07: exact and glob plans allow declared targets, and deny undeclared ones with plan.outside-plan', async () => {
    const r = await repo()
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-plan-tool-state-'))
    cleanup.push(stateDir)
    await prepareActivation(env(stateDir, r.dir, r.baseSha))
    const { fake, mounted } = await mount(stateDir, r.dir)
    try {
      const contract = await loadActivation(activationPath(stateDir, TICKET))
      await appendPlan(stateDir, TICKET, { contractHash: contract.contractHash, files: ['src/app.js', 'src/**'] })
      const next = async () => ({ kind: 'allow' as const })
      expect(await fake.callbacks().preExecute!(editCall('src/app.js'), next)).toEqual({ kind: 'allow' })
      expect(await fake.callbacks().preExecute!(editCall('src/new-module.ts'), next)).toEqual({ kind: 'allow' })
      const denied = await fake.callbacks().preExecute!(editCall('tests/keep.test.js'), next)
      expect(denied).toMatchObject({ kind: 'deny', reason: expect.stringContaining('does not include tests/keep.test.js') })
      expect(await rules(stateDir)).toContain('plan.outside-plan')
    } finally { mounted.dispose() }
  })

  it('PT-08: a plan from another contract hash does not constrain the current Worker', async () => {
    const r = await repo()
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-plan-tool-state-'))
    cleanup.push(stateDir)
    await prepareActivation(env(stateDir, r.dir, r.baseSha))
    // plan bound to a different contract (e.g. before re-prepare) is not the current plan.
    await appendPlan(stateDir, TICKET, { contractHash: `sha256:${'b'.repeat(64)}`, files: ['src/app.js'] })
    const { fake, mounted } = await mount(stateDir, r.dir)
    try {
      expect(await fake.callbacks().preExecute!(editCall('tests/keep.test.js'), async () => ({ kind: 'allow' as const }))).toEqual({ kind: 'allow' })
    } finally { mounted.dispose() }
  })

  it('PT-09: re-prepare reuses the same contract, so the old plan stays effective for edits', async () => {
    const r = await repo()
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-plan-tool-state-'))
    cleanup.push(stateDir)
    await prepareActivation(env(stateDir, r.dir, r.baseSha))
    const before = await loadActivation(activationPath(stateDir, TICKET))
    await appendPlan(stateDir, TICKET, { contractHash: before.contractHash, files: ['src/app.js'] })
    // T11: re-prepare (even with different env) replays the frozen contract; the contractHash
    // and the plan bound to it do not change.
    const rerun = await prepareActivation(env(stateDir, r.dir, r.baseSha, { baseRef: 'release' }))
    expect(rerun.enabled).toBe(true)
    if (rerun.enabled) expect(rerun.reused).toBe(true)
    const after = await loadActivation(activationPath(stateDir, TICKET))
    expect(after.contractHash).toBe(before.contractHash)
    const { fake, mounted } = await mount(stateDir, r.dir)
    try {
      // The reused contract still has the old plan, which does not include this file: denied.
      expect(await fake.callbacks().preExecute!(editCall('tests/keep.test.js'), async () => ({ kind: 'allow' as const })))
        .toMatchObject({ kind: 'deny', reason: expect.stringContaining('does not include tests/keep.test.js') })
    } finally { mounted.dispose() }
  })

  it('PT-10: C1 and plan denials stay distinguishable', async () => {
    const r = await repo()
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-plan-tool-state-'))
    cleanup.push(stateDir)
    const card = {
      version: 2,
      goal: 'keep the acceptance test',
      outOfScope: [],
      protectedAssets: ['tests/**'],
      acceptance: [{ id: 'AC1', text: 'tests still prove behaviour', check: 'tests', paths: ['src/**', 'tests/**'] }],
    }
    await prepareActivation(env(stateDir, r.dir, r.baseSha, { issueBody: fence(card) }))
    const { fake, mounted } = await mount(stateDir, r.dir)
    try {
      const next = async () => ({ kind: 'allow' as const })
      // No plan yet: the C1 protected-asset rule denies first.
      const c1 = await fake.callbacks().preExecute!(editCall('tests/keep.test.js'), next)
      expect(c1).toMatchObject({ kind: 'deny', reason: expect.stringContaining('protected acceptance asset') })
      expect((await decisions(stateDir)).filter(entry => entry.rule === 'asset.unauthorized-modify')).toHaveLength(1)
      // With a plan that omits the protected test, the plan denial is reported instead.
      const contract = await loadActivation(activationPath(stateDir, TICKET))
      await appendPlan(stateDir, TICKET, { contractHash: contract.contractHash, files: ['src/app.js'] })
      const planDenied = await fake.callbacks().preExecute!(editCall('tests/keep.test.js'), next)
      expect(planDenied).toMatchObject({ kind: 'deny', reason: expect.stringContaining('does not include tests/keep.test.js') })
      expect(planDenied).not.toMatchObject({ reason: expect.stringContaining('protected acceptance asset') })
    } finally { mounted.dispose() }
  })

  it('PT-11: shadow mode records the plan wouldDecision but never denies', async () => {
    const r = await repo()
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-plan-tool-state-'))
    cleanup.push(stateDir)
    await prepareActivation(env(stateDir, r.dir, r.baseSha, { enforcement: 'shadow' }))
    const contract = await loadActivation(activationPath(stateDir, TICKET))
    await appendPlan(stateDir, TICKET, { contractHash: contract.contractHash, files: ['src/app.js'] })
    const { fake, mounted } = await mount(stateDir, r.dir)
    try {
      expect(await fake.callbacks().preExecute!(editCall('tests/keep.test.js'), async () => ({ kind: 'allow' as const }))).toEqual({ kind: 'allow' })
      const entry = (await decisions(stateDir)).filter(item => item.rule === 'plan.outside-plan').at(-1)
      expect(entry).toMatchObject({ mode: 'shadow', effectiveDecision: 'allow', wouldDecision: 'deny' })
    } finally { mounted.dispose() }
  })

  it('PT-13: requirePlan=true is fail-closed: no plan denies write/edit with plan.not-declared, then a declared plan allows', async () => {
    const r = await repo()
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-plan-tool-state-'))
    cleanup.push(stateDir)
    await prepareActivation(env(stateDir, r.dir, r.baseSha, { requirePlan: true }))
    const { fake, mounted } = await mount(stateDir, r.dir)
    try {
      const next = async () => ({ kind: 'allow' as const })
      const undeclared = await fake.callbacks().preExecute!(editCall('src/app.js'), next)
      expect(undeclared).toMatchObject({ kind: 'deny', reason: expect.stringContaining('plan.not-declared') })
      expect((await decisions(stateDir)).filter(item => item.rule === 'plan.not-declared').at(-1))
        .toMatchObject({ tool: 'edit', effectiveDecision: 'deny', wouldDecision: 'deny' })
      // Declaring the plan for the current contract unlocks edits inside it...
      const tool = planToolOf(fake)!
      await tool.execute({ files: ['src/app.js'] }, planCall(['src/app.js']))
      expect(await fake.callbacks().preExecute!(editCall('src/app.js'), next)).toEqual({ kind: 'allow' })
      // ...while an undeclared target is still plan.outside-plan.
      expect(await fake.callbacks().preExecute!(editCall('tests/keep.test.js'), next))
        .toMatchObject({ kind: 'deny', reason: expect.stringContaining('does not include tests/keep.test.js') })
    } finally { mounted.dispose() }
  })

  it('PT-14: requirePlan=true registers hephi_plan even without a task card (otherwise fail-closed would deadlock)', async () => {
    const r = await repo()
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-plan-tool-state-'))
    cleanup.push(stateDir)
    await prepareActivation(env(stateDir, r.dir, r.baseSha, { issueBody: null, requirePlan: true }))
    const { fake, mounted } = await mount(stateDir, r.dir)
    try {
      const tool = planToolOf(fake)
      expect(tool?.name).toBe('hephi_plan')
      await tool!.execute({ files: ['src/app.js'] }, planCall(['src/app.js']))
      expect(await fake.callbacks().preExecute!(editCall('src/app.js'), async () => ({ kind: 'allow' as const }))).toEqual({ kind: 'allow' })
    } finally { mounted.dispose() }
  })

  it('PT-15: requirePlan=true in shadow mode records wouldDecision plan.not-declared but never denies', async () => {
    const r = await repo()
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-plan-tool-state-'))
    cleanup.push(stateDir)
    await prepareActivation(env(stateDir, r.dir, r.baseSha, { requirePlan: true, enforcement: 'shadow' }))
    const { fake, mounted } = await mount(stateDir, r.dir)
    try {
      expect(await fake.callbacks().preExecute!(editCall('src/app.js'), async () => ({ kind: 'allow' as const }))).toEqual({ kind: 'allow' })
      const entry = (await decisions(stateDir)).filter(item => item.rule === 'plan.not-declared').at(-1)
      expect(entry).toMatchObject({ mode: 'shadow', effectiveDecision: 'allow', wouldDecision: 'deny' })
    } finally { mounted.dispose() }
  })

  it('PT-16: re-prepare reuses the contract, so a declared plan stays effective (requirePlan=true)', async () => {
    const r = await repo()
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-plan-tool-state-'))
    cleanup.push(stateDir)
    await prepareActivation(env(stateDir, r.dir, r.baseSha, { requirePlan: true }))
    const { fake, mounted } = await mount(stateDir, r.dir)
    try {
      await planToolOf(fake)!.execute({ files: ['src/app.js'] }, planCall(['src/app.js']))
      expect(await fake.callbacks().preExecute!(editCall('src/app.js'), async () => ({ kind: 'allow' as const }))).toEqual({ kind: 'allow' })
      // T11: re-prepare replays the same contract; a freshly mounted Worker binds the same
      // hash and the plan declared for it stays effective (no plan.not-declared).
      const rerun = await prepareActivation(env(stateDir, r.dir, r.baseSha, { requirePlan: true, baseRef: 'release' }))
      expect(rerun.enabled).toBe(true)
      if (rerun.enabled) expect(rerun.reused).toBe(true)
      const remounted = await mount(stateDir, r.dir)
      try {
        expect(await remounted.fake.callbacks().preExecute!(editCall('src/app.js'), async () => ({ kind: 'allow' as const }))).toEqual({ kind: 'allow' })
        expect((await decisions(stateDir)).filter(item => item.rule === 'plan.not-declared')).toHaveLength(0)
      } finally { remounted.mounted.dispose() }
    } finally { mounted.dispose() }
  })

  it('PT-12: re-prepare reuses the contract, so the mounted plan tool keeps recording', async () => {
    const r = await repo()
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-plan-tool-state-'))
    cleanup.push(stateDir)
    await prepareActivation(env(stateDir, r.dir, r.baseSha))
    const { fake, mounted } = await mount(stateDir, r.dir)
    try {
      // T11: re-prepare behind the Worker's back does not change the contract hash, so the
      // mounted tool (which revalidates the hash before recording) still works.
      const rerun = await prepareActivation(env(stateDir, r.dir, r.baseSha, { baseRef: 'release' }))
      expect(rerun.enabled).toBe(true)
      if (rerun.enabled) expect(rerun.reused).toBe(true)
      await expect(planToolOf(fake)!.execute({ files: ['src/app.js'] }, planCall(['src/app.js']))).resolves.toMatchObject({ files: ['src/app.js'] })
    } finally { mounted.dispose() }
  })
})
