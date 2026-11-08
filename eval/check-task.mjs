#!/usr/bin/env node
// ROADMAP-95 工作线 B / B2：任务集有效性校验器。
//
// 校验内容：
//   1) 结构：task.json / issue.md / hidden-test.sh / review.md / reference.patch 存在性与字段口径；
//   2) 有效性（完整模式，需要 git 仓库）：隐藏测试在 base 上失败、在参考修复上通过；
//      “连续 3 次一致”同时比较退出码与归一化后的稳定输出（F15/R6：仅归一化元数据上下文——
//      JSON/Python repr 的 timestamp/requestId 等键值与行首日志时间戳；裸值及 actual=/expected=
//      等业务结果不归一化。规则见 NORMALIZATION；原始 stdout/stderr 与 outputSha256 仍保留）；
//      base 失败会做归属核对后分类为 target-assertion-failed / target-symbol-missing / environment-error
//      （R5：ModuleNotFoundError/TypeError 只有追溯到 worktree 调用帧或本地包根才算目标缺失；
//      第三方依赖/客户端错误归 environment-error）。只有前两类算有效 base 失败，environment-error 判卡不合格。
//   3) 范围：参考修复改动的文件必须落在 task.json.allowedFiles 内。
//
// 用法：
//   node eval/check-task.mjs <taskDir> --dry-run [--json]
//   node eval/check-task.mjs <taskDir> --repo <git仓库> [--base <sha|ref>] [--reference <patch>]
//                                       [--hidden-test <script>] [--repeats 3] [--json]
//   node eval/check-task.mjs --self-test [--json]
//
// 退出码：0=通过；1=任务无效；2=用法/环境缺失（例如没有 git 或缺少 --repo）。
// 本脚本只使用 Node 内置模块，不新增依赖；只在系统临时目录创建 worktree，不动主工作树。
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, matchesGlob, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCHEMA_VERSION = 1
const CATEGORIES = new Set([
  'defect-fix',
  'new-feature',
  'behavior-preserving-refactor',
  'cross-module',
  'staged-suitable',
])
const ISSUE_HEADINGS = ['## 任务', '## 验收', '## 合法范围']
const TASK_FIELDS_REQUIRED = [
  'schemaVersion', 'taskId', 'repo', 'base', 'category', 'referenceFix', 'allowedFiles',
  'issue', 'hiddenTest', 'review', 'stagedSuitable', 'contamination', 'checks',
]
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = `用法：
  node eval/check-task.mjs <taskDir> --dry-run [--json]
  node eval/check-task.mjs <taskDir> --repo <git仓库> [--base <sha|ref>] [--reference <patch>] [--hidden-test <script>] [--repeats 3] [--json]
  node eval/check-task.mjs --self-test [--json]

说明：
  --dry-run   只做结构/schema 校验，不访问 git（任务作者本地先跑）。
  完整模式    需要 --repo 或 task.json.repo 指向本机 git 仓库；校验 base 失败、参考修复通过、
              连续 --repeats 次一致、参考修复不越出 allowedFiles。
  environment 可选块（C4.6）：offline=true 时要求 lockfile 存在（完整模式校验 base checkout/taskDir；
              dry-run 缺仓库上下文时只警告），并扫描 hidden-test.sh/参考修复命令中的联网安装模式
              （npm install 无 ci、pnpm install 无 frozen/offline、mvn 无 -o、gradle 无 --offline 等）。
              commandsMustMatchOffline=true 时使用更严格的离线标志要求。未声明 environment 时不拦截。
  退出码      0=通过；1=任务无效；2=用法/环境缺失。`

function usage(message) {
  console.error(`[check-task] ${message}\n\n${USAGE}`)
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

function sameIds(list) {
  return list.length > 0 && list.every((id) => id === list[0])
}

// ---- 输出稳定性归一化与 base 失败分类（F15）--------------------------------
// “三次一致”不能只比退出码：还要比较每次运行的稳定输出内容。以下归一化规则只剔除
// 已确认的动态字段；原始 stdout/stderr 与 outputSha256 始终保留，归一化规则写入
// validation 报告（顶层 normalization 及 checks.{base,reference}.normalization）。
const NORMALIZATION = {
  version: 2,
  scope: 'stdout+stderr',
  rules: [
    'CRLF/CR → LF',
    '仅 JSON/Python repr 的元数据键值（timestamp/time/requestId/request_id/traceId/trace_id/spanId/span_id/pid/loggedAt/createdAt/updatedAt/durationMs/elapsedMs）→ <dynamic>',
    '仅行首日志时间戳（可带 []，如 [2026-11-08T12:00:00Z] 或 2026-11-08T12:00:00Z）→ <timestamp>',
    '裸值、actual=/expected= 之后的值、普通文本中的时间/UUID 不归一化（业务结果差异必须保留）',
  ],
  note: 'R6：仅归一化已确认的元数据上下文（JSON 键值/日志前缀）；业务断言里的时间、UUID 等真实值保留，差异会令 consistent=false。原始 stdout/stderr 与 outputSha256 不删除。',
}

const METADATA_KEYS = 'timestamp|time|requestId|request_id|traceId|trace_id|spanId|span_id|pid|loggedAt|createdAt|updatedAt|durationMs|elapsedMs'
const METADATA_KV_PATTERN = new RegExp(
  `(["'](?:${METADATA_KEYS})["']\\s*:\\s*)(?:"[^"]*"|'[^']*'|[^,\\s}\\]]+)`,
  'gi',
)
const LOG_PREFIX_TIMESTAMP_PATTERN = /^(\s*\[?)(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)(\]?)/gm

function normalizeStableOutput(text) {
  let out = String(text ?? '').replace(/\r\n?/g, '\n')
  // R6：只替换元数据键值（JSON/Python repr 的键必须是引号包裹）。
  out = out.replace(METADATA_KV_PATTERN, '$1<dynamic>')
  // R6：只替换行首的日志时间戳前缀（可带 []）；正文/断言中的时间不处理。
  out = out.replace(LOG_PREFIX_TIMESTAMP_PATTERN, '$1<timestamp>$3')
  return out
}

const VALID_BASE_FAILURE_CLASSES = new Set(['target-assertion-failed', 'target-symbol-missing'])
const ENV_ERROR_PATTERNS = [
  /command not found/i,
  /permission denied/i,
  /\b(?:EACCES|ENOSPC|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EAI_AGAIN)\b/,
  /\b(?:npm|pnpm|yarn)\b[^\n]*\bERR!?/i,
]
const ASSERTION_PATTERNS = [
  /AssertionError/,
  /\bassert(?:ion)?\b[^\n]*(?:fail|expected|got|actual|raise)/i,
  /^\s*FAIL(?:ED)?\b/mi,
  /\bexpected\b[^\n]*\b(?:got|but|actual)\b/i,
  /\b(?:hidden[-_ ]?check|assertion|test)\s+failed\b/i,
  /期望/,
]
const IMPORT_ERROR_PATTERN = /(?:ModuleNotFoundError|ImportError): No module named ['"]([^'"]+)['"]/g
const CANNOT_IMPORT_PATTERN = /ImportError: cannot import name ['"]([^'"]+)['"] from ['"]([^'"]+)['"]/
const TYPE_ERROR_SIGNATURE_PATTERN = /TypeError: \S+?\(\) (?:takes|got|missing|accepts)[^\n]*argument/i
const ATTRIBUTE_ERROR_PATTERN = /AttributeError: (?:module )?['"]?([A-Za-z0-9_.]+)['"]? has no attribute/
const FILE_MISSING_PATTERN = /FileNotFoundError|No such file or directory/i

/** 由 worktree 顶层 Python 包（含 __init__.py 的目录）与 allowedFiles 首段推导本地包根。 */
function localPackageRoots(worktree, allowedFiles = []) {
  const roots = new Set()
  for (const glob of allowedFiles ?? []) {
    const first = String(glob).split('/')[0]
    if (first && !first.includes('*') && existsSync(join(worktree, first))) roots.add(first)
  }
  try {
    for (const entry of readdirSync(worktree, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(worktree, entry.name, '__init__.py'))) roots.add(entry.name)
    }
  } catch { /* ignore unreadable worktree */ }
  return [...roots]
}

function normalizePathForCompare(pathText) {
  return String(pathText ?? '').replace(/\\/g, '/')
}

/** traceback 帧路径是否落在任务 worktree 内（含 macOS /private 前缀差异）。 */
function worktreeFramePaths(text, worktree) {
  if (!worktree) return []
  const normalizedWorktree = normalizePathForCompare(worktree).replace(/\/+$/, '')
  const frames = []
  const pattern = /File "([^"]+)"/g
  let match
  while ((match = pattern.exec(text)) !== null) frames.push(match[1])
  return frames.filter((frame) => {
    const normalizedFrame = normalizePathForCompare(frame)
    return normalizedFrame === normalizedWorktree
      || normalizedFrame.startsWith(`${normalizedWorktree}/`)
      || normalizedFrame.startsWith(`/private${normalizedWorktree}/`)
  })
}

function moduleBelongsToTarget(moduleName, roots) {
  const first = String(moduleName ?? '').split('.')[0]
  return roots.some((root) => first === root || String(moduleName) === root || String(moduleName).startsWith(`${root}.`))
}

/**
 * R5：归属核对。只有模块/符号属于任务目标（worktree 内 traceback 帧，或缺失模块名匹配
 * 本地包根）才算 target-symbol-missing；第三方依赖/客户端版本问题返回 null（归 environment-error）。
 */
function targetSymbolEvidence(text, { worktree, packageRoots = [] } = {}) {
  const frames = worktreeFramePaths(text, worktree)
  for (const name of text.matchAll(IMPORT_ERROR_PATTERN)) {
    if (moduleBelongsToTarget(name[1], packageRoots)) {
      return { reason: `missing module '${name[1]}' matches local package root (${packageRoots.join(', ')})` }
    }
  }
  const cannotImport = CANNOT_IMPORT_PATTERN.exec(text)
  if (cannotImport && (moduleBelongsToTarget(cannotImport[2], packageRoots) || frames.length > 0)) {
    return { reason: `cannot import name '${cannotImport[1]}' from target module '${cannotImport[2]}'` }
  }
  // 签名/参数不匹配：只有调用栈里存在任务 worktree 帧才算目标函数缺失。
  if (TYPE_ERROR_SIGNATURE_PATTERN.test(text) && frames.length > 0) {
    return { reason: 'TypeError signature mismatch at worktree call site' }
  }
  const attributeError = ATTRIBUTE_ERROR_PATTERN.exec(text)
  if (attributeError && (moduleBelongsToTarget(attributeError[1], packageRoots) || frames.length > 0)) {
    return { reason: `AttributeError on target symbol '${attributeError[1]}'` }
  }
  if (worktree && normalizePathForCompare(text).includes(normalizePathForCompare(worktree).replace(/\/+$/, '')) && FILE_MISSING_PATTERN.test(text)) {
    return { reason: 'FileNotFoundError/ENOENT on task checkout path (target file/symbol missing)' }
  }
  return null
}

// 分类顺序：进程异常/126/127 → 环境标记 → 断言标记 → 目标符号缺失（归属核对）
// → 其余非零按环境错误 fail-closed。第三方依赖/客户端错误不会仅因异常类型被当成目标缺失。
function classifyBaseFailure(run, context = {}) {
  if (run.signal !== null && run.signal !== undefined) {
    return { failureClass: 'environment-error', reason: `process signal=${run.signal}` }
  }
  if (run.code === null || run.code === undefined) {
    return { failureClass: 'environment-error', reason: 'process did not exit normally (timeout/error)' }
  }
  if (run.code === 126 || run.code === 127) {
    return { failureClass: 'environment-error', reason: `exit code ${run.code} (not executable / command missing)` }
  }
  const text = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
  for (const pattern of ENV_ERROR_PATTERNS) {
    if (pattern.test(text)) return { failureClass: 'environment-error', reason: `environment marker: ${pattern}` }
  }
  for (const pattern of ASSERTION_PATTERNS) {
    if (pattern.test(text)) return { failureClass: 'target-assertion-failed', reason: `assertion marker: ${pattern}` }
  }
  const symbolEvidence = targetSymbolEvidence(text, context)
  if (symbolEvidence !== null) {
    return { failureClass: 'target-symbol-missing', reason: symbolEvidence.reason }
  }
  return { failureClass: 'environment-error', reason: 'unattributed import/symbol/type failure or unclassified non-zero base failure（fail-closed：按环境错误判无效）' }
}

function summarizeConsistency(runs) {
  const codes = runs.map((run) => run.code)
  const outputSha256 = runs.map((run) => run.outputSha256 ?? null)
  const normalizedSha256 = runs.map((run) => run.normalizedSha256 ?? null)
  return {
    codes,
    outputSha256,
    normalizedSha256,
    consistent: sameIds(codes.map(String)) && sameIds(normalizedSha256.map(String)),
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function fileExists(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function gitOk() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function gitOrNull(cwd, args) {
  try {
    return git(cwd, args).trim()
  } catch {
    return null
  }
}

// ---- C4.6 可选 environment 块校验 -----------------------------------------

const ENVIRONMENT_KEYS = new Set(['offline', 'lockfile', 'commandsMustMatchOffline'])
const OFFLINE_HINT = 'environment.offline=true 要求锁文件与离线命令；未声明 environment 时不拦截'

/** C4.6：lockfile 必须是 workspace-relative（拒绝绝对路径、`..` 逃逸、空段、控制字符）。 */
function lockfileProblem(value) {
  const file = value.trim()
  if (file.length === 0) return 'lockfile must not be empty'
  if (isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file)) return `lockfile must be workspace-relative: ${file}`
  const segments = file.split(/[\\/]+/)
  if (segments.includes('..')) return `lockfile must not escape the workspace: ${file}`
  if (segments.some(segment => segment === '' || segment === '.')) return `lockfile has an invalid path segment: ${file}`
  if (/[\u0000-\u001f\u007f]/.test(file)) return `lockfile contains control characters: ${file}`
  return null
}

function commandLines(text) {
  return text.split('\n').map(line => line.trim()).filter(line => line.length > 0 && !line.startsWith('#'))
}

/** 从 hidden-test/参考补丁/可选的 task.commands 中找出疑似联网安装命令。返回 [{source, command}]。 */
function onlineCommands(sources, strict) {
  const found = []
  const add = (source, command) => found.push({ source, command })
  for (const { source, text } of sources) {
    for (const line of commandLines(text)) {
      // 统一 diff 里只检查新增行（+ 开头），其余文本按 shell 行检查。
      const command = source.endsWith('.patch') && line.startsWith('+') ? line.slice(1).trim() : line
      if (command.length === 0) continue
      if (/\bnpm\s+(install|i|add)\b/.test(command) && !/\bnpm\s+ci\b/.test(command)) {
        if (!/--offline|--prefer-offline|--cache\b/.test(command)) add(source, command)
      }
      if (strict && /\bnpm\s+ci\b/.test(command) && !/--offline|--prefer-offline/.test(command)) add(source, command)
      if (/\bpnpm\s+(install|i|add)\b/.test(command)) {
        const frozen = /--frozen-lockfile/.test(command)
        const offline = /--offline/.test(command)
        if (strict ? !(frozen && offline) : !(frozen || offline)) add(source, command)
      }
      if (/\bmvn\b/.test(command) && !/-o\b|--offline/.test(command)) add(source, command)
      if (/\bgradle(w)?\b/.test(command) && !/--offline/.test(command)) add(source, command)
      if (strict && /\byarn\s+install\b/.test(command) && !/--offline|--frozen-lockfile/.test(command)) add(source, command)
      if (strict && /\bpip3?\s+install\b/.test(command) && !/--no-index|--find-links/.test(command)) add(source, command)
      if (/\bgit\s+clone\b|\bcurl\s|\bwget\s/.test(command)) add(source, command)
    }
  }
  return found
}

function environmentProblems(task, dir, paths) {
  const errors = []
  const warnings = []
  if (task.environment === undefined) return { errors, warnings, environment: null }
  const environment = task.environment
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
    errors.push('environment 必须是对象')
    return { errors, warnings, environment: null }
  }
  for (const key of Object.keys(environment)) {
    if (!ENVIRONMENT_KEYS.has(key)) warnings.push(`environment 未知字段将被忽略：${key}`)
  }
  if (typeof environment.offline !== 'boolean') errors.push('environment.offline 必须是 boolean')
  if (environment.commandsMustMatchOffline !== undefined && typeof environment.commandsMustMatchOffline !== 'boolean') {
    errors.push('environment.commandsMustMatchOffline 必须是 boolean（可选）')
  }
  if (environment.offline !== true) return { errors, warnings, environment }
  if (typeof environment.lockfile !== 'string' || environment.lockfile.trim().length === 0) {
    errors.push('environment.offline=true 时 environment.lockfile 必填（仓库相对路径）')
    return { errors, warnings, environment }
  }
  const lockfile = environment.lockfile.trim()
  const lockfileIssue = lockfileProblem(lockfile)
  if (lockfileIssue !== null) {
    errors.push(`environment.lockfile 必须是 workspace-relative 路径（${lockfileIssue}）`)
    return { errors, warnings, environment }
  }
  const candidates = [join(dir, lockfile)]
  if (typeof task.repo === 'string' && isAbsolute(task.repo) && existsSync(task.repo)) candidates.push(join(task.repo, lockfile))
  const found = candidates.find(candidate => fileExists(candidate))
  if (!found) {
    if (paths.repoRoot) errors.push(`environment.offline=true 但 lockfile 不存在于仓库基线或任务目录：${lockfile}`)
    else warnings.push(`environment.offline=true：lockfile 未在任务目录/本地仓库找到（${lockfile}）；完整模式会强制校验，dry-run 无法确认仓库锁文件`)
  }
  const sources = []
  if (fileExists(paths.hiddenPath)) sources.push({ source: 'hidden-test.sh', text: readFileSync(paths.hiddenPath, 'utf8') })
  if (fileExists(paths.referencePath)) sources.push({ source: 'reference.patch', text: readFileSync(paths.referencePath, 'utf8') })
  if (Array.isArray(task.commands)) {
    for (const command of task.commands) {
      if (typeof command === 'string') sources.push({ source: 'task.json commands', text: command })
    }
  }
  const strict = environment.commandsMustMatchOffline === true
  for (const hit of onlineCommands(sources, strict)) {
    errors.push(`environment.offline=true 但发现疑似联网命令（${hit.source}）：${hit.command}`)
  }
  return { errors, warnings, environment }
}

// ---- 结构校验 -------------------------------------------------------------

function strList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0)
}

export function validateStructure(taskDir) {
  const errors = []
  const warnings = []
  const dir = resolve(taskDir)
  const taskFile = join(dir, 'task.json')

  if (!existsSync(dir)) return { ok: false, errors: [`任务目录不存在：${dir}`], warnings, task: null }
  if (!fileExists(taskFile)) return { ok: false, errors: [`缺少 task.json：${taskFile}`], warnings, task: null }

  let task
  try {
    task = readJson(taskFile)
  } catch (error) {
    return { ok: false, errors: [`task.json 不是合法 JSON：${error.message}`], warnings, task: null }
  }

  const missing = TASK_FIELDS_REQUIRED.filter((field) => !(field in task))
  if (missing.length > 0) errors.push(`task.json 缺少字段：${missing.join(', ')}`)

  if (task.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion 必须为 ${SCHEMA_VERSION}`)
  if (typeof task.taskId !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(task.taskId)) {
    errors.push('taskId 必须匹配 ^[a-z0-9][a-z0-9._-]{1,63}$')
  }
  if (typeof task.repo !== 'string' || task.repo.length === 0) errors.push('repo 必须是非空字符串')
  if (task.base !== null && !(typeof task.base === 'string' && task.base.length > 0)) {
    errors.push('base 必须是完整 commit SHA（40 位）或 null（仅合成自测夹具）')
  } else if (typeof task.base === 'string' && !/^[0-9a-f]{40}$/.test(task.base)) {
    errors.push('base 不是 40 位小写十六进制 commit SHA')
  }
  if (!CATEGORIES.has(task.category)) errors.push(`category 必须是 ${[...CATEGORIES].join(' / ')}`)
  if (!strList(task.allowedFiles) || task.allowedFiles.length === 0) {
    errors.push('allowedFiles 必须是非空 glob 字符串数组')
  }
  if (typeof task.stagedSuitable !== 'boolean') errors.push('stagedSuitable 必须是 boolean')

  const contamination = task.contamination
  if (contamination === null || typeof contamination !== 'object') {
    errors.push('contamination 必须是对象')
  } else {
    if (typeof contamination.mergedAfterTrainingCutoff !== 'boolean') {
      errors.push('contamination.mergedAfterTrainingCutoff 必须是 boolean')
    }
    if (typeof contamination.private !== 'boolean') errors.push('contamination.private 必须是 boolean')
    if (contamination.mergedAfterTrainingCutoff === true && typeof contamination.cutoff !== 'string') {
      errors.push('contamination.mergedAfterTrainingCutoff=true 时 cutoff 必填')
    }
  }

  if (task.checks === null || typeof task.checks !== 'object') {
    errors.push('checks 必须是对象')
  } else {
    if (task.checks.baseMustFail !== true) errors.push('checks.baseMustFail 必须为 true')
    if (task.checks.referenceMustPass !== true) errors.push('checks.referenceMustPass 必须为 true')
  }

  const rel = (field, fallback) => (typeof task[field] === 'string' && task[field].length > 0 ? task[field] : fallback)
  const issuePath = resolve(dir, rel('issue', 'issue.md'))
  const hiddenPath = resolve(dir, rel('hiddenTest', 'hidden-test.sh'))
  const reviewPath = resolve(dir, rel('review', 'review.md'))
  const referencePath = resolve(dir, rel('referenceFix', 'reference.patch'))

  for (const [label, path] of [['issue', issuePath], ['hidden-test', hiddenPath], ['review', reviewPath], ['reference', referencePath]]) {
    if (!fileExists(path)) errors.push(`缺少 ${label} 文件：${path}`)
  }

  let issueText = ''
  if (fileExists(issuePath)) {
    issueText = readFileSync(issuePath, 'utf8')
    if (issueText.trim().length === 0) errors.push('issue.md 为空')
    for (const heading of ISSUE_HEADINGS) {
      if (!issueText.includes(heading)) errors.push(`issue.md 缺少二级标题：${heading}`)
    }
  }

  if (fileExists(hiddenPath)) {
    const hiddenText = readFileSync(hiddenPath, 'utf8')
    if (hiddenText.trim().length === 0) errors.push('hidden-test.sh 为空')
    if (!/^\s*#!\/(bin\/sh|usr\/bin\/env\s+(sh|bash))/m.test(hiddenText)) {
      warnings.push('hidden-test.sh 没有 sh/bash shebang；check-task 仍会用 sh 执行，但建议补上')
    }
    if (/\/(Users|home)\/[^/\s]+\//.test(hiddenText)) {
      warnings.push('hidden-test.sh 含绝对路径，可能不可移植（应当在 checkout 根目录相对执行）')
    }
  }

  if (fileExists(reviewPath)) {
    const reviewText = readFileSync(reviewPath, 'utf8')
    if (reviewText.trim().length < 40) errors.push('review.md 内容过短，必须写明合法范围判定理由')
    if (!reviewText.includes('合法范围')) warnings.push('review.md 未出现“合法范围”字样，请确认写法符合 eval/tasks/README.md')
  }

  if (fileExists(referencePath) && !readFileSync(referencePath, 'utf8').includes('diff --git')) {
    warnings.push('reference.patch 看起来不是 git 生成的 unified diff（缺少 diff --git 头）')
  }

  const environment = environmentProblems(task, dir, { hiddenPath, referencePath })
  errors.push(...environment.errors)
  warnings.push(...environment.warnings)

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    task,
    environment: environment.environment,
    files: { issuePath, hiddenPath, reviewPath, referencePath },
    taskFile,
    issueSha256: fileExists(issuePath) ? sha256(readFileSync(issuePath)) : null,
  }
}

// ---- 完整校验 -------------------------------------------------------------

function runHidden(worktree, hiddenPath, timeoutMs) {
  const result = spawnSync('sh', [hiddenPath], {
    cwd: worktree,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, TASK_CHECKOUT: worktree },
  })
  const rawText = `${result.status}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const stableText = normalizeStableOutput(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  return {
    code: result.status,
    signal: result.signal ?? null,
    // 原始输出保留（截尾 2000 字符仅用于报告体积；sha256 基于完整输出）。
    stdout: (result.stdout ?? '').slice(-2000),
    stderr: (result.stderr ?? '').slice(-2000),
    outputSha256: sha256(rawText),
    // 归一化稳定内容的 hash：consistent 判定用它比较三次输出，动态字段规则见 NORMALIZATION。
    normalizedSha256: sha256(`${result.status}\n${stableText}`),
  }
}

function repeatRuns(worktree, hiddenPath, repeats, timeoutMs) {
  return Array.from({ length: repeats }, () => runHidden(worktree, hiddenPath, timeoutMs))
}

export function validateTask(options) {
  const taskDir = resolve(options.taskDir)
  const structure = validateStructure(taskDir)
  const report = {
    mode: 'full',
    taskDir,
    structure: { ok: structure.ok, errors: structure.errors, warnings: structure.warnings },
    checks: {},
    // 归一化规则随 validation 报告落盘，便于复核“三次一致”比较的到底是什么。
    normalization: NORMALIZATION,
    ok: false,
  }
  if (!structure.ok) return report

  const { task, files } = structure
  const repoArg = options.repo ?? (typeof task.repo === 'string' && isAbsolute(task.repo) ? task.repo : null)
  if (!repoArg) {
    return { ...report, ok: false, exitCode: 2, envError: '完整校验需要 --repo 指向本机 git 仓库（或 task.json.repo 写本机绝对路径）' }
  }
  if (!gitOk()) return { ...report, ok: false, exitCode: 2, envError: '找不到 git 可执行文件；无法做 base/参考修复校验' }

  const repoRoot = gitOrNull(repoArg, ['rev-parse', '--show-toplevel'])
  if (!repoRoot) return { ...report, ok: false, exitCode: 2, envError: `${repoArg} 不是 git 工作树/仓库` }

  const baseRef = options.base ?? task.base
  if (!baseRef) return { ...report, ok: false, exitCode: 2, envError: 'task.json.base 为 null；完整校验需要 --base <sha|ref>' }

  const baseSha = gitOrNull(repoRoot, ['rev-parse', '--verify', `${baseRef}^{commit}`])
  if (!baseSha) return { ...report, ok: false, exitCode: 1, error: `base 无法解析为 commit：${baseRef}` }

  const hiddenPath = resolve(options.hiddenTest ?? files.hiddenPath)
  const referencePath = resolve(options.reference ?? files.referencePath)
  if (!fileExists(hiddenPath)) return { ...report, ok: false, exitCode: 2, envError: `hidden-test 不存在：${hiddenPath}` }
  if (!fileExists(referencePath)) return { ...report, ok: false, exitCode: 2, envError: `reference patch 不存在：${referencePath}` }

  const repeats = Number(options.repeats ?? 3)
  if (!Number.isInteger(repeats) || repeats < 1) return { ...report, ok: false, exitCode: 2, envError: '--repeats 必须是正整数' }
  const timeoutMs = Number(options.timeoutMs ?? 30 * 60 * 1000)

  const tmpRoot = mkdtempSync(join(tmpdir(), 'hephi-b2-'))
  const worktree = join(tmpRoot, 'checkout')
  try {
    git(repoRoot, ['worktree', 'add', '--detach', '--quiet', worktree, baseSha])
  } catch (error) {
    rmSync(tmpRoot, { recursive: true, force: true })
    return { ...report, ok: false, exitCode: 1, error: `git worktree add 失败：${error.message.split('\n')[0]}` }
  }

  try {
    if (structure.environment?.offline === true) {
      const lockfile = structure.environment.lockfile
      const candidates = [join(worktree, lockfile), join(taskDir, lockfile)]
      const found = candidates.find(candidate => fileExists(candidate))
      report.checks.environment = { offline: true, lockfile, found: Boolean(found), ok: Boolean(found) }
      if (!found) {
        report.error = `environment.offline=true 但 lockfile 不存在于 base checkout 或任务目录：${lockfile}`
        return report
      }
    } else {
      // 未声明 environment 或 offline=false：保持旧行为（不拦截），在报告中标记声明状态。
      report.checks.environment = { offline: false, declared: structure.environment !== null, ok: true }
    }
    // R5：本地包根用于 base 失败归属核对（缺失模块是否属于任务目标）。
    const packageRoots = localPackageRoots(worktree, task.allowedFiles)
    const baseRuns = repeatRuns(worktree, hiddenPath, repeats, timeoutMs)
    const baseConsistency = summarizeConsistency(baseRuns)
    const failureClasses = baseRuns.map((run) => ({ code: run.code, ...classifyBaseFailure(run, { worktree, packageRoots }) }))
    const invalidFailure = failureClasses.find((entry) => !VALID_BASE_FAILURE_CLASSES.has(entry.failureClass))
    report.checks.base = {
      expected: 'fail',
      runs: baseRuns,
      codes: baseConsistency.codes,
      outputSha256: baseConsistency.outputSha256,
      normalizedSha256: baseConsistency.normalizedSha256,
      consistent: baseConsistency.consistent,
      failureClasses,
      validFailureClasses: [...VALID_BASE_FAILURE_CLASSES],
      normalization: NORMALIZATION,
      ok: baseRuns.every((run) => run.code !== 0)
        && baseConsistency.consistent
        && failureClasses.every((entry) => VALID_BASE_FAILURE_CLASSES.has(entry.failureClass)),
      ...(invalidFailure
        ? { invalidReason: `base 失败分类为 ${invalidFailure.failureClass}（${invalidFailure.reason}）；只有 target-assertion-failed/target-symbol-missing 算有效 base 失败，environment-error 判卡不合格` }
        : {}),
    }

    const untrackedBefore = new Set(
      git(worktree, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean),
    )
    let applyError = null
    try {
      git(worktree, ['apply', '--whitespace=nowarn', referencePath])
    } catch (error) {
      applyError = error.message.split('\n').slice(0, 3).join(' ')
    }

    if (applyError !== null) {
      report.checks.reference = { ok: false, error: `参考修复应用失败：${applyError}` }
    } else {
      // 参考修复可能新增文件（untracked，git diff 看不到），需与 patch 前快照比较。
      const untrackedAfter = git(worktree, ['ls-files', '--others', '--exclude-standard'])
        .split('\n')
        .filter(Boolean)
      const newUntracked = untrackedAfter.filter((file) => !untrackedBefore.has(file))
      const changedFiles = [
        ...new Set([
          ...git(worktree, ['diff', '--name-only', '--no-renames']).split('\n').filter(Boolean),
          ...newUntracked,
        ]),
      ]
      const outside = changedFiles.filter((file) => !task.allowedFiles.some((glob) => matchesGlob(file, glob)))
      report.checks.scope = {
        allowedFiles: task.allowedFiles,
        changedFiles,
        outside,
        ok: outside.length === 0,
      }
      const referenceRuns = repeatRuns(worktree, hiddenPath, repeats, timeoutMs)
      const referenceConsistency = summarizeConsistency(referenceRuns)
      report.checks.reference = {
        expected: 'pass',
        runs: referenceRuns,
        codes: referenceConsistency.codes,
        outputSha256: referenceConsistency.outputSha256,
        normalizedSha256: referenceConsistency.normalizedSha256,
        consistent: referenceConsistency.consistent,
        normalization: NORMALIZATION,
        ok: referenceRuns.every((run) => run.code === 0) && referenceConsistency.consistent,
      }
    }

    report.baseSha = baseSha
    report.repo = repoRoot
    report.repeats = repeats
    report.ok = Boolean(
      report.checks.base?.ok
      && report.checks.reference?.ok
      && report.checks.scope?.ok
      && (report.checks.environment?.ok ?? true),
    )
    return report
  } finally {
    try { git(repoRoot, ['worktree', 'remove', '--force', worktree]) } catch { /* ignore */ }
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

// ---- 自测 -----------------------------------------------------------------

function selfTest(asJson) {
  const exampleDir = join(REPO_ROOT, 'eval', 'tasks', 'example')
  const steps = []
  const root = mkdtempSync(join(tmpdir(), 'hephi-b2-self-'))
  const repo = join(root, 'repo')
  const record = (name, ok, detail) => steps.push({ name, ok, detail })
  try {
    const dry = validateStructure(exampleDir)
    record('dry-run 结构校验（合成示例）', dry.ok, dry.ok ? 'ok' : dry.errors)

    cpSync(join(exampleDir, 'base'), repo, { recursive: true })
    git(repo, ['init', '--quiet'])
    git(repo, ['add', '-A'])
    git(repo, ['-c', 'user.name=B2 Self Test', '-c', 'user.email=b2@example.invalid', 'commit', '--quiet', '-m', 'synthetic base'])
    const baseSha = git(repo, ['rev-parse', 'HEAD']).trim()

    const pass = validateTask({
      taskDir: exampleDir,
      repo,
      base: baseSha,
      reference: join(exampleDir, 'reference.patch'),
      hiddenTest: join(exampleDir, 'hidden-test.sh'),
      repeats: 3,
    })
    record(
      '完整双向校验：base 失败 / 参考修复通过 / 3 次一致',
      pass.ok === true,
      pass.ok
        ? `base codes=${JSON.stringify(pass.checks.base.codes)} ref codes=${JSON.stringify(pass.checks.reference.codes)} scope=${JSON.stringify(pass.checks.scope.changedFiles)}`
        : JSON.stringify(pass.checks),
    )

    const alwaysPass = join(root, 'always-pass.sh')
    writeFileSync(alwaysPass, '#!/bin/sh\nexit 0\n', 'utf8')
    const badBase = validateTask({
      taskDir: exampleDir,
      repo,
      base: baseSha,
      reference: join(exampleDir, 'reference.patch'),
      hiddenTest: alwaysPass,
      repeats: 3,
    })
    record('负例：隐藏测试在 base 上通过 → 必须判任务无效', badBase.ok === false, JSON.stringify(badBase.checks.base?.codes ?? badBase.error))

    const outOfScope = join(root, 'out-of-scope.patch')
    writeFileSync(outOfScope, [
      'diff --git a/notes.txt b/notes.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/notes.txt',
      '@@ -0,0 +1 @@',
      '+out of scope',
      'diff --git a/src/calc.mjs b/src/calc.mjs',
      '--- a/src/calc.mjs',
      '+++ b/src/calc.mjs',
      '@@ -2,3 +2,3 @@',
      ' export function add(a, b) {',
      '-  return a - b',
      '+  return a + b',
      ' }',
      '',
    ].join('\n'), 'utf8')
    const badScope = validateTask({
      taskDir: exampleDir,
      repo,
      base: baseSha,
      reference: outOfScope,
      hiddenTest: join(exampleDir, 'hidden-test.sh'),
      repeats: 3,
    })
    record(
      '负例：参考修复越出 allowedFiles → 必须判任务无效',
      badScope.ok === false && (badScope.checks.scope?.outside ?? []).includes('notes.txt'),
      JSON.stringify(badScope.checks.scope ?? badScope.error),
    )

    // C4.6 environment 块自测（复制合成夹具，避免修改仓库内 example）。
    const makeEnvTask = (name, mutate) => {
      const dir = join(root, name)
      cpSync(exampleDir, dir, { recursive: true })
      const task = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf8'))
      task.environment = { offline: true, lockfile: 'package-lock.json', commandsMustMatchOffline: false }
      mutate?.(dir, task)
      writeFileSync(join(dir, 'task.json'), `${JSON.stringify(task, null, 2)}\n`, 'utf8')
      return dir
    }
    const offlineTask = makeEnvTask('task-offline-valid', (dir) => { writeFileSync(join(dir, 'package-lock.json'), '{}\n', 'utf8') })
    const offlineStructure = validateStructure(offlineTask)
    const offlineFull = validateTask({ taskDir: offlineTask, repo, base: baseSha, repeats: 3 })
    record(
      'environment 合法 offline：结构通过且完整校验通过',
      offlineStructure.ok === true && offlineFull.ok === true && offlineFull.checks.environment?.ok === true,
      JSON.stringify(offlineStructure.errors) + ' ' + JSON.stringify(offlineFull.checks.environment ?? offlineFull.error),
    )
    const missingLock = makeEnvTask('task-offline-missing-lock')
    const missingLockFull = validateTask({ taskDir: missingLock, repo, base: baseSha, repeats: 3 })
    record(
      'environment offline 但缺 lockfile → 完整校验 FAIL',
      missingLockFull.ok === false && missingLockFull.checks.environment?.ok === false,
      JSON.stringify(missingLockFull.checks.environment ?? missingLockFull.error),
    )
    const onlineTask = makeEnvTask('task-online-command', (dir) => {
      writeFileSync(join(dir, 'package-lock.json'), '{}\n', 'utf8')
      writeFileSync(join(dir, 'hidden-test.sh'), '#!/bin/sh\nnpm install lodash\nexit 1\n', 'utf8')
    })
    const onlineStructure = validateStructure(onlineTask)
    record(
      'environment offline 但 hidden-test 含 npm install → 结构校验 FAIL 并列出命令',
      onlineStructure.ok === false && onlineStructure.errors.some(error => error.includes('npm install lodash')),
      JSON.stringify(onlineStructure.errors),
    )
    record(
      '未声明 environment → 不拦截（行为不变）',
      dry.ok === true && dry.environment === null && pass.ok === true,
      `dry.environment=${JSON.stringify(dry.environment)} full=${pass.ok}`,
    )
    const absoluteLock = makeEnvTask('task-lock-absolute', (_dir, task) => {
      task.environment = { offline: true, lockfile: '/tmp/package-lock.json', commandsMustMatchOffline: false }
    })
    const absoluteLockStructure = validateStructure(absoluteLock)
    record(
      'environment lockfile 绝对路径 → 结构校验 FAIL',
      absoluteLockStructure.ok === false && absoluteLockStructure.errors.some(error => error.includes('workspace-relative')),
      JSON.stringify(absoluteLockStructure.errors),
    )
    const escapeLock = makeEnvTask('task-lock-escape', (_dir, task) => {
      task.environment = { offline: true, lockfile: '../outside/package-lock.json', commandsMustMatchOffline: false }
    })
    const escapeLockStructure = validateStructure(escapeLock)
    record(
      'environment lockfile ../ 逃逸 → 结构校验 FAIL',
      escapeLockStructure.ok === false && escapeLockStructure.errors.some(error => error.includes('escape')),
      JSON.stringify(escapeLockStructure.errors),
    )
    const relativeLock = makeEnvTask('task-lock-relative', (dir, task) => {
      task.environment = { offline: true, lockfile: 'fixtures/package-lock.json', commandsMustMatchOffline: false }
      mkdirSync(join(dir, 'fixtures'), { recursive: true })
      writeFileSync(join(dir, 'fixtures', 'package-lock.json'), '{}\n', 'utf8')
    })
    const relativeLockStructure = validateStructure(relativeLock)
    record(
      'environment lockfile 合法相对路径 → 结构校验 PASS',
      relativeLockStructure.ok === true,
      JSON.stringify(relativeLockStructure.errors ?? relativeLockStructure.warnings),
    )

    // ---- F15/R5/R6: 稳定内容一致性 + base 失败归属分类（自测合成夹具，不改仓库）----
    const classifyRepo = join(root, 'repo-classify')
    mkdirSync(join(classifyRepo, 'targetpkg'), { recursive: true })
    writeFileSync(join(classifyRepo, 'state.txt'), 'base\n', 'utf8')
    writeFileSync(join(classifyRepo, 'targetpkg', '__init__.py'), '', 'utf8')
    git(classifyRepo, ['init', '--quiet'])
    git(classifyRepo, ['add', '-A'])
    git(classifyRepo, ['-c', 'user.name=B2 Self Test', '-c', 'user.email=b2@example.invalid', 'commit', '--quiet', '-m', 'classify base'])
    const classifyBase = git(classifyRepo, ['rev-parse', 'HEAD']).trim()
    const classifyPatch = join(root, 'classify-reference.patch')
    writeFileSync(classifyPatch, [
      'diff --git a/state.txt b/state.txt',
      '--- a/state.txt',
      '+++ b/state.txt',
      '@@ -1 +1 @@',
      '-base',
      '+fixed',
      '',
    ].join('\n'), 'utf8')
    const scriptLines = (lines) => `${lines.join('\n')}\n`
    const makeClassifyCard = (name, hiddenBody) => {
      const dir = join(root, `classify-card-${name}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'issue.md'), '# classify\n\n## 任务\n合成分类自测。\n\n## 验收\n见 hidden-test。\n\n## 合法范围\n仅 state.txt。\n', 'utf8')
      writeFileSync(join(dir, 'review.md'), '合法范围：仅 state.txt；本文件是 self-test 合成夹具，不是真实任务卡或实验记录。\n', 'utf8')
      writeFileSync(join(dir, 'hidden-test.sh'), hiddenBody, 'utf8')
      writeFileSync(join(dir, 'reference.patch'), readFileSync(classifyPatch), 'utf8')
      writeFileSync(join(dir, 'task.json'), `${JSON.stringify({
        schemaVersion: 1,
        taskId: `classify-${name}`,
        repo: 'synthetic',
        base: null,
        category: 'new-feature',
        referenceFix: 'reference.patch',
        allowedFiles: ['state.txt'],
        issue: 'issue.md',
        hiddenTest: 'hidden-test.sh',
        review: 'review.md',
        stagedSuitable: false,
        contamination: { mergedAfterTrainingCutoff: false, private: true, cutoff: null, notes: 'self-test fixture' },
        checks: { baseMustFail: true, referenceMustPass: true },
      }, null, 2)}\n`, 'utf8')
      return dir
    }
    const runClassify = (name, hiddenBody) => validateTask({
      taskDir: makeClassifyCard(name, hiddenBody),
      repo: classifyRepo,
      base: classifyBase,
      reference: join(root, `classify-card-${name}`, 'reference.patch'),
      hiddenTest: join(root, `classify-card-${name}`, 'hidden-test.sh'),
      repeats: 3,
    })
    const fixedPass = 'if [ "$(cat state.txt)" = fixed ]; then echo "PASS: stable"; exit 0; fi'

    // R6 正例：仅元数据变化（JSON 键值）应被归一化，三次判一致。
    const dynamicMetadata = runClassify('dynamic-metadata', scriptLines([
      '#!/bin/sh',
      fixedPass,
      "rid=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')",
      'ts=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)',
      'printf \'AssertionError: expected fixed at {"timestamp": "%s", "requestId": "%s"}\n\' "$ts" "$rid" >&2',
      'exit 1',
    ]))
    record(
      'R6 元数据（JSON timestamp/requestId）变化被归一化：三次一致且分类 target-assertion-failed',
      dynamicMetadata.ok === true
        && dynamicMetadata.checks.base.consistent === true
        && new Set(dynamicMetadata.checks.base.outputSha256).size > 1
        && new Set(dynamicMetadata.checks.base.normalizedSha256).size === 1
        && dynamicMetadata.checks.base.failureClasses.every((entry) => entry.failureClass === 'target-assertion-failed')
        && dynamicMetadata.checks.base.runs.every((run) => typeof run.stdout === 'string' && typeof run.stderr === 'string')
        && (dynamicMetadata.checks.base.normalization?.rules?.length ?? 0) > 0
        && (dynamicMetadata.normalization?.rules?.length ?? 0) > 0,
      JSON.stringify({ ok: dynamicMetadata.ok, classes: dynamicMetadata.checks.base?.failureClasses?.map((entry) => entry.failureClass), rawHashes: dynamicMetadata.checks.base?.outputSha256?.map((hash) => hash?.slice(0, 8)), normalizedHashes: dynamicMetadata.checks.base?.normalizedSha256?.map((hash) => hash?.slice(0, 8)) }),
    )

    // R6 正例：行首日志时间戳属于元数据上下文，可归一化。
    const logPrefixMetadata = runClassify('log-prefix-metadata', scriptLines([
      '#!/bin/sh',
      fixedPass,
      'ts=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)',
      'printf \'[%s] [INFO] request started\nAssertionError: expected fixed\n\' "$ts" >&2',
      'exit 1',
    ]))
    record(
      'R6 行首日志时间戳变化被归一化：三次一致',
      logPrefixMetadata.ok === true
        && logPrefixMetadata.checks.base.consistent === true
        && new Set(logPrefixMetadata.checks.base.outputSha256).size > 1
        && new Set(logPrefixMetadata.checks.base.normalizedSha256).size === 1,
      JSON.stringify({ ok: logPrefixMetadata.ok, rawHashes: logPrefixMetadata.checks.base?.outputSha256?.map((hash) => hash?.slice(0, 8)), normalizedHashes: logPrefixMetadata.checks.base?.normalizedSha256?.map((hash) => hash?.slice(0, 8)) }),
    )

    // R6 反例：业务断言里的时间/UUID 裸值必须保留，三次差异必须判不一致。
    const businessValueVariation = runClassify('business-value-variation', scriptLines([
      '#!/bin/sh',
      fixedPass,
      'counter="$TASK_CHECKOUT/../.classify-business-counter"',
      'n=$(cat "$counter" 2>/dev/null || echo 0)',
      'n=$((n+1))',
      'echo "$n" > "$counter"',
      'case "$n" in 1) d=01;; 2) d=09;; *) d=12;; esac',
      'printf \'AssertionError: actual=2026-%s-01T00:00:00Z id=00000000-0000-4000-8000-00000000000%s\n\' "$d" "$n" >&2',
      'exit 1',
    ]))
    record(
      'R6 业务值（actual 时间/UUID）变化必须判不一致、判卡不合格',
      businessValueVariation.ok === false
        && businessValueVariation.checks.base.consistent === false
        && businessValueVariation.checks.base.failureClasses.every((entry) => entry.failureClass === 'target-assertion-failed')
        && new Set(businessValueVariation.checks.base.normalizedSha256).size > 1,
      JSON.stringify({ ok: businessValueVariation.ok, consistent: businessValueVariation.checks.base?.consistent, normalizedHashes: businessValueVariation.checks.base?.normalizedSha256?.map((hash) => hash?.slice(0, 8)) }),
    )

    // R5 正例：缺失模块属于本地包根（targetpkg）→ target-symbol-missing。
    const symbolMissing = runClassify('symbol-missing', scriptLines([
      '#!/bin/sh',
      fixedPass,
      "printf \"ModuleNotFoundError: No module named 'targetpkg.summary'\\n\" >&2",
      'exit 1',
    ]))
    record(
      'R5 目标包缺失模块 → 归属核对为 target-symbol-missing 且有效',
      symbolMissing.ok === true
        && symbolMissing.checks.base.consistent === true
        && symbolMissing.checks.base.failureClasses.every((entry) => entry.failureClass === 'target-symbol-missing'),
      JSON.stringify({ ok: symbolMissing.ok, classes: symbolMissing.checks.base?.failureClasses?.map((entry) => entry.failureClass) }),
    )

    // R5 反例：第三方依赖缺失 → environment-error（不能只因 ModuleNotFoundError 判目标缺失）。
    const thirdPartyModule = runClassify('third-party-module', scriptLines([
      '#!/bin/sh',
      fixedPass,
      "printf \"ModuleNotFoundError: No module named 'pydantic_core'\\n\" >&2",
      'exit 1',
    ]))
    record(
      'R5 第三方依赖缺失（pydantic_core）→ environment-error、判卡不合格',
      thirdPartyModule.ok === false
        && thirdPartyModule.checks.base.failureClasses.every((entry) => entry.failureClass === 'environment-error')
        && /environment-error/.test(thirdPartyModule.checks.base.invalidReason ?? ''),
      JSON.stringify({ ok: thirdPartyModule.ok, classes: thirdPartyModule.checks.base?.failureClasses?.map((entry) => entry.failureClass) }),
    )

    // R5 反例：第三方客户端 TypeError（无 worktree 调用帧）→ environment-error。
    const thirdPartyTypeError = runClassify('third-party-type-error', scriptLines([
      '#!/bin/sh',
      fixedPass,
      "printf \"TypeError: Client.__init__() got an unexpected keyword argument 'proxies'\\n\" >&2",
      'exit 1',
    ]))
    record(
      'R5 第三方客户端 TypeError（无 worktree 帧）→ environment-error、判卡不合格',
      thirdPartyTypeError.ok === false
        && thirdPartyTypeError.checks.base.failureClasses.every((entry) => entry.failureClass === 'environment-error'),
      JSON.stringify({ ok: thirdPartyTypeError.ok, classes: thirdPartyTypeError.checks.base?.failureClasses?.map((entry) => entry.failureClass) }),
    )

    // R5 正例：目标函数签名不匹配且调用帧在 worktree 内 → target-symbol-missing。
    const targetCallSiteTypeError = runClassify('target-call-site-type-error', scriptLines([
      '#!/bin/sh',
      fixedPass,
      'printf \'Traceback (most recent call last):\\n  File "%s/targetpkg/api.py", line 10, in <module>\\nTypeError: list_diagnoses() takes 3 positional arguments but 4 were given\\n\' "$TASK_CHECKOUT" >&2',
      'exit 1',
    ]))
    record(
      'R5 worktree 调用帧内的目标函数 TypeError → target-symbol-missing 且有效',
      targetCallSiteTypeError.ok === true
        && targetCallSiteTypeError.checks.base.failureClasses.every((entry) => entry.failureClass === 'target-symbol-missing'),
      JSON.stringify({ ok: targetCallSiteTypeError.ok, classes: targetCallSiteTypeError.checks.base?.failureClasses?.map((entry) => entry.failureClass) }),
    )

    const environmentError = runClassify('environment-error', scriptLines([
      '#!/bin/sh',
      fixedPass,
      "echo 'sh: 1: deploy-tool: command not found' >&2",
      'exit 127',
    ]))
    record(
      'F15 base environment-error → 判卡不合格（invalidReason 指出分类）',
      environmentError.ok === false
        && environmentError.checks.base.ok === false
        && environmentError.checks.base.failureClasses.every((entry) => entry.failureClass === 'environment-error')
        && /environment-error/.test(environmentError.checks.base.invalidReason ?? ''),
      JSON.stringify({ ok: environmentError.ok, classes: environmentError.checks.base?.failureClasses?.map((entry) => entry.failureClass), invalidReason: environmentError.checks.base?.invalidReason }),
    )

    const inconsistentReference = runClassify('inconsistent-reference', scriptLines([
      '#!/bin/sh',
      'if [ "$(cat state.txt)" = fixed ]; then',
      "  v=$(od -An -N8 -tu8 /dev/urandom | tr -d ' \n')",
      '  echo "PASS: random $v"',
      '  exit 0',
      'fi',
      'printf "AssertionError: expected fixed\\n" >&2',
      'exit 1',
    ]))
    record(
      'F15 reference 稳定内容不一致 → consistent=false 且判卡不合格',
      inconsistentReference.ok === false
        && inconsistentReference.checks.base.consistent === true
        && inconsistentReference.checks.reference.consistent === false,
      JSON.stringify({ ok: inconsistentReference.ok, baseConsistent: inconsistentReference.checks.base?.consistent, referenceConsistent: inconsistentReference.checks.reference?.consistent }),
    )

    const ok = steps.every((step) => step.ok)
    if (asJson) {
      console.log(JSON.stringify({ selfTest: ok, steps }, null, 2))
    } else {
      for (const step of steps) console.log(`${step.ok ? 'PASS' : 'FAIL'} ${step.name} :: ${step.detail}`)
      console.log(ok ? 'SELF-TEST: PASS' : 'SELF-TEST: FAIL')
    }
    process.exit(ok ? 0 : 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- CLI ------------------------------------------------------------------

function printHuman(report) {
  const lines = []
  lines.push(`[check-task] mode=${report.mode} taskDir=${report.taskDir}`)
  if (report.mode === 'full') {
    if (report.repo) lines.push(`[check-task] repo=${report.repo} base=${report.baseSha} repeats=${report.repeats}`)
    const structureOk = report.structure?.ok
    lines.push(`${structureOk ? 'PASS' : 'FAIL'} structure :: ${structureOk ? 'ok' : (report.structure?.errors ?? []).join('; ')}`)
    if (report.checks.environment) {
      lines.push(`${report.checks.environment.ok ? 'PASS' : 'FAIL'} environment :: offline=${report.checks.environment.offline}${report.checks.environment.lockfile ? ` lockfile=${report.checks.environment.lockfile}` : ''}${report.checks.environment.found === false ? '（lockfile 缺失）' : ''}`)
    }
    for (const warning of report.structure?.warnings ?? []) lines.push(`WARN ${warning}`)
    if (report.checks.base) {
      const baseClasses = (report.checks.base.failureClasses ?? []).map((entry) => entry.failureClass)
      lines.push(`${report.checks.base.ok ? 'PASS' : 'FAIL'} base-hidden-test :: codes=${JSON.stringify(report.checks.base.codes)} expected fail, consistent=${report.checks.base.consistent}, failureClasses=${JSON.stringify(baseClasses)}`)
      if (report.checks.base.invalidReason) lines.push(`FAIL base-classification :: ${report.checks.base.invalidReason}`)
    }
    if (report.normalization) {
      lines.push(`[check-task] normalization=v${report.normalization.version} scope=${report.normalization.scope} rules=${report.normalization.rules.length}（原始 stdout/stderr 与 outputSha256 保留）`)
    }
    if (report.checks.scope) {
      lines.push(`${report.checks.scope.ok ? 'PASS' : 'FAIL'} allowed-scope :: changed=${JSON.stringify(report.checks.scope.changedFiles)} outside=${JSON.stringify(report.checks.scope.outside)}`)
    }
    if (report.checks.reference) {
      if (report.checks.reference.error) lines.push(`FAIL reference :: ${report.checks.reference.error}`)
      else lines.push(`${report.checks.reference.ok ? 'PASS' : 'FAIL'} reference-hidden-test :: codes=${JSON.stringify(report.checks.reference.codes)} expected pass, consistent=${report.checks.reference.consistent}`)
    }
    if (report.error) lines.push(`ERROR ${report.error}`)
    if (report.envError) lines.push(`ENV ${report.envError}`)
  } else {
    lines.push(`${report.ok ? 'PASS' : 'FAIL'} structure :: ${report.ok ? 'ok' : report.errors.join('; ')}`)
    for (const warning of report.warnings ?? []) lines.push(`WARN ${warning}`)
  }
  lines.push(`RESULT: ${report.ok ? 'PASS' : 'FAIL'}`)
  console.log(lines.join('\n'))
}

function main() {
  const asJson = hasFlag('json')
  if (hasFlag('self-test')) selfTest(asJson)

  const taskDir = process.argv[2]
  if (!taskDir || taskDir.startsWith('--')) usage('缺少 <taskDir>')
  const dryRun = hasFlag('dry-run')
  const report = dryRun
    ? { mode: 'dry-run', taskDir: resolve(taskDir), ...validateStructure(taskDir) }
    : validateTask({
        taskDir,
        repo: arg('repo'),
        base: arg('base'),
        reference: arg('reference'),
        hiddenTest: arg('hidden-test'),
        repeats: arg('repeats'),
        timeoutMs: arg('timeout-ms'),
      })

  if (asJson) console.log(JSON.stringify(report, null, 2))
  else printHuman(report)

  if (report.exitCode === 2) process.exit(2)
  process.exit(report.ok ? 0 : 1)
}

main()
