import { z } from 'zod'

/**
 * Issue-scoped task card, written by the Issue author inside a fenced
 * ```hephi-task``` block and frozen into the activation contract by prepare.
 *
 * Every changed file must belong to some acceptance item's `paths`. Each item
 * names the project check that demonstrates it; reproduction or behaviour
 * preservation is the project check's responsibility, not inferred here.
 *
 * Versions: 1 and 2 are unchanged. Version 3 (T13) adds the mandatory
 * `kind` (code/refactor/doc), makes `outOfScope` mandatory, and lets each
 * acceptance item name the `tests` that prove it (mandatory for `code`) and
 * the concrete `cases` the check must cover.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const relative = z.string().min(1).refine(
  v => !v.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(v) && !v.split(/[\\/]+/).includes('..') && !v.includes('\0'),
  'must be a relative path inside the repository',
)

/** C1 authorization operations. modify does not imply delete/migrate, and vice versa. */
export const ASSET_OPS = ['modify', 'delete', 'migrate'] as const
export type AssetOp = (typeof ASSET_OPS)[number]

/** T13: what a version 3 task card asks for. Required on version 3 and rejected on version 1/2. */
export const TASK_KINDS = ['code', 'refactor', 'doc'] as const
export type TaskKind = (typeof TASK_KINDS)[number]

/** A C1 authorization names exact files only: no globs, no directory paths, no escaping. */
const exactFile = (name: string) =>
  relative.refine(v => !/[*?\[\]{}]/.test(v) && !v.endsWith('/'), `${name} must be one exact file, not a glob or directory`)

/**
 * C1: an authorization names one exact workspace-relative file (no globs) and one operation.
 * A `migrate` authorization must also name the exact `replacement` file; `modify`/`delete`
 * must not carry one (a migration is a deletion plus a declared new file, not a relabel).
 */
const authorizationSchema = z.object({
  path: exactFile('authorization path'),
  op: z.enum(ASSET_OPS),
  replacement: exactFile('replacement').optional(),
}).strict()

const acceptanceSchema = z.object({
  id: z.string().regex(ID),
  text: z.string().trim().min(1),
  check: z.string().regex(ID),
  paths: z.array(relative).min(1),
  /** C1: only valid on task card version 2. Authorizes this item to modify/delete/migrate protected assets. */
  authorizes: z.array(authorizationSchema).optional(),
  /** T13 (version 3): the project tests that prove this item. Required when the card kind is `code` (AT-21). */
  tests: z.array(relative).min(1).optional(),
  /** T13 (version 3): named cases the acceptance check must cover. */
  cases: z.array(z.string().trim().min(1)).optional(),
}).strict()

export const DEFAULT_PROTECTED = ['**/test/**', '**/tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/*Test.java', '**/*_test.go', '**/test_*.py']

export const taskCardSchema = z.object({
  /**
   * C1: version 2 adds the protected-asset fields below. Version 1 cards keep their
   * historical meaning (no protected assets, no authorizations) and are still accepted.
   * T13: version 3 adds `kind`, a mandatory `outOfScope`, and per-item `tests`/`cases`.
   */
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  /** T13: required on version 3 (`code` | `refactor` | `doc`); not accepted on version 1/2. */
  kind: z.enum(TASK_KINDS).optional(),
  goal: z.string().trim().min(1),
  /** Versions 1/2 default to `[]`; version 3 must spell the field out (checked below). */
  outOfScope: z.array(z.string().trim().min(1)).optional(),
  acceptance: z.array(acceptanceSchema).min(1),
  /** A hard limit only when the Issue author asks for one. */
  budget: z.object({
    maxFiles: z.number().int().min(1).optional(),
    maxChangedLines: z.number().int().min(1).optional(),
  }).strict().optional(),
  protect: z.array(relative).default(DEFAULT_PROTECTED),
  /** C1 (version 2): protected acceptance assets (glob syntax, same as `protect`). */
  protectedAssets: z.array(relative).optional(),
}).strict().superRefine((card, ctx) => {
  if (card.version === 1) {
    if (card.protectedAssets !== undefined) ctx.addIssue({ code: 'custom', message: 'protectedAssets requires task card version 2' })
    if (card.acceptance.some(item => item.authorizes !== undefined)) ctx.addIssue({ code: 'custom', message: 'authorizes requires task card version 2' })
  }
  if (card.version === 3) {
    // T13 (AT-20): version 3 must state the missing-field failures explicitly, so callers
    // get the field name instead of a silent default.
    if (card.kind === undefined) ctx.addIssue({ code: 'custom', path: ['kind'], message: 'kind is required for task card version 3' })
    if (card.outOfScope === undefined) ctx.addIssue({ code: 'custom', path: ['outOfScope'], message: 'outOfScope is required for task card version 3' })
    // T13 (AT-21): a `code` task must say which tests prove every acceptance item.
    if (card.kind === 'code') {
      for (const [index, item] of card.acceptance.entries()) {
        if (item.tests === undefined) {
          ctx.addIssue({ code: 'custom', path: ['acceptance', index, 'tests'], message: `acceptance ${item.id}: tests is required when kind is "code"` })
        }
      }
    }
  } else {
    // T13/AT-22: version 1/2 stay byte-for-byte compatible, including rejecting v3-only fields.
    if (card.kind !== undefined) ctx.addIssue({ code: 'custom', path: ['kind'], message: 'kind requires task card version 3' })
    for (const [index, item] of card.acceptance.entries()) {
      if (item.tests !== undefined) ctx.addIssue({ code: 'custom', path: ['acceptance', index, 'tests'], message: `acceptance ${item.id}: tests requires task card version 3` })
      if (item.cases !== undefined) ctx.addIssue({ code: 'custom', path: ['acceptance', index, 'cases'], message: `acceptance ${item.id}: cases requires task card version 3` })
    }
  }
  const ids = new Set<string>()
  for (const a of card.acceptance) {
    if (ids.has(a.id)) ctx.addIssue({ code: 'custom', message: `duplicate acceptance id: ${a.id}` })
    ids.add(a.id)
  }
  // Authorizations may not target the same (path, op) twice: ambiguity is a config error.
  const seenAuthorizations = new Set<string>()
  for (const item of card.acceptance) {
    for (const authorization of item.authorizes ?? []) {
      const key = `${item.id}\0${authorization.path}\0${authorization.op}`
      if (seenAuthorizations.has(key)) ctx.addIssue({ code: 'custom', message: `duplicate authorization in ${item.id}: ${authorization.path} ${authorization.op}` })
      seenAuthorizations.add(key)
      if (authorization.op === 'migrate') {
        if (authorization.replacement === undefined) {
          ctx.addIssue({ code: 'custom', message: `acceptance ${item.id}: migrate authorization for ${authorization.path} requires replacement` })
        } else if (authorization.replacement === authorization.path) {
          ctx.addIssue({ code: 'custom', message: `acceptance ${item.id}: replacement must differ from the original path ${authorization.path}` })
        }
      } else if (authorization.replacement !== undefined) {
        ctx.addIssue({ code: 'custom', message: `acceptance ${item.id}: replacement is only valid with a migrate authorization (${authorization.path} ${authorization.op})` })
      }
    }
  }
}).transform(card => ({
  // Rebuilt in the historical field order so version 1/2 output stays byte-for-byte
  // identical to the pre-v3 schema (AT-22), with the v1/v2 `outOfScope: []` default kept.
  version: card.version,
  ...(card.kind === undefined ? {} : { kind: card.kind }),
  goal: card.goal,
  outOfScope: card.outOfScope ?? [],
  acceptance: card.acceptance,
  ...(card.budget === undefined ? {} : { budget: card.budget }),
  protect: card.protect,
  ...(card.protectedAssets === undefined ? {} : { protectedAssets: card.protectedAssets }),
}))

export type TaskCard = z.infer<typeof taskCardSchema>

export function parseTaskCard(input: unknown): TaskCard {
  return taskCardSchema.parse(input)
}

const FENCE = /^(`{3,})[ \t]*([^\n]*)\n([\s\S]*?)\n\1[ \t]*$/gm

/** Extract the single ```hephi-task``` JSON block from an Issue body. */
export function parseIssueTask(body: string): TaskCard | undefined {
  let raw: string | undefined
  for (const match of body.replace(/\r\n/g, '\n').matchAll(FENCE)) {
    const kind = match[2].trim().split(/\s+/)[0]
    if (kind === 'hephi-test') throw new Error('hephi-test blocks are not supported; name a project check in the acceptance item instead')
    if (kind !== 'hephi-task') continue
    if (raw !== undefined) throw new Error('Issue contains more than one hephi-task block')
    raw = match[3]
  }
  if (raw === undefined) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (error) { throw new Error(`hephi-task block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`) }
  return parseTaskCard(parsed)
}
