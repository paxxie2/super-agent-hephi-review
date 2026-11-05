import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { parseIssueTask } from '../../src/contracts/task.js'
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
    expect(text).not.toContain('budget')
    expect(await promptFor(fence({ ...card, budget: { maxFiles: 3 } }))).toContain('Change budget requested by the Issue: at most 3 files.')
  })
})
