import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActivationContract } from '../../src/control/activation.js'
import type { VerificationCheck } from '../../src/contracts/checks.js'
import { runCheck, type NativeJobEvent, type NativeJobView, type NativeJobs, type CheckTools } from '../../src/control/check-runner.js'
import { checkRunDir, readRuns } from '../../src/control/check-store.js'
import { sha256 } from '../../src/verification/fingerprint.js'

const run = promisify(execFile)
const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(p => rm(p, { recursive: true, force: true }))) })

const check: VerificationCheck = {
  id: 'build', kind: 'build', purpose: 'build', command: 'true', args: [], cwd: '.',
  required: true, timeoutMs: 5000,
}

async function repo(): Promise<{ dir: string; baseSha: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'hephi-check-job-'))
  cleanup.push(dir)
  await run('git', ['init', '-b', 'main', dir])
  await run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir })
  await run('git', ['config', 'user.name', 'Check job test'], { cwd: dir })
  await run('git', ['remote', 'add', 'origin', 'git@github.com:example/check-job.git'], { cwd: dir })
  await writeFile(join(dir, 'a.txt'), 'base\n')
  await run('git', ['add', '.'], { cwd: dir })
  await run('git', ['commit', '-m', 'base'], { cwd: dir })
  const baseSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
  await writeFile(join(dir, 'a.txt'), 'patched\n')
  await run('git', ['add', '.'], { cwd: dir })
  await run('git', ['commit', '-m', 'patch'], { cwd: dir })
  return { dir, baseSha }
}

function outer(signal = new AbortController().signal): ToolExecution {
  return {
    callId: 'outer-check' as never, rootCallId: 'outer-check' as never, name: 'hephi_check',
    agent: { id: 'worker-session' } as never, arguments: { checkId: 'build' },
    signal, token: Symbol('check') as never,
  }
}

function context(dir: string, baseSha: string, timeoutMs = check.timeoutMs): ActivationContract {
  return {
    enabled: true, ticketId: 'ticket-1', repository: 'example/check-job', issueNumber: 42,
    workspace: dir, baseRef: 'main', baseSha, allowedPaths: ['**'], requirePullRequest: false,
    verification: { version: 1, checks: [{ ...check, timeoutMs }] }, contractHash: 'sha256:test',
  }
}

async function setup(timeoutMs = check.timeoutMs) {
  const r = await repo()
  const stateDir = await mkdtemp(join(tmpdir(), 'hephi-check-state-'))
  cleanup.push(stateDir)
  const c = context(r.dir, r.baseSha, timeoutMs)
  const execute = (tools: CheckTools, jobs?: NativeJobs, signal?: AbortSignal) =>
    runCheck({ stateDir, contract: c, checkId: 'build', outer: outer(signal), tools, jobs })
  return { r, stateDir, c, execute }
}

function bashResult(value: Record<string, unknown>): CheckTools {
  return { execute: async () => ({ isError: false, content: [], value } as never) }
}

function view(status: string, detail?: string): NativeJobView {
  return { status, ...(detail === undefined ? {} : { detail }) }
}

function read(text: string, lossy = false) {
  return { chunks: [{ at: 0, text }], lossy }
}

describe('native background check jobs', () => {
  it('waits on a promoted Job and records its real output and exit code', async () => {
    const x = await setup()
    const calls: Array<Record<string, unknown>> = []
    const jobs: NativeJobs = {
      wait: async (id, timeoutMs, caller, signal) => {
        calls.push({ op: 'wait', id, timeoutMs, caller, hasSignal: signal !== undefined })
        const persisted = (await readRuns(x.stateDir, 'ticket-1')).at(-1)
        expect(persisted?.jobId).toBe('bash-job')
        expect(persisted?.status).toBe('running')
        return view('completed', 'exit code: 0')
      },
      get: () => { throw new Error('unexpected get') },
      readAt: (id, from, caller) => {
        calls.push({ op: 'readAt', id, from, caller })
        return read('real output\n')
      },
      kill: () => { throw new Error('unexpected kill') },
    }
    const record = await x.execute(bashResult({ kind: 'promoted', jobId: 'bash-job', timeoutMs: 1000, output: 'initial\n' }), jobs)
    expect(record.status).toBe('passed')
    expect(record.jobId).toBe('bash-job')
    expect(record.exitCode).toBe(0)
    expect(record.outputHash).toBe(sha256('real output\n'))
    expect(await readFile(join(checkRunDir(x.stateDir, 'ticket-1', record.runId), 'output.log'), 'utf8')).toBe('real output\n')
    expect(calls[0]).toMatchObject({ op: 'wait', id: 'bash-job', caller: 'worker-session', hasSignal: true })
    expect(calls).toContainEqual({ op: 'readAt', id: 'bash-job', from: 0, caller: 'worker-session' })
  })

  it('polls again while the Job is still running instead of treating one wait as completion', async () => {
    const x = await setup()
    let waits = 0
    const jobs: NativeJobs = {
      wait: async () => {
        waits += 1
        return waits === 1 ? view('running') : view('completed', 'exit code: 0')
      },
      get: () => { throw new Error('unexpected get') },
      readAt: () => read('finished\n'),
      kill: () => { throw new Error('unexpected kill') },
    }
    const record = await x.execute(bashResult({ kind: 'background', jobId: 'bash-job' }), jobs)
    expect(record.status).toBe('passed')
    expect(waits).toBe(2)
  })

  it('preserves a failed Job real exit code and blocks it', async () => {
    const x = await setup()
    const jobs: NativeJobs = {
      wait: async () => view('failed', 'exit code: 2'),
      get: () => { throw new Error('unexpected get') },
      readAt: () => read('failure output\n'),
      kill: () => { throw new Error('unexpected kill') },
    }
    const record = await x.execute(bashResult({ kind: 'promoted', jobId: 'bash-job', timeoutMs: 1000, output: '' }), jobs)
    expect(record.status).toBe('blocked')
    expect(record.exitCode).toBe(2)
    expect(record.reason).toContain('native Job failed: exit code: 2')
    expect(await readFile(join(checkRunDir(x.stateDir, 'ticket-1', record.runId), 'output.log'), 'utf8')).toBe('failure output\n')
    expect((await readRuns(x.stateDir, 'ticket-1')).at(-1)?.jobId).toBe('bash-job')
  })

  it('kills and confirms a Job that outlives the contract deadline', async () => {
    const x = await setup(60)
    let killed = false
    const killCalls: Array<Record<string, unknown>> = []
    const jobs: NativeJobs = {
      wait: async (_id, timeoutMs) => {
        await new Promise(resolve => setTimeout(resolve, Math.min(timeoutMs, 20)))
        return view('running')
      },
      get: () => view(killed ? 'killed' : 'running'),
      readAt: () => read('partial\n'),
      kill: (id, caller, reason) => {
        killed = true
        killCalls.push({ id, caller, reason })
        return 'requested'
      },
    }
    const record = await x.execute(bashResult({ kind: 'promoted', jobId: 'bash-job', timeoutMs: 1000, output: '' }), jobs)
    expect(record.status).toBe('blocked')
    expect(record.exitCode).toBeNull()
    expect(record.reason).toContain('contract deadline')
    expect(killed).toBe(true)
    expect(killCalls).toContainEqual({ id: 'bash-job', caller: 'worker-session', reason: 'HEPHI check timeout or cancellation' })
  })

  it('cancels through the caller signal, kills the Job and confirms it stopped', async () => {
    const x = await setup()
    const controller = new AbortController()
    let killed = false
    const jobs: NativeJobs = {
      wait: async () => { controller.abort(); return view('running') },
      get: () => view('killed'),
      readAt: () => read('partial\n'),
      kill: () => { killed = true; return 'requested' },
    }
    const record = await x.execute(bashResult({ kind: 'promoted', jobId: 'bash-job', timeoutMs: 1000, output: '' }), jobs, controller.signal)
    expect(record.status).toBe('blocked')
    expect(record.reason).toContain('cancelled')
    expect(killed).toBe(true)
  })

  it('stays unknown when termination cannot be confirmed', async () => {
    const x = await setup(40)
    let killed = false
    const jobs: NativeJobs = {
      wait: async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
        return view('running')
      },
      get: () => { throw new Error('Job registry access lost') },
      readAt: () => read('partial\n'),
      kill: () => { killed = true; return 'requested' },
    }
    const record = await x.execute(bashResult({ kind: 'promoted', jobId: 'bash-job', timeoutMs: 1000, output: '' }), jobs)
    expect(record.status).toBe('unknown')
    expect(record.reason).toContain('termination is unconfirmed')
    expect(killed).toBe(true)
  })

  it('rejects a source change while the background Job was running', async () => {
    const x = await setup()
    let changed = false
    const jobs: NativeJobs = {
      wait: async () => {
        if (!changed) {
          changed = true
          await writeFile(join(x.r.dir, 'a.txt'), 'changed during check\n')
        }
        return view('completed', 'exit code: 0')
      },
      get: () => { throw new Error('unexpected get') },
      readAt: () => read('ok\n'),
      kill: () => { throw new Error('unexpected kill') },
    }
    const record = await x.execute(bashResult({ kind: 'promoted', jobId: 'bash-job', timeoutMs: 1000, output: '' }), jobs)
    expect(record.status).toBe('blocked')
    expect(record.reason).toBe('source changed during check')
  })

  it('blocks a confirmed terminal Job when its output ring lost bytes', async () => {
    const x = await setup()
    const jobs: NativeJobs = {
      wait: async () => view('completed', 'exit code: 0'),
      get: () => { throw new Error('unexpected get') },
      readAt: () => read('tail only\n', true),
      kill: () => { throw new Error('unexpected kill') },
    }
    const record = await x.execute(bashResult({ kind: 'promoted', jobId: 'bash-job', timeoutMs: 1000, output: '' }), jobs)
    expect(record.status).toBe('blocked')
    expect(record.reason).toContain('output was lost')
  })

  it('blocks a confirmed terminal Job when its result cannot be parsed', async () => {
    const x = await setup()
    const jobs: NativeJobs = {
      wait: async () => view('completed', 'terminated somehow'),
      get: () => { throw new Error('unexpected get') },
      readAt: () => read('done\n'),
      kill: () => { throw new Error('unexpected kill') },
    }
    const record = await x.execute(bashResult({ kind: 'promoted', jobId: 'bash-job', timeoutMs: 1000, output: '' }), jobs)
    expect(record.status).toBe('blocked')
    expect(record.exitCode).toBeNull()
    expect(record.reason).toContain('documented exit-code form')
  })

  it('records a non-cancellation wait failure and still stops and confirms the Job', async () => {
    const x = await setup()
    let killed = false
    const jobs: NativeJobs = {
      wait: async () => { throw new Error('registry transport closed') },
      get: () => view(killed ? 'killed' : 'running'),
      readAt: () => read('partial\n'),
      kill: () => { killed = true; return 'requested' },
    }
    const record = await x.execute(bashResult({ kind: 'promoted', jobId: 'bash-job', timeoutMs: 1000, output: '' }), jobs)
    expect(record.status).toBe('blocked')
    expect(record.reason).toContain('native Job wait failed: registry transport closed')
    expect(record.reason).not.toContain('cancelled')
    expect(killed).toBe(true)
  })

  it('keeps the original foreground pass, non-zero and source-change behavior', async () => {
    const x = await setup()
    const passed = await x.execute(bashResult({
      kind: 'foreground', cwd: x.r.dir, exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 5000,
      stdout: { text: 'ok\n', truncated: false }, stderr: { text: '', truncated: false },
    }))
    expect(passed.status).toBe('passed')
    expect(passed.jobId).toBeUndefined()
    const blocked = await x.execute(bashResult({
      kind: 'foreground', cwd: x.r.dir, exitCode: 3, signal: null, timedOut: false, aborted: false, timeoutMs: 5000,
      stdout: { text: '', truncated: false }, stderr: { text: 'bad\n', truncated: false },
    }))
    expect(blocked.status).toBe('blocked')
    expect(blocked.exitCode).toBe(3)
    const changed = await x.execute({
      execute: async () => {
        await writeFile(join(x.r.dir, 'a.txt'), 'changed during check\n')
        return {
          isError: false, content: [], value: {
            kind: 'foreground', cwd: x.r.dir, exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 5000,
            stdout: { text: 'ok\n', truncated: false }, stderr: { text: '', truncated: false },
          },
        } as never
      },
    })
    expect(changed.status).toBe('blocked')
    expect(changed.reason).toBe('source changed during check')
  })
})

/**
 * Simulated native Job registry: a bounded output ring that trims on every
 * append and once more on settlement, plus the synchronous event stream the
 * real host publishes. The retention simulation lets a test prove the check no
 * longer depends on re-reading a settled (already-trimmed) ring.
 */
type FakeChunk = { at: number; text: string; bytes: number; gapBefore?: true }

type FakeJob = {
  id: string
  owner?: string
  label: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  detail?: string
  total: number
  earliest: number
  retainedBytes: number
  chunks: FakeChunk[]
}

class FakeJobs implements NativeJobs {
  readonly reads: Array<{ id: string; from: number; caller?: string }> = []
  readonly kills: Array<{ id: string; caller?: string; reason?: string }> = []
  readonly waitCalls: Array<{ id: string; caller?: string }> = []
  readonly filters: Array<{ owner: string }> = []
  disposeCalls = 0
  waitHook?: (id: string) => void
  readHook?: (id: string, from: number) => unknown
  private readonly jobs = new Map<string, FakeJob>()
  private readonly listeners = new Set<(event: NativeJobEvent) => void>()
  private readonly session: string
  private readonly liveCap: number
  private readonly settledCap: number
  private readonly wholeChunks: boolean
  readonly events: { subscribe(filter: { owner: string }, listener: (event: NativeJobEvent) => void): () => void }

  constructor(session: string, options: { liveCap?: number; settledCap?: number; wholeChunks?: boolean } = {}) {
    this.session = session
    this.liveCap = options.liveCap ?? 256 * 1024
    this.settledCap = options.settledCap ?? 16 * 1024
    this.wholeChunks = options.wholeChunks === true
    this.events = {
      subscribe: (filter, listener) => {
        this.filters.push(filter)
        this.listeners.add(listener)
        return () => { this.disposeCalls += 1; this.listeners.delete(listener) }
      },
    }
  }

  register(id: string, owner: string | null = this.session, label = 'HEPHI check', seed = ''): void {
    const job: FakeJob = {
      id, ...(owner === null ? {} : { owner }), label, status: 'running', total: 0, earliest: 0, retainedBytes: 0, chunks: [],
    }
    this.jobs.set(id, job)
    // Seeding inside the starter call reaches the ring before the registration commit,
    // exactly like the host producer's first append.
    if (seed.length > 0) this.write(job, seed)
    this.emit({ type: 'registered', job: this.eventJob(job) })
  }

  append(id: string, text: string): void {
    const job = this.must(id)
    if (job.status !== 'running' || text.length === 0) return
    this.write(job, text)
    this.emitOutput(job)
  }

  private write(job: FakeJob, text: string): void {
    const bytes = Buffer.byteLength(text, 'utf8')
    job.chunks.push({ at: job.total, text, bytes })
    job.total += bytes
    job.retainedBytes += bytes
    this.trim(job, this.liveCap)
  }

  settle(id: string, status: 'completed' | 'killed' | 'failed', detail?: string): void {
    const job = this.must(id)
    if (job.status === 'completed' || job.status === 'killed' || job.status === 'failed') return
    job.status = status
    job.detail = detail
    this.trim(job, this.settledCap)
    this.emit({ type: 'settled', job: this.eventJob(job) })
    this.emitOutput(job)
  }

  emit(event: NativeJobEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  emitOutput(job: FakeJob): void {
    this.emit({ type: 'output', ...(job.owner === undefined ? {} : { owner: job.owner }), id: job.id, total: job.total })
  }

  get(id: string, _caller?: string): NativeJobView {
    const job = this.must(id)
    return { status: job.status, ...(job.detail === undefined ? {} : { detail: job.detail }) }
  }

  async wait(id: string, _timeoutMs: number, caller?: string): Promise<NativeJobView> {
    this.waitCalls.push({ id, caller })
    this.waitHook?.(id)
    return this.get(id)
  }

  readAt(id: string, from: number, caller?: string) {
    this.reads.push({ id, from, caller })
    const job = this.must(id)
    if (this.readHook !== undefined) return this.readHook(id, from) as never
    const lossy = from < job.earliest
    if (this.wholeChunks) {
      const text = job.chunks.map(chunk => chunk.text).join('')
      return { chunks: text === '' ? [] : [{ at: job.chunks[0]!.at, text }], next: job.total, lossy }
    }
    const chunks = job.chunks
      .filter(chunk => chunk.at + chunk.bytes > from)
      .map(chunk => ({ at: chunk.at, text: chunk.text, ...(chunk.gapBefore === undefined ? {} : { gapBefore: chunk.gapBefore }) }))
    return { chunks, next: job.total, lossy }
  }

  kill(id: string, caller?: string, reason?: string): 'requested' | 'already-finished' {
    const job = this.must(id)
    this.kills.push({ id, caller, reason })
    if (job.status === 'completed' || job.status === 'killed' || job.status === 'failed') return 'already-finished'
    job.status = 'killed'
    job.detail = reason
    this.trim(job, this.settledCap)
    this.emit({ type: 'settled', job: this.eventJob(job) })
    this.emitOutput(job)
    return 'requested'
  }

  private must(id: string): FakeJob {
    const job = this.jobs.get(id)
    if (job === undefined) throw new Error(`unknown Job ${id}`)
    return job
  }

  private eventJob(job: FakeJob): { id?: string; owner?: string; status?: string; detail?: string } {
    return {
      id: job.id,
      ...(job.owner === undefined ? {} : { owner: job.owner }),
      status: job.status,
      ...(job.detail === undefined ? {} : { detail: job.detail }),
    }
  }

  /** Mirror the host ring: evict whole head chunks, and cut one oversized chunk to its UTF-8-safe tail. */
  private trim(job: FakeJob, cap: number): void {
    while (job.retainedBytes > cap && job.chunks.length > 1) {
      const dropped = job.chunks.shift()
      if (dropped === undefined) break
      job.retainedBytes -= dropped.bytes
    }
    const single = job.chunks.length === 1 ? job.chunks[0] : undefined
    if (single !== undefined && single.bytes > cap) {
      const bytes = Buffer.from(single.text, 'utf8')
      let start = bytes.length - cap
      while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1
      const tail = bytes.subarray(start)
      single.at += single.bytes - tail.length
      single.text = tail.toString('utf8')
      single.bytes = tail.length
      single.gapBefore = true
      job.retainedBytes = tail.length
    }
    job.earliest = job.chunks[0]?.at ?? job.total
  }
}

const promotedJob = (jobId: string) => ({ kind: 'promoted', jobId, timeoutMs: 1000, output: '' })
const foregroundOk = (stdout: string) => ({
  kind: 'foreground', cwd: '.', exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 5000,
  stdout: { text: stdout, truncated: false }, stderr: { text: '', truncated: false },
})
const toolsThat = (start: () => void, value: Record<string, unknown>): CheckTools => ({
  execute: async () => { start(); return { isError: false, content: [], value } as never },
})
const outputLog = async (stateDir: string, runId: string) =>
  readFile(join(checkRunDir(stateDir, 'ticket-1', runId), 'output.log'), 'utf8')

describe('incremental native Job output collection', () => {
  it('collects output while the Job runs even when the settled ring can no longer be read from zero', async () => {
    const x = await setup()
    const jobs = new FakeJobs('worker-session', { liveCap: 4096, settledCap: 1024 })
    const parts = Array.from({ length: 20 }, (_, i) => `chunk-${i}-` + '世界'.repeat(160) + '\n')
    const tail = 'tail 🚀 done\n'
    jobs.waitHook = id => { jobs.append(id, tail); jobs.settle(id, 'completed', 'exit code: 0') }
    const record = await x.execute(toolsThat(() => {
      // The first chunk is ring seed output committed by the registration event.
      jobs.register('bash-job', 'worker-session', 'HEPHI build', parts[0])
      for (const part of parts.slice(1)) jobs.append('bash-job', part)
    }, promotedJob('bash-job')), jobs)
    const body = parts.join('') + tail
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(16 * 1024)
    expect(record.status).toBe('passed')
    expect(record.jobId).toBe('bash-job')
    expect(record.outputHash).toBe(sha256(body))
    expect(await outputLog(x.stateDir, record.runId)).toBe(body)
    expect(jobs.readAt('bash-job', 0).lossy).toBe(true)
    expect(jobs.filters).toEqual([{ owner: 'worker-session' }])
    expect(jobs.kills).toEqual([])
    expect(jobs.disposeCalls).toBe(1)
  })

  it('collects only the Job the native call returned, never unowned or foreign jobs', async () => {
    const x = await setup()
    const jobs = new FakeJobs('worker-session')
    jobs.waitHook = () => {
      // A registration after selection must be ignored before a collector exists.
      jobs.register('job-late', 'worker-session', 'same label')
      jobs.append('job-late', 'late\n')
      jobs.append('job-a', 'A late\n')
      jobs.append('job-b', 'B late\n')
      jobs.append('job-unowned', 'unowned late\n')
      jobs.append('job-foreign', 'foreign late\n')
      jobs.settle('job-b', 'completed', 'exit code: 0')
    }
    const record = await x.execute(toolsThat(() => {
      jobs.register('job-a', 'worker-session', 'same label')
      jobs.register('job-b', 'worker-session', 'same label')
      jobs.register('job-unowned', null, 'same label')
      jobs.register('job-foreign', 'other-session', 'same label')
      jobs.append('job-a', 'A only\n')
      jobs.append('job-b', 'B only\n')
      jobs.append('job-unowned', 'unowned\n')
      jobs.append('job-foreign', 'foreign\n')
    }, promotedJob('job-b')), jobs)
    expect(record.status).toBe('passed')
    expect(await outputLog(x.stateDir, record.runId)).toBe('B only\nB late\n')
    expect(jobs.kills).toEqual([])
  })

  it('tracks a UTF-8 byte cursor across overlapping chunks and empty advances', async () => {
    const x = await setup()
    const jobs = new FakeJobs('worker-session', { wholeChunks: true })
    jobs.waitHook = id => { jobs.append(id, '🚀'); jobs.emit({ type: 'output', id, owner: 'worker-session' }); jobs.settle(id, 'completed', 'exit code: 0') }
    const record = await x.execute(toolsThat(() => {
      jobs.register('bash-job')
      jobs.append('bash-job', '你好')
      jobs.emit({ type: 'output', id: 'bash-job', owner: 'worker-session' })
      jobs.append('bash-job', '世界')
    }, promotedJob('bash-job')), jobs)
    expect(record.status).toBe('passed')
    expect(await outputLog(x.stateDir, record.runId)).toBe('你好世界🚀')
  })

  const unsoundReads: Array<{ name: string; read: (from: number) => unknown }> = [
    { name: 'a lossy ring', read: from => ({ chunks: [], next: from, lossy: true }) },
    { name: 'a gap marker', read: from => ({ chunks: [{ at: from, text: 'x', gapBefore: true }], next: from + 1, lossy: false }) },
    { name: 'a backwards cursor', read: from => ({ chunks: [], next: Math.max(0, from - 1), lossy: false }) },
    { name: 'an uncovered advance', read: from => ({ chunks: [], next: from + 2, lossy: false }) },
    { name: 'a chunk gap', read: from => ({ chunks: [{ at: from + 2, text: 'xx' }], next: from + 4, lossy: false }) },
    { name: 'an unknown structure', read: () => null },
    { name: 'a fractional cursor', read: from => ({ chunks: [], next: from + 1.5, lossy: false }) },
    { name: 'a negative chunk offset', read: from => ({ chunks: [{ at: -1, text: 'x' }], next: from + 1, lossy: false }) },
  ]
  for (const unsound of unsoundReads) {
    it(`stops and blocks a Job when incremental collection hits ${unsound.name}`, async () => {
      const x = await setup()
      const jobs = new FakeJobs('worker-session')
      jobs.waitHook = id => jobs.append(id, 'more\n')
      const record = await x.execute(toolsThat(() => {
        jobs.register('bash-job')
        jobs.append('bash-job', 'seed\n')
        jobs.readHook = (_id, from) => unsound.read(from)
      }, promotedJob('bash-job')), jobs)
      expect(record.status).toBe('blocked')
      expect(record.reason).toContain('native Job output collection failed')
      expect(record.outputHash).toBeUndefined()
      expect(jobs.kills).toEqual([{ id: 'bash-job', caller: 'worker-session', reason: 'HEPHI check timeout or cancellation' }])
    })
  }

  it('still refuses output lost to a single retention window while the Job is live', async () => {
    const x = await setup()
    const jobs = new FakeJobs('worker-session', { liveCap: 64 })
    jobs.waitHook = id => jobs.append(id, 'x'.repeat(200))
    const record = await x.execute(toolsThat(() => jobs.register('bash-job'), promotedJob('bash-job')), jobs)
    expect(record.status).toBe('blocked')
    expect(record.reason).toContain('output was lost')
    expect(jobs.kills).toHaveLength(1)
  })

  it('cleans up events and stops only the returned Job on timeout and abort', async () => {
    const timedOut = await setup(60)
    const timeoutJobs = new FakeJobs('worker-session')
    timeoutJobs.waitHook = () => timeoutJobs.append('other-job', 'other late\n')
    const timeoutRecord = await timedOut.execute(toolsThat(() => {
      timeoutJobs.register('bash-job')
      timeoutJobs.register('other-job')
      timeoutJobs.append('other-job', 'other output\n')
    }, promotedJob('bash-job')), timeoutJobs)
    expect(timeoutRecord.status).toBe('blocked')
    expect(timeoutRecord.reason).toContain('contract deadline')
    expect(timeoutJobs.kills).toEqual([{ id: 'bash-job', caller: 'worker-session', reason: 'HEPHI check timeout or cancellation' }])
    expect(timeoutJobs.get('other-job').status).toBe('running')
    expect(timeoutJobs.disposeCalls).toBe(1)

    const aborted = await setup()
    const abortJobs = new FakeJobs('worker-session')
    const controller = new AbortController()
    abortJobs.waitHook = () => controller.abort()
    const abortRecord = await aborted.execute(toolsThat(() => {
      abortJobs.register('bash-job')
      abortJobs.register('other-job')
    }, promotedJob('bash-job')), abortJobs, controller.signal)
    expect(abortRecord.status).toBe('blocked')
    expect(abortRecord.reason).toContain('cancelled')
    expect(abortJobs.kills.map(kill => kill.id)).toEqual(['bash-job'])
    expect(abortJobs.get('other-job').status).toBe('running')
    expect(abortJobs.disposeCalls).toBe(1)
  })

  it('unsubscribes on pass, blocked exit and a throwing native call, and keeps foreground output', async () => {
    const passed = await setup()
    const passedJobs = new FakeJobs('worker-session')
    const passedRecord = await passed.execute(toolsThat(() => {
      passedJobs.register('other-job')
      passedJobs.append('other-job', 'background output\n')
    }, foregroundOk('ok\n')), passedJobs)
    expect(passedRecord.status).toBe('passed')
    expect(await outputLog(passed.stateDir, passedRecord.runId)).toBe('ok\n\n')
    expect(passedJobs.disposeCalls).toBe(1)

    const failed = await setup()
    const failedJobs = new FakeJobs('worker-session')
    failedJobs.waitHook = id => failedJobs.settle(id, 'completed', 'exit code: 3')
    const failedRecord = await failed.execute(toolsThat(() => failedJobs.register('bash-job'), promotedJob('bash-job')), failedJobs)
    expect(failedRecord.status).toBe('blocked')
    expect(failedRecord.exitCode).toBe(3)
    expect(failedJobs.disposeCalls).toBe(1)

    const thrown = await setup()
    const thrownJobs = new FakeJobs('worker-session')
    const thrownRecord = await thrown.execute({ execute: async () => { throw new Error('native bash failed to start') } }, thrownJobs)
    expect(thrownRecord.status).toBe('unknown')
    expect(thrownJobs.disposeCalls).toBe(1)
  })
})
