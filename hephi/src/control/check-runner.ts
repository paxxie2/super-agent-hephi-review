import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ToolExecution, ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { verificationOf, type ActivationContract } from './activation.js'
import { gitFingerprint, sha256 } from '../verification/fingerprint.js'
import { clean, hasCommit, normalizeRepository, remoteRepository } from './repository.js'
import { inScope } from './discipline.js'
import { resolveWorkspace } from './workspace.js'
import { checkRunDir, readRetryResets, readRuns, resolvedRunIds, saveRun, type CheckRunRecord } from './check-store.js'
import { logDecision } from './decision-log.js'
import { pluginCommit } from '../version.js'

export type CheckTools = { execute(input: ToolExecutionInput): Promise<ToolExecutionResult> }

/** Public projection of one native background Job; only what a check reads. */
export type NativeJobView = {
  status: string
  detail?: string
}

type NativeJobRead = {
  chunks: readonly { at: number; text: string; gapBefore?: true }[]
  lossy: boolean
  /** UTF-8 byte offset to resume from; absent on host surfaces without incremental reads. */
  next?: number
}

/** One native Job lifecycle or output event; collection reads only the identity and the ring total. */
export type NativeJobEvent =
  | { type: 'registered' | 'progress' | 'stopping' | 'removed' | 'settled'; job: { id?: string; owner?: string; status?: string; detail?: string } }
  | { type: 'output'; id?: string; owner?: string; total?: number }

/** Host-provided `ctx.jobs` surface; only the operations a check needs. */
export type NativeJobs = {
  get(id: string, caller?: string): NativeJobView
  wait(id: string, timeoutMs: number, caller?: string, signal?: AbortSignal): Promise<NativeJobView>
  readAt(id: string, from: number, caller?: string): NativeJobRead
  kill(id: string, caller?: string, reason?: string): 'requested' | 'already-finished'
  /** Optional event stream; a host without it keeps the end-of-run read and its lossy refusal. */
  events?: { subscribe(filter: { owner: string }, listener: (event: NativeJobEvent) => void): () => void }
}

const JOB_WAIT_MS = 30_000
const JOB_CONFIRM_MS = 15_000
const isTerminal = (status: string) => status === 'completed' || status === 'killed' || status === 'failed'
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"
export function sameSource(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b) }
/** The exact shell command a check hands to the native bash tool; Session binding compares against it. */
export function checkCommand(baseSha: string, command: string, args: string[]): string {
  return `HEPHI_BASE_COMMIT=${quote(baseSha)} ` + [command, ...args].map(quote).join(' ')
}
export async function contained(root: string, path: string): Promise<string> {
  const [base, actual] = await Promise.all([realpath(root), realpath(resolve(root, path))])
  if (actual !== base && !actual.startsWith(base + sep)) throw new Error('path escapes declared directory')
  return actual
}

function jobExitCode(detail: string | undefined): number | undefined {
  if (detail === undefined) return undefined
  const match = /^exit code: (-?\d+)(?:;|$)/.exec(detail)
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : undefined
}

/** C4.5 default: actual-run failures allowed per check/contract before refusing to start. */
export const DEFAULT_RETRY_LIMIT = 3

const RETRY_LIMIT_GUIDANCE = 'report blocked in the fixed format: (1) the blocked acceptance item; (2) what each attempt changed; (3) the key points of the check output; (4) the assessed cause; (5) who must decide what. An operator retry-reset (A3) is required before this check can run again.'

/** A blocked record that actually ran; start-up refusals (`check not started:`) are not failures. */
function ranAndFailed(record: CheckRunRecord): boolean {
  return record.status === 'blocked' && !(record.reason ?? '').startsWith('check not started:')
}

/**
 * C4.5: derived retry counter = actual-run failures for one check under one contract
 * since the last `passed` or the latest operator retry-reset. `blocked` counts when the
 * check really ran; `running`/`unknown` do not count (they block elsewhere); a pass or a
 * retry-reset clears the counter; a different contractHash is filtered out (= starts at 0).
 * Timestamps: records use `startedAt`, retry-resets use `at`; both are ISO UTC strings.
 */
export function retryFailureCount(records: CheckRunRecord[], checkId: string, contractHash: string, resetAt: string[] = []): number {
  const latestReset = resetAt.reduce((latest, at) => (at > latest ? at : latest), '')
  let failures = 0
  for (const record of records) {
    if (record.checkId !== checkId || record.contractHash !== contractHash) continue
    if (latestReset && record.startedAt <= latestReset) continue
    if (record.status === 'passed') { failures = 0; continue }
    if (ranAndFailed(record)) failures += 1
  }
  return failures
}

async function readJobOutput(jobs: NativeJobs, jobId: string, sessionId: string): Promise<string> {
  const read = jobs.readAt(jobId, 0, sessionId)
  if (!read || !Array.isArray(read.chunks) || typeof read.lossy !== 'boolean') {
    throw new Error('native Job readAt returned an unknown structure')
  }
  for (const chunk of read.chunks) {
    if (!chunk || typeof chunk.at !== 'number' || typeof chunk.text !== 'string') {
      throw new Error('native Job returned an unknown output chunk')
    }
  }
  if (read.lossy) throw new Error('native Job output was lost before it could be read')
  return read.chunks.map(chunk => chunk.text).join('')
}

/** One subscribed Job's byte cursor and every byte collected since its registration. */
type JobCollector = { readonly id: string; cursor: number; output: string; error?: string }

const isByteOffset = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Keep a chunk's tail from a byte offset; an offset inside a UTF-8 sequence is malformed. */
function chunkTail(text: string, from: number): string {
  const bytes = Buffer.from(text, 'utf8')
  const part = bytes.subarray(from)
  const tail = part.toString('utf8')
  if (!Buffer.from(tail, 'utf8').equals(part)) throw new Error('chunk is not cut on a UTF-8 boundary')
  return tail
}

/**
 * Drain one Job strictly from its own byte cursor. Every read must be a
 * lossless, gap-free, byte-addressed continuation; a host may return a whole
 * retained chunk whose `at` precedes the cursor, so only the unread tail is
 * appended. Failures stay on the Job and never escape to the event registry.
 */
function drainJobOutput(jobs: NativeJobs, sessionId: string, collector: JobCollector): void {
  if (collector.error !== undefined) return
  let read: NativeJobRead
  try {
    read = jobs.readAt(collector.id, collector.cursor, sessionId)
  } catch (error) {
    collector.error = `native Job output read failed: ${error instanceof Error ? error.message : String(error)}`
    return
  }
  if (!read || typeof read.lossy !== 'boolean' || !Array.isArray(read.chunks)) {
    collector.error = 'native Job output read returned an unknown structure'
    return
  }
  const next = read.next
  if (!isByteOffset(next) || next < collector.cursor) {
    collector.error = 'native Job output read did not advance a byte cursor'
    return
  }
  if (read.lossy) {
    collector.error = 'native Job output was lost before it could be collected'
    return
  }
  let cursor = collector.cursor
  const pieces: string[] = []
  for (const chunk of read.chunks) {
    if (!chunk || !isByteOffset(chunk.at) || typeof chunk.text !== 'string' || chunk.gapBefore !== undefined) {
      collector.error = 'native Job output returned an unknown or discontinuous chunk'
      return
    }
    const end = chunk.at + Buffer.byteLength(chunk.text, 'utf8')
    if (end <= cursor) continue
    if (chunk.at > cursor) {
      collector.error = `native Job output skipped bytes before offset ${chunk.at}`
      return
    }
    try {
      pieces.push(chunkTail(chunk.text, cursor - chunk.at))
    } catch (error) {
      collector.error = `native Job output chunk is malformed: ${error instanceof Error ? error.message : String(error)}`
      return
    }
    cursor = end
  }
  if (cursor !== next) {
    collector.error = cursor < next
      ? 'native Job output did not cover the advertised byte cursor'
      : 'native Job output overran the advertised byte cursor'
    return
  }
  collector.output += pieces.join('')
  collector.cursor = next
}

/** Live subscription over this Session's newly registered Jobs, kept for one native call. */
type JobCollection = {
  /** The Job the native call actually returned; collectors for every other Job are dropped. */
  take(id: string): JobCollector | undefined
  /** A collection-level failure (the event stream itself is unusable), if any. */
  failure(): string | undefined
  dispose(): void
}

/**
 * Subscribe before the native call starts so no registration or output event can
 * be missed. The owner filter also delivers unowned Jobs, which are explicitly
 * excluded; a Job is collected only when its owner is exactly this Session.
 */
function startJobCollection(jobs: NativeJobs | undefined, sessionId: string): JobCollection | undefined {
  const events = jobs?.events
  if (jobs === undefined || events === undefined) return undefined
  const registry = jobs
  const collectors = new Map<string, JobCollector>()
  let selected: JobCollector | undefined
  let failure: string | undefined
  const onEvent = (raw: NativeJobEvent) => {
    let collector: JobCollector | undefined
    try {
      const event = raw as NativeJobEvent | null | undefined
      if (!event || typeof event !== 'object') return
      const id = event.type === 'output' ? event.id : event.job?.id
      const owner = event.type === 'output' ? event.owner : event.job?.owner
      if (typeof id !== 'string' || owner !== sessionId) return
      // After selection, other Job ids are ignored before any collector is
      // created: a later registration must never become a second collection.
      if (selected !== undefined && selected.id !== id) return
      collector = collectors.get(id)
      if (collector === undefined) {
        if (event.type !== 'registered') return
        collector = { id, cursor: 0, output: '' }
        collectors.set(id, collector)
      }
      if (event.type === 'registered' || event.type === 'output' || event.type === 'settled') drainJobOutput(registry, sessionId, collector)
    } catch (error) {
      if (collector !== undefined && collector.error === undefined) {
        collector.error = `native Job output collection failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
  let unsubscribe: (() => void) | undefined
  try {
    unsubscribe = events.subscribe({ owner: sessionId }, onEvent)
  } catch (error) {
    failure = `native Job output events could not be subscribed: ${error instanceof Error ? error.message : String(error)}`
  }
  return {
    take(id) {
      selected = collectors.get(id)
      for (const key of [...collectors.keys()]) if (key !== id) collectors.delete(key)
      return selected
    },
    failure: () => failure,
    dispose: () => { unsubscribe?.() },
  }
}

/** Confirm that a killed Job reached a terminal status, using the remaining budget. */
async function confirmTerminal(jobs: NativeJobs, jobId: string, sessionId: string, maxMs: number): Promise<NativeJobView | undefined> {
  const end = Date.now() + maxMs
  while (Date.now() <= end) {
    let view: NativeJobView | undefined
    try {
      view = jobs.get(jobId, sessionId)
    } catch {
      return undefined
    }
    if (!view || typeof view.status !== 'string') return undefined
    if (isTerminal(view.status)) return view
    try {
      view = await jobs.wait(jobId, Math.max(1, Math.min(end - Date.now(), 1000)), sessionId)
    } catch {
      view = undefined
    }
    if (view && isTerminal(view.status)) return view
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return undefined
}

export async function runCheck(options: {
  stateDir: string; contract: ActivationContract; checkId: string; outer: ToolExecution;
  tools: CheckTools; jobs?: NativeJobs; sessionCwd?: string; internal?: (id?: string) => void;
  /** A3: read operator resolutions. Defaults to the temporary host env switch; Lead wires the host config field here. */
  allowOperatorResolutions?: boolean;
  /** C4.5: maximum actual-run failures per check/contract before refusing to start (default 3). */
  retryLimit?: number;
}): Promise<CheckRunRecord> {
  const { contract, stateDir, outer } = options
  const check = verificationOf(contract).checks.find(c => c.id === options.checkId)
  if (!check) throw new Error('unknown checkId or missing frozen verification contract')
  const retryLimit = options.retryLimit ?? DEFAULT_RETRY_LIMIT
  if (!Number.isInteger(retryLimit) || retryLimit < 1) throw new Error(`retryLimit must be a positive integer, got ${String(options.retryLimit)}`)
  const old = await readRuns(stateDir, contract.ticketId)
  // A3: only an operator resolution for this exact ticket + contract may clear a
  // leftover running/unknown execution. The host plugin configuration is the only switch
  // (`apply(ctx, config)` passes it down); the process environment is never consulted, so
  // a Worker-inherited env var cannot enable resolutions. Disabled feature ignores the log
  // entirely; a corrupt resolution log throws and fails closed (the check stays blocked).
  const allowResolutions = options.allowOperatorResolutions === true
  const resolved = allowResolutions ? await resolvedRunIds(stateDir, contract.ticketId, contract.contractHash) : new Set<string>()
  if (old.some(r => (r.status === 'running' || r.status === 'unknown') && !resolved.has(r.runId))) throw new Error('unfinished/unsupported execution requires operator resolution; no automatic recovery')
  // C4.5: refuse to start once the derived failure count reaches the limit. Only the
  // operator retry-reset channel (same A3 switch/trust boundary) can clear the counter;
  // the refusal is logged as rule `check.retry-limit` (new rule number; decisions-format.md
  // registration is pending Lead because that file is outside this change's scope).
  const retryResets = allowResolutions ? await readRetryResets(stateDir, contract.ticketId, contract.contractHash) : []
  // A retry-reset only clears the counter of its own check (single check granularity).
  const retryFailures = retryFailureCount(old, check.id, contract.contractHash,
    retryResets.filter(record => record.checkId === check.id).map(record => record.at))
  if (retryFailures >= retryLimit) {
    const reason = `check ${check.id} reached the retry limit (${retryFailures}/${retryLimit} actual-run failures for this contract); ${RETRY_LIMIT_GUIDANCE}`
    await logDecision(stateDir, {
      ticketId: contract.ticketId,
      sessionId: String(outer.agent?.id ?? '') || undefined,
      callId: String(outer.callId),
      tool: 'hephi_check',
      mode: 'enforce',
      effectiveDecision: 'deny',
      wouldDecision: 'deny',
      rule: 'check.retry-limit',
      reason,
      contractHash: contract.contractHash,
    })
    throw new Error(reason)
  }
  const workspace = await resolveWorkspace(contract.workspace, options.sessionCwd)
  if (normalizeRepository(await remoteRepository(workspace)) !== normalizeRepository(contract.repository)
    || !await hasCommit(workspace, contract.baseSha) || !await clean(workspace)) throw new Error('repository/base/clean check failed')
  const before = await gitFingerprint(workspace, contract.baseSha)
  if (before.changedFiles.some(p => !inScope(contract, p))) throw new Error('changed path outside contract')
  const runId = randomUUID(), innerCallId = `hephi-${randomUUID()}`
  const dir = checkRunDir(stateDir, contract.ticketId, runId)
  await mkdir(dir, { recursive: true })
  const command = checkCommand(contract.baseSha, check.command, check.args)
  const record: CheckRunRecord = {
    version: 3, pluginCommit: pluginCommit(), runId, sequence: (old.at(-1)?.sequence ?? 0) + 1, ticketId: contract.ticketId,
    contractHash: contract.contractHash, checkId: check.id,
    sessionId: String(outer.agent?.id ?? ''), callId: outer.callId, innerCallId,
    argv: [check.command, ...check.args], cwd: check.cwd, startedAt: new Date().toISOString(),
    status: 'running', exitCode: null, before,
  }
  let cwd: string
  try {
    cwd = await contained(workspace, check.cwd)
  } catch (error) {
    // Nothing was launched, so this is a settled failure that may be retried after a fix.
    record.status = 'blocked'
    record.reason = `check not started: ${error instanceof Error ? error.message : String(error)}`
    record.finishedAt = new Date().toISOString()
    await saveRun(stateDir, record)
    return record
  }
  record.cwd = cwd
  await saveRun(stateDir, record)
  const collection = startJobCollection(options.jobs, record.sessionId)
  let terminal = false
  try {
    options.internal?.(innerCallId)
    // The contract deadline covers the whole native execution, including a Job
    // that the host promotes or starts in the background.
    const deadline = Date.now() + check.timeoutMs
    const result = await options.tools.execute({ name: 'bash', callId: innerCallId as never, parent: outer.token,
      rootCallId: outer.callId, agent: outer.agent, signal: outer.signal,
      arguments: { description: `HEPHI ${check.id}`, command, workdir: cwd, timeoutMs: check.timeoutMs } })
    const value = result.value as { kind?: string; jobId?: string; exitCode?: number; timedOut?: boolean; aborted?: boolean; signal?: string | null;
      stdout?: { text?: string }; stderr?: { text?: string } } | undefined
    if (result.isError) throw new Error('native bash execution returned an error')

    let output = ''
    let exitCode: number | null = null
    let jobFailure: string | undefined
    if (value?.kind === 'foreground') {
      if (!Number.isInteger(value.exitCode) || value.timedOut || value.aborted || value.signal != null) {
        throw new Error('only a confirmed foreground result is supported; background/cancel/unknown requires operator resolution')
      }
      terminal = true
      output = `${value.stdout?.text ?? ''}\n${value.stderr?.text ?? ''}`
      exitCode = value.exitCode!
    } else if (value?.kind === 'promoted' || value?.kind === 'background') {
      const jobId = value.jobId
      if (typeof jobId !== 'string' || !jobId) throw new Error(`native bash ${value.kind} result is missing its Job id`)
      // Persist the Job id before waiting, so a crash during settlement still
      // leaves the evidence needed to identify the native execution.
      record.jobId = jobId
      await saveRun(stateDir, record)
      const jobs = options.jobs
      if (!jobs) throw new Error('native bash returned a background Job but the host Job registry is unavailable')
      const sessionId = record.sessionId
      // The Job the native call really returned selects its own collector; every
      // other collector is dropped without touching its Job. A host without the
      // event surface keeps the original end-of-run read below.
      const collector = collection?.take(jobId)
      if (collector !== undefined) drainJobOutput(jobs, sessionId, collector)
      const uncollected = collection !== undefined && collector === undefined
        ? collection.failure() ?? `native Job ${jobId} was not observed in its Session's output events`
        : undefined
      let view: NativeJobView | undefined
      let timedOut = false
      let waitError: string | undefined
      while (true) {
        if (outer.signal.aborted) break
        if (uncollected !== undefined || collector?.error !== undefined) break
        const remaining = deadline - Date.now()
        if (remaining <= 0) { timedOut = true; break }
        try {
          const next = await jobs.wait(jobId, Math.min(remaining, JOB_WAIT_MS), sessionId, outer.signal)
          if (!next || typeof next.status !== 'string') throw new Error('native Job returned an unknown projection')
          if (isTerminal(next.status)) { view = next; break }
          if (next.status !== 'running' && next.status !== 'stopping' && next.status !== 'unknown') {
            throw new Error(`native Job returned unknown status: ${next.status}`)
          }
          // A single wait timeout is not contract completion: poll again until
          // the Job settles or the overall deadline expires.
        } catch (error) {
          if (!outer.signal.aborted) waitError = error instanceof Error ? error.message : String(error)
          break
        }
      }
      if (!view) {
        try {
          jobs.kill(jobId, sessionId, 'HEPHI check timeout or cancellation')
        } catch (error) {
          throw new Error(`native Job ${jobId} could not be stopped: ${error instanceof Error ? error.message : String(error)}`)
        }
        view = await confirmTerminal(jobs, jobId, sessionId, JOB_CONFIRM_MS)
        const stopReason = uncollected
          ?? (collector?.error !== undefined
            ? `native Job output collection failed: ${collector.error}`
            : timedOut
              ? `check exceeded its contract deadline of ${check.timeoutMs}ms`
              : waitError !== undefined ? `native Job wait failed: ${waitError}` : 'check was cancelled')
        if (!view) throw new Error(`native Job ${jobId} termination is unconfirmed after ${stopReason}`)
        terminal = true
        record.exitCode = null
        if (collector !== undefined) {
          // Only a complete collection may become the check output.
          drainJobOutput(jobs, sessionId, collector)
          if (collector.error === undefined) {
            await writeFile(join(dir, 'output.log'), collector.output)
            record.outputHash = sha256(collector.output)
          }
        } else if (collection === undefined) {
          try {
            const stoppedOutput = await readJobOutput(jobs, jobId, sessionId)
            await writeFile(join(dir, 'output.log'), stoppedOutput)
            record.outputHash = sha256(stoppedOutput)
          } catch {
            // A confirmed stopped Job is blocked even when its output is gone.
          }
        }
        throw new Error(stopReason)
      }
      terminal = true
      if (uncollected !== undefined) throw new Error(uncollected)
      if (collector !== undefined) {
        drainJobOutput(jobs, sessionId, collector)
        if (collector.error !== undefined) throw new Error(`native Job output collection failed: ${collector.error}`)
        output = collector.output
      } else {
        output = await readJobOutput(jobs, jobId, sessionId)
      }
      if (view.status === 'completed') {
        const code = jobExitCode(view.detail)
        if (code === undefined) jobFailure = `native Job detail is not the documented exit-code form: ${String(view.detail)}`
        else exitCode = code
      } else if (view.status === 'failed') {
        const code = jobExitCode(view.detail)
        if (code === undefined) jobFailure = `native Job failed without a parseable exit code: ${String(view.detail)}`
        else { exitCode = code; jobFailure = `native Job failed: ${view.detail}` }
      } else {
        jobFailure = `native Job ${view.status}: ${view.detail ?? 'no detail'}`
      }
    } else {
      throw new Error(`native bash returned unknown result kind: ${String(value?.kind)}`)
    }

    // One terminal path for foreground and Job results: persist the real
    // output and exit code before the existing source checks decide passing.
    await writeFile(join(dir, 'output.log'), output)
    record.outputHash = sha256(output)
    record.exitCode = exitCode
    if (jobFailure) throw new Error(jobFailure)
    if (exitCode === null) throw new Error('native execution did not report an exit code')
    if (exitCode !== 0) throw new Error(`check did not exit successfully: ${exitCode}`)
    record.after = await gitFingerprint(workspace, contract.baseSha)
    if (!await clean(workspace) || !sameSource(before, record.after)) throw new Error('source changed during check')
    record.status = 'passed'
  } catch (error) {
    record.status = terminal ? 'blocked' : 'unknown'
    record.reason = error instanceof Error ? error.message : String(error)
  } finally {
    collection?.dispose()
    options.internal?.()
    record.finishedAt = new Date().toISOString()
    await saveRun(stateDir, record)
  }
  return record
}
