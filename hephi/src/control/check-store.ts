import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RepositoryFingerprint } from '../verification/fingerprint.js'

/** T17: the red (before-implementation) phase. Ordinary runs carry no phase at all. */
export type CheckRunPhase = 'red'

/**
 * H6=C detect-only: digest of the Worker Session's persisted log prefix at check
 * completion. `bytes`/`sha256` cover only complete units (zstd frames or JSONL lines),
 * so a torn trailing batch from a live append is not part of the seal. This is
 * detection, not protection (same UID Worker can rewrite the log or the record).
 */
export type SnapshotSeal = {
  format: 'jsonl.zstd' | 'jsonl'
  /** Number of sealed prefix bytes. */
  bytes: number
  /** SHA-256 (hex) of exactly the first `bytes` bytes of the persisted log. */
  sha256: string
  /** Complete zstd frames (jsonl.zstd) or complete JSONL lines (jsonl) in the prefix. */
  frames: number
}

/** Why the seal could not be taken at check completion; ready fails closed when binding is effective. */
export type SnapshotSealUnavailable = string

/**
 * v5.4 §2 ① prompt-only: how the workspace changed since the previous check run.
 * Written for Worker feedback only; no verifier reads it, so it can never change a
 * deny/allow decision. `scope` distinguishes "no previous check yet, measured from the
 * contract base" from "measured from the previous check's head commit".
 */
export type IncrementalChanges = {
  scope: 'previous-check' | 'base'
  files: number
  addedLines: number
  removedLines: number
  /** Whole seconds since the previous check finished; absent for the first check. */
  sinceLastCheckSeconds?: number
  fromCommit: string
  toCommit: string
}

/**
 * v5.4 §2 ② record-only plan width: declared plan file count vs the final changed file
 * count. Stored on check records and logged as `plan.width`; never gates ready.
 */
export type PlanWidth = {
  planFiles: number
  changedFiles: number
  /** changedFiles / planFiles (plan files are never empty, so the divisor is non-zero). */
  ratio: number
}

export type CheckRunRecord = {
  version: 3; runId: string; sequence: number; ticketId: string; contractHash: string;
  /** Plugin build that produced this record; ready rejects a different build. */
  pluginCommit: string;
  checkId: string; sessionId: string; callId: string; innerCallId: string;
  /**
   * T17: optional `red` phase marker. Records written before T17 (and ordinary runs)
   * have no `phase`; readers treat a missing value as an ordinary check.
   */
  phase?: CheckRunPhase;
  /** Native background Job id, persisted before waiting for its terminal state. */
  jobId?: string;
  argv: string[]; cwd: string; startedAt: string; finishedAt?: string;
  status: 'running' | 'passed' | 'blocked' | 'unknown'; exitCode: number | null;
  before: RepositoryFingerprint; after?: RepositoryFingerprint;
  outputHash?: string; reason?: string;
  /** H6=C detect-only: sealed Session log prefix taken at check completion. */
  snapshotSeal?: SnapshotSeal;
  /** Set instead of `snapshotSeal` when the host adapter could not seal the log. */
  snapshotSealUnavailable?: SnapshotSealUnavailable;
  /** v5.4 §2 ① prompt-only delta since the previous check (or the contract base for the first check). */
  incrementalChanges?: IncrementalChanges;
  /** v5.4 §2 ② record-only plan width snapshot taken when this check ran. */
  planWidth?: PlanWidth;
}
const SAFE_EVIDENCE_ID = /^[\w-]+$/
export function checkRunDir(stateDir: string, ticketId: string, runId = ''): string {
  if (!SAFE_EVIDENCE_ID.test(ticketId) || (runId && !SAFE_EVIDENCE_ID.test(runId))) throw new Error('unsafe evidence id')
  return join(stateDir, 'hephi', ticketId, 'checks', runId)
}

function assertRecord(value: unknown, ticketId: string, expectedRunId: string): CheckRunRecord {
  const record = value as CheckRunRecord
  if (!record || typeof record !== 'object' || record.version !== 3 || typeof record.pluginCommit !== 'string'
    || typeof record.runId !== 'string' || record.runId !== expectedRunId || record.ticketId !== ticketId
    || !Number.isSafeInteger(record.sequence) || !['running', 'passed', 'blocked', 'unknown'].includes(record.status)
    || (record.phase !== undefined && record.phase !== 'red')) {
    throw new Error('unsupported or corrupt check evidence')
  }
  // H6=C: a record carries either a well-formed seal or an unavailable marker, never
  // both; a malformed seal is corrupt evidence (fail closed) instead of "no seal".
  if (record.snapshotSeal !== undefined) {
    const problem = snapshotSealShapeProblem(record.snapshotSeal)
    if (problem !== undefined) throw new Error(`unsupported or corrupt check evidence: ${problem}`)
  }
  if (record.snapshotSealUnavailable !== undefined
    && (typeof record.snapshotSealUnavailable !== 'string' || record.snapshotSealUnavailable.length === 0)) {
    throw new Error('unsupported or corrupt check evidence: snapshotSealUnavailable must be a non-empty string')
  }
  if (record.snapshotSeal !== undefined && record.snapshotSealUnavailable !== undefined) {
    throw new Error('unsupported or corrupt check evidence: snapshotSeal and snapshotSealUnavailable are mutually exclusive')
  }
  return record
}

const SNAPSHOT_SEAL_HEX = /^[0-9a-f]{64}$/

/** Shape validation for the persisted seal (fail closed: any deviation is corrupt evidence). */
export function snapshotSealShapeProblem(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return 'snapshotSeal must be an object'
  const seal = value as Partial<SnapshotSeal>
  if (seal.format !== 'jsonl.zstd' && seal.format !== 'jsonl') return 'snapshotSeal.format must be jsonl.zstd or jsonl'
  if (!Number.isSafeInteger(seal.bytes) || (seal.bytes as number) < 0) return 'snapshotSeal.bytes must be a non-negative safe integer'
  if (typeof seal.sha256 !== 'string' || !SNAPSHOT_SEAL_HEX.test(seal.sha256)) return 'snapshotSeal.sha256 must be 64 lowercase hex characters'
  if (!Number.isSafeInteger(seal.frames) || (seal.frames as number) < 1) return 'snapshotSeal.frames must be a positive safe integer'
  return undefined
}

/** Read one stored run record; a missing run is an error, not an empty result. */
export async function readRun(stateDir: string, ticketId: string, runId: string): Promise<CheckRunRecord> {
  const file = join(checkRunDir(stateDir, ticketId, runId), 'run.json')
  let text: string
  try { text = await readFile(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`check run not found: ${ticketId}/${runId}`)
    throw error
  }
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('unsupported or corrupt check evidence') }
  return assertRecord(value, ticketId, runId)
}

export async function saveRun(stateDir: string, record: CheckRunRecord): Promise<void> {
  const path = join(checkRunDir(stateDir, record.ticketId, record.runId), 'run.json')
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(record, null, 2), { flag: 'wx' })
  await rename(temp, path)
}
export async function readRuns(stateDir: string, ticketId: string): Promise<CheckRunRecord[]> {
  const dir = checkRunDir(stateDir, ticketId)
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
  const records: CheckRunRecord[] = []
  for (const entry of entries.filter(e => e.isDirectory())) {
    const value = JSON.parse(await readFile(join(dir, entry.name, 'run.json'), 'utf8')) as CheckRunRecord
    records.push(assertRecord(value, ticketId, entry.name))
  }
  return records.sort((a, b) => a.sequence - b.sequence)
}

/**
 * A3 operator resolutions can unblock one interrupted execution (run-unblock) or
 * reset the C4.5 retry counter for one check (retry-reset). Both are operator-only
 * (see the temporary host switch) and append-only.
 */
export type ResolutionBasis = 'host-terminal' | 'operator-risk-accepted'
export const RESOLUTION_BASES: readonly ResolutionBasis[] = ['host-terminal', 'operator-risk-accepted']
export const OPERATOR_RESOLUTIONS_ENV = 'HEPHI_ALLOW_OPERATOR_RESOLUTIONS'
const MAX_HOST_QUERY_LENGTH = 100_000
const MAX_OPERATOR_LENGTH = 200

/** Historical records have no kind; they are all run unblocks. */
export type ResolutionKind = 'run-unblock' | 'retry-reset'
export const RESOLUTION_KINDS: readonly ResolutionKind[] = ['run-unblock', 'retry-reset']

type ResolutionCommon = {
  /** Ticket the resolution is scoped to. */
  ticketId: string
  /** Contract the resolution belongs to; a different contract is never affected. */
  contractHash: string
  /** How the operator established the reason for the resolution. */
  basis: ResolutionBasis
  /** Raw query output (host Job/process query) or the query failure text. */
  hostQuery: string
  /** Operator identity recorded for audit. */
  operator: string
  at: string
}

/** Unblocks one interrupted (running/unknown) execution. */
export type RunUnblockResolution = ResolutionCommon & { kind?: 'run-unblock'; runId: string }

/** C4.5: resets the retry counter for exactly one check under one contract. */
export type RetryResetResolution = ResolutionCommon & { kind: 'retry-reset'; checkId: string }

export type CheckResolution = RunUnblockResolution | RetryResetResolution

export type ResolutionInput =
  | (Omit<RunUnblockResolution, 'at'> & { at?: undefined })
  | (Omit<RetryResetResolution, 'at'> & { at?: undefined })

export type AppendResolutionResult = {
  /** False when an equivalent resolution for this run already existed (idempotent repeat). */
  appended: boolean
  resolution: CheckResolution
}

/** The temporary host switch for operator resolutions; disabled unless explicitly "1". Callers pass the env explicitly. */
export function operatorResolutionsAllowed(env: NodeJS.ProcessEnv): boolean {
  return env[OPERATOR_RESOLUTIONS_ENV] === '1'
}

export function resolutionsPath(stateDir: string, ticketId: string): string {
  if (!SAFE_EVIDENCE_ID.test(ticketId)) throw new Error('unsafe evidence id')
  return join(stateDir, 'hephi', ticketId, 'resolutions.jsonl')
}

/** Historical resolution records have no kind: interpret them as run unblocks. */
function resolutionKind(record: Record<string, unknown>): ResolutionKind {
  return record.kind === undefined ? 'run-unblock' : record.kind as ResolutionKind
}

function resolutionProblem(value: unknown, ticketId: string): string | undefined {
  const record = value as CheckResolution
  const raw = record as unknown as Record<string, unknown>
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'resolution is not an object'
  if (record.ticketId !== ticketId || !SAFE_EVIDENCE_ID.test(String(record.ticketId))) return 'resolution ticket id does not match its directory'
  if (typeof record.contractHash !== 'string' || !record.contractHash.trim()) return 'resolution contract hash is missing'
  const kind = resolutionKind(raw)
  if (!RESOLUTION_KINDS.includes(kind)) return `resolution kind is invalid: ${String(raw.kind)}`
  if (kind === 'run-unblock') {
    if (typeof (record as RunUnblockResolution).runId !== 'string' || !SAFE_EVIDENCE_ID.test((record as RunUnblockResolution).runId)) return 'resolution run id is invalid'
    if (raw.checkId !== undefined) return 'run-unblock resolution must not carry a check id'
  } else {
    if (typeof (record as RetryResetResolution).checkId !== 'string' || !SAFE_EVIDENCE_ID.test((record as RetryResetResolution).checkId)) return 'retry-reset check id is invalid'
    if (raw.runId !== undefined) return 'retry-reset resolution must not carry a run id'
  }
  if (!RESOLUTION_BASES.includes(record.basis)) return `resolution basis is invalid: ${String(record.basis)}`
  if (typeof record.hostQuery !== 'string' || !record.hostQuery.trim()) return 'resolution host query is missing'
  if (record.hostQuery.length > MAX_HOST_QUERY_LENGTH) return 'resolution host query is too long'
  if (typeof record.operator !== 'string' || !record.operator.trim()) return 'resolution operator is missing'
  if (record.operator.length > MAX_OPERATOR_LENGTH) return 'resolution operator is too long'
  if (/[\u0000-\u001f\u007f]/.test(record.operator)) return 'resolution operator contains control characters'
  if (typeof record.at !== 'string' || Number.isNaN(Date.parse(record.at))) return 'resolution timestamp is invalid'
  return undefined
}

/** One idempotency key per resolution target (run or retry counter). */
function resolutionKey(record: CheckResolution): string {
  const raw = record as unknown as Record<string, unknown>
  return resolutionKind(raw) === 'retry-reset'
    ? `retry-reset:${(record as RetryResetResolution).checkId}`
    : `run-unblock:${(record as RunUnblockResolution).runId}`
}

/**
 * Read the ticket's resolution log. Any malformed line is an error: this log can
 * unblock reruns, so corruption must fail closed instead of silently dropping an
 * entry. The file is never written by this function.
 */
export async function readResolutions(stateDir: string, ticketId: string): Promise<CheckResolution[]> {
  const file = resolutionsPath(stateDir, ticketId)
  let text: string
  try { text = await readFile(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const seen = new Map<string, CheckResolution>()
  const resolutions: CheckResolution[] = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (!line.trim()) continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { throw new Error(`corrupt resolution log: invalid JSON at line ${index + 1} (${file})`) }
    const problem = resolutionProblem(parsed, ticketId)
    if (problem) throw new Error(`corrupt resolution log: ${problem} at line ${index + 1} (${file})`)
    const resolution = parsed as CheckResolution
    const key = resolutionKey(resolution)
    const previous = seen.get(key)
    if (previous) {
      // A retried identical resolution (same evidence, another timestamp) is a
      // duplicate; any disagreement is corruption and fails closed.
      const equivalent = previous.contractHash === resolution.contractHash && previous.basis === resolution.basis
        && previous.hostQuery === resolution.hostQuery && previous.operator === resolution.operator
        && resolutionKind(previous as unknown as Record<string, unknown>) === resolutionKind(resolution as unknown as Record<string, unknown>)
        && (resolution as RunUnblockResolution).runId === (previous as RunUnblockResolution).runId
        && (resolution as RetryResetResolution).checkId === (previous as RetryResetResolution).checkId
      if (!equivalent) throw new Error(`conflicting resolution records for ${key} (${file})`)
      continue
    }
    seen.set(key, resolution)
    resolutions.push(resolution)
  }
  return resolutions
}

function sameResolutionTarget(a: CheckResolution, b: CheckResolution): boolean {
  return resolutionKey(a) === resolutionKey(b)
}

/**
 * Append one resolution. Repeats for the same target (run id or retry-reset check id)
 * never append again and always return the first record, so a retried command is
 * idempotent. A target resolved for another contract is a hard error.
 */
export async function appendResolution(stateDir: string, input: ResolutionInput): Promise<AppendResolutionResult> {
  const file = resolutionsPath(stateDir, input.ticketId)
  const candidate = { ...input, at: new Date().toISOString() } as CheckResolution
  const problem = resolutionProblem(candidate, input.ticketId)
  if (problem) throw new Error(problem)
  const existing = (await readResolutions(stateDir, input.ticketId)).find(record => sameResolutionTarget(record, candidate))
  if (existing) {
    if (existing.contractHash !== candidate.contractHash) throw new Error(`${resolutionKey(candidate)} is already resolved for another contract`)
    return { appended: false, resolution: existing }
  }
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(candidate)}\n`, { mode: 0o600 })
  return { appended: true, resolution: candidate }
}

/** Run ids resolved for exactly this ticket and contract; a different contract never matches. */
export async function resolvedRunIds(stateDir: string, ticketId: string, contractHash: string): Promise<Set<string>> {
  const resolutions = await readResolutions(stateDir, ticketId)
  return new Set(resolutions
    .filter((record): record is RunUnblockResolution =>
      (record.kind === undefined || record.kind === 'run-unblock') && record.contractHash === contractHash)
    .map(record => record.runId))
}

/** Retry-reset records for exactly this ticket and contract (C4.5). */
export async function readRetryResets(stateDir: string, ticketId: string, contractHash: string): Promise<RetryResetResolution[]> {
  const resolutions = await readResolutions(stateDir, ticketId)
  return resolutions.filter((record): record is RetryResetResolution =>
    record.kind === 'retry-reset' && record.contractHash === contractHash)
}

/** The run-unblock resolution for one run under exactly this contract, if any. */
export async function resolutionFor(stateDir: string, ticketId: string, contractHash: string, runId: string): Promise<RunUnblockResolution | undefined> {
  const resolutions = await readResolutions(stateDir, ticketId)
  return resolutions.find((record): record is RunUnblockResolution =>
    (record.kind === undefined || record.kind === 'run-unblock') && record.contractHash === contractHash && record.runId === runId)
}
