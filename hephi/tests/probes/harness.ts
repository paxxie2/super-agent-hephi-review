import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { afterEach } from 'vitest'
import { prepareActivation, type ActivationContract } from '../../src/control/activation.js'
import { runCheck } from '../../src/control/check-runner.js'
import { readRuns } from '../../src/control/check-store.js'
import { createEvidenceVerifier, type SessionSnapshot } from '../../src/control/evidence-verifier.js'

// Shared probe harness: real Git repositories, real shell commands, the real
// check runner and ready verifier. The host bash tool is a thin sh adapter that
// records each call in a Session snapshot shaped like the one stage recovery
// reads from the host.
const run = promisify(execFile)
export const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(p => rm(p, { recursive: true, force: true }))) })

export async function git(dir: string, ...args: string[]) { return (await run('git', args, { cwd: dir })).stdout.trim() }
export async function commitAll(dir: string, message: string) { await git(dir, 'add', '-A'); await git(dir, 'commit', '-q', '-m', message) }

export const RUN_TESTS = 'for f in tests/*.test.sh; do sh "$f" || exit 1; done'
export const PRICE = 'process.exit(require("./src/price.js").total(2, 3) === 5 ? 0 : 1)'
export const SESSION = 'worker-session'

type CardOverrides = { paths?: string[]; budget?: { maxFiles?: number; maxChangedLines?: number }; check?: string }
export function issueBody(o: CardOverrides): string {
  const card = {
    version: 1, goal: 'total() returns the sum of its two arguments',
    acceptance: [{ id: 'AC1', text: 'total(2, 3) is 5', check: o.check ?? 'price', paths: o.paths ?? ['src/price.js', 'tests/price*'] }],
    ...(o.budget ? { budget: o.budget } : {}),
  }
  return ['```hephi-task', JSON.stringify(card), '```'].join('\n')
}

export function bashHost(log: SessionSnapshot['events']) {
  return { execute: async (input: any) => {
    const callId = String(input.callId)
    log.push({ seq: log.length, type: 'tool/call', data: { name: 'bash', callId, arguments: JSON.stringify(input.arguments) } })
    let exitCode = 0, stdout = '', stderr = ''
    try {
      const r = await run('sh', ['-c', input.arguments.command], { cwd: input.arguments.workdir, timeout: 20000 })
      stdout = r.stdout; stderr = r.stderr
    } catch (error: any) {
      if (!Number.isInteger(error.code)) throw error
      exitCode = error.code; stdout = error.stdout; stderr = error.stderr
    }
    log.push({ seq: log.length, type: 'tool/result', data: { message: {
      toolCallId: callId, isError: false, content: [{ type: 'text', text: JSON.stringify({ exitCode }) }],
      // A1-BIND/A1-OUT read this structured native value; the host shape is pending H2/H3.
      value: { kind: 'foreground', exitCode, signal: null, timedOut: false, aborted: false, stdout: { text: stdout, truncated: false }, stderr: { text: stderr, truncated: false } },
    } } })
    return { isError: false as const, content: [], value: { kind: 'foreground', exitCode, stdout: { text: stdout }, stderr: { text: stderr } } }
  } }
}

export async function project(card: CardOverrides = {}, extraChecks: object[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'hephi-eff-repo-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'hephi-eff-state-'))
  cleanup.push(dir, stateDir)
  await git(dir, 'init', '-q', '-b', 'main')
  await git(dir, 'config', 'user.email', 'probe@example.invalid')
  await git(dir, 'config', 'user.name', 'probe')
  await git(dir, 'remote', 'add', 'origin', 'git@github.com:example/probe.git')
  await mkdir(join(dir, 'src')); await mkdir(join(dir, 'tests')); await mkdir(join(dir, 'deploy'))
  await writeFile(join(dir, 'src/price.js'), 'exports.total = (a, b) => a - b\n')
  for (let i = 0; i < 20; i++) await writeFile(join(dir, `src/m${String(i).padStart(2, '0')}.js`), `exports.value${i} = function () { return ${i} }\n`)
  await writeFile(join(dir, 'tests/smoke.test.sh'), 'node -e "require(\'./src/m00.js\')"\n')
  await writeFile(join(dir, 'tests/legacy.test.sh'), 'node -e "process.exit(require(\'./src/m01.js\').value1() === 1 ? 0 : 1)"\n')
  await writeFile(join(dir, 'deploy/prod.env'), 'REPLICAS=3\n')
  await commitAll(dir, 'base')
  const baseSha = await git(dir, 'rev-parse', 'HEAD')
  const checks = [
    { id: 'tests', kind: 'test', purpose: 'project tests', command: 'sh', args: ['-c', RUN_TESTS], timeoutMs: 20000 },
    { id: 'price', kind: 'test', purpose: 'pricing behaviour', command: 'node', args: ['-e', PRICE], required: false, timeoutMs: 20000 },
    ...extraChecks,
  ]
  const prepared = await prepareActivation({
    HEPHI_ENABLED: '1', HEPHI_STATE_DIR: stateDir, HEPHI_BASE_COMMIT: baseSha, HEPHI_ALLOWED_PATHS: 'src/**,tests/**',
    DSH_SUPERAGENT_TICKET: `t${Math.random().toString(36).slice(2)}`, DSH_SUPERAGENT_DIR: dir,
    DSH_SUPERAGENT_GITHUB_REPOSITORY: 'example/probe', DSH_SUPERAGENT_GITHUB_NUMBER: '7', HEPHI_REQUIRE_TASK: '1',
    HEPHI_VERIFICATION_CHECKS: JSON.stringify({ version: 1, checks }),
    HEPHI_ISSUE_BODY: issueBody(card),
  })
  if (!prepared.enabled) throw new Error('not enabled')
  const events: SessionSnapshot['events'] = []
  return { dir, stateDir, baseSha, contract: prepared.contract, events, tools: bashHost(events) }
}

export type Project = Awaited<ReturnType<typeof project>>
export const outer = (id: string): ToolExecution => ({
  callId: `outer-${id}` as never, rootCallId: `outer-${id}` as never, name: 'hephi_check',
  agent: { id: SESSION } as never, arguments: { checkId: id }, signal: new AbortController().signal, token: Symbol(id) as never,
})
export const readyCall = (cwd: string, id: string | undefined = SESSION): ToolExecution => ({
  callId: 'ready' as never, rootCallId: 'ready' as never, name: 'orchestrator_report', arguments: { state: 'ready' },
  signal: new AbortController().signal, token: Symbol('ready') as never, agent: { session: { header: { cwd, id } } } as never,
})
export const snapshot = (events: SessionSnapshot['events'], id = SESSION, inheritedEventCount = 0): SessionSnapshot => ({ session: { id }, inheritedEventCount, events })
/**
 * B2 (DSH host task order §3.2): binding-effective ready reports now also require the
 * host's four-way delivery binding record. The probe harness models an honest deployment
 * (B1 + B2 delivered), so a matching record is written before verification; deployment-level
 * failures of the gate itself are covered by tests/control/binding-record.test.ts.
 */
async function writeBindingRecordFixture(p: Project, contract: ActivationContract): Promise<void> {
  const needed = new Set(contract.verification.checks.filter(check => check.required).map(check => check.id))
  for (const item of contract.task?.acceptance ?? []) needed.add(item.check)
  const records = await readRuns(p.stateDir, contract.ticketId)
  const record = [...records].reverse().find(item => needed.has(item.checkId)
    && item.contractHash === contract.contractHash && item.status === 'passed' && item.exitCode === 0)
  if (record === undefined || record.before.headCommit === undefined) return
  const execution = record.jobId === undefined
    ? { kind: 'foreground' as const, exitCode: record.exitCode!, toolCallId: record.innerCallId }
    : { kind: 'background' as const, jobId: record.jobId, toolCallId: record.innerCallId }
  await mkdir(join(p.stateDir, 'binding'), { recursive: true })
  await writeFile(join(p.stateDir, 'binding', `${contract.ticketId}.json`), JSON.stringify({
    version: 1,
    producedAt: '2026-11-12T07:00:00Z',
    producer: 'probe-harness',
    ticket: { id: contract.ticketId },
    session: { id: SESSION },
    execution,
    finalCommit: { sha: record.before.headCommit, baseSha: contract.baseSha },
  }))
}

export const verifier = (p: Project, read?: (id: string) => SessionSnapshot) => {
  const verify = createEvidenceVerifier({ stateDir: p.stateDir, readSession: async id => read ? read(id) : snapshot(p.events, id), requireSessionBinding: true })
  return async (contract: ActivationContract, execution: ToolExecution) => {
    await writeBindingRecordFixture(p, contract)
    return verify(contract, execution)
  }
}
export const check = async (p: Project, id: string) => {
  try { return (await runCheck({ stateDir: p.stateDir, contract: p.contract, checkId: id, outer: outer(id), tools: p.tools as never })).status }
  catch (error) { return `refused: ${error instanceof Error ? error.message : String(error)}` }
}

