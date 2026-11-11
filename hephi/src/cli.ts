#!/usr/bin/env node
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseVerificationConfig } from './contracts/checks.js'
import { taskCardSchema } from './contracts/task.js'
import { activationPath, defaultStateDir, loadActivation, prepareActivation } from './control/activation.js'
import {
  RESOLUTION_BASES, RESOLUTION_KINDS, appendResolution, readRun, readRuns,
  type CheckRunRecord, type ResolutionBasis, type ResolutionKind,
} from './control/check-store.js'
import { readPlanEntries } from './control/plan-store.js'
import { allowedPath } from './control/repository.js'

export type CliIo = { out(message: string): void; err(message: string): void }
const consoleIo: CliIo = { out: message => console.log(message), err: message => console.error(message) }

const RESOLUTION_STATUSES = ['running', 'terminated', 'unavailable'] as const
type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number]

export const USAGE = `usage: hephi prepare
       hephi resolve --ticket <id> --run <runId>
                     --basis <host-terminal|operator-risk-accepted>
                     --status <running|terminated|unavailable>
                     (--host-query <raw query output> | --host-query-file <path>)
                     --operator <name> [--accept-risk] [--state-dir <dir>]
                     [--operator-config <path>]
       hephi resolve --kind retry-reset --ticket <id> --check <checkId>
                     --basis <host-terminal|operator-risk-accepted>
                     --status <running|terminated|unavailable>
                     (--host-query <raw query output> | --host-query-file <path>)
                     --operator <name> [--accept-risk] [--state-dir <dir>]
                     [--operator-config <path>]
       hephi stats [--state-dir <dir>] [--ticket <id>] [--rule <prefix>] [--json]
       hephi summary --ticket <id> [--state-dir <dir>] [--coverage-hint <file>] [--json] [--out <file>]
       hephi lint-task <task.json> [--json]

hephi stats reads (never writes) decision logs under <stateDir>/hephi/<ticketId>/decisions.jsonl.
With --ticket it summarizes one Ticket; without it scans every Ticket directory and prints a
per-Ticket table. Corrupt lines are counted and reported on stderr, never trusted. --json emits
machine-readable output; --rule filters by rule-number prefix.

hephi lint-task validates a task bundle offline (no network/git): task card (hephi-task JSON),
ticketId, allowedPaths and the project checks referenced by every acceptance item. It only reads
the given file; warnings (too many acceptance items, too-wide allowedPaths) do not fail the lint.

hephi resolve records an A3 operator resolution. With the default --kind run-unblock it
applies to one unresolved (running/unknown) execution; it only restores the right to run
the check again, the resolved execution stays non-passing evidence, and its
run.json/output.log are never edited.

--kind retry-reset (C4.5) resets the derived retry counter for exactly one check
(ticket + contract + check id) after the operator has reviewed the repeated failures.
Other checks keep their counters; the switch/trust boundary is the same as run-unblock.

The command is disabled by default and the process environment is NOT an enable channel.

Plugin side (runner/verifier): only the host plugin config field allowOperatorResolutions
(cordis.patch.yml, read in apply(ctx, config)) can enable the resolution channel.

CLI side (trust boundary): the operator must pass --operator-config <path> (or set the
HEPHI_OPERATOR_CONFIG path in their own shell, which is only a path hint, not a permission).
The file must be a regular JSON file with {"allowOperatorResolutions": true} and must not be
accessible by group/other (mode & 0o077 === 0, e.g. 0600). A Worker-inherited
HEPHI_ALLOW_OPERATOR_RESOLUTIONS environment variable has no effect at all.

--status running      host still reports the execution: refuse to resolve.
--kind <kind>         run-unblock (default) or retry-reset (C4.5).
--check <checkId>     retry-reset only: the single check whose counter is reset.
--status terminated   host confirmed the execution ended (result lost): basis host-terminal.
--status unavailable  host query unavailable: requires --accept-risk and
                      --basis operator-risk-accepted.
--accept-risk         only valid with --basis operator-risk-accepted.`

class UsageError extends Error {}

function safeId(value: string, what: string): string {
  if (!/^[\w-]+$/.test(value)) throw new UsageError(`${what} is not a safe identifier: ${value}`)
  return value
}

function parseResolveArgs(args: string[]): {
  kind: ResolutionKind; ticketId: string; runId?: string; checkId?: string
  basis: ResolutionBasis; status: ResolutionStatus
  hostQuery?: string; hostQueryFile?: string; operator: string; acceptRisk: boolean; stateDir?: string
  operatorConfig?: string
} {
  const values = new Map<string, string>()
  let acceptRisk = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--accept-risk') { acceptRisk = true; continue }
    if (arg === '--help' || arg === '-h') throw new UsageError('help')
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument: ${arg}`)
    if (values.has(arg)) throw new UsageError(`duplicate argument: ${arg}`)
    const value = args[index + 1]
    if (value === undefined) throw new UsageError(`missing value for ${arg}`)
    index += 1
    values.set(arg, value)
  }
  const allowed = new Set(['--kind', '--ticket', '--run', '--check', '--basis', '--status', '--host-query', '--host-query-file', '--operator', '--state-dir', '--operator-config'])
  for (const key of values.keys()) if (!allowed.has(key)) throw new UsageError(`unknown argument: ${key}`)
  const ticket = values.get('--ticket'), run = values.get('--run'), checkId = values.get('--check'), basis = values.get('--basis')
  const status = values.get('--status'), operator = values.get('--operator')
  const rawKind = values.get('--kind') ?? 'run-unblock'
  if (!(RESOLUTION_KINDS as readonly string[]).includes(rawKind)) throw new UsageError(`--kind must be one of: ${RESOLUTION_KINDS.join(', ')}`)
  const kind = rawKind as ResolutionKind
  if (ticket === undefined) throw new UsageError('--ticket is required')
  if (kind === 'run-unblock') {
    if (run === undefined) throw new UsageError('--run is required')
    if (checkId !== undefined) throw new UsageError('--check is only accepted with --kind retry-reset')
  } else {
    if (checkId === undefined) throw new UsageError('--check is required with --kind retry-reset')
    if (run !== undefined) throw new UsageError('--run is not accepted with --kind retry-reset')
  }
  if (basis === undefined) throw new UsageError('--basis is required')
  if (status === undefined) throw new UsageError('--status is required')
  if (operator === undefined) throw new UsageError('--operator is required')
  if (!RESOLUTION_BASES.includes(basis as ResolutionBasis)) throw new UsageError(`--basis must be one of: ${RESOLUTION_BASES.join(', ')}`)
  if (!(RESOLUTION_STATUSES as readonly string[]).includes(status)) throw new UsageError(`--status must be one of: ${RESOLUTION_STATUSES.join(', ')}`)
  const hostQuery = values.get('--host-query'), hostQueryFile = values.get('--host-query-file')
  if (hostQuery !== undefined && hostQueryFile !== undefined) throw new UsageError('set only one of --host-query and --host-query-file')
  if (hostQuery === undefined && hostQueryFile === undefined) throw new UsageError('one of --host-query and --host-query-file is required')
  const name = operator.trim()
  if (!name) throw new UsageError('--operator must not be empty')
  if (name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) throw new UsageError('--operator must be a single-line value of at most 200 characters')
  if (hostQuery !== undefined && hostQuery.length > 100_000) throw new UsageError('--host-query is too long')
  const parsedBasis = basis as ResolutionBasis
  if (acceptRisk && parsedBasis !== 'operator-risk-accepted') throw new UsageError('--accept-risk is only accepted with --basis operator-risk-accepted')
  return {
    kind, ticketId: safeId(ticket, '--ticket'),
    ...(run === undefined ? {} : { runId: safeId(run, '--run') }),
    ...(checkId === undefined ? {} : { checkId: safeId(checkId, '--check') }),
    basis: parsedBasis,
    status: status as ResolutionStatus, hostQuery, hostQueryFile, operator: name, acceptRisk,
    stateDir: values.get('--state-dir'),
    operatorConfig: values.get('--operator-config'),
  }
}

/**
 * A3 operator-only gate for the CLI. The process environment is not an enable channel: the
 * operator provides a mode-0600 JSON config explicitly (`--operator-config` or the
 * HEPHI_OPERATOR_CONFIG *path* in their own shell). The file permission check keeps a
 * Worker-readable/writable config from enabling the channel.
 */
async function operatorGate(options: { operatorConfig?: string }, env: NodeJS.ProcessEnv): Promise<{ ok: true } | { ok: false; problem: string }> {
  const path = options.operatorConfig ?? env.HEPHI_OPERATOR_CONFIG?.trim()
  if (!path) {
    return { ok: false, problem: 'operator resolutions are disabled: provide --operator-config <path> to a mode-0600 JSON file with {"allowOperatorResolutions": true}; the process environment (including HEPHI_ALLOW_OPERATOR_RESOLUTIONS) is not an enable channel' }
  }
  let stat
  try { stat = statSync(path) } catch (error) {
    return { ok: false, problem: `operator resolutions are disabled: cannot read operator config ${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!stat.isFile()) return { ok: false, problem: `operator resolutions are disabled: operator config ${path} is not a regular file` }
  const mode = stat.mode & 0o777
  if ((mode & 0o077) !== 0) {
    return { ok: false, problem: `operator resolutions are disabled: operator config ${path} is accessible by group/other (mode ${mode.toString(8)}); require mode 0600 (mode & 0o077 === 0)` }
  }
  let parsed: unknown
  try { parsed = JSON.parse(await readFile(path, 'utf8')) } catch (error) {
    return { ok: false, problem: `operator resolutions are disabled: operator config ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as { allowOperatorResolutions?: unknown }).allowOperatorResolutions !== true) {
    return { ok: false, problem: `operator resolutions are disabled: operator config ${path} must contain {"allowOperatorResolutions": true}` }
  }
  return { ok: true }
}

async function resolveCommand(args: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  let options: ReturnType<typeof parseResolveArgs>
  try { options = parseResolveArgs(args) } catch (error) {
    if (error instanceof UsageError && error.message === 'help') { io.out(USAGE); return 0 }
    io.err(error instanceof Error ? error.message : String(error))
    io.err(USAGE)
    return 2
  }
  const gate = await operatorGate(options, env)
  if (!gate.ok) { io.err(gate.problem); return 1 }
  if (options.status === 'running') {
    io.err('host still reports the check as running; stop it, confirm a terminal state and then resolve')
    return 1
  }
  if (options.basis === 'host-terminal' && options.status !== 'terminated') {
    io.err('--basis host-terminal requires --status terminated (a host query confirmed the end of the execution)')
    return 2
  }
  if (options.basis === 'operator-risk-accepted' && (options.status !== 'unavailable' || !options.acceptRisk)) {
    io.err('--basis operator-risk-accepted requires --status unavailable and --accept-risk (host query was not available)')
    return 2
  }
  let hostQuery: string
  try {
    hostQuery = options.hostQuery ?? await readFile(options.hostQueryFile!, 'utf8')
  } catch (error) {
    io.err(`cannot read --host-query-file: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  if (!hostQuery.trim()) { io.err('the host query evidence must not be empty'); return 2 }
  const stateDir = defaultStateDir(options.stateDir)
  try {
    if (options.kind === 'retry-reset') {
      // C4.5: the counter key is ticket + contractHash + checkId. Derive the contract
      // from the latest record for that check (the reset must target a real counter).
      const runs = (await readRuns(stateDir, options.ticketId)).filter(record => record.checkId === options.checkId)
      const latest = runs.at(-1)
      if (!latest) {
        io.err(`no check records for ${options.checkId}; nothing to reset`)
        return 1
      }
      const result = await appendResolution(stateDir, {
        kind: 'retry-reset', ticketId: options.ticketId, contractHash: latest.contractHash,
        checkId: options.checkId!, basis: options.basis, hostQuery, operator: options.operator,
      })
      if (result.appended) {
        io.out(`HEPHI retry reset recorded: ticket=${options.ticketId} check=${options.checkId} contract=${latest.contractHash} basis=${options.basis} operator=${options.operator}`)
      } else {
        io.out(`HEPHI retry reset already recorded: ticket=${options.ticketId} check=${options.checkId} (idempotent, no new record)`)
      }
      return 0
    }
    const record = await readRun(stateDir, options.ticketId, options.runId!)
    if (record.status !== 'running' && record.status !== 'unknown') {
      io.err(`check run ${options.runId} is already settled (status=${record.status}); operator resolution only applies to running/unknown executions`)
      return 1
    }
    const result = await appendResolution(stateDir, {
      ticketId: options.ticketId, contractHash: record.contractHash, runId: options.runId!,
      basis: options.basis, hostQuery, operator: options.operator,
    })
    if (result.appended) {
      io.out(`HEPHI resolution recorded: ticket=${options.ticketId} run=${options.runId} basis=${options.basis} operator=${options.operator}`)
    } else {
      io.out(`HEPHI resolution already recorded: ticket=${options.ticketId} run=${options.runId} (idempotent, no new record)`)
    }
    return 0
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error))
    return 1
  }
}

// ---- stats (C4.9)：只读汇总决策日志，不写任何文件 -------------------------

const STATS_USAGE = `usage: hephi stats [--state-dir <dir>] [--ticket <id>] [--rule <prefix>] [--json]`

const DECISION_MODES = ['enforce', 'shadow'] as const
const DECISION_VALUES = ['allow', 'deny'] as const
type DecisionMode = (typeof DECISION_MODES)[number]
type DecisionValue = (typeof DECISION_VALUES)[number]

type DecisionEntry = {
  seq: number
  at: string
  rule: string
  mode: DecisionMode
  effectiveDecision: DecisionValue
  wouldDecision: DecisionValue
}

type TicketStats = {
  ticketId: string
  entries: number
  matched: number
  corruptLines: number
  rules: Record<string, number>
  modes: Record<DecisionMode, number>
  effectiveDecision: Record<DecisionValue, number>
  earliest: string | null
  latest: string | null
}

type StatsTotals = Omit<TicketStats, 'ticketId'> & { tickets: number; skippedTickets: number }

const SAFE_TICKET_ID = /^[A-Za-z0-9._-]+$/
const CORRUPT_WARNINGS_PER_TICKET = 3

function emptyTicketStats(ticketId: string): TicketStats {
  return {
    ticketId, entries: 0, matched: 0, corruptLines: 0, rules: {},
    modes: { enforce: 0, shadow: 0 }, effectiveDecision: { allow: 0, deny: 0 },
    earliest: null, latest: null,
  }
}

function emptyStatsTotals(): StatsTotals {
  return {
    tickets: 0, entries: 0, matched: 0, corruptLines: 0, rules: {},
    modes: { enforce: 0, shadow: 0 }, effectiveDecision: { allow: 0, deny: 0 },
    earliest: null, latest: null, skippedTickets: 0,
  }
}

function decisionEntry(value: unknown): { entry: DecisionEntry } | { reason: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { reason: 'not a JSON object' }
  const record = value as Record<string, unknown>
  if (!Number.isSafeInteger(record.seq) || (record.seq as number) <= 0) return { reason: 'missing or invalid seq' }
  if (typeof record.at !== 'string' || record.at.length === 0 || Number.isNaN(Date.parse(record.at))) {
    return { reason: 'missing or invalid at timestamp' }
  }
  if (typeof record.rule !== 'string' || record.rule.trim().length === 0) return { reason: 'missing or invalid rule' }
  if (!(DECISION_MODES as readonly unknown[]).includes(record.mode)) return { reason: 'missing or invalid mode' }
  if (!(DECISION_VALUES as readonly unknown[]).includes(record.effectiveDecision)) {
    return { reason: 'missing or invalid effectiveDecision' }
  }
  if (!(DECISION_VALUES as readonly unknown[]).includes(record.wouldDecision)) {
    return { reason: 'missing or invalid wouldDecision' }
  }
  return {
    entry: {
      seq: record.seq as number,
      at: record.at,
      rule: record.rule,
      mode: record.mode as DecisionMode,
      effectiveDecision: record.effectiveDecision as DecisionValue,
      wouldDecision: record.wouldDecision as DecisionValue,
    },
  }
}

function addEntry(stats: TicketStats | StatsTotals, entry: DecisionEntry): void {
  stats.matched += 1
  stats.rules[entry.rule] = (stats.rules[entry.rule] ?? 0) + 1
  stats.modes[entry.mode] += 1
  stats.effectiveDecision[entry.effectiveDecision] += 1
  const time = Date.parse(entry.at)
  if (stats.earliest === null || time < Date.parse(stats.earliest)) stats.earliest = entry.at
  if (stats.latest === null || time > Date.parse(stats.latest)) stats.latest = entry.at
}

function mergeTotals(target: StatsTotals, ticket: TicketStats): void {
  target.tickets += 1
  target.entries += ticket.entries
  target.matched += ticket.matched
  target.corruptLines += ticket.corruptLines
  for (const [rule, count] of Object.entries(ticket.rules)) target.rules[rule] = (target.rules[rule] ?? 0) + count
  for (const mode of DECISION_MODES) target.modes[mode] += ticket.modes[mode]
  for (const value of DECISION_VALUES) target.effectiveDecision[value] += ticket.effectiveDecision[value]
  if (ticket.earliest !== null && (target.earliest === null || Date.parse(ticket.earliest) < Date.parse(target.earliest))) {
    target.earliest = ticket.earliest
  }
  if (ticket.latest !== null && (target.latest === null || Date.parse(ticket.latest) > Date.parse(target.latest))) {
    target.latest = ticket.latest
  }
}

async function summarizeDecisionLog(
  stateDir: string, ticketId: string, rulePrefix: string | null, io: CliIo,
): Promise<{ stats: TicketStats; missing: boolean }> {
  const stats = emptyTicketStats(ticketId)
  let text: string
  try {
    text = await readFile(join(stateDir, 'hephi', ticketId, 'decisions.jsonl'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { stats, missing: true }
    throw error
  }
  const lines = text.split('\n')
  let warned = 0
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim()
    if (line.length === 0) continue
    stats.entries += 1
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      stats.corruptLines += 1
      warned += 1
      if (warned <= CORRUPT_WARNINGS_PER_TICKET) {
        io.err(`[stats] ${ticketId}: corrupt decisions.jsonl line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
      }
      continue
    }
    const result = decisionEntry(parsed)
    if ('reason' in result) {
      stats.corruptLines += 1
      warned += 1
      if (warned <= CORRUPT_WARNINGS_PER_TICKET) {
        io.err(`[stats] ${ticketId}: corrupt decisions.jsonl line ${index + 1}: ${result.reason}`)
      }
      continue
    }
    if (rulePrefix !== null && !result.entry.rule.startsWith(rulePrefix)) continue
    addEntry(stats, result.entry)
  }
  if (stats.corruptLines > CORRUPT_WARNINGS_PER_TICKET) {
    io.err(`[stats] ${ticketId}: ${stats.corruptLines} corrupt lines in total (showing first ${CORRUPT_WARNINGS_PER_TICKET})`)
  }
  return { stats, missing: false }
}

function sortRules(rules: Record<string, number>): Array<[string, number]> {
  return Object.entries(rules).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

function formatTicketStats(stats: TicketStats, rulePrefix: string | null): string {
  const lines = [
    `HEPHI stats — ticket ${stats.ticketId}`,
    `  entries=${stats.entries} matched=${stats.matched} corrupt=${stats.corruptLines}` +
      (rulePrefix === null ? '' : ` rulePrefix=${rulePrefix}`),
    `  mode: enforce=${stats.modes.enforce} shadow=${stats.modes.shadow}`,
    `  effectiveDecision: allow=${stats.effectiveDecision.allow} deny=${stats.effectiveDecision.deny}`,
    `  earliest=${stats.earliest ?? 'none'} latest=${stats.latest ?? 'none'}`,
    '  rules:',
    ...sortRules(stats.rules).map(([rule, count]) => `    ${rule.padEnd(32)} ${count}`),
  ]
  if (Object.keys(stats.rules).length === 0) lines.push('    (none)')
  return lines.join('\n')
}

function formatAllStats(tickets: TicketStats[], totals: StatsTotals, rulePrefix: string | null): string {
  const lines = [
    `HEPHI stats — tickets=${totals.tickets} entries=${totals.entries} matched=${totals.matched} corrupt=${totals.corruptLines} skipped=${totals.skippedTickets}` +
      (rulePrefix === null ? '' : ` rulePrefix=${rulePrefix}`),
    '',
    'ticket                          entries  matched  corrupt  earliest                  latest',
  ]
  for (const ticket of tickets) {
    lines.push(`${ticket.ticketId.padEnd(30)}  ${String(ticket.entries).padStart(7)}  ${String(ticket.matched).padStart(7)}  ${String(ticket.corruptLines).padStart(7)}  ${(ticket.earliest ?? 'none').padEnd(24)}  ${ticket.latest ?? 'none'}`)
  }
  if (tickets.length === 0) lines.push('(no decision logs)')
  lines.push('', `mode: enforce=${totals.modes.enforce} shadow=${totals.modes.shadow}`)
  lines.push(`effectiveDecision: allow=${totals.effectiveDecision.allow} deny=${totals.effectiveDecision.deny}`)
  lines.push(`earliest=${totals.earliest ?? 'none'} latest=${totals.latest ?? 'none'}`, 'rules:')
  const rules = sortRules(totals.rules)
  if (rules.length === 0) lines.push('  (none)')
  for (const [rule, count] of rules) lines.push(`  ${rule.padEnd(32)} ${count}`)
  return lines.join('\n')
}

function parseStatsArgs(args: string[]): { stateDir?: string; ticket?: string; rule?: string; json: boolean } {
  let stateDir: string | undefined
  let ticket: string | undefined
  let rule: string | undefined
  let json = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--json') { json = true; continue }
    if (arg === '--help' || arg === '-h') throw new UsageError('help')
    if (arg === '--state-dir' || arg === '--ticket' || arg === '--rule') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) throw new UsageError(`missing value for ${arg}`)
      index += 1
      if (arg === '--state-dir') { if (stateDir !== undefined) throw new UsageError('duplicate argument: --state-dir'); stateDir = value }
      else if (arg === '--ticket') { if (ticket !== undefined) throw new UsageError('duplicate argument: --ticket'); ticket = value }
      else { if (rule !== undefined) throw new UsageError('duplicate argument: --rule'); rule = value }
      continue
    }
    throw new UsageError(`unknown argument: ${arg}`)
  }
  if (ticket !== undefined && !SAFE_TICKET_ID.test(ticket)) throw new UsageError(`--ticket is not a safe identifier: ${ticket}`)
  if (rule !== undefined && rule.length === 0) throw new UsageError('--rule prefix must not be empty')
  return { stateDir, ticket, rule, json }
}

async function statsCommand(args: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  let options: ReturnType<typeof parseStatsArgs>
  try {
    options = parseStatsArgs(args)
  } catch (error) {
    if (error instanceof UsageError && error.message === 'help') { io.out(STATS_USAGE); return 0 }
    io.err(error instanceof Error ? error.message : String(error))
    io.err(STATS_USAGE)
    return 2
  }
  const stateDir = defaultStateDir(options.stateDir)
  const rulePrefix = options.rule ?? null
  const tickets: TicketStats[] = []
  let skippedTickets = 0
  try {
    if (options.ticket !== undefined) {
      const result = await summarizeDecisionLog(stateDir, options.ticket, rulePrefix, io)
      tickets.push(result.stats)
    } else {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await readdir(join(stateDir, 'hephi'), { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        entries = []
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (!SAFE_TICKET_ID.test(entry.name)) {
          skippedTickets += 1
          io.err(`[stats] skipped unsafe ticket directory name: ${JSON.stringify(entry.name)}`)
          continue
        }
        const result = await summarizeDecisionLog(stateDir, entry.name, rulePrefix, io)
        if (result.missing) continue
        tickets.push(result.stats)
      }
      tickets.sort((a, b) => a.ticketId.localeCompare(b.ticketId))
    }
  } catch (error) {
    io.err(`[stats] cannot read decision logs: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const totals = emptyStatsTotals()
  totals.skippedTickets = skippedTickets
  for (const ticket of tickets) mergeTotals(totals, ticket)

  if (options.json) {
    const payload = {
      schemaVersion: 1,
      filter: { rulePrefix },
      tickets,
      totals: {
        tickets: totals.tickets, entries: totals.entries, matched: totals.matched,
        corruptLines: totals.corruptLines, skippedTickets: totals.skippedTickets,
        modes: totals.modes, effectiveDecision: totals.effectiveDecision, rules: totals.rules,
        earliest: totals.earliest, latest: totals.latest,
      },
    }
    io.out(JSON.stringify(payload, null, 2))
    return 0
  }
  io.out(options.ticket === undefined ? formatAllStats(tickets, totals, rulePrefix) : formatTicketStats(tickets[0]!, rulePrefix))
  return 0
}

// ---- summary：只读汇总 Ticket 状态，不写 state 目录、不改变 ready ---------------

const SUMMARY_USAGE = `usage: hephi summary --ticket <id> [--state-dir <dir>] [--coverage-hint <file>] [--json] [--out <file>]

Reads (never writes) the Ticket state: activation.json, the latest check run for the frozen
contract, plan.jsonl, decisions.jsonl and an optional coverage hint (examples/coverage-node
format). The summary is evidence for a human: it never changes ready and it never writes the
input state directory. --out writes the same JSON outside the state directory; an existing
path is overwritten only when it is not one of the state inputs (including through symlinks).

sections: header (ticket/head/contractHash/time/read-only), acceptance groups (acceptance
paths → changedFiles), unassigned files, plan files/entries/match, coverage uncovered lines
(a risk hint, NOT a pass/fail decision), decisions (last ready rule and allow/deny counts).
exit: 0 = summary produced (also with only warnings); 1 = corrupt state; 2 = usage error.`

const SUMMARY_READ_ONLY = 'read-only: this command did not create or modify the state directory and it does not change ready'

type SummaryAcceptance = {
  id: string
  text: string
  check: string
  paths: string[]
  changedFiles: string[]
}

type SummaryCoverageUncovered = { path: string; lines: number[]; reason?: string }
type SummaryCoverage = {
  source: string | null
  uncovered: SummaryCoverageUncovered[]
  summary: Record<string, number> | null
}
type SummaryDecisions = {
  entries: number
  allow: number
  deny: number
  lastRule: string | null
  lastAt: string | null
}
type SummaryPlan = { files: string[]; entries: number; match: boolean | null }
type SummaryPayload = {
  schemaVersion: 1
  ticketId: string
  head: string | null
  contractHash: string
  acceptance: SummaryAcceptance[]
  unassigned: string[]
  plan: SummaryPlan
  coverage: SummaryCoverage
  decisions: SummaryDecisions
  generatedAt: string
}

function parseSummaryArgs(args: string[]): {
  ticket?: string; stateDir?: string; coverageHint?: string; json: boolean; out?: string
} {
  let ticket: string | undefined
  let stateDir: string | undefined
  let coverageHint: string | undefined
  let out: string | undefined
  let json = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--json') { json = true; continue }
    if (arg === '--help' || arg === '-h') throw new UsageError('help')
    if (arg === '--ticket' || arg === '--state-dir' || arg === '--coverage-hint' || arg === '--out') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) throw new UsageError(`missing value for ${arg}`)
      index += 1
      if (arg === '--ticket') { if (ticket !== undefined) throw new UsageError('duplicate argument: --ticket'); ticket = value }
      else if (arg === '--state-dir') { if (stateDir !== undefined) throw new UsageError('duplicate argument: --state-dir'); stateDir = value }
      else if (arg === '--coverage-hint') { if (coverageHint !== undefined) throw new UsageError('duplicate argument: --coverage-hint'); coverageHint = value }
      else { if (out !== undefined) throw new UsageError('duplicate argument: --out'); out = value }
      continue
    }
    throw new UsageError(`unknown argument: ${arg}`)
  }
  if (ticket === undefined) throw new UsageError('--ticket is required')
  if (!SAFE_TICKET_ID.test(ticket)) throw new UsageError(`--ticket is not a safe identifier: ${ticket}`)
  return { ticket, stateDir, coverageHint, json, out }
}

/** Total, stable ordering for the latest current-contract check. */
function compareRuns(a: CheckRunRecord, b: CheckRunRecord): number {
  return a.sequence - b.sequence
    || a.startedAt.localeCompare(b.startedAt)
    || a.runId.localeCompare(b.runId)
    || a.checkId.localeCompare(b.checkId)
}

/** The latest current-contract check supplies head and changedFiles; none means no evidence. */
function summaryEvidence(runs: CheckRunRecord[], contractHash: string, io: CliIo): { head: string | null; changedFiles: string[] } {
  const current = runs.filter(record => record.contractHash === contractHash)
  if (current.length === 0) {
    io.err('[summary] no check records for the current contract; head and changedFiles are unavailable')
    return { head: null, changedFiles: [] }
  }
  const latest = [...current].sort(compareRuns)[current.length - 1]!
  const fingerprint = latest.after ?? latest.before
  return {
    head: fingerprint?.headCommit ?? null,
    changedFiles: [...(fingerprint?.changedFiles ?? [])].sort(),
  }
}

async function summaryPlan(stateDir: string, ticketId: string, contractHash: string, changedFiles: string[]): Promise<SummaryPlan> {
  const entries = (await readPlanEntries(stateDir, ticketId)).filter(entry => entry.contractHash === contractHash)
  const files = [...new Set(entries.flatMap(entry => entry.files.map(file => file.trim())))].sort()
  if (entries.length === 0) return { files, entries: 0, match: null }
  return { files, entries: entries.length, match: changedFiles.every(file => allowedPath(file, files)) }
}

/**
 * Decision summary. A malformed line is corrupt state (exit 1) instead of a silently
 * smaller count: the summary must not pretend the log is complete.
 */
async function summaryDecisions(stateDir: string, ticketId: string): Promise<SummaryDecisions> {
  const file = join(stateDir, 'hephi', ticketId, 'decisions.jsonl')
  let text: string
  try { text = await readFile(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: 0, allow: 0, deny: 0, lastRule: null, lastAt: null }
    throw error
  }
  const result: SummaryDecisions = { entries: 0, allow: 0, deny: 0, lastRule: null, lastAt: null }
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim()
    if (line.length === 0) continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch {
      throw new Error(`corrupt decisions.jsonl line ${index + 1}: invalid JSON (${file})`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`corrupt decisions.jsonl line ${index + 1}: not a JSON object (${file})`)
    }
    const record = parsed as Record<string, unknown>
    if (typeof record.rule !== 'string' || record.rule.trim().length === 0
      || typeof record.at !== 'string' || Number.isNaN(Date.parse(record.at))
      || (record.effectiveDecision !== 'allow' && record.effectiveDecision !== 'deny')) {
      throw new Error(`corrupt decisions.jsonl line ${index + 1}: missing rule/at/effectiveDecision (${file})`)
    }
    result.entries += 1
    if (record.effectiveDecision === 'allow') result.allow += 1
    else result.deny += 1
    if (record.rule.startsWith('ready.')) {
      result.lastRule = record.rule
      result.lastAt = record.at
    }
  }
  return result
}

function coverageHintProblem(parsed: unknown): string | undefined {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'top-level value must be a JSON object'
  const uncovered = (parsed as { uncovered?: unknown }).uncovered
  if (!Array.isArray(uncovered)) return 'uncovered must be an array'
  for (const [index, item] of uncovered.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return `uncovered[${index}] must be an object`
    const entry = item as Record<string, unknown>
    if (typeof entry.path !== 'string' || entry.path.trim().length === 0) return `uncovered[${index}].path must be a non-empty string`
    if (!Array.isArray(entry.lines) || entry.lines.length === 0
      || !entry.lines.every(line => Number.isSafeInteger(line) && (line as number) > 0)) {
      return `uncovered[${index}].lines must be a non-empty array of positive integers`
    }
    if (entry.reason !== undefined && typeof entry.reason !== 'string') return `uncovered[${index}].reason must be a string`
  }
  const summary = (parsed as { summary?: unknown }).summary
  if (summary !== undefined) {
    if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) return 'summary must be an object'
    for (const [key, value] of Object.entries(summary as Record<string, unknown>)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `summary.${key} must be a number`
    }
  }
  return undefined
}

/** Optional coverage hint: invalid input is only a warning; coverage never decides ready. */
async function summaryCoverage(hintFile: string | undefined, io: CliIo): Promise<SummaryCoverage> {
  const empty: SummaryCoverage = { source: hintFile ?? null, uncovered: [], summary: null }
  if (hintFile === undefined) return empty
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(hintFile, 'utf8'))
  } catch (error) {
    io.err(`[summary] coverage hint ignored (${hintFile}): ${error instanceof Error ? error.message : String(error)}`)
    return empty
  }
  const problem = coverageHintProblem(parsed)
  if (problem) {
    io.err(`[summary] coverage hint ignored (${hintFile}): ${problem}`)
    return empty
  }
  const record = parsed as { uncovered: SummaryCoverageUncovered[]; summary?: Record<string, number> }
  return {
    source: hintFile,
    uncovered: record.uncovered.map(item => ({
      path: item.path,
      lines: [...item.lines],
      ...(item.reason === undefined ? {} : { reason: item.reason }),
    })),
    summary: record.summary ?? null,
  }
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function realOrResolve(path: string): string {
  try { return realpathSync(path) } catch { return resolve(path) }
}

/**
 * --out must stay outside the input state directory and must not overwrite one of the
 * inputs, including when it (or its parent) is a symlink into the state directory.
 */
function summaryOutProblem(out: string, stateDir: string, protectedInputs: string[]): string | undefined {
  const stateReal = realOrResolve(stateDir)
  const outAbs = resolve(out)
  const parentReal = realOrResolve(dirname(outAbs))
  const candidate = join(parentReal, basename(outAbs))
  const target = existsSync(outAbs) ? realOrResolve(outAbs) : candidate
  if (isWithin(stateReal, outAbs) || isWithin(stateReal, candidate) || isWithin(stateReal, target)) {
    return `--out must point outside the input state directory (${stateDir})`
  }
  for (const input of protectedInputs) {
    const inputReal = realOrResolve(input)
    if (candidate === inputReal || target === inputReal) return `--out must not overwrite the state input ${input}`
  }
  return undefined
}

function formatSummary(payload: SummaryPayload): string {
  const lines: string[] = [
    `HEPHI summary — ticket ${payload.ticketId}`,
    `  head=${payload.head ?? 'unavailable'} contractHash=${payload.contractHash} generatedAt=${payload.generatedAt}`,
    '  ' + SUMMARY_READ_ONLY,
    '',
    'acceptance:',
  ]
  if (payload.acceptance.length === 0) lines.push('  (no acceptance items in the task card)')
  for (const item of payload.acceptance) {
    lines.push(`  ${item.id} (${item.check}) paths=${item.paths.join(', ')} changed=${item.changedFiles.length}`)
    for (const file of item.changedFiles) lines.push(`    ${file}`)
  }
  lines.push('', 'unassigned:')
  if (payload.unassigned.length === 0) lines.push('  (none)')
  for (const file of payload.unassigned) lines.push(`  ${file}`)
  lines.push('', 'plan:')
  if (payload.plan.entries === 0) {
    lines.push('  entries=0 match=null (no plan for the current contract)')
  } else {
    lines.push(`  entries=${payload.plan.entries} match=${String(payload.plan.match)}`)
    for (const file of payload.plan.files) lines.push(`    ${file}`)
  }
  lines.push('', 'coverage (risk hint only; this is NOT a pass/fail decision):')
  if (payload.coverage.source === null) {
    lines.push('  source=(none)')
  } else {
    lines.push(`  source=${payload.coverage.source}`)
    for (const item of payload.coverage.uncovered) {
      lines.push(`  ${item.path}: lines ${item.lines.join(', ')}${item.reason === undefined ? '' : ` — ${item.reason}`}`)
    }
    if (payload.coverage.summary !== null) {
      lines.push(`  summary: ${Object.entries(payload.coverage.summary).map(([key, value]) => `${key}=${value}`).join(' ')}`)
    }
    if (payload.coverage.uncovered.length === 0) lines.push('  (no uncovered-change hints; this does not mean the change is verified)')
  }
  lines.push('', 'decisions:')
  lines.push(`  entries=${payload.decisions.entries} allow=${payload.decisions.allow} deny=${payload.decisions.deny}`)
  lines.push(`  lastReadyRule=${payload.decisions.lastRule ?? '(none)'} lastReadyAt=${payload.decisions.lastAt ?? '(none)'}`)
  lines.push('', `This summary is ${SUMMARY_READ_ONLY}.`)
  return lines.join('\n')
}

async function summaryCommand(args: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  let options: ReturnType<typeof parseSummaryArgs>
  try {
    options = parseSummaryArgs(args)
  } catch (error) {
    if (error instanceof UsageError && error.message === 'help') { io.out(SUMMARY_USAGE); return 0 }
    io.err(error instanceof Error ? error.message : String(error))
    io.err(SUMMARY_USAGE)
    return 2
  }
  const ticketId = options.ticket!
  const stateDir = defaultStateDir(options.stateDir)
  let payload: SummaryPayload
  try {
    const contract = await loadActivation(activationPath(stateDir, ticketId))
    const runs = await readRuns(stateDir, ticketId)
    const evidence = summaryEvidence(runs, contract.contractHash, io)
    const acceptance: SummaryAcceptance[] = (contract.task?.acceptance ?? []).map(item => ({
      id: item.id,
      text: item.text,
      check: item.check,
      paths: [...item.paths],
      changedFiles: evidence.changedFiles.filter(file => allowedPath(file, item.paths)),
    }))
    const assigned = new Set(acceptance.flatMap(item => item.changedFiles))
    payload = {
      schemaVersion: 1,
      ticketId,
      head: evidence.head,
      contractHash: contract.contractHash,
      acceptance,
      unassigned: evidence.changedFiles.filter(file => !assigned.has(file)),
      plan: await summaryPlan(stateDir, ticketId, contract.contractHash, evidence.changedFiles),
      coverage: await summaryCoverage(options.coverageHint, io),
      decisions: await summaryDecisions(stateDir, ticketId),
      generatedAt: new Date().toISOString(),
    }
  } catch (error) {
    io.err(`[summary] cannot read the Ticket state: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const json = JSON.stringify(payload, null, 2)
  if (options.out !== undefined) {
    const outProblem = summaryOutProblem(options.out, stateDir, [
      activationPath(stateDir, ticketId),
      join(stateDir, 'hephi', ticketId, 'plan.jsonl'),
      join(stateDir, 'hephi', ticketId, 'decisions.jsonl'),
      ...(options.coverageHint === undefined ? [] : [options.coverageHint]),
    ])
    if (outProblem) { io.err(`[summary] ${outProblem}`); return 2 }
    try {
      await writeFile(options.out, `${json}\n`)
    } catch (error) {
      io.err(`[summary] cannot write --out: ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }
  if (options.json) { io.out(json); return 0 }
  io.out(formatSummary(payload))
  return 0
}

// ---- lint-task (C5)：离线校验任务卡 bundle，不依赖网络/git ------------------

const LINT_TASK_USAGE = `usage: hephi lint-task <task.json> [--json]

输入是任务 bundle（JSON）：task（hephi-task 任务卡）、ticketId、allowedPaths、
checks（或 verification.checks）。也可以把任务卡字段平铺在顶层，与 ticketId/allowedPaths/checks 并列。`

const TASK_CARD_KEYS = ['version', 'kind', 'goal', 'outOfScope', 'acceptance', 'budget', 'protect', 'protectedAssets'] as const
const LINT_BUNDLE_KEYS = new Set([
  ...TASK_CARD_KEYS, 'task', 'ticketId', 'allowedPaths', 'checks', 'verification',
])

function formatZodIssues(error: unknown): string[] {
  if (error !== null && typeof error === 'object' && Array.isArray((error as { issues?: unknown }).issues)) {
    const issues = (error as { issues: Array<{ path?: Array<string | number | symbol>; message?: string }> }).issues
    return issues.map(issue => `${(issue.path ?? []).map(String).join('.') || '<root>'}: ${issue.message ?? 'invalid'}`)
  }
  return [error instanceof Error ? error.message : String(error)]
}

function safeRelativeGlob(value: string): boolean {
  if (value.length === 0 || value.includes('\0')) return false
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return false
  if (value.split(/[\\/]+/).includes('..')) return false
  const normal = normalize(value)
  return normal !== '..' && !normal.startsWith(`..${sep}`) && !normal.startsWith('../')
}

function parseLintArgs(args: string[]): { file: string; json: boolean } {
  let file: string | undefined
  let json = false
  for (const arg of args) {
    if (arg === '--json') { json = true; continue }
    if (arg === '--help' || arg === '-h') throw new UsageError('help')
    if (arg.startsWith('-')) throw new UsageError(`unknown argument: ${arg}`)
    if (file !== undefined) throw new UsageError(`unexpected argument: ${arg}`)
    file = arg
  }
  if (file === undefined) throw new UsageError('missing <task.json>')
  return { file, json }
}

async function lintTaskCommand(args: string[], io: CliIo): Promise<number> {
  let options: ReturnType<typeof parseLintArgs>
  try {
    options = parseLintArgs(args)
  } catch (error) {
    if (error instanceof UsageError && error.message === 'help') { io.out(LINT_TASK_USAGE); return 0 }
    io.err(error instanceof Error ? error.message : String(error))
    io.err(LINT_TASK_USAGE)
    return 2
  }
  const errors: string[] = []
  const warnings: string[] = []
  let raw: string
  try {
    raw = await readFile(options.file, 'utf8')
  } catch (error) {
    io.err(`HEPHI task lint: FAIL ${options.file}`)
    io.err(`  - cannot read file: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    io.err(`HEPHI task lint: FAIL ${options.file}`)
    io.err(`  - not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    io.err(`HEPHI task lint: FAIL ${options.file}`)
    io.err('  - top-level value must be a JSON object')
    return 1
  }
  const record = parsed as Record<string, unknown>
  const bundleChecks = record.checks ?? (record.verification !== null && typeof record.verification === 'object'
    ? (record.verification as Record<string, unknown>).checks
    : undefined)

  let taskInput: unknown
  if (record.task !== undefined) {
    if (record.task === null || typeof record.task !== 'object' || Array.isArray(record.task)) {
      errors.push('task must be an object')
    } else {
      taskInput = record.task
    }
  } else {
    taskInput = Object.fromEntries(TASK_CARD_KEYS.filter(key => key in record).map(key => [key, record[key]]))
  }
  for (const key of Object.keys(record)) {
    if (!LINT_BUNDLE_KEYS.has(key)) warnings.push(`unknown top-level field ignored: ${key}`)
  }

  let card: { acceptance: Array<{ id: string; check: string; paths: string[]; tests?: string[] }> } | null = null
  const cardResult = taskCardSchema.safeParse(taskInput)
  if (!cardResult.success) errors.push(...formatZodIssues(cardResult.error))
  else card = cardResult.data

  let verification: ReturnType<typeof parseVerificationConfig> | null = null
  if (!Array.isArray(bundleChecks) || bundleChecks.length === 0) {
    errors.push('checks must be a non-empty array (or verification.checks); acceptance items reference these checks')
  } else {
    try {
      verification = parseVerificationConfig({ version: 1, checks: bundleChecks })
    } catch (error) {
      errors.push(...formatZodIssues(error))
    }
  }

  const ticketId = record.ticketId
  if (typeof ticketId !== 'string' || !SAFE_TICKET_ID.test(ticketId)) {
    errors.push('ticketId must be a non-empty safe identifier ([A-Za-z0-9._-])')
  }
  const allowedPaths = record.allowedPaths
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) {
    errors.push('allowedPaths must be a non-empty array of workspace-relative globs')
  } else {
    for (const [index, path] of allowedPaths.entries()) {
      if (typeof path !== 'string' || !safeRelativeGlob(path)) {
        errors.push(`allowedPaths[${index}] must be a workspace-relative glob without absolute or escaping paths: ${String(path)}`)
      }
    }
    if (allowedPaths.length > 50) warnings.push(`allowedPaths has ${allowedPaths.length} entries (>50): scope may be too wide`)
  }

  if (card !== null && verification !== null) {
    const byId = new Map(verification.checks.map(check => [check.id, check]))
    for (const item of card.acceptance) {
      const check = byId.get(item.check)
      if (check === undefined) {
        errors.push(`acceptance ${item.id} references unknown check: ${item.check}`)
      } else if (check.kind !== 'test') {
        errors.push(`acceptance ${item.id} must reference a test check, not ${check.kind} check ${check.id}`)
      }
    }
    if (card.acceptance.length > 8) warnings.push(`task card has ${card.acceptance.length} acceptance items (>8): consider splitting the Issue`)
  }

  // C4.8 聚焦提示：只提示、不失败，不改变 exit 语义。
  const focus: Array<{ rule: string; message: string }> = []
  const acceptedChecks = new Set<string>()
  const acceptanceRefCounts = new Map<string, number>()
  if (card !== null && verification !== null) {
    const byId = new Map(verification.checks.map(check => [check.id, check]))
    const required = verification.checks.filter(check => check.required)
    if (required.length > 5) {
      focus.push({ rule: 'focus.required-too-many', message: `${required.length} required checks (>5); consider marking only the essential checks required` })
    }
    const notRequired = new Set<string>()
    for (const item of card.acceptance) {
      acceptedChecks.add(item.check)
      acceptanceRefCounts.set(item.check, (acceptanceRefCounts.get(item.check) ?? 0) + 1)
      const check = byId.get(item.check)
      if (check !== undefined && !check.required) notRequired.add(check.id)
    }
    if (notRequired.size > 0) {
      focus.push({ rule: 'focus.check-not-required', message: `acceptance references non-required checks: ${[...notRequired].sort().join(', ')}; mark them required or expect ready to verify them anyway` })
    }
    const shared = [...acceptanceRefCounts.entries()].filter(([, count]) => count > 5).sort((a, b) => a[0].localeCompare(b[0]))
    for (const [checkId, count] of shared) {
      focus.push({ rule: 'focus.acceptance-check-not-test', message: `check ${checkId} is shared by ${count} acceptance items (>5); add focused checks or split acceptance` })
    }
    const regressionPattern = /(full|regression|all[-_ ]?tests?|whole|suite|全套|回归)/i
    const regressionChecks = required.filter(check => check.kind === 'test' && regressionPattern.test(
      [check.id, check.purpose, check.command, ...check.args].join(' '),
    ))
    if (regressionChecks.length === 0) {
      focus.push({ rule: 'focus.no-regression', message: 'no required test check looks like the full regression suite (heuristic on id/purpose/command); confirm the whole suite is run once before ready' })
    }
    const unused = verification.checks.filter(check => !check.required && !acceptedChecks.has(check.id)).map(check => check.id).sort()
    if (unused.length > 0) {
      focus.push({ rule: 'focus.unused-check', message: `checks neither required nor referenced by acceptance: ${unused.join(', ')}` })
    }
    for (const item of card.acceptance) {
      const outside = (item.tests ?? []).filter(test => !allowedPath(test, item.paths))
      if (outside.length > 0) {
        focus.push({ rule: 'focus.tests-outside-paths', message: `acceptance ${item.id} names tests outside its own paths: ${outside.join(', ')}; add them to paths only if the task requires creating or updating them; existing tests that already fail on the baseline can remain read-only acceptance evidence` })
      }
    }
  }
  if (Array.isArray(allowedPaths)) {
    const broad = allowedPaths.filter(path => typeof path === 'string'
      && (path === '**' || path === '*' || path === '**/*' || path.startsWith('**/')))
    if (broad.length > 0 || allowedPaths.length > 50) {
      const parts = []
      if (broad.length > 0) parts.push(`broad globs: ${broad.slice(0, 5).join(', ')}`)
      if (allowedPaths.length > 50) parts.push(`${allowedPaths.length} entries (>50)`)
      focus.push({ rule: 'focus.broad-scope', message: `allowedPaths may be too wide (${parts.join('; ')}); narrow it where possible` })
    }
  }

  const summary = {
    acceptance: card?.acceptance.length ?? 0,
    checks: verification?.checks.length ?? 0,
    allowedPaths: Array.isArray(allowedPaths) ? allowedPaths.length : 0,
  }
  if (options.json) {
    io.out(JSON.stringify({
      schemaVersion: 1, ok: errors.length === 0, file: options.file,
      errors, warnings, focus, summary,
    }, null, 2))
    return errors.length === 0 ? 0 : 1
  }
  if (errors.length > 0) {
    io.err(`HEPHI task lint: FAIL ${options.file}`)
    for (const error of errors) io.err(`  - ${error}`)
    for (const warning of warnings) io.err(`  WARN: ${warning}`)
    return 1
  }
  io.out(`HEPHI task lint: PASS ${options.file} (acceptance=${summary.acceptance} checks=${summary.checks} allowedPaths=${summary.allowedPaths})`)
  for (const item of focus) io.out(`focus: ${item.rule} ${item.message}`)
  for (const warning of warnings) io.err(`HEPHI task lint: WARN ${warning}`)
  return 0
}

/** CLI entry point. Returns the process exit code instead of calling process.exit, so tests can drive it. */
export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  io: CliIo = consoleIo,
): Promise<number> {
  const command = argv[0]
  if (command === 'stats') return statsCommand(argv.slice(1), env, io)
  if (command === 'summary') return summaryCommand(argv.slice(1), env, io)
  if (command === 'lint-task') return lintTaskCommand(argv.slice(1), io)
  if (command === 'prepare') {
    try {
      const result = await prepareActivation(env)
      if (result.enabled) io.out(`HEPHI activation written to ${result.filePath}`)
      return 0
    } catch (error) {
      io.err(error instanceof Error ? error.message : String(error))
      return 1
    }
  }
  if (command === 'resolve') return resolveCommand(argv.slice(1), env, io)
  io.err(USAGE)
  return 2
}

function invokedAsCli(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try { return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (invokedAsCli()) process.exitCode = await main()
