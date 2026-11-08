import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requireKnowledgeQuery, searchKnowledgeBase } from '../../src/kb/index.js'
import { loadActivation } from '../../src/control/activation.js'
import { activationPath, contractHash, prepareActivation } from '../../src/control/activation.js'
import { installWorkerMount, mountWorkerGate } from '../../src/control/worker-mount.js'
const run = promisify(execFile)

function env(stateDir: string, mode?: 'native' | 'staged', workspace = '/tmp/ticket-1', baseSha = 'a'.repeat(40)): NodeJS.ProcessEnv {
  return {
    HEPHI_ENABLED: '1', HEPHI_STATE_DIR: stateDir, HEPHI_BASE_COMMIT: baseSha, HEPHI_ALLOWED_PATHS: '**',
    HEPHI_TEST_COMMAND: 'true', HEPHI_REVERSE_TEST_COMMAND: 'true',
    DSH_SUPERAGENT_TICKET: 'ticket-1', DSH_SUPERAGENT_DIR: workspace,
    DSH_SUPERAGENT_GITHUB_REPOSITORY: 'paxxie2/dubbo', DSH_SUPERAGENT_GITHUB_NUMBER: '42',
    HEPHI_VERIFICATION_CHECKS: JSON.stringify({version:1,checks:[{id:'fixture-build',kind:'build',purpose:'fixture command',command:'true',args:[],cwd:'.',required:true,timeoutMs:5000,}]}),
    ...mode === undefined ? {} : { HEPHI_EXECUTION_MODE: mode },
  }
}
async function gitWorkspace(): Promise<{ repo: string; baseSha: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'hephi-worker-repo-'))
  await run('git', ['init', repo])
  await run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo })
  await run('git', ['config', 'user.name', 'Worker test'], { cwd: repo })
  await writeFile(join(repo, 'a.txt'), 'base')
  await run('git', ['add', '.'], { cwd: repo })
  await run('git', ['commit', '-m', 'base'], { cwd: repo })
  return { repo, baseSha: (await run('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim() }
}
function stageContext(services: Record<string, unknown> = {}): Context {
  return { get: (name: string) => services[name] } as unknown as Context
}
type StageChild = { id: string; status?: string; jobs?: string[]; loaded?: boolean }
function stageServices(children: StageChild[] = [], parentJobs: string[] = []) {
  return {
    jobs: {
      list: (sessionId: string) => {
        const statuses = sessionId === 'worker-ticket-1'
          ? parentJobs
          : children.find(child => child.id === sessionId)?.jobs ?? []
        return statuses.map(status => ({ status }))
      },
    },
    sessionQuery: { readSession: async (id: string) => ({ session: { id }, inheritedEventCount: 0, events: [] }) },
    subagents: { listChildren: async () => children.map(child => ({ id: child.id })) },
    agents: {
      get: (id: string) => {
        const child = children.find(item => item.id === id)
        return child && child.loaded !== false ? { status: child.status ?? 'idle' } : undefined
      },
    },
  }
}

type PreExecute = (execution: ToolExecution, next: () => Promise<any>) => Promise<any>
type Guard = (execution: ToolExecution) => string | undefined
function fakeAgent(preset = 'dsh-superagent-worker', origin?: 'subagent', cwd = '/tmp/ticket-1', id = 'worker-ticket-1', parentSession?: string) {
  const listeners = new Map<string, Function>()
  const guards = new Set<Guard>()
  const prompts: Array<{ text: () => string }> = []
  const services: Record<string, unknown> = {}
  const agent = {
    session: { header: { id, agentPreset: preset, origin, cwd, parentSession } },
    ctx: {
      on: (name: string, listener: Function) => {
        listeners.set(name, listener)
        return () => { if (listeners.get(name) === listener) listeners.delete(name) }
      },
      tools: {
        register: () => () => true,
        guard: (listener: Guard) => { guards.add(listener); return () => { guards.delete(listener) } },
      },
      systemPrompt: {
        section: (section: { text: () => string }) => {
          prompts.push(section)
          return () => { const index = prompts.indexOf(section); if (index >= 0) prompts.splice(index, 1) }
        },
      },
      get: (name: string) => services[name],
    },
  } as unknown as Agent
  return {
    agent,
    services,
    callbacks: () => ({
      preExecute: listeners.get('tools/pre-execute') as PreExecute | undefined,
      guard: (execution: ToolExecution) => { for (const guard of guards) { const reason = guard(execution); if (reason) return reason } return undefined },
      execute: listeners.get('tools/execute') as ((execution: ToolExecution, next: () => Promise<any>) => Promise<any>) | undefined,
      result: listeners.get('tools/result') as ((execution: ToolExecution, result: any) => undefined) | undefined,
      prompt: prompts.at(-1),
      prompts,
    }),
  }
}

describe('Worker mount', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('supplies KB instructions before any tool call and disposes them with the gate', async () => {
    vi.stubEnv('HEPHI_KB_CONFIG', JSON.stringify({ 'paxxie2/dubbo': '/unused-kb' }))
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
    await prepareActivation(env(stateDir))
    const fake = fakeAgent()
    const mounted = mountWorkerGate({} as Context, fake.agent, { stateDir })
    const text = fake.callbacks().prompt!.text()
    expect(text).toContain('Before creating an implementation todo/plan or modifying code')
    expect(text).toContain('orchestrator_report progress and the real pr_number')
    expect(text).not.toContain('before push/PR')
    expect(text).toContain('hephi_kb_search')
    expect(text).toContain('skill("hephi-superagent-control")')
    expect(text).toContain('hephi_get_contract')
    // AT-70: the startup prompt states that checks run on committed source only.
    expect(text).toContain('Commit your changes before running hephi_check')
    mounted!.dispose()
    expect(fake.callbacks().prompt).toBeUndefined()
  })

  it('does not require KB or emit KB instructions when this repository has no mapping', async () => {
    vi.stubEnv('HEPHI_KB_CONFIG', JSON.stringify({ 'other/project': '/unused-kb' }))
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
    await prepareActivation(env(stateDir))
    const fake = fakeAgent()
    const mounted = mountWorkerGate({} as Context, fake.agent, { stateDir })
    expect(fake.callbacks().prompt!.text()).toContain('hephi_get_contract')
    expect(fake.callbacks().prompt!.text()).toContain('skill("hephi-superagent-control")')
    expect(fake.callbacks().prompt!.text()).not.toContain('hephi_kb_search')
    const contract = await loadActivation(activationPath(stateDir, 'ticket-1'))
    await expect(requireKnowledgeQuery(contract, stateDir)).resolves.toBeUndefined()
    await expect(searchKnowledgeBase(contract, 'task', 3, stateDir)).resolves.toEqual({ enabled: false, matches: [] })
    mounted!.dispose()
  })
  it('does not register startup instructions for an unactivated Worker', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
    const fake = fakeAgent()
    expect(mountWorkerGate({} as Context, fake.agent, { stateDir })).toBeUndefined()
    expect(fake.callbacks().preExecute).toBeUndefined()
    expect(fake.callbacks().prompts).toHaveLength(0)
  })

  it('reports malformed KB configuration without throwing during prompt assembly or bypassing the gate', async () => {
    vi.stubEnv('HEPHI_KB_CONFIG', '{broken')
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
    await prepareActivation(env(stateDir))
    const fake = fakeAgent()
    const mounted = mountWorkerGate({} as Context, fake.agent, { stateDir })
    expect(fake.callbacks().prompt!.text()).toContain('configuration could not be read')
    expect(fake.callbacks().prompt!.text()).not.toContain('No knowledge base is configured')
    const contract = await loadActivation(activationPath(stateDir, 'ticket-1'))
    await expect(requireKnowledgeQuery(contract, stateDir)).rejects.toThrow()
    mounted!.dispose()
  })

  it('mounts only the selected Worker and gates ready', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
    await prepareActivation(env(stateDir))
    const fake = fakeAgent()
    const mounted = await mountWorkerGate({} as Context, fake.agent, {
      stateDir,
      verify: async () => ({ ok: true as const }),
    })
    expect(mounted?.ticketId).toBe('ticket-1')
    const callbacks = fake.callbacks()
    expect(callbacks.preExecute).toBeTypeOf('function')
    expect(callbacks.guard).toBeTypeOf('function')
    mounted?.dispose()
  })

  it('ignores retired stage records but still enforces final verification', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
    await prepareActivation(env(stateDir))
    await writeFile(join(stateDir, 'hephi', 'ticket-1', 'execution-plan.json'), '{retired-stage-record')
    const fake = fakeAgent()
    const register = vi.fn(() => () => true)
    fake.agent.ctx.tools.register = register as typeof fake.agent.ctx.tools.register
    const verify = vi.fn(async () => ({ ok: false as const, reason: 'actual final checks failed' }))
    const mounted = mountWorkerGate({} as Context, fake.agent, { stateDir, verify })!
    try {
      expect((register.mock.calls as unknown as Array<[{ name: string }]>).map(call => call[0].name)).toEqual(['hephi_check'])
      expect(fake.callbacks().guard({ name: 'orchestrator_report', arguments: { state: 'progress' }, token: Symbol() } as unknown as ToolExecution)).toBeUndefined()
      expect(fake.callbacks().prompt!.text()).not.toMatch(/staged|hephi_stage|checkpoint/)
      const next = vi.fn(async () => ({ kind: 'allow' }))
      for (const name of ['write', 'subagent']) {
        const call = { name, arguments: {}, token: Symbol() } as unknown as ToolExecution
        expect(fake.callbacks().guard!(call)).toBeUndefined()
        expect(await fake.callbacks().preExecute!(call, next)).toEqual({ kind: 'allow' })
      }
      const ready = { name: 'orchestrator_report', arguments: { state: 'ready' }, token: Symbol() } as unknown as ToolExecution
      expect(await fake.callbacks().preExecute!(ready, next)).toEqual({ kind: 'deny', reason: 'actual final checks failed' })
      expect(verify).toHaveBeenCalledOnce()
      expect(fake.callbacks().guard!(ready)).toContain('denied')
    } finally { mounted.dispose() }
  })

  it('does not mount subagents or non-worker presets', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
    await prepareActivation(env(stateDir))
    expect(await mountWorkerGate({} as Context, fakeAgent('standard').agent, { stateDir })).toBeUndefined()
    expect(await mountWorkerGate({} as Context, fakeAgent('dsh-superagent-worker', 'subagent').agent, { stateDir })).toBeUndefined()
  })

  it('scans existing workers and does not mount the same worker twice', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
    await prepareActivation(env(stateDir))
    const fake = fakeAgent()
    const listeners = new Map<string, (payload: { agent: Agent }) => void>()
    const context = {
      agents: { list: () => [fake.agent] },
      on: (name: string, listener: (payload: { agent: Agent }) => void) => {
        listeners.set(name, listener)
        return () => true
      },
    } as unknown as Context
    const dispose = installWorkerMount(context, { stateDir, verify: async () => ({ ok: true as const }) })
    const first = fake.callbacks()
    expect(first.preExecute).toBeTypeOf('function')
    listeners.get('agent/created')?.({ agent: fake.agent })
    expect(fake.callbacks().preExecute).toBe(first.preExecute)
    dispose()
  })

  it('keeps the gate mounted when an activated contract disappears', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
    await prepareActivation(env(stateDir))
    await import('node:fs/promises').then(({ unlink }) => unlink(activationPath(stateDir, 'ticket-1')))
    const fake = fakeAgent()
    const mounted = mountWorkerGate({} as Context, fake.agent, {
      stateDir,
      verify: async () => ({ ok: true as const }),
    })
    expect(mounted).toBeDefined()
    expect(fake.callbacks().prompt!.text()).toContain('contract could not be read')
    expect(fake.callbacks().preExecute).toBeTypeOf('function')
    for (const state of ['blocked', 'progress']) {
      const report = { name: 'orchestrator_report', arguments: { state }, token: Symbol() } as unknown as ToolExecution
      expect(fake.callbacks().guard(report)).toBeUndefined()
    }
    const ready = { name: 'orchestrator_report', arguments: { state: 'ready' }, token: Symbol() } as unknown as ToolExecution
    expect((await fake.callbacks().preExecute!(ready, async () => ({ kind: 'allow' }))).kind).toBe('deny')
    mounted?.dispose()
  })

  it('does not swallow an activated gate mount failure', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
    await prepareActivation(env(stateDir))
    const fake = fakeAgent()
    fake.agent.ctx.on = (() => { throw new Error('mount failed') }) as typeof fake.agent.ctx.on
    const context = {
      agents: { list: () => [fake.agent] },
      on: () => () => true,
    } as unknown as Context
    expect(() => installWorkerMount(context, { stateDir })).toThrow('mount failed')
  })


  it('native default installs no stage tool or state and permits native delegation without stage services', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
    await prepareActivation(env(stateDir))
    const fake = fakeAgent()
    const register = vi.fn(() => () => true)
    fake.agent.ctx.tools.register = register as typeof fake.agent.ctx.tools.register
    const mounted = mountWorkerGate({} as Context, fake.agent, { stateDir, verify: async () => ({ ok: true as const }) })
    try {
      expect((register.mock.calls as unknown as Array<[{ name: string }]>).map(call => call[0].name)).toEqual(['hephi_check'])
      const prompt = fake.callbacks().prompt!.text()
      expect(prompt).toContain('Execution mode: native')
      expect(prompt).not.toMatch(/staged|hephi_stage|checkpoint/)
      for (const name of ['write', 'subagent', 'spawn_teammate', 'workflow']) {
        expect(fake.callbacks().guard({ name, arguments: {}, token: Symbol() } as unknown as ToolExecution)).toBeUndefined()
      }
      const ready = { name: 'orchestrator_report', arguments: { state: 'ready' }, token: Symbol() } as unknown as ToolExecution
      expect(await fake.callbacks().preExecute!(ready, async () => ({ kind: 'allow' }))).toEqual({ kind: 'allow' })
    } finally { mounted!.dispose() }
  })

  it('injects ctx.get("jobs") into hephi_check and settles a promoted native Job', async () => {
    const { repo, baseSha } = await gitWorkspace()
    await run('git', ['remote', 'add', 'origin', 'git@github.com:paxxie2/dubbo.git'], { cwd: repo })
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
    await prepareActivation(env(stateDir, 'native', repo, baseSha))
    const fake = fakeAgent('dsh-superagent-worker', undefined, repo)
    const registered: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = []
    fake.agent.ctx.tools.register = ((tool: typeof registered[number]) => { registered.push(tool); return () => true }) as unknown as typeof fake.agent.ctx.tools.register
    ;(fake.agent.ctx.tools as unknown as { execute: (...args: any[]) => Promise<any> }).execute = async () => ({
      isError: false, content: [], value: { kind: 'promoted', jobId: 'bash-job', timeoutMs: 1000, output: '' },
    })
    const jobs = {
      wait: async () => ({ id: 'bash-job', status: 'completed', detail: 'exit code: 0' }),
      get: () => { throw new Error('unexpected get') },
      readAt: () => ({ chunks: [{ at: 0, text: 'ok\n' }], next: 3, lossy: false }),
      kill: () => { throw new Error('unexpected kill') },
    }
    const context = { get: (name: string) => name === 'jobs' ? jobs : undefined } as unknown as Context
    const mounted = mountWorkerGate(context, fake.agent, { stateDir })!
    try {
      const checkTool = registered.find(tool => tool.name === 'hephi_check')!
      const result = await checkTool.execute({ checkId: 'fixture-build' }, {
        callId: 'outer-check', rootCallId: 'outer-check', token: Symbol('outer'), signal: new AbortController().signal,
        agent: { id: 'worker-ticket-1' }, arguments: { checkId: 'fixture-build' },
      })
      expect(result.status).toBe('passed')
      expect(result.jobId).toBe('bash-job')
      const decisions = (await readFile(join(stateDir, 'hephi', 'ticket-1', 'decisions.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(decisions.at(-1)).toMatchObject({ tool: 'hephi_check', rule: 'check.pass', effectiveDecision: 'allow', wouldDecision: 'allow', callId: 'outer-check' })
    } finally { mounted.dispose() }
  })

  it('staged mode registers stage control and closes delegation and mutation before plan', async () => {
    const { repo, baseSha } = await gitWorkspace()
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
    await prepareActivation(env(stateDir, 'staged', repo, baseSha))
    const fake = fakeAgent('dsh-superagent-worker', undefined, repo)
    const registered: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = []
    fake.agent.ctx.tools.register = ((tool: typeof registered[number]) => { registered.push(tool); return () => true }) as unknown as typeof fake.agent.ctx.tools.register
    const mounted = mountWorkerGate(stageContext(stageServices()), fake.agent, { stateDir, verify: async () => ({ ok: true as const }) })
    try {
      expect(registered.map(tool => tool.name)).toContain('hephi_stage')
      expect(fake.callbacks().prompts.some(section => section.text().includes('execution mode: staged'))).toBe(true)
      expect(fake.callbacks().guard({ name: 'write', arguments: {}, token: Symbol() } as unknown as ToolExecution)).toContain('plan')
      expect(fake.callbacks().guard({ name: 'subagent', arguments: {}, token: Symbol() } as unknown as ToolExecution)).toContain('subagent')
      expect(fake.callbacks().guard({ name: 'spawn_teammate', arguments: {}, token: Symbol() } as unknown as ToolExecution)).toContain('Agent Team')
      expect(fake.callbacks().guard({ name: 'hephi_check', arguments: { checkId: 'unit' }, token: Symbol() } as unknown as ToolExecution)).toContain('every stage')
      expect(fake.callbacks().guard({ name: 'read', arguments: {}, token: Symbol() } as unknown as ToolExecution)).toBeUndefined()
      const ready = { name: 'orchestrator_report', arguments: { state: 'ready' }, token: Symbol() } as unknown as ToolExecution
      const denied = await fake.callbacks().preExecute!(ready, async () => ({ kind: 'allow' }))
      expect(denied.kind).toBe('deny')
      expect(denied.reason).toContain('plan')
    } finally { mounted!.dispose() }
  })

  it('staged mode fails closed when the Job registry is missing without affecting native tasks', async () => {
    const { repo, baseSha } = await gitWorkspace()
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
    await prepareActivation(env(stateDir, 'staged', repo, baseSha))
    const fake = fakeAgent('dsh-superagent-worker', undefined, repo)
    const mounted = mountWorkerGate(stageContext({ ...stageServices(), jobs: undefined }), fake.agent, { stateDir })
    try {
      const next = vi.fn(async () => ({ isError: false, value: undefined }))
      const write = { name: 'write', arguments: {}, token: Symbol(), callId: 'call-1' } as unknown as ToolExecution
      await expect(fake.callbacks().execute!(write, next)).rejects.toThrow('Native Job registry is required')
      expect(next).not.toHaveBeenCalled()
      expect(fake.callbacks().guard(write)).toContain('unavailable')
      expect(fake.callbacks().guard({ name: 'read', arguments: {}, token: Symbol() } as unknown as ToolExecution)).toBeUndefined()
    } finally { mounted!.dispose() }
  })

  it('re-prepare reuses the mounted contract instead of changing its mode under a worker', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
    await prepareActivation(env(stateDir))
    const fake = fakeAgent()
    const mounted = mountWorkerGate({} as Context, fake.agent, { stateDir, verify: async () => ({ ok: true as const }) })
    try {
      // T11: the contract is written once per ticket and re-prepare replays it, so a re-prepare
      // with staged env cannot change the mode of the mounted worker.
      const rerun = await prepareActivation(env(stateDir, 'staged'))
      expect(rerun.enabled).toBe(true)
      if (rerun.enabled) {
        expect(rerun.reused).toBe(true)
        expect(rerun.contract.executionMode).toBe('native')
      }
      const write = { name: 'write', arguments: {}, token: Symbol() } as unknown as ToolExecution
      expect(fake.callbacks().guard(write)).toBeUndefined()
    } finally { mounted!.dispose() }
  })


  it('checks Jobs for every child even after its Agent unloads, without treating settled work as active', async () => {
    async function setup(initial: StageChild[] = []) {
      const { repo, baseSha } = await gitWorkspace()
      const stateDir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
      await prepareActivation(env(stateDir, 'staged', repo, baseSha))
      const fake = fakeAgent('dsh-superagent-worker', undefined, repo)
      const children = [...initial]
      const registered: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = []
      fake.agent.ctx.tools.register = ((tool: typeof registered[number]) => { registered.push(tool); return () => true }) as unknown as typeof fake.agent.ctx.tools.register
      const mounted = mountWorkerGate(stageContext(stageServices(children)), fake.agent, { stateDir, verify: async () => ({ ok: true as const }) })!
      const stage = registered.find(tool => tool.name === 'hephi_stage')!
      const run = (args: Record<string, unknown>) => stage.execute(args, { signal: new AbortController().signal })
      const plan = ['A', 'B'].map(id => ({ id, objective: id, scope: ['**'], checks: [{ id: 'node', command: process.execPath, args: ['-e', 'console.log("mount check")'] }] }))
      await run({ action: 'plan', reason: 'mount lifecycle fixture', planJson: JSON.stringify(plan) })
      await run({ action: 'start', stageId: 'A' })
      return { fake, mounted, children, run, stateDir }
    }

    const idle = await setup([
      { id: 'child-idle', status: 'idle', jobs: ['completed', 'failed', 'killed'] },
      { id: 'child-ended', loaded: false },
      { id: 'child-ended-terminal', loaded: false, jobs: ['completed', 'failed', 'killed'] },
    ])
    try {
      await expect(idle.run({ action: 'finish', stageId: 'A' })).resolves.toMatchObject({ stageId: 'A' })
      const reason = idle.fake.callbacks().guard({ name: 'write', arguments: {}, token: Symbol() } as unknown as ToolExecution)
      expect(reason).toContain('closed')
      expect(reason).not.toContain('active implementation subagent')
    } finally { idle.mounted.dispose() }

    for (const child of [
      { id: 'child-running', status: 'running' },
      { id: 'child-job', status: 'idle', jobs: ['running'] },
      { id: 'child-job-unknown', status: 'idle', jobs: ['mystery'] },
      { id: 'child-ended-running', loaded: false, jobs: ['running'] },
      { id: 'child-ended-unknown', loaded: false, jobs: ['mystery'] },
      { id: 'child-paused', status: 'paused' },
    ] as StageChild[]) {
      const mounted = await setup()
      try {
        mounted.children.push(child)
        const expected = child.status === 'paused'
          ? 'Unknown subagent lifecycle'
          : child.jobs?.includes('mystery') ? 'Unknown Job state' : 'active implementation subagent'
        await expect(mounted.run({ action: 'finish', stageId: 'A' })).rejects.toThrow(expected)
        expect(mounted.fake.callbacks().guard({ name: 'write', arguments: {}, token: Symbol() } as unknown as ToolExecution)).toBeTruthy()
        const next = vi.fn(async () => ({ isError: false, value: { reported: true } }))
        for (const state of ['blocked', 'progress']) {
          const report = { name: 'orchestrator_report', arguments: { state }, token: Symbol(), callId: `report-${state}` } as unknown as ToolExecution
          expect(mounted.fake.callbacks().guard(report)).toBeUndefined()
          await expect(mounted.fake.callbacks().execute!(report, next)).resolves.toEqual({ isError: false, value: { reported: true } })
        }
        expect(next).toHaveBeenCalledTimes(2)
        const ready = { name: 'orchestrator_report', arguments: { state: 'ready' }, token: Symbol() } as unknown as ToolExecution
        expect((await mounted.fake.callbacks().preExecute!(ready, async () => ({ kind: 'allow' }))).kind).toBe('deny')
      } finally { mounted.mounted.dispose() }
    }
  })

  it('allows a progress report but does not complete a checkpoint while a child is active', async () => {
    const { repo, baseSha } = await gitWorkspace()
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
    await prepareActivation(env(stateDir, 'staged', repo, baseSha))
    const fake = fakeAgent('dsh-superagent-worker', undefined, repo)
    const children: StageChild[] = []
    const registered: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = []
    fake.agent.ctx.tools.register = ((tool: typeof registered[number]) => { registered.push(tool); return () => true }) as unknown as typeof fake.agent.ctx.tools.register
    const mounted = mountWorkerGate(stageContext(stageServices(children)), fake.agent, { stateDir, verify: async () => ({ ok: true as const }) })!
    const stage = registered.find(tool => tool.name === 'hephi_stage')!
    const run = (args: Record<string, unknown>) => stage.execute(args, { signal: new AbortController().signal })
    const plan = ['A', 'B'].map(id => ({ id, objective: id, scope: ['**'], checks: [{ id: 'node', command: process.execPath, args: ['-e', 'console.log("progress check")'] }] }))
    try {
      await run({ action: 'plan', reason: 'progress with active child', planJson: JSON.stringify(plan) })
      await run({ action: 'start', stageId: 'A' })
      const receipt = await run({ action: 'finish', stageId: 'A' }) as { progressMarker: string }
      children.push({ id: 'child-active', status: 'running' })
      const next = vi.fn(async () => ({ isError: false, value: { reported: true } }))
      const report = { name: 'orchestrator_report', arguments: { state: 'progress', summary: receipt.progressMarker }, token: Symbol(), callId: 'progress-active' } as unknown as ToolExecution
      await expect(fake.callbacks().execute!(report, next)).resolves.toEqual({ isError: false, value: { reported: true } })
      fake.callbacks().result!(report, { isError: false, value: { reported: true } })
      await new Promise(resolve => setTimeout(resolve, 200))
      const record = JSON.parse(await readFile(join(stateDir, 'hephi', 'ticket-1', 'execution-plan.json'), 'utf8'))
      expect(record.stages[0].status).toBe('checking')
      expect(record.stages[0].attempts.at(-1).progressCallId).toBeUndefined()
      expect(fake.callbacks().guard({ name: 'write', arguments: {}, token: Symbol() } as unknown as ToolExecution)).toContain('active implementation subagent')
    } finally { mounted.dispose() }
  })

  it('allows a progress report but does not complete a checkpoint after the contract changes', async () => {
    const { repo, baseSha } = await gitWorkspace()
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
    await prepareActivation(env(stateDir, 'staged', repo, baseSha))
    const fake = fakeAgent('dsh-superagent-worker', undefined, repo)
    const registered: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = []
    fake.agent.ctx.tools.register = ((tool: typeof registered[number]) => { registered.push(tool); return () => true }) as unknown as typeof fake.agent.ctx.tools.register
    const mounted = mountWorkerGate(stageContext(stageServices()), fake.agent, { stateDir, verify: async () => ({ ok: true as const }) })!
    const stage = registered.find(tool => tool.name === 'hephi_stage')!
    const run = (args: Record<string, unknown>) => stage.execute(args, { signal: new AbortController().signal })
    const plan = ['A', 'B'].map(id => ({ id, objective: id, scope: ['**'], checks: [{ id: 'node', command: process.execPath, args: ['-e', 'console.log("contract check")'] }] }))
    try {
      await run({ action: 'plan', reason: 'contract change progress', planJson: JSON.stringify(plan) })
      await run({ action: 'start', stageId: 'A' })
      const receipt = await run({ action: 'finish', stageId: 'A' }) as { progressMarker: string }
      const path = activationPath(stateDir, 'ticket-1')
      const raw = JSON.parse(await readFile(path, 'utf8'))
      raw.baseRef = 'changed-after-mount'
      delete raw.contractHash
      raw.contractHash = contractHash(raw)
      await writeFile(path, JSON.stringify(raw))
      const next = vi.fn(async () => ({ isError: false, value: { reported: true } }))
      const report = { name: 'orchestrator_report', arguments: { state: 'progress', summary: receipt.progressMarker }, token: Symbol(), callId: 'progress-changed' } as unknown as ToolExecution
      await expect(fake.callbacks().execute!(report, next)).resolves.toEqual({ isError: false, value: { reported: true } })
      fake.callbacks().result!(report, { isError: false, value: { reported: true } })
      await new Promise(resolve => setTimeout(resolve, 200))
      const record = JSON.parse(await readFile(join(stateDir, 'hephi', 'ticket-1', 'execution-plan.json'), 'utf8'))
      expect(record.stages[0].status).toBe('checking')
      expect(record.stages[0].attempts.at(-1).progressCallId).toBeUndefined()
      const ready = { name: 'orchestrator_report', arguments: { state: 'ready' }, token: Symbol() } as unknown as ToolExecution
      expect((await fake.callbacks().preExecute!(ready, async () => ({ kind: 'allow' }))).kind).toBe('deny')
    } finally { mounted.dispose() }
  })

  it('lets blocked and progress reports reach the host after a staged service load failure', async () => {
    const { repo, baseSha } = await gitWorkspace()
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
    await prepareActivation(env(stateDir, 'staged', repo, baseSha))
    const fake = fakeAgent('dsh-superagent-worker', undefined, repo)
    const mounted = mountWorkerGate(stageContext({ ...stageServices(), jobs: undefined }), fake.agent, { stateDir, verify: async () => ({ ok: true as const }) })
    try {
      const next = vi.fn(async () => ({ isError: false, value: { reported: true } }))
      const write = { name: 'write', arguments: {}, token: Symbol(), callId: 'write-1' } as unknown as ToolExecution
      await expect(fake.callbacks().execute!(write, next)).rejects.toThrow('Native Job registry is required')
      expect(next).not.toHaveBeenCalled()
      for (const state of ['blocked', 'progress']) {
        const report = { name: 'orchestrator_report', arguments: { state }, token: Symbol(), callId: `report-${state}` } as unknown as ToolExecution
        expect(fake.callbacks().guard(report)).toBeUndefined()
        await expect(fake.callbacks().execute!(report, next)).resolves.toEqual({ isError: false, value: { reported: true } })
      }
      expect(next).toHaveBeenCalledTimes(2)
      const ready = { name: 'orchestrator_report', arguments: { state: 'ready' }, token: Symbol() } as unknown as ToolExecution
      const denied = await fake.callbacks().preExecute!(ready, async () => ({ kind: 'allow' }))
      expect(denied.kind).toBe('deny')
      expect(String(denied.reason)).toContain('stages unavailable')
      expect(fake.callbacks().guard(write)).toContain('unavailable')
    } finally { mounted!.dispose() }
  })

  it('returns the created mount result so agent creation can await the hook', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
    await prepareActivation(env(stateDir))
    const fake = fakeAgent()
    let created: ((payload: { agent: Agent }) => unknown) | undefined
    const context = {
      agents: { list: () => [] },
      on: (name: string, listener: (payload: { agent: Agent }) => unknown) => {
        if (name === 'agent/created') created = listener
        return () => true
      },
    } as unknown as Context
    const dispose = installWorkerMount(context, { stateDir, verify: async () => ({ ok: true as const }) })
    created?.({ agent: fake.agent })
    expect(fake.callbacks().preExecute).toBeTypeOf('function')
    dispose()
  })

  it('records write-scope decisions in the per-ticket decision log', async () => {
    const { repo, baseSha } = await gitWorkspace()
    await run('git', ['remote', 'add', 'origin', 'git@github.com:paxxie2/dubbo.git'], { cwd: repo })
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
    await prepareActivation(env(stateDir, 'native', repo, baseSha))
    const fake = fakeAgent('dsh-superagent-worker', undefined, repo)
    const context = { get: () => undefined } as unknown as Context
    const mounted = mountWorkerGate(context, fake.agent, { stateDir })!
    try {
      const next = async () => ({ kind: 'allow' as const })
      const call = (path: string, callId: string) => ({
        name: 'write', arguments: { path }, callId, token: Symbol(), agent: fake.agent, signal: new AbortController().signal,
      }) as unknown as ToolExecution
      expect(await fake.callbacks().preExecute!(call('src/ok.ts', 'call-allow'), next)).toEqual({ kind: 'allow' })
      const denied = await fake.callbacks().preExecute!(call('../outside.ts', 'call-deny'), next)
      expect(denied.kind).toBe('deny')
      const entries = (await readFile(join(stateDir, 'hephi', 'ticket-1', 'decisions.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(entries.map(entry => entry.rule)).toEqual(['scope.allowed', 'scope.outside-checkout'])
      expect(entries.map(entry => entry.effectiveDecision)).toEqual(['allow', 'deny'])
      expect(entries[1]).toMatchObject({ tool: 'write', callId: 'call-deny', mode: 'enforce', wouldDecision: 'deny' })
    } finally { mounted.dispose() }
  })


  it('shadow mode observes scope and ready but never denies, registers checks or injects prompts', async () => {
    const { repo, baseSha } = await gitWorkspace()
    await run('git', ['remote', 'add', 'origin', 'git@github.com:paxxie2/dubbo.git'], { cwd: repo })
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
    await prepareActivation({ ...env(stateDir, 'native', repo, baseSha), HEPHI_ENFORCEMENT: 'shadow' })
    const fake = fakeAgent('dsh-superagent-worker', undefined, repo)
    const register = vi.fn(() => () => true)
    fake.agent.ctx.tools.register = register as unknown as typeof fake.agent.ctx.tools.register
    const verify = vi.fn(async () => ({ ok: false as const, reason: 'real evidence would fail' }))
    const mounted = mountWorkerGate({} as Context, fake.agent, { stateDir, verify })!
    try {
      expect(register).not.toHaveBeenCalled()
      expect(fake.callbacks().prompts).toHaveLength(0)
      const next = vi.fn(async () => ({ kind: 'allow' }))
      const write = { name: 'write', arguments: { path: '../outside.ts' }, callId: 'shadow-write', token: Symbol(), agent: fake.agent } as unknown as ToolExecution
      expect(await fake.callbacks().preExecute!(write, next)).toEqual({ kind: 'allow' })
      const ready = { name: 'orchestrator_report', arguments: { state: 'ready' }, callId: 'shadow-ready', token: Symbol() } as unknown as ToolExecution
      expect(await fake.callbacks().preExecute!(ready, next)).toEqual({ kind: 'allow' })
      expect(verify).not.toHaveBeenCalled()
      const entries = (await readFile(join(stateDir, 'hephi', 'ticket-1', 'decisions.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(entries[0]).toMatchObject({ tool: 'write', mode: 'shadow', effectiveDecision: 'allow', wouldDecision: 'deny', rule: 'scope.outside-checkout' })
      expect(entries[1]).toMatchObject({ tool: 'orchestrator_report', mode: 'shadow', effectiveDecision: 'allow', rule: 'ready.pass' })
    } finally { mounted.dispose() }
  })


  it('shadow mode never blocks ready even when the activation contract disappears', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
    await prepareActivation({ ...env(dir), HEPHI_ENFORCEMENT: 'shadow' })
    const fake = fakeAgent()
    const mounted = mountWorkerGate({} as Context, fake.agent, { stateDir: dir })!
    try {
      await import('node:fs/promises').then(({ unlink }) => unlink(activationPath(dir, 'ticket-1')))
      const ready = { name: 'orchestrator_report', arguments: { state: 'ready' }, callId: 'shadow-missing-contract', token: Symbol() } as unknown as ToolExecution
      expect(await fake.callbacks().preExecute!(ready, async () => ({ kind: 'allow' }))).toEqual({ kind: 'allow' })
    } finally { mounted.dispose() }
  })

  it('applies the worker path limit to a spawned subagent and does not give it hephi_check', async () => {
    const { repo, baseSha } = await gitWorkspace()
    await run('git', ['remote', 'add', 'origin', 'git@github.com:paxxie2/dubbo.git'], { cwd: repo })
    const stateDir = await mkdtemp(join(tmpdir(), 'hephi-worker-'))
    await prepareActivation(env(stateDir, 'native', repo, baseSha))
    const child = fakeAgent('standard', 'subagent', repo, 'child-1', 'worker-ticket-1')
    const registered: string[] = []
    child.agent.ctx.tools.register = ((tool: { name: string }) => {
      registered.push(tool.name)
      return () => true
    }) as typeof child.agent.ctx.tools.register
    const context = {
      agents: { list: () => [child.agent], get: () => undefined },
      on: () => () => true,
    } as unknown as Context
    const dispose = installWorkerMount(context, { stateDir })
    try {
      expect(registered).not.toContain('hephi_check')
      expect(child.callbacks().prompt!.text()).toContain('path limits apply to this subagent')
      const next = async () => ({ kind: 'allow' as const })
      const call = (path: string) => ({
        name: 'write', arguments: { path }, callId: 'child-write', token: Symbol(), agent: child.agent, signal: new AbortController().signal,
      }) as unknown as ToolExecution
      expect((await child.callbacks().preExecute!(call('../outside.ts'), next)).kind).toBe('deny')
      expect(await child.callbacks().preExecute!(call('src/ok.ts'), next)).toEqual({ kind: 'allow' })
    } finally { dispose() }
  })

})
