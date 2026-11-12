import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { CheckRunRecord } from './check-store.js'

/**
 * B2 four-way delivery binding record (DSH host task order §3.2):
 * Ticket ↔ Session ↔ execution result ↔ final commit SHA.
 *
 * Consumer contract aligned with the DSH capability-B2 reference schema delivered in
 * `paxxie2/g1-at81#5` (`docs/host-capability-ab/b2-binding-record.schema.json`, baseline
 * `tag dsh-v0.2.1-rc.5`, commit `b830ec95`). The reference schema forbids unknown fields
 * (`additionalProperties: false`), but this consumer deliberately accepts them and reports
 * warnings instead of denying: a future host adding fields must not turn into a hephi-side
 * outage. Required hephi-side fields are the four-way minimum from §3.2.1; the enhanced
 * fields (`ticket.repository/issue`, `session.origin/agentPreset`, `finalCommit.prNumber`)
 * are optional and type-checked when present.
 *
 * This module is the hephi-side **consumer**. It does not require the host to ship the
 * record yet: the ready gate only activates while the Session binding is effective.
 */


export type BindingRecordExecution =
  | {
    kind: 'foreground'
    /** Final exit code of the executed check. */
    exitCode: number
    /** Host tool-call id that links the record to the Session event. */
    toolCallId: string
    terminalStatus?: string
    finishedAt?: string
  }
  | {
    kind: 'background' | 'promoted'
    /** Non-empty Job id; a background/promoted result carries no final exit code. */
    jobId: string
    toolCallId: string
    terminalStatus?: string
    finishedAt?: string
  }

export type BindingRecord = {
  /** Record format version; only a positive integer is accepted. */
  version: number
  /** ISO8601 timestamp of record production. */
  producedAt: string
  producer: string
  ticket: { id: string; repository?: string; issue?: number }
  session: { id: string; origin?: string; agentPreset?: string }
  execution: BindingRecordExecution
  finalCommit: { sha: string; baseSha: string; prNumber?: number }
}

const GIT_SHA = /^[0-9a-f]{40}$/
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function isIso8601(value: string): boolean {
  return ISO_8601.test(value) && !Number.isNaN(Date.parse(value))
}

const iso8601 = z.string().refine(isIso8601, 'must be an ISO8601 timestamp')
const gitSha = z.string().regex(GIT_SHA, 'must be 40 lowercase hex characters')
// The host reference schema types these as plain strings (no minLength); a host writing
// an empty value is type-correct, so rejecting it here would be a false denial.
const executionTail = {
  toolCallId: z.string().min(1),
  terminalStatus: z.string().optional(),
  finishedAt: iso8601.optional(),
}

/**
 * Shape schema. Execution branches are loose on purpose: the record may carry extra
 * host fields, and `validateBindingRecord` inspects the raw object for the two
 * conflicting-field rules (foreground must not name a Job; background/promoted must
 * not carry a final exit code).
 */
export const BindingRecordSchema = z.object({
  version: z.number().int().positive(),
  producedAt: iso8601,
  producer: z.string().min(1),
  ticket: z.object({
    id: z.string().min(1),
    repository: z.string().min(1).optional(),
    issue: z.number().int().positive().optional(),
  }).loose(),
  session: z.object({
    id: z.string().min(1),
    origin: z.string().optional(),
    agentPreset: z.string().optional(),
  }).loose(),
  execution: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('foreground'), exitCode: z.number().int(), ...executionTail }).loose(),
    z.object({ kind: z.literal('background'), jobId: z.string().min(1), ...executionTail }).loose(),
    z.object({ kind: z.literal('promoted'), jobId: z.string().min(1), ...executionTail }).loose(),
  ]),
  finalCommit: z.object({
    sha: gitSha,
    baseSha: gitSha,
    prNumber: z.number().int().positive().optional(),
  }).loose(),
}).loose()

export type BindingRecordValidation =
  | {
    ok: true
    record: BindingRecord
    /**
     * Unknown fields found in the record (top level or in a nested object). They are NOT
     * denials: the host reference schema forbids them, but a future host may add fields and
     * hephi must not turn that into an outage ("warn, never falsely reject").
     */
    warnings: string[]
  }
  | { ok: false; problem: string }

const TOP_LEVEL_FIELDS = new Set(['version', 'producedAt', 'producer', 'ticket', 'session', 'execution', 'finalCommit'])
const TICKET_FIELDS = new Set(['id', 'repository', 'issue'])
const SESSION_FIELDS = new Set(['id', 'origin', 'agentPreset'])
const FOREGROUND_FIELDS = new Set(['toolCallId', 'kind', 'exitCode', 'terminalStatus', 'finishedAt'])
const JOB_FIELDS = new Set(['toolCallId', 'kind', 'jobId', 'terminalStatus', 'finishedAt'])
const FINAL_COMMIT_FIELDS = new Set(['sha', 'baseSha', 'prNumber'])

function unknownFields(value: unknown, known: Set<string>, path: string): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.keys(value as Record<string, unknown>)
    .filter(key => !known.has(key))
    .map(key => `${path === '' ? key : `${path}.${key}`}`)
}

function issueSummary(error: z.ZodError): string {
  return error.issues.slice(0, 5)
    .map(issue => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ')
}

/**
 * Validate one host-produced record. Shape errors and the two execution-kind conflict
 * rules are fail-closed: any deviation means the record cannot be consumed. Unknown fields
 * are reported as warnings (the ready gate still passes only if the four-way check passes).
 */
export function validateBindingRecord(value: unknown): BindingRecordValidation {
  const parsed = BindingRecordSchema.safeParse(value)
  if (!parsed.success) return { ok: false, problem: `binding record schema mismatch: ${issueSummary(parsed.error)}` }
  const record = parsed.data as BindingRecord
  const rawExecution = (value as { execution?: Record<string, unknown> }).execution ?? {}
  if (record.execution.kind === 'foreground') {
    if (rawExecution.jobId !== undefined) {
      return { ok: false, problem: 'binding record schema mismatch: a foreground execution must not name a Job (execution.jobId)' }
    }
  } else if (rawExecution.exitCode !== undefined) {
    return { ok: false, problem: `binding record schema mismatch: a ${record.execution.kind} execution must not carry a final exit code (execution.exitCode)` }
  }
  const warnings = [
    ...unknownFields(value, TOP_LEVEL_FIELDS, ''),
    ...unknownFields((value as { ticket?: unknown }).ticket, TICKET_FIELDS, 'ticket'),
    ...unknownFields((value as { session?: unknown }).session, SESSION_FIELDS, 'session'),
    ...unknownFields(rawExecution, record.execution.kind === 'foreground' ? FOREGROUND_FIELDS : JOB_FIELDS, 'execution'),
    ...unknownFields((value as { finalCommit?: unknown }).finalCommit, FINAL_COMMIT_FIELDS, 'finalCommit'),
  ]
  return { ok: true, record, warnings }
}

export type BindingRecordOrigin = 'config' | 'env' | 'default'

export type BindingRecordSource = {
  /** Absolute record path (a configured directory resolves to `<dir>/<ticketId>.json`). */
  path: string
  origin: BindingRecordOrigin
  /** `true` for an explicitly configured source (host config or environment). */
  configured: boolean
}

/**
 * Resolve the record source in deployment order: host configuration
 * (`bindingRecordPath`) → `DSH_BINDING_RECORD` → `<stateDir>/binding/<ticket>.json`.
 */
export function bindingRecordSource(options: {
  stateDir: string
  ticketId: string
  /** Host configuration seam (`bindingRecordPath`); not wired by `index.ts` yet. */
  configuredPath?: string
  env?: NodeJS.ProcessEnv
}): BindingRecordSource {
  const configuredPath = options.configuredPath?.trim()
  if (configuredPath) return { path: resolve(configuredPath), origin: 'config', configured: true }
  const envPath = (options.env ?? process.env).DSH_BINDING_RECORD?.trim()
  if (envPath) return { path: resolve(envPath), origin: 'env', configured: true }
  return { path: join(options.stateDir, 'binding', `${options.ticketId}.json`), origin: 'default', configured: false }
}

export type BindingRecordLookup =
  | { found: true; path: string; origin: BindingRecordOrigin; value: unknown }
  | {
    found: false
    path: string
    origin: BindingRecordOrigin
    /** The file is absent or cannot be parsed; the ready gate always denies in this case. */
    reason: 'missing' | 'unreadable'
    problem: string
  }

/**
 * Read the record without throwing. A missing file is `{found:false}` as required by the
 * contract; the ready gate treats it as a fail-closed denial whenever binding is effective
 * (there is no "unconfigured" skip: binding on requires the host to deliver B1 + B2).
 *
 * Source order: host configuration `bindingRecordPath` → `DSH_BINDING_RECORD` →
 * `<stateDir>/binding/<ticket>.json`. The environment only locates the record; it is never
 * an enable/skip channel (matching the trust boundary of TB-01/TB-03).
 */
export async function readBindingRecord(options: {
  stateDir: string
  ticketId: string
  configuredPath?: string
  env?: NodeJS.ProcessEnv
}): Promise<BindingRecordLookup> {
  const source = bindingRecordSource(options)
  let path = source.path
  if (source.configured) {
    try {
      if ((await stat(path)).isDirectory()) path = join(path, `${options.ticketId}.json`)
    } catch { /* path does not exist (or is not a directory); read below reports it */ }
  }
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return {
        found: false, path, origin: source.origin, reason: 'missing',
        problem: `binding record does not exist: ${path}`,
      }
    }
    return {
      found: false, path, origin: source.origin, reason: 'unreadable',
      problem: `binding record is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  try {
    return { found: true, path, origin: source.origin, value: JSON.parse(text) }
  } catch {
    return { found: false, path, origin: source.origin, reason: 'unreadable', problem: `binding record is not valid JSON: ${path}` }
  }
}

export type BindingRecordExpectation = {
  /** Frozen contract ticket id. */
  ticketId: string
  /** Worker Session header id of the ready report. */
  sessionId: string
  /** HEAD of the verified candidate tree; the record must name exactly this commit. */
  headSha: string | undefined
  /** Frozen contract base commit. */
  baseSha: string
  /** Check records already accepted as passing evidence for this ready report. */
  usedRuns: readonly CheckRunRecord[]
}

function describeRun(record: CheckRunRecord): string {
  return record.jobId === undefined
    ? `foreground exit ${String(record.exitCode)}`
    : `Job ${record.jobId}`
}

/**
 * The four-way consistency check (host task order §3.2.2 steps 2–5):
 * ticket / session / execution-vs-accepted-run / final commit SHA.
 * Returns the first mismatch as a human-readable problem, or undefined when consistent.
 */
export function bindingRecordProblem(record: BindingRecord, expected: BindingRecordExpectation): string | undefined {
  if (record.ticket.id !== expected.ticketId) {
    return `ticket.id "${record.ticket.id}" does not match the contract ticket "${expected.ticketId}"`
  }
  if (record.session.id !== expected.sessionId) {
    return `session.id "${record.session.id}" does not match the current Worker Session "${expected.sessionId}"`
  }
  if (expected.headSha === undefined || expected.headSha === '') {
    return 'the verified candidate HEAD is unavailable; the finalCommit binding cannot be checked'
  }
  if (record.finalCommit.sha !== expected.headSha) {
    return `finalCommit.sha "${record.finalCommit.sha}" does not match the verified candidate HEAD "${expected.headSha}"`
  }
  if (record.finalCommit.baseSha !== expected.baseSha) {
    return `finalCommit.baseSha "${record.finalCommit.baseSha}" does not match the contract baseSha "${expected.baseSha}"`
  }
  const execution = record.execution
  const candidates = expected.usedRuns.filter(run =>
    run.innerCallId === execution.toolCallId || run.callId === execution.toolCallId)
  if (candidates.length === 0) {
    return `execution.toolCallId "${execution.toolCallId}" does not name any accepted check run`
  }
  const matched = candidates.find(run => execution.kind === 'foreground'
    ? run.jobId === undefined && run.exitCode === execution.exitCode
    : run.jobId !== undefined && run.jobId === execution.jobId)
  if (matched === undefined) {
    const wanted = execution.kind === 'foreground'
      ? `foreground exit ${String(execution.exitCode)}`
      : `${execution.kind} Job ${execution.jobId}`
    return `execution (${wanted}) disagrees with the accepted check run (${describeRun(candidates[0]!)})`
  }
  return undefined
}
