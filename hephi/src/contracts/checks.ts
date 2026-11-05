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
}

export type VerificationConfig = {
  version: 1
  checks: VerificationCheck[]
}

const CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

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
}).strict()

const verificationSchema = z.object({
  version: z.literal(1),
  checks: z.array(checkSchema).min(1),
}).strict().superRefine((config, ctx) => {
  const ids = new Set<string>()
  for (const check of config.checks) {
    if (ids.has(check.id)) ctx.addIssue({ code: 'custom', message: `duplicate check id: ${check.id}` })
    ids.add(check.id)
  }
  if (!config.checks.some(check => check.required)) {
    ctx.addIssue({ code: 'custom', message: 'at least one check must be required' })
  }
})

/** Validate an explicit project verification configuration. */
export function parseVerificationConfig(input: unknown): VerificationConfig {
  return verificationSchema.parse(input) as VerificationConfig
}
