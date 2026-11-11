#!/usr/bin/env node
/**
 * T11 recovery verification: build fabricated check-run records from a REAL 3085
 * ticket record template into a /tmp state-dir copy (never the real state dir).
 * Usage: node build-records.mjs <realTemplateRunJson> <tempStateRoot> <ticketId>
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [templatePath, stateRoot, ticketId] = process.argv.slice(2)
if (!templatePath || !stateRoot || !ticketId) throw new Error('usage: node build-records.mjs <template> <stateRoot> <ticket>')

const template = JSON.parse(await readFile(templatePath, 'utf8'))
const ticketDir = join(stateRoot, 'hephi', ticketId)
await mkdir(join(ticketDir, 'checks'), { recursive: true })

const now = Date.now()
const iso = ms => new Date(ms).toISOString()

function record(runId, sequence, checkId, fields) {
  return {
    version: 3,
    pluginCommit: template.pluginCommit,
    runId,
    sequence,
    ticketId,
    contractHash: template.contractHash,
    checkId,
    sessionId: template.sessionId,
    callId: `call_00_t11${String(sequence)}`,
    innerCallId: `hephi-t11-${checkId}-${runId.slice(0, 8)}`,
    argv: template.argv,
    cwd: template.cwd,
    startedAt: iso(now - 30 * 60_000),
    status: 'running',
    exitCode: null,
    before: template.before,
    ...fields,
  }
}

async function write(name, runId, value) {
  const dir = join(ticketDir, 'checks', runId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'run.json'), `${JSON.stringify(value, null, 2)}\n`)
  return dir
}

const runs = {
  stillRunning: '11111111-aaaa-4bbb-8ccc-111111111111',
  unavailable: '22222222-aaaa-4bbb-8ccc-222222222222',
  resultLost: '33333333-aaaa-4bbb-8ccc-333333333333',
  leftoverRunning: '44444444-aaaa-4bbb-8ccc-444444444444',
}

// 1) host still reports the execution as running: a real check process exists.
await write('still-running', runs.stillRunning, record(runs.stillRunning, 101, 'project-regression', {
  startedAt: iso(now - 2 * 60_000),
  status: 'running',
  exitCode: null,
}))

// 2) the host query is unavailable (operator cannot tell whether it ended).
await write('unavailable', runs.unavailable, record(runs.unavailable, 102, 'project-regression', {
  startedAt: iso(now - 10 * 60_000),
  status: 'unknown',
  exitCode: null,
  reason: 'Session ended before a foreground result was recorded; host terminal state unknown',
}))

// 3) host confirmed the execution ended, but its output/exit code was lost.
await write('result-lost', runs.resultLost, record(runs.resultLost, 103, 'acceptance', {
  startedAt: iso(now - 20 * 60_000),
  finishedAt: iso(now - 18 * 60_000),
  status: 'unknown',
  exitCode: null,
  reason: 'host confirmed the execution ended, but its output and exit code are unavailable',
}))

// 4) a running record left behind by a host crash (no process exists any more).
await write('leftover-running', runs.leftoverRunning, record(runs.leftoverRunning, 104, 'acceptance', {
  startedAt: iso(now - 120 * 60_000),
  status: 'running',
  exitCode: null,
}))

console.log(JSON.stringify({ ticketDir, runs }, null, 2))
