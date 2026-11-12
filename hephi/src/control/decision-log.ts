import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pluginCommit } from '../version.js'

/** Append-only decision log for one Ticket. Writes never change a decision. */
export const DECISION_LOG_VERSION = 1

/**
 * Effective Session-binding policy for one ready decision (A1-K5b).
 * `contract: null` records that the contract format predates the field (v1/v2);
 * `effective` is what the verifier actually enforced.
 */
export type DecisionBinding = { contract: boolean | null; host: boolean; effective: boolean }

export type DecisionLogInput = {
  ticketId: string
  sessionId?: string
  callId?: string
  tool: string
  mode: 'enforce' | 'shadow'
  effectiveDecision: 'allow' | 'deny'
  wouldDecision: 'allow' | 'deny'
  rule: string
  reason?: string
  contractHash?: string
  /** Additive optional field; DECISION_LOG_VERSION stays 1 because old readers ignore unknown keys. */
  binding?: DecisionBinding
  /**
   * v5.4 §2 ② record-only plan width (rule `plan.width`). Additive audit fields; the
   * decision they accompany is an allow observation and never gates ready.
   */
  planFiles?: number
  changedFiles?: number
  ratio?: number
  /**
   * v5.4 B2 observability: unknown fields from the host binding record are logged here
   * (rule `binding-record.warnings`). Additive; never changes the ready verdict.
   */
  warnings?: string[]
}

export type DecisionLogResult = { ok: true; seq: number } | { ok: false; logError: string }

export function decisionLogPath(stateDir: string, ticketId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(ticketId)) throw new Error('unsafe decision log ticket id')
  return join(stateDir, 'hephi', ticketId, 'decisions.jsonl')
}

// One in-process queue per log file keeps seq unique and ordered for concurrent calls.
const queues = new Map<string, Promise<unknown>>()

async function nextSeq(file: string): Promise<number> {
  let text: string
  try { text = await readFile(file, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 1
    throw error
  }
  const lines = text.split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]) as { seq?: unknown }
      if (Number.isSafeInteger(entry.seq)) return (entry.seq as number) + 1
    } catch { /* skip a corrupt tail line, the next seq still moves forward */ }
  }
  return lines.length + 1
}

/** Append one decision entry. A failure is reported, never thrown into the decision path. */
export async function appendDecision(stateDir: string, input: DecisionLogInput): Promise<DecisionLogResult> {
  let file: string
  try { file = decisionLogPath(stateDir, input.ticketId) } catch (error) {
    return { ok: false, logError: error instanceof Error ? error.message : String(error) }
  }
  const previous = queues.get(file) ?? Promise.resolve()
  const task = previous.catch(() => undefined).then(async () => {
    await mkdir(dirname(file), { recursive: true })
    const seq = await nextSeq(file)
    const entry = { version: DECISION_LOG_VERSION, seq, at: new Date().toISOString(), ...input, pluginCommit: pluginCommit() }
    await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    return seq
  })
  queues.set(file, task)
  try {
    return { ok: true, seq: await task }
  } catch (error) {
    return { ok: false, logError: error instanceof Error ? error.message : String(error) }
  } finally {
    if (queues.get(file) === task) queues.delete(file)
  }
}

/** Log without letting a log failure change or block the caller's decision. */
export async function logDecision(stateDir: string, input: DecisionLogInput): Promise<string | undefined> {
  const result = await appendDecision(stateDir, input)
  if (result.ok) return undefined
  const message = `HEPHI decision log write failed: ${result.logError}`
  console.error(message)
  return message
}
