#!/usr/bin/env node
// Generate a reproducible B5 run plan (ROADMAP-95 §B5, plan review P1-1 context).
//
// The plan is data only: it decides WHICH runs to execute and in what order; it
// does not run anything and it does not prove any result. Fixed seed + the same
// tasks file always produce the same order (generatedAt aside), so anybody can
// regenerate and audit the batch plan.
//
//   node eval/b5-plan.mjs --tasks <tasks.json> --seed <int> [--groups off,native] \
//        [--repeat-fraction 0.2] (--out <plan.json> | --dry-run)
//   node eval/b5-plan.mjs --self-test
//
// tasks.json (array, or `{ "tasks": [...] }`):
//   [{ "taskId": "dubbo-t01", "repo": "dubbo", "category": "defect-fix" }, ...]
//   taskId: ^[a-z0-9][a-z0-9._-]{1,63}$ and unique
//   repo: non-empty string (repository identifier or path)
//   category: defect-fix | new-feature | behavior-preserving-refactor | cross-module | staged-suitable
//
// Plan rules (B5):
//   1. Tasks are sorted by taskId, then randomly ordered with the fixed seed.
//   2. Within one task the groups run adjacently (off/native interleaved); which
//      group runs first per task is decided by the seed. No "all off first" batches.
//   3. A seeded random subset of round(repeatFraction * taskCount) tasks gets one
//      extra run per group (`repetition=2`, `repeat=true`), adjacent to the primary
//      pair, for the repeat-consistency report.
//   4. Every run entry records runId, taskId, repo, category, group (and `arm`),
//      order, repetition, repeat and the seed; the plan records seed + generatedAt.
//
// A plan is an input to the RUNBOOK §5 review, not evidence. PREREG still has to
// lock the seed / sample size / repeat fraction (owner decision).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLAN_SCHEMA_VERSION = 1
export const KNOWN_GROUPS = ['legacy-system', 'full-package', 'off', 'native', 'staged']
// PREREG v1.2: legacy-system=原系统组(含旧赫菲) / full-package=整包组；off/native 为旧 B5 历史值，新运行禁用
export const TASK_CATEGORIES = ['defect-fix', 'new-feature', 'behavior-preserving-refactor', 'cross-module', 'staged-suitable']
const SAFE_TASK_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/

export class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32). No dependency; identical output for a seed.
// ---------------------------------------------------------------------------
export function makeRandom(seed) {
  let state = seed >>> 0
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle(items, random) {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    const swap = out[i]
    out[i] = out[j]
    out[j] = swap
  }
  return out
}

function parseSeed(value) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) throw new UsageError(`--seed must be an integer, got "${value}"`)
  const seed = Number(value)
  if (!Number.isSafeInteger(seed)) throw new UsageError(`--seed must be a safe integer, got "${value}"`)
  return seed
}

function parseRepeatFraction(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new UsageError(`--repeat-fraction must be between 0 and 1, got "${value}"`)
  return number
}

function parseGroups(value) {
  const groups = String(value).split(',').map(item => item.trim()).filter(Boolean)
  if (groups.length === 0) throw new UsageError('--groups must list at least one group')
  if (groups.length > 2) throw new UsageError('--groups supports at most two groups (off,native or native,staged)')
  for (const group of groups) if (!KNOWN_GROUPS.includes(group)) throw new UsageError(`unknown group "${group}"; allowed: ${KNOWN_GROUPS.join(', ')}`)
  // PREREG v1.2：禁止混代（旧 B5 off/native 与现行 legacy-system/full-package 不得组合）
  const OLD = new Set(['off', 'native']); const NEW = new Set(['legacy-system', 'full-package'])
  if (groups.some((g) => OLD.has(g)) && groups.some((g) => NEW.has(g))) throw new UsageError('--groups 不得混代：off/native（旧 B5）与 legacy-system/full-package（PREREG v1.2）不能组合')
  if (new Set(groups).size !== groups.length) throw new UsageError(`--groups contains duplicates: ${groups.join(',')}`)
  if (groups.includes('staged') && groups.includes('off')) throw new UsageError('staged must not be mixed with off (staged is a separate Q3 experiment)')
  return groups
}

export function validateTasks(input) {
  const raw = Array.isArray(input) ? input : input?.tasks
  if (!Array.isArray(raw) || raw.length === 0) throw new UsageError('tasks must be a non-empty array (or { "tasks": [...] })')
  const tasks = []
  const seen = new Set()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') throw new UsageError('each task must be an object with taskId/repo/category')
    const taskId = entry.taskId
    if (typeof taskId !== 'string' || !SAFE_TASK_ID.test(taskId)) throw new UsageError(`invalid taskId: ${String(taskId)}`)
    if (seen.has(taskId)) throw new UsageError(`duplicate taskId: ${taskId}`)
    seen.add(taskId)
    if (typeof entry.repo !== 'string' || !entry.repo.trim()) throw new UsageError(`task ${taskId}: repo must be a non-empty string`)
    if (!TASK_CATEGORIES.includes(entry.category)) throw new UsageError(`task ${taskId}: category must be one of ${TASK_CATEGORIES.join(', ')}`)
    tasks.push({ taskId, repo: entry.repo.trim(), category: entry.category })
  }
  return tasks
}

function repeatCountFor(taskCount, repeatFraction) {
  return Math.max(0, Math.min(taskCount, Math.round(taskCount * repeatFraction)))
}

/**
 * Generate the plan. `generatedAt` is injectable so tests can compare two plans
 * byte-for-byte; the CLI passes the real clock.
 */
export function generatePlan({ tasks, groups, seed, repeatFraction, generatedAt = new Date().toISOString(), source = null }) {
  if (!Number.isSafeInteger(seed)) throw new UsageError('seed must be a safe integer')
  if (!Array.isArray(tasks) || tasks.length === 0) throw new UsageError('tasks must be a non-empty array')
  if (!Array.isArray(groups) || groups.length === 0 || groups.length > 2) throw new UsageError('groups must contain one or two groups')
  if (!(repeatFraction >= 0 && repeatFraction <= 1)) throw new UsageError('repeatFraction must be between 0 and 1')
  const random = makeRandom(seed)
  const orderedTasks = shuffle([...tasks].sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0)), random)
  const repeatTasks = new Set(shuffle(orderedTasks, random).slice(0, repeatCountFor(orderedTasks.length, repeatFraction)).map(task => task.taskId))
  const repeats = orderedTasks.filter(task => repeatTasks.has(task.taskId)).map(task => task.taskId)
  const planOrder = []
  let order = 0
  for (const task of orderedTasks) {
    // Two groups run adjacently, seed decides which comes first; repetition 2 stays adjacent.
    const taskGroups = groups.length === 1 ? [groups[0]] : (random() < 0.5 ? [groups[0], groups[1]] : [groups[1], groups[0]])
    const repetitions = repeatTasks.has(task.taskId) ? [1, 2] : [1]
    for (const repetition of repetitions) {
      for (const group of taskGroups) {
        order += 1
        planOrder.push({
          order,
          runId: `b5-${seed}-${String(order).padStart(4, '0')}-${task.taskId}-${group}-r${repetition}`,
          taskId: task.taskId,
          repo: task.repo,
          category: task.category,
          group,
          arm: group,
          repeat: repetition > 1,
          repetition,
          seed,
        })
      }
    }
  }
  const perGroup = Object.fromEntries(groups.map(group => [group, planOrder.filter(run => run.group === group).length]))
  const primaryRuns = planOrder.filter(run => !run.repeat).length
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    generatedBy: 'eval/b5-plan.mjs',
    generatedAt,
    seed,
    groups,
    repeatFraction,
    ...(source === null ? {} : { source }),
    taskSet: {
      taskCount: orderedTasks.length,
      taskIds: orderedTasks.map(task => task.taskId),
      repos: [...new Set(orderedTasks.map(task => task.repo))].sort(),
      categoryCounts: Object.fromEntries(TASK_CATEGORIES.map(category => [category, orderedTasks.filter(task => task.category === category).length]).filter(([, count]) => count > 0)),
    },
    repeats,
    order: planOrder,
    summary: {
      runs: planOrder.length,
      primaryRuns,
      repeatRuns: planOrder.length - primaryRuns,
      perGroup,
      repeatTasks: repeats.length,
    },
  }
}

export function parseArgs(argv) {
  const options = { tasks: null, groups: ['legacy-system', 'full-package'], seed: null, repeatFraction: 0.2, out: null, dryRun: false, selfTest: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--self-test') { options.selfTest = true; continue }
    if (arg === '--dry-run') { options.dryRun = true; continue }
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (!['--tasks', '--groups', '--seed', '--repeat-fraction', '--out'].includes(arg)) throw new UsageError(`unknown argument: ${arg}`)
    const value = argv[index + 1]
    if (value === undefined) throw new UsageError(`missing value for ${arg}`)
    index += 1
    if (arg === '--tasks') options.tasks = value
    if (arg === '--groups') options.groups = parseGroups(value)
    if (arg === '--seed') options.seed = parseSeed(value)
    if (arg === '--repeat-fraction') options.repeatFraction = parseRepeatFraction(value)
    if (arg === '--out') options.out = value
  }
  if (options.selfTest || options.help) return options
  if (options.tasks === null) throw new UsageError('--tasks is required')
  if (options.seed === null) throw new UsageError('--seed is required')
  if (options.out === null && !options.dryRun) throw new UsageError('--out is required unless --dry-run is used')
  return options
}

export function readTasksFile(path) {
  let text
  try { text = readFileSync(path, 'utf8') } catch (error) {
    throw new UsageError(`cannot read --tasks file ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed
  try { parsed = JSON.parse(text) } catch (error) {
    throw new UsageError(`--tasks file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return validateTasks(parsed)
}

// ---------------------------------------------------------------------------
// Self-test: real CLI executions with a temporary tasks file.
// ---------------------------------------------------------------------------
function pass(list, name, condition, detail = '') {
  if (condition) { list.push(`PASS ${name}`); return }
  list.push(`FAIL ${name}${detail ? ` :: ${detail}` : ''}`)
}

function spawnCli(args) {
  const scriptPath = fileURLToPath(import.meta.url)
  const result = execFileSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return { status: 0, stdout: result }
}

function spawnCliExpectFailure(args) {
  try {
    spawnCli(args)
    return { status: 0, stdout: '' }
  } catch (error) {
    const status = typeof error.status === 'number' ? error.status : null
    return { status, stdout: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

function stripGeneratedAt(plan) { const copy = { ...plan }; delete copy.generatedAt; return copy }

export function selfTest() {
  const results = []
  const root = mkdtempSync(join(tmpdir(), 'b5-plan-self-'))
  const tasksPath = join(root, 'tasks.json')
  const tasks = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'].map((name, index) => ({
    taskId: `task-${name}`,
    repo: index < 5 ? 'dubbo' : 'ts-project',
    category: ['defect-fix', 'new-feature', 'behavior-preserving-refactor', 'cross-module', 'staged-suitable'][index % 5],
  }))
  writeFileSync(tasksPath, JSON.stringify({ tasks }, null, 2))
  const fixed = '2026-11-07T00:00:00.000Z'
  try {
    const planA = generatePlan({ tasks, groups: ['off', 'native'], seed: 20261107, repeatFraction: 0.2, generatedAt: fixed })
    const planB = generatePlan({ tasks, groups: ['off', 'native'], seed: 20261107, repeatFraction: 0.2, generatedAt: fixed })
    pass(results, 'self-test same seed yields identical plan', JSON.stringify(planA) === JSON.stringify(planB))

    const planC = generatePlan({ tasks, groups: ['off', 'native'], seed: 20261108, repeatFraction: 0.2, generatedAt: fixed })
    pass(results, 'self-test different seed changes the order', JSON.stringify(planA.order) !== JSON.stringify(planC.order))

    pass(results, 'self-test plan contains seed and generation time', planA.seed === 20261107 && planA.generatedAt === fixed)
    pass(results, 'self-test run entries carry runId/group/order/repeat', planA.order.every(run => typeof run.runId === 'string' && run.runId.length > 0 && run.group === run.arm && Number.isInteger(run.order) && typeof run.repeat === 'boolean'))
    pass(results, 'self-test runIds are unique and ordered', new Set(planA.order.map(run => run.runId)).size === planA.order.length && planA.order.every((run, index) => run.order === index + 1))

    // Interleaving: each task's runs are adjacent, groups alternate inside each repetition pair.
    const byTask = new Map()
    planA.order.forEach((run, index) => {
      if (!byTask.has(run.taskId)) byTask.set(run.taskId, [])
      byTask.get(run.taskId).push({ run, index })
    })
    let interleaved = true
    for (const entries of byTask.values()) {
      const indexes = entries.map(entry => entry.index)
      const adjacent = indexes.every((value, position) => position === 0 || value === indexes[position - 1] + 1)
      const groupsPerRepetition = new Map()
      for (const { run } of entries) {
        if (!groupsPerRepetition.has(run.repetition)) groupsPerRepetition.set(run.repetition, new Set())
        groupsPerRepetition.get(run.repetition).add(run.group)
      }
      const pairsOk = [...groupsPerRepetition.values()].every(groups => groups.size === 2)
      if (!adjacent || !pairsOk) interleaved = false
    }
    pass(results, 'self-test groups run adjacently per task (interleaving)', interleaved)

    const expectedRepeats = Math.round(tasks.length * 0.2)
    pass(results, 'self-test repeat fraction selects 20% of tasks', planA.repeats.length === expectedRepeats && planA.summary.repeatTasks === expectedRepeats, `repeats=${planA.repeats.length}`)
    const repeatRuns = planA.order.filter(run => run.repeat)
    pass(results, 'self-test repeated tasks get one extra run per group', repeatRuns.length === expectedRepeats * 2 && repeatRuns.every(run => run.repetition === 2 && planA.repeats.includes(run.taskId)))
    pass(results, 'self-test primary runs equal taskCount × groups', planA.summary.primaryRuns === tasks.length * 2 && planA.summary.runs === tasks.length * 2 + expectedRepeats * 2, JSON.stringify(planA.summary))

    const noRepeat = generatePlan({ tasks, groups: ['off', 'native'], seed: 7, repeatFraction: 0, generatedAt: fixed })
    const allRepeat = generatePlan({ tasks, groups: ['off', 'native'], seed: 7, repeatFraction: 1, generatedAt: fixed })
    pass(results, 'self-test repeat fraction 0 and 1 boundaries', noRepeat.repeats.length === 0 && allRepeat.repeats.length === tasks.length)

    const stagedPlan = generatePlan({ tasks, groups: ['native', 'staged'], seed: 3, repeatFraction: 0, generatedAt: fixed })
    pass(results, 'self-test staged experiment can use native+staged', stagedPlan.groups.join(',') === 'native,staged')

    // Real CLI determinism: two --out files with the same seed match after generatedAt removal.
    const outA = join(root, 'plan-a.json')
    const outB = join(root, 'plan-b.json')
    spawnCli(['--tasks', tasksPath, '--seed', '20261107', '--groups', 'off,native', '--out', outA])
    spawnCli(['--tasks', tasksPath, '--seed', '20261107', '--groups', 'off,native', '--out', outB])
    const cliA = JSON.parse(readFileSync(outA, 'utf8'))
    const cliB = JSON.parse(readFileSync(outB, 'utf8'))
    pass(results, 'self-test CLI --out writes a parseable plan', cliA.order.length === tasks.length * 2 + expectedRepeats * 2 && typeof cliA.generatedAt === 'string' && !Number.isNaN(Date.parse(cliA.generatedAt)))
    pass(results, 'self-test CLI same seed produces the same plan', JSON.stringify(stripGeneratedAt(cliA)) === JSON.stringify(stripGeneratedAt(cliB)))

    const dry = spawnCli(['--tasks', tasksPath, '--seed', '42', '--dry-run'])
    const dryPlan = JSON.parse(dry.stdout)
    pass(results, 'self-test --dry-run prints the plan and writes nothing', dryPlan.seed === 42 && dryPlan.order.length > 0 && !('out' in dryPlan))

    const failures = [
      ['unknown argument', ['--tasks', tasksPath, '--seed', '1', '--bogus', 'x']],
      ['missing --seed', ['--tasks', tasksPath, '--out', join(root, 'x.json')]],
      ['bad seed', ['--tasks', tasksPath, '--seed', 'abc', '--out', join(root, 'x.json')]],
      ['bad repeat fraction', ['--tasks', tasksPath, '--seed', '1', '--repeat-fraction', '1.5', '--out', join(root, 'x.json')]],
      ['unknown group', ['--tasks', tasksPath, '--seed', '1', '--groups', 'off,other', '--out', join(root, 'x.json')]],
      ['staged mixed with off', ['--tasks', tasksPath, '--seed', '1', '--groups', 'off,staged', '--out', join(root, 'x.json')]],
      ['missing --out without --dry-run', ['--tasks', tasksPath, '--seed', '1']],
      ['duplicate taskId', ['--tasks', (() => { const p = join(root, 'dup.json'); writeFileSync(p, JSON.stringify({ tasks: [{ taskId: 'dup', repo: 'r', category: 'defect-fix' }, { taskId: 'dup', repo: 'r', category: 'defect-fix' }] })); return p })(), '--seed', '1', '--out', join(root, 'x.json')]],
      ['bad category', ['--tasks', (() => { const p = join(root, 'cat.json'); writeFileSync(p, JSON.stringify({ tasks: [{ taskId: 'a-task', repo: 'r', category: 'nope' }] })); return p })(), '--seed', '1', '--out', join(root, 'x.json')]],
      ['unreadable tasks file', ['--tasks', join(root, 'missing.json'), '--seed', '1', '--out', join(root, 'x.json')]],
    ]
    for (const [label, args] of failures) {
      const result = spawnCliExpectFailure(args)
      pass(results, `self-test rejects invalid input: ${label} (exit 2)`, result.status === 2, `status=${result.status} ${result.stdout.slice(0, 300)}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  for (const line of results) console.log(line)
  const failed = results.filter(line => line.startsWith('FAIL')).length
  if (failed > 0) { console.log(`\nFAILED: ${failed} assertion(s)`); return 1 }
  console.log(`\nPASS: ${results.length} assertions (b5-plan self-test)`)
  return 0
}

function usage() {
  return 'usage: node eval/b5-plan.mjs --tasks <tasks.json> --seed <int> [--groups off,native] [--repeat-fraction 0.2] (--out <plan.json> | --dry-run)\n       node eval/b5-plan.mjs --self-test'
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(usage())
    process.exitCode = 2
  }
  if (options && options.help) { console.log(usage()); process.exitCode = 0 }
  else if (options && options.selfTest) process.exitCode = selfTest()
  else if (options) {
    try {
      const tasks = readTasksFile(options.tasks)
      const plan = generatePlan({ tasks, groups: options.groups, seed: options.seed, repeatFraction: options.repeatFraction, source: options.tasks })
      const text = `${JSON.stringify(plan, null, 2)}\n`
      if (options.dryRun) process.stdout.write(text)
      else writeFileSync(options.out, text)
      if (!options.dryRun) console.error(`plan written: ${options.out} (${plan.summary.runs} runs, seed=${plan.seed}, repeats=${plan.repeats.length})`)
    } catch (error) {
      const usageError = error instanceof UsageError
      console.error(error instanceof Error ? error.message : String(error))
      if (usageError) { console.error(usage()); process.exitCode = 2 } else process.exitCode = 1
    }
  }
}
