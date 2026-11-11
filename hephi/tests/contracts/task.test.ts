import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { main as cliMain } from '../../src/cli.js'
import { DEFAULT_PROTECTED, parseIssueTask, parseTaskCard, taskCardSchema } from '../../src/contracts/task.js'
import { loadActivation, prepareActivation } from '../../src/control/activation.js'
import { mountWorkerGate } from '../../src/control/worker-mount.js'

const card = {
  version: 1,
  goal: 'total() returns the sum of its two arguments',
  outOfScope: ['pricing rules', 'module layout'],
  acceptance: [{ id: 'AC1', text: 'total(2, 3) is 5', check: 'tests', paths: ['src/price.js', 'tests/price*.sh'] }],
}
const fence = (value: unknown) => ['```hephi-task', JSON.stringify(value, null, 2), '```'].join('\n')
const body = ['total() subtracts instead of adding.', '', fence(card)].join('\n')

function env(stateDir: string, issueBody?: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HEPHI_ENABLED: '1', HEPHI_STATE_DIR: stateDir, HEPHI_BASE_COMMIT: 'a'.repeat(40), HEPHI_ALLOWED_PATHS: 'src/**,tests/**',
    DSH_SUPERAGENT_TICKET: 'ticket-1', DSH_SUPERAGENT_DIR: '/tmp/ticket-1',
    DSH_SUPERAGENT_GITHUB_REPOSITORY: 'example/probe', DSH_SUPERAGENT_GITHUB_NUMBER: '7',
    HEPHI_VERIFICATION_CHECKS: JSON.stringify({ version: 1, checks: [{ id: 'tests', kind: 'test', purpose: 'project tests', command: 'sh', args: ['run-tests.sh'] }] }),
    ...(issueBody === undefined ? {} : { HEPHI_ISSUE_BODY: issueBody }),
    ...extra,
  }
}

describe('Issue task card', () => {
  it('parses goal, non-goals, acceptance and paths without requiring a budget', () => {
    const task = parseIssueTask(body)!
    expect(task.goal).toBe(card.goal)
    expect(task.acceptance[0]).toEqual(card.acceptance[0])
    expect(task.budget).toBeUndefined()
    expect(task.protect).toContain('**/tests/**')
  })

  it('rejects ambiguous cards and fields it no longer interprets', () => {
    expect(parseIssueTask('no card here')).toBeUndefined()
    expect(() => parseIssueTask(`${body}\n${fence(card)}`)).toThrow('more than one hephi-task')
    expect(() => parseIssueTask(`${body}\n\`\`\`hephi-test AC1 t.sh\nexit 0\n\`\`\``)).toThrow('hephi-test blocks are not supported')
    expect(() => parseIssueTask(fence({ ...card, acceptance: [card.acceptance[0], card.acceptance[0]] }))).toThrow('duplicate acceptance id')
    expect(() => parseIssueTask(fence({ ...card, acceptance: [{ ...card.acceptance[0], tests: ['x'] }] }))).toThrow()
    expect(() => parseIssueTask(fence({ ...card, acceptance: [{ ...card.acceptance[0], paths: ['../outside'] }] }))).toThrow()
  })

  it('prepare freezes the card into the contract hash', async () => {
    const result = await prepareActivation(env(await mkdtemp(join(tmpdir(), 'hephi-task-')), body))
    if (!result.enabled) throw new Error('not enabled')
    const contract = await loadActivation(result.filePath)
    expect(contract.task?.acceptance[0].check).toBe('tests')
    const withoutTask = await prepareActivation(env(await mkdtemp(join(tmpdir(), 'hephi-task-')), 'plain issue'))
    if (!withoutTask.enabled) throw new Error('not enabled')
    expect(withoutTask.contract.contractHash).not.toBe(contract.contractHash)
  })

  it('prepare refuses a missing card when required, and a card naming an unknown check', async () => {
    await expect(prepareActivation(env(await mkdtemp(join(tmpdir(), 'hephi-task-')), 'plain issue', { HEPHI_REQUIRE_TASK: '1' }))).rejects.toThrow('hephi-task block')
    await expect(prepareActivation(env(await mkdtemp(join(tmpdir(), 'hephi-task-')), body.replace('"check": "tests"', '"check": "lint"')))).rejects.toThrow('unknown check lint')
  })

  it('keeps the goal in the Worker prompt and mentions a budget only when the Issue sets one', async () => {
    const promptFor = async (issueBody: string) => {
      const stateDir = await mkdtemp(join(tmpdir(), 'hephi-task-'))
      await prepareActivation(env(stateDir, issueBody))
      const prompts: Array<{ text: () => string }> = []
      const agent = {
        session: { header: { id: 'worker-ticket-1', agentPreset: 'dsh-superagent-worker', cwd: '/tmp/ticket-1' } },
        ctx: {
          on: () => () => true,
          tools: { register: () => () => true, guard: () => () => true },
          systemPrompt: { section: (s: { text: () => string }) => { prompts.push(s); return () => true } },
        },
      } as unknown as Agent
      mountWorkerGate({} as Context, agent, { stateDir })
      return prompts.map(p => p.text()).join('\n')
    }
    const text = await promptFor(body)
    expect(text).toContain(`HEPHI task goal (frozen; do not reinterpret or extend): ${card.goal}`)
    expect(text).toContain('AC1: total(2, 3) is 5 | may change: src/price.js, tests/price*.sh | prove with hephi_check("tests")')
    expect(text).toContain('Explicitly out of scope: pricing rules; module layout')
    expect(text).toContain('Advisory change budget, recorded but not refused: at most 8 files and 400 changed lines.')
    expect(text).not.toContain('requested by the Issue')
    expect(await promptFor(fence({ ...card, budget: { maxFiles: 3 } }))).toContain('Change budget requested by the Issue: at most 3 files.')
  })
})

// ---- T13: task card v3 -------------------------------------------------------

const v3Acceptance = { id: 'AC1', text: 'total(2, 3) is 5', check: 'tests', paths: ['src/price.js'] }
const v3CodeCard = {
  version: 3 as const,
  kind: 'code' as const,
  goal: 'total() returns the sum of its two arguments',
  outOfScope: ['pricing rules', 'module layout'],
  acceptance: [{ ...v3Acceptance, tests: ['tests/price.test.ts'] }],
}

describe('Issue task card v3 (T13)', () => {
  it('parses a v3 card and keeps kind, tests and cases', () => {
    const parsed = parseTaskCard({
      ...v3CodeCard,
      acceptance: [{ ...v3Acceptance, tests: ['tests/price.test.ts'], cases: ['sum of positives', 'zero'] }],
    })
    expect(parsed.version).toBe(3)
    expect(parsed.kind).toBe('code')
    expect(parsed.outOfScope).toEqual(v3CodeCard.outOfScope)
    expect(parsed.acceptance[0].tests).toEqual(['tests/price.test.ts'])
    expect(parsed.acceptance[0].cases).toEqual(['sum of positives', 'zero'])
    expect(parseTaskCard({ ...v3CodeCard, kind: 'refactor', acceptance: [v3Acceptance] }).kind).toBe('refactor')
    expect(parseTaskCard({ ...v3CodeCard, kind: 'doc', acceptance: [v3Acceptance] }).kind).toBe('doc')
  })

  it('AT-20: a v3 card without outOfScope fails and names the missing field', () => {
    const withoutScope: Record<string, unknown> = { ...v3CodeCard }
    delete withoutScope.outOfScope
    expect(() => parseTaskCard(withoutScope)).toThrow(/outOfScope is required for task card version 3/)
    const result = taskCardSchema.safeParse(withoutScope)
    if (result.success) throw new Error('expected the v3 card without outOfScope to fail')
    expect(result.error.issues.some(issue => issue.path.join('.') === 'outOfScope')).toBe(true)
  })

  it('AT-21: kind=code requires tests on every acceptance item', () => {
    const withoutTests = { ...v3CodeCard, acceptance: [v3Acceptance] }
    expect(() => parseTaskCard(withoutTests)).toThrow(/acceptance AC1: tests is required when kind is/)
    const result = taskCardSchema.safeParse(withoutTests)
    if (result.success) throw new Error('expected the code card without tests to fail')
    expect(result.error.issues.some(issue => issue.path.join('.') === 'acceptance.0.tests')).toBe(true)
    const secondMissing = { ...v3CodeCard, acceptance: [{ ...v3Acceptance }, { ...v3Acceptance, id: 'AC2' }] }
    expect(() => parseTaskCard(secondMissing)).toThrow(/acceptance AC2: tests is required when kind is/)
    // tests are optional for refactor/doc
    expect(parseTaskCard({ ...v3CodeCard, kind: 'refactor', acceptance: [v3Acceptance] }).acceptance[0].tests).toBeUndefined()
  })

  it('AT-22: version 1 and version 2 cards parse exactly as before', () => {
    const v1 = {
      version: 1,
      goal: 'total() adds',
      outOfScope: ['pricing rules'],
      acceptance: [{ id: 'AC1', text: 'total(2, 3) is 5', check: 'tests', paths: ['src/price.js'] }],
    }
    // Fixed JSON: the v1 result keeps the pre-v3 shape, order and outOfScope default.
    expect(parseTaskCard(v1)).toEqual({ ...v1, protect: DEFAULT_PROTECTED })
    expect(JSON.stringify(parseTaskCard(v1))).toBe(JSON.stringify({ ...v1, protect: DEFAULT_PROTECTED }))
    expect(parseTaskCard({ version: 1, goal: v1.goal, acceptance: v1.acceptance })).toEqual({ version: 1, goal: v1.goal, outOfScope: [], acceptance: v1.acceptance, protect: DEFAULT_PROTECTED })

    const v2 = {
      version: 2,
      goal: 'rename a helper without behaviour change',
      outOfScope: ['module layout'],
      acceptance: [{ id: 'AC1', text: 'existing tests pass', check: 'tests', paths: ['src/price.js'], authorizes: [{ path: 'tests/price.spec.ts', op: 'modify' }] }],
      budget: { maxFiles: 2 },
      protectedAssets: ['tests/**'],
    }
    const expectedV2 = {
      version: 2,
      goal: v2.goal,
      outOfScope: v2.outOfScope,
      acceptance: v2.acceptance,
      budget: v2.budget,
      protect: DEFAULT_PROTECTED,
      protectedAssets: v2.protectedAssets,
    }
    expect(parseTaskCard(v2)).toEqual(expectedV2)
    expect(JSON.stringify(parseTaskCard(v2))).toBe(JSON.stringify(expectedV2))

    // v3-only fields stay rejected on v1/v2 -> no silent behaviour change.
    expect(() => parseTaskCard({ ...v1, kind: 'code' })).toThrow(/kind requires task card version 3/)
    expect(() => parseTaskCard({ ...v2, acceptance: [{ ...v2.acceptance[0], tests: ['tests/price.test.ts'] }] })).toThrow(/tests requires task card version 3/)
  })

  it('AT-23: a v3 card rejects unknown fields', () => {
    expect(() => parseTaskCard({ ...v3CodeCard, licence: 'MIT' })).toThrow(/unrecognized key/i)
    const acceptanceUnknown = taskCardSchema.safeParse({ ...v3CodeCard, acceptance: [{ ...v3CodeCard.acceptance[0], coverage: 80 }] })
    if (acceptanceUnknown.success) throw new Error('expected an unknown acceptance field to fail')
    expect(acceptanceUnknown.error.issues.some(issue => issue.code === 'unrecognized_keys')).toBe(true)
  })

  it('T16: the template v3 code/refactor examples match the schema', async () => {
    const template = await readFile(new URL('../../templates/issue-with-task-card.md', import.meta.url), 'utf8')
    const blocks = [...template.matchAll(/```hephi-task\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]) as unknown)
    const v3 = blocks.filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null && (block as { version?: unknown }).version === 3)
    expect(v3.map(block => block.kind)).toEqual(['code', 'refactor', 'code'])
    for (const block of v3) expect(() => parseTaskCard(block)).not.toThrow()
  })

  it('T13: hephi lint-task accepts a flattened v3 bundle carrying kind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hephi-task-'))
    const file = join(dir, 'bundle.json')
    await writeFile(file, JSON.stringify({
      version: 3,
      kind: 'code',
      goal: 'total() returns the sum of its two arguments',
      outOfScope: ['pricing rules'],
      acceptance: [{ ...v3Acceptance, check: 'unit', tests: ['tests/price.test.ts'] }],
      ticketId: 'ticket-1',
      allowedPaths: ['src/**', 'tests/**'],
      checks: [{ id: 'unit', kind: 'test', purpose: 'unit', command: 'node', args: ['test.js'] }],
    }))
    const out: string[] = []
    const err: string[] = []
    const code = await cliMain(['lint-task', file], process.env, { out: message => out.push(message), err: message => err.push(message) })
    expect(code).toBe(0)
    expect(out.join('\n')).toContain('HEPHI task lint: PASS')
    expect(err.join('\n')).not.toContain('unknown top-level field ignored: kind')
  })
})
