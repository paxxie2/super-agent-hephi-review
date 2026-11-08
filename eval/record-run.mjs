#!/usr/bin/env node
// ROADMAP-95 工作线 B / B3：运行记录生成器（schema 严格校验 + 原子写）。
//
// 用法：
//   node eval/record-run.mjs --input <candidate.json> --out <record.json>
//   node eval/record-run.mjs --self-test
//
// 行为：
//   1) 按 eval/schema/run.schema.json 做“最小严格校验”：只覆盖该 schema 实际用到的关键字
//      （type/const/enum/required/properties/additionalProperties/items/minimum/maximum/
//      minLength/pattern/format/oneOf/allOf/if-then/$ref/$defs）。schema 若新增未覆盖的关键字，
//      工具以 exit 2 失败，而不是静默放宽校验。
//   2) 输入字段值原样写入输出（只统一 JSON 序列化：2 空格缩进 + 末尾换行）：
//      不补默认值、不伪造 token、不把 null 改写成 0；schema 允许的 nullable 字段保持 null。
//   3) 输出已存在时拒绝覆盖；写文件使用同目录临时文件 + rename 原子替换，失败时清理临时文件，
//      不留半成品。
//   4) 退出码：0=合法且已写入；1=数据不合法（stderr 逐条列出字段路径，且不写输出）；
//      2=参数/IO/schema 错误（含输出已存在）。
//
// 自测：--self-test 覆盖 B3-01..B3-05，全部使用系统临时目录（mkdtemp），不写仓库。
// B3-05 使用由 eval/tasks/ 与 eval/evidence/ 真实产物派生的夹具（标注“派生夹具，不是正式实验
// 记录”）；本仓库没有甲（A 侧）交付的真实 run，因此该用例只验证字段可回溯，不证明任何正式实验。
//
// 注意：本工具只把“候选记录”校验并落盘；它不产生运行、不访问宿主、不代表任何真实实验结论。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const SCRIPT_DIR = dirname(SCRIPT_PATH)
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const SCHEMA_PATH = join(SCRIPT_DIR, 'schema', 'run.schema.json')

const EXIT_OK = 0
const EXIT_INVALID = 1
const EXIT_USAGE = 2

const USAGE = `用法：
  node eval/record-run.mjs --input <candidate.json> --out <record.json>
  node eval/record-run.mjs --self-test

说明：
  --input     候选运行记录 JSON；按 eval/schema/run.schema.json 做最小严格校验。
  --out       校验通过后写入的记录文件；已存在则拒绝覆盖（exit 2）。
  --self-test 覆盖 B3-01..B3-05 的自测（mkdtemp 临时目录，不写仓库）。

退出码：
  0  合法且已写入输出
  1  数据不合法（stderr 逐条列出字段路径；不写输出）
  2  参数/IO/schema 错误（含输出已存在、父目录缺失、输入不可读）`

// ---------------------------------------------------------------------------
// 错误类型：UsageError 打印用法（参数错误）；CliError 是 IO/schema 错误；DataError 是数据错误。
// ---------------------------------------------------------------------------
class UsageError extends Error {}
class CliError extends Error {}
class DataError extends Error {}

// ---------------------------------------------------------------------------
// 最小 JSON Schema 校验器：只覆盖 eval/schema/run.schema.json 实际用到的关键字。
// ---------------------------------------------------------------------------
const SUPPORTED_KEYWORDS = new Set([
  '$schema', '$id', 'title', 'description', '$comment', '$defs', '$ref',
  'type', 'const', 'enum', 'required', 'properties', 'additionalProperties', 'items',
  'minimum', 'maximum', 'minLength', 'pattern', 'format', 'oneOf', 'allOf', 'if', 'then',
])
const SUPPORTED_FORMATS = new Set(['date-time'])

function loadSchema() {
  let text
  try {
    text = readFileSync(SCHEMA_PATH, 'utf8')
  } catch (error) {
    throw new CliError(`无法读取 schema ${SCHEMA_PATH}：${error instanceof Error ? error.message : String(error)}`)
  }
  let schema
  try {
    schema = JSON.parse(text)
  } catch (error) {
    throw new CliError(`schema 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  assertSchemaSupported(schema, '$')
  return schema
}

function assertSchemaSupported(schema, where) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new CliError(`schema 节点必须是对象（${where}）`)
  }
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new CliError(`schema 使用了本工具未覆盖的关键字 "${keyword}"（${where}）；请同步扩展 eval/record-run.mjs 的校验器`)
    }
  }
  if (schema.format !== undefined && !SUPPORTED_FORMATS.has(schema.format)) {
    throw new CliError(`schema 使用了本工具未覆盖的 format "${schema.format}"（${where}）`)
  }
  const children = []
  if (schema.properties !== undefined) {
    for (const [name, child] of Object.entries(schema.properties)) children.push([child, `${where}.properties.${name}`])
  }
  if (schema.$defs !== undefined) {
    for (const [name, child] of Object.entries(schema.$defs)) children.push([child, `${where}.$defs.${name}`])
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties === 'object') {
    children.push([schema.additionalProperties, `${where}.additionalProperties`])
  }
  if (schema.items !== undefined) children.push([schema.items, `${where}.items`])
  for (const keyword of ['oneOf', 'allOf']) {
    if (schema[keyword] === undefined) continue
    if (!Array.isArray(schema[keyword])) throw new CliError(`schema 的 ${keyword} 必须是数组（${where}）`)
    schema[keyword].forEach((child, index) => children.push([child, `${where}.${keyword}[${index}]`]))
  }
  for (const keyword of ['if', 'then']) {
    if (schema[keyword] !== undefined) children.push([schema[keyword], `${where}.${keyword}`])
  }
  for (const [child, childPath] of children) assertSchemaSupported(child, childPath)
}

function resolveRef(reference, rootSchema) {
  if (typeof reference !== 'string' || !reference.startsWith('#/')) {
    throw new CliError(`不支持非本地 $ref：${String(reference)}`)
  }
  let node = rootSchema
  for (const rawPart of reference.slice(2).split('/')) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~')
    if (node === null || typeof node !== 'object') throw new CliError(`无法解析 $ref：${reference}`)
    node = node[part]
    if (node === undefined) throw new CliError(`无法解析 $ref：${reference}`)
  }
  return node
}

function displayPath(path) {
  return path === '' ? '$' : path
}

function childPath(path, key) {
  return path === '' ? key : `${path}.${key}`
}

function describeType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function acceptsType(value, type) {
  switch (type) {
    case 'null': return value === null
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    default: throw new CliError(`schema 使用了本工具未覆盖的 type：${type}`)
  }
}

function sameValue(left, right) {
  return Object.is(left, right)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/

function isIsoDateTime(text) {
  const match = ISO_DATE_TIME.exec(text)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offset = match[7]
  if (month < 1 || month > 12) return false
  if (hour > 23 || minute > 59 || second > 59) return false
  if (offset !== 'Z') {
    const offsetHour = Number(offset.slice(1, 3))
    const offsetMinute = Number(offset.slice(4, 6))
    if (offsetHour > 23 || offsetMinute > 59) return false
  }
  // Date.UTC(year, month, 0) 返回 month 月的最后一天（month 为 1-based，故用 Date.UTC(year, month, 0)）。
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (day < 1 || day > daysInMonth) return false
  return !Number.isNaN(Date.parse(text))
}

function validateValue(value, schema, path, rootSchema, errors) {
  if (schema === undefined || schema === true || schema === null) return
  if (schema === false) {
    errors.push({ path: displayPath(path), message: '不允许出现该字段' })
    return
  }
  if (schema.$ref !== undefined) {
    validateValue(value, resolveRef(schema.$ref, rootSchema), path, rootSchema, errors)
    return
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some(type => acceptsType(value, type))) {
      errors.push({
        path: displayPath(path),
        message: `类型必须是 ${types.join(' | ')}，实际为 ${describeType(value)}`,
      })
      return
    }
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !sameValue(value, schema.const)) {
    errors.push({ path: displayPath(path), message: `必须是常量 ${JSON.stringify(schema.const)}，实际为 ${JSON.stringify(value)}` })
    return
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(item => sameValue(value, item))) {
    errors.push({
      path: displayPath(path),
      message: `必须是枚举之一 ${schema.enum.map(item => JSON.stringify(item)).join(' | ')}，实际为 ${JSON.stringify(value)}`,
    })
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push({ path: displayPath(path), message: `不能小于 ${schema.minimum}，实际为 ${value}` })
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push({ path: displayPath(path), message: `不能大于 ${schema.maximum}，实际为 ${value}` })
    }
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push({ path: displayPath(path), message: `长度不能小于 ${schema.minLength}，实际为 ${value.length}` })
    }
    if (typeof schema.pattern === 'string') {
      const pattern = new RegExp(schema.pattern)
      if (!pattern.test(value)) {
        errors.push({ path: displayPath(path), message: `不匹配正则 ${schema.pattern}（实际为 ${JSON.stringify(value)}）` })
      }
    }
    if (schema.format === 'date-time' && !isIsoDateTime(value)) {
      errors.push({ path: displayPath(path), message: `不是符合 RFC 3339 的 date-time（需带时区，实际为 ${JSON.stringify(value)}）` })
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => validateValue(item, schema.items, `${path}[${index}]`, rootSchema, errors))
  }
  if (isPlainObject(value)) validateObjectFields(value, schema, path, rootSchema, errors)
  if (Array.isArray(schema.oneOf)) validateOneOf(value, schema, path, rootSchema, errors)
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) validateValue(value, branch, path, rootSchema, errors)
  }
  if (schema.if !== undefined) {
    const conditionErrors = []
    validateValue(value, schema.if, path, rootSchema, conditionErrors)
    if (conditionErrors.length === 0) {
      if (schema.then !== undefined) validateValue(value, schema.then, path, rootSchema, errors)
    }
  }
}

function validateObjectFields(value, schema, path, rootSchema, errors) {
  if (Array.isArray(schema.required)) {
    for (const name of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) {
        errors.push({ path: childPath(path, name), message: '缺少必填字段' })
      }
    }
  }
  const properties = schema.properties ?? {}
  for (const [name, child] of Object.entries(properties)) {
    if (Object.prototype.hasOwnProperty.call(value, name)) {
      validateValue(value[name], child, childPath(path, name), rootSchema, errors)
    }
  }
  if (schema.additionalProperties === undefined || schema.additionalProperties === true) return
  for (const key of Object.keys(value)) {
    if (Object.prototype.hasOwnProperty.call(properties, key)) continue
    const keyPath = childPath(path, key)
    if (schema.additionalProperties === false) {
      errors.push({ path: keyPath, message: '不允许的字段（additionalProperties=false）' })
    } else {
      validateValue(value[key], schema.additionalProperties, keyPath, rootSchema, errors)
    }
  }
}

function validateOneOf(value, schema, path, rootSchema, errors) {
  const branchErrors = schema.oneOf.map(branch => {
    const collected = []
    validateValue(value, branch, path, rootSchema, collected)
    return collected
  })
  const matched = branchErrors.filter(collected => collected.length === 0).length
  if (matched === 1) return
  if (matched === 0) {
    const details = branchErrors
      .map((collected, index) => `分支${index + 1}: ${collected[0]?.message ?? '不匹配'}`)
      .join('；')
    errors.push({ path: displayPath(path), message: `不满足 oneOf 任一分支（${details}）` })
    return
  }
  errors.push({ path: displayPath(path), message: '同时满足多个 oneOf 分支（oneOf 要求恰好一个）' })
}

/**
 * S05：schema 无法表达的确定性算术/口径约束。
 * total 是主口径合计（input+output+cacheRead+cacheWrite 去重后的合计），至少必须
 * >= output；当 input/output/total 三者都已知时，total >= input+output（去重不会减少
 * 已计入的 input/output）。矛盾即数据非法，不自行编造合计。
 */
function validateRecordSemantics(data) {
  const errors = []
  if (!isPlainObject(data) || !isPlainObject(data.tokens)) return errors
  const tokens = data.tokens
  const total = tokens.total
  const input = tokens.input
  const output = tokens.output
  const known = value => typeof value === 'number' && Number.isInteger(value) && value >= 0
  if (known(total) && known(output) && total < output) {
    errors.push({ path: 'tokens.total', message: `total(${total}) 不能小于 output(${output})（主口径合计不可能小于分量）` })
  }
  if (known(total) && known(input) && known(output) && total < input + output) {
    errors.push({ path: 'tokens.total', message: `total(${total}) 不能小于 input+output(${input + output})（去重关系矛盾）` })
  }
  return errors
}

/**
 * 校验候选记录；返回 [{ path, message }]（空数组表示合法）。
 */
function validateRecord(data, schema) {
  const errors = []
  validateValue(data, schema, '', schema, errors)
  errors.push(...validateRecordSemantics(data))
  return errors
}

// ---------------------------------------------------------------------------
// CLI：参数解析、输入读取、原子写。
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const options = { input: null, out: null, selfTest: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--self-test') { options.selfTest = true; continue }
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (arg !== '--input' && arg !== '--out') throw new UsageError(`未知参数：${arg}`)
    const value = argv[index + 1]
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new UsageError(`缺少 ${arg} 的值`)
    }
    index += 1
    if (arg === '--input') options.input = value
    else options.out = value
  }
  if (options.selfTest || options.help) return options
  if (options.input === null || options.out === null) throw new UsageError('必须同时提供 --input 与 --out')
  return options
}

function readJsonFile(filePath, flagName) {
  let stats
  try {
    stats = statSync(filePath)
  } catch (error) {
    throw new CliError(`无法读取 ${flagName} 文件 ${filePath}：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!stats.isFile()) throw new CliError(`${flagName} 不是普通文件：${filePath}`)
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new CliError(`无法读取 ${flagName} 文件 ${filePath}：${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new DataError(`输入不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
}

function assertWritableTarget(outPath) {
  if (existsSync(outPath)) {
    throw new CliError(`输出已存在，拒绝覆盖：${outPath}`)
  }
  const directory = dirname(resolve(outPath))
  let stats
  try {
    stats = statSync(directory)
  } catch (error) {
    throw new CliError(`输出父目录不可用 ${directory}：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!stats.isDirectory()) throw new CliError(`输出父路径不是目录：${directory}`)
}

/**
 * 同目录临时文件 + fsync + rename 原子替换；任何失败都清理临时文件，避免留下半成品。
 * 调用前已由 assertWritableTarget 确认输出不存在。
 */
function writeAtomic(outPath, content) {
  const directory = dirname(resolve(outPath))
  const temporaryPath = join(directory, `.${basename(outPath)}.${process.pid}.${createHash('sha256').update(`${Math.random()}`).digest('hex').slice(0, 12)}.tmp`)
  let descriptor = null
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600)
    writeFileSync(descriptor, content)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    renameSync(temporaryPath, outPath)
  } catch (error) {
    if (descriptor !== null) {
      try { closeSync(descriptor) } catch { /* ignore */ }
    }
    try { unlinkSync(temporaryPath) } catch { /* ignore */ }
    throw error
  }
}

function reportDataErrors(errors, outPath) {
  console.error(`[record-run] 数据不合法（${errors.length} 项），未写入输出：${outPath}`)
  for (const error of errors) console.error(`  - ${error.path}: ${error.message}`)
}

function runCliMain(options) {
  const schema = loadSchema()
  let data
  try {
    data = readJsonFile(options.input, '--input')
  } catch (error) {
    if (error instanceof DataError) {
      reportDataErrors([{ path: '$', message: error.message }], options.out)
      return EXIT_INVALID
    }
    throw error
  }
  const errors = validateRecord(data, schema)
  if (errors.length > 0) {
    reportDataErrors(errors, options.out)
    return EXIT_INVALID
  }
  assertWritableTarget(options.out)
  try {
    writeAtomic(options.out, `${JSON.stringify(data, null, 2)}\n`)
  } catch (error) {
    throw new CliError(`写入输出失败（已清理临时文件）：${error instanceof Error ? error.message : String(error)}`)
  }
  const fields = isPlainObject(data) ? Object.keys(data).length : 0
  console.log(`[record-run] OK 已写入 ${options.out}（schema=eval/schema/run.schema.json，顶层字段 ${fields} 个）`)
  return EXIT_OK
}

// ---------------------------------------------------------------------------
// 自测（B3-01..B3-05）：全部在 mkdtemp 临时目录执行，不写仓库。
// ---------------------------------------------------------------------------
function baseRecord() {
  return {
    schemaVersion: 1,
    runId: 'pilot-01-run-000001',
    batch: 'pilot-01',
    taskId: 'example-synthetic-add',
    category: 'defect-fix',
    repo: 'synthetic/example',
    base: '0'.repeat(40),
    head: '1'.repeat(40),
    arm: 'native',
    executionMode: 'normal',
    repetition: 1,
    seed: 20261107,
    startedAt: '2026-11-07T09:00:00Z',
    endedAt: '2026-11-07T09:10:00Z',
    wallClockSeconds: 600,
    timeout: false,
    model: {
      id: 'deepseek-v4',
      provider: 'deepseek',
      parameters: { temperature: 'uncontrolled', topP: 0.9 },
      parametersSource: 'host-config',
    },
    host: { version: '0.1.0-experimental', versionSource: 'experimental', instance: 'http://127.0.0.1:57007' },
    plugin: {
      candidateSha: '2'.repeat(40),
      baselineSha: '3'.repeat(40),
      loadedSha: null,
      loadedShaReadback: 'unverified',
    },
    taskCard: {
      sha256: '4'.repeat(64),
      deliveryMechanism: 'issue-body',
      verifiedEqual: true,
      sourcePath: 'eval/tasks/example/issue.md',
    },
    tokens: { input: 1000, output: 200, total: 1200, cacheRead: 300 },
    decisionLog: { path: 'eval/evidence/checklist3/check-task-selftest.log', sha256: null, entries: 12 },
    objectiveChanged: 'unchanged',
    requiredFunctionImplemented: 'complete',
    implementationDefect: { verdict: 'none', notes: null },
    validationEnvironment: { status: 'available', reason: null },
    delivery: 'ready-pr-created',
    outOfScopeChanges: { has: false, files: [] },
    unrelatedChanges: { has: false, notes: null },
    testWeakening: { has: false, notes: null, evidence: [] },
    humanIntervention: { count: 0, reasons: [] },
    faults: { unexpectedDeliveryReleased: false, unsafeRecovery: false, notes: null },
    label: { batchId: 'pilot-01', labelers: ['rater-a', 'rater-b'], kappa: 0.71 },
    notes: '自测合成夹具，不是正式实验记录。',
  }
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== typeof right) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((item, index) => deepEqual(item, right[index]))
  }
  if (typeof left === 'object') {
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    if (leftKeys.length !== rightKeys.length) return false
    if (!leftKeys.every((key, index) => key === rightKeys[index])) return false
    return leftKeys.every(key => deepEqual(left[key], right[key]))
  }
  return false
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function truncate(text, limit = 400) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean
}

function slug(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function selfTest() {
  const assertions = []
  const add = (name, ok, detail = '') => {
    assertions.push({ name, ok: Boolean(ok), detail })
    return Boolean(ok)
  }
  const root = mkdtempSync(join(tmpdir(), 'b3-record-self-'))
  try {
    selfTestB301(root, add)
    selfTestB302(root, add)
    selfTestB303(root, add)
    selfTestB304(root, add)
    selfTestB305(root, add)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  for (const assertion of assertions) {
    if (assertion.ok) {
      console.log(`PASS ${assertion.name}`)
    } else {
      console.log(`FAIL ${assertion.name}${assertion.detail ? ` :: ${assertion.detail}` : ''}`)
    }
  }
  const failed = assertions.filter(assertion => !assertion.ok).length
  if (failed > 0) {
    console.log(`\nSELF-TEST: FAIL（${failed}/${assertions.length} 条断言失败）`)
    return EXIT_INVALID
  }
  console.log(`\nSELF-TEST: PASS（${assertions.length} 条断言；B3-05 为派生夹具/未验证，不是正式实验记录）`)
  return EXIT_OK
}

function caseDir(root, name) {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  return directory
}

function writeJsonFile(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function readJsonFileForTest(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function listDirectory(directory) {
  return readdirSync(directory).sort()
}

function runCli(args) {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8', cwd: REPO_ROOT })
  return {
    status: typeof result.status === 'number' ? result.status : null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  }
}

/**
 * 构造一个“应当被拒绝”的数据用例：写入候选文件、执行 CLI，返回结果与输出路径。
 */
function rejectedCase(root, name, mutate) {
  const directory = caseDir(root, name)
  const inputPath = join(directory, 'candidate.json')
  const outPath = join(directory, 'record.json')
  const data = mutate(baseRecord())
  writeJsonFile(inputPath, data)
  const result = runCli(['--input', inputPath, '--out', outPath])
  return { directory, inputPath, outPath, data, result }
}

function assertRejected(root, add, name, mutate, expectedPath) {
  const { result, outPath } = rejectedCase(root, name, mutate)
  const okay = result.status === EXIT_INVALID && !existsSync(outPath) && result.stderr.includes(expectedPath)
  return add(
    `B3-02 ${name} → exit 1 且指出字段 ${expectedPath}、不产生输出`,
    okay,
    `status=${result.status} outExists=${existsSync(outPath)} stderr=${truncate(result.stderr)}`,
  )
}

function selfTestB301(root, add) {
  const directory = caseDir(root, 'B3-01')
  const schema = loadSchema()
  add('B3-01 前置：schema 可加载且关键字/format 全部被校验器覆盖', schema.required.length > 0)

  const input = baseRecord()
  const inputPath = join(directory, 'candidate.json')
  const outPath = join(directory, 'record.json')
  writeJsonFile(inputPath, input)
  const result = runCli(['--input', inputPath, '--out', outPath])
  add(
    'B3-01 完整合法记录 → exit 0 且写出记录',
    result.status === EXIT_OK && existsSync(outPath),
    `status=${result.status} stderr=${truncate(result.stderr)}`,
  )
  let parsed = null
  try { parsed = readJsonFileForTest(outPath) } catch { /* 保持 null */ }
  add('B3-01 输出与输入逐字段一致（不补默认值、不重写字段）', parsed !== null && deepEqual(parsed, input))
  const entries = listDirectory(directory)
  add(
    'B3-01 原子写：目录内无 tmp/半成品残留',
    parsed !== null && entries.every(name => !name.endsWith('.tmp')),
    entries.join(','),
  )
}

function selfTestB302(root, add) {
  const schema = loadSchema()
  const requiredFailures = []
  for (const field of schema.required) {
    const { result, outPath } = rejectedCase(root, `B3-02-required-${field}`, data => {
      delete data[field]
      return data
    })
    if (!(result.status === EXIT_INVALID && !existsSync(outPath) && result.stderr.includes(field))) {
      requiredFailures.push(`${field}(status=${result.status})`)
    }
  }
  add(
    `B3-02 逐项删除 required（${schema.required.length} 项）→ exit 1 且指出字段、不产生输出`,
    requiredFailures.length === 0,
    requiredFailures.join(','),
  )

  const negatives = [
    ['非法 arm', data => { data.arm = 'baseline'; return data }, 'arm'],
    ['非法 executionMode', data => { data.executionMode = 'p4'; return data }, 'executionMode'],
    ['非法 delivery', data => { data.delivery = 'merged'; return data }, 'delivery'],
    ['非法 category', data => { data.category = 'refactor'; return data }, 'category'],
    ['非法 model.parametersSource', data => { data.model.parametersSource = 'default'; return data }, 'model.parametersSource'],
    ['非法 host.versionSource', data => { data.host.versionSource = 'guess'; return data }, 'host.versionSource'],
    ['非法 plugin.loadedShaReadback', data => { data.plugin.loadedShaReadback = 'yes'; return data }, 'plugin.loadedShaReadback'],
    ['非法 taskCard.deliveryMechanism', data => { data.taskCard.deliveryMechanism = 'pr-body'; return data }, 'taskCard.deliveryMechanism'],
    ['非 40hex base（分支名）', data => { data.base = 'main'; return data }, 'base'],
    ['非 40hex head（短 SHA）', data => { data.head = 'abc1234'; return data }, 'head'],
    ['大写 40hex base', data => { data.base = 'A'.repeat(40); return data }, 'base'],
    ['plugin.candidateSha 非 40hex', data => { data.plugin.candidateSha = 'deadbeef'; return data }, 'plugin.candidateSha'],
    ['taskCard.sha256 长度错误', data => { data.taskCard.sha256 = 'a'.repeat(63); return data }, 'taskCard.sha256'],
    ['decisionLog.sha256 非 64hex', data => { data.decisionLog = { path: 'log.jsonl', sha256: 'zz' }; return data }, 'decisionLog.sha256'],
    ['负时间 wallClockSeconds', data => { data.wallClockSeconds = -0.5; return data }, 'wallClockSeconds'],
    ['负 token tokens.input', data => { data.tokens.input = -1; return data }, 'tokens.input'],
    ['负人工介入 humanIntervention.count', data => { data.humanIntervention.count = -2; return data }, 'humanIntervention.count'],
    ['非法 temperature', data => { data.model.parameters.temperature = 'fixed'; return data }, 'model.parameters.temperature'],
    ['类型错误 timeout', data => { data.timeout = 'yes'; return data }, 'timeout'],
    ['类型错误 seed', data => { data.seed = '20261107'; return data }, 'seed'],
    ['类型错误 outOfScopeChanges.has', data => { data.outOfScopeChanges.has = 'false'; return data }, 'outOfScopeChanges.has'],
    ['空 repo（minLength）', data => { data.repo = ''; return data }, 'repo'],
    ['空 model.id（minLength）', data => { data.model.id = ''; return data }, 'model.id'],
    ['未知顶层字段', data => { data.unknownTop = 1; return data }, 'unknownTop'],
    ['未知嵌套字段 model.extra', data => { data.model.extra = 'x'; return data }, 'model.extra'],
    ['额外参数 topK=high（oneOf）', data => { data.model.parameters.topK = 'high'; return data }, 'model.parameters.topK'],
    ['非法 startedAt 格式', data => { data.startedAt = '2026-11-07 09:00:00'; return data }, 'startedAt'],
    ['startedAt 不带时区', data => { data.startedAt = '2026-11-07T09:00:00'; return data }, 'startedAt'],
    ['非法 endedAt 日历（2 月 30 日）', data => { data.endedAt = '2026-02-30T00:00:00Z'; return data }, 'endedAt'],
    ['shadow 只允许 off（条件约束）', data => { data.executionMode = 'shadow'; data.arm = 'native'; return data }, 'arm'],
    ['validationEnvironment unavailable 但 reason=null（条件约束）', data => {
      data.validationEnvironment = { status: 'unavailable', reason: null }
      return data
    }, 'validationEnvironment.reason'],
    ['plugin verified 但 loadedSha=null（条件约束）', data => {
      data.plugin.loadedShaReadback = 'verified'
      data.plugin.loadedSha = null
      return data
    }, 'plugin.loadedSha'],
    ['非法 enum objectiveChanged', data => { data.objectiveChanged = 'no'; return data }, 'objectiveChanged'],
    ['非法 label.kappa 越界', data => { data.label.kappa = 1.5; return data }, 'label.kappa'],
    ['数组元素类型 label.labelers[0]', data => { data.label.labelers = [1]; return data }, 'label.labelers[0]'],
    ['faults 字段类型', data => { data.faults.unexpectedDeliveryReleased = 'no'; return data }, 'faults.unexpectedDeliveryReleased'],
    ['decisionLog 类型（字符串）', data => { data.decisionLog = 'log.jsonl'; return data }, 'decisionLog'],
    ['tokens.input 类型（字符串）', data => { data.tokens.input = '1234'; return data }, 'tokens.input'],
    ['S05 tokens.total 小于 output（算术矛盾）', data => { data.tokens = { input: 4000000, output: 4000000, total: 100, cacheRead: 0 }; return data }, 'tokens.total'],
    ['S05 tokens.total 小于 input+output', data => { data.tokens = { input: 900, output: 400, total: 1000, cacheRead: 0 }; return data }, 'tokens.total'],
    ['implementationDefect.verdict 非法 enum', data => {
      data.implementationDefect = { verdict: 'ok', notes: null }
      return data
    }, 'implementationDefect.verdict'],
    ['validationEnvironment.status 非法 enum', data => {
      data.validationEnvironment = { status: 'ok', reason: null }
      return data
    }, 'validationEnvironment.status'],
    ['顶层不是对象（array）', () => [], '$'],
    ['删除嵌套必填 model.parameters.temperature', data => {
      delete data.model.parameters.temperature
      return data
    }, 'model.parameters.temperature'],
    ['删除嵌套必填 plugin.candidateSha', data => { delete data.plugin.candidateSha; return data }, 'plugin.candidateSha'],
    ['删除嵌套必填 taskCard.sha256', data => { delete data.taskCard.sha256; return data }, 'taskCard.sha256'],
    ['删除嵌套必填 humanIntervention.reasons', data => { delete data.humanIntervention.reasons; return data }, 'humanIntervention.reasons'],
    ['删除嵌套必填 decisionLog.path', data => { delete data.decisionLog.path; return data }, 'decisionLog.path'],
    ['删除嵌套必填 outOfScopeChanges.files', data => { delete data.outOfScopeChanges.files; return data }, 'outOfScopeChanges.files'],
    ['删除嵌套必填 implementationDefect.notes', data => { delete data.implementationDefect.notes; return data }, 'implementationDefect.notes'],
    ['删除嵌套必填 host.instance', data => { delete data.host.instance; return data }, 'host.instance'],
  ]

  const negativeFailures = []
  for (const [label, mutate, expectedPath] of negatives) {
    const { result, outPath } = rejectedCase(root, `B3-02-neg-${slug(label)}`, mutate)
    const okay = result.status === EXIT_INVALID && !existsSync(outPath) && result.stderr.includes(expectedPath)
    if (!okay) negativeFailures.push(`${label}(status=${result.status} path=${expectedPath} stderr=${truncate(result.stderr, 200)})`)
  }
  add(
    `B3-02 非法枚举/非 40hex/负值/嵌套必填/条件约束/未知字段等（${negatives.length} 例）→ exit 1 且指出路径、不产生输出`,
    negativeFailures.length === 0,
    negativeFailures.join(' | '),
  )

  const malformedDirectory = caseDir(root, 'B3-02-malformed-json')
  const malformedInput = join(malformedDirectory, 'candidate.json')
  const malformedOut = join(malformedDirectory, 'record.json')
  writeFileSync(malformedInput, '{ this is not json')
  const malformedResult = runCli(['--input', malformedInput, '--out', malformedOut])
  add(
    'B3-02 输入不是合法 JSON → exit 1、不产生输出',
    malformedResult.status === EXIT_INVALID && !existsSync(malformedOut) && /JSON/.test(malformedResult.stderr),
    `status=${malformedResult.status} stderr=${truncate(malformedResult.stderr)}`,
  )
}

function selfTestB303(root, add) {
  const directory = caseDir(root, 'B3-03')
  const inputPath = join(directory, 'candidate.json')
  const outPath = join(directory, 'record.json')
  const nullable = baseRecord()
  nullable.tokens = { input: null, output: null, total: null, cacheRead: null }
  nullable.decisionLog = null
  nullable.host = { version: null, versionSource: 'unavailable', instance: null }
  nullable.model.provider = null
  nullable.plugin = { candidateSha: null, baselineSha: null, loadedSha: null, loadedShaReadback: 'unavailable' }
  nullable.objectiveChanged = null
  nullable.requiredFunctionImplemented = null
  nullable.implementationDefect = { verdict: 'unlabeled', notes: null }
  nullable.category = null
  nullable.unrelatedChanges = { has: null, notes: null }
  nullable.testWeakening = { has: null, notes: null }
  nullable.notes = null
  delete nullable.label
  delete nullable.faults
  delete nullable.tokens.cacheRead
  writeJsonFile(inputPath, nullable)
  const result = runCli(['--input', inputPath, '--out', outPath])
  let parsed = null
  try { parsed = readJsonFileForTest(outPath) } catch { /* 保持 null */ }
  add(
    'B3-03 nullable 记录合法 → exit 0 且写出',
    result.status === EXIT_OK && parsed !== null,
    `status=${result.status} stderr=${truncate(result.stderr)}`,
  )
  add(
    'B3-03 不可得 token 保持 null，不伪造 0（input/output/total 均为 null）',
    parsed !== null && parsed.tokens.input === null && parsed.tokens.output === null && parsed.tokens.total === null,
  )
  add(
    'B3-03 不补默认值：省略的可选字段（label/faults/tokens.cacheRead）不被写回',
    parsed !== null && !('label' in parsed) && !('faults' in parsed) && !('cacheRead' in parsed.tokens),
    parsed === null ? 'output 不可解析' : Object.keys(parsed).join(','),
  )
  add(
    'B3-03 未标注字段保持 null（decisionLog/category/objectiveChanged/host.version）',
    parsed !== null && parsed.decisionLog === null && parsed.category === null &&
      parsed.objectiveChanged === null && parsed.host.version === null,
  )
  add('B3-03 输出与输入逐字段一致（nullable 原样保留）', parsed !== null && deepEqual(parsed, nullable))

  const nullableNegatives = [
    ['nullableSha40 非法（plugin.candidateSha 短 SHA）', data => { data.plugin.candidateSha = 'abc'; return data }, 'plugin.candidateSha'],
    ['nullableSha40 非法（大写）', data => { data.plugin.baselineSha = 'A'.repeat(40); return data }, 'plugin.baselineSha'],
    ['nullableSha256 非法（decisionLog.sha256 短串）', data => {
      data.decisionLog = { path: 'log.jsonl', sha256: 'abc' }
      return data
    }, 'decisionLog.sha256'],
    ['nullable object 类型错误（decisionLog=字符串）', data => { data.decisionLog = 'log.jsonl'; return data }, 'decisionLog'],
    ['nullable string 类型错误（host.version=数字）', data => { data.host.version = 1; return data }, 'host.version'],
    ['nullable number 类型错误（tokens.cacheRead=字符串）', data => { data.tokens.cacheRead = '0'; return data }, 'tokens.cacheRead'],
    ['verified 必须有真实回读 SHA（loadedSha=null）', data => {
      data.plugin.loadedShaReadback = 'verified'
      data.plugin.loadedSha = null
      return data
    }, 'plugin.loadedSha'],
  ]
  const failures = []
  for (const [label, mutate, expectedPath] of nullableNegatives) {
    const { result: negativeResult, outPath: negativeOut } = rejectedCase(root, `B3-03-neg-${slug(label)}`, mutate)
    const okay = negativeResult.status === EXIT_INVALID && !existsSync(negativeOut) && negativeResult.stderr.includes(expectedPath)
    if (!okay) failures.push(`${label}(status=${negativeResult.status} path=${expectedPath})`)
  }
  add(
    `B3-03 非法 nullable（短 SHA/类型/条件约束，${nullableNegatives.length} 例）→ exit 1 且指出路径`,
    failures.length === 0,
    failures.join(' | '),
  )
}

function selfTestB304(root, add) {
  const validDirectory = caseDir(root, 'B3-04-valid-input')
  const validInput = join(validDirectory, 'candidate.json')
  writeJsonFile(validInput, baseRecord())

  // 输出已存在 → 拒绝覆盖，既有内容不变。
  const existingDirectory = caseDir(root, 'B3-04-out-exists')
  const existingOut = join(existingDirectory, 'record.json')
  const sentinel = '{"sentinel": "keep-me"}\n'
  writeFileSync(existingOut, sentinel)
  const existingResult = runCli(['--input', validInput, '--out', existingOut])
  add(
    'B3-04 输出已存在 → exit 2、拒绝覆盖且既有内容不变',
    existingResult.status === EXIT_USAGE && readFileSync(existingOut, 'utf8') === sentinel &&
      /已存在|拒绝覆盖/.test(existingResult.stderr),
    `status=${existingResult.status} stderr=${truncate(existingResult.stderr)}`,
  )

  // 输出路径是已存在目录 → 拒绝。
  const directoryOutDirectory = caseDir(root, 'B3-04-out-is-directory')
  const directoryOut = join(directoryOutDirectory, 'record-as-dir')
  mkdirSync(directoryOut)
  const directoryResult = runCli(['--input', validInput, '--out', directoryOut])
  add(
    'B3-04 输出路径是目录 → exit 2、不写文件',
    directoryResult.status === EXIT_USAGE && statSync(directoryOut).isDirectory(),
    `status=${directoryResult.status}`,
  )

  // 父目录缺失 → IO 错误，不产生目录/文件。
  const missingParentDirectory = caseDir(root, 'B3-04-parent-missing')
  const missingParent = join(missingParentDirectory, 'no-such-dir')
  const missingResult = runCli(['--input', validInput, '--out', join(missingParent, 'record.json')])
  add(
    'B3-04 输出父目录缺失 → exit 2、不创建目录、不留文件',
    missingResult.status === EXIT_USAGE && !existsSync(missingParent),
    `status=${missingResult.status} stderr=${truncate(missingResult.stderr)}`,
  )

  // 父路径是普通文件 → 写入在临时文件阶段失败，清理后目录无残留。
  const parentFileDirectory = caseDir(root, 'B3-04-parent-is-file')
  const blockerPath = join(parentFileDirectory, 'blocker.bin')
  writeFileSync(blockerPath, 'blocker\n')
  const parentFileResult = runCli(['--input', validInput, '--out', join(blockerPath, 'record.json')])
  const parentFileEntries = listDirectory(parentFileDirectory)
  add(
    'B3-04 输出父路径是文件（模拟 IO 错误）→ exit 2、清理临时文件、目录无半成品',
    parentFileResult.status === EXIT_USAGE && readFileSync(blockerPath, 'utf8') === 'blocker\n' &&
      parentFileEntries.every(name => !name.endsWith('.tmp')),
    `status=${parentFileResult.status} entries=${parentFileEntries.join(',')} stderr=${truncate(parentFileResult.stderr)}`,
  )

  // 只读目录 → 临时文件写入失败且被清理（root 下 chmod 不生效，跳过该断言）。
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    const readOnlyDirectory = caseDir(root, 'B3-04-read-only')
    const readOnlyInput = join(readOnlyDirectory, 'candidate.json')
    writeJsonFile(readOnlyInput, baseRecord())
    const readOnlyTarget = join(readOnlyDirectory, 'locked')
    mkdirSync(readOnlyTarget)
    chmodSync(readOnlyTarget, 0o500)
    let readOnlyResult
    try {
      readOnlyResult = runCli(['--input', readOnlyInput, '--out', join(readOnlyTarget, 'record.json')])
    } finally {
      chmodSync(readOnlyTarget, 0o700)
    }
    add(
      'B3-04 只读目录（模拟 IO 错误）→ exit 2、目录内无临时文件',
      readOnlyResult.status === EXIT_USAGE && listDirectory(readOnlyTarget).length === 0,
      `status=${readOnlyResult.status} entries=${listDirectory(readOnlyTarget).join(',')}`,
    )
  }

  // 参数/IO 前置错误 → exit 2。
  const usageCases = [
    ['无参数', []],
    ['只给 --input', ['--input', validInput]],
    ['未知参数', ['--input', validInput, '--out', join(validDirectory, 'x.json'), '--bogus']],
    ['--input 缺少值', ['--input']],
    ['输入文件不存在', ['--input', join(validDirectory, 'missing.json'), '--out', join(validDirectory, 'x2.json')]],
    ['输入路径是目录', ['--input', validDirectory, '--out', join(validDirectory, 'x3.json')]],
  ]
  const usageFailures = []
  for (const [label, args] of usageCases) {
    const usageResult = runCli(args)
    if (usageResult.status !== EXIT_USAGE) usageFailures.push(`${label}(status=${usageResult.status})`)
  }
  add(
    `B3-04 参数/IO 错误（${usageCases.length} 例：缺参/未知参数/输入不可读）→ exit 2`,
    usageFailures.length === 0,
    usageFailures.join(' | '),
  )
}

function selfTestB305(root, add) {
  const directory = caseDir(root, 'B3-05-derived')
  const inputPath = join(directory, 'candidate.json')
  const outPath = join(directory, 'record.json')

  // 真实产物（只读，不修改仓库）：任务卡、issue.md、既有证据日志。
  const taskDirectory = join(REPO_ROOT, 'eval', 'tasks', 'hephi', 'b5-task-key-whitelist')
  const taskJsonPath = join(taskDirectory, 'task.json')
  const issuePath = join(taskDirectory, 'issue.md')
  const evidencePath = join(REPO_ROOT, 'eval', 'evidence', 'checklist3', 'check-task-selftest.log')
  const artifacts = [taskJsonPath, issuePath, evidencePath]
  if (!artifacts.every(filePath => existsSync(filePath))) {
    add('B3-05 派生夹具前置：真实产物存在（eval/tasks + eval/evidence）', false, artifacts.filter(p => !existsSync(p)).join(','))
    return
  }
  add('B3-05 派生夹具前置：真实产物存在（eval/tasks + eval/evidence）', true)

  const task = readJsonFileForTest(taskJsonPath)
  const issueSha256 = sha256File(issuePath)
  const evidenceSha256 = sha256File(evidencePath)
  const issueMtime = statSync(issuePath).mtimeMs
  const evidenceMtime = statSync(evidencePath).mtimeMs
  const startedAt = new Date(Math.min(issueMtime, evidenceMtime)).toISOString()
  const endedAt = new Date(Math.max(issueMtime, evidenceMtime)).toISOString()
  const wallClockSeconds = Math.round(((Math.max(issueMtime, evidenceMtime) - Math.min(issueMtime, evidenceMtime)) / 1000) * 1000) / 1000
  const base = task.base
  const fixture = {
    schemaVersion: 1,
    runId: 'fixture-b3-05-derived',
    batch: 'fixture-b3-05',
    taskId: task.taskId,
    category: task.category,
    repo: task.repo,
    base,
    // 派生夹具假设：该“运行”结束时没有产生新提交，故 head=base；不是真实运行结果。
    head: base,
    arm: 'off',
    executionMode: 'normal',
    repetition: 1,
    seed: 0,
    startedAt,
    endedAt,
    wallClockSeconds,
    timeout: false,
    model: {
      id: 'fixture-model-not-recorded',
      provider: null,
      parameters: { temperature: 'uncontrolled' },
      parametersSource: 'unavailable',
    },
    host: { version: null, versionSource: 'unavailable', instance: null },
    plugin: { candidateSha: null, baselineSha: null, loadedSha: null, loadedShaReadback: 'unavailable' },
    taskCard: {
      sha256: issueSha256,
      deliveryMechanism: 'task-file',
      verifiedEqual: false,
      sourcePath: 'eval/tasks/hephi/b5-task-key-whitelist/issue.md',
    },
    tokens: { input: null, output: null, total: null },
    decisionLog: {
      path: 'eval/evidence/checklist3/check-task-selftest.log',
      sha256: evidenceSha256,
      entries: null,
    },
    objectiveChanged: null,
    requiredFunctionImplemented: null,
    implementationDefect: { verdict: 'unlabeled', notes: null },
    validationEnvironment: { status: 'unavailable', reason: '派生夹具：未执行正式实验，环境可用性未验证' },
    delivery: 'blocked',
    outOfScopeChanges: { has: false, files: [] },
    unrelatedChanges: { has: null, notes: null },
    testWeakening: { has: null, notes: null },
    humanIntervention: { count: 0, reasons: [] },
    notes: '派生夹具，不是正式实验记录：由 eval/tasks/hephi/b5-task-key-whitelist/task.json、issue.md 与 eval/evidence/checklist3/check-task-selftest.log 的真实 SHA/时间派生；未执行真实运行，也没有甲（A 侧）交付的真实 run，不得作为正式实验记录使用。',
  }
  writeJsonFile(inputPath, fixture)
  const result = runCli(['--input', inputPath, '--out', outPath])
  let parsed = null
  try { parsed = readJsonFileForTest(outPath) } catch { /* 保持 null */ }
  add(
    'B3-05 派生夹具可通过校验并写出（派生夹具/未验证，不是正式实验记录）',
    result.status === EXIT_OK && parsed !== null,
    `status=${result.status} stderr=${truncate(result.stderr)}`,
  )
  add(
    'B3-05 可回溯字段 taskCard.sha256 与真实 issue.md 重新哈希一致',
    parsed !== null && parsed.taskCard.sha256 === issueSha256 && sha256File(issuePath) === parsed.taskCard.sha256,
  )
  add(
    'B3-05 可回溯字段 decisionLog.path/sha256 与真实证据日志重新哈希一致',
    parsed !== null && parsed.decisionLog.path === 'eval/evidence/checklist3/check-task-selftest.log' &&
      parsed.decisionLog.sha256 === evidenceSha256 && sha256File(evidencePath) === parsed.decisionLog.sha256,
  )
  add(
    'B3-05 base/head 来自真实 task.json 的 40hex SHA（head=base 为夹具假设）',
    parsed !== null && parsed.base === base && parsed.head === base && /^[0-9a-f]{40}$/.test(parsed.base),
  )
  add(
    'B3-05 不可得 token 保持 null（不伪造 0）',
    parsed !== null && parsed.tokens.input === null && parsed.tokens.output === null && parsed.tokens.total === null,
  )
  add(
    'B3-05 夹具标注：notes 含“派生夹具”“不是正式实验记录”，且输出与派生输入一致',
    parsed !== null && /派生夹具/.test(parsed.notes) && /不是正式实验记录/.test(parsed.notes) && deepEqual(parsed, fixture),
  )
}

// ---------------------------------------------------------------------------
// 入口。
// ---------------------------------------------------------------------------
function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`[record-run] ${error.message}\n\n${USAGE}`)
      return EXIT_USAGE
    }
    console.error(`[record-run] ${error instanceof Error ? error.message : String(error)}`)
    return EXIT_USAGE
  }
  if (options.help) {
    console.log(USAGE)
    return EXIT_OK
  }
  if (options.selfTest) return selfTest()
  try {
    return runCliMain(options)
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`[record-run] ${error.message}`)
      return EXIT_USAGE
    }
    console.error(`[record-run] ${error instanceof Error ? error.message : String(error)}`)
    return EXIT_USAGE
  }
}

function isCliEntryPoint() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(SCRIPT_PATH)
  } catch {
    return false
  }
}

if (isCliEntryPoint()) process.exit(main(process.argv.slice(2)))
