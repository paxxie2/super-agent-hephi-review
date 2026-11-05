import { defineTool, type PreToolDecision, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { runCheck, type CheckTools, type NativeJobs } from './check-runner.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { loadKnowledgeBases } from '../kb/index.js'
import { activationIntentPath, activationIntentPresentSync, activationPath, defaultStateDir, executionModeOf, loadActivation, loadActivationSync, migrateActivationIntentSync, type ActivationContract, type ExecutionMode } from './activation.js'
import { createReadyGate, type ReadyVerifier } from './ready-gate.js'
import { inScope } from './discipline.js'
import { checkoutRelative, resolveWorkspace } from './workspace.js'
import { DELEGATION_TOOLS, MODIFYING_TOOLS } from './stage-control.js'
import { installStageControl, type StageAgents, type StageJobs, type StageSessionQuery, type StageSubagents } from './stage-mount.js'

// Structural type for the host's public, agent-scoped prompt service.
type PromptContext = Context & {
  systemPrompt: { section(section: { name: string; order: number; interpolate: boolean; text: () => string }): () => void }
}

// One invocation surface for contract changes: mutation, delegation, stage
// control, and report delivery are all bound to the mode read at mount.
function modeSensitive(name: string, args: unknown): boolean {
  if (MODIFYING_TOOLS.has(name) || DELEGATION_TOOLS.has(name) || name === 'hephi_stage' || name === 'hephi_check') return true
  return name === 'orchestrator_report' && (args as { state?: unknown } | null)?.state === 'ready'
}

/** The task card stays in the system prompt every turn so the goal survives long sessions and compaction. */
export function hephiTaskPrompt(contract: ActivationContract | undefined): string {
  const task = contract?.task
  if (!task) return ''
  const lines = [
    `HEPHI task goal (frozen; do not reinterpret or extend): ${task.goal}`,
    ...task.acceptance.map(a => `- ${a.id}: ${a.text} | may change: ${a.paths.join(', ')} | prove with hephi_check("${a.check}")`),
    ...(task.outOfScope.length ? [`Explicitly out of scope: ${task.outOfScope.join('; ')}`] : []),
    ...(task.budget ? [`Change budget requested by the Issue: ${[task.budget.maxFiles && `at most ${task.budget.maxFiles} files`, task.budget.maxChangedLines && `at most ${task.budget.maxChangedLines} changed lines`].filter(Boolean).join(', ')}.`] : []),
    'Do not delete existing tests. Change only what an acceptance item needs; if an item cannot be met within these paths, report blocked with the reason instead of widening the change.',
  ]
  return lines.join('\n')
}

function editedPath(args: unknown): string | undefined {
  const value = args as { path?: unknown; file_path?: unknown; filePath?: unknown } | null
  const path = value?.path ?? value?.file_path ?? value?.filePath
  return typeof path === 'string' ? path : undefined
}

export function hephiStartupPrompt(filePath: string, mode?: ExecutionMode, contractProblem?: string): string {
  const instructions = 'HEPHI is enabled for this Ticket. Before creating an implementation todo/plan or modifying code, load skill("hephi-superagent-control") and call hephi_get_contract; read the rules, allowed scope and acceptance checks. Run required hephi_check checks before push/PR and ready. Do not wait until ready to load them. On resuming, use the current contract and actual Session evidence rather than pretending earlier work followed these instructions.'
  if (!mode) {
    return `${instructions} The activation contract could not be read or resolved${contractProblem ? `: ${contractProblem}` : ''}. Implementation, delegation, stage control, and ready are blocked until an operator fixes the contract and remounts this Worker; do not treat this as an ordinary non-HEPHI task.`
  }
  const modeLine = mode === 'staged'
    ? 'Execution mode: staged. Use the hephi_stage serial stage cycle. Do not create implementation subagents or an Agent Team at any point before the final report. Do not implement or report ready before the first stage plan.'
    : 'Execution mode: native. Use the native DSH planning and Agent Team/subagent tools as needed. HEPHI installs no phase tool or phase record for this task; the cumulative ready verification still applies.'
  let repository: unknown
  try {
    repository = JSON.parse(readFileSync(filePath, 'utf8')).repository
  } catch {
    // The activation intent still applies even if its contract is missing.
    // Contract validity remains the existing ready gate's responsibility.
    return `${instructions} ${modeLine} The activation contract could not be read. Report the contract problem before implementation; do not treat this as an ordinary non-HEPHI task.`
  }
  if (typeof repository !== 'string') return `${instructions} ${modeLine} Resolve the invalid contract before implementation.`
  let hasKnowledgeBase: boolean
  try {
    hasKnowledgeBase = Boolean(loadKnowledgeBases()[repository])
  } catch {
    return `${instructions} ${modeLine} Knowledge-base configuration could not be read. Report the configuration problem before implementation; do not assume that no KB is configured.`
  }
  if (!hasKnowledgeBase) return `${instructions} ${modeLine} No knowledge base is configured for this repository. Continue with current-source investigation without requiring a KB query.`
  return `${instructions} ${modeLine} This repository has a configured knowledge base: after reading the contract and before the implementation todo/plan or code changes, call hephi_kb_search with the Issue title and relevant module or symbols, and read the results. A successful query with no matches is sufficient; inspect current source and continue. If this Session already queried successfully for the current contract, use that record. A query error is not a successful query: report the concrete problem rather than inventing KB evidence. KB content is reference only and does not replace current-code verification.`
}

export type MountedWorker = {
  ticketId: string
  dispose: () => void
}

export function isWorkerAgent(agent: Agent): boolean {
  const header = agent.session.header
  return header.agentPreset === 'dsh-superagent-worker' && header.origin !== 'subagent'
}

export function workerTicketId(agent: Agent): string | undefined {
  const id = String(agent.session.header.id)
  if (id.startsWith('worker-')) return id.slice('worker-'.length)
  return undefined
}

// The host Job registry is optional: native foreground checks must keep working
// on compositions that do not mount the background-job runtime.
function nativeJobs(ctx: Context): NativeJobs | undefined {
  try { return ctx.get?.('jobs') as NativeJobs | undefined } catch { return undefined }
}

export function mountWorkerGate(
  ctx: Context,
  agent: Agent,
  options: { stateDir?: string; verify?: ReadyVerifier } = {},
): MountedWorker | undefined {
  if (!isWorkerAgent(agent)) return undefined
  const ticketId = workerTicketId(agent)
  if (!ticketId) return undefined
  const stateDir = options.stateDir ?? defaultStateDir()
  migrateActivationIntentSync(stateDir, ticketId)
  const intentPath = activationIntentPath(stateDir, ticketId)
  if (!activationIntentPresentSync(intentPath)) return undefined
  const filePath = activationPath(stateDir, ticketId)

  // Mode selection is synchronous and bound before any tool is admitted. A bad
  // contract blocks this Worker's mutations and ready without breaking the host.
  let mountedContract: ActivationContract | undefined
  let mountProblem: string | undefined
  try {
    mountedContract = loadActivationSync(filePath)
  } catch (error) {
    mountProblem = `HEPHI activation contract unavailable: ${error instanceof Error ? error.message : String(error)}`
  }
  const mode = mountedContract ? executionModeOf(mountedContract) : undefined
  const boundHash = mountedContract?.contractHash
  const boundMode = mode
  const currentProblem = (): string | undefined => {
    if (!mountedContract || !boundHash || !boundMode) return mountProblem ?? 'HEPHI activation contract was unavailable at mount'
    let current: ActivationContract
    try {
      current = loadActivationSync(filePath)
    } catch (error) {
      return `HEPHI activation contract became unavailable: ${error instanceof Error ? error.message : String(error)}`
    }
    if (current.contractHash !== boundHash) return 'HEPHI activation contract changed during this Worker; stop and report the contract problem instead of reusing the mounted control'
    if (executionModeOf(current) !== boundMode) return `HEPHI execution mode changed from ${boundMode} to ${executionModeOf(current)} during this Worker; stop and report the contract problem`
    return undefined
  }

  // Ready re-reads and revalidates both identity and mode before the cumulative verifier.
  const loadBoundActivation = async (): Promise<ActivationContract> => {
    if (!mountedContract || !boundHash || !boundMode) throw new Error(mountProblem ?? 'HEPHI activation contract was unavailable at mount')
    const current = await loadActivation(filePath)
    if (current.contractHash !== boundHash) throw new Error('HEPHI activation contract changed during this Worker; cannot reuse mounted control')
    if (executionModeOf(current) !== boundMode) throw new Error(`HEPHI execution mode changed from ${boundMode} to ${executionModeOf(current)} during this Worker; cannot reuse mounted control`)
    return current
  }

  const stages = mountedContract && mode === 'staged'
    ? installStageControl(agent, stateDir, ticketId, {
        loadContract: loadBoundActivation,
        jobs: () => ctx.get('jobs') as StageJobs | undefined,
        sessionQuery: () => ctx.get('sessionQuery') as StageSessionQuery | undefined,
        subagents: () => ctx.get('subagents') as StageSubagents | undefined,
        agents: () => ctx.get('agents') as StageAgents | undefined,
      })
    : undefined

  let checking = false
  let internalCall: string | undefined
  const removeCheckGuard = agent.ctx.tools.guard(e => {
    if (e.callId === internalCall) return
    if (checking && (MODIFYING_TOOLS.has(e.name) || DELEGATION_TOOLS.has(e.name) || e.name === 'hephi_check'
      || (e.name === 'orchestrator_report' && (e.arguments as { state?: string })?.state === 'ready'))) return 'HEPHI synchronous check is running'
  })
  const removeCheck = agent.ctx.tools.register(defineTool({
    name: 'hephi_check', description: 'Run a frozen required check by checkId before ready.',
    parameters: { checkId: { type: 'string', required: true } },
    output: { schema: { type: 'json' as const }, render: (_a, value) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
    execute: async (args, execution) => {
      if (checking) throw new Error('HEPHI check already running')
      checking = true
      try {
        return JSON.parse(JSON.stringify(await runCheck({ stateDir, contract: await loadBoundActivation(), checkId: args.checkId,
          outer: execution, tools: agent.ctx.tools as unknown as CheckTools, jobs: nativeJobs(ctx), sessionCwd: agent.session.header.cwd,
          internal: id => { internalCall = id } })))
      } finally { checking = false; internalCall = undefined }
    },
  }))

  const gate = createReadyGate({
    loadActivation: loadBoundActivation,
    verify: options.verify ? (contract, execution) => stages
      ? stages.verify(() => options.verify!(contract, execution), execution.signal, execution.token)
      : options.verify!(contract, execution) : undefined,
  })
  // Early feedback for direct file edits; shell writes and unreadable tool paths are caught by the check and ready gates.
  const scopeProblem = async (execution: ToolExecution): Promise<string | undefined> => {
    if (!mountedContract || (execution.name !== 'write' && execution.name !== 'edit')) return undefined
    const path = editedPath(execution.arguments)
    if (!path) return undefined
    let file: string | undefined
    try {
      const sessionCwd = agent.session.header.cwd
      const checkout = await resolveWorkspace(mountedContract.workspace, sessionCwd)
      file = await checkoutRelative(checkout, sessionCwd ?? checkout, path)
    } catch (error) {
      return `HEPHI cannot resolve the Worker checkout: ${error instanceof Error ? error.message : String(error)}`
    }
    if (file === undefined) return `HEPHI denies ${path}: it is outside the Worker checkout`
    if (!inScope(mountedContract, file)) return `HEPHI task scope does not include ${file}; change only files an acceptance item needs, or report blocked`
    return undefined
  }
  const removePreExecute = agent.ctx.on('tools/pre-execute', async (execution: ToolExecution, next: () => Promise<PreToolDecision>) => {
    const problem = await scopeProblem(execution)
    return problem ? { kind: 'deny' as const, reason: problem } : gate.preExecute(execution, next)
  }, { prepend: true })
  const removeGuard = agent.ctx.tools.guard(gate.guard)
  // A contract or mode change must not leave an admitted native/staged window.
  const removeBinding = agent.ctx.tools.guard(execution => {
    if (!modeSensitive(execution.name, execution.arguments)) return undefined
    return currentProblem()
  })
  const removePrompt = (agent.ctx as PromptContext).systemPrompt.section({
    name: 'hephi:startup-instructions',
    order: 900,
    interpolate: false,
    text: () => [hephiStartupPrompt(filePath, mode, mountProblem), hephiTaskPrompt(mountedContract)].filter(Boolean).join('\n'),
  })
  let disposed = false
  return {
    ticketId,
    dispose: () => {
      if (disposed) return
      disposed = true
      removePreExecute()
      removeGuard()
      removeBinding()
      removePrompt()
      removeCheck()
      removeCheckGuard()
      gate.dispose()
      stages?.dispose()
    },
  }
}

export function installWorkerMount(ctx: Context, options: { stateDir?: string; verify?: ReadyVerifier } = {}): () => void {
  const mounted = new WeakMap<Agent, MountedWorker>()
  let closed = false
  const mount = (agent: Agent): MountedWorker | undefined => {
    if (closed || mounted.has(agent)) return mounted.get(agent)
    const result = mountWorkerGate(ctx, agent, options)
    if (result) mounted.set(agent, result)
    return result
  }
  // Mounting is synchronous: all gate registrations happen before the
  // listener returns. A mount error propagates through agent creation instead
  // of silently turning an activated Worker into a normal Worker.
  const disposeCreated = ctx.on('agent/created', ({ agent }) => {
    mount(agent)
    return undefined
  })
  const disposeDisposed = ctx.on('agent/disposed', ({ agent }) => {
    mounted.get(agent)?.dispose()
    mounted.delete(agent)
  })
  for (const agent of ctx.agents.list()) mount(agent)
  return () => {
    closed = true
    disposeCreated()
    disposeDisposed()
    for (const agent of ctx.agents.list()) mounted.get(agent)?.dispose()
  }
}
