#!/usr/bin/env node
// ROADMAP-95 工作线 B / B4：盲评材料导出骨架。
//
// 职责：把一批运行整理成盲评材料，并**在导出前扫描/拒绝组别痕迹**。
// 只隐藏“组别”和能看出组别的痕迹（分支名、提交信息、赫菲输出），不删除理解语义需要的内容。
//
// 用法：
//   node eval/label/export.mjs --manifest <runs.json> --out <材料目录> --mapping <私有映射.json>
//                              [--seed 20261107] [--scan-only] [--json]
//
// 输入 manifest（见 eval/RUNBOOK.md §7）：
//   {
//     "batch": "pilot-01",
//     "seed": 20261107,
//     "tasks": { "<taskId>": { "taskDir": "eval/tasks/<repo>/<taskId>" } },
//     "runs": [
//       { "runId": "pilot-01-t01-off", "taskId": "t01", "arm": "off", "repetition": 1,
//         "repo": "/abs/path", "base": "<40hex>", "head": "<40hex|ref>",
//         "requirement": "可选：覆盖任务卡路径" }
//     ]
//   }
//
// 输出材料目录结构：
//   <out>/manifest.json          # 盲评清单（无组别/taskId/runId）
//   <out>/labels.template.json   # 标注模板（字段为 null，供两名盲评者填写）
//   <out>/cases/<blindId>/diff.patch
//   <out>/cases/<blindId>/requirement.md
//   <out>/cases/<blindId>/allowed-scope.md
//   <out>/cases/<blindId>/case.json
//
// 私有映射（盲评结束后才可打开）：<mapping> 记录 blindId → runId/arm/taskId。
// **映射文件不允许放在材料目录内**，否则脚本直接拒绝。
//
// 退出码：0=导出成功；1=发现组别痕迹/材料无效；2=用法或环境缺失。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ARMS = new Set(['legacy-system', 'full-package', 'off', 'native', 'staged'])
const DEFAULT_SEED = 20261107

// 硬痕迹：命中即拒绝导出（fail-closed）。只匹配能直接暴露组别/赫菲的标记，
// 不把普通英文词汇（如 "turn off"）误判为组别痕迹。
const HARD_TRACE_PATTERNS = [
  { id: 'hephi', re: /hephi/i },
  { id: 'hephi-zh', re: /赫菲/ },
  { id: 'full-package-group', re: /full-package\s*(?:arm|group|组)/i },
  { id: 'legacy-system-group', re: /legacy-system\s*(?:arm|group|组)/i },
  { id: 'native-group', re: /native\s*(?:arm|group|组)/i },
  { id: 'off-group', re: /\boff\s*(?:arm|group|组)/i },
  { id: 'staged-group', re: /staged\s*(?:arm|group|组)/i },
  { id: 'shadow-group', re: /shadow\s*(?:arm|group|组)/i },
  { id: 'arm-equals', re: /\barm\s*[=:]\s*(?:off|native|staged|shadow|legacy-system|full-package)\b/i },
  { id: 'plugin-commit', re: /pluginCommit|loadedShaReadback/i },
  { id: 'roadmap', re: /ROADMAP[-_ ]?95/i },
  { id: 'branch-ref', re: /\b(?:agent|docs|codex|fix|feat)\/[a-z0-9][a-z0-9._-]*/i },
  { id: 'pull-ref', re: /\bpull\/\d+\b|#\d{2,4}\b(?=[^\n]*(?:merge|pr\b))/i },
  { id: 'run-id-arm', re: /\b[a-z0-9][a-z0-9._-]*[-_](?:off|native|staged|legacy-system|full-package)[-_][a-z0-9._-]+\b/i },
  { id: 'decision-log', re: /decisions\.jsonl/i },
  // F06：已发现的漏配写法——当前 schema 的 JSON 形态、带引号/空格的赋值、现行中文组名，
  // 以及裸 legacy-system/full-package。全部按硬痕迹 fail-closed（不静默删正文后放行）。
  { id: 'arm-json', re: /"arm"\s*:\s*"(?:legacy-system|full-package|off|native|staged|shadow)"/i },
  { id: 'arm-quoted', re: /\barm\b\s*(?:=+|:|：)\s*["'`]\s*(?:legacy-system|full-package|off|native|staged|shadow)\s*["'`]/i },
  { id: 'arm-legacy-full', re: /\barm\b\s*(?:=+|:|：)\s*["'`]?\s*(?:legacy-system|full-package)\b/i },
  { id: 'legacy-system-word', re: /legacy-system/i },
  { id: 'full-package-word', re: /full-package/i },
  { id: 'zh-group', re: /原系统组|整包组|原系统|整包/ },
  { id: 'zh-group-json', re: /"(?:group|arm|组别|运行分组)"\s*:\s*"(?:原系统组|整包组|原系统|整包|legacy-system|full-package)"/i },
]

// 软痕迹：只在 requirement/allowed-scope 正文里提示（不阻断），由材料作者人工判断。
const SOFT_TRACE_PATTERNS = [
  { id: 'word-off', re: /(?<![\w-])off(?![\w-])/i },
  { id: 'word-native', re: /(?<![\w-])native(?![\w-])/i },
  { id: 'word-staged', re: /(?<![\w-])staged(?![\w-])/i },
  { id: 'word-shadow', re: /(?<![\w-])shadow(?![\w-])/i },
]

const USAGE = `用法：
  node eval/label/export.mjs --manifest <runs.json> --out <材料目录> --mapping <私有映射.json> [--seed 20261107] [--scan-only] [--json]
退出码：0=成功；1=发现组别痕迹/材料无效；2=用法或环境缺失。`

function usage(message) {
  console.error(`[label-export] ${message}\n\n${USAGE}`)
  process.exit(2)
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = process.argv[i + 1]
  return next === undefined || next.startsWith('--') ? fallback : next
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

// L02：仅比较词法路径会让 outside-alias（目录符号链接→公开材料目录）绕过隔离，
// 私有 mapping 实际写进 blind 目录。这里解析真实路径（含父目录链接与悬空文件链接）后比较。
function realpathLoose(target) {
  const absolute = resolve(target)
  try {
    return realpathSync(absolute)
  } catch {
    // 路径不存在或悬空符号链接：若是链接则先解析链接目标，再继续按最深已存在祖先解析。
  }
  try {
    if (lstatSync(absolute).isSymbolicLink()) {
      const link = readlinkSync(absolute)
      return realpathLoose(resolve(dirname(absolute), link))
    }
  } catch {
    // 不存在：走已存在祖先解析。
  }
  let current = absolute
  const suffix = []
  while (true) {
    const parent = dirname(current)
    if (parent === current) break
    suffix.unshift(basename(current))
    current = parent
    try {
      return join(realpathSync(current), ...suffix)
    } catch {
      // 继续向上。
    }
  }
  return absolute
}

function ensureOutside(target, dir) {
  // 词法路径在材料目录内一律拒绝（保持既有隔离语义），再按真实路径核对父目录/最终目标。
  const lexicalTarget = resolve(target)
  const lexicalDir = resolve(dir)
  if (lexicalTarget === lexicalDir || lexicalTarget.startsWith(`${lexicalDir}${sep}`)) return false
  const t = realpathLoose(target)
  const d = realpathLoose(dir)
  return t !== d && !t.startsWith(`${d}${sep}`)
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffled(items, seed) {
  const rng = mulberry32(seed)
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = copy[i]
    copy[i] = copy[j]
    copy[j] = tmp
  }
  return copy
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
}

function scanTraces(label, text, patterns) {
  const hits = []
  const lines = text.split('\n')
  for (const pattern of patterns) {
    for (let i = 0; i < lines.length; i += 1) {
      if (pattern.re.test(lines[i])) {
        hits.push({ layer: label, pattern: pattern.id, line: i + 1, excerpt: lines[i].trim().slice(0, 200) })
        break // 同一 pattern 每个材料只报一次，避免刷屏
      }
    }
  }
  return hits
}

function loadManifest(manifestPath) {
  if (!existsSync(manifestPath)) usage(`manifest 不存在：${manifestPath}`)
  let manifest
  try {
    manifest = readJson(manifestPath)
  } catch (error) {
    usage(`manifest 不是合法 JSON：${error.message}`)
  }
  if (typeof manifest.batch !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(manifest.batch)) {
    usage('manifest.batch 必须匹配 ^[a-z0-9][a-z0-9._-]{1,63}$')
  }
  if (!Array.isArray(manifest.runs) || manifest.runs.length === 0) usage('manifest.runs 必须是非空数组')
  const tasks = manifest.tasks && typeof manifest.tasks === 'object' ? manifest.tasks : {}
  const seen = new Set()
  for (const run of manifest.runs) {
    const missing = ['runId', 'taskId', 'arm', 'repo', 'base', 'head'].filter((field) => !run[field])
    if (missing.length > 0) usage(`run ${run.runId ?? '?'} 缺少字段：${missing.join(', ')}`)
    if (!ARMS.has(run.arm)) usage(`run ${run.runId} 的 arm 必须是 ${[...ARMS].join('/')}`)
    if (seen.has(run.runId)) usage(`runId 重复：${run.runId}`)
    seen.add(run.runId)
    if (!tasks[run.taskId] || !tasks[run.taskId].taskDir) usage(`tasks.${run.taskId}.taskDir 缺失`)
  }
  return { manifest, tasks }
}

function collectCase(run, task, seed) {
  const taskDir = resolve(REPO_ROOT, task.taskDir)
  if (!existsSync(taskDir)) {
    return { error: `taskDir 不存在：${taskDir}` }
  }
  const requirementPath = run.requirement
    ? resolve(REPO_ROOT, run.requirement)
    : resolve(taskDir, 'issue.md')
  const allowedScopePath = resolve(taskDir, 'review.md')
  if (!existsSync(requirementPath)) return { error: `requirement 不存在：${requirementPath}` }
  if (!existsSync(allowedScopePath)) return { error: `allowed-scope 不存在：${allowedScopePath}` }

  let diffText
  let changedFiles
  let binaryFiles
  try {
    const range = [`${run.base}..${run.head}`]
    diffText = git(run.repo, ['diff', '--no-renames', '--no-color', '--no-ext-diff', '--unified=3', ...range])
    changedFiles = git(run.repo, ['diff', '--name-only', '--no-renames', ...range]).split('\n').filter(Boolean)
    binaryFiles = git(run.repo, ['diff', '--numstat', '--no-renames', ...range])
      .split('\n')
      .filter((row) => row.includes('\t-\t'))
      .map((row) => row.split('\t').pop())
      .filter(Boolean)
  } catch (error) {
    return { error: `git diff 失败（${run.runId}）：${error.message.split('\n')[0]}` }
  }
  const requirement = readFileSync(requirementPath, 'utf8')
  const allowedScope = readFileSync(allowedScopePath, 'utf8')

  const hardFindings = [
    ...scanTraces('requirement', requirement, HARD_TRACE_PATTERNS),
    ...scanTraces('allowed-scope', allowedScope, HARD_TRACE_PATTERNS),
    ...scanTraces('diff', diffText, HARD_TRACE_PATTERNS),
  ]
  const weakFindings = [
    ...scanTraces('requirement', requirement, SOFT_TRACE_PATTERNS),
    ...scanTraces('allowed-scope', allowedScope, SOFT_TRACE_PATTERNS),
  ]
  return {
    diffText,
    requirement,
    allowedScope,
    changedFiles,
    binaryFiles,
    hardFindings,
    weakFindings,
    requirementSha256: sha256(requirement),
    allowedScopeSha256: sha256(allowedScope),
    patchSha256: sha256(diffText),
  }
}

function runExport(options) {
  const { manifest, tasks } = loadManifest(options.manifest)
  const out = resolve(options.out)
  const mappingPath = resolve(options.mapping)
  if (existsSync(out) && readdirSync(out).length > 0) {
    return { exitCode: 2, error: `材料目录已存在且非空，拒绝覆盖：${out}` }
  }
  if (!ensureOutside(mappingPath, out)) {
    return { exitCode: 2, error: '私有映射文件不允许放在材料目录内（会泄漏组别），请换路径' }
  }
  if (existsSync(mappingPath)) {
    return { exitCode: 2, error: `私有映射文件已存在，拒绝覆盖：${mappingPath}` }
  }

  const seed = Number(options.seed ?? manifest.seed ?? DEFAULT_SEED)
  const order = shuffled(manifest.runs.map((run) => run.runId), seed)
  const runById = new Map(manifest.runs.map((run) => [run.runId, run]))

  const cases = []
  const scan = { hard: [], weak: [] }
  for (let i = 0; i < order.length; i += 1) {
    const run = runById.get(order[i])
    const blindId = `case-${String(i + 1).padStart(3, '0')}`
    const collected = collectCase(run, tasks[run.taskId], seed)
    if (collected.error) return { exitCode: 1, error: collected.error, scan }
    scan.hard.push(...collected.hardFindings.map((hit) => ({ blindId, ...hit })))
    scan.weak.push(...collected.weakFindings.map((hit) => ({ blindId, ...hit })))
    cases.push({ blindId, run, collected })
  }

  if (scan.hard.length > 0) {
    return { exitCode: 1, error: '导出材料中发现组别/赫菲硬痕迹，已拒绝导出。请先清理材料或修正任务卡/运行仓库内容。', scan }
  }
  if (options.scanOnly) {
    return { exitCode: 0, scan, cases: cases.length, wrote: false }
  }

  mkdirSync(join(out, 'cases'), { recursive: true })
  const manifestCases = []
  const templateCases = {}
  const mapping = {}
  for (const item of cases) {
    const caseDir = join(out, 'cases', item.blindId)
    mkdirSync(caseDir, { recursive: true })
    writeFileSync(join(caseDir, 'diff.patch'), item.collected.diffText, 'utf8')
    writeFileSync(join(caseDir, 'requirement.md'), item.collected.requirement, 'utf8')
    writeFileSync(join(caseDir, 'allowed-scope.md'), item.collected.allowedScope, 'utf8')
    const caseMeta = {
      blindId: item.blindId,
      changedFiles: item.collected.changedFiles,
      binaryFiles: item.collected.binaryFiles,
      patchSha256: item.collected.patchSha256,
      requirementSha256: item.collected.requirementSha256,
      allowedScopeSha256: item.collected.allowedScopeSha256,
      instructions: '按 eval/label/RUBRIC.md 以整次运行为单位标注；不得推测分组。',
    }
    writeFileSync(join(caseDir, 'case.json'), `${JSON.stringify(caseMeta, null, 2)}\n`, 'utf8')
    manifestCases.push({
      blindId: item.blindId,
      diffSha256: item.collected.patchSha256,
      requirementSha256: item.collected.requirementSha256,
      allowedScopeSha256: item.collected.allowedScopeSha256,
      changedFiles: item.collected.changedFiles.length,
    })
    templateCases[item.blindId] = {
      objectiveChanged: null,
      requiredFunctionImplemented: null,
      implementationDefect: { verdict: null, notes: null },
      unrelatedChanges: { has: null, notes: null, positions: [] },
      testWeakening: { has: null, notes: null, positions: [] },
    }
    mapping[item.blindId] = {
      runId: item.run.runId,
      taskId: item.run.taskId,
      arm: item.run.arm,
      repetition: item.run.repetition ?? 1,
      repo: item.run.repo,
      base: item.run.base,
      head: item.run.head,
    }
  }

  const exportManifest = {
    schemaVersion: 1,
    batch: manifest.batch,
    seed,
    caseCount: manifestCases.length,
    cases: manifestCases,
    scan: {
      hardFindings: 0,
      weakWarnings: scan.weak.map((hit) => ({ blindId: hit.blindId, layer: hit.layer, pattern: hit.pattern, line: hit.line })),
    },
    rubric: 'eval/label/RUBRIC.md',
    note: '本清单不含组别、taskId、runId；盲评结束后用私有映射还原。',
  }
  const exportManifestText = `${JSON.stringify(exportManifest, null, 2)}\n`
  const exportIdentity = { caseCount: manifestCases.length, manifestSha256: sha256(exportManifestText) }
  writeFileSync(join(out, 'manifest.json'), exportManifestText, 'utf8')
  // L01：标签模板也携带导出身份；import 用它核对 labels/manifest/mapping 三方一致，
  // 同批新导出不会再接受旧 labels（旧格式默认拒绝，历史兼容需显式 --allow-legacy-mapping）。
  writeFileSync(join(out, 'labels.template.json'), `${JSON.stringify({
    batch: manifest.batch,
    caseCount: exportIdentity.caseCount,
    manifestSha256: exportIdentity.manifestSha256,
    labeler: null,
    cases: templateCases,
  }, null, 2)}\n`, 'utf8')

  mkdirSync(dirname(mappingPath), { recursive: true })
  writeFileSync(mappingPath, `${JSON.stringify({
    schemaVersion: 1,
    batch: manifest.batch,
    seed,
    // F05/L01：导出清单身份；labels 模板携带同一身份，import 做三方一致核对。
    caseCount: exportIdentity.caseCount,
    manifestSha256: exportIdentity.manifestSha256,
    note: '私有映射：只在盲评结束后打开；不得与材料一起分发。',
    mapping,
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })

  return { exitCode: 0, out, mapping: mappingPath, cases: manifestCases.length, scan, wrote: true }
}

// ---- 自测 -----------------------------------------------------------------

function runCliSafe(args) {
  try {
    const stdout = execFileSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
    })
    return { status: 0, stdout: stdout ?? '', stderr: '' }
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

function selfTest(asJson) {
  const steps = []
  const record = (name, ok, detail) => steps.push({ name, ok, detail })
  const root = mkdtempSync(join(tmpdir(), 'hephi-label-self-'))
  const script = fileURLToPath(import.meta.url)
  try {
    // 合成 git 仓库：base 有 bug，head 修复。
    const repo = join(root, 'repo')
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(join(repo, 'src', 'calc.mjs'), 'export const add = (a, b) => a - b\n', 'utf8')
    const taskDir = join(root, 'task')
    mkdirSync(taskDir, { recursive: true })
    writeFileSync(join(taskDir, 'issue.md'), '# 任务占位\n\n## 任务\n修复 add。\n\n## 验收\nadd(2,3)=5。\n\n## 合法范围\n只改 src/**。\n', 'utf8')
    writeFileSync(join(taskDir, 'review.md'), '# 合法范围评审\n\n合法范围：src/**。这是合成自测材料。\n', 'utf8')
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'B4 Self Test', GIT_AUTHOR_EMAIL: 'b4@example.invalid',
      GIT_COMMITTER_NAME: 'B4 Self Test', GIT_COMMITTER_EMAIL: 'b4@example.invalid',
    }
    const gitIn = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv })
    gitIn(['init', '--quiet'])
    gitIn(['add', '-A'])
    gitIn(['commit', '--quiet', '-m', 'base'])
    const base = gitIn(['rev-parse', 'HEAD']).trim()
    writeFileSync(join(repo, 'src', 'calc.mjs'), 'export const add = (a, b) => a + b\n', 'utf8')
    gitIn(['add', '-A'])
    gitIn(['commit', '--quiet', '-m', 'fix'])
    const head = gitIn(['rev-parse', 'HEAD']).trim()

    const manifest = join(root, 'manifest.json')
    writeFileSync(manifest, JSON.stringify({
      batch: 'selftest-b4',
      seed: 7,
      tasks: { t1: { taskDir: taskDir } },
      runs: [{ runId: 'selftest-t1-off', taskId: 't1', arm: 'off', repo, base, head }],
    }), 'utf8')

    const cleanOut = join(root, 'out-clean')
    const cleanMapping = join(root, 'private', 'mapping.json')
    const clean = runCliSafe(['--manifest', manifest, '--out', cleanOut, '--mapping', cleanMapping])
    record('导出干净材料', clean.status === 0, `exit=${clean.status} ${clean.stderr.slice(0, 300)}`)
    const manifestOut = existsSync(join(cleanOut, 'manifest.json'))
    record('材料目录生成 manifest/template/case', manifestOut && existsSync(join(cleanOut, 'labels.template.json')) && existsSync(join(cleanOut, 'cases', 'case-001', 'diff.patch')), 'layout')
    const exportManifest = manifestOut ? JSON.parse(readFileSync(join(cleanOut, 'manifest.json'), 'utf8')) : null
    const leakedKeys = exportManifest
      ? [
          ...Object.keys(exportManifest).filter((key) => ['arm', 'taskId', 'runId', 'runs'].includes(key)),
          ...(exportManifest.cases ?? []).flatMap((item) => Object.keys(item).filter((key) => ['arm', 'taskId', 'runId'].includes(key))),
        ]
      : ['manifest 缺失']
    record('导出清单不含组别/taskId/runId 键', leakedKeys.length === 0, JSON.stringify(leakedKeys))
    record('私有映射与材料目录分离', existsSync(cleanMapping) && ensureOutside(cleanMapping, cleanOut), cleanMapping)

    // L01：标签模板必须携带与 blind manifest / 私有 mapping 一致的导出身份。
    const templateJson = existsSync(join(cleanOut, 'labels.template.json')) ? JSON.parse(readFileSync(join(cleanOut, 'labels.template.json'), 'utf8')) : null
    const cleanMappingJson = existsSync(cleanMapping) ? JSON.parse(readFileSync(cleanMapping, 'utf8')) : null
    const cleanManifestRaw = existsSync(join(cleanOut, 'manifest.json')) ? readFileSync(join(cleanOut, 'manifest.json'), 'utf8') : ''
    record('L01 标签模板携带与 manifest/mapping 一致的导出身份',
      Boolean(templateJson) && Boolean(cleanMappingJson)
        && templateJson.caseCount === 1
        && templateJson.manifestSha256 === sha256(cleanManifestRaw)
        && templateJson.caseCount === cleanMappingJson.caseCount
        && templateJson.manifestSha256 === cleanMappingJson.manifestSha256,
      `template=${JSON.stringify({ caseCount: templateJson?.caseCount, manifestSha256: templateJson?.manifestSha256 })} mapping=${JSON.stringify({ caseCount: cleanMappingJson?.caseCount, manifestSha256: cleanMappingJson?.manifestSha256 })}`)

    // L02：符号链接绕过隔离必须拒绝；正常（含指向外部的链接）路径仍通过。
    const symlinkOut = join(root, 'out-symlink-l02')
    mkdirSync(symlinkOut, { recursive: true })
    const outsideAlias = join(root, 'outside-alias')
    symlinkSync(symlinkOut, outsideAlias, 'dir')
    const symlinkMappingRun = runCliSafe(['--manifest', manifest, '--out', symlinkOut, '--mapping', join(outsideAlias, 'private.json')])
    record('L02 负例：--mapping 经目录符号链接实际落入材料目录 → 拒绝（exit 2，不写文件）',
      symlinkMappingRun.status === 2 && !existsSync(join(symlinkOut, 'private.json')),
      `exit=${symlinkMappingRun.status} leaked=${existsSync(join(symlinkOut, 'private.json'))}`)

    const nestedOut = join(root, 'out-nested-l02')
    mkdirSync(nestedOut, { recursive: true })
    const nestedAlias = join(root, 'nested-alias-l02')
    symlinkSync(nestedOut, nestedAlias, 'dir')
    const nestedSymlinkRun = runCliSafe(['--manifest', manifest, '--out', nestedOut, '--mapping', join(nestedAlias, 'sub', 'private.json')])
    record('L02 负例：--mapping 父目录链接（含不存在子目录）指向材料目录 → 拒绝（exit 2）',
      nestedSymlinkRun.status === 2 && !existsSync(join(nestedOut, 'sub', 'private.json')),
      `exit=${nestedSymlinkRun.status}`)

    const danglingOut = join(root, 'out-dangling-l02')
    mkdirSync(danglingOut, { recursive: true })
    const danglingMapping = join(root, 'mapping-dangling.json')
    symlinkSync(join(danglingOut, 'actual.json'), danglingMapping)
    const danglingRun = runCliSafe(['--manifest', manifest, '--out', danglingOut, '--mapping', danglingMapping])
    record('L02 负例：--mapping 是悬空符号链接且目标在材料目录内 → 拒绝（exit 2）',
      danglingRun.status === 2 && !existsSync(join(danglingOut, 'actual.json')),
      `exit=${danglingRun.status} leaked=${existsSync(join(danglingOut, 'actual.json'))}`)

    const outsideTarget = join(root, 'outside-mapping-target')
    mkdirSync(outsideTarget, { recursive: true })
    const outsideOkAlias = join(root, 'outside-alias-ok')
    symlinkSync(outsideTarget, outsideOkAlias, 'dir')
    const outsideAliasRun = runCliSafe(['--manifest', manifest, '--out', join(root, 'out-alias-ok'), '--mapping', join(outsideOkAlias, 'private.json')])
    record('L02 正例：--mapping 经符号链接指向材料目录之外 → 允许（exit 0）',
      outsideAliasRun.status === 0 && existsSync(join(outsideTarget, 'private.json')),
      `exit=${outsideAliasRun.status}`)

    const insideMapping = runCliSafe(['--manifest', manifest, '--out', join(root, 'out-inside'), '--mapping', join(root, 'out-inside', 'mapping.json')])
    record('负例：映射放进材料目录 → 拒绝（exit 2）', insideMapping.status === 2, `exit=${insideMapping.status}`)

    // 痕迹材料：diff 内容包含 hephi 标记。
    const tracedRepo = join(root, 'repo-traced')
    mkdirSync(join(tracedRepo, 'src'), { recursive: true })
    writeFileSync(join(tracedRepo, 'src', 'calc.mjs'), 'export const add = (a, b) => a - b\n', 'utf8')
    const gitTraced = (args) => execFileSync('git', args, { cwd: tracedRepo, encoding: 'utf8', env: gitEnv })
    gitTraced(['init', '--quiet'])
    gitTraced(['add', '-A'])
    gitTraced(['commit', '--quiet', '-m', 'base'])
    const tracedBase = gitTraced(['rev-parse', 'HEAD']).trim()
    writeFileSync(join(tracedRepo, 'src', 'calc.mjs'), 'export const add = (a, b) => a + b\n// hephi output: ready\n', 'utf8')
    gitTraced(['add', '-A'])
    gitTraced(['commit', '--quiet', '-m', 'fix'])
    const tracedHead = gitTraced(['rev-parse', 'HEAD']).trim()
    const tracedManifest = join(root, 'manifest-traced.json')
    writeFileSync(tracedManifest, JSON.stringify({
      batch: 'selftest-b4-trace',
      seed: 7,
      tasks: { t1: { taskDir } },
      runs: [{ runId: 'selftest-t1-native', taskId: 't1', arm: 'native', repo: tracedRepo, base: tracedBase, head: tracedHead }],
    }), 'utf8')
    const traced = runCliSafe(['--manifest', tracedManifest, '--out', join(root, 'out-traced'), '--mapping', join(root, 'private', 'mapping-traced.json')])
    record('负例：材料含 hephi 痕迹 → 拒绝导出（exit 1）', traced.status === 1, `exit=${traced.status} ${traced.stderr.slice(0, 200)}`)

    // B4-01：分支名/提交信息类组别痕迹 → 拒绝导出（fail-closed）。
    const gitAt = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv })
    const makeTracedRepo = (dirName, headContent) => {
      const tracedRepo = join(root, dirName)
      mkdirSync(join(tracedRepo, 'src'), { recursive: true })
      writeFileSync(join(tracedRepo, 'src', 'calc.mjs'), 'export const add = (a, b) => a - b\n', 'utf8')
      gitAt(tracedRepo, ['init', '--quiet'])
      gitAt(tracedRepo, ['add', '-A'])
      gitAt(tracedRepo, ['commit', '--quiet', '-m', 'base'])
      const tracedBase = gitAt(tracedRepo, ['rev-parse', 'HEAD']).trim()
      writeFileSync(join(tracedRepo, 'src', 'calc.mjs'), headContent, 'utf8')
      gitAt(tracedRepo, ['add', '-A'])
      gitAt(tracedRepo, ['commit', '--quiet', '-m', 'fix'])
      return { tracedRepo, tracedBase, tracedHead: gitAt(tracedRepo, ['rev-parse', 'HEAD']).trim() }
    }
    const branchTrace = makeTracedRepo('repo-branch-trace', 'export const add = (a, b) => a + b\n// 来自 agent/b4b6-stats 分支\n')
    const branchManifest = join(root, 'manifest-branch.json')
    writeFileSync(branchManifest, JSON.stringify({
      batch: 'selftest-b4-branch',
      seed: 7,
      tasks: { t1: { taskDir } },
      runs: [{ runId: 'selftest-t1-off', taskId: 't1', arm: 'off', repo: branchTrace.tracedRepo, base: branchTrace.tracedBase, head: branchTrace.tracedHead }],
    }), 'utf8')
    const branchTraceRun = runCliSafe(['--manifest', branchManifest, '--out', join(root, 'out-branch-trace'), '--mapping', join(root, 'private', 'mapping-branch.json')])
    record('B4-01 负例：diff 含分支名 agent/... → 拒绝导出（exit 1）', branchTraceRun.status === 1, `exit=${branchTraceRun.status} ${branchTraceRun.stderr.slice(0, 200)}`)

    const redactionRepo = makeTracedRepo('repo-redaction-trace', 'export const add = (a, b) => a + b\n// loadedShaReadback: abc123\n')
    const redactionManifest = join(root, 'manifest-redaction.json')
    writeFileSync(redactionManifest, JSON.stringify({
      batch: 'selftest-b4-plugin-trace',
      seed: 7,
      tasks: { t1: { taskDir } },
      runs: [{ runId: 'selftest-t1-native', taskId: 't1', arm: 'native', repo: redactionRepo.tracedRepo, base: redactionRepo.tracedBase, head: redactionRepo.tracedHead }],
    }), 'utf8')
    const redactionRun = runCliSafe(['--manifest', redactionManifest, '--out', join(root, 'out-redaction-trace'), '--mapping', join(root, 'private', 'mapping-redaction.json')])
    record('B4-01 负例：diff 含插件输出 loadedShaReadback → 拒绝导出（exit 1）', redactionRun.status === 1, `exit=${redactionRun.status} ${redactionRun.stderr.slice(0, 200)}`)

    // B4-01：私有映射可还原（blindId → runId/arm/taskId），且不泄漏进材料目录。
    const mappingManifest = join(root, 'manifest-mapping.json')
    writeFileSync(mappingManifest, JSON.stringify({
      batch: 'selftest-b4-mapping',
      seed: 7,
      tasks: { t1: { taskDir } },
      runs: [
        { runId: 'selftest-t1-off', taskId: 't1', arm: 'off', repo, base, head },
        { runId: 'selftest-t2-native', taskId: 't1', arm: 'native', repo, base, head },
      ],
    }), 'utf8')
    const mappingOut = join(root, 'out-mapping')
    const mappingFile = join(root, 'private', 'mapping-restore.json')
    const mappingRun = runCliSafe(['--manifest', mappingManifest, '--out', mappingOut, '--mapping', mappingFile])
    let restoreDetail = 'mapping 未生成'
    let restoreOk = false
    if (mappingRun.status === 0 && existsSync(mappingFile)) {
      const privateMapping = JSON.parse(readFileSync(mappingFile, 'utf8')).mapping ?? {}
      const entries = Object.values(privateMapping)
      const arms = new Set(entries.map((entry) => entry.arm))
      const leaked = existsSync(join(mappingOut, 'mapping-restore.json'))
      restoreOk = entries.length === 2
        && [...arms].sort().join(',') === 'native,off'
        && entries.every((entry) => entry.runId && entry.taskId === 't1' && /^[0-9a-f]{40}$/.test(entry.base) && /^[0-9a-f]{40}$/.test(entry.head))
        && !leaked
      restoreDetail = `entries=${JSON.stringify(entries.map((entry) => ({ runId: entry.runId, arm: entry.arm })))} leakedIntoMaterial=${leaked}`
    } else {
      restoreDetail = `exit=${mappingRun.status} ${mappingRun.stderr.slice(0, 200)}`
    }
    record('B4-01 私有映射可按 blindId 还原 runId/arm/taskId 且不进入材料目录', restoreOk, restoreDetail)

    // F06：现行实际写法的组别泄漏必须拒绝（fail-closed），且不静默删正文后放行。
    const leakTaskDir = join(root, 'task-leak')
    mkdirSync(leakTaskDir, { recursive: true })
    writeFileSync(join(leakTaskDir, 'issue.md'), '任务：增加字段。\n运行分组：原系统组\n{"arm": "legacy-system"}\n', 'utf8')
    writeFileSync(join(leakTaskDir, 'review.md'), '合法范围：src/**。\n', 'utf8')
    const leakManifest = join(root, 'manifest-leak.json')
    writeFileSync(leakManifest, JSON.stringify({
      batch: 'selftest-b4-leak',
      seed: 7,
      tasks: { t1: { taskDir: leakTaskDir } },
      runs: [{ runId: 'selftest-t1-off', taskId: 't1', arm: 'off', repo, base, head }],
    }), 'utf8')
    const leakOut = join(root, 'out-leak')
    const leakRun = runCliSafe(['--manifest', leakManifest, '--out', leakOut, '--mapping', join(root, 'private', 'mapping-leak.json')])
    record('F06 负例：requirement 含中文“原系统组”+ JSON "arm":"legacy-system" → 拒绝导出（exit 1）',
      leakRun.status === 1
        && /HARD [^\n]*requirement[^\n]*\[zh-group\]/.test(leakRun.stderr)
        && /HARD [^\n]*requirement[^\n]*\[arm-json\]/.test(leakRun.stderr)
        && !existsSync(leakOut),
      `exit=${leakRun.status} outExists=${existsSync(leakOut)} stderr=${leakRun.stderr.slice(0, 500)}`)

    const leakScanOnly = runCliSafe(['--manifest', leakManifest, '--out', join(root, 'out-leak-scan'), '--mapping', join(root, 'private', 'mapping-leak-scan.json'), '--scan-only'])
    record('F06 负例：scan-only 遇到同样泄漏也拒绝（exit 1，不生成材料）',
      leakScanOnly.status === 1 && !existsSync(join(root, 'out-leak-scan')),
      `exit=${leakScanOnly.status} outExists=${existsSync(join(root, 'out-leak-scan'))}`)

    const leakScopeDir = join(root, 'task-leak-scope')
    mkdirSync(leakScopeDir, { recursive: true })
    writeFileSync(join(leakScopeDir, 'issue.md'), '任务：增加字段。\n', 'utf8')
    writeFileSync(join(leakScopeDir, 'review.md'), '合法范围：src/**。\n分组信息：{ "arm" : "full-package" }\n', 'utf8')
    const leakScopeManifest = join(root, 'manifest-leak-scope.json')
    writeFileSync(leakScopeManifest, JSON.stringify({
      batch: 'selftest-b4-leak-scope',
      seed: 7,
      tasks: { t1: { taskDir: leakScopeDir } },
      runs: [{ runId: 'selftest-t1-off', taskId: 't1', arm: 'off', repo, base, head }],
    }), 'utf8')
    const leakScopeOut = join(root, 'out-leak-scope')
    const leakScopeRun = runCliSafe(['--manifest', leakScopeManifest, '--out', leakScopeOut, '--mapping', join(root, 'private', 'mapping-leak-scope.json')])
    record('F06 负例：allowed-scope 含带空格 JSON `"arm" : "full-package"` → 拒绝（exit 1）',
      leakScopeRun.status === 1
        && /HARD [^\n]*allowed-scope[^\n]*\[arm-json\]/.test(leakScopeRun.stderr)
        && !existsSync(leakScopeOut),
      `exit=${leakScopeRun.status} stderr=${leakScopeRun.stderr.slice(0, 400)}`)

    const leakDiffRepo = makeTracedRepo('repo-arm-json-trace', 'export const add = (a, b) => a + b\n// meta {"arm":"legacy-system"}\n')
    const leakDiffManifest = join(root, 'manifest-leak-diff.json')
    writeFileSync(leakDiffManifest, JSON.stringify({
      batch: 'selftest-b4-leak-diff',
      seed: 7,
      tasks: { t1: { taskDir } },
      runs: [{ runId: 'selftest-t1-native', taskId: 't1', arm: 'native', repo: leakDiffRepo.tracedRepo, base: leakDiffRepo.tracedBase, head: leakDiffRepo.tracedHead }],
    }), 'utf8')
    const leakDiffOut = join(root, 'out-leak-diff')
    const leakDiffRun = runCliSafe(['--manifest', leakDiffManifest, '--out', leakDiffOut, '--mapping', join(root, 'private', 'mapping-leak-diff.json')])
    record('F06 负例：diff 含 JSON `"arm":"legacy-system"` → 拒绝（exit 1，diff 层）',
      leakDiffRun.status === 1
        && /HARD [^\n]*diff[^\n]*\[arm-json\]/.test(leakDiffRun.stderr)
        && !existsSync(leakDiffOut),
      `exit=${leakDiffRun.status} stderr=${leakDiffRun.stderr.slice(0, 400)}`)

    const leakAssignDir = join(root, 'task-leak-assign')
    mkdirSync(leakAssignDir, { recursive: true })
    writeFileSync(join(leakAssignDir, 'issue.md'), '任务：增加字段。\narm = "legacy-system"\narm=full-package\n', 'utf8')
    writeFileSync(join(leakAssignDir, 'review.md'), '合法范围：src/**。\n', 'utf8')
    const leakAssignManifest = join(root, 'manifest-leak-assign.json')
    writeFileSync(leakAssignManifest, JSON.stringify({
      batch: 'selftest-b4-leak-assign',
      seed: 7,
      tasks: { t1: { taskDir: leakAssignDir } },
      runs: [{ runId: 'selftest-t1-off', taskId: 't1', arm: 'off', repo, base, head }],
    }), 'utf8')
    const leakAssignOut = join(root, 'out-leak-assign')
    const leakAssignRun = runCliSafe(['--manifest', leakAssignManifest, '--out', leakAssignOut, '--mapping', join(root, 'private', 'mapping-leak-assign.json')])
    record('F06 负例：requirement 含 `arm = "legacy-system"` / `arm=full-package` → 拒绝（exit 1）',
      leakAssignRun.status === 1
        && /\[arm-quoted\]|\[arm-legacy-full\]|\[legacy-system-word\]/.test(leakAssignRun.stderr)
        && !existsSync(leakAssignOut),
      `exit=${leakAssignRun.status} stderr=${leakAssignRun.stderr.slice(0, 400)}`)

    const ok = steps.every((step) => step.ok)
    if (asJson) console.log(JSON.stringify({ selfTest: ok, steps }, null, 2))
    else {
      for (const step of steps) console.log(`${step.ok ? 'PASS' : 'FAIL'} ${step.name} :: ${step.detail}`)
      console.log(ok ? 'SELF-TEST: PASS' : 'SELF-TEST: FAIL')
    }
    process.exit(ok ? 0 : 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function main() {
  const asJson = hasFlag('json')
  if (hasFlag('self-test')) selfTest(asJson)
  const manifest = arg('manifest')
  const out = arg('out')
  const mapping = arg('mapping')
  if (!manifest || !out || !mapping) usage('需要 --manifest、--out、--mapping')
  const report = runExport({ manifest, out, mapping, seed: arg('seed'), scanOnly: hasFlag('scan-only') })
  if (asJson) console.log(JSON.stringify(report, null, 2))
  else {
    if (report.error) console.error(`[label-export] ${report.error}`)
    if (report.scan) {
      for (const hit of report.scan.hard) console.error(`HARD ${hit.blindId} ${hit.layer}:${hit.line} [${hit.pattern}] ${hit.excerpt}`)
      for (const hit of report.scan.weak) console.warn(`WEAK ${hit.blindId} ${hit.layer}:${hit.line} [${hit.pattern}] ${hit.excerpt}`)
    }
    if (report.wrote) {
      console.log(`[label-export] batch=${arg('manifest')} cases=${report.cases}`)
      console.log(`[label-export] out=${report.out}`)
      console.log(`[label-export] mapping=${report.mapping}（私有，不得随材料分发）`)
      console.log('RESULT: PASS')
    } else if (report.exitCode === 0) {
      console.log('RESULT: PASS (scan-only)')
    } else {
      console.log('RESULT: FAIL')
    }
  }
  process.exit(report.exitCode)
}

main()
