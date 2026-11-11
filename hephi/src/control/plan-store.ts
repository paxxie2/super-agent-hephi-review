import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { allowedPath } from './repository.js'
import type { PlanWidth } from './check-store.js'

/**
 * C4.2: append-only change plan per Ticket.
 *
 * Enforcement is opt-in: with `verification.requirePlan` unset/false the plan is optional
 * (write/edit and ready do not require one); when `requirePlan` is true, worker-mount denies
 * write/edit without a current-contract plan (`plan.not-declared`) and the verifier denies ready
 * likewise, while out-of-plan edits are denied as `plan.outside-plan`. The final diff is always
 * checked against an existing plan.
 *
 * The plan is declared by the Worker before/while working and is bound to the frozen
 * contract hash. It is stored as `<stateDir>/hephi/<ticketId>/plan.jsonl` beside, but
 * outside, `checks/` and `decisions.jsonl`. Each line is one appended plan version:
 *
 *   { version: 1, at, contractHash, files: string[], note? }
 *
 * `files` are workspace-relative exact paths or glob patterns (same `matchesGlob`
 * semantics as the contract `allowedPaths`).
 *
 * Semantics (ROADMAP-95 §4.10 C4.2):
 *   - versions are appended, never rewritten; a later version can only be added.
 *   - a plan only applies to its own `contractHash`; after re-prepare (new hash) the
 *     old plan neither blocks nor justifies a ready report.
 *   - the plugin does NOT judge whether the planned changes are reasonable; ready only
 *     checks that the final diff is inside the declared files, and (normal form, C4.2)
 *     write/edit are additionally intercepted against the plan for the current contract.
 *   - a corrupt log fails closed: ready must not silently ignore an unreadable plan.
 *   - `planIncludes` is the single exact-path/glob membership check shared by the
 *     write/edit interception and the tool's own reporting.
 */
export const PLAN_VERSION = 1

export type PlanEntry = {
  version: typeof PLAN_VERSION
  at: string
  contractHash: string
  files: string[]
  note?: string
}

export type PlanInput = {
  contractHash: string
  files: string[]
  note?: string
}

export type PlanSummary = {
  contractHash: string
  /** Union of every file/glob declared for this contract, in first-seen order. */
  files: string[]
  /** Number of appended plan versions that apply to this contract. */
  entries: number
}

const SAFE_EVIDENCE_ID = /^[\w-]+$/
const MAX_NOTE_LENGTH = 4_000

/** Path of the per-Ticket plan log. Shared with readRuns' directory layout but outside `checks/`. */
export function planPath(stateDir: string, ticketId: string): string {
  if (!SAFE_EVIDENCE_ID.test(ticketId)) throw new Error('unsafe evidence id')
  return join(stateDir, 'hephi', ticketId, 'plan.jsonl')
}

function fileProblem(value: unknown): string | undefined {
  if (typeof value !== 'string') return 'plan file entry must be a string'
  const file = value.trim()
  if (!file) return 'plan file entry must not be empty'
  if (file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file)) return `plan file must be workspace-relative: ${file}`
  const segments = file.split(/[\\/]/)
  if (segments.includes('..')) return `plan file must not escape the workspace: ${file}`
  if (segments.some(segment => segment === '' || segment === '.')) return `plan file has an invalid path segment: ${file}`
  if (/[\u0000-\u001f\u007f]/.test(file)) return `plan file contains control characters: ${file}`
  return undefined
}

function entryProblem(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'plan entry is not an object'
  const entry = value as Partial<PlanEntry>
  if (entry.version !== PLAN_VERSION) return `unsupported plan version: ${String(entry.version)}`
  if (typeof entry.at !== 'string' || Number.isNaN(Date.parse(entry.at))) return 'plan timestamp is invalid'
  if (typeof entry.contractHash !== 'string' || !entry.contractHash.trim()) return 'plan contract hash is missing'
  if (!Array.isArray(entry.files) || entry.files.length === 0) return 'plan files must be a non-empty array'
  for (const file of entry.files) {
    const problem = fileProblem(file)
    if (problem) return problem
  }
  if (entry.note !== undefined) {
    if (typeof entry.note !== 'string' || entry.note.length > MAX_NOTE_LENGTH || /[\u0000-\u001f\u007f]/.test(entry.note)) return 'plan note is invalid'
  }
  return undefined
}

/**
 * Read all appended plan versions for one Ticket. A missing file is an empty log.
 * Any malformed line is an error (fail closed) — an unreadable plan must not silently
 * degrade ready to the no-plan behavior.
 */
export async function readPlanEntries(stateDir: string, ticketId: string): Promise<PlanEntry[]> {
  const file = planPath(stateDir, ticketId)
  let text: string
  try { text = await readFile(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const entries: PlanEntry[] = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (!line.trim()) continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { throw new Error(`corrupt plan log: invalid JSON at line ${index + 1} (${file})`) }
    const problem = entryProblem(parsed)
    if (problem) throw new Error(`corrupt plan log: ${problem} at line ${index + 1} (${file})`)
    entries.push(parsed as PlanEntry)
  }
  return entries
}

/**
 * Merged plan for exactly one contract hash. Returns undefined when no plan version
 * applies, so ready keeps its previous behavior for Tickets without a plan.
 */
export async function readPlan(stateDir: string, ticketId: string, contractHash: string): Promise<PlanSummary | undefined> {
  const matching = (await readPlanEntries(stateDir, ticketId)).filter(entry => entry.contractHash === contractHash)
  if (matching.length === 0) return undefined
  const files: string[] = []
  const seen = new Set<string>()
  for (const entry of matching) {
    for (const file of entry.files) {
      const normalized = file.trim()
      if (seen.has(normalized)) continue
      seen.add(normalized)
      files.push(normalized)
    }
  }
  return { contractHash, files, entries: matching.length }
}

/**
 * v5.4 §2 ②: record-only width of the declared plan vs the actual changed files.
 * Pure computation from two already-recorded counts; callers must never gate on it.
 * `planFiles` comes from `PlanSummary.files.length` (non-empty by construction) and
 * `changedFiles` from the final `ChangeSummary.files.length`.
 */
export function planWidthOf(planFiles: number, changedFiles: number): PlanWidth {
  if (!Number.isSafeInteger(planFiles) || planFiles < 1) throw new Error(`plan width needs a positive plan file count, got ${String(planFiles)}`)
  if (!Number.isSafeInteger(changedFiles) || changedFiles < 0) throw new Error(`plan width needs a non-negative changed file count, got ${String(changedFiles)}`)
  return { planFiles, changedFiles, ratio: changedFiles / planFiles }
}

/** True when the merged plan for this contract declares `file` (exact path or glob). */
export function planIncludes(plan: PlanSummary | undefined, file: string): boolean {
  return plan !== undefined && allowedPath(file, plan.files)
}

/**
 * Append one plan version. Plans are append-only: an identical repeat still produces a
 * new version (the Worker declared its plan again), never an edit of an earlier line.
 */
export async function appendPlan(stateDir: string, ticketId: string, input: PlanInput): Promise<{ appended: true; entry: PlanEntry }> {
  const file = planPath(stateDir, ticketId)
  const entry: PlanEntry = {
    version: PLAN_VERSION,
    at: new Date().toISOString(),
    contractHash: input.contractHash,
    files: Array.isArray(input.files) ? input.files.map(file => file.trim()) : input.files as never,
    ...(input.note === undefined ? {} : { note: input.note }),
  }
  const problem = entryProblem(entry)
  if (problem) throw new Error(problem)
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  return { appended: true, entry }
}
