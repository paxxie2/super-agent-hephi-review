/** HEPHI Super Agent plugin bundle entry point. */
import type { Context } from '@deepseek-ai/cordis'
import { defaultStateDir } from './control/activation.js'
import { createEvidenceVerifier, type SessionSnapshot } from './control/evidence-verifier.js'
import { installWorkerMount } from './control/worker-mount.js'

export * from './control/index.js'

export const pluginName = 'hephi-superagent-plugin'
export const pluginVersion = '0.1.0'
export const inject = ['agents', 'tools', 'systemPrompt']

/**
 * Cordis bundle entry. The control plane only observes existing Worker Agents.
 * Session binding is opt-in (HEPHI_REQUIRE_SESSION_BINDING=1) until the host's
 * event structure for inner check calls has been confirmed.
 */
export function apply(ctx: Context, config: { stateDir?: string; requireSessionBinding?: boolean } = {}): void {
  const stateDir = defaultStateDir(config.stateDir)
  const requireSessionBinding = config.requireSessionBinding ?? process.env.HEPHI_REQUIRE_SESSION_BINDING === '1'
  const readSession = async (sessionId: string): Promise<SessionSnapshot> => {
    const query = ctx.get('sessionQuery') as { readSession(id: string): Promise<SessionSnapshot> } | undefined
    if (!query) throw new Error('host sessionQuery service is unavailable; evidence cannot be bound to native executions')
    return query.readSession(sessionId)
  }
  const verify = createEvidenceVerifier({ stateDir, readSession, requireSessionBinding })
  const dispose = installWorkerMount(ctx, { stateDir, verify })
  ctx.effect(() => dispose, `${pluginName}: worker ready gate`)
}

/**
 * The runtime integration is registered by Cordis through cordis.patch.yml.
 * Keeping this module side-effect free makes the domain code testable outside DSH.
 */
export function describePlugin(): { name: string; version: string } {
  return { name: pluginName, version: pluginVersion }
}
