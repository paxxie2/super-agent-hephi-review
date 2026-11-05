// 回归测试：eval/ab-metrics.mjs 只做描述性测量与汇总。
//
//   node --test eval/ab-metrics.test.mjs
//
// 说明：这里的构造数据只验证程序行为，不证明赫菲插件效果，也不构成真实业务端到端验证。
// 标记为“夹具集成测试”的用例使用临时 Git 仓库和真实 git 命令。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { measure, summarize } from './ab-metrics.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'ab-metrics.mjs')
const createdRoots = []

after(() => {
  for (const root of createdRoots) rmSync(root, { recursive: true, force: true })
})

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })

function mkRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ab-metrics-fixture-'))
  createdRoots.push(root)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'Fixture Runner')
  git(root, 'config', 'user.email', 'fixture@example.invalid')
  git(root, 'config', 'commit.gpgsign', 'false')
  return root
}

function write(root, rel, content) {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function commit(root, message, { allowEmpty = false } = {}) {
  git(root, 'add', '-A')
  const args = ['commit', '-q', '-m', message]
  if (allowEmpty) args.push('--allow-empty')
  git(root, ...args)
  return git(root, 'rev-parse', 'HEAD').trim()
}

// 夹具集成测试仓库：范围内改动、范围外改动、纯空白改动、重命名、删除测试文件。
function scenarioRepo() {
  const root = mkRepo()
  write(root, 'src/app.js', 'export const value = 1\n')
  write(root, 'src/other.js', 'export const other = 1\n')
  write(root, 'docs/old.md', 'old doc\n')
  write(root, 'docs/guide.md', 'guide\n')
  write(root, 'tests/app.test.mjs', 'test\n')
  const base = commit(root, 'base')
  write(root, 'src/app.js', 'export const value = 2\n')
  write(root, 'src/other.js', 'export const other = 2\n')
  write(root, 'docs/guide.md', 'guide \n') // 纯空白改动
  execFileSync('git', ['mv', 'docs/old.md', 'docs/new.md'], { cwd: root })
  rmSync(join(root, 'tests/app.test.mjs'))
  const head = commit(root, 'head')
  return { root, base, head }
}

// ---- 单元测试：summarize 只返回分组均值，不生成效果判定 ----

test('summarize: 空输入只返回 { arms: {} }', () => {
  const result = summarize([])
  assert.deepEqual(result, { arms: {} })
  assert.deepEqual(Object.keys(result), ['arms'])
})

test('summarize: off/native/staged 三组均值正确，且不含伪语义指标与结论字段', () => {
  const rows = [
    {
      arm: 'off', outsideLines: 100, outsideShare: 0.5, deletedTests: 2, hiddenPass: true,
      humanDriftScore: 2, minutes: 10, tokens: 1000, readyDenials: 1,
      formatOnlyFiles: 5, renames: 2,
    },
    {
      arm: 'off', outsideLines: 50, outsideShare: 0.25, deletedTests: 0, hiddenPass: false,
      humanDriftScore: 1, minutes: 20, tokens: 2000, readyDenials: 0,
      formatOnlyFiles: 3, renames: 1,
    },
    {
      arm: 'native', outsideLines: 10, outsideShare: 0.1, deletedTests: 0, hiddenPass: true,
      humanDriftScore: 1, minutes: 12, tokens: 1500, readyDenials: 0,
      formatOnlyFiles: 0, renames: 0,
    },
    {
      arm: 'staged', outsideLines: 5, outsideShare: 0.05, deletedTests: 0, hiddenPass: false,
      humanDriftScore: 0, minutes: 11, tokens: 900, readyDenials: 0,
      formatOnlyFiles: 0, renames: 0,
    },
  ]
  const result = summarize(rows)
  assert.deepEqual(Object.keys(result), ['arms'])
  assert.deepEqual(Object.keys(result.arms).sort(), ['native', 'off', 'staged'])

  assert.deepEqual(result.arms.off, {
    runs: 2,
    outsideLines: 75,
    outsideShare: 0.375,
    deletedTests: 1,
    hiddenPassRate: 0.5,
    humanDriftScore: 1.5,
    minutes: 15,
    tokens: 1500,
    readyDenials: 0.5,
  })
  assert.deepEqual(result.arms.native, {
    runs: 1,
    outsideLines: 10,
    outsideShare: 0.1,
    deletedTests: 0,
    hiddenPassRate: 1,
    humanDriftScore: 1,
    minutes: 12,
    tokens: 1500,
    readyDenials: 0,
  })
  assert.deepEqual(result.arms.staged, {
    runs: 1,
    outsideLines: 5,
    outsideShare: 0.05,
    deletedTests: 0,
    hiddenPassRate: 0,
    humanDriftScore: 0,
    minutes: 11,
    tokens: 900,
    readyDenials: 0,
  })

  for (const arm of Object.values(result.arms)) {
    assert.equal(Object.hasOwn(arm, 'unrelatedRefactor'), false)
  }
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('verdict'), false)
  assert.equal(serialized.includes('"effective"'), false)
  assert.equal(serialized.includes('outsideLinesDrop'), false)
  assert.equal(serialized.includes('unrelatedRefactorDrop'), false)
  assert.equal(serialized.includes('completionHeld'), false)
})

test('summarize: 旧逻辑可能判定 effective=true 的输入不再产生效果结论', () => {
  // off 组范围外行数 100，native 10（下降 90%）；无关重构指标也明显下降；
  // 隐藏测试通过率持平 —— 旧实现会输出 effective=true。
  const rows = [
    {
      arm: 'off', outsideLines: 100, outsideShare: 0.5, deletedTests: 1, hiddenPass: true,
      humanDriftScore: 1, minutes: 10, tokens: 1000, readyDenials: 0,
      formatOnlyFiles: 6, renames: 4,
    },
    {
      arm: 'native', outsideLines: 10, outsideShare: 0.1, deletedTests: 0, hiddenPass: true,
      humanDriftScore: 1, minutes: 10, tokens: 1000, readyDenials: 0,
      formatOnlyFiles: 0, renames: 0,
    },
  ]
  const result = summarize(rows)
  assert.deepEqual(Object.keys(result), ['arms'])
  assert.deepEqual(Object.keys(result.arms).sort(), ['native', 'off'])
  assert.equal(result.verdict, undefined)
  assert.equal(result.arms.native.effective, undefined)
  assert.equal(result.arms.native.completionHeld, undefined)
  assert.equal(result.arms.native.outsideLinesDrop, undefined)
  assert.equal(result.arms.native.unrelatedRefactorDrop, undefined)
})

test('summarize: 缺少 off 对照组时不抛错、不生成结论', () => {
  const rows = [
    { arm: 'native', outsideLines: 10, outsideShare: 0.1, deletedTests: 0, hiddenPass: true, humanDriftScore: 1, minutes: 12, tokens: 1500, readyDenials: 0 },
    { arm: 'staged', outsideLines: 5, outsideShare: 0.05, deletedTests: 0, hiddenPass: false, humanDriftScore: 0, minutes: 11, tokens: 900, readyDenials: 0 },
  ]
  const result = summarize(rows)
  assert.deepEqual(Object.keys(result), ['arms'])
  assert.deepEqual(Object.keys(result.arms).sort(), ['native', 'staged'])
  assert.equal(JSON.stringify(result).includes('effective'), false)
})

test('summarize: 零基线（off 组 outsideLines 为 0）不产生相对变化或判定', () => {
  const rows = [
    { arm: 'off', outsideLines: 0, outsideShare: 0, deletedTests: 0, hiddenPass: true, humanDriftScore: 0, minutes: 10, tokens: 1000, readyDenials: 0 },
    { arm: 'native', outsideLines: 10, outsideShare: 0.1, deletedTests: 0, hiddenPass: true, humanDriftScore: 0, minutes: 10, tokens: 1000, readyDenials: 0 },
  ]
  const result = summarize(rows)
  assert.deepEqual(Object.keys(result), ['arms'])
  assert.equal(result.arms.off.outsideLines, 0)
  assert.equal(result.arms.native.outsideLines, 10)
  assert.equal(JSON.stringify(result).includes('Drop'), false)
})

// ---- 夹具集成测试：measure 仍从 Git 提取机械指标 ----

test('measure（夹具集成测试）: 保留机械指标，删除格式化/重命名指标', () => {
  const { root, base, head } = scenarioRepo()
  const row = measure(
    { task: 'demo', arm: 'off', repo: root, base, head, minutes: 10, tokens: 1000, readyDenials: 1, humanDriftScore: 2 },
    { expectedFiles: ['src/app.js'] },
  )
  assert.equal(row.task, 'demo')
  assert.equal(row.arm, 'off')
  assert.equal(row.files, 6)
  assert.equal(row.lines, 9)
  assert.equal(row.outsideFiles, 5)
  assert.equal(row.outsideLines, 7)
  assert.equal(row.outsideShare, 7 / 9)
  assert.equal(row.deletedTests, 1)
  assert.equal(row.hiddenPass, null)
  assert.equal(row.minutes, 10)
  assert.equal(row.tokens, 1000)
  assert.equal(row.readyDenials, 1)
  assert.equal(row.humanDriftScore, 2)
  assert.equal(Object.hasOwn(row, 'formatOnlyFiles'), false)
  assert.equal(Object.hasOwn(row, 'renames'), false)
})

test('measure（夹具集成测试）: 隐藏测试成功返回 true，失败返回 false，未配置返回 null', () => {
  const { root, base, head } = scenarioRepo()
  const run = { task: 'demo', arm: 'off', repo: root, base, head }

  const passing = measure(run, { expectedFiles: ['src/app.js'], hiddenTest: 'test -f src/app.js' })
  assert.equal(passing.hiddenPass, true)

  const failing = measure(run, { expectedFiles: ['src/app.js'], hiddenTest: 'test -f missing.js' })
  assert.equal(failing.hiddenPass, false)

  const unset = measure(run, { expectedFiles: ['src/app.js'] })
  assert.equal(unset.hiddenPass, null)
})

test('measure（夹具集成测试）: 执行隐藏测试后原 HEAD 保持不变且 worktree 被清理', () => {
  const { root, base, head } = scenarioRepo()
  const headBefore = git(root, 'rev-parse', 'HEAD').trim()
  const statusBefore = git(root, 'status', '--porcelain').trim()

  measure({ task: 'demo', arm: 'off', repo: root, base, head }, { expectedFiles: ['src/app.js'], hiddenTest: 'test -f src/app.js' })
  measure({ task: 'demo', arm: 'native', repo: root, base, head }, { expectedFiles: ['src/app.js'], hiddenTest: 'exit 3' })

  assert.equal(git(root, 'rev-parse', 'HEAD').trim(), headBefore)
  assert.equal(git(root, 'status', '--porcelain').trim(), statusBefore)
  const worktrees = git(root, 'worktree', 'list', '--porcelain').trim().split('\n\n').filter(Boolean)
  assert.equal(worktrees.length, 1)
})

test('measure（夹具集成测试）: 无改动提交产生零 diff', () => {
  const root = mkRepo()
  write(root, 'src/app.js', 'export const value = 1\n')
  const base = commit(root, 'base')
  const head = commit(root, 'noop', { allowEmpty: true })

  const row = measure({ task: 'demo', arm: 'native', repo: root, base, head }, { expectedFiles: ['src/app.js'] })
  assert.equal(row.files, 0)
  assert.equal(row.lines, 0)
  assert.equal(row.outsideFiles, 0)
  assert.equal(row.outsideLines, 0)
  assert.equal(row.outsideShare, 0)
  assert.equal(row.deletedTests, 0)
  assert.equal(row.hiddenPass, null)
})

// ---- CLI：实际命令行入口只输出 rows 与 arms ----

test('CLI（夹具集成测试）: 输出 { rows, arms }，不含结论字段', () => {
  const { root, base, head } = scenarioRepo()
  const dir = mkdtempSync(join(tmpdir(), 'ab-metrics-cli-'))
  createdRoots.push(dir)
  const input = join(dir, 'runs.json')
  writeFileSync(input, JSON.stringify({
    tasks: { demo: { expectedFiles: ['src/app.js'], hiddenTest: 'test -f src/app.js' } },
    runs: [
      { task: 'demo', arm: 'off', repo: root, base, head },
      { task: 'demo', arm: 'native', repo: root, base, head },
    ],
  }))

  const headBefore = git(root, 'rev-parse', 'HEAD').trim()
  const output = execFileSync(process.execPath, [script, input], { encoding: 'utf8' })
  const parsed = JSON.parse(output)

  assert.deepEqual(Object.keys(parsed).sort(), ['arms', 'rows'])
  assert.equal(parsed.rows.length, 2)
  assert.deepEqual(parsed.rows.map(row => row.arm), ['off', 'native'])
  for (const row of parsed.rows) {
    assert.equal(row.hiddenPass, true)
    assert.equal(row.files, 6)
    assert.equal(row.outsideLines, 7)
    assert.equal(Object.hasOwn(row, 'formatOnlyFiles'), false)
    assert.equal(Object.hasOwn(row, 'renames'), false)
  }
  assert.deepEqual(Object.keys(parsed.arms).sort(), ['native', 'off'])
  for (const arm of Object.values(parsed.arms)) {
    assert.equal(Object.hasOwn(arm, 'unrelatedRefactor'), false)
  }
  const serialized = JSON.stringify(parsed)
  assert.equal(serialized.includes('"verdict"'), false)
  assert.equal(serialized.includes('"effective"'), false)
  assert.equal(git(root, 'rev-parse', 'HEAD').trim(), headBefore)
})
