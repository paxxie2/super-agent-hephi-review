import { isAbsolute, normalize, sep } from 'node:path'
import { z } from 'zod'

/**
 * Frozen project-check configuration copied into an activation contract.
 *
 * The first version only proves a synchronous pass: build commands use their
 * exit code from a frozen project check. The project check must fail on absent
 * required tests and assertion failures. Report formats belong to the project,
 * not this control plane.
 */
export type VerificationCheck = {
  id: string
  kind: 'build' | 'test'
  purpose: string
  command: string
  args: string[]
  /** Workspace-relative directory. */
  cwd: string
  required: boolean
  timeoutMs: number
  /**
   * T08 (A2): failure types this check accepts as an assertion failure when T18 classifies an
   * offline red state. Additive and optional: a config without it keeps its historical meaning,
   * and the list is only frozen into the contract (nothing consumes it yet).
   */
  assertionFailureTypes?: string[]
}

/**
 * C4.6 optional offline/locked environment requirements for the frozen checks.
 * Additive to verification format version 1; frozen inside the activation contract.
 */
export type EnvironmentRequirements = {
  /** When true, prepare enforces an offline, lockfile-pinned check environment. */
  offline?: boolean
  /** Workspace-relative lockfile that must exist when offline=true. */
  lockfile?: string
}

export type VerificationConfig = {
  version: 1
  checks: VerificationCheck[]
  /** C4.6: optional offline/lockfile requirement (only enforced at prepare when offline=true). */
  environment?: EnvironmentRequirements
  /**
   * C3: GitHub usernames allowed to approve the pull request at ready time. Frozen
   * into the contract from activation version 5; empty/absent means no approval is
   * required (legacy behavior).
   */
  approvers?: string[]
  /**
   * C1: project-level protected acceptance assets (workspace-relative globs). The
   * effective list is these entries plus the task card's `protectedAssets`; the task
   * card can only add to the project list, never remove from it.
   */
  protectedAssets?: string[]
  /**
   * C4.2 enforcement switch (M1 fix). Default false/absent = the change plan is OPTIONAL:
   * no plan means no plan check, and a Worker can skip declaring a plan. When true the
   * contract is fail-closed: write/edit and ready are denied with `plan.not-declared`
   * until a plan for the current contract hash exists. Additive to verification format 1
   * (frozen into the contract hash; no contract version bump, like `environment`).
   */
  requirePlan?: boolean
}

const CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/** GitHub login: alphanumeric single characters or hyphen-separated, max 39 chars. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const approverLogin = z.string().regex(GITHUB_LOGIN, 'approver must be a GitHub username')

function safeRelativePath(value: string): boolean {
  if (!value || value.includes('\0')) return false
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return false
  if (value.split(/[\\/]+/).includes('..')) return false
  return normalize(value) !== '..' && !normalize(value).startsWith(`..${sep}`)
}

const relativePath = z.string().min(1).refine(safeRelativePath, 'must be a relative path inside the declared root')

const checkSchema = z.object({
  id: z.string().regex(CHECK_ID, 'check id must contain only letters, digits, dot, dash or underscore'),
  kind: z.enum(['build', 'test']),
  purpose: z.string().trim().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: relativePath.default('.'),
  required: z.boolean().default(true),
  timeoutMs: z.number().int().min(1).max(3_600_000).default(600_000),
  /** T08 (A2): trimmed non-empty failure-type names (e.g. ["AssertionError"]); optional and additive. */
  assertionFailureTypes: z.array(z.string().trim().min(1)).optional(),
}).strict()

const environmentSchema = z.object({
  offline: z.boolean().optional(),
  lockfile: relativePath.optional(),
}).strict().superRefine((environment, ctx) => {
  // C4.6: an offline declaration without a pinned lockfile is not enforceable.
  if (environment.offline === true && environment.lockfile === undefined) {
    ctx.addIssue({ code: 'custom', message: 'environment.offline=true requires environment.lockfile' })
  }
})

const verificationSchema = z.object({
  version: z.literal(1),
  checks: z.array(checkSchema).min(1),
  protectedAssets: z.array(relativePath).optional(),
  /** C4.2 M1: explicit opt-in to fail-closed plan enforcement (default false/optional). */
  requirePlan: z.boolean().optional(),
  approvers: z.array(approverLogin).optional(),
  environment: environmentSchema.optional(),
}).strict().superRefine((config, ctx) => {
  const ids = new Set<string>()
  for (const check of config.checks) {
    if (ids.has(check.id)) ctx.addIssue({ code: 'custom', message: `duplicate check id: ${check.id}` })
    ids.add(check.id)
  }
  if (!config.checks.some(check => check.required)) {
    ctx.addIssue({ code: 'custom', message: 'at least one check must be required' })
  }
  // GitHub logins are case-insensitive; a duplicated approver must not be accepted.
  const approvers = new Set<string>()
  for (const approver of config.approvers ?? []) {
    const key = approver.toLowerCase()
    if (approvers.has(key)) ctx.addIssue({ code: 'custom', message: `duplicate approver: ${approver}` })
    approvers.add(key)
  }
})

/** Validate an explicit project verification configuration. */
export function parseVerificationConfig(input: unknown): VerificationConfig {
  return verificationSchema.parse(input) as VerificationConfig
}
