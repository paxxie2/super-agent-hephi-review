import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActivationContract } from '../../src/control/activation.js'
import type { VerificationCheck } from '../../src/contracts/checks.js'
import { runCheck, type CheckTools } from '../../src/control/check-runner.js'
import { checkRunDir, readRun, readRuns, snapshotSealShapeProblem, type CheckRunRecord, type SnapshotSeal } from '../../src/control/check-store.js'
import { readyRule, snapshotSealProblem } from '../../src/control/evidence-verifier.js'
import {
  MAX_SNAPSHOT_SEAL_BYTES, defaultSessionLogRoots, encodeSegment, findSessionLogFile, projectKey,
  readPersistedSessionLog, scanZstdFrames, sealSnapshotBytes, verifySnapshotBytes,
} from '../../src/control/snapshot-seal.js'

const run = promisify(execFile)
const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

const check: VerificationCheck = {
  id: 'build', kind: 'build', purpose: 'build', command: 'true', args: [], cwd: '.',
  required: true, timeoutMs: 5000,
}

async function repo(): Promise<{ dir: string; baseSha: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'hephi-seal-repo-'))
  cleanup.push(dir)
  await run('git', ['init', '-b', 'main', dir])
  await run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir })
  await run('git', ['config', 'user.name', 'Seal test'], { cwd: dir })
  await run('git', ['remote', 'add', 'origin', 'git@github.com:example/seal-fixture.git'], { cwd: dir })
  await writeFile(join(dir, 'a.txt'), 'base\n')
  await run('git', ['add', '.'], { cwd: dir })
  await run('git', ['commit', '-m', 'base'], { cwd: dir })
  const baseSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
  await writeFile(join(dir, 'a.txt'), 'patched\n')
  await run('git', ['add', '.'], { cwd: dir })
  await run('git', ['commit', '-m', 'patch'], { cwd: dir })
  return { dir, baseSha }
}

function context(dir: string, baseSha: string): ActivationContract {
  return {
    enabled: true, ticketId: 'ticket-1', repository: 'example/seal-fixture', issueNumber: 42,
    workspace: dir, baseRef: 'main', baseSha, allowedPaths: ['**'], requirePullRequest: false,
    verification: { version: 1, checks: [check] }, contractHash: 'sha256:test',
  }
}

function outer(): ToolExecution {
  return {
    callId: 'outer-check' as never, rootCallId: 'outer-check' as never, name: 'hephi_check',
    agent: { id: 'worker-session' } as never, arguments: { checkId: 'build' },
    signal: new AbortController().signal, token: Symbol('check') as never,
  }
}

function fakeTools(): CheckTools {
  return {
    execute: async () => ({
      isError: false, content: [],
      value: {
        kind: 'foreground', cwd: '.', exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000,
        stdout: { text: 'ok\n', truncated: false }, stderr: { text: '', truncated: false },
      },
    }) as never,
  }
}

async function runWithSeal(sealSnapshot?: Parameters<typeof runCheck>[0]['sealSnapshot']): Promise<{ record: CheckRunRecord; stateDir: string }> {
  const r = await repo()
  const stateDir = await mkdtemp(join(tmpdir(), 'hephi-seal-state-'))
  cleanup.push(stateDir)
  const record = await runCheck({ stateDir, contract: context(r.dir, r.baseSha), checkId: 'build', outer: outer(), tools: fakeTools(), sealSnapshot })
  return { record, stateDir }
}

/** A structurally valid zstd frame carrying `payload` as one raw (uncompressed) block. */
function rawZstdFrame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8')
  expect(body.length).toBeLessThan(256)
  const header = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20]) // magic + descriptor: single segment, no checksum/dict, 1-byte FCS
  const contentSize = Buffer.from([body.length])
  const headerValue = 0x01 | (body.length << 3) // last block, raw
  const blockHeader = Buffer.from([headerValue & 0xff, (headerValue >> 8) & 0xff, (headerValue >> 16) & 0xff])
  return Buffer.concat([header, contentSize, blockHeader, body])
}

const sealOf = (bytes: Buffer, format: 'jsonl' | 'jsonl.zstd'): SnapshotSeal => {
  const sealed = sealSnapshotBytes(bytes, format)
  if ('unavailable' in sealed) throw new Error(sealed.unavailable)
  return sealed.seal
}

describe('zstd frame structure (no decompression)', () => {
  it('walks complete frames and reports a frame-aligned EOF', () => {
    const bytes = Buffer.concat([rawZstdFrame('a'), rawZstdFrame('b')])
    const scan = scanZstdFrames(bytes)
    expect(scan).toEqual({ ok: true, frames: 2, endOffset: bytes.length, aligned: true })
  })

  it('reports a torn trailing fragment without rejecting the complete prefix', () => {
    const frame = rawZstdFrame('a')
    const scan = scanZstdFrames(Buffer.concat([frame, Buffer.from([0x00])]))
    expect(scan).toEqual({ ok: true, frames: 1, endOffset: frame.length, aligned: false })
  })

  it('rejects bytes outside the frame stream at a frame boundary', () => {
    const frame = rawZstdFrame('a')
    const scan = scanZstdFrames(Buffer.concat([frame, Buffer.from('garbage!')]))
    expect(scan.ok).toBe(false)
  })
})

describe('seal + verify of the persisted zstd log', () => {
  it('seals only complete frames and accepts a later legal (append-only) frame', () => {
    const first = rawZstdFrame('a')
    const withTornTail = Buffer.concat([first, Buffer.from([0x28])])
    const seal = sealOf(withTornTail, 'jsonl.zstd')
    expect(seal).toMatchObject({ format: 'jsonl.zstd', bytes: first.length, frames: 1 })
    const laterBatch = Buffer.concat([first, rawZstdFrame('b')])
    expect(verifySnapshotBytes(laterBatch, seal)).toEqual({ ok: true })
  })

  it('rejects a single byte appended outside the frame stream (after retryable classification)', () => {
    const bytes = rawZstdFrame('a')
    const seal = sealOf(bytes, 'jsonl.zstd')
    const result = verifySnapshotBytes(Buffer.concat([bytes, Buffer.from([0x00])]), seal)
    expect(result).toMatchObject({ ok: false, retryable: true })
  })

  it('rejects a rewritten prefix (same file, changed bytes, same length)', () => {
    const bytes = rawZstdFrame('a')
    const seal = sealOf(bytes, 'jsonl.zstd')
    const rewritten = Buffer.from(bytes)
    rewritten[rewritten.length - 1] = 0x21 // change the payload, keep the frame structure valid
    const result = verifySnapshotBytes(rewritten, seal)
    expect(result).toMatchObject({ ok: false, retryable: false })
    if (!result.ok) expect(result.problem).toMatch(/prefix digest changed/)
  })

  it('rejects a re-encoded prefix (different bytes, same sealed length)', () => {
    const bytes = rawZstdFrame('a')
    const seal = sealOf(bytes, 'jsonl.zstd')
    const reencoded = rawZstdFrame('z') // same length, different bytes
    const result = verifySnapshotBytes(reencoded.subarray(0, seal.bytes), seal)
    expect(result).toMatchObject({ ok: false, retryable: false })
  })

  it('rejects a truncated log shorter than the sealed prefix', () => {
    const bytes = Buffer.concat([rawZstdFrame('a'), rawZstdFrame('b')])
    const seal = sealOf(bytes, 'jsonl.zstd')
    const result = verifySnapshotBytes(bytes.subarray(0, seal.bytes - 1), seal)
    expect(result).toMatchObject({ ok: false, retryable: false })
  })
})

describe('seal + verify of a compression:none JSONL log', () => {
  it('seals complete lines and accepts later complete lines', () => {
    const bytes = Buffer.from('{"a":1}\n{"b":2}\n', 'utf8')
    const seal = sealOf(bytes, 'jsonl')
    expect(seal).toMatchObject({ format: 'jsonl', bytes: Buffer.byteLength('{"a":1}\n{"b":2}\n'), frames: 2 })
    expect(verifySnapshotBytes(bytes, seal)).toEqual({ ok: true })
    const appended = Buffer.concat([bytes, Buffer.from('{"c":3}\n', 'utf8')])
    expect(verifySnapshotBytes(appended, seal)).toEqual({ ok: true })
  })

  it('seals only the complete-line prefix when a torn line is already present at seal time', () => {
    const torn = Buffer.from('{"a":1}\n{"partial"', 'utf8')
    const seal = sealOf(torn, 'jsonl')
    expect(seal.bytes).toBe(Buffer.byteLength('{"a":1}\n'))
    // The bytes present at seal time are not verifiable as-is (the partial line is outside
    // the seal); once the line completes, verify passes again.
    expect(verifySnapshotBytes(torn, seal)).toMatchObject({ ok: false, retryable: true })
    expect(verifySnapshotBytes(Buffer.concat([torn, Buffer.from('\n', 'utf8')]), seal)).toEqual({ ok: true })
  })

  it('rejects a torn tail in the appended part until it becomes a complete line', () => {
    const bytes = Buffer.from('{"a":1}\n', 'utf8')
    const seal = sealOf(bytes, 'jsonl')
    const torn = verifySnapshotBytes(Buffer.concat([bytes, Buffer.from('{"b"', 'utf8')]), seal)
    expect(torn).toMatchObject({ ok: false, retryable: true })
    const complete = verifySnapshotBytes(Buffer.concat([bytes, Buffer.from('{"b":2}\n', 'utf8')]), seal)
    expect(complete).toEqual({ ok: true })
  })

  it('reports unavailable when the log has no complete line yet', () => {
    expect(sealSnapshotBytes(Buffer.from('{"a"', 'utf8'), 'jsonl')).toEqual({ unavailable: 'persisted Session log has no complete JSONL line yet' })
  })
})

describe('persisted log limits and DSH layout lookup', () => {
  it('refuses oversized logs through the 64MiB cap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hephi-seal-big-'))
    cleanup.push(dir)
    const path = join(dir, 'session.v4.jsonl.zstd')
    await writeFile(path, '')
    await truncate(path, MAX_SNAPSHOT_SEAL_BYTES + 1)
    const read = await readPersistedSessionLog(path)
    expect('unavailable' in read && read.unavailable).toMatch(/above the/)
    expect(MAX_SNAPSHOT_SEAL_BYTES).toBe(64 * 1024 * 1024)
  })

  it('finds the newest session.vN.jsonl[.zstd] under the DSH project layout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hephi-dsh-sessions-'))
    cleanup.push(root)
    const cwd = '/Users/zm/proj/workspace'
    const key = projectKey(cwd)
    expect(key).toBe('--Users-zm-proj-workspace--')
    expect(encodeSegment('a b/c')).toBe('a-b-c')
    const sessionDir = join(root, key, 'worker-ticket-1')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'session.v3.jsonl.zstd'), 'old')
    await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'new')
    const found = await findSessionLogFile({ roots: [root], sessionId: 'worker-ticket-1', sessionCwd: cwd })
    expect(found).toEqual({ path: join(sessionDir, 'session.v4.jsonl.zstd'), format: 'jsonl.zstd' })
    expect(await findSessionLogFile({ roots: [root], sessionId: 'worker-missing', sessionCwd: cwd })).toBeUndefined()
    expect(defaultSessionLogRoots(undefined, {}).at(-1)).toMatch(/\.dsh\/sessions$/)
  })
})

describe('check record seal shape and ready integration', () => {
  it('validates the seal shape fail-closed', () => {
    const seal = sealOf(rawZstdFrame('a'), 'jsonl.zstd')
    expect(snapshotSealShapeProblem(seal)).toBeUndefined()
    expect(snapshotSealShapeProblem({ ...seal, sha256: 'not-hex' })).toMatch(/sha256/)
    expect(snapshotSealShapeProblem({ ...seal, format: 'zstd' })).toMatch(/format/)
    expect(snapshotSealShapeProblem({ ...seal, bytes: -1 })).toMatch(/bytes/)
    expect(snapshotSealShapeProblem({ ...seal, frames: 0 })).toMatch(/frames/)
  })

  it('persists a successful seal without changing the check result', async () => {
    const seal = sealOf(rawZstdFrame('a'), 'jsonl.zstd')
    const { record, stateDir } = await runWithSeal(async () => ({ seal }))
    expect(record.status).toBe('passed')
    expect(record.snapshotSeal).toEqual(seal)
    expect(record.snapshotSealUnavailable).toBeUndefined()
    expect((await readRun(stateDir, 'ticket-1', record.runId)).snapshotSeal).toEqual(seal)
    expect((await readRuns(stateDir, 'ticket-1')).at(-1)?.snapshotSeal).toEqual(seal)
  })

  it('records unavailability on seal failure without changing the check result', async () => {
    const { record } = await runWithSeal(async () => { throw new Error('host adapter down') })
    expect(record.status).toBe('passed')
    expect(record.snapshotSeal).toBeUndefined()
    expect(record.snapshotSealUnavailable).toMatch(/snapshot seal failed: host adapter down/)
  })

  it('keeps the legacy behavior when the host adapter is not wired', async () => {
    const { record, stateDir } = await runWithSeal(undefined)
    expect(record.status).toBe('passed')
    expect(record.snapshotSeal).toBeUndefined()
    expect(record.snapshotSealUnavailable).toBeUndefined()
    const persisted = JSON.parse(await readFile(join(checkRunDir(stateDir, 'ticket-1', record.runId), 'run.json'), 'utf8'))
    expect(persisted.snapshotSeal).toBeUndefined()
  })
})

describe('ready.snapshot-tampered denial', () => {
  const baseRecord = { checkId: 'build', ticketId: 'ticket-1', runId: 'run-1' } as CheckRunRecord
  const input = { sessionId: 'worker-session', sessionCwd: '/work' }

  it('denies a record without a seal and an unavailable seal when the adapter is wired', async () => {
    const verifier = async () => ({ ok: true as const })
    await expect(snapshotSealProblem(baseRecord, { verifier, ...input })).resolves.toMatch(/no sealed Session snapshot digest/)
    const unavailable = { ...baseRecord, snapshotSealUnavailable: 'no persisted Session log' }
    await expect(snapshotSealProblem(unavailable, { verifier, ...input })).resolves.toMatch(/could not seal/)
  })

  it('denies a mismatching re-read and allows a matching one', async () => {
    const record = { ...baseRecord, snapshotSeal: sealOf(rawZstdFrame('a'), 'jsonl.zstd') }
    const mismatch = await snapshotSealProblem(record, { verifier: async () => ({ ok: false, problem: 'prefix changed' }), ...input })
    expect(mismatch).toMatch(/ready\.snapshot-tampered: build: prefix changed/)
    await expect(snapshotSealProblem(record, { verifier: async () => ({ ok: true }), ...input })).resolves.toBeUndefined()
  })

  it('keeps the legacy behavior when no verifier is wired and maps the rule', async () => {
    await expect(snapshotSealProblem(baseRecord, input)).resolves.toBeUndefined()
    expect(readyRule('ready.snapshot-tampered: build: prefix changed')).toBe('ready.snapshot-tampered')
  })
})
