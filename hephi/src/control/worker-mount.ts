import { defineTool, type PreToolDecision, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { incrementalSummaryLine, runCheck, type NativeJobs } from './check-runner.js'
import { createNativeCheckExecutor } from './native-check-execution.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadKnowledgeBases } from '../kb/index.js'
import { activationIntentPath, activationIntentPresentSync, activationPath, defaultStateDir, enforcementOf, executionModeOf, loadActivation, loadActivationSync, migrateActivationIntentSync, type ActivationContract, type EnforcementMode, type ExecutionMode } from './activation.js'
import { createReadyGate, type ReadyVerifier } from './ready-gate.js'
import { ADVISORY_BUDGET, advisoryBudgetWarnings, assetReadyReport, authorizedAcceptance, checkDiscipline, inScope, isProtectedAsset, summarizeChanges, type AssetRecord } from './discipline.js'
import { appendPlan, planIncludes, readPlan } from './plan-store.js'
import { checkoutRelative, resolveWorkspace } from './workspace.js'
import { DELEGATION_TOOLS, MODIFYING_TOOLS } from './stage-control.js'
import { installStageControl, type StageAgents, type StageJobs, type StageSessionQuery, type StageSubagents } from './stage-mount.js'
import { logDecision } from './decision-log.js'
import type { IncrementalChanges } from './check-store.js'
import type { SnapshotSealProvider } from './snapshot-seal.js'

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
    ...(task.budget
      ? [`Change budget requested by the Issue: ${[task.budget.maxFiles && `at most ${task.budget.maxFiles} files`, task.budget.maxChangedLines && `at most ${task.budget.maxChangedLines} changed lines`].filter(Boolean).join(', ')}. Exceeding it is refused.`]
      : [`Advisory change budget, recorded but not refused: at most ${ADVISORY_BUDGET.maxFiles} files and ${ADVISORY_BUDGET.maxChangedLines} changed lines.`]),
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
  const instructions = 'HEPHI is enabled for this Ticket. Before creating an implementation todo/plan or modifying code, load skill("hephi-superagent-control") and call hephi_get_contract; read the rules, allowed scope and acceptance checks. Commit your changes before running hephi_check: the check requires a clean workspace and uncommitted changes are rejected as workspace-dirty; after review feedback, add new commits and rerun the required checks. Create or update the PR and bind it with orchestrator_report progress and the real pr_number, then run every required hephi_check, then call orchestrator_report with state ready. Do not report ready before those checks pass, and do not wait for merge. On resuming, use the current contract and actual Session evidence rather than pretending earlier work followed these instructions.'
  if (!mode) {
    return `${instructions} The activation contract could not be read or resolved${contractProblem ? `: ${contractProblem}` : ''}. Implementation, delegation, stage control, and ready are blocked until an operator fixes the contract and remounts this Worker; do not treat this as an ordinary non-HEPHI task.`
  }
  const modeLine = mode === 'staged'
    ? 'Execution mode: staged. Use the hephi_stage serial stage cycle. Do not create implementation subagents or an Agent Team at any point before the final report. Do not implement or report ready before the first stage plan.'
    : 'Execution mode: native. HEPHI applies the same path limits to this worker and to subagents it spawns. HEPHI installs no phase tool or phase record; the cumulative ready verification still applies.'
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

/** v5.4 §2 ① (prompt-only): the hephi_check JSON result plus one readable delta line. */
export function checkResultText(value: { incrementalChanges?: Partial<IncrementalChanges> } | undefined): string {
  const json = JSON.stringify(value)
  const summary = incrementalSummaryLine(value)
  return summary === undefined ? json : `${json}\n${summary}`
}

/** Host plugin configuration that reaches the check runner (A3 / C4.5 trust boundary). */
export type WorkerControlConfig = {
  /** A3: allow the operator resolution channel. Default false; the environment never enables it. */
  allowOperatorResolutions?: boolean
  /** C4.5: per-check retry limit. Default 3; must be a positive integer. */
  retryLimit?: number
  /** H6=C detect-only: host adapter that seals the Worker Session's persisted log at check completion. */
  sealSnapshot?: SnapshotSealProvider
}

export function mountWorkerGate(
  ctx: Context,
  agent: Agent,
  options: { stateDir?: string; verify?: ReadyVerifier; ticketId?: string; scopeOnly?: boolean } & WorkerControlConfig = {},
): MountedWorker | undefined {
  const scopeOnly = options.scopeOnly === true
  if (!scopeOnly && !isWorkerAgent(agent)) return undefined
  const ticketId = options.ticketId ?? workerTicketId(agent)
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
  const enforcement: EnforcementMode = mountedContract ? enforcementOf(mountedContract) : 'enforce'
  const shadow = enforcement === 'shadow'
  const boundHash = mountedContract?.contractHash
  const boundMode = mode
  const boundEnforcement = enforcement
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
    if (enforcementOf(current) !== boundEnforcement) return `HEPHI enforcement mode changed from ${boundEnforcement} to ${enforcementOf(current)} during this Worker; stop and report the contract problem`
    return undefined
  }

  // Ready re-reads and revalidates both identity and mode before the cumulative verifier.
  const loadBoundActivation = async (): Promise<ActivationContract> => {
    if (!mountedContract || !boundHash || !boundMode) throw new Error(mountProblem ?? 'HEPHI activation contract was unavailable at mount')
    const current = await loadActivation(filePath)
    if (current.contractHash !== boundHash) throw new Error('HEPHI activation contract changed during this Worker; cannot reuse mounted control')
    if (executionModeOf(current) !== boundMode) throw new Error(`HEPHI execution mode changed from ${boundMode} to ${executionModeOf(current)} during this Worker; cannot reuse mounted control`)
    if (enforcementOf(current) !== boundEnforcement) throw new Error(`HEPHI enforcement mode changed from ${boundEnforcement} to ${enforcementOf(current)} during this Worker; cannot reuse mounted control`)
    return current
  }

  const stages = !scopeOnly && mountedContract && mode === 'staged' && !shadow
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
  // The check runs a nested bash call through the installed host's invocation
  // API; the adapter keeps the legacy single-call surface on older hosts.
  const checkExecution = createNativeCheckExecutor({ ctx: agent.ctx, tools: agent.ctx.tools })
  const removeCheckGuard = scopeOnly ? () => {} : agent.ctx.tools.guard(e => {
    if (e.callId === internalCall) return
    if (checking && (MODIFYING_TOOLS.has(e.name) || DELEGATION_TOOLS.has(e.name) || e.name === 'hephi_check'
      || (e.name === 'orchestrator_report' && (e.arguments as { state?: string })?.state === 'ready'))) return 'HEPHI synchronous check is running'
  })
  const removeCheck = scopeOnly || shadow ? () => {} : agent.ctx.tools.register(defineTool({
    name: 'hephi_check', description: 'Run a frozen required check by checkId before ready.',
    parameters: {
      checkId: { type: 'string', required: true },
      phase: {
        type: 'string', enum: ['red'],
        description: 'Set to "red" for the failing before-implementation run required by version 3 code task cards.',
      },
    },
    output: {
      schema: { type: 'json' as const },
      render: (_a, value) => [{ type: 'text' as const, text: checkResultText(value as { incrementalChanges?: Partial<IncrementalChanges> } | undefined) }],
    },
    execute: async (args, execution) => {
      const sessionId = String(agent.session.header.id)
      if (checking) {
        await logDecision(stateDir, {
          ticketId, sessionId, callId: String(execution.callId), tool: 'hephi_check', mode: 'enforce',
          effectiveDecision: 'deny', wouldDecision: 'deny', rule: 'check.running', reason: 'HEPHI check already running',
        })
        throw new Error('HEPHI check already running')
      }
      checking = true
      try {
        const phase = (args as { phase?: unknown }).phase === 'red' ? 'red' as const : undefined
        const record = await runCheck({ stateDir, contract: await loadBoundActivation(), checkId: args.checkId, phase,
          outer: execution, tools: checkExecution, jobs: nativeJobs(ctx), sessionCwd: agent.session.header.cwd,
          allowOperatorResolutions: options.allowOperatorResolutions === true, retryLimit: options.retryLimit,
          sealSnapshot: options.sealSnapshot, internal: id => { internalCall = id } })
        const passed = record.status === 'passed' && record.exitCode === 0
        await logDecision(stateDir, {
          ticketId, sessionId, callId: String(execution.callId), tool: 'hephi_check', mode: 'enforce',
          effectiveDecision: passed ? 'allow' : 'deny', wouldDecision: passed ? 'allow' : 'deny',
          rule: passed ? 'check.pass' : `check.${record.status}`, reason: record.reason,
          contractHash: mountedContract?.contractHash,
        })
        const value = JSON.parse(JSON.stringify(record)) as { advisory?: string[] }
        try {
          const contract = await loadBoundActivation()
          const workspace = await resolveWorkspace(contract.workspace, agent.session.header.cwd)
          const advisory = advisoryBudgetWarnings(contract, await summarizeChanges(workspace, contract.baseSha))
          if (advisory.length) {
            value.advisory = advisory
            await logDecision(stateDir, {
              ticketId, sessionId, callId: String(execution.callId), tool: 'hephi_check', mode: 'enforce',
              effectiveDecision: 'allow', wouldDecision: 'allow', rule: 'budget.advisory', reason: advisory.join('; '),
              contractHash: contract.contractHash,
            })
          }
        } catch {
          // The advisory diff is not part of the check result. A git failure here must not fail a check that already finished.
        }
        return value
      } finally { checking = false; internalCall = undefined }
    },
  }))

  // C4.2 (normal form): the Worker declares an append-only change plan for the current
  // contract; write/edit are intercepted against it. In shadow mode the tool is NOT
  // registered (the Worker cannot write a real plan) and only a wouldDecision is recorded.
  const PLAN_OUTPUT = {
    schema: { type: 'json' as const },
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  }
  const planInputProblems = (contract: ActivationContract, files: string[]): string[] => {
    const problems: string[] = []
    if (files.length === 0) problems.push('hephi_plan requires at least one planned file')
    for (const file of files) {
      if (!file) { problems.push('planned file must be a non-empty string'); continue }
      // C4.2: every planned file must stay inside the contract allowedPaths/task scope;
      // a plan never widens the contract. exact paths and globs share this check.
      if (!inScope(contract, file)) problems.push(`planned file is outside the contract allowedPaths/task scope: ${file}`)
    }
    return problems
  }
  // C4.2 tool registration (M1 fix):
  //  - shadow: never registered (the Worker cannot write a real plan; only wouldDecision is recorded);
  //  - contract invalid: never registered;
  //  - `verification.requirePlan === true`: ALWAYS registered (even without a task card), otherwise
  //    fail-closed enforcement would deadlock a contract that has no way to declare a plan;
  //  - requirePlan unset/false (default, optional C4.2): keep the earlier "needs a frozen task card"
  //    condition so legacy task-card-less contracts keep their previous tool surface.
  const requirePlan = mountedContract?.verification.requirePlan === true
  const removePlan = scopeOnly || shadow || !mountedContract || (!requirePlan && mountedContract.task === undefined) ? () => {} : agent.ctx.tools.register(defineTool({
    name: 'hephi_plan', description: 'Declare/append the change plan (C4.2). Planned files must be inside the contract scope. When the contract sets verification.requirePlan=true, write/edit and ready are denied until a plan for the current contract exists; otherwise the plan is optional.',
    parameters: { files: { type: 'array', items: { type: 'string' }, required: true }, note: { type: 'string' } },
    output: PLAN_OUTPUT,
    execute: async (args, execution) => {
      const sessionId = String(agent.session.header.id)
      const contract = await loadBoundActivation()
      const files = Array.isArray(args.files) ? args.files.map(file => String(file).trim()) : []
      const problems = planInputProblems(contract, files)
      if (problems.length) {
        await logDecision(stateDir, {
          ticketId, sessionId, callId: String(execution.callId), tool: 'hephi_plan', mode: 'enforce',
          effectiveDecision: 'deny', wouldDecision: 'deny', rule: 'plan.recorded', reason: problems.join('; '),
          contractHash: contract.contractHash,
        })
        throw new Error(`HEPHI plan rejected: ${problems.join('; ')}`)
      }
      let appended
      try {
        appended = await appendPlan(stateDir, ticketId, {
          contractHash: contract.contractHash, files, ...(typeof args.note === 'string' ? { note: args.note } : {}),
        })
      } catch (error) {
        throw new Error(`HEPHI plan could not be recorded: ${error instanceof Error ? error.message : String(error)}`)
      }
      const plan = await readPlan(stateDir, ticketId, contract.contractHash)
      // Rule `plan.recorded` is new; decisions-format.md registration is pending Lead
      // (that file is outside this change's allowed list).
      await logDecision(stateDir, {
        ticketId, sessionId, callId: String(execution.callId), tool: 'hephi_plan', mode: 'enforce',
        effectiveDecision: 'allow', wouldDecision: 'allow', rule: 'plan.recorded',
        reason: `recorded ${files.join(', ')} (entry ${appended.entry.at}; ${plan?.entries ?? 1} plan version(s) for this contract)`,
        contractHash: contract.contractHash,
      })
      return { files, entries: plan?.entries ?? 1 }
    },
  }))

  // Shadow ready: only range/discipline is computed, recorded as wouldDecision, and always allowed.
  const shadowVerify: ReadyVerifier = async (contract, execution) => {
    let wouldDecision: 'allow' | 'deny' = 'allow'
    let reason: string | undefined
    let assetLog: AssetRecord[] = []
    try {
      const workspace = await resolveWorkspace(contract.workspace, execution.agent?.session.header.cwd)
      const report = await assetReadyReport(contract, workspace)
      assetLog = report.records
      await checkDiscipline(contract, workspace)
      if (report.problems.length) {
        wouldDecision = 'deny'
        reason = `shadow would deny: ${report.problems.join('; ')}`
      }
    } catch (error) {
      wouldDecision = 'deny'
      reason = `shadow would deny: ${error instanceof Error ? error.message : String(error)}`
    }
    const sessionId = execution.agent?.session.header.id
    // C1 audit records are record-only; shadow mode never changes the real decision.
    for (const record of assetLog) {
      await logDecision(stateDir, {
        ticketId, sessionId: sessionId === undefined || sessionId === null ? undefined : String(sessionId),
        callId: String(execution.callId), tool: 'orchestrator_report', mode: 'shadow',
        effectiveDecision: 'allow', wouldDecision: 'allow', rule: record.rule, reason: record.detail,
        contractHash: contract.contractHash,
      })
    }
    await logDecision(stateDir, {
      ticketId, sessionId: sessionId === undefined || sessionId === null ? undefined : String(sessionId),
      callId: String(execution.callId), tool: 'orchestrator_report', mode: 'shadow',
      effectiveDecision: 'allow', wouldDecision, rule: wouldDecision === 'allow' ? 'ready.pass' : 'ready.discipline',
      reason, contractHash: contract.contractHash,
    })
    return { ok: true }
  }
  // C1: shell/git changes bypass the write/edit tools, so ready rechecks the final diff and
  // records authorized/record-only changes for audit. A protected-asset deny here is not
  // overridden by the rest of ready.
  const assetReadyGuard = async (contract: ActivationContract, execution: ToolExecution): Promise<string | undefined> => {
    let report: Awaited<ReturnType<typeof assetReadyReport>>
    try {
      const workspace = await resolveWorkspace(contract.workspace, execution.agent?.session.header.cwd)
      report = await assetReadyReport(contract, workspace)
    } catch {
      // Workspace resolution errors stay with the existing verifier so its reason is unchanged.
      return undefined
    }
    const sessionId = execution.agent?.session.header.id
    for (const record of report.records) {
      await logDecision(stateDir, {
        ticketId, sessionId: sessionId === undefined || sessionId === null ? undefined : String(sessionId),
        callId: String(execution.callId), tool: 'orchestrator_report', mode: 'enforce',
        effectiveDecision: 'allow', wouldDecision: 'allow', rule: record.rule, reason: record.detail,
        contractHash: contract.contractHash,
      })
    }
    if (report.problems.length === 0) {
      const warnings = advisoryBudgetWarnings(contract, report.changes)
      if (warnings.length) {
        await logDecision(stateDir, {
          ticketId, sessionId: sessionId === undefined || sessionId === null ? undefined : String(sessionId),
          callId: String(execution.callId), tool: 'orchestrator_report', mode: 'enforce',
          effectiveDecision: 'allow', wouldDecision: 'allow', rule: 'budget.advisory', reason: warnings.join('; '),
          contractHash: contract.contractHash,
        })
      }
      return undefined
    }
    const rule = report.problems.some(problem => problem.includes(' deleted ')) ? 'asset.unauthorized-delete' : 'asset.unauthorized-modify'
    const reason = `HEPHI protected acceptance asset change is not authorized: ${report.problems.join('; ')}`
    await logDecision(stateDir, {
      ticketId, sessionId: sessionId === undefined || sessionId === null ? undefined : String(sessionId),
      callId: String(execution.callId), tool: 'orchestrator_report', mode: 'enforce',
      effectiveDecision: 'deny', wouldDecision: 'deny', rule, reason, contractHash: contract.contractHash,
    })
    return reason
  }
  const guardedVerify: ReadyVerifier | undefined = options.verify
    ? async (contract, execution) => {
        const denied = await assetReadyGuard(contract, execution)
        if (denied) return { ok: false, reason: denied }
        return options.verify!(contract, execution)
      }
    : undefined
  const gate = scopeOnly ? undefined : createReadyGate({
    loadActivation: loadBoundActivation,
    allowUnavailable: shadow,
    verify: shadow ? shadowVerify : guardedVerify ? (contract, execution) => stages
      ? stages.verify(() => guardedVerify(contract, execution), execution.signal, execution.token)
      : guardedVerify(contract, execution) : undefined,
  })
  // Early feedback for direct file edits; shell writes and unreadable tool paths are caught by the check and ready gates.
  const scopeProblem = async (execution: ToolExecution): Promise<string | undefined> => {
    if (!mountedContract) return undefined
    // C4.2 shadow mode: hephi_plan is not registered, so nothing can be written; record what
    // the decision would have been for the model-visible attempt instead of enforcing.
    if (shadow && execution.name === 'hephi_plan') {
      const args = (execution.arguments ?? {}) as { files?: unknown }
      const files = Array.isArray(args.files) ? args.files.map(file => String(file).trim()) : []
      const problems = planInputProblems(mountedContract, files)
      await logDecision(stateDir, {
        ticketId, sessionId: String(agent.session.header.id), callId: String(execution.callId), tool: 'hephi_plan', mode: 'shadow',
        effectiveDecision: 'allow', wouldDecision: problems.length ? 'deny' : 'allow',
        rule: 'plan.recorded', reason: problems.length ? `shadow would deny: ${problems.join('; ')}` : `shadow would record plan: ${files.join(', ')}`,
        contractHash: mountedContract.contractHash,
      })
      return undefined
    }
    if (execution.name !== 'write' && execution.name !== 'edit') return undefined
    const path = editedPath(execution.arguments)
    if (!path) return undefined
    const log = async (rule: string, problem?: string, recordReason?: string) => {
      await logDecision(stateDir, {
        ticketId, sessionId: String(agent.session.header.id), callId: String(execution.callId), tool: execution.name,
        mode: shadow ? 'shadow' : 'enforce',
        effectiveDecision: shadow ? 'allow' : problem ? 'deny' : 'allow',
        wouldDecision: problem ? 'deny' : 'allow',
        rule, reason: problem ?? recordReason, contractHash: mountedContract.contractHash,
      })
    }
    const decide = (problem: string): string | undefined => (shadow ? undefined : problem)
    let file: string | undefined
    let checkout: string | undefined
    try {
      const sessionCwd = agent.session.header.cwd
      checkout = await resolveWorkspace(mountedContract.workspace, sessionCwd)
      file = await checkoutRelative(checkout, sessionCwd ?? checkout, path)
    } catch (error) {
      const problem = `HEPHI cannot resolve the Worker checkout: ${error instanceof Error ? error.message : String(error)}`
      await log('scope.outside-checkout', problem)
      return decide(problem)
    }
    if (file === undefined) {
      const problem = `HEPHI denies ${path}: it is outside the Worker checkout`
      await log('scope.outside-checkout', problem)
      return decide(problem)
    }
    if (!inScope(mountedContract, file)) {
      const problem = `HEPHI task scope does not include ${file}; change only files an acceptance item needs, or report blocked`
      await log('scope.outside-task', problem)
      return decide(problem)
    }
    // C4.2: when verification.requirePlan=true this is fail-closed (no plan -> plan.not-declared);
    // otherwise the plan is OPTIONAL and only an existing plan constrains targets (default, not an
    // active interception). This runs before the C1 protected-asset check so denial reasons stay
    // distinguishable; shadow mode records the wouldDecision but does not enforce.
    let plan
    try {
      plan = await readPlan(stateDir, ticketId, mountedContract.contractHash)
    } catch (error) {
      const problem = `HEPHI plan is unreadable; refusing edits until an operator fixes it: ${error instanceof Error ? error.message : String(error)}`
      await log('plan.outside-plan', problem)
      return decide(problem)
    }
    if (plan === undefined) {
      // C4.2 M1 (fail-closed): only contracts that explicitly opted in with requirePlan are
      // forced to declare a plan. Default (false/absent) keeps C4.2 optional — documented as
      // OPTIONAL, not as an active interception.
      if (mountedContract.verification.requirePlan === true) {
        const problem = `plan.not-declared: HEPHI requirePlan is enabled for this contract but no plan exists; call hephi_plan to declare the files before writing/editing ${file}`
        await log('plan.not-declared', problem)
        return decide(problem)
      }
    } else if (!planIncludes(plan, file)) {
      const planned = plan.files.slice(0, 10).join(', ') + (plan.files.length > 10 ? ` (+${plan.files.length - 10} more)` : '')
      const problem = `HEPHI plan for this contract does not include ${file}; declare it with hephi_plan or report blocked. Planned: ${planned}`
      await log('plan.outside-plan', problem)
      return decide(problem)
    }
    // C1: modifying an existing protected acceptance asset requires an authorization in the
    // same acceptance item for this exact file and the `modify` operation. Creating a new file
    // is not covered by this rule; delete/migrate go through the ready-time final-diff recheck.
    if (checkout !== undefined && isProtectedAsset(mountedContract, file) && existsSync(join(checkout, file))) {
      const acceptance = authorizedAcceptance(mountedContract, file, 'modify')
      if (!acceptance) {
        const problem = `HEPHI protected acceptance asset ${file} requires its acceptance item to authorize "modify"; report blocked instead of editing it`
        await log('asset.unauthorized-modify', problem)
        return decide(problem)
      }
      await log('asset.authorized', undefined, `${file} modified under authorization ${acceptance}`)
    }
    await log('scope.allowed')
    return undefined
  }
  const removePreExecute = agent.ctx.on('tools/pre-execute', async (execution: ToolExecution, next: () => Promise<PreToolDecision>) => {
    const problem = await scopeProblem(execution)
    if (problem) return { kind: 'deny' as const, reason: problem }
    return gate ? gate.preExecute(execution, next) : next()
  }, { prepend: true })
  const removeGuard = gate ? agent.ctx.tools.guard(gate.guard) : () => {}
  // A contract or mode change must not leave an admitted native/staged window.
  const removeBinding = agent.ctx.tools.guard(execution => {
    if (!modeSensitive(execution.name, execution.arguments)) return undefined
    return currentProblem()
  })
  const removePrompt = shadow ? () => {} : (agent.ctx as PromptContext).systemPrompt.section({
    name: 'hephi:startup-instructions',
    order: 900,
    interpolate: false,
    text: () => (scopeOnly
      ? [hephiTaskPrompt(mountedContract), 'HEPHI path limits apply to this subagent: write and edit outside the task scope are denied.'].filter(Boolean).join('\n')
      : [hephiStartupPrompt(filePath, mode, mountProblem), hephiTaskPrompt(mountedContract)].filter(Boolean).join('\n')),
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
      removePlan()
      gate?.dispose()
      stages?.dispose()
    },
  }
}

function ancestorTicketId(ctx: Context, agent: Agent): string | undefined {
  const header = agent.session.header as { origin?: string; parentSession?: string }
  if (header.origin !== 'subagent') return undefined
  let parentId = header.parentSession
  const agents = (ctx as Context & { agents?: { get?(id: string): Agent | undefined } }).agents
  for (let depth = 0; parentId && depth < 8; depth += 1) {
    if (parentId.startsWith('worker-')) return parentId.slice('worker-'.length)
    const parent = agents?.get?.(parentId)
    parentId = (parent?.session.header as { parentSession?: string } | undefined)?.parentSession
    if (!parent) return undefined
  }
  return undefined
}

export function installWorkerMount(ctx: Context, options: { stateDir?: string; verify?: ReadyVerifier } & WorkerControlConfig = {}): () => void {
  const mounted = new WeakMap<Agent, MountedWorker>()
  let closed = false
  const mount = (agent: Agent): MountedWorker | undefined => {
    if (closed || mounted.has(agent)) return mounted.get(agent)
    const direct = mountWorkerGate(ctx, agent, options)
    if (direct) {
      mounted.set(agent, direct)
      return direct
    }
    const ticketId = ancestorTicketId(ctx, agent)
    if (!ticketId) return undefined
    const inherited = mountWorkerGate(ctx, agent, { ...options, ticketId, scopeOnly: true })
    if (inherited) mounted.set(agent, inherited)
    return inherited
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
