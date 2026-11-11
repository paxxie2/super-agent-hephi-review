/**
 * H6=C detect-only hardening: seal the Worker Session's persisted log at check
 * completion and re-verify the sealed prefix before ready.
 *
 * This is a DETECTION mechanism, not a protection: the Worker runs as the same OS
 * user as the host, so a Worker that owns an equivalent shell can rewrite the
 * persisted log (or the run record that holds the seal). The seal only makes two
 * tampering shapes observable:
 *
 * 1. bytes inside the sealed prefix changed (rewrite/re-encoding), and
 * 2. bytes were appended outside the persisted log's zstd frame stream (for
 *    example `printf x >> session.vN.jsonl.zstd`).
 *
 * The persisted log is append-only during a live Session, so the seal covers only the
 * complete-frame (or complete-JSONL-line) prefix observed at check completion; later
 * legitimate batches are new frames after `seal.bytes` and are not treated as
 * tampering. A forged *valid* appended frame is indistinguishable from a host batch by
 * design (same UID, same write channel) and stays a documented limitation.
 *
 * No zstd library is used: only the frame/block headers are walked structurally, which
 * is enough to find the last complete frame boundary. Host interface dependency: the
 * `sessionQuery.readSession` view returns parsed events, not raw bytes, so the host
 * adapter (`src/index.ts`) locates the persisted log through the deployment's session
 * root and reads it here. When it is unavailable the runner records
 * `snapshotSealUnavailable` and ready fails closed (binding effective only).
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SnapshotSeal } from './check-store.js'

export type SnapshotFormat = SnapshotSeal['format']

/** Refuse to seal/verify absurdly large logs (a whole-file read is required for the tail check). */
export const MAX_SNAPSHOT_SEAL_BYTES = 64 * 1024 * 1024
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const
/** Base name of the JSONL persistence generations, e.g. session.v4.jsonl.zstd. */
const SESSION_LOG_NAME = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/

/** Why a seal could not be taken; recorded on the run record and denied at ready. */
export type SnapshotSealUnavailable = { unavailable: string }
export type SnapshotSealResult = { seal: SnapshotSeal } | SnapshotSealUnavailable

/** Host adapter: seal the Worker Session's persisted log (raw bytes) at check completion. */
export type SnapshotSealProvider = (sessionId: string, sessionCwd?: string) => Promise<SnapshotSealResult>

/** Host adapter: re-read the persisted log and verify the sealed prefix before ready. */
export type SnapshotSealVerifier = (input: {
  sessionId: string
  sessionCwd?: string
  seal: SnapshotSeal
}) => Promise<{ ok: true } | { ok: false; problem: string }>

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The last offset after a complete JSONL line (`\n`); 0 when there is no complete line. */
function lastCompleteLineEnd(bytes: Buffer): number {
  return bytes.lastIndexOf(0x0a) + 1
}

type ZstdFrameScan =
  | { ok: true; frames: number; endOffset: number; aligned: boolean }
  | { ok: false; problem: string }

/**
 * Walk zstd frame/block headers without decompressing. `endOffset` is the end of the
 * last *complete* frame (`frames` of them); `aligned` says whether the stream ends
 * exactly there. A short trailing fragment is reported as a (retryable) torn tail;
 * bytes that are not a frame at a frame boundary are a structural error.
 */
export function scanZstdFrames(bytes: Buffer): ZstdFrameScan {
  let offset = 0
  let frames = 0
  while (offset < bytes.length) {
    if (bytes.length - offset < 4) {
      // A live append can tear the next frame; this is the retryable tail case.
      return { ok: true, frames, endOffset: offset, aligned: false }
    }
    if (bytes[offset] !== ZSTD_MAGIC[0] || bytes[offset + 1] !== ZSTD_MAGIC[1]
      || bytes[offset + 2] !== ZSTD_MAGIC[2] || bytes[offset + 3] !== ZSTD_MAGIC[3]) {
      // Not a frame at a frame boundary: bytes outside the zstd frame stream.
      return { ok: false, problem: `persisted log has bytes outside the zstd frame stream at offset ${offset}` }
    }
    if (bytes.length - offset < 5) return { ok: true, frames, endOffset: offset, aligned: false }
    const descriptor = bytes[offset + 4]!
    const contentSizeFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const checksumFlag = (descriptor >> 2) & 1
    const dictIdFlag = descriptor & 3
    let cursor = offset + 5
    if (singleSegment === 0) cursor += 1 // window descriptor
    cursor += dictIdFlag === 1 ? 1 : dictIdFlag === 2 ? 2 : dictIdFlag === 3 ? 4 : 0
    // FCS sizes: single-segment uses 1/2/4/8; otherwise 0/2/4/8 (flag 0 means absent).
    const contentSizeBytes = singleSegment === 1
      ? (contentSizeFlag === 0 ? 1 : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8)
      : (contentSizeFlag === 0 ? 0 : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8)
    cursor += contentSizeBytes
    if (cursor > bytes.length) return { ok: true, frames, endOffset: offset, aligned: false }
    // Blocks: 3-byte little-endian header = lastBlock(1) | blockType(2) | blockSize(21).
    for (;;) {
      if (bytes.length - cursor < 3) return { ok: true, frames, endOffset: offset, aligned: false }
      const header = bytes[cursor]! | (bytes[cursor + 1]! << 8) | (bytes[cursor + 2]! << 16)
      const lastBlock = header & 1
      const blockType = (header >> 1) & 3
      const blockSize = header >> 3
      if (blockType === 3) return { ok: false, problem: `persisted log has a reserved zstd block type at offset ${cursor}` }
      const payload = blockType === 1 ? 1 : blockSize // RLE block carries one byte of payload
      cursor += 3 + payload
      if (cursor > bytes.length) return { ok: true, frames, endOffset: offset, aligned: false }
      if (lastBlock === 1) break
    }
    if (checksumFlag === 1) {
      cursor += 4
      if (cursor > bytes.length) return { ok: true, frames, endOffset: offset, aligned: false }
    }
    frames += 1
    offset = cursor
  }
  return { ok: true, frames, endOffset: offset, aligned: true }
}

function makeSeal(prefix: Buffer, format: SnapshotFormat, units: number): SnapshotSeal {
  return { format, bytes: prefix.length, sha256: sha256Hex(prefix), frames: units }
}

/** Seal the complete-unit prefix of the persisted log (never a torn trailing unit). */
export function sealSnapshotBytes(bytes: Buffer, format: SnapshotFormat): SnapshotSealResult {
  if (bytes.length > MAX_SNAPSHOT_SEAL_BYTES) {
    return { unavailable: `persisted Session log is ${bytes.length} bytes, above the ${MAX_SNAPSHOT_SEAL_BYTES}-byte seal cap` }
  }
  if (format === 'jsonl.zstd') {
    const scan = scanZstdFrames(bytes)
    if (!scan.ok) return { unavailable: scan.problem }
    if (scan.frames === 0) return { unavailable: 'persisted Session log has no complete zstd frame yet' }
    return { seal: makeSeal(bytes.subarray(0, scan.endOffset), format, scan.frames) }
  }
  const end = lastCompleteLineEnd(bytes)
  if (end === 0) return { unavailable: 'persisted Session log has no complete JSONL line yet' }
  const prefix = bytes.subarray(0, end)
  let lines = 0
  for (let i = 0; i < prefix.length; i += 1) if (prefix[i] === 0x0a) lines += 1
  return { seal: makeSeal(prefix, format, lines) }
}

export type SnapshotVerifyFailure = { ok: false; problem: string; retryable: boolean }
export type SnapshotVerifyResult = { ok: true } | SnapshotVerifyFailure

/**
 * Verify a sealed persisted log: (a) the sealed prefix digest is unchanged, and
 * (b) everything after the sealed prefix is a complete unit stream ending exactly at
 * EOF. A torn trailing unit (live append in flight) is retryable; a changed prefix or
 * bytes outside the frame stream are definitive failures.
 */
export function verifySnapshotBytes(bytes: Buffer, seal: SnapshotSeal): SnapshotVerifyResult {
  if (bytes.length > MAX_SNAPSHOT_SEAL_BYTES) {
    return { ok: false, problem: `persisted Session log is ${bytes.length} bytes, above the ${MAX_SNAPSHOT_SEAL_BYTES}-byte verify cap`, retryable: false }
  }
  if (!Number.isSafeInteger(seal.bytes) || seal.bytes < 0 || seal.bytes > bytes.length) {
    return { ok: false, problem: `persisted Session log is shorter than the sealed ${seal.bytes}-byte prefix`, retryable: false }
  }
  const prefix = bytes.subarray(0, seal.bytes)
  if (sha256Hex(prefix) !== seal.sha256) {
    return { ok: false, problem: 'the sealed Session snapshot prefix digest changed (rewrite/re-encoding)', retryable: false }
  }
  const tail = bytes.subarray(seal.bytes)
  if (seal.format === 'jsonl.zstd') {
    const scan = scanZstdFrames(tail)
    if (!scan.ok) return { ok: false, problem: scan.problem, retryable: false }
    if (!scan.aligned) return { ok: false, problem: 'the persisted Session log ends mid-frame (torn tail)', retryable: true }
    return { ok: true }
  }
  if (tail.length > 0 && tail[tail.length - 1] !== 0x0a) {
    return { ok: false, problem: 'the persisted JSONL Session log ends mid-line (torn tail)', retryable: true }
  }
  return { ok: true }
}

/** Read the persisted log bytes with the same 64MiB cap used by seal/verify. */
export async function readPersistedSessionLog(path: string): Promise<{ bytes: Buffer } | SnapshotSealUnavailable> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return { unavailable: `persisted Session log is not a regular file: ${path}` }
    if (info.size > MAX_SNAPSHOT_SEAL_BYTES) {
      return { unavailable: `persisted Session log is ${info.size} bytes, above the ${MAX_SNAPSHOT_SEAL_BYTES}-byte cap: ${path}` }
    }
    return { bytes: await readFile(path) }
  } catch (error) {
    return { unavailable: `persisted Session log is unreadable (${path}): ${error instanceof Error ? error.message : String(error)}` }
  }
}

export type PersistedSessionLog = { path: string; format: SnapshotFormat }

/** DSH encodes path segments with non-alphanumerics collapsed to dashes. */
export function encodeSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9]/g, '-')
}

/** The DSH project directory name for a workspace cwd, e.g. `--Users-zm-proj--`. */
export function projectKey(cwd: string): string {
  const segments = cwd.split(/[\\/]+/).filter(segment => segment.length > 0).map(encodeSegment)
  return `--${segments.join('-')}--`
}

/** The default search roots for the persisted Session log (host `sessionLogRoot` wins). */
export function defaultSessionLogRoots(configured?: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [configured, env.DSH_SESSION_ROOT, env.DSH_HOME ? join(env.DSH_HOME, 'sessions') : undefined, join(homedir(), '.dsh', 'sessions')]
  return roots.filter((root): root is string => typeof root === 'string' && root.trim().length > 0)
}

function newestLogIn(dir: string, names: string[]): PersistedSessionLog | undefined {
  const candidates = names.filter(name => SESSION_LOG_NAME.test(name))
  if (candidates.length === 0) return undefined
  const ranked = candidates.map(name => {
    const match = SESSION_LOG_NAME.exec(name)!
    const version = match[1] === undefined ? 0 : Number(match[1])
    return { name, version, zstd: name.endsWith('.zstd') }
  }).sort((a, b) => b.version - a.version || Number(b.zstd) - Number(a.zstd))
  const best = ranked[0]!
  return { path: join(dir, best.name), format: best.zstd ? 'jsonl.zstd' : 'jsonl' }
}

function dirMatchesSession(name: string, sessionId: string): boolean {
  return name === sessionId || name.startsWith(sessionId) || sessionId.endsWith(name) || name.endsWith(sessionId)
}

async function findInProjectDir(projectDir: string, sessionId: string): Promise<PersistedSessionLog | undefined> {
  let entries
  try { entries = await readdir(projectDir, { withFileTypes: true }) } catch { return undefined }
  for (const entry of entries) {
    if (!entry.isDirectory() || !dirMatchesSession(entry.name, sessionId)) continue
    const sessionDir = join(projectDir, entry.name)
    let names: string[]
    try { names = (await readdir(sessionDir)).filter(name => SESSION_LOG_NAME.test(name)) } catch { continue }
    const log = newestLogIn(sessionDir, names)
    if (log) return log
  }
  return undefined
}

async function scanRoot(root: string, sessionId: string, depth: number): Promise<PersistedSessionLog | undefined> {
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return undefined }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    if (dirMatchesSession(entry.name, sessionId)) {
      const names = (await readdir(dir).catch(() => [] as string[])).filter(name => SESSION_LOG_NAME.test(name))
      const log = newestLogIn(dir, names)
      if (log) return log
    }
    if (depth > 1) {
      const nested = await scanRoot(dir, sessionId, depth - 1)
      if (nested) return nested
    }
  }
  return undefined
}

/**
 * Locate the persisted log for a Session under the DSH JSONL layout:
 * `<root>/<projectKey(cwd)>/<session dir>/session.vN.jsonl[.zstd]`. When the workspace
 * cwd is unknown every project directory is scanned; a bounded recursive scan is the
 * fallback so a renamed layout still fails safe (undefined → seal unavailable).
 */
export async function findSessionLogFile(options: {
  roots: string[]
  sessionId: string
  sessionCwd?: string
}): Promise<PersistedSessionLog | undefined> {
  const { roots, sessionId, sessionCwd } = options
  for (const root of roots) {
    if (sessionCwd !== undefined && sessionCwd.length > 0) {
      const found = await findInProjectDir(join(root, projectKey(sessionCwd)), sessionId)
      if (found) return found
    }
    let projectDirs: string[] = []
    try { projectDirs = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => join(root, entry.name)) } catch { continue }
    for (const projectDir of projectDirs) {
      const found = await findInProjectDir(projectDir, sessionId)
      if (found) return found
    }
    const scanned = await scanRoot(root, sessionId, 3)
    if (scanned) return scanned
  }
  return undefined
}
