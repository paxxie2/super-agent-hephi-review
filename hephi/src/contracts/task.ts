import { z } from 'zod'

/**
 * Issue-scoped task card, written by the Issue author inside a fenced
 * ```hephi-task``` block and frozen into the activation contract by prepare.
 *
 * Every changed file must belong to some acceptance item's `paths`. Each item
 * names the project check that demonstrates it; reproduction or behaviour
 * preservation is the project check's responsibility, not inferred here.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const relative = z.string().min(1).refine(v => !v.startsWith('/') && !v.split(/[\\/]+/).includes('..') && !v.includes('\0'), 'must be a relative path inside the repository')

const acceptanceSchema = z.object({
  id: z.string().regex(ID),
  text: z.string().trim().min(1),
  check: z.string().regex(ID),
  paths: z.array(relative).min(1),
}).strict()

export const DEFAULT_PROTECTED = ['**/test/**', '**/tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/*Test.java', '**/*_test.go', '**/test_*.py']

export const taskCardSchema = z.object({
  version: z.literal(1),
  goal: z.string().trim().min(1),
  outOfScope: z.array(z.string().trim().min(1)).default([]),
  acceptance: z.array(acceptanceSchema).min(1),
  /** A hard limit only when the Issue author asks for one. */
  budget: z.object({
    maxFiles: z.number().int().min(1).optional(),
    maxChangedLines: z.number().int().min(1).optional(),
  }).strict().optional(),
  protect: z.array(relative).default(DEFAULT_PROTECTED),
}).strict().superRefine((card, ctx) => {
  const ids = new Set<string>()
  for (const a of card.acceptance) {
    if (ids.has(a.id)) ctx.addIssue({ code: 'custom', message: `duplicate acceptance id: ${a.id}` })
    ids.add(a.id)
  }
})

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
