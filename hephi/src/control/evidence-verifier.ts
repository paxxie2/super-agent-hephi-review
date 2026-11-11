import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { sessionBindingPolicy, verificationOf, type ActivationContract } from './activation.js'
import type { ReadyVerifier } from './ready-gate.js'
import { gitFingerprint, sha256 } from '../verification/fingerprint.js'
import { allowedPath, clean, defaultPullRequest, defaultPullRequestReviews, hasCommit, normalizeRepository, remoteRepository, type PullRequestInfo, type PullRequestReview } from './repository.js'
import { resolveWorkspace } from './workspace.js'
import { requireKnowledgeQuery } from '../kb/index.js'
import { checkRunDir, readRuns, resolvedRunIds, type CheckRunRecord } from './check-store.js'
import { checkCommand, contained, sameSource, type NativeJobView, type NativeJobs } from './check-runner.js'
import { checkDiscipline } from './discipline.js'
import { pluginCommit } from '../version.js'
import { logDecision } from './decision-log.js'
import { planWidthOf, readPlan } from './plan-store.js'
import type { SnapshotSealVerifier } from './snapshot-seal.js'

const exec = promisify(execFile)

/** T17: changed files in one commit range, NUL-separated so spaces/Unicode survive. */
async function diffFiles(workspace: string, from: string, to: string): Promise<string[]> {
  const { stdout } = await exec('git', ['diff', '--name-only', '-z', from, to, '--'], { cwd: workspace, maxBuffer: 20 * 1024 * 1024 })
  return stdout.split('\0').filter(Boolean)
}

/**
 * The host's Session snapshot, in the shape stage recovery already reads
 * (`sessionQuery.readSession`). Whether hephi_check's inner bash calls are
 * recorded there has not been verified on a real host.
 */
export type SessionSnapshot = {
  session: { id: string }
  inheritedEventCount: number
  events: Array<{ seq: number; type: string; data: any }>
}
export type SessionReader = (sessionId: string) => Promise<SessionSnapshot>

function argumentsOf(data: any): any {
  if (typeof data?.arguments !== 'string') return data?.arguments
  try { return JSON.parse(data.arguments) } catch { return undefined }
}

/**
 * Native bash result value carried by a Session `tool/result` message (path A).
 * FI-FIXME(H2): the host shape of this structured value (field name, exit-code form,
 * foreground/promoted kinds, truncation flags) has not been confirmed on a real host.
 */
type NativeResultValue = {
  kind?: string
  jobId?: string
  exitCode?: number
  timedOut?: boolean
  aborted?: boolean
  signal?: string | null
  stdout?: { text?: string; truncated?: boolean }
  stderr?: { text?: string; truncated?: boolean }
}

/**
 * `job/registered` / `job/settled` payload (path B, observed on historical real-host snapshots).
 * FI-FIXME(H1/H2/H3): the current candidate plugin has not been re-probed; `label` carrying the
 * shell command and the `arguments` fallback are assumptions to confirm on the host.
 */
type JobEventData = {
  jobId?: string
  owner?: string
  kind?: string
  name?: string
  label?: string
  command?: string
  arguments?: unknown
  toolCall?: { callId?: string; rootCallId?: string; name?: string; arguments?: unknown }
  status?: string
  detail?: string
}

/** Host `jobs.readAt` projection. Mirrored structurally because check-runner keeps its type private. */
type NativeJobReadView = { chunks: readonly { at: number; text: string }[]; lossy: boolean }

/**
 * Exit code in the documented host Job detail form (`exit code: <n>[; ...]`).
 * MUST stay byte-compatible with check-runner's private reader; H3 confirms the real format.
 */
function jobDetailExitCode(detail: string | undefined): number | undefined {
  if (detail === undefined) return undefined
  const match = /^exit code: (-?\d+)(?:;|$)/.exec(detail)
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : undefined
}

/** One record's native evidence, reconstructed from the Session snapshot only (never from run.json). */
type NativeEvidence = {
  /** The evidence is not bound to a genuine native execution, or the Job terminal state is wrong. */
  bindingProblem?: string
  /** The Job terminal state cannot be read at ready time (cleared, foreign Session, no registry). */
  jobUnavailable?: string
  /** A1-OUT: the authoritative output cannot be reconstructed (truncated, lossy, cleared, path B). */
  outputProblem?: string
  /** A1-OUT: authoritative output text when it can be reconstructed. */
  output?: string
  /** Non-fatal facts about the matched evidence (for example `workdir: absent` on path B). */
  notes?: string[]
}

const truncated = (part: { truncated?: boolean } | undefined): boolean => part?.truncated === true

function withNotes(evidence: NativeEvidence, notes: string[]): NativeEvidence {
  return notes.length ? { ...evidence, notes: [...(evidence.notes ?? []), ...notes] } : evidence
}

/**
 * A1-BIND path A: the structured shape. Exactly one bash `tool/call` for the recorded inner call
 * with the frozen command/directory, plus exactly one non-error `tool/result` carrying a
 * structured `message.value` with a `kind`.
 */
function checkStructuredPath(
  own: SessionSnapshot['events'], record: CheckRunRecord, expectedCommand: string, expectedCwd: string,
): { matched: boolean; problem?: string; value?: NativeResultValue } {
  const calls = own.filter(event => event.type === 'tool/call' && event.data?.callId === record.innerCallId)
  if (calls.length !== 1) return { matched: false, problem: `expected one native call ${record.innerCallId} in this Session, found ${calls.length}` }
  const call = calls[0].data
  if (call.name !== 'bash') return { matched: false, problem: `Session call ${record.innerCallId} is ${String(call.name)}, not bash` }
  const args = argumentsOf(call)
  // Exact string comparison: the shell command is never parsed or normalised.
  if (args?.command !== expectedCommand || args?.workdir !== expectedCwd) {
    return { matched: false, problem: `Session call ${record.innerCallId} ran a different command or directory` }
  }
  const results = own.filter(event => event.type === 'tool/result' && event.data?.message?.toolCallId === record.innerCallId)
  if (results.length !== 1) return { matched: false, problem: `expected one result for ${record.innerCallId} in this Session, found ${results.length}` }
  const message = results[0].data.message
  if (message.isError !== false) return { matched: false, problem: `Session result for ${record.innerCallId} is an error` }
  const value = message.value as NativeResultValue | undefined
  if (!value || typeof value !== 'object' || typeof value.kind !== 'string') {
    return { matched: false, problem: `Session result for ${record.innerCallId} carries no structured native value` }
  }
  return { matched: true, value }
}

/** A1-BIND path A branch: branch on the structured Session result kind, never on record.jobId. */
function structuredEvidence(value: NativeResultValue, record: CheckRunRecord, sessionId: string, jobs: NativeJobs | undefined): NativeEvidence {
  if (value.kind === 'foreground') {
    if (record.jobId !== undefined) return { bindingProblem: `${record.checkId}: foreground Session result but the record names a Job` }
    if (!Number.isInteger(value.exitCode)) return { bindingProblem: `${record.checkId}: foreground Session result has no exit code` }
    if (value.timedOut === true || value.aborted === true || value.signal != null) {
      return { bindingProblem: `${record.checkId}: foreground Session result was cancelled or timed out` }
    }
    if (value.exitCode !== record.exitCode) {
      return { bindingProblem: `${record.checkId}: Session result exit code ${String(value.exitCode)} differs from the record` }
    }
    if (value.exitCode !== 0) return { bindingProblem: `${record.checkId}: foreground Session result exit code ${String(value.exitCode)} does not confirm a successful check` }
    if (truncated(value.stdout) || truncated(value.stderr)) return { outputProblem: `${record.checkId}: foreground Session output was truncated` }
    // The runner persisted `${stdout.text}\n${stderr.text}`; mirror that form exactly.
    return { output: `${value.stdout?.text ?? ''}\n${value.stderr?.text ?? ''}` }
  }
  if (value.kind === 'promoted' || value.kind === 'background') {
    if (typeof record.jobId !== 'string' || record.jobId === '') {
      return { bindingProblem: `${record.checkId}: Session result is ${value.kind} but the record names no Job` }
    }
    if (value.jobId !== record.jobId) {
      return { bindingProblem: `${record.checkId}: Session result Job ${String(value.jobId)} differs from the recorded Job ${record.jobId}` }
    }
    return jobTerminalEvidence(record.jobId, sessionId, record, jobs)
  }
  return { bindingProblem: `${record.checkId}: unsupported Session result kind ${value.kind}` }
}

/** Shared Job checks: the recorded Job must be readable for this Session, completed, exit 0, output readable. */
function jobTerminalEvidence(jobId: string, sessionId: string, record: CheckRunRecord, jobs: NativeJobs | undefined): NativeEvidence {
  if (!jobs) return { jobUnavailable: `${record.checkId}: Job terminal state is unavailable (host Job registry is not mounted)` }
  let view: NativeJobView | undefined
  try { view = jobs.get(jobId, sessionId) } catch { view = undefined }
  if (!view || typeof view.status !== 'string') {
    return { jobUnavailable: `${record.checkId}: Job terminal state is unavailable (Job ${jobId} is cleared or belongs to another Session)` }
  }
  if (view.status !== 'completed') return { bindingProblem: `${record.checkId}: Job ${jobId} terminal status is ${view.status}` }
  const code = jobDetailExitCode(view.detail)
  if (code === undefined) return { bindingProblem: `${record.checkId}: Job ${jobId} detail is not the documented exit-code form` }
  if (code !== 0 || record.exitCode !== 0) {
    return { bindingProblem: `${record.checkId}: Job ${jobId} exit code ${code} does not confirm a successful check` }
  }
  let read: NativeJobReadView | undefined
  try { read = jobs.readAt(jobId, 0, sessionId) as NativeJobReadView } catch { read = undefined }
  if (!read || !Array.isArray(read.chunks) || typeof read.lossy !== 'boolean'
    || read.chunks.some(chunk => !chunk || typeof chunk.at !== 'number' || typeof chunk.text !== 'string')) {
    return { outputProblem: `${record.checkId}: Job ${jobId} output is not readable` }
  }
  if (read.lossy) return { outputProblem: `${record.checkId}: Job ${jobId} output was lost (lossy)` }
  return { output: read.chunks.map(chunk => chunk.text).join('') }
}

/**
 * A1-BIND path B: the historical real-host shape. The internal dispatch leaves one
 * `job/registered` (toolCall.callId = innerCallId, rootCallId = outer callId) and one
 * `job/settled` (status/detail carrying the textual exit code) but no `tool/call`/`tool/result`
 * for the inner call and no structured `message.value`.
 *
 * Path B can only attest a Job terminal. When the record is not a Job record (no `jobId`, i.e. a
 * foreground check on that host) there is no structured foreground output A1-OUT can trust, so
 * the verifier denies it as output-unverified instead of guessing from text.
 */
function jobEventCommand(data: JobEventData): { command?: string; workdir?: string } {
  const raw = data.arguments ?? data.toolCall?.arguments
  if (raw !== undefined) {
    let parsed: unknown = raw
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw) } catch { parsed = undefined }
    }
    const args = parsed as { command?: unknown; workdir?: unknown } | undefined
    if (args && typeof args.command === 'string') {
      return { command: args.command, workdir: typeof args.workdir === 'string' ? args.workdir : undefined }
    }
  }
  // The probe fixture and historical snapshots expose the shell command as the Job label.
  if (typeof data.label === 'string') return { command: data.label }
  if (typeof data.command === 'string') return { command: data.command }
  return {}
}

function jobEventEvidence(
  own: SessionSnapshot['events'], sessionId: string, record: CheckRunRecord,
  expectedCommand: string, expectedCwd: string, jobs: NativeJobs | undefined,
): NativeEvidence {
  const registered = own.filter(event => event.type === 'job/registered' && event.data?.toolCall?.callId === record.innerCallId)
  if (registered.length !== 1) return { bindingProblem: `${record.checkId}: expected one job/registered for ${record.innerCallId} in this Session, found ${registered.length}` }
  const settled = own.filter(event => event.type === 'job/settled' && event.data?.toolCall?.callId === record.innerCallId)
  if (settled.length !== 1) return { bindingProblem: `${record.checkId}: expected one job/settled for ${record.innerCallId} in this Session, found ${settled.length}` }
  const start = registered[0].data as JobEventData
  const done = settled[0].data as JobEventData
  if (start.toolCall?.rootCallId !== record.callId) {
    return { bindingProblem: `${record.checkId}: job/registered for ${record.innerCallId} belongs to another root call` }
  }
  const isBash = start.kind === 'bash' || start.name === 'bash' || start.toolCall?.name === 'bash'
  if (!isBash) return { bindingProblem: `${record.checkId}: job/registered for ${record.innerCallId} is not a bash execution` }
  const command = jobEventCommand(start)
  // Historical bash calls carry no workdir (the command runs in the Session cwd). Accepting that
  // is a documented weakening: record the fact instead of pretending the directory matched.
  const notes = command.workdir === undefined ? ['workdir: absent'] : []
  if (command.command === undefined) return withNotes({ bindingProblem: `${record.checkId}: job/registered for ${record.innerCallId} carries no parseable command` }, notes)
  if (command.command !== expectedCommand) return withNotes({ bindingProblem: `${record.checkId}: Session Job for ${record.innerCallId} ran a different command` }, notes)
  if (command.workdir !== undefined && command.workdir !== expectedCwd) {
    return withNotes({ bindingProblem: `${record.checkId}: Session Job for ${record.innerCallId} ran in a different directory` }, notes)
  }
  const owner = typeof start.owner === 'string' ? start.owner : (typeof done.owner === 'string' ? done.owner : undefined)
  if (owner !== undefined && owner !== sessionId) return withNotes({ bindingProblem: `${record.checkId}: job event for ${record.innerCallId} belongs to another Session` }, notes)
  const startJobId = typeof start.jobId === 'string' ? start.jobId : undefined
  const doneJobId = typeof done.jobId === 'string' ? done.jobId : undefined
  if (startJobId !== undefined && doneJobId !== undefined && startJobId !== doneJobId) {
    return withNotes({ bindingProblem: `${record.checkId}: job/registered and job/settled disagree on the Job id` }, notes)
  }
  const eventJobId = startJobId ?? doneJobId
  if (record.jobId !== undefined) {
    if (eventJobId === undefined) return withNotes({ bindingProblem: `${record.checkId}: Job events carry no Job id to match the record` }, notes)
    if (eventJobId !== record.jobId) return withNotes({ bindingProblem: `${record.checkId}: Session Job ${eventJobId} differs from the recorded Job ${record.jobId}` }, notes)
  }
  if (done.status !== 'completed') return withNotes({ bindingProblem: `${record.checkId}: Job terminal status is ${String(done.status)}` }, notes)
  const code = jobDetailExitCode(typeof done.detail === 'string' ? done.detail : undefined)
  if (code === undefined) return withNotes({ bindingProblem: `${record.checkId}: Job detail is not the documented exit-code form` }, notes)
  if (code !== record.exitCode) return withNotes({ bindingProblem: `${record.checkId}: Session result exit code ${code} differs from the record` }, notes)
  if (code !== 0) return withNotes({ bindingProblem: `${record.checkId}: Job exit code ${code} does not confirm a successful check` }, notes)
  if (record.jobId === undefined) {
    // Foreground record on a real host that only leaves Job events: no structured stdout/stderr.
    return withNotes({ outputProblem: `${record.checkId}: job/registered+job/settled evidence carries no structured foreground output and the record names no Job` }, notes)
  }
  return withNotes(jobTerminalEvidence(record.jobId, sessionId, record, jobs), notes)
}

/**
 * A1-BIND: reconstruct the native execution from the Session snapshot, using the contract's
 * frozen check definition (command, args, cwd) and one of two mutually exclusive Session shapes:
 * path A (structured `tool/call` + `tool/result.message.value`) or path B (historical real-host
 * `job/registered` + `job/settled` textual exit code). A1-OUT: return the authoritative output.
 *
 * FI-FIXME(H1-H5): the exact host encodings are pending the host probes:
 * H1 (tool/call or Job arguments string and workdir), H2 (structured result value / exit-code
 * form), H3 (Job registered/settled shape, terminal view, detail exit-code format), H3a
 * (jobs.readAt chunks and `lossy`), H5 (inherited event count). Fixture-tested only until then.
 */
async function analyzeNativeEvidence(
  snapshot: SessionSnapshot, sessionId: string, contract: ActivationContract, record: CheckRunRecord,
  stateDir: string, workspace: string, jobs: NativeJobs | undefined,
): Promise<NativeEvidence> {
  if (snapshot.session?.id !== sessionId) return { bindingProblem: 'Session snapshot belongs to a different Session' }
  const own = snapshot.events.filter(event => event.seq >= snapshot.inheritedEventCount)
  // The expected command and directory come from the frozen contract, not from the record's argv/cwd.
  const definition = verificationOf(contract).checks.find(check => check.id === record.checkId)
  if (!definition) return { bindingProblem: `${record.checkId}: no frozen check definition in the contract` }
  let expectedCommand: string
  let expectedCwd: string
  try {
    expectedCommand = checkCommand(contract.baseSha, definition.command, definition.args, checkRunDir(stateDir, contract.ticketId, record.runId))
    expectedCwd = await contained(workspace, definition.cwd)
  } catch (error) {
    return { bindingProblem: `${record.checkId}: cannot resolve the frozen check command or directory: ${error instanceof Error ? error.message : String(error)}` }
  }
  const jobEventsPresent = own.some(event => (event.type === 'job/registered' || event.type === 'job/settled')
    && event.data?.toolCall?.callId === record.innerCallId)
  const structured = checkStructuredPath(own, record, expectedCommand, expectedCwd)
  if (structured.matched && jobEventsPresent) {
    return { bindingProblem: `${record.checkId}: both structured tool/result evidence and job/registered+job/settled evidence are present for ${record.innerCallId}; refusing to choose a shape` }
  }
  if (structured.matched) return structuredEvidence(structured.value!, record, sessionId, jobs)
  if (jobEventsPresent) return jobEventEvidence(own, sessionId, record, expectedCommand, expectedCwd, jobs)
  return { bindingProblem: `${record.checkId}: no native evidence for ${record.innerCallId} in this Session (structured path: ${structured.problem ?? 'unmatched'}; job events: none present)` }
}

/**
 * A record is bound only to this Session's own bash call matching the frozen check, with a
 * successful Session result (structured foreground exit 0, a completed Job exit 0 via the
 * structured value, or a completed Job reported by job/registered+job/settled).
 * Returns the first binding problem, if any; Job-unavailable and output problems are covered
 * by `analyzeNativeEvidence` for the verifier's A1-OUT pass.
 */
export async function sessionBindingProblem(
  snapshot: SessionSnapshot, sessionId: string, contract: ActivationContract, record: CheckRunRecord,
  context: { stateDir: string; workspace: string; jobs?: NativeJobs },
): Promise<string | undefined> {
  const evidence = await analyzeNativeEvidence(snapshot, sessionId, contract, record, context.stateDir, context.workspace, context.jobs)
  return evidence.bindingProblem ?? evidence.jobUnavailable
}

/**
 * Evidence must match the frozen check definition even when Session binding is off:
 * a record for another command or another directory is not evidence for this check.
 */
async function frozenCheckProblem(contract: ActivationContract, record: CheckRunRecord, workspace: string): Promise<string | undefined> {
  const definition = verificationOf(contract).checks.find(check => check.id === record.checkId)
  if (!definition) return `${record.checkId}: no frozen check definition in the contract`
  const expected = [definition.command, ...definition.args]
  if (record.argv.length !== expected.length || record.argv.some((value, index) => value !== expected[index])) {
    return `${record.checkId}: recorded argv differs from the frozen check`
  }
  if (record.cwd !== await contained(workspace, definition.cwd)) {
    return `${record.checkId}: recorded working directory differs from the frozen check`
  }
  return undefined
}

const normalizeLogin = (value: string) => value.trim().toLowerCase()

/**
 * C3 approval rules (ROADMAP-95 §4.10): only the latest review of each listed approver
 * counts; a listed approver's latest CHANGES_REQUESTED blocks even when others approve;
 * an APPROVED review must target the current PR HEAD commit. Reviews are consumed in host
 * order (GitHub returns them chronologically), so the map keeps the last one per author.
 * Awaiting approval is a wait state, not a failed check: C4.5 counts check-run failures
 * only (check records / retry counters), so this denial never consumes a retry.
 */
function approvalProblem(info: PullRequestInfo, approvers: string[], headCommit: string | undefined): string | undefined {
  const reviews = info.reviews
  if (!Array.isArray(reviews)) return 'PR reviews are unavailable; cannot verify the configured approvers'
  const latest = new Map<string, PullRequestReview>()
  for (const review of reviews) {
    if (!review || typeof review.author !== 'string' || typeof review.state !== 'string') return 'PR reviews are malformed; cannot verify the configured approvers'
    latest.set(normalizeLogin(review.author), review)
  }
  const blocked = approvers.filter(approver => latest.get(normalizeLogin(approver))?.state === 'CHANGES_REQUESTED')
  if (blocked.length > 0) return `changes requested by ${blocked.join(', ')}; waiting for review resolution (not a failed check)`
  const approved = approvers.some(approver => {
    const review = latest.get(normalizeLogin(approver))
    return review?.state === 'APPROVED' && review.commitId !== undefined && headCommit !== undefined && review.commitId === headCommit
  })
  if (!approved) return 'no listed approver approved the current PR HEAD; waiting for approval (not a failed check)'
  return undefined
}

const samplePlanFiles = (items: string[]) => items.slice(0, 10).join(', ') + (items.length > 10 ? ` (+${items.length - 10} more)` : '')

/**
 * H6=C: a used record must carry a seal that still matches the persisted Session log.
 * Returns the `ready.snapshot-tampered` denial reason, or undefined when the record is
 * verifiable (or the host adapter is not wired, which keeps the legacy behavior).
 */
export async function snapshotSealProblem(record: CheckRunRecord, input: {
  verifier?: SnapshotSealVerifier
  sessionId: string
  sessionCwd?: string
}): Promise<string | undefined> {
  if (!input.verifier) return undefined
  if (record.snapshotSealUnavailable !== undefined) {
    return `ready.snapshot-tampered: ${record.checkId}: the check could not seal the Session snapshot (${record.snapshotSealUnavailable})`
  }
  if (record.snapshotSeal === undefined) {
    return `ready.snapshot-tampered: ${record.checkId}: the check record has no sealed Session snapshot digest; rerun the check with this plugin build`
  }
  const result = await input.verifier({ sessionId: input.sessionId, sessionCwd: input.sessionCwd, seal: record.snapshotSeal })
  if (!result.ok) return `ready.snapshot-tampered: ${record.checkId}: ${result.problem}`
  return undefined
}

export function createEvidenceVerifier(options: {
  stateDir: string
  pullRequest?: (repo: string, n: number) => Promise<PullRequestInfo>
  readSession?: SessionReader
  /**
   * Host configuration only (cordis.patch.yml / environment). The effective requirement is
   * this OR the contract's frozen `evidence.requireSessionBinding`: host config can tighten
   * the contract but never relax it (A1-K5). Contracts written before version 3 have no
   * frozen value, so for them this is the only source.
   */
  requireSessionBinding?: boolean
  /**
   * A3: operator resolutions for unfinished (`running`/`unknown`) runs. Disabled unless the
   * host operator enables it (A3 trust boundary); a resolution only restores the right to
   * re-run the check — it never turns the old execution into passing evidence.
   */
  allowOperatorResolutions?: boolean
  /**
   * Host `ctx.jobs` registry, used by A1-BIND to confirm a background check's terminal state
   * and by A1-OUT to read its authoritative output. Missing registry means background
   * evidence cannot be verified (ready denies) rather than silently trusting the record.
   */
  jobs?: NativeJobs
  /**
   * H6=C detect-only: host adapter that re-reads the persisted Session log and checks
   * the seal recorded at check completion. Absent = unwired host; the seal fields are
   * then not written by the runner either, so ready keeps its previous behavior.
   */
  sealSnapshotVerifier?: SnapshotSealVerifier
}): ReadyVerifier {
  if (options.requireSessionBinding && !options.readSession) throw new Error('Session binding requires a Session reader')
  const verify = async (contract: ActivationContract, execution: Parameters<ReadyVerifier>[1]): ReturnType<ReadyVerifier> => {
    try {
      const binding = sessionBindingPolicy(contract, options.requireSessionBinding === true)
      const verification = verificationOf(contract)
      await requireKnowledgeQuery(contract, options.stateDir)
      const workspace = await resolveWorkspace(contract.workspace, execution.agent?.session.header.cwd)
      if (normalizeRepository(await remoteRepository(workspace)) !== normalizeRepository(contract.repository)
        || !await hasCommit(workspace, contract.baseSha) || !await clean(workspace)) throw new Error('repository/base/clean check failed')
      const before = await gitFingerprint(workspace, contract.baseSha)
      if (!before.changedFiles.length) throw new Error('missing patch or path outside contract')
      await checkDiscipline(contract, workspace)
      if (contract.plugin !== undefined && contract.plugin.commit !== pluginCommit()) {
        throw new Error(`contract was prepared by another plugin build (${contract.plugin.commit}); rerun prepare with ${pluginCommit()}`)
      }
      const records = await readRuns(options.stateDir, contract.ticketId)
      // Host plugin config only; the process environment is never an enable channel (A3 trust boundary).
      const allowResolutions = options.allowOperatorResolutions === true
      const resolved = allowResolutions
        ? await resolvedRunIds(options.stateDir, contract.ticketId, contract.contractHash)
        : new Set<string>()
      if (records.some(r => (r.status === 'unknown' || r.status === 'running') && !resolved.has(r.runId))) {
        throw new Error('unfinished/unsupported check execution; operator resolution required')
      }
      // Required checks plus every check an acceptance item names, each verified once.
      const needed = new Set(verification.checks.filter(c => c.required).map(c => c.id))
      for (const item of contract.task?.acceptance ?? []) needed.add(item.check)
      const used: CheckRunRecord[] = []
      for (const id of needed) {
        // T17: green evidence is the latest ordinary run for this check; red runs are
        // never green evidence even when they are the most recent record.
        const r = records.filter(record => record.checkId === id && record.phase !== 'red').at(-1)
        if (!r || r.status !== 'passed' || r.exitCode !== 0 || r.contractHash !== contract.contractHash
          || !r.sessionId || !r.callId || !r.innerCallId || !r.finishedAt
          || !sameSource(r.before, before) || !sameSource(r.after, before)) throw new Error(`missing, failed or stale evidence: ${id}`)
        if (sha256(await readFile(join(checkRunDir(options.stateDir, contract.ticketId, r.runId), 'output.log'))) !== r.outputHash) throw new Error('output hash mismatch')
        const frozen = await frozenCheckProblem(contract, r, workspace)
        if (frozen) throw new Error(`evidence does not match the frozen check: ${frozen}`)
        if (r.pluginCommit !== pluginCommit()) throw new Error(`check evidence was produced by another plugin build (${r.pluginCommit}); rerun checks with ${pluginCommit()}`)
        used.push(r)
      }
      // T17: red-before-green gate. Only version 3 `code` task cards carry it; version 1/2
      // cards and `refactor`/`doc` kinds keep the historical green-only behavior unchanged.
      const taskCard = contract.task
      if (taskCard?.version === 3 && taskCard.kind === 'code') {
        const red = records.filter(record => record.phase === 'red').at(-1)
        if (red === undefined) {
          throw new Error('ready.red-missing: this code task has no red-phase check run; run hephi_check with phase="red" on the failing acceptance checks before implementing')
        }
        const redUsable = red.contractHash === contract.contractHash && red.status === 'blocked'
          && Number.isInteger(red.exitCode) && red.exitCode !== 0
          && red.after !== undefined && sameSource(red.before, red.after)
        if (!redUsable) {
          throw new Error('ready.red-missing: the latest red-phase check run is not red evidence (it must fail with a non-zero exit code without changing the source tree); rerun hephi_check with phase="red"')
        }
        const redCommit = red.before.headCommit
        if (redCommit === undefined) {
          throw new Error('ready.red-missing: the latest red-phase check record has no commit identity; rerun hephi_check with phase="red"')
        }
        const testFiles = [...new Set(taskCard.acceptance.flatMap(item => item.tests ?? []))]
        // (a) the red commit may only contain the acceptance tests; implementation code in
        // it means the "red" state was not actually failing before the implementation.
        const redFiles = await diffFiles(workspace, contract.baseSha, redCommit)
        const outsideTests = redFiles.filter(file => !allowedPath(file, testFiles))
        if (outsideTests.length > 0) {
          throw new Error(`ready.red-impl-files: the red commit changes files outside the acceptance tests: ${outsideTests.join(', ')}; the red phase must only introduce the failing acceptance tests`)
        }
        // (b) the acceptance tests must not move after the red run, or the red evidence no
        // longer covers the tests the green state is judged by.
        const changedSinceRed = await diffFiles(workspace, redCommit, 'HEAD')
        const testsChanged = changedSinceRed.filter(file => allowedPath(file, testFiles))
        if (testsChanged.length > 0) {
          throw new Error(`ready.red-tests-changed: acceptance tests changed after the red run: ${testsChanged.join(', ')}; re-run hephi_check with phase="red" on the current tests`)
        }
      }
      // A1-K4: the evidence must name this Worker Session, not merely a non-empty id.
      // This runs regardless of the binding switch (the defect was that the binding-off
      // path had no such constraint); a ready report without a Session id fails closed
      // because ownership cannot be proven. Which host id ends up in check records is
      // still pending the H4 host probe.
      const reportSessionId = execution.agent?.session.header.id
      const sessionId = reportSessionId === undefined || reportSessionId === null || reportSessionId === ''
        ? undefined
        : String(reportSessionId)
      if (sessionId === undefined) throw new Error('ready report has no Worker Session; evidence cannot be bound')
      for (const r of used) {
        if (r.sessionId !== sessionId) {
          throw new Error(`evidence is not bound to a native execution: ${r.checkId}: check record belongs to Session "${r.sessionId}" but the current Worker Session is "${sessionId}"`)
        }
      }
      if (binding.effective) {
        if (!options.readSession) throw new Error('Session binding requires a Session reader')
        // The Session snapshot carries the native call/result evidence; reading it after
        // the ownership check keeps a missing sessionQuery from masking a foreign record.
        const snapshot = await options.readSession(sessionId)
        for (const r of used) {
          // H6=C: the persisted log prefix sealed at check completion must still match.
          const sealProblem = await snapshotSealProblem(r, {
            verifier: options.sealSnapshotVerifier,
            sessionId,
            sessionCwd: execution.agent?.session.header.cwd,
          })
          if (sealProblem) throw new Error(sealProblem)
          const evidence = await analyzeNativeEvidence(snapshot, sessionId, contract, r, options.stateDir, workspace, options.jobs)
          // Non-fatal shape facts (for example `workdir: absent` on the job-event path) are kept
          // in the denial reason so the operator can see what could not be compared.
          const notes = evidence.notes && evidence.notes.length > 0 ? ` (${evidence.notes.join('; ')})` : ''
          if (evidence.jobUnavailable) throw new Error(`evidence is not bound to a native execution: ${evidence.jobUnavailable}${notes}`)
          if (evidence.bindingProblem) throw new Error(`evidence is not bound to a native execution: ${evidence.bindingProblem}${notes}`)
          // A1-OUT: the record's output hash must also match the authoritative Session/Job
          // output. Unavailable authoritative output is a denial, never a silent downgrade.
          if (evidence.outputProblem) throw new Error(`authoritative check output is unavailable: ${evidence.outputProblem}${notes}`)
          if (evidence.output === undefined) throw new Error(`authoritative check output is unavailable: ${r.checkId}: no native output${notes}`)
          if (sha256(evidence.output) !== r.outputHash) throw new Error(`authoritative check output differs from the record: ${r.checkId}${notes}`)
        }
      }
      // C3: approvals are verified against the PR reviews; the same PR must be open and
      // point at the local HEAD. A contract with approvers therefore needs a PR number
      // even if `requirePullRequest` is false.
      const approvers = verification.approvers ?? []
      let pullRequest: PullRequestInfo | undefined
      if (contract.requirePullRequest || approvers.length > 0) {
        const number = (execution.arguments as { pr_number?: number }).pr_number
        if (!Number.isInteger(number) || number! <= 0) {
          if (approvers.length > 0) {
            throw new Error('ready.awaiting-approval: approvers are configured; pr_number is required to verify approval (waiting for approval, not a failed check)')
          }
          throw new Error('pr_number required')
        }
        const cli = join(options.stateDir, 'worker-bin', 'gh')
        // Only approval-enabled contracts pay for the extra reviews API call; without
        // approvers the legacy PR check behavior is byte-for-byte unchanged. An injected
        // `pullRequest` fixture supplies `reviews` directly (tests never use the network).
        const fetch = options.pullRequest ?? (approvers.length > 0
          ? async (repo: string, n: number) => ({
            ...await defaultPullRequest(repo, n, cli),
            reviews: await defaultPullRequestReviews(repo, n, cli),
          })
          : (repo: string, n: number) => defaultPullRequest(repo, n, cli))
        pullRequest = await fetch(contract.repository, number!)
        if (pullRequest.state !== 'open' || pullRequest.baseRef !== contract.baseRef || pullRequest.headSha !== before.headCommit) throw new Error('PR/base/HEAD mismatch')
      }
      if (approvers.length > 0) {
        const problem = approvalProblem(pullRequest!, approvers, before.headCommit)
        if (problem) throw new Error(`ready.awaiting-approval: ${problem}`)
      }
      if (!await clean(workspace) || !sameSource(before, await gitFingerprint(workspace, contract.baseSha))) throw new Error('source changed during ready')
      // C4.2: the FINAL diff is compared with the plan declared for this exact contract hash.
      // Default (verification.requirePlan unset/false) keeps C4.2 OPTIONAL: no plan means no
      // plan check (documented limitation, not an active interception). With requirePlan=true
      // the contract is fail-closed: ready without a current-contract plan is denied.
      const plan = await readPlan(options.stateDir, contract.ticketId, contract.contractHash)
      if (plan === undefined) {
        if (verification.requirePlan === true) {
          throw new Error('plan.not-declared: HEPHI requirePlan is enabled for this contract but no plan exists; call hephi_plan before reporting ready')
        }
      } else {
        const outsidePlan = before.changedFiles.filter(file => !allowedPath(file, plan.files))
        if (outsidePlan.length > 0) {
          throw new Error(`plan.outside-plan: changed files outside the declared plan: ${samplePlanFiles(outsidePlan)}`)
        }
        // v5.4 §2 ② (record-only): plan width is written as its own allow audit row so P3
        // can report plan coverage. It is not part of this verification's result, and a
        // log failure is swallowed by logDecision, so no ready verdict can change here.
        const width = planWidthOf(plan.files.length, before.changedFiles.length)
        await logDecision(options.stateDir, {
          ticketId: contract.ticketId,
          sessionId,
          callId: String(execution.callId),
          tool: 'orchestrator_report',
          mode: 'enforce',
          effectiveDecision: 'allow',
          wouldDecision: 'allow',
          rule: 'plan.width',
          reason: `plan covers ${width.planFiles} files; final diff changes ${width.changedFiles} files (ratio ${width.ratio})`,
          contractHash: contract.contractHash,
          planFiles: width.planFiles,
          changedFiles: width.changedFiles,
          ratio: width.ratio,
        })
      }
      return { ok: true }
    } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e) } }
  }
  return async (contract, execution) => {
    const result = await verify(contract, execution)
    const rule = result.ok ? 'ready.pass' : readyRule(result.reason)
    const sessionId = execution.agent?.session.header.id
    // A1-K5b: every ready decision records the policy actually in force (contract + host + effective).
    const binding = sessionBindingPolicy(contract, options.requireSessionBinding === true)
    await logDecision(options.stateDir, {
      ticketId: contract.ticketId,
      sessionId: sessionId === undefined || sessionId === null ? undefined : String(sessionId),
      callId: String(execution.callId),
      tool: 'orchestrator_report',
      mode: 'enforce',
      effectiveDecision: result.ok ? 'allow' : 'deny',
      wouldDecision: result.ok ? 'allow' : 'deny',
      rule,
      reason: result.ok ? undefined : result.reason,
      contractHash: contract.contractHash,
      binding,
    })
    return result
  }
}

/** Stable rule ids for ready denials; P3 aggregates by rule. */
export function readyRule(reason: string): string {
  // T14/AT-43: a GitHub rate-limit failure is environment unavailability, not a failed
  // check; give it its own rule so P3 does not count it as an evidence/check failure.
  if (/rate limit|API rate limit exceeded/i.test(reason)) return 'ready.github-unavailable'
  // C3: waiting for a human approval is its own denial class (a wait state, not a failed check).
  if (reason.includes('ready.snapshot-tampered')) return 'ready.snapshot-tampered'
  if (reason.includes('ready.awaiting-approval')) return 'ready.awaiting-approval'
  // A1-BIND/A1-OUT: an unreadable Job terminal state or unverifiable output is not a
  // generic binding mismatch; keep them distinguishable for P3 aggregation.
  if (reason.includes('Job terminal state is unavailable')) return 'ready.job-unavailable'
  if (reason.includes('authoritative check output is unavailable') || reason.includes('authoritative check output differs')) return 'ready.output-unverified'
  if (reason.includes('not bound to a native execution')) return 'ready.binding'
  if (reason.includes('PR/base/HEAD mismatch')) return 'ready.pr-mismatch'
  // T17: the red-before-green gate has its own denial classes for P3 aggregation.
  if (reason.includes('ready.red-missing')) return 'ready.red-missing'
  if (reason.includes('ready.red-impl-files')) return 'ready.red-impl-files'
  if (reason.includes('ready.red-tests-changed')) return 'ready.red-tests-changed'
  if (reason.includes('missing, failed or stale evidence')) return 'ready.evidence-missing'
  if (reason.includes('contract was prepared by another plugin build')) return 'ready.plugin-build'
  // C4.2: plan denials are their own denial classes (owner can see why).
  if (reason.includes('plan.not-declared')) return 'plan.not-declared'
  if (reason.includes('plan.outside-plan')) return 'plan.outside-plan'
  return 'ready.other'
}
