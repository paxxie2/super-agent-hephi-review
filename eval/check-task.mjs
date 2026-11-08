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
  version: 4,
  scope: 'stdout+stderr',
  rules: [
    'CRLF/CR → LF',
    '行首结构化日志前缀（[ts] [LEVEL] 或 ts - LEVEL -）的时间只替换为 <log-timestamp>，保留级别与正文',
    '关联 ID 键值（requestId/traceId/spanId/pid/correlationId 等）只在带上述日志前缀的日志行内 → <dynamic>',
    '普通 JSON 行、AssertionError 任意行（含多行负载）、actual=/expected= 等业务内容一律不归一化；timestamp/createdAt 等业务值也不归一化',
    '裸值、actual=/expected= 之后的值、普通文本中的时间/UUID 不归一化（业务结果差异必须保留）',
  ],
  note: 'N02：只有带结构化日志前缀的日志行才做时间/关联 ID 归一化；普通 JSON 与断言负载（含多行）保留原值。原始 stdout/stderr 与 outputSha256 不删除。',
}

const METADATA_KEYS = 'requestId|request_id|traceId|trace_id|spanId|span_id|pid|correlationId|correlation_id|x-request-id'
const METADATA_KV_PATTERN = new RegExp(
  `(["'](?:${METADATA_KEYS})["']\\s*:\\s*)(?:"[^"]*"|'[^']*'|[^,\\s}\\]]+)`,
  'gi',
)
const LOG_LEVELS = 'TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL'
// N02：只有带结构化日志前缀的行才归一化；普通 JSON/断言负载不参与关联 ID 归一化。
const LOG_LINE_TEST_BRACKET = new RegExp(`^\\[\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?\\]\\s*\\[(?:${LOG_LEVELS})\\]`)
const LOG_LINE_TEST_DASH = new RegExp(`^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?\\s+-\\s+(?:${LOG_LEVELS})\\s+-`)
const LOG_TIMESTAMP_BRACKET_PATTERN = new RegExp(
  `^(\\[\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?\\])(\\s*\\[(?:${LOG_LEVELS})\\])`,
  'gm',
)
const LOG_TIMESTAMP_DASH_PATTERN = new RegExp(
  `^(\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)(\\s+-\\s+(?:${LOG_LEVELS})\\s+-)`,
  'gm',
)

function normalizeStableOutput(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  return lines.map(line => {
    const isLogLine = LOG_LINE_TEST_BRACKET.test(line) || LOG_LINE_TEST_DASH.test(line)
    if (!isLogLine) return line
    let normalized = line.replace(LOG_TIMESTAMP_BRACKET_PATTERN, '<log-timestamp>$2')
    normalized = normalized.replace(LOG_TIMESTAMP_DASH_PATTERN, '<log-timestamp>$2')
    return normalized.replace(METADATA_KV_PATTERN, '$1<dynamic>')
  }).join('\n')
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

/**
 * C01：目标来源索引。分类不能只看调用帧（参数绑定失败时被调函数没有帧）：
 * 先取异常抛出的符号/函数名，再在 worktree 源码里找出它的定义文件；定义在 worktree
 * 才算任务目标缺失，只在 site-packages/外部依赖里才归环境错误。
 */
function buildSourceIndex(worktree) {
  const functions = new Map()
  const classes = new Map()
  const modules = new Map()
  const add = (map, name, rel) => {
    if (!map.has(name)) map.set(name, [])
    map.get(name).push(rel)
  }
  const walk = (dir, relBase) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '__pycache__') continue
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name
      if (entry.isDirectory()) { walk(join(dir, entry.name), rel); continue }
      if (!entry.isFile()) continue
      if (entry.name.endsWith('.py')) {
        const module = entry.name.slice(0, -3)
        if (module !== '__init__') add(modules, module, rel)
        let text
        try { text = readFileSync(join(dir, entry.name), 'utf8') } catch { text = '' }
        for (const match of text.matchAll(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm)) add(functions, match[1], rel)
        // 类与其方法（按缩进归属，覆盖 class Client: def __init__ 这类定义）。
        const lines = text.split('\n')
        let current = null
        let classIndent = -1
        for (const line of lines) {
          const classMatch = /^(\s*)class\s+([A-Za-z_]\w*)(?:\s*\([^)]*\))?\s*:/.exec(line)
          if (classMatch) {
            current = classMatch[2]
            classIndent = classMatch[1].length
            if (!classes.has(current)) classes.set(current, { files: new Set(), methods: new Set() })
            classes.get(current).files.add(rel)
            continue
          }
          if (current === null) continue
          const indent = /^(\s*)/.exec(line)[1].length
          if (line.trim() !== '' && indent <= classIndent && /^\s*(?:@|def|async\s+def|class)\b/.test(line)) {
            current = null
            continue
          }
          const method = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(line)
          if (method) classes.get(current).methods.add(method[1])
        }
      }
    }
  }
  walk(worktree, '')
  return { functions, classes, modules }
}

/** AttributeError 的模块/对象来源与属性名；TypeError 等的被调函数名。 */
function exceptionSymbols(text) {
  const symbols = []
  for (const match of text.matchAll(/(?:TypeError|ValueError|AttributeError|KeyError|IndexError|RuntimeError|NotImplementedError|NameError):\s*([A-Za-z_][\w.]*)\(\)/g)) {
    symbols.push({ kind: 'call', name: match[1] })
  }
  for (const match of text.matchAll(/AttributeError: (?:module )?['"]?([A-Za-z_][\w.]*)['"]?(?: object)? has no attribute ['"]?(\w+)/g)) {
    symbols.push({ kind: 'attribute', name: match[1], attribute: match[2] })
  }
  for (const match of text.matchAll(/NameError: name ['"](\w+)['"] is not defined/g)) {
    symbols.push({ kind: 'name', name: match[1] })
  }
  const cannotImport = CANNOT_IMPORT_PATTERN.exec(text)
  if (cannotImport) symbols.push({ kind: 'cannot-import', name: cannotImport[1], module: cannotImport[2] })
  return symbols
}

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

/** 单个路径是否位于任务 worktree 内（含 macOS /private 前缀差异）。 */
function pathInsideWorktree(pathText, worktree) {
  if (!worktree) return false
  const normalizedWorktree = normalizePathForCompare(worktree).replace(/\/+$/, '')
  const normalized = normalizePathForCompare(pathText)
  return normalized === normalizedWorktree
    || normalized.startsWith(`${normalizedWorktree}/`)
    || normalized.startsWith(`/private${normalizedWorktree}/`)
}

/** 最内层（异常抛出点）帧路径；无 traceback 返回 null。 */
function innermostFramePath(text) {
  const frames = [...text.matchAll(/File "([^"]+)"/g)].map((m) => m[1])
  return frames.length ? frames[frames.length - 1] : null
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
/** 读取 worktree 内文本文件；失败返回空串。 */
function readTextSafe(file) {
  try { return readFileSync(file, 'utf8') } catch { return '' }
}

/** 解析 traceback：帧路径、函数、以及帧后源码行（参数绑定失败时被调函数无帧）。 */
function parseTraceback(text) {
  const lines = String(text ?? '').split('\n')
  const frames = []
  for (let index = 0; index < lines.length; index++) {
    const match = /^\s*File "([^"]+)", line (\d+), in (.+)$/.exec(lines[index])
    if (!match) continue
    let sourceLine = null
    for (let next = index + 1; next < Math.min(index + 4, lines.length); next++) {
      const candidate = lines[next]
      if (/^\s*File "/.test(candidate)) break
      if (/^\s{2,}\S/.test(candidate)) { sourceLine = candidate.trim(); break }
    }
    frames.push({ path: match[1], func: match[3].trim(), sourceLine })
  }
  return frames
}

/** 从「模块.名字(...)」取限定调用；无源码行时从异常消息取被调符号。 */
function calledExpression(frames, text) {
  const message = String(text ?? '')
  const messageCall = /(?:TypeError|ValueError|AttributeError|KeyError|IndexError|RuntimeError|NotImplementedError|NameError):\s*([A-Za-z_][\w.]*)\(\)/.exec(message)
  const messageName = messageCall ? messageCall[1].split('.').pop() : null
  for (let index = frames.length - 1; index >= 0; index--) {
    const source = frames[index].sourceLine
    if (!source) continue
    const matches = [...source.matchAll(/([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g)].map(match => match[1])
    if (matches.length === 0) continue
    // 优先选与异常消息同名的被调函数（源码行可能含 print(...) 等外层调用）；否则取最内层。
    const preferred = messageName ? matches.find(name => name.split('.').pop() === messageName) : null
    return preferred ?? matches[matches.length - 1]
  }
  return messageCall ? messageCall[1] : null
}

/** 把 import 语句解析成 alias -> 完整模块名（只处理绝对模块；相对导入不用于归属）。 */
function importBindings(content) {
  const modules = new Map()
  const symbols = new Map()
  for (const match of content.matchAll(/^\s*import\s+([A-Za-z_][\w.]*)(?:\s+as\s+([A-Za-z_]\w*))?/gm)) {
    modules.set(match[2] ?? match[1].split('.')[0], match[1])
  }
  for (const match of content.matchAll(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+([^\n#]+)/gm)) {
    const module = match[1]
    for (const spec of match[2].split(',')) {
      const item = /^\s*([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(spec)
      if (!item) continue
      symbols.set(item[2] ?? item[1], module)
      // 该符号也可能是子模块（from pkg import submodule as alias）。
      modules.set(item[2] ?? item[1], `${module}.${item[1]}`)
    }
  }
  return { modules, symbols }
}

/** 模块名是否解析到 worktree 内的 Python 文件（sys.path 可能是仓库根或其子目录）。 */
function moduleFileInWorktree(worktree, moduleName, packageRoots = []) {
  const segments = String(moduleName).split('.').filter(Boolean)
  if (segments.length === 0) return null
  const bases = [worktree]
  for (const root of packageRoots) if (root && !root.includes('*')) bases.push(join(worktree, root))
  try {
    for (const entry of readdirSync(worktree, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') bases.push(join(worktree, entry.name))
    }
  } catch { /* ignore */ }
  for (const base of bases) {
    const file = join(base, ...segments) + '.py'
    if (existsSync(file)) return file
    const init = join(base, ...segments, '__init__.py')
    if (existsSync(init)) return init
  }
  return null
}

/** 文件内是否定义/从本地模块导入了 `name`（同名定义只在无关文件不算）。 */
function fileDefinesOrImportsLocal(filePath, name, worktree, packageRoots) {
  const content = readTextSafe(filePath)
  if (new RegExp(`^\\s*(?:async\\s+)?def\\s+${name}\\s*\\(`, 'm').test(content)) return { evidence: `def ${name} in ${filePath}` }
  if (new RegExp(`^\\s*class\\s+${name}\\b`, 'm').test(content)) return { evidence: `class ${name} in ${filePath}` }
  const bindings = importBindings(content)
  const moduleName = bindings.symbols.get(name) ?? bindings.modules.get(name)
  if (moduleName) {
    const moduleFile = moduleFileInWorktree(worktree, moduleName, packageRoots)
    if (moduleFile) return { evidence: `import ${name} from local module ${moduleName} (${moduleFile})` }
  }
  return null
}

/** 从限定调用表达式解析模块：优先调用文件里的 import 绑定，其次本地包根/模块路径。 */
function resolveQualifiedModule(expression, frameFile, worktree, packageRoots) {
  const parts = expression.split('.')
  const functionName = parts.pop()
  if (!functionName) return null
  const qualifier = parts.join('.')
  const content = frameFile ? readTextSafe(frameFile) : ''
  const bindings = importBindings(content)
  const first = qualifier.split('.')[0]
  let moduleName = null
  if (bindings.modules.has(first)) {
    const base = bindings.modules.get(first)
    const rest = qualifier.split('.').slice(1)
    moduleName = rest.length ? `${base}.${rest.join('.')}` : base
  } else if (bindings.symbols.has(first)) {
    moduleName = qualifier === first ? bindings.symbols.get(first) : `${bindings.symbols.get(first)}.${qualifier.split('.').slice(1).join('.')}`
  } else if (packageRoots.includes(first)) {
    moduleName = qualifier
  } else {
    moduleName = qualifier
  }
  const moduleFile = moduleFileInWorktree(worktree, moduleName, packageRoots)
  return moduleFile ? { moduleName, moduleFile, functionName } : null
}

function targetSymbolEvidence(text, { worktree, packageRoots = [], sourceIndex = null } = {}) {
  const index = sourceIndex ?? (worktree ? buildSourceIndex(worktree) : { functions: new Map(), classes: new Map(), modules: new Map() })
  const frames = parseTraceback(text)
  const worktreeFrames = frames.filter(frame => pathInsideWorktree(frame.path, worktree))
  const stdinFrames = frames.length > 0 && frames.every(frame => frame.path === '<stdin>' || frame.path === '<string>' || frame.path === '<module>')
  // 1) 本地包缺失模块：模块名必须是本地包根（或能解析为 worktree 模块文件）。
  for (const name of text.matchAll(IMPORT_ERROR_PATTERN)) {
    if (moduleBelongsToTarget(name[1], packageRoots) || moduleFileInWorktree(worktree, name[1], packageRoots)) {
      return { reason: `missing module '${name[1]}' belongs to the task worktree` }
    }
  }
  const cannotImport = CANNOT_IMPORT_PATTERN.exec(text)
  if (cannotImport && (moduleBelongsToTarget(cannotImport[2], packageRoots) || moduleFileInWorktree(worktree, cannotImport[2], packageRoots))) {
    return { reason: `cannot import name '${cannotImport[1]}' from local module '${cannotImport[2]}'` }
  }
  // 2) AttributeError：模块的本地文件 / 调用文件内的类定义才可作为目标依据；同名索引只是候选。
  const attributeError = /AttributeError: (?:module )?['"]?([A-Za-z_][\w.]*)['"]?(?: object)? has no attribute ['"]?(\w+)/.exec(text)
  if (attributeError) {
    const owner = attributeError[1]
    const basename = owner.split('.').pop()
    if (index.modules.has(basename)) {
      return { reason: `AttributeError on local module '${owner}' loaded from ${index.modules.get(basename).join(', ')}` }
    }
    const frame = worktreeFrames[worktreeFrames.length - 1]
    const defined = frame ? fileDefinesOrImportsLocal(frame.path, basename, worktree, packageRoots) : null
    if (defined) return { reason: `AttributeError on class '${owner}' defined in the task worktree (${defined.evidence})` }
    // 同名类在无关文件里出现，不构成归属证据。
    return null
  }
  // 3) 被调符号：优先源码行里的限定/裸调用；无源码行时回退异常消息（仅 stdin/裸函数可用）。
  const expression = calledExpression(frames, text)
  if (expression) {
    const parts = expression.split('.')
    const functionName = parts[parts.length - 1]
    if (parts.length >= 2) {
      const frame = worktreeFrames[worktreeFrames.length - 1]
      const resolved = resolveQualifiedModule(expression, frame?.path, worktree, packageRoots)
      if (resolved) {
        return { reason: `exception raised by ${functionName}() whose module ${resolved.moduleName} resolves to the task worktree (${resolved.moduleFile})` }
      }
      return null
    }
    const frame = worktreeFrames[worktreeFrames.length - 1]
    if (frame) {
      const defined = fileDefinesOrImportsLocal(frame.path, functionName, worktree, packageRoots)
      if (defined) return { reason: `exception raised by ${functionName}() which the calling file defines/imports locally (${defined.evidence})` }
      return null
    }
    if (stdinFrames || frames.length === 0) {
      if (index.functions.has(functionName) || index.classes.has(functionName)) {
        return { reason: `exception raised by ${functionName}() whose definition is in the task worktree (stdin/exec call)` }
      }
    }
    return null
  }
  // 4) NameError：仅调用文件内定义/本地导入，或 stdin 下的 worktree 定义。
  const nameError = /NameError: name ['"](\w+)['"] is not defined/.exec(text)
  if (nameError) {
    const frame = worktreeFrames[worktreeFrames.length - 1]
    if (frame) {
      const defined = fileDefinesOrImportsLocal(frame.path, nameError[1], worktree, packageRoots)
      return defined ? { reason: `NameError for ${nameError[1]} defined in ${defined.evidence}` } : null
    }
    if (index.functions.has(nameError[1]) || index.classes.has(nameError[1])) {
      return { reason: `NameError for ${nameError[1]} whose definition is in the task worktree (stdin/exec call)` }
    }
    return null
  }
  // 5) 其它：只有异常指向 worktree 路径的缺文件才算目标。
  if (worktree && FILE_MISSING_PATTERN.test(text) && normalizePathForCompare(text).includes(normalizePathForCompare(worktree).replace(/\/+$/, ''))) {
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

/**
 * C04：reference.patch 自己声明的路径全集（diff --git a/... b/...）。范围检查不能只信
 * git diff/ls-files：被 .gitignore 忽略的新文件不会出现在那里。
 */
function patchDeclaredPaths(referencePath) {
  const text = readFileSync(referencePath, 'utf8')
  const paths = new Set()
  for (const match of text.matchAll(/^diff --git a\/(.+?) b\/(.+?)$/gm)) {
    for (const raw of [match[1], match[2]]) {
      const path = raw.replace(/^"|"$/g, '')
      if (path && path !== '/dev/null') paths.add(path)
    }
  }
  return [...paths].sort()
}

/** C04：工作树文件树快照（含 ignored/untracked；跳 .git），用于发现补丁带来的实际文件变化。 */
function snapshotWorktree(worktree, limit = 20000) {
  const files = new Map()
  const walk = (dir, relBase) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name
      if (entry.isDirectory()) { walk(join(dir, entry.name), rel); continue }
      if (!entry.isFile()) continue
      if (files.size >= limit) return
      try { files.set(rel, sha256(readFileSync(join(dir, entry.name)))) } catch { /* unreadable */ }
    }
  }
  walk(worktree, '')
  return files.size >= limit ? null : files
}

function changedFromSnapshots(before, after) {
  if (before === null || after === null) return []
  const changed = new Set()
  for (const [path, hash] of after) if (before.get(path) !== hash) changed.add(path)
  for (const path of before.keys()) if (!after.has(path)) changed.add(path)
  return [...changed]
}

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

/**
 * C03：每次运行（含重复运行）都从干净 base 开始，避免 base/reference 或前一次运行留在
 * checkout 里的状态影响下一次结论。只重置临时 worktree，不碰主仓库。
 */
function resetCheckout(worktree, baseSha) {
  git(worktree, ['reset', '--hard', '--quiet', baseSha])
  git(worktree, ['clean', '-ffdxq'])
}

function repeatRuns(worktree, hiddenPath, repeats, timeoutMs, baseSha) {
  if (baseSha === undefined) return Array.from({ length: repeats }, () => runHidden(worktree, hiddenPath, timeoutMs))
  return Array.from({ length: repeats }, () => {
    resetCheckout(worktree, baseSha)
    return runHidden(worktree, hiddenPath, timeoutMs)
  })
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
    isolation: {
      reset: '每次运行前 git reset --hard <baseSha> + git clean -ffdx；base 与 reference 阶段彼此隔离，重复运行也重置',
      baseReset: true,
      referenceReset: true,
      repeatsReset: true,
    },
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
    // R5/C01：本地包根 + 目标源码索引用于 base 失败归属核对。
    const packageRoots = localPackageRoots(worktree, task.allowedFiles)
    const sourceIndex = buildSourceIndex(worktree)
    const baseRuns = repeatRuns(worktree, hiddenPath, repeats, timeoutMs, baseSha)
    const baseConsistency = summarizeConsistency(baseRuns)
    const failureClasses = baseRuns.map((run) => ({ code: run.code, ...classifyBaseFailure(run, { worktree, packageRoots, sourceIndex }) }))
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

    // C03：reference 阶段从干净 base 开始，不能复用 base 测试留下的状态。
    resetCheckout(worktree, baseSha)
    // C04：补丁应用前记录完整文件树（含 ignored 文件），应用后对比。
    const treeBefore = snapshotWorktree(worktree)
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
      const treeAfter = snapshotWorktree(worktree)
      const filesystemChanges = changedFromSnapshots(treeBefore, treeAfter)
      const patchPaths = patchDeclaredPaths(referencePath)
      const changedFiles = [
        ...new Set([
          ...git(worktree, ['diff', '--name-only', '--no-renames']).split('\n').filter(Boolean),
          ...newUntracked,
          ...filesystemChanges,
          ...patchPaths,
        ]),
      ].sort()
      const outside = changedFiles.filter((file) => !task.allowedFiles.some((glob) => matchesGlob(file, glob)))
      report.checks.scope = {
        allowedFiles: task.allowedFiles,
        patchPaths,
        filesystemChanges,
        changedFiles,
        outside,
        ok: outside.length === 0,
      }
      // C03：重复运行也各自重置到干净 base 并重新应用参考补丁，避免上一次运行的状态。
      const referenceRuns = []
      let replayError = null
      for (let index = 0; index < repeats; index++) {
        try {
          resetCheckout(worktree, baseSha)
          git(worktree, ['apply', '--whitespace=nowarn', referencePath])
        } catch (error) {
          replayError = error.message.split('\n').slice(0, 3).join(' ')
          break
        }
        referenceRuns.push(runHidden(worktree, hiddenPath, timeoutMs))
      }
      if (replayError !== null) {
        report.checks.reference = { ok: false, error: `参考修复在重置后的干净 base 上应用失败：${replayError}` }
      }
      if (replayError === null) {
        const referenceConsistency = summarizeConsistency(referenceRuns)
        report.checks.reference = {
          expected: 'pass',
          runs: referenceRuns,
          codes: referenceConsistency.codes,
          outputSha256: referenceConsistency.outputSha256,
          normalizedSha256: referenceConsistency.normalizedSha256,
          consistent: referenceConsistency.consistent,
          normalization: NORMALIZATION,
          ok: referenceRuns.length === repeats
            && referenceRuns.every((run) => run.code === 0)
            && referenceConsistency.consistent,
        }
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
    mkdirSync(join(classifyRepo, 'backend', 'app', 'domain'), { recursive: true })
    writeFileSync(join(classifyRepo, 'state.txt'), 'base\n', 'utf8')
    writeFileSync(join(classifyRepo, 'targetpkg', '__init__.py'), '', 'utf8')
    writeFileSync(join(classifyRepo, 'targetpkg', 'service.py'), 'def list_diagnoses(db_path, limit, offset):\n    return [], 0\n', 'utf8')
    writeFileSync(join(classifyRepo, 'targetpkg', 'api.py'), 'from targetpkg.service import list_diagnoses\n\ndef new_api():\n    return 1\n', 'utf8')
    writeFileSync(join(classifyRepo, 'caller.py'), 'import httpx\n\nclient = httpx.Client(proxies={})\n', 'utf8')
    writeFileSync(join(classifyRepo, 'unrelated.py'), 'class Client:\n    def __init__(self):\n        pass\n', 'utf8')
    writeFileSync(join(classifyRepo, 'backend', 'app', 'domain', 'money.py'), 'def previous_window(start, end):\n    return start, end\n', 'utf8')
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

    // C02 正例：日志行上的元数据（JSON requestId）被归一化，三次判一致。
    const logMetadata = runClassify('log-metadata', scriptLines([
      '#!/bin/sh',
      fixedPass,
      "rid=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')",
      'printf \'[2026-11-09T00:00:00.000Z] [INFO] {"requestId": "%s", "loggedVia": "fixed"}\\n\' "$rid" >&2',
      'printf \'AssertionError: expected fixed\\n\' >&2',
      'exit 1',
    ]))
    record(
      'C02 正例：日志元数据行 requestId 变化被归一化：三次一致且 classification=target-assertion-failed',
      logMetadata.ok === true
        && logMetadata.checks.base.consistent === true
        && new Set(logMetadata.checks.base.outputSha256).size > 1
        && new Set(logMetadata.checks.base.normalizedSha256).size === 1
        && logMetadata.checks.base.failureClasses.every((entry) => entry.failureClass === 'target-assertion-failed')
        && (logMetadata.checks.base.normalization?.rules?.length ?? 0) > 0,
      JSON.stringify({ ok: logMetadata.ok, rawHashes: logMetadata.checks.base?.outputSha256?.map((hash) => hash?.slice(0, 8)), normalizedHashes: logMetadata.checks.base?.normalizedSha256?.map((hash) => hash?.slice(0, 8)) }),
    )

    // C02 反例：业务断言负载里的 requestId 变化不得归一化（三次必须判不一致）。
    const assertionRequestId = runClassify('assertion-request-id', scriptLines([
      '#!/bin/sh',
      fixedPass,
      "rid=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')",
      'printf \'AssertionError: expected fixed at {"requestId": "%s"}\\n\' "$rid" >&2',
      'exit 1',
    ]))
    record(
      'C02 反例：AssertionError 业务负载 requestId 变化保留 → 三次不一致、判卡不合格',
      assertionRequestId.checks.base.consistent === false
        && assertionRequestId.ok === false
        && new Set(assertionRequestId.checks.base.normalizedSha256).size > 1,
      JSON.stringify({ ok: assertionRequestId.ok, consistent: assertionRequestId.checks.base?.consistent, normalizedHashes: assertionRequestId.checks.base?.normalizedSha256?.map((hash) => hash?.slice(0, 8)) }),
    )

    // T10-02 反例：业务 JSON 的 createdAt 差异不得被归一化（键名不能证明是元数据）。
    const businessCreatedAt = runClassify('business-created-at', scriptLines([
      '#!/bin/sh',
      fixedPass,
      "rnd=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')",
      'printf \'AssertionError: actual={"createdAt":"2026-run-%s"}\n\' "$rnd" >&2',
      'exit 1',
    ]))
    record(
      'T10-02 业务 JSON createdAt 差异保留：三次不一致',
      businessCreatedAt.checks.base.consistent === false,
      JSON.stringify({ normalized: businessCreatedAt.checks.base?.normalizedSha256?.map((hash) => hash?.slice(0, 8)) }),
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

    // N02 反例：普通 JSON 行（无日志前缀）的 requestId 变化必须保留。
    const plainJsonRequestId = runClassify('plain-json-request-id', scriptLines([
      '#!/bin/sh',
      fixedPass,
      "rid=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \\n')",
      'printf \'{"requestId": "%s"}\\n\' "$rid" >&2',
      'printf \'AssertionError: expected fixed\\n\' >&2',
      'exit 1',
    ]))
    record(
      'N02 反例：普通 JSON 行 requestId 变化保留 → 三次不一致、判卡不合格',
      plainJsonRequestId.checks.base.consistent === false
        && plainJsonRequestId.ok === false,
      JSON.stringify({ ok: plainJsonRequestId.ok, consistent: plainJsonRequestId.checks.base?.consistent }),
    )

    // N02 反例：多行 AssertionError 负载第二行（无关键字）的 requestId 变化必须保留。
    const multilineAssertionRequestId = runClassify('multiline-assertion-request-id', scriptLines([
      '#!/bin/sh',
      fixedPass,
      "rid=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \\n')",
      'printf \'AssertionError: actual={\\n  "requestId": "%s"\\n}\\n\' "$rid" >&2',
      'exit 1',
    ]))
    record(
      'N02 反例：多行 AssertionError 内 requestId 变化保留 → 三次不一致、判卡不合格',
      multilineAssertionRequestId.checks.base.consistent === false
        && multilineAssertionRequestId.ok === false,
      JSON.stringify({ ok: multilineAssertionRequestId.ok, consistent: multilineAssertionRequestId.checks.base?.consistent }),
    )

    // C02 反例：同一时间戳格式下日志级别变化必须保留（INFO vs ERROR 不得归一成同一输出）。
    const logLevelChange = runClassify('log-level-change', scriptLines([
      '#!/bin/sh',
      fixedPass,
      'counter="$TASK_CHECKOUT/../.classify-log-level-counter"',
      'n=$(cat "$counter" 2>/dev/null || echo 0)',
      'n=$((n+1))',
      'echo "$n" > "$counter"',
      'case "$n" in 2) level=ERROR;; *) level=INFO;; esac',
      'printf \'[2026-11-09T00:00:00.000Z] [%s] request started\\n\' "$level" >&2',
      'printf \'AssertionError: expected fixed\\n\' >&2',
      'exit 1',
    ]))
    record(
      'C02 反例：日志级别 INFO/ERROR 变化保留 → 三次不一致、判卡不合格',
      logLevelChange.checks.base.consistent === false
        && logLevelChange.ok === false
        && new Set(logLevelChange.checks.base.normalizedSha256).size > 1,
      JSON.stringify({ ok: logLevelChange.ok, consistent: logLevelChange.checks.base?.consistent, normalizedHashes: logLevelChange.checks.base?.normalizedSha256?.map((hash) => hash?.slice(0, 8)) }),
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
      'printf \'Traceback (most recent call last):\\n  File "%s/caller.py", line 12, in <module>\\nTypeError: Client.__init__() got an unexpected keyword argument proxies\\n\' "$TASK_CHECKOUT" >&2',
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
      'printf \'Traceback (most recent call last):\\n  File "%s/targetpkg/api.py", line 10, in <module>\\n    list_diagnoses(db, 10, 0, "S01")\\nTypeError: list_diagnoses() takes 3 positional arguments but 4 were given\\n\' "$TASK_CHECKOUT" >&2',
      'exit 1',
    ]))
    record(
      'C01 目标函数定义在 worktree（traceback 只有 caller 帧）→ target-symbol-missing 且有效',
      targetCallSiteTypeError.ok === true
        && targetCallSiteTypeError.checks.base.failureClasses.every((entry) => entry.failureClass === 'target-symbol-missing'),
      JSON.stringify({ ok: targetCallSiteTypeError.ok, classes: targetCallSiteTypeError.checks.base?.failureClasses?.map((entry) => entry.failureClass) }),
    )

    // C01 正例：<stdin>/exec 无文件帧时，按异常函数名在 worktree 源码里找到定义（history-page-size-v3 场景）。
    const stdinTargetMissing = runClassify('stdin-target-missing', scriptLines([
      '#!/bin/sh',
      fixedPass,
      'printf \'Traceback (most recent call last):\\n  File "<stdin>", line 7, in <module>\\nTypeError: list_diagnoses() takes 3 positional arguments but 4 were given\\n\' >&2',
      'exit 1',
    ]))
    record(
      'C01 正例：<stdin> 调用的目标函数定义在 worktree（list_diagnoses）→ target-symbol-missing 且有效',
      stdinTargetMissing.ok === true
        && stdinTargetMissing.checks.base.failureClasses.every((entry) => entry.failureClass === 'target-symbol-missing'),
      JSON.stringify({ ok: stdinTargetMissing.ok, classes: stdinTargetMissing.checks.base?.failureClasses?.map((entry) => entry.failureClass) }),
    )

    // C01 正例：importlib 把本地文件加载为别名模块（module 'money'）——模块名不是顶层包根，但仍属于 worktree。
    const importlibAlias = runClassify('importlib-alias', scriptLines([
      '#!/bin/sh',
      fixedPass,
      'printf \'Traceback (most recent call last):\\n  File "<stdin>", line 5, in <module>\\nAttributeError: module money has no attribute previous_windows\\n\' >&2',
      'exit 1',
    ]))
    record(
      'C01 正例：importlib 别名模块 money（文件在 worktree）缺属性 → target-symbol-missing 且有效',
      importlibAlias.ok === true
        && importlibAlias.checks.base.failureClasses.every((entry) => entry.failureClass === 'target-symbol-missing'),
      JSON.stringify({ ok: importlibAlias.ok, classes: importlibAlias.checks.base?.failureClasses?.map((entry) => entry.failureClass) }),
    )

    // C01 反例：真实 httpx 参数绑定失败没有第三方函数体帧，只有本地 caller 帧；不能按调用帧判目标。
    const thirdPartyBinding = runClassify('third-party-binding', scriptLines([
      '#!/bin/sh',
      fixedPass,
      'printf \'Traceback (most recent call last):\\n  File "%s/caller.py", line 12, in <module>\\nTypeError: Client.__init__() got an unexpected keyword argument proxies\\n\' "$TASK_CHECKOUT" >&2',
      'exit 1',
    ]))
    record(
      'C01 反例：第三方 Client.__init__ 参数绑定失败（只有 worktree caller 帧）→ environment-error、判卡不合格',
      thirdPartyBinding.ok === false
        && thirdPartyBinding.checks.base.failureClasses.every((entry) => entry.failureClass === 'environment-error'),
      JSON.stringify({ ok: thirdPartyBinding.ok, classes: thirdPartyBinding.checks.base?.failureClasses?.map((entry) => entry.failureClass) }),
    )

    // N01：真实 httpx 调用有帧后源码行「httpx.Client(...)」——限定调用模块不是本地包根；
    // checkout 里存在未导入的同名 class Client 也不能作为归属证据。
    const n01Dir = join(root, 'n01-httpx')
    mkdirSync(n01Dir, { recursive: true })
    writeFileSync(join(n01Dir, 'caller.py'), 'import httpx\n\nclient = httpx.Client(proxies={})\n', 'utf8')
    const n01Traceback = [
      'Traceback (most recent call last):',
      `  File ${JSON.stringify(join(n01Dir, 'caller.py'))}, line 3, in <module>`,
      '    client = httpx.Client(proxies={})',
      "TypeError: Client.__init__() got an unexpected keyword argument 'proxies'",
      '',
    ].join('\n')
    const n01Run = { code: 1, signal: null, stdout: '', stderr: n01Traceback }
    const n01Before = classifyBaseFailure(n01Run, { worktree: n01Dir, packageRoots: [], sourceIndex: buildSourceIndex(n01Dir) })
    writeFileSync(join(n01Dir, 'unrelated.py'), 'class Client:\n    def __init__(self):\n        pass\n', 'utf8')
    const n01After = classifyBaseFailure(n01Run, { worktree: n01Dir, packageRoots: [], sourceIndex: buildSourceIndex(n01Dir) })
    record(
      'N01 反例：未导入的同名 class Client 不得把真实 httpx 参数错误判成 target（有无同名均 environment-error）',
      n01Before.failureClass === 'environment-error'
        && n01After.failureClass === 'environment-error'
        && !String(n01After.reason ?? '').includes('unrelated.py'),
      JSON.stringify({ withoutCollision: n01Before, withUnrelatedClass: n01After }),
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

    // ---- C03：base 留下的状态不得影响 reference；重复运行也必须重置 ----
    const carryRepo = join(root, 'repo-carry')
    mkdirSync(carryRepo, { recursive: true })
    writeFileSync(join(carryRepo, 'state.txt'), 'base\n', 'utf8')
    git(carryRepo, ['init', '--quiet'])
    git(carryRepo, ['add', '-A'])
    git(carryRepo, ['-c', 'user.name=B2 Self Test', '-c', 'user.email=b2@example.invalid', 'commit', '--quiet', '-m', 'carry base'])
    const carryBase = git(carryRepo, ['rev-parse', 'HEAD']).trim()
    const carryDir = join(root, 'card-carry')
    mkdirSync(carryDir, { recursive: true })
    writeFileSync(join(carryDir, 'issue.md'), '# carry\n\n## 任务\n合成 C03 自测。\n\n## 验收\n见 hidden-test。\n\n## 合法范围\n仅 state.txt。\n', 'utf8')
    writeFileSync(join(carryDir, 'review.md'), '合法范围：仅 state.txt；本文件是 C03 self-test 合成夹具。\n', 'utf8')
    // base 写 carry.txt 才失败；reference 补丁本身并不修复 carry.txt（只改 state.txt）。
    writeFileSync(join(carryDir, 'hidden-test.sh'), [
      '#!/bin/sh',
      'if [ -f carry.txt ]; then echo "PASS: reused base state"; exit 0; fi',
      'echo "base" > carry.txt',
      'printf "AssertionError: expected carry.txt to exist\\n" >&2',
      'exit 1',
      '',
    ].join('\n'), 'utf8')
    writeFileSync(join(carryDir, 'reference.patch'), [
      'diff --git a/state.txt b/state.txt',
      '--- a/state.txt',
      '+++ b/state.txt',
      '@@ -1 +1 @@',
      '-base',
      '+fixed',
      '',
    ].join('\n'), 'utf8')
    writeFileSync(join(carryDir, 'task.json'), `${JSON.stringify({
      schemaVersion: 1, taskId: 'c03-carry', repo: 'synthetic', base: null, category: 'new-feature',
      referenceFix: 'reference.patch', allowedFiles: ['state.txt'], issue: 'issue.md', hiddenTest: 'hidden-test.sh',
      review: 'review.md', stagedSuitable: false,
      contamination: { mergedAfterTrainingCutoff: false, private: true, cutoff: null, notes: 'self-test fixture' },
      checks: { baseMustFail: true, referenceMustPass: true },
    }, null, 2)}\n`, 'utf8')
    const carryReport = validateTask({
      taskDir: carryDir, repo: carryRepo, base: carryBase,
      reference: join(carryDir, 'reference.patch'), hiddenTest: join(carryDir, 'hidden-test.sh'), repeats: 3,
    })
    record(
      'C03 反例：base 留下 carry.txt 时 reference 不得复用其状态（干净重置后参考修复必须失败）',
      carryReport.ok === false
        && carryReport.checks.base.codes.every((code) => code !== 0)
        && carryReport.checks.base.consistent === true
        && carryReport.checks.reference.ok === false
        && carryReport.checks.reference.codes.every((code) => code !== 0)
        && carryReport.isolation?.baseReset === true
        && carryReport.isolation?.repeatsReset === true,
      JSON.stringify({ ok: carryReport.ok, base: carryReport.checks.base?.codes, ref: carryReport.checks.reference?.codes, isolation: carryReport.isolation }),
    )

    // ---- C04：ignored 新文件、删除、重命名都必须进入范围检查 ----
    const scopeRepo = join(root, 'repo-scope')
    mkdirSync(scopeRepo, { recursive: true })
    writeFileSync(join(scopeRepo, '.gitignore'), 'outside.secret\n', 'utf8')
    writeFileSync(join(scopeRepo, 'notes.txt'), 'base\n', 'utf8')
    writeFileSync(join(scopeRepo, 'secure.txt'), 'secret\n', 'utf8')
    writeFileSync(join(scopeRepo, 'old.txt'), 'old\n', 'utf8')
    git(scopeRepo, ['init', '--quiet'])
    git(scopeRepo, ['add', '-A'])
    git(scopeRepo, ['-c', 'user.name=B2 Self Test', '-c', 'user.email=b2@example.invalid', 'commit', '--quiet', '-m', 'scope base'])
    const scopeBase = git(scopeRepo, ['rev-parse', 'HEAD']).trim()
    const scopeDir = join(root, 'card-scope')
    mkdirSync(scopeDir, { recursive: true })
    writeFileSync(join(scopeDir, 'issue.md'), '# scope\n\n## 任务\n合成 C04 自测。\n\n## 验收\n见 hidden-test。\n\n## 合法范围\n仅 notes.txt。\n', 'utf8')
    writeFileSync(join(scopeDir, 'review.md'), '合法范围：仅 notes.txt；本文件是 C04 self-test 合成夹具。\n', 'utf8')
    writeFileSync(join(scopeDir, 'hidden-test.sh'), [
      '#!/bin/sh',
      'if [ "$(cat notes.txt)" = fixed ]; then echo "PASS: fixed"; exit 0; fi',
      'printf "AssertionError: expected fixed\\n" >&2',
      'exit 1',
      '',
    ].join('\n'), 'utf8')
    writeFileSync(join(scopeDir, 'reference.patch'), [
      'diff --git a/notes.txt b/notes.txt',
      '--- a/notes.txt',
      '+++ b/notes.txt',
      '@@ -1 +1 @@',
      '-base',
      '+fixed',
      'diff --git a/outside.secret b/outside.secret',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/outside.secret',
      '@@ -0,0 +1 @@',
      '+secret',
      'diff --git a/secure.txt b/secure.txt',
      'deleted file mode 100644',
      '--- a/secure.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-secret',
      'diff --git a/old.txt b/outside-renamed.txt',
      'similarity index 100%',
      'rename from old.txt',
      'rename to outside-renamed.txt',
      '',
    ].join('\n'), 'utf8')
    writeFileSync(join(scopeDir, 'task.json'), `${JSON.stringify({
      schemaVersion: 1, taskId: 'c04-scope', repo: 'synthetic', base: null, category: 'new-feature',
      referenceFix: 'reference.patch', allowedFiles: ['notes.txt'], issue: 'issue.md', hiddenTest: 'hidden-test.sh',
      review: 'review.md', stagedSuitable: false,
      contamination: { mergedAfterTrainingCutoff: false, private: true, cutoff: null, notes: 'self-test fixture' },
      checks: { baseMustFail: true, referenceMustPass: true },
    }, null, 2)}\n`, 'utf8')
    const scopeReport = validateTask({
      taskDir: scopeDir, repo: scopeRepo, base: scopeBase,
      reference: join(scopeDir, 'reference.patch'), hiddenTest: join(scopeDir, 'hidden-test.sh'), repeats: 2,
    })
    const scopeOutside = scopeReport.checks.scope?.outside ?? []
    record(
      'C04 反例：ignored 新增/删除/重命名越界均进入 outside（不因 gitignore 消失）',
      scopeReport.ok === false
        && scopeOutside.includes('outside.secret')
        && scopeOutside.includes('secure.txt')
        && scopeOutside.includes('outside-renamed.txt')
        && (scopeReport.checks.scope?.patchPaths ?? []).includes('outside.secret')
        && (scopeReport.checks.scope?.filesystemChanges ?? []).includes('outside.secret'),
      JSON.stringify({ ok: scopeReport.ok, outside: scopeOutside, patchPaths: scopeReport.checks.scope?.patchPaths, fs: scopeReport.checks.scope?.filesystemChanges }),
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
