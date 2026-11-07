/** Build-time plugin identity. The commit is injected by tsdown from the build checkout. */
declare const __HEPHI_COMMIT__: unknown

export const pluginName = 'hephi-superagent-plugin'
export const pluginVersion = '0.1.0'

/**
 * The plugin commit this code was built from. Only test/dev runs that never went
 * through the build report 'unknown'; a release build always carries a commit.
 */
export function pluginCommit(): string {
  if (typeof __HEPHI_COMMIT__ === 'string' && __HEPHI_COMMIT__ !== '') return __HEPHI_COMMIT__
  return process.env.HEPHI_BUILD_COMMIT?.trim() || 'unknown'
}

/**
 * Single-line activation evidence written by each bundle entry after its
 * registration completed. scripts/host/deploy-hephi.sh requires one marker per
 * entry, with the release commit and the host process id, read from the host log
 * segment of the current start; a generic 10-service health check cannot prove
 * that the plugin registered (issue #26).
 *
 * Keep the format stable: the deploy script parses this exact shape.
 */
export const ACTIVATION_MARKER_PREFIX = '[hephi-activation]'

export function activationMarker(entry: 'index' | 'tools'): string {
  return `${ACTIVATION_MARKER_PREFIX} entry=${entry} plugin=${pluginName} commit=${pluginCommit()} pid=${process.pid}`
}
