#!/usr/bin/env node
// Extract MECHANICAL diff metrics for A/B delivery runs. This script does not
// judge effectiveness: unrelated changes, objective changes, test weakening and
// all other effect conclusions belong to the B4 blind-review rubric and the B6
// statistics (eval/stats/report.py) computed from run.schema.json records.
//
// Deliberately removed (plan review P2/§B6): the format-only and rename
// estimates (`formatOnlyFiles`, `renames`), their `unrelatedRefactor` aggregate
// and `verdict.effective`. Those were heuristics, not measurements: formatting,
// rename and refactor classification cannot be decided mechanically, so the
// script must not emit them and must not produce an "effective" verdict.
//
//   node eval/ab-metrics.mjs eval/runs.json
//   node eval/ab-metrics.mjs --self-test
//
// T04: the same entry point also builds the task-level evaluation summary from
// the T04 run fields (`ticketIds`, `firstReviewCandidate`, `finalCandidate`,
// `acceptanceVerdict`, `mergedAt`, `sevenDayOutcome`, `queueWaitSeconds`,
// `reviewWaitSeconds`) and scores eight metrics against a fixed anchor table.
// See the T04 section below; no historical baseline is consulted.
//
// runs.json:
// {
//   "tasks": { "<taskId>": { "expectedFiles": ["glob", ...], "hiddenTest": "shell command run in the checkout" } },
//   "runs": [ { "task": "<taskId>", "arm": "off|native|staged", "repo": "/path/to/checkout", "base": "<sha>", "head": "<ref>",
//               "minutes": 12.5, "tokens": 180000, "readyDenials": 1, "humanDriftScore": 0 } ]
// }
//
// Mechanical fields per run: changed files/lines, outside-share, deleted tests,
// hidden-test pass (when configured), and the recorded cost/drift inputs.
// The checkout is left at its original HEAD; hidden tests run in a temporary worktree.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { matchesGlob } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const TEST = ['**/test/**', '**/tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/*Test.java', '**/*_test.go', '**/test_*.py']
const matches = (file, globs) => globs.some(glob => matchesGlob(file, glob))

/** Mechanical measurements only. No heuristic classification, no verdict. */
export function measure(run, task) {
  const range = [run.base, run.head]
  const files = git(run.repo, 'diff', '--name-only', '--no-renames', ...range).split('\n').filter(Boolean)
  const lines = new Map()
  for (const row of git(run.repo, 'diff', '--numstat', '--no-renames', ...range).split('\n').filter(Boolean)) {
    const [added, removed, file] = row.split('\t')
    lines.set(file, added === '-' ? 1 : Number(added) + Number(removed))
  }
  const deleted = git(run.repo, 'diff', '--name-only', '--no-renames', '--diff-filter=D', ...range).split('\n').filter(Boolean)
  const outside = files.filter(file => !matches(file, task.expectedFiles))
  const totalLines = [...lines.values()].reduce((a, b) => a + b, 0)
  const outsideLines = outside.reduce((sum, file) => sum + (lines.get(file) ?? 0), 0)
  let hiddenPass = null
  if (task.hiddenTest) {
    const tree = mkdtempSync(join(tmpdir(), 'ab-hidden-'))
    rmSync(tree, { recursive: true })
    git(run.repo, 'worktree', 'add', '--detach', tree, run.head)
    try {
      execFileSync('sh', ['-c', task.hiddenTest], { cwd: tree, stdio: 'ignore', timeout: 30 * 60 * 1000 })
      hiddenPass = true
    } catch { hiddenPass = false } finally { git(run.repo, 'worktree', 'remove', '--force', tree) }
  }
  return {
    task: run.task, arm: run.arm, files: files.length, lines: totalLines,
    outsideFiles: outside.length, outsideLines, outsideShare: totalLines ? outsideLines / totalLines : 0,
    deletedTests: deleted.filter(file => matches(file, TEST)).length,
    hiddenPass, minutes: run.minutes ?? null, tokens: run.tokens ?? null, readyDenials: run.readyDenials ?? null,
    humanDriftScore: run.humanDriftScore ?? null,
  }
}

const mean = values => { const v = values.filter(x => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }

/** Per-arm means of the mechanical metrics. Effect tests are NOT computed here. */
export function summarize(rows) {
  const arms = {}
  for (const arm of [...new Set(rows.map(r => r.arm))]) {
    const r = rows.filter(row => row.arm === arm)
    arms[arm] = {
      runs: r.length,
      files: mean(r.map(x => x.files)),
      lines: mean(r.map(x => x.lines)),
      outsideFiles: mean(r.map(x => x.outsideFiles)),
      outsideLines: mean(r.map(x => x.outsideLines)),
      outsideShare: mean(r.map(x => x.outsideShare)),
      deletedTests: mean(r.map(x => x.deletedTests)),
      hiddenPassRate: mean(r.map(x => x.hiddenPass === null ? null : Number(x.hiddenPass))),
      humanDriftScore: mean(r.map(x => x.humanDriftScore)),
      minutes: mean(r.map(x => x.minutes)), tokens: mean(r.map(x => x.tokens)), readyDenials: mean(r.map(x => x.readyDenials)),
    }
  }
  return { arms }
}

// ---------------------------------------------------------------------------
// T04: structured evaluation collection + anchored scoring (AT-60 .. AT-64)
//
// Runs that share a taskId belong to the same task: their failures and costs are
// merged into one task aggregate first (AT-60), so one task delivered through
// several tickets is not counted several times.
//
// Eight metrics are scored against a fixed anchor table (AT-62). Anchors are the
// constants BELOW: no historical baseline and no per-batch reference data are
// read. 合格交付率 uses the task-defined anchors 86% => 100 and 60% => 0
// (linear between them).
//
// Missing values are never treated as zero: the metric becomes "unknown" and the
// total score is judged 不达标 (AT-61). When the observation window is shorter
// than 7 days or no merged PR is observable, no total score is produced and the
// rework rate is reported as 证据不足 (AT-64).
//
// Task-level aggregation rules:
//   * acceptance: failed beats passed; invalid only when neither passed nor
//     failed is known.
//   * merged: any ticket of the task merged => the task counts as merged.
//   * sevenDayOutcome: rework beats clean; pending / not-applicable are not
//     observable outcomes.
//   * costs (wall clock, tokens, queue/review waits): summed over the task's
//     tickets; the task value is null when any ticket of the task lacks it.
//   * first review pass: firstReviewCandidate.head === finalCandidate.head.
// Task-level costs / waits are aggregated across tasks by median.
//
// F07: a metric is scored only when EVERY task in scope has the value. A known
// subset may still be displayed, but the metric is marked `incomplete` and no
// total score is released (partial data can no longer produce a full score).
// AT-61's all-values-missing case remains `unknown`/不达标.
//
// F08: observation sufficiency is judged per task, not from the earliest merge
// in the batch: every task must be merged, have a parseable mergedAt at least
// 7 days old, and have an observable sevenDayOutcome. Any pending/fresh task
// withholds the batch total (evidence-insufficient); no subset total is emitted.
//
// F17: T04 scoring is single-arm/single-batch only. The entry rejects mixed
// `arm`/`batch` inputs and any repetition>=2 main record; tickets of the same
// arm+batch still merge under their taskId.
// ---------------------------------------------------------------------------
export const OBSERVATION_DAYS_REQUIRED = 7

/** Fixed T04 anchors. direction=higher: full > zero; direction=lower: full < zero. */
export const METRIC_ANCHORS = Object.freeze({
  acceptanceRate: { direction: 'higher', zero: 0.60, full: 0.86, unit: 'ratio', label: '合格交付率' },
  mergeRate: { direction: 'higher', zero: 0.50, full: 0.90, unit: 'ratio', label: '合并率' },
  firstReviewPassRate: { direction: 'higher', zero: 0.40, full: 0.80, unit: 'ratio', label: '首审即终审率' },
  reworkRate: { direction: 'lower', zero: 0.30, full: 0.00, unit: 'ratio', label: '7 日返修率' },
  queueWaitSeconds: { direction: 'lower', zero: 1800, full: 60, unit: 'seconds', label: '队列等待（任务累计）' },
  reviewWaitSeconds: { direction: 'lower', zero: 7200, full: 300, unit: 'seconds', label: '审查等待（任务累计）' },
  wallClockSeconds: { direction: 'lower', zero: 2700, full: 300, unit: 'seconds', label: '任务耗时（任务累计）' },
  tokensTotal: { direction: 'lower', zero: 400000, full: 50000, unit: 'tokens', label: 'token 成本（任务累计）' },
})
export const METRIC_NAMES = Object.freeze(Object.keys(METRIC_ANCHORS))

const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const round2 = value => Math.round(value * 100) / 100

/** Linear anchor score in 0..100, or null when the metric/value is unknown. */
export function anchorScore(name, value) {
  const anchor = METRIC_ANCHORS[name]
  const number = finite(value)
  if (!anchor || number === null) return null
  const span = anchor.direction === 'higher' ? anchor.full - anchor.zero : anchor.zero - anchor.full
  const raw = anchor.direction === 'higher' ? (number - anchor.zero) / span : (anchor.zero - number) / span
  return round2(Math.min(1, Math.max(0, raw)) * 100)
}

function median(values) {
  const numbers = values.map(finite).filter(value => value !== null).sort((a, b) => a - b)
  if (numbers.length === 0) return null
  const middle = Math.floor(numbers.length / 2)
  return numbers.length % 2 === 1 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2
}

const sumOrNull = values => (values.every(value => finite(value) !== null) ? values.reduce((a, b) => a + finite(b), 0) : null)

/** F17: reject inputs that would merge different arms/batches or repeat runs. */
export function assertSingleBatch(runs) {
  if (runs.length === 0) return null
  const arms = new Set()
  const batches = new Set()
  for (const run of runs) {
    if (typeof run.arm !== 'string' || run.arm === '') {
      throw new Error('T04 input is missing arm identity; single-arm/single-batch scoring requires every run to carry arm')
    }
    if (typeof run.batch !== 'string' || run.batch === '') {
      throw new Error('T04 input is missing batch identity; single-arm/single-batch scoring requires every run to carry batch')
    }
    arms.add(run.arm)
    batches.add(run.batch)
    if (run.repetition !== undefined) {
      if (!Number.isInteger(run.repetition) || run.repetition < 1) {
        throw new Error(`T04 input has invalid repetition: ${String(run.repetition)}`)
      }
      if (run.repetition >= 2) {
        throw new Error(`T04 input contains repetition=${run.repetition}; repetition>=2 is not a main scoring record and must not be merged into the main batch`)
      }
    }
  }
  if (arms.size > 1) {
    throw new Error(`T04 input mixes arms (${[...arms].sort().join(', ')}); only one arm can be scored per batch`)
  }
  if (batches.size > 1) {
    throw new Error(`T04 input mixes batches (${[...batches].sort().join(', ')}); only one batch can be scored per run`)
  }
  return { arm: [...arms][0], batch: [...batches][0] }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const T04_NON_NEGATIVE_FIELDS = ['wallClockSeconds', 'queueWaitSeconds', 'reviewWaitSeconds']

function checkT04Row(run, index) {
  if (run === null || typeof run !== 'object' || Array.isArray(run)) throw new Error(`T04 input row ${index + 1} is not an object`)
  const taskId = run.taskId ?? run.task
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    throw new Error(`T04 input row ${index + 1} is missing taskId identity; every scored row must identify its task`)
  }
  const ticketIds = Array.isArray(run.ticketIds) ? run.ticketIds.filter(id => typeof id === 'string' && id.trim() !== '') : []
  const runId = typeof run.runId === 'string' && run.runId.trim() !== '' ? run.runId.trim() : ''
  if (runId === '' && ticketIds.length === 0) {
    throw new Error(`T04 input row ${index + 1} is missing runId/ticketIds identity; every scored row must identify its ticket or run`)
  }
  for (const field of T04_NON_NEGATIVE_FIELDS) {
    const value = run[field]
    if (value === undefined || value === null) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`T04 input row ${index + 1} has invalid ${field} (${String(value)}); expected a finite non-negative number`)
    }
  }
  if (run.tokens !== undefined && run.tokens !== null) {
    if (typeof run.tokens !== 'object' || Array.isArray(run.tokens)) {
      throw new Error(`T04 input row ${index + 1} has invalid tokens; expected an object with a non-negative total`)
    }
    const total = run.tokens.total
    if (total !== undefined && total !== null && (typeof total !== 'number' || !Number.isFinite(total) || total < 0)) {
      throw new Error(`T04 input row ${index + 1} has invalid tokens.total (${String(total)}); expected a finite non-negative number`)
    }
  }
  return { taskId: taskId.trim(), runId, ticketIds }
}

/**
 * T01/T02: validate every T04 row and give it a stable identity. Identical
 * duplicates are collapsed to one row with a warning; the same identity with a
 * different snapshot is a hard conflict. Different tickets of one task remain
 * distinct and are aggregated normally.
 */
export function normalizeRuns(runs) {
  const unique = []
  const warnings = []
  const seen = new Map()
  for (const [index, run] of runs.entries()) {
    const { taskId, runId, ticketIds } = checkT04Row(run, index)
    const identity = runId !== '' ? `run:${runId}` : `ticket:${taskId}:${ticketIds.join(',')}`
    const snapshot = canonicalJson(run)
    const previous = seen.get(identity)
    if (previous !== undefined) {
      if (previous !== snapshot) {
        throw new Error(`T04 input has conflicting records for the same identity ${identity}; identical duplicates may be collapsed, different snapshots must be rejected`)
      }
      warnings.push(`T02: duplicate identical record ignored (${identity})`)
      continue
    }
    seen.set(identity, snapshot)
    unique.push(run)
  }
  return { runs: unique, warnings }
}

/** Merge the runs of one task into the task-level evaluation aggregate (AT-60). */
export function aggregateByTask(inputRuns) {
  const runs = normalizeRuns(inputRuns).runs
  const groups = new Map()
  for (const run of runs) {
    const taskId = run.taskId ?? run.task
    if (!groups.has(taskId)) groups.set(taskId, [])
    groups.get(taskId).push(run)
  }
  const tasks = []
  for (const [taskId, group] of groups) {
    const ticketIds = [...new Set(group.flatMap(run => Array.isArray(run.ticketIds) ? run.ticketIds : []))]
    const verdicts = group.map(run => run.acceptanceVerdict).filter(value => ['passed', 'failed', 'invalid'].includes(value))
    const acceptance = verdicts.includes('failed') ? 'failed' : verdicts.includes('passed') ? 'passed' : verdicts.includes('invalid') ? 'invalid' : null
    const readyRuns = group.filter(run => run.delivery === 'ready-pr-created')
    const merged = group.some(run => typeof run.mergedAt === 'string' && run.mergedAt !== '')
    const outcomes = group.map(run => run.sevenDayOutcome).filter(value => ['clean', 'rework'].includes(value))
    const sevenDayOutcome = outcomes.includes('rework') ? 'rework' : outcomes.includes('clean') ? 'clean' : null
    const candidates = group.filter(run => run.firstReviewCandidate?.head && run.finalCandidate?.head)
    // R3: ticket-level completeness is a separate property. A ticket with an
    // unknown acceptance/candidate/outcome must not be silently dropped by the
    // task aggregate; the metric is incomplete for the whole task.
    const acceptanceComplete = group.every(run => ['passed', 'failed', 'invalid'].includes(run.acceptanceVerdict))
    const firstReviewComplete = group.every(run => Boolean(run.firstReviewCandidate?.head && run.finalCandidate?.head))
    const sevenDayOutcomeComplete = group.every(run => ['clean', 'rework'].includes(run.sevenDayOutcome))
    const knownTickets = {
      acceptanceRate: group.filter(run => ['passed', 'failed', 'invalid'].includes(run.acceptanceVerdict)).length,
      firstReviewPassRate: group.filter(run => Boolean(run.firstReviewCandidate?.head && run.finalCandidate?.head)).length,
      reworkRate: group.filter(run => ['clean', 'rework'].includes(run.sevenDayOutcome)).length,
      queueWaitSeconds: group.filter(run => typeof run.queueWaitSeconds === 'number' && Number.isFinite(run.queueWaitSeconds)).length,
      reviewWaitSeconds: group.filter(run => typeof run.reviewWaitSeconds === 'number' && Number.isFinite(run.reviewWaitSeconds)).length,
      wallClockSeconds: group.filter(run => typeof run.wallClockSeconds === 'number' && Number.isFinite(run.wallClockSeconds)).length,
      tokensTotal: group.filter(run => typeof run.tokens?.total === 'number' && Number.isFinite(run.tokens.total)).length,
    }
    tasks.push({
      taskId,
      runs: group.length,
      ticketIds,
      ticketTotal: group.length,
      knownTickets,
      delivery: readyRuns.length === group.length ? 'ready-pr-created' : group.some(run => run.delivery === 'ready-pr-created') ? 'partially-delivered' : 'not-delivered',
      ready: readyRuns.length > 0,
      acceptance,
      acceptanceComplete,
      firstReviewComplete,
      sevenDayOutcomeComplete,
      merged,
      sevenDayOutcome,
      firstReviewPass: candidates.length === 0 ? null : candidates.every(run => run.firstReviewCandidate.head === run.finalCandidate.head),
      wallClockSeconds: sumOrNull(group.map(run => run.wallClockSeconds)),
      tokensTotal: sumOrNull(group.map(run => run.tokens?.total)),
      queueWaitSeconds: sumOrNull(group.map(run => run.queueWaitSeconds)),
      reviewWaitSeconds: sumOrNull(group.map(run => run.reviewWaitSeconds)),
      failures: group.filter(run => run.delivery !== 'ready-pr-created' || run.acceptanceVerdict === 'failed' || run.acceptanceVerdict === 'invalid').length,
    })
  }
  return { taskCount: tasks.length, ticketCount: tasks.reduce((sum, task) => sum + (task.ticketIds.length || task.runs), 0), tasks }
}

/**
 * Compute the eight T04 metrics, anchored scores and the total score from the
 * current batch only (AT-60/61/62/64). `now` is injectable for tests.
 */
export function computeMetrics(inputRuns, { now = new Date() } = {}) {
  const normalized = normalizeRuns(inputRuns)
  const runs = normalized.runs
  const warnings = normalized.warnings
  assertSingleBatch(runs)
  const aggregation = aggregateByTask(runs)
  const tasks = aggregation.tasks
  const reasons = []

  const taskHas = {
    acceptanceRate: task => task.acceptance !== null && task.acceptanceComplete === true,
    mergeRate: task => task.ready === true,
    firstReviewPassRate: task => task.firstReviewPass !== null && task.firstReviewComplete === true,
    reworkRate: task => task.sevenDayOutcome !== null && task.sevenDayOutcomeComplete === true,
    queueWaitSeconds: task => finite(task.queueWaitSeconds) !== null,
    reviewWaitSeconds: task => finite(task.reviewWaitSeconds) !== null,
    wallClockSeconds: task => finite(task.wallClockSeconds) !== null,
    tokensTotal: task => finite(task.tokensTotal) !== null,
  }
  const ratioMetric = (name, predicate) => {
    const known = tasks.filter(taskHas[name])
    return { value: known.length > 0 ? known.filter(predicate).length / known.length : null, known: known.length }
  }
  const medianMetric = name => {
    const known = tasks.filter(taskHas[name])
    const numbers = known.map(task => finite(task[name])).filter(value => value !== null)
    return { value: median(numbers), known: known.length }
  }
  const rawValues = {
    acceptanceRate: ratioMetric('acceptanceRate', task => task.acceptance === 'passed'),
    mergeRate: ratioMetric('mergeRate', task => task.merged),
    firstReviewPassRate: ratioMetric('firstReviewPassRate', task => task.firstReviewPass === true),
    reworkRate: ratioMetric('reworkRate', task => task.sevenDayOutcome === 'rework'),
    queueWaitSeconds: medianMetric('queueWaitSeconds'),
    reviewWaitSeconds: medianMetric('reviewWaitSeconds'),
    wallClockSeconds: medianMetric('wallClockSeconds'),
    tokensTotal: medianMetric('tokensTotal'),
  }
  const values = Object.fromEntries(Object.entries(rawValues).map(([name, entry]) => [name, entry.value]))
  const knownCounts = Object.fromEntries(Object.entries(rawValues).map(([name, entry]) => [name, entry.known]))
  // A task that never became ready has no merge disposition to report, not missing
  // data: mergeRate's denominator is the ready subset (no F07 incompleteness).
  knownCounts.mergeRate = tasks.length
  // R3: completeness is judged over every included ticket, not only over tasks
  // whose aggregate happens to keep a known value.
  const totalTickets = tasks.reduce((sum, task) => sum + task.ticketTotal, 0)
  const knownTicketCounts = {
    acceptanceRate: tasks.reduce((sum, task) => sum + task.knownTickets.acceptanceRate, 0),
    mergeRate: totalTickets,
    firstReviewPassRate: tasks.reduce((sum, task) => sum + task.knownTickets.firstReviewPassRate, 0),
    reworkRate: tasks.reduce((sum, task) => sum + task.knownTickets.reworkRate, 0),
    queueWaitSeconds: tasks.reduce((sum, task) => sum + task.knownTickets.queueWaitSeconds, 0),
    reviewWaitSeconds: tasks.reduce((sum, task) => sum + task.knownTickets.reviewWaitSeconds, 0),
    wallClockSeconds: tasks.reduce((sum, task) => sum + task.knownTickets.wallClockSeconds, 0),
    tokensTotal: tasks.reduce((sum, task) => sum + task.knownTickets.tokensTotal, 0),
  }

  // F08/R3: observation sufficiency is per ticket, never the earliest merge in
  // the task or batch. A ticket that is fresh/pending must not be hidden by a
  // mature ticket of the same task.
  const runsByTask = new Map()
  for (const run of runs) {
    const taskId = run.taskId ?? run.task
    if (typeof taskId !== 'string' || taskId === '') continue
    if (!runsByTask.has(taskId)) runsByTask.set(taskId, [])
    runsByTask.get(taskId).push(run)
  }
  const endTime = now instanceof Date ? now.getTime() : Date.parse(now)
  const ticketObservations = []
  let ticketIndex = 0
  for (const [taskId, group] of runsByTask) {
    for (const run of group) {
      ticketIndex += 1
      const ticketIds = Array.isArray(run.ticketIds) && run.ticketIds.length > 0 ? run.ticketIds : [run.runId ?? `${taskId}#${ticketIndex}`]
      const mergeTime = typeof run.mergedAt === 'string' && run.mergedAt !== '' ? Date.parse(run.mergedAt) : NaN
      // T10-03：达标判断用未舍入的毫秒差（>= 7*86400000）；round2 仅用于展示，避免 6d23h59m 提前放行。
      const observedMs = Number.isNaN(mergeTime) || Number.isNaN(endTime) ? null : endTime - mergeTime
      const observedDays = observedMs === null ? null : round2(observedMs / 86400000)
      const problems = []
      if (!Number.isFinite(mergeTime)) problems.push('not merged / no parseable mergedAt')
      else if (observedMs === null || observedMs < OBSERVATION_DAYS_REQUIRED * 86400000) problems.push(`observed ${observedDays} day(s) < ${OBSERVATION_DAYS_REQUIRED} day(s) (exact ms gate)`)
      if (!['clean', 'rework'].includes(run.sevenDayOutcome)) problems.push('7-day outcome is pending/unknown')
      for (const ticketId of ticketIds) {
        ticketObservations.push({
          taskId,
          ticketId,
          runId: typeof run.runId === 'string' ? run.runId : null,
          observedDays,
          sevenDayOutcome: ['clean', 'rework'].includes(run.sevenDayOutcome) ? run.sevenDayOutcome : null,
          sufficient: problems.length === 0,
          problems,
        })
      }
    }
  }
  const taskObservations = tasks.map(task => {
    const tickets = ticketObservations.filter(ticket => ticket.taskId === task.taskId)
    const badTickets = tickets.filter(ticket => !ticket.sufficient)
    const observedDays = tickets.length === 0 || tickets.some(ticket => ticket.observedDays === null)
      ? null
      : round2(Math.min(...tickets.map(ticket => ticket.observedDays)))
    return {
      taskId: task.taskId,
      merged: task.merged,
      observedDays,
      sevenDayOutcome: task.sevenDayOutcome,
      sufficient: tickets.length > 0 && badTickets.length === 0,
      problems: badTickets.map(ticket => `${ticket.ticketId}: ${ticket.problems.join('; ')}`),
    }
  })
  const insufficientTasks = taskObservations.filter(task => !task.sufficient)
  const insufficientTickets = ticketObservations.filter(ticket => !ticket.sufficient)
  const observedDays = tasks.length === 0
    ? null
    : taskObservations.every(task => task.observedDays !== null)
      ? round2(Math.min(...taskObservations.map(task => task.observedDays)))
      : null
  const insufficientObservation = tasks.length === 0 || insufficientTasks.length > 0
  for (const ticket of insufficientTickets) {
    reasons.push(`AT-64/F08/R3: task ${ticket.taskId} ticket ${ticket.ticketId}: ${ticket.problems.join('; ')}; the batch total is withheld`)
  }
  if (tasks.length === 0) reasons.push('AT-64: no task-level records, so no total score can be produced')

  const metrics = METRIC_NAMES.map(name => {
    const anchor = METRIC_ANCHORS[name]
    const value = finite(values[name])
    const known = knownCounts[name] ?? 0
    const knownTickets = knownTicketCounts[name] ?? 0
    const missingTickets = totalTickets - knownTickets
    let status
    if (insufficientObservation && name === 'reworkRate') status = '证据不足'
    else if (knownTickets === 0) status = 'unknown'
    else if (missingTickets > 0) status = 'incomplete'
    else status = 'ok'
    const score = status === 'ok' ? anchorScore(name, value) : null
    return { name, label: anchor.label, unit: anchor.unit, direction: anchor.direction, zero: anchor.zero, full: anchor.full, value: value === null ? null : round2(value), score, status, knownTasks: known, missingTasks: tasks.length - known, knownTickets, missingTickets }
  })
  const incompleteMetrics = metrics.filter(metric => metric.status === 'incomplete').map(metric => metric.name)
  const unknownMetrics = metrics.filter(metric => metric.status === 'unknown' && !(insufficientObservation && metric.name === 'reworkRate')).map(metric => metric.name)
  const observation = {
    requiredDays: OBSERVATION_DAYS_REQUIRED,
    observedDays,
    observedThrough: Number.isNaN(endTime) ? null : new Date(endTime).toISOString(),
    mergedTasks: tasks.filter(task => task.merged === true).length,
    sufficient: !insufficientObservation,
    insufficientTasks: insufficientTasks.map(task => task.taskId),
    insufficientTickets: insufficientTickets.map(ticket => ({
      taskId: ticket.taskId,
      ticketId: ticket.ticketId,
      observedDays: ticket.observedDays,
      sevenDayOutcome: ticket.sevenDayOutcome,
      problems: ticket.problems,
    })),
  }
  if (insufficientObservation) {
    return { observation, aggregation, metrics, totalScore: null, verdict: '证据不足', reasons, warnings }
  }
  if (incompleteMetrics.length > 0) {
    reasons.push(`F07: incomplete task data for ${incompleteMetrics.join(', ')}; known subset shown but no total score (verdict 证据不足)`)
    if (unknownMetrics.length > 0) reasons.push(`AT-61: missing data for ${unknownMetrics.join(', ')}`)
    return { observation, aggregation, metrics, totalScore: null, verdict: '证据不足', reasons, warnings }
  }
  if (unknownMetrics.length > 0) {
    reasons.push(`AT-61: missing data for ${unknownMetrics.join(', ')}; the total is judged 不达标`)
    return { observation, aggregation, metrics, totalScore: null, verdict: '不达标', reasons, warnings }
  }
  const totalScore = round2(metrics.reduce((sum, metric) => sum + metric.score, 0) / metrics.length)
  return { observation, aggregation, metrics, totalScore, verdict: 'scored', reasons, warnings }
}

/** True when the run carries any T04 collection field (so the CLI builds the T04 summary). */
function hasT04Fields(run) {
  return ['ticketIds', 'firstReviewCandidate', 'finalCandidate', 'acceptanceVerdict', 'mergedAt', 'sevenDayOutcome', 'queueWaitSeconds', 'reviewWaitSeconds']
    .some(field => field in run)
}

// ---------------------------------------------------------------------------
// Self-test: build a temporary git repository with a known diff and assert the
// mechanical measurements, plus assert the removed heuristic fields are gone.
// ---------------------------------------------------------------------------
function pass(list, name, condition, detail = '') {
  if (condition) { list.push(`PASS ${name}`); return }
  list.push(`FAIL ${name}${detail ? ` :: ${detail}` : ''}`)
}

function totalLines(row) { return row.lines }

export function selfTest() {
  const results = []
  const root = mkdtempSync(join(tmpdir(), 'ab-metrics-self-'))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const g = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  try {
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 'test@example.invalid')
    g('config', 'user.name', 'ab metrics self-test')
    mkdirSync(join(repo, 'src'))
    mkdirSync(join(repo, 'tests'))
    writeFileSync(join(repo, 'src/a.js'), 'export const a = 1\nexport const b = 2\n')
    writeFileSync(join(repo, 'src/b.js'), 'export const c = 3\n')
    writeFileSync(join(repo, 'tests/a.test.js'), ['test one', 'test two', 'test three'].join('\n') + '\n')
    writeFileSync(join(repo, 'README.md'), '# fixture\n')
    g('add', '.')
    g('commit', '-q', '-m', 'base')
    const base = g('rev-parse', 'HEAD').trim()
    // head: src/a.js +2/-1; add src/new.js (2 lines); delete tests/a.test.js (3 lines);
    // add docs/note.md (1 line, outside the allowed glob).
    writeFileSync(join(repo, 'src/a.js'), 'export const a = 10\nexport const b = 2\nexport const d = 4\n')
    writeFileSync(join(repo, 'src/new.js'), 'export const e = 5\nexport const f = 6\n')
    rmSync(join(repo, 'tests/a.test.js'))
    mkdirSync(join(repo, 'docs'))
    writeFileSync(join(repo, 'docs/note.md'), 'note\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'head')
    const head = g('rev-parse', 'HEAD').trim()

    const task = { expectedFiles: ['src/**'], hiddenTest: 'test -f src/new.js && test ! -e tests/a.test.js' }
    const row = measure({ task: 't1', arm: 'off', repo, base, head, minutes: 2, tokens: 100, readyDenials: 1, humanDriftScore: 0 }, task)
    pass(results, 'self-test changed file count', row.files === 4, `files=${row.files}`)
    pass(results, 'self-test changed line count', totalLines(row) === 9, `lines=${row.lines}`)
    pass(results, 'self-test outside files', row.outsideFiles === 2 && row.outsideLines === 4, `files=${row.outsideFiles} lines=${row.outsideLines}`)
    pass(results, 'self-test outside share', Math.abs(row.outsideShare - 4 / 9) < 1e-12, `share=${row.outsideShare}`)
    pass(results, 'self-test deleted test count', row.deletedTests === 1, `deletedTests=${row.deletedTests}`)
    pass(results, 'self-test hidden test result', row.hiddenPass === true, `hiddenPass=${row.hiddenPass}`)
    pass(results, 'self-test keeps recorded cost fields', row.minutes === 2 && row.tokens === 100 && row.readyDenials === 1 && row.humanDriftScore === 0)
    pass(results, 'self-test removed formatOnlyFiles/renames fields', !('formatOnlyFiles' in row) && !('renames' in row), Object.keys(row).join(','))
    const summary = summarize([row, { ...row, arm: 'native', files: 2, lines: 3, outsideFiles: 0, outsideLines: 0, outsideShare: 0 }])
    pass(results, 'self-test summarize has no unrelatedRefactor', !('unrelatedRefactor' in summary.arms.off), Object.keys(summary.arms.off).join(','))
    pass(results, 'self-test summarize has no effect verdict', !('verdict' in summary), Object.keys(summary).join(','))
    pass(results, 'self-test summarize keeps mechanical means', summary.arms.off.files === 4 && summary.arms.off.lines === 9 && summary.arms.native.files === 2 && summary.arms.native.lines === 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  // -------------------------------------------------------------------------
  // T04 self-test (AT-60 .. AT-64): pure, label-only fixtures. Expected scores
  // are hand-computed from the anchor table above; no git repository is needed.
  // -------------------------------------------------------------------------
  const shaA = 'a'.repeat(40)
  const shaB = 'b'.repeat(40)
  const shaC = 'c'.repeat(40)
  const ticket = (overrides) => ({
    taskId: 'task-alpha',
    ticketIds: ['ticket-1'],
    arm: 'full-package',
    batch: 'batch-1',
    repetition: 1,
    startedAt: '2026-01-01T00:00:00Z',
    delivery: 'ready-pr-created',
    acceptanceVerdict: 'passed',
    mergedAt: '2026-01-02T00:00:00Z',
    sevenDayOutcome: 'clean',
    firstReviewCandidate: { head: shaA, submittedAt: '2026-01-01T06:00:00Z' },
    finalCandidate: { head: shaA },
    queueWaitSeconds: 60,
    reviewWaitSeconds: 300,
    wallClockSeconds: 300,
    tokens: { total: 50000 },
    ...overrides,
  })
  const fixtureRuns = [
    ticket({ ticketIds: ['ticket-1'] }),
    ticket({ ticketIds: ['ticket-2'] }),
    ticket({
      taskId: 'task-beta',
      ticketIds: ['ticket-3'],
      delivery: 'blocked',
      acceptanceVerdict: 'failed',
      mergedAt: '2026-01-02T00:00:00Z',
      sevenDayOutcome: 'clean',
      firstReviewCandidate: { head: shaB, submittedAt: '2026-01-01T06:00:00Z' },
      finalCandidate: { head: shaC },
      queueWaitSeconds: 1800,
      reviewWaitSeconds: 7200,
      wallClockSeconds: 2700,
      tokens: { total: 400000 },
    }),
  ]
  const afterBatch = new Date('2026-03-01T00:00:00Z')

  // AT-60: same taskId + several tickets merge failures and costs.
  const agg = aggregateByTask(fixtureRuns)
  const alpha = agg.tasks.find(task => task.taskId === 'task-alpha')
  const beta = agg.tasks.find(task => task.taskId === 'task-beta')
  pass(results, 'T04 AT-60 aggregates by taskId (2 tasks / 3 tickets)', agg.taskCount === 2 && agg.ticketCount === 3, JSON.stringify({ taskCount: agg.taskCount, ticketCount: agg.ticketCount }))
  pass(results, 'T04 AT-60 merges ticket costs of one task', alpha?.wallClockSeconds === 600 && alpha?.tokensTotal === 100000 && alpha?.queueWaitSeconds === 120 && alpha?.reviewWaitSeconds === 600, JSON.stringify(alpha))
  pass(results, 'T04 AT-60 merges failures into the task outcome', alpha?.acceptance === 'passed' && alpha?.failures === 0 && beta?.acceptance === 'failed' && beta?.failures === 1, JSON.stringify({ alpha, beta }))

  // AT-62: fixed anchors, 合格交付率 86% => 100 and 60% => 0 (linear).
  pass(results, 'T04 AT-62 合格交付率 anchor 86% => 100', anchorScore('acceptanceRate', 0.86) === 100, String(anchorScore('acceptanceRate', 0.86)))
  pass(results, 'T04 AT-62 合格交付率 anchor 60% => 0', anchorScore('acceptanceRate', 0.60) === 0, String(anchorScore('acceptanceRate', 0.60)))
  pass(results, 'T04 AT-62 合格交付率 is linear between anchors', anchorScore('acceptanceRate', 0.73) === 50, String(anchorScore('acceptanceRate', 0.73)))
  const scored = computeMetrics(fixtureRuns, { now: afterBatch })
  const withBaseline = computeMetrics(fixtureRuns.map(run => ({ ...run, historicalBaseline: { acceptanceRate: 0.2, wallClockSeconds: 100000 } })), { now: afterBatch })
  pass(results, 'T04 AT-62 scores current values only (no historical baseline)', JSON.stringify(scored.metrics) === JSON.stringify(withBaseline.metrics) && scored.totalScore === withBaseline.totalScore && scored.verdict === withBaseline.verdict)

  // AT-63: hand-computed metric scores and eight metric names.
  const handMetrics = {
    acceptanceRate: { value: 0.5, score: 0.00 },
    mergeRate: { value: 1, score: 100.00 },
    firstReviewPassRate: { value: 0.5, score: 25.00 },
    reworkRate: { value: 0, score: 100.00 },
    queueWaitSeconds: { value: 960, score: 48.28 },
    reviewWaitSeconds: { value: 3900, score: 47.83 },
    wallClockSeconds: { value: 1650, score: 43.75 },
    tokensTotal: { value: 250000, score: 42.86 },
  }
  pass(results, 'T04 AT-63 eight metrics are computed in anchor order', JSON.stringify(scored.metrics.map(metric => metric.name)) === JSON.stringify(METRIC_NAMES), JSON.stringify(scored.metrics.map(metric => metric.name)))
  const metricsMatch = scored.metrics.every(metric => {
    const expected = handMetrics[metric.name]
    return expected !== undefined && metric.value === expected.value && metric.score === expected.score && metric.status === 'ok'
  })
  pass(results, 'T04 AT-63 hand-computed metric scores match the script', metricsMatch, JSON.stringify(scored.metrics.map(metric => [metric.name, metric.value, metric.score])))
  pass(results, 'T04 AT-63 hand-computed total score matches the script (50.97)', Math.abs(scored.totalScore - 50.97) <= 0.005 && scored.verdict === 'scored', `total=${scored.totalScore} verdict=${scored.verdict}`)
  pass(results, 'T04 AT-63 observation window is sufficient (58 days)', scored.observation.sufficient === true && scored.observation.observedDays >= 7 && scored.reasons.length === 0, JSON.stringify(scored.observation))

  // AT-61: missing data => metric unknown and the total is judged 不达标.
  const missingTokens = fixtureRuns.map(run => ({ ...run, tokens: { total: null } }))
  const missing = computeMetrics(missingTokens, { now: afterBatch })
  const tokensMetric = missing.metrics.find(metric => metric.name === 'tokensTotal')
  pass(results, 'T04 AT-61 missing data becomes unknown', tokensMetric?.status === 'unknown' && tokensMetric?.value === null && tokensMetric?.score === null, JSON.stringify(tokensMetric))
  pass(results, 'T04 AT-61 total is judged 不达标 without a score', missing.totalScore === null && missing.verdict === '不达标', `total=${missing.totalScore} verdict=${missing.verdict}`)
  pass(results, 'T04 AT-61 reasons name the unknown metric', missing.reasons.some(reason => reason.includes('tokensTotal')), JSON.stringify(missing.reasons))

  // AT-64: observation window shorter than 7 days, or no merged PR => no total.
  const shortWindow = computeMetrics(fixtureRuns, { now: new Date('2026-01-04T00:00:00Z') })
  const reworkShort = shortWindow.metrics.find(metric => metric.name === 'reworkRate')
  pass(results, 'T04 AT-64 short window produces no total score', shortWindow.totalScore === null && shortWindow.verdict === '证据不足', `total=${shortWindow.totalScore} verdict=${shortWindow.verdict}`)
  pass(results, 'T04 AT-64 short window marks rework as 证据不足', reworkShort?.status === '证据不足' && reworkShort?.score === null, JSON.stringify(reworkShort))
  const noMerge = fixtureRuns.map(run => ({ ...run, mergedAt: null, sevenDayOutcome: 'pending' }))
  const noMergeResult = computeMetrics(noMerge, { now: afterBatch })
  const reworkNoMerge = noMergeResult.metrics.find(metric => metric.name === 'reworkRate')
  pass(results, 'T04 AT-64 no observable PR produces no total score', noMergeResult.totalScore === null && noMergeResult.verdict === '证据不足' && noMergeResult.observation.mergedTasks === 0, `total=${noMergeResult.totalScore} verdict=${noMergeResult.verdict}`)
  pass(results, 'T04 AT-64 no observable PR marks rework as 证据不足', reworkNoMerge?.status === '证据不足', JSON.stringify(reworkNoMerge))

  // F07 counterexample: two tasks, one lacks token/time/waits/acceptance/candidate.
  // Before the completeness gate this produced totalScore=100; it must now be evidence-insufficient.
  const perfectRuns = [
    ticket({ taskId: 'task-perfect-a', ticketIds: ['ticket-pa'] }),
    ticket({ taskId: 'task-perfect-b', ticketIds: ['ticket-pb'] }),
  ]
  const partialMissingRuns = perfectRuns.map(run => run.taskId === 'task-perfect-b'
    ? {
        ...run,
        acceptanceVerdict: null,
        firstReviewCandidate: null,
        finalCandidate: null,
        wallClockSeconds: null,
        queueWaitSeconds: null,
        reviewWaitSeconds: null,
        tokens: { total: null },
      }
    : run)
  const partialResult = computeMetrics(partialMissingRuns, { now: afterBatch })
  const partialNames = partialResult.metrics.filter(metric => metric.status === 'incomplete').map(metric => metric.name)
  const partialTokens = partialResult.metrics.find(metric => metric.name === 'tokensTotal')
  pass(results, 'T04 F07 partial missing data is evidence-insufficient, never scored/100',
    partialResult.totalScore === null && partialResult.verdict === '证据不足' && partialResult.verdict !== 'scored',
    `total=${partialResult.totalScore} verdict=${partialResult.verdict}`)
  pass(results, 'T04 F07 each affected metric is incomplete (known subset is still displayed)',
    ['acceptanceRate', 'firstReviewPassRate', 'queueWaitSeconds', 'reviewWaitSeconds', 'wallClockSeconds', 'tokensTotal'].every(name => partialNames.includes(name)) && partialTokens?.value === 50000 && partialTokens?.score === null,
    JSON.stringify({ incomplete: partialNames, tokens: partialTokens }))
  pass(results, 'T04 F07 partial data reason names the missing metrics',
    partialResult.reasons.some(reason => reason.includes('F07') && reason.includes('tokensTotal')),
    JSON.stringify(partialResult.reasons))

  // F08 counterexample: A merged 8 days ago clean + B merged today pending.
  // The old batch-wide earliest-merge window let B pass; per-task observation must withhold the total.
  const freshNow = new Date('2026-03-01T00:00:00Z')
  const matureRun = ticket({ taskId: 'task-mature', ticketIds: ['ticket-mature'], mergedAt: '2026-02-21T00:00:00Z', sevenDayOutcome: 'clean' })
  const freshRun = ticket({ taskId: 'task-fresh', ticketIds: ['ticket-fresh'], mergedAt: '2026-03-01T00:00:00Z', sevenDayOutcome: 'pending' })
  const freshResult = computeMetrics([matureRun, freshRun], { now: freshNow })
  const freshRework = freshResult.metrics.find(metric => metric.name === 'reworkRate')
  pass(results, 'T04 F08 a fresh/pending task withholds the batch total',
    freshResult.observation.sufficient === false && freshResult.totalScore === null && freshResult.verdict === '证据不足',
    JSON.stringify(freshResult.observation) + ` total=${freshResult.totalScore} verdict=${freshResult.verdict}`)
  pass(results, 'T04 F08 insufficient task is named and rework is 证据不足',
    freshResult.observation.insufficientTasks.includes('task-fresh') && freshRework?.status === '证据不足' && freshRework?.score === null,
    JSON.stringify({ insufficientTasks: freshResult.observation.insufficientTasks, rework: freshRework }))

  // F17 counterexamples: mixed arm / mixed batch / repetition>=2 are rejected at the entry.
  const errorOf = (fn) => { try { fn(); return null } catch (error) { return error instanceof Error ? error.message : String(error) } }
  const mixedArmError = errorOf(() => computeMetrics([
    ticket({ taskId: 'task-mixed', ticketIds: ['ticket-mixed-a'], arm: 'full-package' }),
    ticket({ taskId: 'task-mixed', ticketIds: ['ticket-mixed-b'], arm: 'legacy-system' }),
  ], { now: afterBatch }))
  const mixedBatchError = errorOf(() => computeMetrics([
    ticket({ taskId: 'task-mixed', ticketIds: ['ticket-mixed-a'], batch: 'batch-1' }),
    ticket({ taskId: 'task-mixed', ticketIds: ['ticket-mixed-b'], batch: 'batch-2' }),
  ], { now: afterBatch }))
  const repetitionError = errorOf(() => computeMetrics([
    ticket({ taskId: 'task-repeat', ticketIds: ['ticket-repeat-1'], repetition: 1 }),
    ticket({ taskId: 'task-repeat', ticketIds: ['ticket-repeat-2'], repetition: 2 }),
  ], { now: afterBatch }))
  pass(results, 'T04 F17 mixed arms are rejected at the scoring entry', typeof mixedArmError === 'string' && mixedArmError.includes('mixes arms'), String(mixedArmError))
  pass(results, 'T04 F17 mixed batches are rejected at the scoring entry', typeof mixedBatchError === 'string' && mixedBatchError.includes('mixes batches'), String(mixedBatchError))
  pass(results, 'T04 F17 repetition>=2 main records are rejected', typeof repetitionError === 'string' && repetitionError.includes('repetition=2'), String(repetitionError))
  pass(results, 'T04 F17 same arm+batch multi-ticket merging is preserved',
    agg.taskCount === 2 && agg.ticketCount === 3 && computeMetrics(fixtureRuns, { now: afterBatch }).verdict === 'scored',
    JSON.stringify({ taskCount: agg.taskCount, ticketCount: agg.ticketCount }))

  // R3 counterexample 1: same task, two tickets; one ticket passed with candidates,
  // the other has unknown acceptance and no candidates. The old aggregate dropped
  // the unknown ticket and scored 95.68; per-ticket completeness must mark incomplete.
  const sharedTaskRuns = [
    ticket({ taskId: 'task-shared', ticketIds: ['ticket-good'] }),
    ticket({ taskId: 'task-shared', ticketIds: ['ticket-unknown'], acceptanceVerdict: null, firstReviewCandidate: null, finalCandidate: null }),
  ]
  const sharedResult = computeMetrics(sharedTaskRuns, { now: afterBatch })
  const sharedNames = sharedResult.metrics.filter(metric => metric.status === 'incomplete').map(metric => metric.name)
  pass(results, 'T04 R3 same-task unknown ticket is not hidden by the known ticket',
    sharedResult.verdict === '证据不足' && sharedResult.totalScore === null,
    `verdict=${sharedResult.verdict} total=${sharedResult.totalScore}`)
  pass(results, 'T04 R3 same-task acceptance/first-review completeness is per ticket',
    sharedNames.includes('acceptanceRate') && sharedNames.includes('firstReviewPassRate'),
    JSON.stringify(sharedNames))
  pass(results, 'T04 R3 same-task aggregate fields keep the incomplete marker',
    sharedResult.aggregation.tasks[0]?.acceptanceComplete === false && sharedResult.aggregation.tasks[0]?.firstReviewComplete === false,
    JSON.stringify(sharedResult.aggregation.tasks[0]))

  // R3 counterexample 2: same task, one ticket merged 8 days ago clean, the other
  // merged today pending. The old task-level earliest-merge window let this score;
  // per-ticket observation must withhold the total.
  const eightDaysAgo = new Date(freshNow.getTime() - 8 * 86400000)
  const sharedObservationRuns = [
    ticket({ taskId: 'task-shared-observation', ticketIds: ['ticket-old'], mergedAt: eightDaysAgo.toISOString(), sevenDayOutcome: 'clean' }),
    ticket({ taskId: 'task-shared-observation', ticketIds: ['ticket-fresh'], mergedAt: freshNow.toISOString(), sevenDayOutcome: 'pending' }),
  ]
  const sharedObservation = computeMetrics(sharedObservationRuns, { now: freshNow })
  pass(results, 'T04 R3 same-task fresh/pending ticket withholds the batch total',
    sharedObservation.observation.sufficient === false && sharedObservation.totalScore === null && sharedObservation.verdict === '证据不足',
    JSON.stringify(sharedObservation.observation))
  pass(results, 'T04 R3 same-task fresh ticket is named in insufficientTickets',
    sharedObservation.observation.insufficientTickets.some(ticket => ticket.ticketId === 'ticket-fresh') && sharedObservation.observation.insufficientTasks.includes('task-shared-observation'),
    JSON.stringify(sharedObservation.observation.insufficientTickets))

  // T01 counterexamples: no silent skipping of a row with missing identity, and
  // negative/non-finite costs are rejected instead of being scored as unknown.
  const goodTicket = ticket({ taskId: 'task-good', ticketIds: ['ticket-good'] })
  const unnamedFail = { ...ticket({ ticketIds: ['ticket-unnamed'], delivery: 'blocked', acceptanceVerdict: 'failed' }), taskId: undefined }
  const missingIdentityError = errorOf(() => computeMetrics([goodTicket, unnamedFail], { now: afterBatch }))
  pass(results, 'T01 row with missing taskId is rejected, not skipped',
    typeof missingIdentityError === 'string' && missingIdentityError.includes('taskId'),
    String(missingIdentityError))
  const negativeErrors = ['wallClockSeconds', 'queueWaitSeconds', 'reviewWaitSeconds', 'tokens'].map(field => {
    const run = field === 'tokens'
      ? ticket({ tokens: { total: -1 } })
      : ticket({ [field]: -1 })
    return errorOf(() => computeMetrics([run], { now: afterBatch }))
  })
  pass(results, 'T01 negative wall-clock/queue/review/token values are rejected',
    negativeErrors.every(message => typeof message === 'string' && message.includes('invalid') && message.includes('non-negative')),
    JSON.stringify(negativeErrors))
  const nonFiniteError = errorOf(() => computeMetrics([ticket({ wallClockSeconds: Number.POSITIVE_INFINITY })], { now: afterBatch }))
  pass(results, 'T01 non-finite cost is rejected', typeof nonFiniteError === 'string' && nonFiniteError.includes('non-negative'), String(nonFiniteError))

  // T02 counterexamples: identical duplicate rows collapse with a warning (no
  // double counting); same identity with a different snapshot is a conflict;
  // different tickets of one task still accumulate.
  const duplicated = computeMetrics([ticket(), ticket()], { now: afterBatch })
  pass(results, 'T02 identical duplicate record is counted once with a warning',
    duplicated.warnings?.length === 1 && duplicated.aggregation.taskCount === 1 && duplicated.aggregation.ticketCount === 1 && duplicated.totalScore === 100 && duplicated.verdict === 'scored',
    JSON.stringify({ warnings: duplicated.warnings, aggregation: duplicated.aggregation, total: duplicated.totalScore, verdict: duplicated.verdict }))
  const conflictError = errorOf(() => computeMetrics([
    ticket({ taskId: 'task-conflict', ticketIds: ['ticket-conflict'], runId: 'run-conflict', wallClockSeconds: 300 }),
    ticket({ taskId: 'task-conflict', ticketIds: ['ticket-conflict'], runId: 'run-conflict', wallClockSeconds: 301 }),
  ], { now: afterBatch }))
  pass(results, 'T02 same identity with a different snapshot is rejected',
    typeof conflictError === 'string' && conflictError.includes('conflicting records'),
    String(conflictError))
  const distinctTickets = computeMetrics([
    ticket({ taskId: 'task-distinct', ticketIds: ['ticket-distinct-1'] }),
    ticket({ taskId: 'task-distinct', ticketIds: ['ticket-distinct-2'] }),
  ], { now: afterBatch })
  pass(results, 'T02 different tickets of one task still accumulate',
    distinctTickets.warnings?.length === 0 && distinctTickets.aggregation.taskCount === 1 && distinctTickets.aggregation.ticketCount === 2,
    JSON.stringify(distinctTickets.aggregation))

  for (const line of results) console.log(line)
  const failed = results.filter(line => line.startsWith('FAIL')).length
  if (failed > 0) { console.log(`\nFAILED: ${failed} assertion(s)`); return 1 }
  console.log(`\nPASS: ${results.length} assertions (ab-metrics self-test)`)
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--self-test') {
    process.exitCode = selfTest()
  } else if (!process.argv[2] || process.argv[2].startsWith('-')) {
    console.error('usage: node eval/ab-metrics.mjs <runs.json> | --self-test')
    process.exitCode = 2
  } else {
    try {
      const input = JSON.parse(readFileSync(process.argv[2], 'utf8'))
      const runs = Array.isArray(input.runs) ? input.runs : []
      const measurable = runs.length > 0 && runs.every(run => typeof run.repo === 'string' && typeof run.base === 'string' && typeof run.head === 'string')
      const output = {}
      if (measurable) {
        const rows = runs.map(run => measure(run, input.tasks?.[run.task] ?? input.tasks?.[run.taskId]))
        output.rows = rows
        Object.assign(output, summarize(rows))
      } else {
        output.rows = runs
      }
      if (runs.some(hasT04Fields)) {
        const summary = computeMetrics(runs)
        Object.assign(output, {
          observation: summary.observation,
          aggregation: summary.aggregation,
          metrics: summary.metrics,
          totalScore: summary.totalScore,
          verdict: summary.verdict,
        })
        if (summary.reasons.length > 0) output.reasons = summary.reasons
        if (summary.warnings.length > 0) output.warnings = summary.warnings
      }
      console.log(JSON.stringify(output, null, 2))
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}
