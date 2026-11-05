import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RepositoryFingerprint } from '../verification/fingerprint.js'

export type CheckRunRecord = {
  version: 2; runId: string; sequence: number; ticketId: string; contractHash: string;
  checkId: string; sessionId: string; callId: string; innerCallId: string;
  /** Native background Job id, persisted before waiting for its terminal state. */
  jobId?: string;
  argv: string[]; cwd: string; startedAt: string; finishedAt?: string;
  status: 'running' | 'passed' | 'blocked' | 'unknown'; exitCode: number | null;
  before: RepositoryFingerprint; after?: RepositoryFingerprint;
  outputHash?: string; reason?: string;
}
export function checkRunDir(stateDir: string, ticketId: string, runId = ''): string {
  if (!/^[\w-]+$/.test(ticketId) || (runId && !/^[\w-]+$/.test(runId))) throw new Error('unsafe evidence id')
  return join(stateDir, 'hephi', ticketId, 'checks', runId)
}
export async function saveRun(stateDir: string, record: CheckRunRecord): Promise<void> {
  const path = join(checkRunDir(stateDir, record.ticketId, record.runId), 'run.json')
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(record, null, 2), { flag: 'wx' })
  await rename(temp, path)
}
export async function readRuns(stateDir: string, ticketId: string): Promise<CheckRunRecord[]> {
  const dir = checkRunDir(stateDir, ticketId)
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
  const records: CheckRunRecord[] = []
  for (const entry of entries.filter(e => e.isDirectory())) {
    const value = JSON.parse(await readFile(join(dir, entry.name, 'run.json'), 'utf8')) as CheckRunRecord
    if (value.version !== 2 || value.runId !== entry.name || value.ticketId !== ticketId || !Number.isSafeInteger(value.sequence)
      || !['running', 'passed', 'blocked', 'unknown'].includes(value.status)) throw new Error('unsupported or corrupt check evidence')
    records.push(value)
  }
  return records.sort((a, b) => a.sequence - b.sequence)
}
