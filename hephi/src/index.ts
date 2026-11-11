/** HEPHI Super Agent plugin bundle entry point. */
import type { Context } from '@deepseek-ai/cordis'
import { defaultStateDir } from './control/activation.js'
import type { NativeJobs } from './control/check-runner.js'
import { createEvidenceVerifier, type SessionSnapshot } from './control/evidence-verifier.js'
import { findSessionLogFile, defaultSessionLogRoots, readPersistedSessionLog, sealSnapshotBytes, verifySnapshotBytes, type SnapshotSealProvider, type SnapshotSealVerifier } from './control/snapshot-seal.js'
import { installWorkerMount } from './control/worker-mount.js'
import { activationMarker, pluginCommit, pluginName, pluginVersion } from './version.js'

export * from './control/index.js'

export { pluginCommit, pluginName, pluginVersion } from './version.js'
export const inject = ['agents', 'tools', 'systemPrompt']

/**
 * Cordis bundle entry. The control plane only observes existing Worker Agents.
 * Session binding is decided by the contract (A1-K5: `evidence.requireSessionBinding`,
 * frozen at prepare) with this host configuration able to tighten it only. Host config
 * still defaults to off until the host's event structure for inner check calls is confirmed.
 */
export function apply(ctx: Context, config: {
  stateDir?: string
  requireSessionBinding?: boolean
  /** A3 operator resolution channel (host cordis config). Default false; never read from the environment. */
  allowOperatorResolutions?: boolean
  /** C4.5 per-check retry limit (host cordis config). Default 3. */
  retryLimit?: number
  /**
   * H6=C detect-only: deployment session root for the persisted Session logs (raw
   * bytes). Falls back to DSH_SESSION_ROOT, $DSH_HOME/sessions, ~/.dsh/sessions.
   */
  sessionLogRoot?: string
} = {}): void {
  const stateDir = defaultStateDir(config.stateDir)
  // Host-side requirement. It is combined with the contract value inside the verifier
  // (effective = contract OR host); it can never relax a contract that requires binding.
  const hostRequireSessionBinding = config.requireSessionBinding ?? process.env.HEPHI_REQUIRE_SESSION_BINDING === '1'
  // A3 trust boundary: ONLY the host plugin configuration enables operator resolutions. The
  // process environment is not an enable channel (a Worker shell cannot opt in), and the CLI
  // has its own operator-only config file gate (see `hephi resolve --operator-config`).
  const allowOperatorResolutions = config.allowOperatorResolutions === true
  const retryLimit = config.retryLimit
  if (retryLimit !== undefined && (!Number.isInteger(retryLimit) || retryLimit < 1)) {
    throw new Error(`retryLimit must be a positive integer, got ${String(retryLimit)}`)
  }
  const readSession = async (sessionId: string): Promise<SessionSnapshot> => {
    const query = ctx.get('sessionQuery') as { readSession(id: string): Promise<SessionSnapshot> } | undefined
    if (!query) throw new Error('host sessionQuery service is unavailable; evidence cannot be bound to native executions')
    return query.readSession(sessionId)
  }
  // A1-BIND/A1-OUT: the host Job registry is optional. Without it a background check's
  // terminal state and output cannot be verified, so ready denies that evidence instead of
  // trusting the record; foreground checks are unaffected.
  let jobs: NativeJobs | undefined
  try { jobs = ctx.get('jobs') as NativeJobs | undefined } catch { jobs = undefined }
  // H6=C detect-only: `sessionQuery.readSession` exposes parsed events, not the persisted
  // bytes, so the seal adapter reads the log file through the deployment's session root.
  // A live append can tear the trailing frame; that shape is retried (4 x 50ms) while a
  // changed sealed prefix is a definitive failure (no retry). A missing log makes the seal
  // unavailable, and ready fails closed only while binding is effective.
  const sessionRoots = (): string[] => defaultSessionLogRoots(config.sessionLogRoot)
  const sealSnapshot: SnapshotSealProvider = async (sessionId, sessionCwd) => {
    try {
      const file = await findSessionLogFile({ roots: sessionRoots(), sessionId, sessionCwd })
      if (!file) return { unavailable: `no persisted Session log found for ${sessionId} under ${sessionRoots().join(', ')}` }
      const read = await readPersistedSessionLog(file.path)
      if ('unavailable' in read) return read
      return sealSnapshotBytes(read.bytes, file.format)
    } catch (error) {
      return { unavailable: `snapshot seal failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  const sealSnapshotVerifier: SnapshotSealVerifier = async ({ sessionId, sessionCwd, seal }) => {
    let lastProblem = 'the persisted Session log could not be verified'
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const file = await findSessionLogFile({ roots: sessionRoots(), sessionId, sessionCwd })
        if (!file) return { ok: false, problem: `no persisted Session log found for ${sessionId} under ${sessionRoots().join(', ')}` }
        const read = await readPersistedSessionLog(file.path)
        if ('unavailable' in read) return { ok: false, problem: read.unavailable }
        const result = verifySnapshotBytes(read.bytes, seal)
        if (result.ok) return result
        lastProblem = result.problem
        if (!result.retryable) return { ok: false, problem: result.problem }
      } catch (error) {
        lastProblem = `the persisted Session log is unreadable: ${error instanceof Error ? error.message : String(error)}`
      }
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 50))
    }
    return { ok: false, problem: lastProblem }
  }
  const verify = createEvidenceVerifier({ stateDir, readSession, requireSessionBinding: hostRequireSessionBinding, allowOperatorResolutions, jobs, sealSnapshotVerifier })
  const dispose = installWorkerMount(ctx, { stateDir, verify, allowOperatorResolutions, retryLimit, sealSnapshot })
  ctx.effect(() => dispose, `${pluginName}: worker ready gate`)
  // Registration completed: emit the deploy-verifiable activation marker (issue #26).
  console.log(activationMarker('index'))
}

/**
 * The runtime integration is registered by Cordis through cordis.patch.yml.
 * Keeping this module side-effect free makes the domain code testable outside DSH.
 */
export function describePlugin(): { name: string; version: string; commit: string } {
  return { name: pluginName, version: pluginVersion, commit: pluginCommit() }
}
