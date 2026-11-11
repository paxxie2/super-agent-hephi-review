#!/usr/bin/env node
/** Structural validation of the T11 evidence directory (no host access). */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ev = process.argv[2]
if (!ev) throw new Error('usage: node validate-evidence.mjs <evidence-dir>')
const read = p => readFileSync(join(ev, p), 'utf8')
const rows = read('recoveries.jsonl').trim().split('\n').map(line => JSON.parse(line))
const by = Object.fromEntries(rows.map(row => [row.scenario, row]))
const results = []
function check(name, condition, detail = '') {
  results.push(`${condition ? 'PASS' : 'FAIL'} ${name}${condition ? '' : ` :: ${detail}`}`)
  if (!condition) process.exitCode = 1
}

check('recoveries.jsonl parses with 5 rows (4 recoveries + 1 authorization gate)',
  rows.length === 5 && rows.filter(r => r.kind === 'recovery').length === 4 && by['operator-gate']?.kind === 'authorization-gate',
  `rows=${rows.length}`)
for (const scenario of ['still-running', 'query-unavailable', 'result-lost', 'leftover-running']) {
  check(`${scenario}: ticket/run scoped and contract hash recorded`,
    typeof by[scenario]?.ticketId === 'string' && typeof by[scenario]?.runId === 'string'
    && /^sha256:[0-9a-f]{64}$/.test(by[scenario]?.resolution?.contractHash ?? ''),
    JSON.stringify({ ticket: by[scenario]?.ticketId, run: by[scenario]?.runId }))
}
check('still-running: first attempt refused with exit 1 and the running message',
  by['still-running'].firstFailure.exitCode === 1 && /host still reports the check as running/.test(by['still-running'].firstFailure.stderr))
check('still-running: recovery recorded (exit 0) and the original record bytes are unchanged',
  by['still-running'].recovery.exitCode === 0 && by['still-running'].postState.runJsonUnchanged === true
  && by['still-running'].postState.status === 'running')
check('still-running: idempotent repeat adds no record',
  by['still-running'].idempotentRepeat.exitCode === 0 && /already recorded/.test(by['still-running'].idempotentRepeat.stdout))
check('query-unavailable: refused without explicit risk acceptance (exit 2)',
  by['query-unavailable'].firstFailure.exitCode === 2 && /--accept-risk/.test(by['query-unavailable'].firstFailure.stderr))
check('query-unavailable: wrong basis refused (exit 2) and recovery uses operator-risk-accepted',
  by['query-unavailable'].guardFailure.exitCode === 2
  && by['query-unavailable'].recovery.exitCode === 0
  && by['query-unavailable'].resolution.basis === 'operator-risk-accepted'
  && by['query-unavailable'].authorization.acceptRisk === true)
check('query-unavailable: the failed host query (curl exit 7) is recorded as the authorization basis',
  by['query-unavailable'].hostQueryFailure.exitCode === 7 && /Couldn't connect to server/.test(by['query-unavailable'].hostQueryFailure.stderr))
check('result-lost: host-terminal resolution allowed (exit 0) but the execution is not passing evidence',
  by['result-lost'].recovery.exitCode === 0 && by['result-lost'].postState.passEvidence === false
  && by['result-lost'].postState.status === 'unknown' && by['result-lost'].postState.hasOutputLog === false)
check('leftover-running: refused without host query (exit 2) and while classified running (exit 1)',
  by['leftover-running'].firstFailure.exitCode === 2 && /must not be empty/.test(by['leftover-running'].firstFailure.stderr)
  && by['leftover-running'].guardFailure.exitCode === 1)
check('leftover-running: host query found no process, resolution recorded, repeat is idempotent',
  /no process matches 'hephi-t11-acceptance-44444444'/.test(by['leftover-running'].hostQueryBefore)
  && by['leftover-running'].recovery.exitCode === 0
  && /already recorded/.test(by['leftover-running'].idempotentRepeat.stdout)
  && by['leftover-running'].postState.runJsonUnchanged === true)
check('operator-gate: no config / group-readable config / env-only are all refused (exit 1) without writing a resolution',
  by['operator-gate'].firstFailure.exitCode === 1
  && by['operator-gate'].guardFailure.exitCode === 1
  && by['operator-gate'].envOnlyFailure.exitCode === 1
  && by['operator-gate'].postState.resolutionsAppended === 0)
check('host facts identify the 3085 deployment and the CLI digest',
  /commit=ab5f527a11655dd3e935a634d3b5c62f0a265f51/.test(read('raw/00-host-facts/host-facts.txt'))
  && /f518b2f05e58a7ecff008ac56497b05fb50f1ad01c837832b099fabd3c7cafd6/.test(read('raw/00-host-facts/host-facts.txt')))
check('real 3085 state directory is byte-identical before and after (no pollution)',
  read('raw/06-real-state-untouched/real-state-diff.txt').includes('PASS: real 3085 ticket state files unchanged'))
check('3086 frozen control was not started by this verification',
  /3086 frozen control \(read-only probe; not touched\)[^\n]*\n[^\n]*http=000/.test(read('raw/00-host-facts/host-facts.txt')))

for (const line of results) console.log(line)
console.log(`\n${results.filter(line => line.startsWith('PASS')).length}/${results.length} checks passed`)
