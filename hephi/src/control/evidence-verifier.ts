import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { verificationOf, type ActivationContract } from './activation.js'
import type { ReadyVerifier } from './ready-gate.js'
import { gitFingerprint, sha256 } from '../verification/fingerprint.js'
import { clean, defaultPullRequest, hasCommit, normalizeRepository, remoteRepository, type PullRequestInfo } from './repository.js'
import { resolveWorkspace } from './workspace.js'
import { requireKnowledgeQuery } from '../kb/index.js'
import { checkRunDir, readRuns, type CheckRunRecord } from './check-store.js'
import { checkCommand, sameSource } from './check-runner.js'
import { checkDiscipline } from './discipline.js'

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

/** Exit code reported in a bash tool result, when the result carries one. */
function resultExitCode(message: any): number | undefined {
  for (const part of message?.content ?? []) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue
    try {
      const value = JSON.parse(part.text)
      if (Number.isInteger(value?.exitCode)) return value.exitCode
    } catch { /* not a JSON result */ }
  }
  return undefined
}

/** A record is bound only to this Session's own bash call with the same command, directory and a successful result. */
export function sessionBindingProblem(snapshot: SessionSnapshot, sessionId: string, contract: ActivationContract, record: CheckRunRecord): string | undefined {
  if (snapshot.session?.id !== sessionId) return 'Session snapshot belongs to a different Session'
  const own = snapshot.events.filter(event => event.seq >= snapshot.inheritedEventCount)
  const calls = own.filter(event => event.type === 'tool/call' && event.data?.callId === record.innerCallId)
  if (calls.length !== 1) return `${record.checkId}: expected one native call ${record.innerCallId} in this Session, found ${calls.length}`
  const call = calls[0].data
  const args = argumentsOf(call)
  if (call.name !== 'bash') return `${record.checkId}: Session call ${record.innerCallId} is ${String(call.name)}, not bash`
  const [command, ...rest] = record.argv
  if (args?.command !== checkCommand(contract.baseSha, command, rest) || args?.workdir !== record.cwd) return `${record.checkId}: Session call ${record.innerCallId} ran a different command or directory`
  const results = own.filter(event => event.type === 'tool/result' && event.data?.message?.toolCallId === record.innerCallId)
  if (results.length !== 1) return `${record.checkId}: expected one result for ${record.innerCallId} in this Session, found ${results.length}`
  const message = results[0].data.message
  if (message.isError !== false) return `${record.checkId}: Session result for ${record.innerCallId} is an error`
  const exitCode = resultExitCode(message)
  if (exitCode !== undefined && exitCode !== record.exitCode) return `${record.checkId}: Session result exit code ${exitCode} differs from the record`
  return undefined
}

export function createEvidenceVerifier(options: {
  stateDir: string
  pullRequest?: (repo: string, n: number) => Promise<PullRequestInfo>
  readSession?: SessionReader
  requireSessionBinding?: boolean
}): ReadyVerifier {
  if (options.requireSessionBinding && !options.readSession) throw new Error('Session binding requires a Session reader')
  return async (contract, execution) => {
    try {
      const verification = verificationOf(contract)
      await requireKnowledgeQuery(contract, options.stateDir)
      const workspace = await resolveWorkspace(contract.workspace, execution.agent?.session.header.cwd)
      if (normalizeRepository(await remoteRepository(workspace)) !== normalizeRepository(contract.repository)
        || !await hasCommit(workspace, contract.baseSha) || !await clean(workspace)) throw new Error('repository/base/clean check failed')
      const before = await gitFingerprint(workspace, contract.baseSha)
      if (!before.changedFiles.length) throw new Error('missing patch or path outside contract')
      await checkDiscipline(contract, workspace)
      const records = await readRuns(options.stateDir, contract.ticketId)
      if (records.some(r => r.status === 'unknown' || r.status === 'running')) throw new Error('unfinished/unsupported check execution; operator resolution required')
      // Required checks plus every check an acceptance item names, each verified once.
      const needed = new Set(verification.checks.filter(c => c.required).map(c => c.id))
      for (const item of contract.task?.acceptance ?? []) needed.add(item.check)
      const used: CheckRunRecord[] = []
      for (const id of needed) {
        const r = records.filter(r => r.checkId === id).at(-1)
        if (!r || r.status !== 'passed' || r.exitCode !== 0 || r.contractHash !== contract.contractHash
          || !r.sessionId || !r.callId || !r.innerCallId || !r.finishedAt
          || !sameSource(r.before, before) || !sameSource(r.after, before)) throw new Error(`missing, failed or stale evidence: ${id}`)
        if (sha256(await readFile(join(checkRunDir(options.stateDir, contract.ticketId, r.runId), 'output.log'))) !== r.outputHash) throw new Error('output hash mismatch')
        used.push(r)
      }
      if (options.requireSessionBinding) {
        const sessionId = execution.agent?.session.header.id
        if (sessionId === undefined || sessionId === null || sessionId === '') throw new Error('ready report has no Worker Session; evidence cannot be bound')
        const snapshot = await options.readSession!(String(sessionId))
        for (const r of used) {
          const problem = sessionBindingProblem(snapshot, String(sessionId), contract, r)
          if (problem) throw new Error(`evidence is not bound to a native execution: ${problem}`)
        }
      }
      if (contract.requirePullRequest) {
        const number = (execution.arguments as { pr_number?: number }).pr_number
        if (!Number.isInteger(number) || number! <= 0) throw new Error('pr_number required')
        const fetch = options.pullRequest ?? ((repo, n) => defaultPullRequest(repo, n, join(options.stateDir, 'worker-bin', 'gh')))
        const pr = await fetch(contract.repository, number!)
        if (pr.state !== 'open' || pr.baseRef !== contract.baseRef || pr.headSha !== before.headCommit) throw new Error('PR/base/HEAD mismatch')
      }
      if (!await clean(workspace) || !sameSource(before, await gitFingerprint(workspace, contract.baseSha))) throw new Error('source changed during ready')
      return { ok: true }
    } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e) } }
  }
}
