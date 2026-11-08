import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseVerificationConfig, type VerificationConfig } from '../contracts/checks.js'
import { parseIssueTask, parseTaskCard, type TaskCard } from '../contracts/task.js'
import { authorizationProblem } from './discipline.js'
import { pluginCommit, pluginVersion } from '../version.js'

export type ExecutionMode = 'native' | 'staged'

/** shadow only observes: decisions are recorded but never enforced. */
export type EnforcementMode = 'enforce' | 'shadow'

/**
 * Session-binding policy frozen into the contract (format version 3+).
 * Contracts written before A1-K5 (v1/v2) never carry it; for those the host configuration decides.
 */
export type EvidencePolicy = { requireSessionBinding: boolean }

/** The format this plugin writes. Older formats are read-only compatible; unknown versions are rejected. */
export const ACTIVATION_VERSION = 5

/** Evidence policy field exists from this contract version (A1-K5). */
export const EVIDENCE_POLICY_SINCE = 3

/** C3 approvers are frozen in the contract from this format version. */
export const APPROVERS_SINCE = 5

/** Contract formats written before canonical hashing. Their stored hash uses the raw JSON key order. */
export const LEGACY_ACTIVATION_VERSION = 1

export type ActivationContract = {
  /** Format version. Absent only in contracts written before versioning (legacy). */
  version?: number
  enabled: true
  ticketId: string
  repository: string
  issueNumber: number
  workspace: string
  baseRef: string
  baseSha: string
  allowedPaths: string[]
  requirePullRequest: boolean
  /** Absent only in contracts written before execution modes. It then means native. */
  executionMode?: ExecutionMode
  /** Absent only in contracts written before shadow mode. It then means enforce. */
  enforcement?: EnforcementMode
  /** Frozen checks are required for every activation. */
  verification: VerificationConfig
  /** Plugin build that froze this contract. Absent only in contracts written before P2. */
  plugin?: { version: string; commit: string }
  /** Issue-scoped task card. Absent only in contracts written before task cards. */
  task?: TaskCard
  /** Session-binding policy. Absent in contracts written before A1-K5 (v1/v2); host configuration then decides. */
  evidence?: EvidencePolicy
  contractHash: string
}

/** The hash payload of a contract exactly as it was written. Old contracts lack executionMode. */
type ContractHashInput = Omit<ActivationContract, 'contractHash' | 'executionMode'> & { executionMode?: unknown }

export type ActivationResult =
  | { enabled: false; reason: 'not-requested' }
  /**
   * T11: `reused` is true when prepare replayed an existing frozen contract for this ticket
   * instead of creating one. A contract is written once per ticket and never overwritten:
   * re-prepare keeps the same file, contractHash and mtime, so previous plan/check evidence
   * still binds to it.
   */
  | { enabled: true; filePath: string; contract: ActivationContract; reused?: boolean }

/** Writes the activation intent marker, tolerating an existing one. */
async function writeActivationIntent(intentPath: string, ticketId: string): Promise<void> {
  await mkdir(dirname(intentPath), { recursive: true })
  try {
    await writeFile(intentPath, `${ticketId}\n`, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * T11 replay branch: load and validate the frozen contract, require it to belong to this exact
 * ticket, restore a missing intent marker (an interrupted earlier prepare), and return it as
 * reused. Never writes the contract: a corrupt or mismatched contract throws instead.
 */
async function reuseActivation(filePath: string, ticketId: string, intentPath: string): Promise<ActivationResult> {
  const contract = await loadActivation(filePath)
  if (contract.ticketId !== ticketId) {
    throw new Error(`HEPHI activation contract ${filePath} belongs to ticket ${contract.ticketId}; refusing to overwrite it for ${ticketId}`)
  }
  await writeActivationIntent(intentPath, ticketId)
  return { enabled: true, filePath, contract, reused: true }
}


// ---- C4.6 prepare-time offline environment enforcement ----------------------
// The plugin side only enforces offline/locked check environments when the project
// config declares `verification.environment.offline = true`; an undeclared or false
// environment keeps the previous behavior (no interception). This runs at prepare
// because the frozen check commands are what the Worker will execute later.

/**
 * Networked install/command patterns that cannot be pinned offline (mirrors eval/check-task.mjs).
 *
 * Review N2/N4 hardening: the scan is static and command-position based. It splits
 * shell -c payloads at `; && || |` and newlines outside quotes, strips env/sudo/nohup
 * prefixes, and only flags the command being run (never a filename or a grep pattern).
 * It is NOT a network sandbox and never executes the command: a shell alias, Makefile
 * target or runtime downloader can still reach the network.
 */
const MAX_SHELL_SCAN_DEPTH = 8

/** Split a shell payload at unquoted `; && || | &` and newlines, preserving token boundaries. */
function shellSegments(line: string): string[][] {
  const segments: string[][] = []
  let tokens: string[] = []
  let token = ''
  let quoting: "'" | '"' | null = null
  let hasToken = false
  const pushToken = (): void => { if (hasToken) { tokens.push(token); token = ''; hasToken = false } }
  const pushSegment = (): void => { pushToken(); if (tokens.length > 0) { segments.push(tokens); tokens = [] } }
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!
    if (quoting === "'") {
      if (char === "'") quoting = null
      else { token += char; hasToken = true }
      continue
    }
    if (quoting === '"') {
      if (char === '\\' && index + 1 < line.length && '"\\$`'.includes(line[index + 1]!)) {
        token += line[index + 1]; hasToken = true; index += 1
      } else if (char === '"') quoting = null
      else { token += char; hasToken = true }
      continue
    }
    if (char === '\\' && index + 1 < line.length) { token += line[index + 1]; hasToken = true; index += 1; continue }
    if (char === "'" || char === '"') { quoting = char; hasToken = true; continue }
    if (char === '\n' || char === ';') { pushSegment(); continue }
    if ((char === '&' || char === '|') && line[index + 1] === char) { pushSegment(); index += 1; continue }
    if (char === '|') { pushSegment(); continue }
    // A lone & backgrounds a command; keep redirections (2>&1, &>file) intact.
    if (char === '&' && line[index + 1] !== '>' && line[index - 1] !== '>') { pushSegment(); continue }
    if (/\s/.test(char)) { pushToken(); continue }
    token += char; hasToken = true
  }
  pushSegment()
  return segments
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const ENV_OPTIONS_WITH_VALUE = new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string'])
const SUDO_OPTIONS_WITH_VALUE = new Set([
  '-u', '-g', '-p', '-C', '-h', '-r', '-t', '-U',
  '--user', '--group', '--prompt', '--chdir', '--close-from', '--host', '--role', '--type', '--other-user',
])

function prefixOptionTakesValue(wrapper: 'env' | 'sudo', token: string): boolean {
  return (wrapper === 'env' ? ENV_OPTIONS_WITH_VALUE : SUDO_OPTIONS_WITH_VALUE).has(token)
}

/** Drop leading VAR=value assignments and env/sudo/nohup wrappers (including option values). */
function stripShellPrefixes(tokens: string[]): string[] {
  let index = 0
  while (index < tokens.length) {
    const name = basename(tokens[index]!)
    if (ENV_ASSIGNMENT.test(tokens[index]!)) { index += 1; continue }
    if (name === 'env') {
      index += 1
      while (index < tokens.length) {
        const value = tokens[index]!
        if (ENV_ASSIGNMENT.test(value)) { index += 1; continue }
        if (value === '-' || !value.startsWith('-')) break
        if (value.startsWith('--') && value.includes('=')) { index += 1; continue }
        // -u/--unset, -C/--chdir and -S/--split-string take a separate value argument.
        if (prefixOptionTakesValue('env', value) && tokens[index + 1] !== undefined) index += 1
        index += 1
      }
      continue
    }
    if (name === 'sudo') {
      index += 1
      while (index < tokens.length && tokens[index]!.startsWith('-')) {
        const value = tokens[index]!
        if (value.startsWith('--') && value.includes('=')) { index += 1; continue }
        if (prefixOptionTakesValue('sudo', value) && tokens[index + 1] !== undefined) index += 1
        index += 1
      }
      continue
    }
    if (name === 'nohup') {
      index += 1
      while (index < tokens.length && tokens[index]!.startsWith('-')) index += 1
      continue
    }
    break
  }
  return tokens.slice(index)
}

const hasFlag = (args: string[], ...flags: string[]): boolean =>
  args.some(arg => flags.some(flag => arg === flag || arg.startsWith(`${flag}=`)))

/** The -c payload of a shell wrapper, including combined short flags such as `-lc`. */
function shellCommandPayload(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '-c') return args[index + 1]
    if (/^-[A-Za-z]+$/.test(arg) && arg.slice(1).includes('c')) return args[index + 1]
    if (arg.startsWith('-c') && arg.length > 2) return arg.slice(2)
    if (arg === '--') break
    if (!arg.startsWith('-')) break
  }
  return undefined
}

type OfflineProblem = { problem: string; command: string }

/** Problem of one non-wrapper command in command position. */
function singleCommandProblem(command: string, args: string[]): string | undefined {
  switch (command) {
    case 'git': return args[0] === 'clone' ? 'git clone is a networked command' : undefined
    case 'curl': case 'wget': return 'curl/wget are networked commands'
    case 'npm': {
      const subcommand = args[0]
      if (subcommand === 'install' || subcommand === 'i' || subcommand === 'add') {
        if (hasFlag(args, '--offline')) return undefined
        return 'npm install without --offline'
      }
      if (subcommand === 'exec') return 'npm exec can download packages from the network'
      if (subcommand === 'create') return 'npm create can download packages from the network'
      return undefined
    }
    case 'pnpm': {
      const subcommand = args[0]
      if (subcommand === 'install' || subcommand === 'i' || subcommand === 'add') {
        if (hasFlag(args, '--offline')) return undefined
        return 'pnpm install without --offline'
      }
      if (subcommand === 'dlx') return 'pnpm dlx downloads packages from the network'
      if (subcommand === 'create') return 'pnpm create can download packages from the network'
      return undefined
    }
    case 'npx': return args.includes('--no-install') ? undefined : 'npx can download packages from the network'
    case 'yarn': {
      const subcommand = args[0]
      if (subcommand === 'install') {
        if (hasFlag(args, '--offline')) return undefined
        return 'yarn install without --offline'
      }
      if (subcommand === 'add') {
        if (hasFlag(args, '--offline')) return undefined
        return 'yarn add without --offline'
      }
      if (subcommand === 'dlx') return 'yarn dlx downloads packages from the network'
      if (subcommand === 'create') return 'yarn create can download packages from the network'
      return undefined
    }
    case 'bun': {
      const subcommand = args[0]
      if (subcommand === 'add' || subcommand === 'install') return 'bun add/install can download packages from the network'
      if (subcommand === 'x') return 'bun x can download packages from the network'
      return undefined
    }
    case 'bunx': return 'bunx can download packages from the network'
    case 'pip': case 'pip3': {
      const subcommand = args[0]
      if (subcommand === 'install') {
        if (hasFlag(args, '--no-index')) return undefined
        return 'pip install without --no-index'
      }
      if (subcommand === 'download') {
        if (hasFlag(args, '--no-index')) return undefined
        return 'pip download fetches packages from the network'
      }
      return undefined
    }
    case 'pipx': return args[0] === 'run' || args[0] === 'install' ? 'pipx run/install can download packages from the network' : undefined
    case 'poetry': return args[0] === 'add' || args[0] === 'install' ? 'poetry add/install can download packages from the network' : undefined
    case 'uv': return args[0] === 'add' || args[0] === 'pip' || args[0] === 'run' ? 'uv add/pip/run can download packages from the network' : undefined
    case 'uvx': return 'uvx can download packages from the network'
    case 'go': return args[0] === 'get' || args[0] === 'install' ? `go ${args[0]} fetches modules from the network` : undefined
    case 'cargo': return args[0] === 'install' ? 'cargo install can download crates from the network' : undefined
    case 'corepack': return args[0] === 'prepare' ? 'corepack prepare downloads package managers from the network' : undefined
    case 'mvn': case 'mvnw': return hasFlag(args, '-o', '--offline') ? undefined : 'mvn without -o/--offline'
    case 'gradle': case 'gradlew': return hasFlag(args, '--offline') ? undefined : 'gradle without --offline'
    default: return undefined
  }
}

/** Every problem in one already-split command; a shell wrapper recurses into its payload. */
function commandProblems(tokens: string[], depth: number): OfflineProblem[] {
  const command = basename(tokens[0]!)
  const args = tokens.slice(1)
  if (command === 'sh' || command === 'bash' || command === 'zsh') {
    const payload = shellCommandPayload(args)
    if (payload === undefined) return []
    if (depth >= MAX_SHELL_SCAN_DEPTH) {
      return [{ problem: `shell -c payload nesting exceeds the static scan depth (${MAX_SHELL_SCAN_DEPTH})`, command: payload }]
    }
    return shellLineProblems(payload, depth + 1)
  }
  const problem = singleCommandProblem(command, args)
  return problem === undefined ? [] : [{ problem, command: tokens.join(' ') }]
}

/** Every problem in one shell text line (used for a shell -c payload); duplicate hits stay listed. */
function shellLineProblems(line: string, depth: number): OfflineProblem[] {
  const problems: OfflineProblem[] = []
  for (const tokens of shellSegments(line)) {
    const stripped = stripShellPrefixes(tokens)
    if (stripped.length === 0) continue
    problems.push(...commandProblems(stripped, depth))
  }
  return problems
}

/**
 * A declared check is spawned as one quoted argv, so operators only take effect inside
 * a `sh -c` payload (or in the command token of a legacy config). Scan the command
 * position, then recurse into a shell wrapper's payload; every hit is returned.
 */
function offlineCommandProblems(command: string, args: string[]): OfflineProblem[] {
  const problems: OfflineProblem[] = []
  const stripped = stripShellPrefixes([command, ...args])
  if (stripped.length > 0) problems.push(...commandProblems(stripped, 0))
  if (/[;&|\n]/.test(command)) {
    for (const problem of shellLineProblems(command, 0)) {
      if (!problems.some(existing => existing.problem === problem.problem && existing.command === problem.command)) problems.push(problem)
    }
  }
  return problems
}

/**
 * Problems with a declared offline environment (empty when it is not declared/disabled).
 * The lockfile is checked in the prepare workspace (the checkout at the base commit);
 * its content/base consistency is checked by the task pipeline, not re-derived here.
 */
function offlineEnvironmentProblems(verification: VerificationConfig, workspace: string): string[] {
  const environment = verification.environment
  if (environment === undefined || environment.offline !== true) return []
  const problems: string[] = []
  if (environment.lockfile === undefined) {
    problems.push('environment.offline=true requires environment.lockfile')
  } else {
    const root = resolve(workspace)
    if (!existsSync(root)) problems.push(`workspace directory not found: ${workspace}`)
    else if (!existsSync(join(root, environment.lockfile))) problems.push(`lockfile not found in the workspace: ${environment.lockfile}`)
  }
  for (const check of verification.checks) {
    for (const { problem, command: offending } of offlineCommandProblems(check.command, check.args)) {
      problems.push(`check "${check.id}" runs a non-offline command (${problem}): ${offending}`)
    }
  }
  return problems
}

const DEFAULT_STATE_DIR = join(homedir(), '.dsh-superagent')

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim()
  if (!value) throw new Error(`${key} is required when HEPHI_ENABLED=1`)
  return value
}

function positiveInteger(value: string, key: string): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${key} must be a positive integer`)
  return number
}

function safeTicketId(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error('DSH_SUPERAGENT_TICKET contains unsafe path characters')
  return value
}

function list(value: string | undefined): string[] {
  if (!value?.trim()) throw new Error('HEPHI_ALLOWED_PATHS is required when HEPHI_ENABLED=1')
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string' && item.trim())) {
      return parsed.map(item => item.trim())
    }
  } catch {
    // Allow the simple comma-separated form for shell configuration.
  }
  const result = value.split(',').map(item => item.trim()).filter(Boolean)
  if (!result.length) throw new Error('HEPHI_ALLOWED_PATHS must contain at least one path')
  return result
}

function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback
  if (value === '1' || value.toLowerCase() === 'true') return true
  if (value === '0' || value.toLowerCase() === 'false') return false
  throw new Error(`invalid boolean value: ${value}`)
}

/** Environment default is native; an explicitly invalid value must never silently fall back. */
export function parseExecutionMode(value: string | undefined): ExecutionMode {
  const mode = value?.trim()
  if (!mode) return 'native'
  if (mode === 'native' || mode === 'staged') return mode
  throw new Error(`HEPHI_EXECUTION_MODE must be "native" or "staged", got "${value}"`)
}

/** Environment default is enforce; an explicitly invalid value must never silently fall back. */
export function parseEnforcement(value: string | undefined): EnforcementMode {
  const mode = value?.trim()
  if (!mode) return 'enforce'
  if (mode === 'enforce' || mode === 'shadow') return mode
  throw new Error(`HEPHI_ENFORCEMENT must be "enforce" or "shadow", got "${value}"`)
}

/** Validate a persisted mode only after the contract hash has been checked. */
function contractEnforcement(value: unknown): EnforcementMode {
  if (value === undefined) return 'enforce'
  if (value === 'enforce' || value === 'shadow') return value
  throw new Error(`HEPHI activation contract has invalid enforcement: ${String(value)}`)
}

/** Historical contracts without enforcement mean enforce. */
export function enforcementOf(contract: ActivationContract): EnforcementMode {
  return contractEnforcement(contract.enforcement)
}

/** Validate a persisted mode only after the contract hash has been checked. */
function contractExecutionMode(value: unknown): ExecutionMode {
  if (value === undefined) return 'native'
  if (value === 'native' || value === 'staged') return value
  throw new Error(`HEPHI activation contract has invalid executionMode: ${String(value)}`)
}

/** Historical contracts without a mode keep their original hash and mean native. */
export function executionModeOf(contract: ActivationContract): ExecutionMode {
  return contractExecutionMode(contract.executionMode)
}

/**
 * The Session-binding policy frozen into the contract. Only format version 3+ carries it;
 * for v1/v2 (and unversioned) contracts undefined means "host configuration decides".
 */
export function evidenceOf(contract: ActivationContract): EvidencePolicy | undefined {
  return typeof contract.version === 'number' && contract.version >= EVIDENCE_POLICY_SINCE ? contract.evidence : undefined
}

/**
 * The effective Session-binding requirement for one decision.
 * `effective = contract OR host`: host configuration can tighten the contract but never relax it,
 * and it is the only source for contracts written before version 3. `contract: null` records
 * that the contract format predates the field instead of pretending it said false.
 */
export type SessionBindingPolicy = { contract: boolean | null; host: boolean; effective: boolean }
export function sessionBindingPolicy(contract: ActivationContract, hostRequireSessionBinding: boolean): SessionBindingPolicy {
  const contractValue = evidenceOf(contract)?.requireSessionBinding
  const host = hostRequireSessionBinding === true
  return {
    contract: contractValue === undefined ? null : contractValue,
    host,
    effective: host || contractValue === true,
  }
}

/** Validate the one supported check contract. No legacy fallback. */
export function verificationOf(contract: ActivationContract): VerificationConfig {
  return parseVerificationConfig(contract.verification)
}

async function loadVerificationFromEnv(env: NodeJS.ProcessEnv): Promise<VerificationConfig> {
  const file = env.HEPHI_VERIFICATION_FILE?.trim()
  const inline = env.HEPHI_VERIFICATION_CHECKS?.trim()
  if (file && inline) throw new Error('Set only one of HEPHI_VERIFICATION_FILE and HEPHI_VERIFICATION_CHECKS')
  if (!file && !inline) {
    throw new Error('HEPHI_VERIFICATION_FILE or HEPHI_VERIFICATION_CHECKS is required when HEPHI_ENABLED=1; a new activation contract must freeze explicit project checks')
  }
  let raw: unknown
  try {
    raw = JSON.parse(file ? await readFile(file, 'utf8') : inline!)
  } catch (error) {
    throw new Error(`HEPHI verification configuration is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseVerificationConfig(raw)
}

const ISSUE_MODE = /\[\s*(native|staged)\s*\]/gi

/**
 * Issue mode is a host-owned marker, never a model guess. Exactly one distinct
 * [native]/[staged] marker is required; a conflicting explicit env mode rejects.
 */
export function parseIssueExecutionMode(title: string | undefined, explicit?: string): ExecutionMode {
  if (!title?.trim()) throw new Error('Issue title must contain an explicit [native] or [staged] execution mode marker')
  const modes = [...new Set([...title.matchAll(ISSUE_MODE)].map(match => match[1].toLowerCase()))] as ExecutionMode[]
  if (modes.length === 0) throw new Error('Issue title must contain an explicit [native] or [staged] execution mode marker')
  if (modes.length > 1) throw new Error('Issue title contains conflicting [native] and [staged] execution mode markers')
  const mode = modes[0]
  if (explicit !== undefined && explicit.trim()) {
    const explicitMode = parseExecutionMode(explicit)
    if (explicitMode !== mode) throw new Error(`HEPHI_EXECUTION_MODE (${explicitMode}) conflicts with the Issue marker (${mode})`)
  }
  return mode
}

/**
 * Recursively sort object keys (UTF-16 code unit order); arrays keep their order.
 * JSON semantics are preserved: undefined object values are dropped, undefined
 * array items become null, no Unicode normalization and no number formatting change.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => item === undefined ? null : canonicalize(item))
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const item = source[key]
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue
      out[key] = canonicalize(item)
    }
    return out
  }
  return value
}

/** Canonical payload for the current formats (version 2 and 3): sorted keys, arrays in order, no whitespace. */
export function canonicalPayload(contract: ContractHashInput): string {
  return JSON.stringify(canonicalize(contract))
}

/** Historical payload for version 1 / unversioned contracts: raw JSON.stringify key order, never rewritten. */
export function legacyPayload(contract: ContractHashInput): string {
  return JSON.stringify(contract)
}

/** Current contract hash (version 2/3, canonical serialization). */
export function contractHash(contract: ContractHashInput): string {
  return `sha256:${createHash('sha256').update(canonicalPayload(contract)).digest('hex')}`
}

/** Historical contract hash for version 1 / unversioned contracts. Read-only compatibility. */
export function legacyContractHash(contract: ContractHashInput): string {
  return `sha256:${createHash('sha256').update(legacyPayload(contract)).digest('hex')}`
}

export function activationPath(stateDir: string, ticketId: string): string {
  return join(stateDir, 'hephi', safeTicketId(ticketId), 'activation.json')
}

export function activationIntentPath(stateDir: string, ticketId: string): string {
  return join(stateDir, 'hephi', safeTicketId(ticketId), 'activation.intent')
}

function taskOf(env: NodeJS.ProcessEnv, verification: VerificationConfig): TaskCard | undefined {
  const body = env.HEPHI_ISSUE_BODY
  const card = body === undefined ? undefined : parseIssueTask(body)
  if (!card) {
    if (boolean(env.HEPHI_REQUIRE_TASK, false)) throw new Error('Issue body must contain a hephi-task block when HEPHI_REQUIRE_TASK=1')
    return undefined
  }
  for (const item of card.acceptance) {
    const check = verification.checks.find(c => c.id === item.check)
    if (!check) throw new Error(`acceptance ${item.id} refers to unknown check ${item.check}`)
    if (check.kind !== 'test') throw new Error(`acceptance ${item.id} must name a behaviour test check, not ${check.kind} check ${check.id}`)
  }
  return card
}

/**
 * An intent is deliberately a marker, not a second contract. Unknown access
 * errors count as present so an activated task cannot silently become normal.
 */
export function activationIntentPresentSync(filePath: string): boolean {
  try {
    statSync(filePath)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/** Create the marker for older activations that predate activation.intent. */
export function migrateActivationIntentSync(stateDir: string, ticketId: string): void {
  const intentPath = activationIntentPath(stateDir, ticketId)
  if (activationIntentPresentSync(intentPath)) return
  if (!activationIntentPresentSync(activationPath(stateDir, ticketId))) return
  mkdirSync(dirname(intentPath), { recursive: true })
  try {
    writeFileSync(intentPath, `${ticketId}\n`, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

export function defaultStateDir(configured?: string): string {
  return configured?.trim() || process.env.HEPHI_STATE_DIR?.trim() || DEFAULT_STATE_DIR
}

export async function prepareActivation(env: NodeJS.ProcessEnv = process.env): Promise<ActivationResult> {
  if (env.HEPHI_ENABLED !== '1') return { enabled: false, reason: 'not-requested' }

  const ticketId = safeTicketId(required(env, 'DSH_SUPERAGENT_TICKET'))
  const stateDir = env.HEPHI_STATE_DIR?.trim() || DEFAULT_STATE_DIR
  const intentPath = activationIntentPath(stateDir, ticketId)
  const filePath = activationPath(stateDir, ticketId)
  // T11: replay, do not overwrite. After an interrupted prepare (or a retried hook), the
  // frozen contract is revalidated and reused; it is never rewritten. Only a ticket without
  // a contract goes on to freeze one below.
  if (await activationExists(filePath)) return reuseActivation(filePath, ticketId, intentPath)
  await writeActivationIntent(intentPath, ticketId)
  // Reject an invalid mode before writing a partial contract (the intent marker above is
  // already enough to tell an attempted activation from a normal task).
  const enforcement = parseEnforcement(env.HEPHI_ENFORCEMENT)
  // A1-K5: the binding requirement is frozen into the contract, not read at ready time.
  // Default stays false until A2 confirms the host's inner-call event shape; a host
  // configuration may only tighten it later (see sessionBindingPolicy).
  const requireSessionBinding = boolean(env.HEPHI_REQUIRE_SESSION_BINDING, false)
  const executionMode = env.HEPHI_ISSUE_TITLE !== undefined
    ? parseIssueExecutionMode(env.HEPHI_ISSUE_TITLE, env.HEPHI_EXECUTION_MODE)
    : parseExecutionMode(env.HEPHI_EXECUTION_MODE)
  const verification = await loadVerificationFromEnv(env)
  const task = taskOf(env, verification)
  const base: Omit<ActivationContract, 'contractHash'> = {
    version: ACTIVATION_VERSION,
    enabled: true,
    ticketId,
    repository: required(env, 'DSH_SUPERAGENT_GITHUB_REPOSITORY'),
    issueNumber: positiveInteger(required(env, 'DSH_SUPERAGENT_GITHUB_NUMBER'), 'DSH_SUPERAGENT_GITHUB_NUMBER'),
    workspace: required(env, 'DSH_SUPERAGENT_DIR'),
    baseRef: env.HEPHI_BASE_REF?.trim() || 'main',
    baseSha: required(env, 'HEPHI_BASE_COMMIT'),
    allowedPaths: list(env.HEPHI_ALLOWED_PATHS),
    requirePullRequest: boolean(env.HEPHI_REQUIRE_PULL_REQUEST, false),
    executionMode,
    enforcement,
    plugin: { version: pluginVersion, commit: pluginCommit() },
    verification,
    evidence: { requireSessionBinding },
    ...(task ? { task } : {}),
  }
  // C4.6: fail before writing a contract when the declared offline environment is not met.
  // Runs after the base required fields so missing-context errors keep their original order.
  const offlineProblems = offlineEnvironmentProblems(verification, base.workspace)
  if (offlineProblems.length > 0) throw new Error(`HEPHI offline environment is not satisfied: ${offlineProblems.join('; ')}`)
  // C1: an authorization never widens the contract scope or the authorizing item's paths.
  const authorizationIssue = authorizationProblem({ allowedPaths: base.allowedPaths, task })
  if (authorizationIssue) throw new Error(`invalid HEPHI task authorizations: ${authorizationIssue}`)
  const contract: ActivationContract = { ...base, contractHash: contractHash(base) }
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`
  await writeFile(temporary, `${JSON.stringify(contract, null, 2)}\n`, { flag: 'wx' })
  try {
    // `link` publishes the fully written file atomically and fails with EEXIST if another
    // prepare process won the race; only one process can create the contract.
    await link(temporary, filePath)
  } catch (error) {
    await unlink(temporary).catch(() => { /* Section below removes it when linked. */ })
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return reuseActivation(filePath, ticketId, intentPath)
    throw error
  }
  await unlink(temporary).catch(() => { /* The contract is linked; the temporary name is gone. */ })
  return { enabled: true, filePath, contract }
}

function isContract(value: unknown): value is Omit<ActivationContract, 'executionMode'> & { executionMode?: unknown } {
  if (!value || typeof value !== 'object') return false
  const contract = value as Partial<ActivationContract>
  return contract.enabled === true
    && typeof contract.ticketId === 'string'
    && typeof contract.repository === 'string'
    && Number.isInteger(contract.issueNumber) && (contract.issueNumber ?? 0) > 0
    && typeof contract.workspace === 'string'
    && typeof contract.baseRef === 'string' && contract.baseRef.length > 0
    && typeof contract.baseSha === 'string' && contract.baseSha.length > 0
    && Array.isArray(contract.allowedPaths) && contract.allowedPaths.every(item => typeof item === 'string')
    && typeof contract.requirePullRequest === 'boolean'
    && typeof contract.contractHash === 'string'
}

const ACTIVATION_FIELDS = new Set([
  'version', 'enabled', 'ticketId', 'repository', 'issueNumber', 'workspace', 'baseRef', 'baseSha',
  'allowedPaths', 'requirePullRequest', 'executionMode', 'enforcement', 'plugin', 'verification', 'evidence', 'task', 'contractHash',
])

/** Formats that use the canonical (sorted-key) hash: versions 2, 3, 4 and 5 share the same algorithm. */
const CANONICAL_ACTIVATION_VERSIONS = new Set<unknown>([2, 3, 4, ACTIVATION_VERSION])
function usesCanonicalHash(version: unknown): boolean {
  return CANONICAL_ACTIVATION_VERSIONS.has(version)
}

const SUPPORTED_ACTIVATION_VERSIONS = new Set<unknown>([LEGACY_ACTIVATION_VERSION, 2, 3, 4, ACTIVATION_VERSION])

/**
 * The evidence policy is part of version 3 only. Version 1/2 writers never emit it, so an
 * old-version contract carrying it was hand-edited: reject instead of silently interpreting
 * a binding switch that the writer of that format could not have frozen.
 */
function contractEvidenceProblem(contractRecord: Record<string, unknown>): string | undefined {
  const version = contractRecord.version
  const evidence = contractRecord.evidence
  if (typeof version === 'number' && version >= EVIDENCE_POLICY_SINCE) {
    if (evidence === undefined) return `${String(version)} requires evidence.requireSessionBinding`
  } else if (evidence !== undefined) {
    return `unsupported HEPHI activation field for this version: evidence (version ${String(version)})`
  }
  if (evidence === undefined) return undefined
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return 'invalid evidence policy (expected an object)'
  const keys = Object.keys(evidence as Record<string, unknown>)
  if (keys.length !== 1 || keys[0] !== 'requireSessionBinding'
    || typeof (evidence as { requireSessionBinding?: unknown }).requireSessionBinding !== 'boolean') {
    return 'invalid evidence policy (expected only requireSessionBinding: boolean)'
  }
  return undefined
}

/**
 * C3 approvers live in the frozen verification config from version 5. Older writers never
 * emit them, so a v1–v4 contract carrying approvers was hand-edited: reject instead of
 * enforcing an approval list that contract format could not freeze.
 */
function contractApproversProblem(contractRecord: Record<string, unknown>, verification: VerificationConfig): string | undefined {
  if (verification.approvers === undefined) return undefined
  const version = contractRecord.version
  if (typeof version === 'number' && version >= APPROVERS_SINCE) return undefined
  return `unsupported HEPHI activation field for this version: verification.approvers (version ${String(version)})`
}

/** An unknown top-level field could change a decision in a newer writer; it must not be ignored. */
function rejectUnsupportedFields(parsed: Record<string, unknown>, filePath: string): void {
  for (const key of Object.keys(parsed)) {
    if (!ACTIVATION_FIELDS.has(key)) throw new Error(`unsupported HEPHI activation field: ${key} (${filePath})`)
  }
}

/**
 * Current format is 5. Version 1, 2, 3 and 4 contracts stay readable.
 * Anything else is rejected with an explicit migration instruction.
 */
function supportedVersion(value: unknown, filePath: string): void {
  if (value === undefined || SUPPORTED_ACTIVATION_VERSIONS.has(value)) return
  throw new Error(`unsupported HEPHI activation version: ${String(value)}; re-prepare a new contract with the current plugin instead of editing the stored hash (${filePath})`)
}

/**
 * Parse one activation contract. The stored hash is verified against the raw
 * object first, so old contracts keep their original hash and mode-less meaning;
 * only then is executionMode interpreted. Nothing is rewritten or re-hashed.
 */
function parseActivation(text: string, filePath: string): ActivationContract {
  const parsed: unknown = JSON.parse(text)
  if (!isContract(parsed)) throw new Error(`invalid HEPHI activation contract: ${filePath}`)
  const { contractHash: storedHash, ...base } = parsed
  // Version selects the hash algorithm. Version 2 and version 3 use the same canonical
  // serialization; version 1 and unversioned contracts keep the historical raw key-order hash.
  // Unknown versions are checked with the historical algorithm first so a forged
  // hash still reports as a hash mismatch rather than a supported-but-wrong version.
  const expectedHash = usesCanonicalHash(base.version) ? contractHash(base) : legacyContractHash(base)
  if (storedHash !== expectedHash) throw new Error(`HEPHI activation contract hash mismatch: ${filePath}`)
  supportedVersion(base.version, filePath)
  rejectUnsupportedFields(parsed as Record<string, unknown>, filePath)
  // Validate persisted optional fields only after the original hash matches.
  // Return the parsed object unchanged so historical contracts keep their raw
  // shape and later reads/hashes match.
  contractExecutionMode(base.executionMode)
  contractEnforcement(base.enforcement)
  const evidenceProblem = contractEvidenceProblem(parsed as Record<string, unknown>)
  if (evidenceProblem) throw new Error(`invalid HEPHI activation contract: ${evidenceProblem} (${filePath})`)
  if (base.plugin !== undefined) {
    const plugin = base.plugin as { version?: unknown; commit?: unknown }
    if (typeof plugin?.version !== 'string' || typeof plugin?.commit !== 'string') throw new Error(`invalid HEPHI activation plugin metadata: ${filePath}`)
  }
  const verification = parseVerificationConfig(base.verification)
  const approversProblem = contractApproversProblem(parsed as Record<string, unknown>, verification)
  if (approversProblem) throw new Error(`invalid HEPHI activation contract: ${approversProblem} (${filePath})`)
  if (base.task !== undefined) {
    const task = parseTaskCard(base.task)
    for (const item of task.acceptance) {
      if (!verification.checks.some(check => check.id === item.check)) throw new Error(`HEPHI activation contract acceptance ${item.id} refers to unknown check ${item.check}`)
    }
    const authorizationIssue = authorizationProblem({ allowedPaths: base.allowedPaths, task })
    if (authorizationIssue) throw new Error(`invalid HEPHI activation contract: ${authorizationIssue} (${filePath})`)
  }
  return parsed as ActivationContract
}

export function loadActivationSync(filePath: string): ActivationContract {
  return parseActivation(readFileSync(filePath, 'utf8'), filePath)
}

export async function loadActivation(filePath: string): Promise<ActivationContract> {
  return parseActivation(await readFile(filePath, 'utf8'), filePath)
}

export async function activationExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
