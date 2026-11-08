#!/usr/bin/env node
// ROADMAP-95 工作线 B / B4：盲评标注读回 + 完整性校验。
//
// 用法：
//   node eval/label/import.mjs --manifest <材料目录/manifest.json> --labels <labels.json>
//                              [--mapping <私有映射.json> --normalized-out <run 级标注.json>] [--json]
//
// labels.json（两名盲评者各交一份；字段与 eval/label/RUBRIC.md 一致）：
//   {
//     "batch": "pilot-01",
//     "labeler": "rater-a",
//     "cases": {
//       "case-001": {
//         "objectiveChanged": "unchanged|partially-changed|changed-to-other",
//         "requiredFunctionImplemented": "complete|partial|not-implemented",
//         "implementationDefect": { "verdict": "none|has-defect", "notes": null|"..." },
//         "unrelatedChanges": { "has": false, "notes": null, "positions": [] },
//         "testWeakening": { "has": false, "notes": null, "positions": [] }
//       }
//     }
//   }
//
// 校验规则：
//   - batch 与 manifest 一致；labeler 非空；
//   - 每个 blindId 恰好标注一次，不得出现未知/缺失/重复 blindId（含 manifest 重复与
//     labels JSON 中的重复键——后者在解析前按原始文本检查）；
//   - 枚举值必须在 RUBRIC 规定的集合内；
//   - 判定为 has-defect / unrelatedChanges.has / testWeakening.has 时 notes 必填；
//   - has-defect 时 notes 必须写明缺陷位置（文件+行），见 RUBRIC §5；
//   - unrelatedChanges.has / testWeakening.has 为 true 时 positions 至少一条（file + 行/块定位）；
//   - 私有映射（--mapping）：mapping.batch 必须等于 labels.batch 与 manifest.batch；
//     mapping 的 case 集必须与 labels/manifest 完整一一对应（不多不少），每个 case 的 runId 非空且唯一；
//     若 mapping 带 caseCount/manifestSha256（新导出会写），必须与本次 manifest 一致。
//     不一致一律 exit 1，不得只按可重复的 case-001 编号取映射。
//
// 退出码：0=完整；1=不完整/非法；2=用法或环境缺失。
// 本脚本不接触 git，不读材料内容，只校验标注 JSON 与清单。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const OBJECTIVE_VALUES = new Set(['unchanged', 'partially-changed', 'changed-to-other'])
const FUNCTION_VALUES = new Set(['complete', 'partial', 'not-implemented'])
const DEFECT_VALUES = new Set(['none', 'has-defect'])

// RUBRIC §5：has-defect 时 notes 必须写明缺陷位置（文件+行）与触发条件。
// 位置判定接受常见写法：`src/calc.mjs:12`、`src/calc.mjs 第 12 行`、`第 12 行`、`L12`。
const DEFECT_LOCATION_RE = /(?:[\w./\\-]+\.[A-Za-z0-9_]+(?::\d+|#L\d+))|(?::\d+\b)|(?:第\s*\d+\s*行)|(?:\bL\d+\b)/

function hasDefectLocation(notes) {
  return typeof notes === 'string' && DEFECT_LOCATION_RE.test(notes)
}

// labels JSON 中重复键（`"case-001"` 出现两次）会被 JSON.parse 静默去重，
// 必须在原始文本上检查；只检查 manifest 已知的 blindId，避免误伤嵌套键。
function duplicateCaseKeys(rawText, manifestIds) {
  if (typeof rawText !== 'string') return []
  const duplicates = []
  for (const blindId of new Set(manifestIds)) {
    const escaped = blindId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const occurrences = (rawText.match(new RegExp(`"${escaped}"\\s*:`, 'g')) ?? []).length
    if (occurrences > 1) duplicates.push(blindId)
  }
  return duplicates
}

const USAGE = `用法：
  node eval/label/import.mjs --manifest <材料目录/manifest.json> --labels <labels.json> [--mapping <映射.json> --normalized-out <输出.json>] [--json]
退出码：0=完整；1=不完整/非法；2=用法或环境缺失。`

function usage(message) {
  console.error(`[label-import] ${message}\n\n${USAGE}`)
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

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function checkPositions(positions) {
  if (!Array.isArray(positions) || positions.length === 0) return 'positions 至少需要一条定位'
  for (const position of positions) {
    if (!isObject(position)) return 'positions 的每一项必须是对象'
    if (!nonEmptyString(position.file)) return 'positions[].file 必须是非空字符串'
    if (position.line !== undefined && (!Number.isInteger(position.line) || position.line < 1)) {
      return 'positions[].line 必须是正整数（可选）'
    }
    if (position.hunk !== undefined && !nonEmptyString(position.hunk)) return 'positions[].hunk 必须是非空字符串（可选）'
  }
  return null
}

export function validateLabels(manifest, labels, rawLabelsText = null) {
  const errors = []
  const manifestIds = manifest.cases.map((item) => item.blindId)
  const seen = new Set()

  if (!isObject(labels)) return { ok: false, errors: ['labels 不是对象'] }
  if (labels.batch !== manifest.batch) errors.push(`batch 不一致：labels=${labels.batch ?? '(缺失)'} manifest=${manifest.batch}`)
  if (!nonEmptyString(labels.labeler)) errors.push('labeler 必须是非空字符串（用于 kappa/裁决追溯）')
  if (!isObject(labels.cases)) return { ok: false, errors: [...errors, 'cases 不是对象'] }

  const duplicateManifestIds = [...new Set(manifestIds.filter((blindId, index) => manifestIds.indexOf(blindId) !== index))]
  if (duplicateManifestIds.length > 0) errors.push(`manifest 中 blindId 重复：${duplicateManifestIds.join(', ')}`)
  const duplicateLabelsKeys = duplicateCaseKeys(rawLabelsText, manifestIds)
  if (duplicateLabelsKeys.length > 0) errors.push(`labels 中 blindId 重复键：${duplicateLabelsKeys.join(', ')}（每个 case 只能标注一次）`)

  for (const blindId of Object.keys(labels.cases)) {
    if (!manifestIds.includes(blindId)) errors.push(`未知 blindId：${blindId}（不在 manifest 中）`)
  }

  for (const blindId of manifestIds) {
    const item = labels.cases[blindId]
    if (item === undefined) {
      errors.push(`缺少标注：${blindId}`)
      continue
    }
    seen.add(blindId)
    if (!isObject(item)) {
      errors.push(`${blindId} 的标注不是对象`)
      continue
    }
    if (!OBJECTIVE_VALUES.has(item.objectiveChanged)) {
      errors.push(`${blindId}.objectiveChanged 必须是 ${[...OBJECTIVE_VALUES].join('/')}`)
    }
    if (!FUNCTION_VALUES.has(item.requiredFunctionImplemented)) {
      errors.push(`${blindId}.requiredFunctionImplemented 必须是 ${[...FUNCTION_VALUES].join('/')}`)
    }
    const defect = item.implementationDefect
    if (!isObject(defect) || !DEFECT_VALUES.has(defect.verdict)) {
      errors.push(`${blindId}.implementationDefect.verdict 必须是 ${[...DEFECT_VALUES].join('/')}`)
    } else if (defect.verdict === 'has-defect' && !nonEmptyString(defect.notes)) {
      errors.push(`${blindId}.implementationDefect.notes 在 has-defect 时必填`)
    } else if (defect.verdict === 'has-defect' && !hasDefectLocation(defect.notes)) {
      errors.push(`${blindId}.implementationDefect.notes 在 has-defect 时必须写明缺陷位置（文件+行），见 RUBRIC §5`)
    }
    const unrelated = item.unrelatedChanges
    if (!isObject(unrelated) || typeof unrelated.has !== 'boolean') {
      errors.push(`${blindId}.unrelatedChanges.has 必须是 boolean`)
    } else {
      if (unrelated.has === true) {
        if (!nonEmptyString(unrelated.notes)) errors.push(`${blindId}.unrelatedChanges.notes 在 has=true 时必填`)
        const positionError = checkPositions(unrelated.positions)
        if (positionError) errors.push(`${blindId}.unrelatedChanges.${positionError}`)
      }
    }
    const weakening = item.testWeakening
    if (!isObject(weakening) || typeof weakening.has !== 'boolean') {
      errors.push(`${blindId}.testWeakening.has 必须是 boolean`)
    } else {
      if (weakening.has === true) {
        if (!nonEmptyString(weakening.notes)) errors.push(`${blindId}.testWeakening.notes 在 has=true 时必填`)
        const positionError = checkPositions(weakening.positions)
        if (positionError) errors.push(`${blindId}.testWeakening.${positionError}`)
      }
    }
  }

  const summary = {
    expected: manifestIds.length,
    labeled: seen.size,
    missing: manifestIds.filter((blindId) => !seen.has(blindId)),
    complete: errors.length === 0,
  }
  return { ok: errors.length === 0, errors, summary }
}

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex')
}

// F05：默认只校验 labels/manifest 的批次，normalize 又按可重复的 case-001 编号取映射，
// 另一批次的 mapping 会被接受并污染分组。这里把 mapping 的身份作为一等校验：
//   - mapping.batch 必须等于 manifest.batch（labels 批次已由 validateLabels 校验，这里再防御）；
//   - mapping.mapping 的 case 集必须与 labels.cases / manifest.cases 完整一一对应（不多不少）；
//   - 每条映射的 runId 必须是非空、唯一（一一对应；不允许两个 case 指向同一 run）；
//   - 若 mapping 带导出清单身份（caseCount / manifestSha256），必须与本次 manifest 一致，
//     避免同批多次导出时只凭重复的 case 编号错配。
function normalize(manifest, labels, mapping, manifestRawText) {
  if (!isObject(mapping)) throw new Error('mapping 必须是对象')
  const problems = []
  const manifestIds = manifest.cases.map((item) => item.blindId)
  if (labels.batch !== manifest.batch) problems.push(`labels.batch 不一致：labels=${labels.batch ?? '(缺失)'} manifest=${manifest.batch}`)
  if (mapping.batch !== manifest.batch) problems.push(`mapping.batch 不一致：mapping=${mapping.batch ?? '(缺失)'} manifest=${manifest.batch}（跨批次映射会错绑任务，已拒绝）`)
  if (!isObject(mapping.mapping)) problems.push('mapping.mapping 必须是对象')

  const mappingCases = isObject(mapping.mapping) ? mapping.mapping : {}
  const labelIds = Object.keys(labels.cases ?? {})
  const mappingIds = Object.keys(mappingCases)
  for (const blindId of mappingIds) {
    if (!manifestIds.includes(blindId)) problems.push(`mapping 含未知 blindId：${blindId}（不在 manifest 中）`)
  }
  for (const blindId of manifestIds) {
    if (!Object.hasOwn(mappingCases, blindId)) problems.push(`mapping 缺少 ${blindId}`)
    if (!labelIds.includes(blindId)) problems.push(`labels 缺少 ${blindId}`)
  }
  for (const blindId of labelIds) {
    if (!manifestIds.includes(blindId)) problems.push(`labels 含未知 blindId：${blindId}`)
  }

  const runIdOwner = new Map()
  for (const blindId of manifestIds) {
    const mapped = Object.hasOwn(mappingCases, blindId) ? mappingCases[blindId] : undefined
    if (mapped === undefined) continue
    if (!isObject(mapped)) {
      problems.push(`mapping.${blindId} 必须是对象`)
      continue
    }
    if (!nonEmptyString(mapped.runId)) {
      problems.push(`mapping.${blindId}.runId 必须是非空字符串（不能只靠可重复的 ${blindId} 编号）`)
    } else if (runIdOwner.has(mapped.runId)) {
      problems.push(`mapping 的 runId 重复：${mapped.runId}（${runIdOwner.get(mapped.runId)} 与 ${blindId} 不能指向同一 run）`)
    } else {
      runIdOwner.set(mapped.runId, blindId)
    }
    if (!nonEmptyString(mapped.taskId)) problems.push(`mapping.${blindId}.taskId 必须是非空字符串`)
    if (!nonEmptyString(mapped.arm)) problems.push(`mapping.${blindId}.arm 必须是非空字符串`)
    if (mapped.repetition !== undefined && (!Number.isInteger(mapped.repetition) || mapped.repetition < 1)) {
      problems.push(`mapping.${blindId}.repetition 必须是正整数（可选）`)
    }
  }

  // 可选导出清单身份：新导出会写 caseCount + manifestSha256；旧 mapping 没有这两个字段时不强行失败，
  // 但一旦提供就必须与本次 manifest 完全一致。
  if (mapping.caseCount !== undefined && mapping.caseCount !== manifestIds.length) {
    problems.push(`mapping.caseCount 与 manifest 不一致：mapping=${mapping.caseCount} manifest=${manifestIds.length}`)
  }
  if (mapping.manifestSha256 !== undefined) {
    const actual = sha256Text(manifestRawText ?? '')
    if (mapping.manifestSha256 !== actual) problems.push(`mapping.manifestSha256 与本次 manifest 不一致：mapping=${mapping.manifestSha256} actual=${actual}`)
  }

  if (problems.length > 0) throw new Error(`映射校验失败：${problems.join('; ')}`)

  const normalized = { batch: manifest.batch, labeler: labels.labeler, runs: [] }
  for (const item of manifest.cases) {
    const mapped = mappingCases[item.blindId]
    const label = labels.cases[item.blindId]
    normalized.runs.push({
      runId: mapped.runId,
      taskId: mapped.taskId,
      arm: mapped.arm,
      repetition: mapped.repetition ?? 1,
      blindId: item.blindId,
      label: {
        objectiveChanged: label.objectiveChanged,
        requiredFunctionImplemented: label.requiredFunctionImplemented,
        implementationDefect: label.implementationDefect,
        unrelatedChanges: label.unrelatedChanges,
        testWeakening: label.testWeakening,
      },
    })
  }
  return normalized
}

function selfTest(asJson) {
  const steps = []
  const record = (name, ok, detail) => steps.push({ name, ok, detail })
  const script = fileURLToPath(import.meta.url)
  const cli = (args) => {
    try {
      const stdout = execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: 'pipe' })
      return { status: 0, stdout }
    } catch (error) {
      return { status: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
    }
  }
  const manifest = {
    schemaVersion: 1,
    batch: 'selftest-b4',
    cases: [{ blindId: 'case-001' }, { blindId: 'case-002' }],
  }
  const goodCase = {
    objectiveChanged: 'unchanged',
    requiredFunctionImplemented: 'complete',
    implementationDefect: { verdict: 'none', notes: null },
    unrelatedChanges: { has: false, notes: null, positions: [] },
    testWeakening: { has: false, notes: null, positions: [] },
  }
  const good = {
    batch: 'selftest-b4',
    labeler: 'rater-a',
    cases: {
      'case-001': goodCase,
      'case-002': { ...goodCase, unrelatedChanges: { has: true, notes: '重排了无关 import', positions: [{ file: 'src/a.mjs', line: 3 }] } },
    },
  }

  const dir = mkdtempSync(resolve(tmpdir(), 'hephi-b4-import-'))
  try {
    const write = (name, value) => {
      const file = resolve(dir, name)
      writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      return file
    }
    const manifestFile = write('manifest.json', manifest)
    const goodFile = write('good.json', good)
    const goodRun = cli(['--manifest', manifestFile, '--labels', goodFile, '--json'])
    record('完整标注 → exit 0', goodRun.status === 0, `exit=${goodRun.status}`)

    const missing = JSON.parse(JSON.stringify(good))
    delete missing.cases['case-002']
    const missingRun = cli(['--manifest', manifestFile, '--labels', write('missing.json', missing), '--json'])
    record('负例：缺 case → exit 1 且列出 missing', missingRun.status === 1 && missingRun.stdout.includes('缺少标注'), `exit=${missingRun.status}`)

    const badField = JSON.parse(JSON.stringify(good))
    badField.cases['case-001'].objectiveChanged = 'mostly-fine'
    const badFieldRun = cli(['--manifest', manifestFile, '--labels', write('bad-field.json', badField), '--json'])
    record('负例：非法枚举 → exit 1', badFieldRun.status === 1, `exit=${badFieldRun.status}`)

    const badNotes = JSON.parse(JSON.stringify(good))
    badNotes.cases['case-001'].testWeakening = { has: true, notes: null, positions: [] }
    const badNotesRun = cli(['--manifest', manifestFile, '--labels', write('bad-notes.json', badNotes), '--json'])
    record('负例：has=true 但缺 notes/positions → exit 1', badNotesRun.status === 1, `exit=${badNotesRun.status}`)

    // B4-02：未知 case、重复 case、缺陷无位置、缺陷有位置。
    const clone = (value) => JSON.parse(JSON.stringify(value))
    const unknownCase = clone(good)
    unknownCase.cases['case-999'] = clone(goodCase)
    const unknownCaseRun = cli(['--manifest', manifestFile, '--labels', write('unknown-case.json', unknownCase), '--json'])
    record('B4-02 负例：未知 case → exit 1 且列出未知 blindId', unknownCaseRun.status === 1 && unknownCaseRun.stdout.includes('未知 blindId'), `exit=${unknownCaseRun.status}`)

    const duplicateRaw = `{"batch":"selftest-b4","labeler":"rater-a","cases":{"case-001":${JSON.stringify(goodCase)},"case-001":${JSON.stringify(goodCase)},"case-002":${JSON.stringify(goodCase)}}}`
    const duplicateKeyFile = resolve(dir, 'duplicate-key.json')
    writeFileSync(duplicateKeyFile, duplicateRaw, 'utf8')
    const duplicateKeyRun = cli(['--manifest', manifestFile, '--labels', duplicateKeyFile, '--json'])
    record('B4-02 负例：labels 中 blindId 重复键 → exit 1', duplicateKeyRun.status === 1 && duplicateKeyRun.stdout.includes('重复'), `exit=${duplicateKeyRun.status}`)

    const duplicateManifest = { schemaVersion: 1, batch: 'selftest-b4', cases: [{ blindId: 'case-001' }, { blindId: 'case-001' }] }
    const duplicateManifestFile = write('manifest-duplicate.json', duplicateManifest)
    const duplicateManifestRun = cli(['--manifest', duplicateManifestFile, '--labels', goodFile, '--json'])
    record('B4-02 负例：manifest blindId 重复 → exit 1', duplicateManifestRun.status === 1 && duplicateManifestRun.stdout.includes('manifest 中 blindId 重复'), `exit=${duplicateManifestRun.status}`)

    const defectNoLocation = clone(good)
    defectNoLocation.cases['case-001'].implementationDefect = { verdict: 'has-defect', notes: '空指针崩溃' }
    const defectNoLocationRun = cli(['--manifest', manifestFile, '--labels', write('defect-no-location.json', defectNoLocation), '--json'])
    record('B4-02 负例：has-defect 但 notes 无位置 → exit 1', defectNoLocationRun.status === 1 && defectNoLocationRun.stdout.includes('缺陷位置'), `exit=${defectNoLocationRun.status}`)

    const defectWithLocation = clone(good)
    defectWithLocation.cases['case-001'].implementationDefect = { verdict: 'has-defect', notes: 'src/calc.mjs:12 当 b=0 时除以 0' }
    const defectWithLocationRun = cli(['--manifest', manifestFile, '--labels', write('defect-with-location.json', defectWithLocation), '--json'])
    record('B4-02 正例：has-defect 且 notes 含文件+行 → exit 0', defectWithLocationRun.status === 0, `exit=${defectWithLocationRun.status} ${defectWithLocationRun.stderr?.slice(0, 200) ?? ''}`)

    const mapping = {
      schemaVersion: 1,
      batch: 'selftest-b4',
      mapping: {
        'case-001': { runId: 'selftest-t1-off', taskId: 't1', arm: 'off', repetition: 1 },
        'case-002': { runId: 'selftest-t1-native', taskId: 't1', arm: 'native', repetition: 1 },
      },
    }
    const mappingFile = write('mapping.json', mapping)
    const normalizedFile = resolve(dir, 'normalized.json')
    const normalizedRun = cli(['--manifest', manifestFile, '--labels', goodFile, '--mapping', mappingFile, '--normalized-out', normalizedFile, '--json'])
    const normalized = existsSync(normalizedFile) ? readJSON(normalizedFile) : null
    record('带私有映射 → 还原为 run 级标注', normalizedRun.status === 0 && normalized?.runs?.length === 2 && normalized.runs.some((run) => run.arm === 'native'), `exit=${normalizedRun.status}`)

    // F05：私有映射必须带正确的批次/完整 case 集/一一对应 runId；跨批次或错配必须拒绝。
    const cloneMapping = () => JSON.parse(JSON.stringify(mapping))
    const wrongBatchMapping = cloneMapping()
    wrongBatchMapping.batch = 'selftest-b4-other'
    const wrongBatchRun = cli(['--manifest', manifestFile, '--labels', goodFile, '--mapping', write('mapping-wrong-batch.json', wrongBatchMapping), '--json'])
    record('F05 负例：mapping.batch 与 labels/manifest 不一致 → exit 1', wrongBatchRun.status === 1 && wrongBatchRun.stdout.includes('mapping.batch'), `exit=${wrongBatchRun.status}`)

    const extraCaseMapping = cloneMapping()
    extraCaseMapping.mapping['case-999'] = { runId: 'selftest-t9-off', taskId: 't9', arm: 'off' }
    const extraCaseRun = cli(['--manifest', manifestFile, '--labels', goodFile, '--mapping', write('mapping-extra-case.json', extraCaseMapping), '--json'])
    record('F05 负例：mapping 含多余 case → exit 1', extraCaseRun.status === 1 && extraCaseRun.stdout.includes('未知 blindId'), `exit=${extraCaseRun.status}`)

    const missingCaseMapping = cloneMapping()
    delete missingCaseMapping.mapping['case-002']
    const missingCaseRun = cli(['--manifest', manifestFile, '--labels', goodFile, '--mapping', write('mapping-missing-case.json', missingCaseMapping), '--json'])
    record('F05 负例：mapping 缺 case → exit 1', missingCaseRun.status === 1 && missingCaseRun.stdout.includes('缺少 case-002'), `exit=${missingCaseRun.status}`)

    const duplicateRunIdMapping = cloneMapping()
    duplicateRunIdMapping.mapping['case-002'].runId = duplicateRunIdMapping.mapping['case-001'].runId
    const duplicateRunIdRun = cli(['--manifest', manifestFile, '--labels', goodFile, '--mapping', write('mapping-duplicate-run.json', duplicateRunIdMapping), '--json'])
    record('F05 负例：两个 case 映射到同一 runId → exit 1', duplicateRunIdRun.status === 1 && duplicateRunIdRun.stdout.includes('runId 重复'), `exit=${duplicateRunIdRun.status}`)

    const wrongCaseCountMapping = cloneMapping()
    wrongCaseCountMapping.caseCount = 3
    wrongCaseCountMapping.manifestSha256 = '0'.repeat(64)
    const wrongIdentityRun = cli(['--manifest', manifestFile, '--labels', goodFile, '--mapping', write('mapping-wrong-identity.json', wrongCaseCountMapping), '--json'])
    record('F05 负例：导出清单身份（caseCount/manifestSha256）不匹配 → exit 1', wrongIdentityRun.status === 1 && wrongIdentityRun.stdout.includes('caseCount') && wrongIdentityRun.stdout.includes('manifestSha256'), `exit=${wrongIdentityRun.status}`)

    const ok = steps.every((step) => step.ok)
    if (asJson) console.log(JSON.stringify({ selfTest: ok, steps }, null, 2))
    else {
      for (const step of steps) console.log(`${step.ok ? 'PASS' : 'FAIL'} ${step.name} :: ${step.detail}`)
      console.log(ok ? 'SELF-TEST: PASS' : 'SELF-TEST: FAIL')
    }
    process.exit(ok ? 0 : 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function readJSON(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function main() {
  const asJson = hasFlag('json')
  if (hasFlag('self-test')) selfTest(asJson)

  const manifestPath = arg('manifest')
  const labelsPath = arg('labels')
  if (!manifestPath || !labelsPath) usage('需要 --manifest 与 --labels')
  if (!existsSync(manifestPath)) usage(`manifest 不存在：${manifestPath}`)
  if (!existsSync(labelsPath)) usage(`labels 不存在：${labelsPath}`)

  let manifest
  let manifestRawText
  let labels
  let labelsRawText
  try {
    manifestRawText = readFileSync(manifestPath, 'utf8')
    manifest = JSON.parse(manifestRawText)
  } catch (error) {
    usage(`manifest 不是合法 JSON：${error.message}`)
  }
  try {
    labelsRawText = readFileSync(labelsPath, 'utf8')
    labels = JSON.parse(labelsRawText)
  } catch (error) {
    usage(`labels 不是合法 JSON：${error.message}`)
  }
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) usage('manifest.cases 必须是非空数组')

  const result = validateLabels(manifest, labels, labelsRawText)
  const mappingPath = arg('mapping')
  const normalizedOut = arg('normalized-out')
  if (normalizedOut && !mappingPath) usage('--normalized-out 需要同时提供 --mapping（否则无法从 blindId 还原 runId/arm）')
  const report = { manifest: manifestPath, labels: labelsPath, ...result }
  if (result.ok && mappingPath) {
    if (!existsSync(mappingPath)) usage(`mapping 不存在：${mappingPath}`)
    let mapping
    try {
      mapping = readJSON(mappingPath)
    } catch (error) {
      usage(`mapping 不是合法 JSON：${error.message}`)
    }
    try {
      report.normalized = normalize(manifest, labels, mapping, manifestRawText)
    } catch (error) {
      report.ok = false
      report.errors = [error.message]
    }
  }
  if (report.ok && normalizedOut) {
    writeFileSync(resolve(normalizedOut), `${JSON.stringify(report.normalized, null, 2)}\n`, 'utf8')
    report.normalizedOut = resolve(normalizedOut)
  }

  if (asJson) console.log(JSON.stringify(report, null, 2))
  else {
    for (const error of report.errors) console.error(`FAIL ${error}`)
    console.log(`[label-import] labeled=${report.summary.labeled}/${report.summary.expected} complete=${report.summary.complete}`)
    if (report.summary.missing.length) console.log(`missing: ${report.summary.missing.join(', ')}`)
    if (report.normalizedOut) console.log(`normalized: ${report.normalizedOut}`)
    console.log(`RESULT: ${report.ok ? 'PASS' : 'FAIL'}`)
  }
  process.exit(report.ok ? 0 : 1)
}

main()
