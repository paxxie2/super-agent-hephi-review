#!/usr/bin/env node
// T18: offline red-state determination from run directories (eval side only).
//
// For one batch of `<stateDir>/hephi/<ticketId>/checks/<runId>/` directories
// (each with run.json and an optional junit.xml) plus the matching v3 task card
// (acceptance[].tests + the check configuration's assertionFailureTypes), decide
// per acceptance item whether the recorded red state is VALID:
//   valid   - all four premises hold and a failing target test's type matches the
//             configured assertion failure types
//   invalid - a premise is broken, the failure type does not match (TypeError
//             etc.), the target test is missing or skipped, or the report says
//             the target test passed
//   absent  - no red-state run (run.json phase === 'red') exists for the item
//
// Premises:
//   P1 target test cases exist in junit.xml. Matching rules:
//      * an acceptance test entry is `file::name`, `file#name`, a bare test
//        name, or { file?, classname?, name };
//      * `name` must equal the testcase's `name` (normalised separators);
//      * when the entry names a file/classname, the testcase `classname` must
//        have the same normalised suffix (path separators and file extensions
//        are dropped, so `tests/test_money.py` ~ `tests.test_money` ~
//        `backend.tests.test_money`); a testcase without classname is matched by
//        name only;
//      * every matching testcase is aggregated: a file-level entry matches all
//        testcases of that file; missing cases, all-skipped target sets and
//        any target failure are decided per spec (AT-68), e.g. a file with one
//        passing and one failing target testcase is a failing target set in
//        any report order.
//   P2 the report belongs to this run: junit.xml lives inside the runId directory
//      and its *real path* (after resolving symlinks) stays inside that run
//      directory; its mtime is >= run.startedAt
//   P3 every test file still hashes to the red commit's blob:
//      `git -C <workspace> hash-object -- <file>` === `git ls-tree <redCommit> -- <file>`
//   P4 the report is complete and internally consistent: junit.xml is a
//      well-formed document (balanced tags, no truncation, no duplicate
//      attributes); any present counter (`tests`/`failures`/`errors`/`skipped`)
//      must be a non-negative integer; each testsuite's `failures`/`errors`
//      counter must equal that suite's own `<failure>`/`<error>` nodes (no
//      cross-suite offsetting; nested suites checked independently); flat
//      reports declare a `tests` total equal to the number of testcase nodes
//
// Input shapes (documented because T17's phase field is not merged yet):
//   run.json        { phase: 'red', startedAt: ISO, before: { headCommit: sha40 },
//                     acceptanceId?: string, checkId?: string, junit?: string,
//                     testFiles?: string[] }
//                   Only `phase === 'red'` records are treated as red-state runs;
//                   fixtures may hand-write this field until T17 lands.
//   task card (v3)  { version: 3, ticketId?: string,
//                     acceptance: [ { id, tests: [ 'file::name' | { file?, classname?, name } ],
//                                     baselinePasses?: boolean, files?: string[] } ],
//                     assertionFailureTypes?: string[], checkConfig?: { assertionFailureTypes?: string[] },
//                     checks?: [ { id, assertionFailureTypes?: string[] } ] }
//                   `baselinePasses: true` items are excluded from the coverage
//                   denominator (AT-67); they only need the report to be absent.
//   --task-cards    a JSON file mapping ticketId -> task card (or an array of
//                   { ticketId, card }), or a directory of `<ticketId>.json`.
//                   Without it the script looks for
//                   `<stateDir>/hephi/<ticketId>/task-card.json`.
//
// CLI:
//   node eval/offline-red-check.mjs --state-dir <dir> --workspace <git repo> \
//        (--task-cards <file|dir> | per-ticket task-card.json) [--out <json> | --dry-run]
//   node eval/offline-red-check.mjs --self-test
//
// Coverage = valid items / items that need a red state (tests present and
// baselinePasses !== true). A batch-local number only; it is not an experiment
// result and does not read any historical baseline.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RED_CHECK_SCHEMA_VERSION = 1
export const DEFAULT_ASSERTION_FAILURE_TYPES = Object.freeze(['AssertionError'])

class UsageError extends Error {}

const isSha40 = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
const asIsoMs = value => {
  if (typeof value !== 'string' || value === '') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function readJson(path, label) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new UsageError(`cannot read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new UsageError(`${label} is not valid JSON: ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ---------------------------------------------------------------------------
// junit.xml: dependency-free, deliberately small parser. Only the attributes the
// verdict needs are read (testcase classname/name, skipped/failure/error and the
// testsuite failures/errors counters).
// ---------------------------------------------------------------------------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" }
const decode = value => value.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, name) => ENTITIES[name])
const attributes = (tag, label = 'junit report') => {
  const found = {}
  const seen = new Set()
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let match
  while ((match = re.exec(tag)) !== null) {
    const name = match[1]
    // N06a: duplicate attributes are rejected instead of silently keeping the last value.
    if (seen.has(name)) throw new Error(`${label}: duplicate attribute "${name}" on an element`)
    seen.add(name)
    const value = match[2] !== undefined ? match[2] : match[3]
    found[name] = decode(value)
  }
  return found
}

/** Index of the first `>` that terminates a start tag, ignoring quoted values. */
function startTagEnd(xml, from) {
  let quote = null
  for (let index = from + 1; index < xml.length; index += 1) {
    const ch = xml[index]
    if (quote !== null) { if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '>') return index
  }
  return -1
}

/**
 * Dependency-free XML well-formedness parser (elements only; comments, CDATA,
 * processing instructions and doctypes are skipped/ignored). Throws on
 * truncated documents, unbalanced/ crossed tags, multiple roots and stray text.
 * Returns the element tree, which the junit reader uses to cross-check counters.
 */
function parseXmlDocument(xml, label = 'junit report') {
  let index = 0
  const stack = []
  const nodes = []
  let root = null
  let rootCount = 0
  while (index < xml.length) {
    const lt = xml.indexOf('<', index)
    if (lt === -1) {
      const tail = xml.slice(index)
      if (stack.length > 0) stack.at(-1).text += tail
      else if (tail.trim() !== '') throw new Error(`${label}: text outside the root element`)
      break
    }
    if (lt > index) {
      const text = xml.slice(index, lt)
      if (stack.length > 0) stack.at(-1).text += text
      else if (text.trim() !== '') throw new Error(`${label}: text outside the root element`)
    }
    index = lt
    if (xml.startsWith('<?', index)) {
      const end = xml.indexOf('?>', index + 2)
      if (end === -1) throw new Error(`${label}: unterminated processing instruction`)
      index = end + 2
      continue
    }
    if (xml.startsWith('<!--', index)) {
      const end = xml.indexOf('-->', index + 4)
      if (end === -1) throw new Error(`${label}: unterminated comment`)
      index = end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', index)) {
      const end = xml.indexOf(']]>', index + 9)
      if (end === -1) throw new Error(`${label}: unterminated CDATA section`)
      if (stack.length === 0) throw new Error(`${label}: CDATA outside the root element`)
      stack.at(-1).text += xml.slice(index + 9, end)
      index = end + 3
      continue
    }
    if (xml.startsWith('<!', index)) {
      const end = xml.indexOf('>', index)
      if (end === -1) throw new Error(`${label}: unterminated declaration`)
      index = end + 1
      continue
    }
    if (xml.startsWith('</', index)) {
      const end = xml.indexOf('>', index)
      if (end === -1) throw new Error(`${label}: unterminated end tag`)
      const name = xml.slice(index + 2, end).trim()
      if (!/^[A-Za-z_][\w:.-]*$/.test(name)) throw new Error(`${label}: malformed end tag </${name}>`)
      const open = stack.pop()
      if (!open) throw new Error(`${label}: end tag </${name}> without an open element`)
      if (open.name !== name) throw new Error(`${label}: end tag </${name}> does not match <${open.name}>`)
      index = end + 1
      continue
    }
    const end = startTagEnd(xml, index)
    if (end === -1) throw new Error(`${label}: unterminated start tag (truncated document?)`)
    const inner = xml.slice(index + 1, end)
    const selfClosing = /\/\s*$/.test(inner)
    const tag = selfClosing ? inner.slice(0, inner.lastIndexOf('/')) : inner
    const nameMatch = /^\s*([A-Za-z_][\w:.-]*)/.exec(tag)
    if (!nameMatch) throw new Error(`${label}: malformed start tag`)
    const name = nameMatch[1]
    const node = { name, attrs: attributes(tag.slice(nameMatch[0].length), label), children: [], text: '' }
    if (stack.length === 0) {
      rootCount += 1
      if (rootCount > 1) throw new Error(`${label}: multiple root elements`)
      root = node
    } else {
      stack.at(-1).children.push(node)
    }
    nodes.push(node)
    if (!selfClosing) stack.push(node)
    index = end + 1
  }
  if (stack.length > 0) throw new Error(`${label}: unclosed element(s): ${stack.map(node => node.name).join(', ')}`)
  if (root === null) throw new Error(`${label}: no root element`)
  return { root, nodes }
}

/** Parse a junit.xml report. Throws on unreadable, truncated or inconsistent reports. */
export function parseJunit(xml) {
  if (typeof xml !== 'string') throw new Error('junit report must be a string')
  const { root, nodes } = parseXmlDocument(xml, 'junit report')
  if (root.name !== 'testsuites' && root.name !== 'testsuite') {
    throw new Error(`not a junit report (unexpected root <${root.name}>)`)
  }
  const suites = nodes.filter(node => node.name === 'testsuite')
  if (suites.length === 0) throw new Error('no parsable <testsuite> element')
  const suiteAttrs = suites.map(suite => suite.attrs)
  // N06b: a counter attribute that is present must be a non-negative integer;
  // "exists but is garbage" is rejected instead of silently skipping the check.
  for (const attrs of suiteAttrs) {
    for (const field of ['tests', 'failures', 'errors', 'skipped']) {
      if (attrs[field] !== undefined && !/^\d+$/.test(attrs[field])) {
        throw new Error(`report counters invalid: testsuite ${field}=${JSON.stringify(attrs[field])} is not a non-negative integer`)
      }
    }
  }
  const failures = suiteAttrs.map(attrs => attrs.failures)
  const errors = suiteAttrs.map(attrs => attrs.errors)
  const countersPresent = failures.every(value => value !== undefined)
    && errors.every(value => value !== undefined)
  const testcases = nodes
    .filter(node => node.name === 'testcase')
    .map(node => ({
      classname: node.attrs.classname ?? '',
      name: node.attrs.name ?? '',
      file: node.attrs.file ?? null,
      time: node.attrs.time ?? null,
      skipped: node.children.some(child => child.name === 'skipped'),
      failures: node.children.filter(child => child.name === 'failure').map(child => child.attrs),
      errors: node.children.filter(child => child.name === 'error').map(child => child.attrs),
    }))

  if (countersPresent) {
    // N06c: verify failures/errors per testsuite, against that suite's own
    // subtree (nested suites included). Cross-suite offsetting is rejected; a
    // declared node count can never be balanced by another suite's surplus.
    for (let index = 0; index < suites.length; index += 1) {
      const suite = suites[index]
      const suiteLabel = suite.attrs.name ? `"${suite.attrs.name}"` : `#${index + 1}`
      let suiteFailures = 0
      let suiteErrors = 0
      const pending = [...suite.children]
      while (pending.length > 0) {
        const node = pending.pop()
        if (node.name === 'failure') suiteFailures += 1
        else if (node.name === 'error') suiteErrors += 1
        pending.push(...node.children)
      }
      const declaredSuiteFailures = Number(suite.attrs.failures)
      const declaredSuiteErrors = Number(suite.attrs.errors)
      if (declaredSuiteFailures !== suiteFailures) {
        throw new Error(`report counters disagree in testsuite ${suiteLabel}: failures=${declaredSuiteFailures} but the suite subtree contains ${suiteFailures} <failure> node(s)`)
      }
      if (declaredSuiteErrors !== suiteErrors) {
        throw new Error(`report counters disagree in testsuite ${suiteLabel}: errors=${declaredSuiteErrors} but the suite subtree contains ${suiteErrors} <error> node(s)`)
      }
    }
    const declaredFailures = failures.reduce((sum, value) => sum + Number(value), 0)
    const declaredErrors = errors.reduce((sum, value) => sum + Number(value), 0)
    // pytest writes flat suites; only cross-check global `tests` when not nested
    // (per-suite failures/errors above carry the strict per-suite guarantee).
    const nestedSuites = suites.some(suite => suite.children.some(child => child.name === 'testsuite'))
    const testsValues = suiteAttrs.map(attrs => attrs.tests)
    if (!nestedSuites && testsValues.every(value => value !== undefined)) {
      const declaredTests = testsValues.reduce((sum, value) => sum + Number(value), 0)
      if (declaredTests !== testcases.length) {
        throw new Error(`report counters disagree: testsuites declare tests=${declaredTests} but the document contains ${testcases.length} testcase node(s)`)
      }
    }
    return {
      root,
      suites: suiteAttrs,
      countersPresent,
      counters: { failures: declaredFailures, errors: declaredErrors },
      testcases,
    }
  }
  return {
    root,
    suites: suiteAttrs,
    countersPresent,
    counters: { failures: null, errors: null },
    testcases,
  }
}

// ---------------------------------------------------------------------------
// Test id matching. A task card entry may be `path::test_name`,
// `path#test_name`, a bare test name, or { file?, classname?, name }.
// classname comparison normalises separators/paths:
//   'tests/test_money.py::test_window'  ~  classname 'tests.test_money'
//   'backend.tests.test_money'          ~  classname 'tests.test_money'
// ---------------------------------------------------------------------------
const normalizePath = value => value.replace(/\\/g, '/').replace(/^\.\//, '')
const normalizeClass = value => {
  let out = normalizePath(value).replace(/\.(py|js|jsx|ts|tsx|mjs|cjs|java|go|rb|php|rs)$/i, '')
  out = out.replace(/\//g, '.').replace(/::/g, '.')
  return out.replace(/^\.+/, '')
}
const classSuffixMatch = (expected, actual) => {
  const e = normalizeClass(expected)
  const a = normalizeClass(actual)
  if (e === a) return true
  return a === e || a.endsWith(`.${e}`) || e.endsWith(`.${a}`)
}

/** Normalise one acceptance[].tests entry to {file, classname, name}. */
export function normalizeTestSpec(entry) {
  if (entry && typeof entry === 'object') {
    const file = typeof entry.file === 'string' ? normalizePath(entry.file) : null
    const classname = typeof entry.classname === 'string' ? entry.classname : null
    const name = typeof entry.name === 'string' ? entry.name : null
    if (!name) throw new UsageError(`acceptance test object needs a name: ${JSON.stringify(entry)}`)
    return { file, classname, name }
  }
  if (typeof entry !== 'string' || entry.trim() === '') throw new UsageError(`acceptance test must be a non-empty string or object: ${JSON.stringify(entry)}`)
  const raw = entry.trim()
  const split = raw.includes('::') ? '::' : raw.includes('#') ? '#' : null
  if (split) {
    const [file, name] = raw.split(split, 2)
    return { file: normalizePath(file), classname: null, name }
  }
  const slash = raw.lastIndexOf('/')
  const dot = raw.lastIndexOf('.')
  if (slash >= 0 && dot > slash && raw.slice(dot + 1).trim() !== '') {
    // A path-like entry without a `::`/`#` separator names the whole test file
    // (the v3 task-card schema freezes plain relative paths in `tests`). Every
    // testcase whose classname matches the file satisfies P1.
    return { file: normalizePath(raw), classname: null, name: null }
  }
  return { file: null, classname: null, name: raw }
}

export function matchTestcase(spec, testcase) {
  if (!spec || !testcase) return false
  const sameName = spec.name === null || spec.name === undefined
    || spec.name === testcase.name || normalizeClass(spec.name) === normalizeClass(testcase.name)
  if (!sameName) return false
  if (spec.classname) {
    if (!classSuffixMatch(spec.classname, testcase.classname)) return false
  } else if (spec.file) {
    const fileClass = normalizeClass(spec.file)
    if (testcase.classname && !classSuffixMatch(fileClass, testcase.classname)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// git helpers. The workspace is the checkout the report was produced from: the
// working tree hash is compared with the red commit's tree entry (P3).
// ---------------------------------------------------------------------------
const git = (workspace, ...args) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })

/** Blob hash of a working-tree file, or null when the file does not exist. */
export function workingBlobHash(workspace, file) {
  try {
    return git(workspace, 'hash-object', '--', file).trim() || null
  } catch {
    return null
  }
}

/** Blob hash recorded for `file` at `commit`, or null when absent/unresolvable. */
export function commitBlobHash(workspace, commit, file) {
  if (!isSha40(commit)) return null
  try {
    const out = git(workspace, 'ls-tree', commit, '--', file).trim()
    if (out === '') return null
    const match = /^[0-9]+\s+blob\s+([0-9a-f]{40})\t/.exec(out)
    return match ? match[1] : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Resolution of check configuration / failure types.
// ---------------------------------------------------------------------------
export function assertionFailureTypesFor(card, acceptanceItem, checkConfig) {
  const collect = values => (Array.isArray(values) && values.every(v => typeof v === 'string' && v !== '') ? [...values] : null)
  const perCheck = (card.checks ?? []).find(check => check && (check.id === acceptanceItem.check || check.id === acceptanceItem.id))
  const candidates = [
    acceptanceItem.assertionFailureTypes,
    perCheck?.assertionFailureTypes,
    card.checkConfig?.assertionFailureTypes,
    card.assertionFailureTypes,
    checkConfig?.[acceptanceItem.check ?? acceptanceItem.id],
    checkConfig?.assertionFailureTypes,
  ]
  for (const candidate of candidates) {
    const types = collect(candidate)
    if (types !== null) return types
  }
  return [...DEFAULT_ASSERTION_FAILURE_TYPES]
}

// R02: an explicit `type` attribute decides; the message is never used to
// override it. Only reports without a type attribute get the restricted
// pytest plain-assert shape (`message` begins with `assert`) inferred as
// AssertionError. Arbitrary message substrings are not accepted.
const failureTypeMatches = (types, testcase) => {
  const failures = [...testcase.failures, ...testcase.errors]
  return failures.some(failure => {
    const explicit = typeof failure.type === 'string' ? failure.type.trim() : ''
    if (explicit !== '') return types.includes(explicit)
    const message = typeof failure.message === 'string' ? failure.message : ''
    if (/^assert\b/.test(message)) return types.includes('AssertionError')
    return false
  })
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
function loadTaskCards(options) {
  const cards = new Map()
  if (options.taskCards === null) return cards
  const path = resolve(options.taskCards)
  if (existsSync(path) && statSync(path).isDirectory()) {
    for (const name of readdirSync(path)) {
      if (!name.endsWith('.json')) continue
      const ticketId = name.slice(0, -'.json'.length)
      cards.set(ticketId, readJson(join(path, name), 'task card'))
    }
    return cards
  }
  const parsed = readJson(path, '--task-cards')
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (!entry || typeof entry.ticketId !== 'string' || !entry.card) throw new UsageError('--task-cards array entries must be { ticketId, card }')
      cards.set(entry.ticketId, entry.card)
    }
    return cards
  }
  if (!parsed || typeof parsed !== 'object') throw new UsageError('--task-cards must be an object, array, or directory')
  for (const [ticketId, card] of Object.entries(parsed)) cards.set(ticketId, card)
  return cards
}

/** All run directories for one state directory, grouped per ticket. */
export function discoverRedRuns(stateDir) {
  const root = join(resolve(stateDir), 'hephi')
  if (!existsSync(root)) throw new UsageError(`state directory has no hephi/ subtree: ${root}`)
  const tickets = new Map()
  for (const ticketId of readdirSync(root)) {
    const checksDir = join(root, ticketId, 'checks')
    if (!existsSync(checksDir) || !statSync(checksDir).isDirectory()) continue
    const runs = []
    for (const runId of readdirSync(checksDir)) {
      const runDir = join(checksDir, runId)
      if (!existsSync(runDir) || !statSync(runDir).isDirectory()) continue
      const recordPath = join(runDir, 'run.json')
      if (!existsSync(recordPath)) continue
      const record = readJson(recordPath, 'run.json')
      if (record?.phase !== 'red') continue // T18: only phase === 'red' records are red-state runs
      runs.push({ ticketId, runId, runDir, record })
    }
    if (runs.length > 0) {
      runs.sort((a, b) => (asIsoMs(a.record.startedAt) ?? 0) - (asIsoMs(b.record.startedAt) ?? 0))
      tickets.set(ticketId, runs)
    }
  }
  return tickets
}

/** Pick the red run that belongs to one acceptance item. */
function runForItem(runs, item) {
  const explicit = runs.filter(run => run.record.acceptanceId === item.id)
  if (explicit.length > 0) return explicit.at(-1)
  const byCheck = runs.filter(run => run.record.checkId !== undefined && (run.record.checkId === item.check || run.record.checkId === item.id))
  if (byCheck.length > 0) return byCheck.at(-1)
  const unmapped = runs.filter(run => run.record.acceptanceId === undefined && run.record.checkId === undefined)
  if (unmapped.length > 0 && (item._siblingCount ?? 1) === 1) return unmapped.at(-1)
  return null
}

function testFilesFor(run, item, specs) {
  const fromRun = Array.isArray(run.record.testFiles) ? run.record.testFiles.map(normalizePath) : []
  const fromItem = Array.isArray(item.files) ? item.files.map(normalizePath) : []
  const fromSpecs = specs.map(spec => spec.file).filter(file => typeof file === 'string' && file !== '')
  return [...new Set([...fromRun, ...fromItem, ...fromSpecs])]
}

const inside = (child, parent) => {
  const c = resolve(child)
  const p = resolve(parent)
  return c === p || c.startsWith(`${p}${sep}`)
}

/** Evaluate one acceptance item against its red-state run. Pure except for fs/git reads. */
export function evaluateAcceptanceItem({ item, run, workspace, card = {}, checkConfig }) {
  const baselinePasses = item.baselinePasses === true
  const specs = (Array.isArray(item.tests) ? item.tests : []).map(normalizeTestSpec)
  if (baselinePasses) {
    return { id: item.id, tests: specs, baselinePasses: true, red: 'absent', reason: 'baseline passes; excluded from the red-state coverage denominator', runId: null }
  }
  if (!run) return { id: item.id, tests: specs, baselinePasses: false, red: 'absent', reason: 'no red-state run (phase === red) mapped to this acceptance item', runId: null }

  const reportName = typeof run.record.junit === 'string' && run.record.junit !== '' ? run.record.junit : 'junit.xml'
  const reportPath = resolve(run.runDir, reportName)
  const invalid = reason => ({ id: item.id, tests: specs, baselinePasses: false, red: 'invalid', reason, runId: run.runId, reportPath })

  // P2: report belongs to this run. Lexical containment is not enough: resolve
  // symlinks and require the real report path to stay inside the real run
  // directory (R03). mtime is only an auxiliary signal, it cannot prove origin.
  if (!inside(reportPath, run.runDir)) return invalid(`P2: report ${reportPath} is outside the run directory`)
  if (!existsSync(reportPath)) return invalid(`P2: report ${reportPath} does not exist`)
  let realRunDir
  let realReportPath
  try {
    realRunDir = realpathSync(run.runDir)
    realReportPath = realpathSync(reportPath)
  } catch (error) {
    return invalid(`P2: cannot resolve report real path: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!inside(realReportPath, realRunDir)) {
    return invalid(`P2: report ${reportPath} resolves to ${realReportPath}, outside the run directory (symlinked report)`)
  }
  if (!statSync(realReportPath).isFile()) return invalid(`P2: report ${realReportPath} is not a regular file`)
  const startedAt = asIsoMs(run.record.startedAt)
  if (startedAt === null) return invalid('P2: run.json startedAt is missing or not an ISO timestamp')
  const mtime = statSync(realReportPath).mtimeMs
  if (mtime < startedAt) return invalid(`P2: report mtime ${new Date(mtime).toISOString()} predates run startedAt ${new Date(startedAt).toISOString()}`)

  // P4: report completeness.
  let report
  try {
    report = parseJunit(readFileSync(reportPath, 'utf8'))
  } catch (error) {
    return invalid(`P4: junit report cannot be parsed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!report.countersPresent) return invalid('P4: testsuite failures/errors counters are missing or not numeric')

  // P1: target cases exist and are aggregated per spec (R04). A file-level
  // spec covers every matching testcase of the file; the report node order
  // must not change the verdict. Aggregation rules:
  //   - a spec with zero matching testcases is missing => invalid;
  //   - a spec whose matching testcases are all skipped is skipped => invalid;
  //   - otherwise the target set fails when any matching testcase failed
  //     (the passing/skipped siblings do not cancel a real failure).
  if (specs.length === 0) return invalid('P1: acceptance item has no tests to match')
  const specMatches = specs.map(spec => report.testcases.filter(testcase => matchTestcase(spec, testcase)))
  const missing = specs.filter((spec, index) => specMatches[index].length === 0)
  if (missing.length > 0) return invalid(`P1: target test case(s) missing from the report: ${missing.map(spec => spec.name ?? spec.file ?? '(unnamed)').join(', ')}`)
  const allSkipped = specs.filter((spec, index) => specMatches[index].every(testcase => testcase.skipped))
  if (allSkipped.length > 0) return invalid(`AT-68: target test case(s) skipped: ${allSkipped.map(spec => spec.name ?? spec.file ?? '(unnamed)').join(', ')}`)
  const matched = [...new Set(specMatches.flat())]
    .sort((a, b) => `${a.classname}\u0000${a.name}`.localeCompare(`${b.classname}\u0000${b.name}`))

  // P3: test files still hash to the red commit.
  const files = testFilesFor(run, item, specs)
  if (files.length === 0) return invalid('P3: no test file to verify against the red commit')
  const redCommit = run.record.before?.headCommit
  if (!isSha40(redCommit)) return invalid('P3: run.json before.headCommit is missing or not a full SHA')
  for (const file of files) {
    const expected = commitBlobHash(workspace, redCommit, file)
    if (expected === null) return invalid(`P3: test file ${file} is absent from red commit ${redCommit}`)
    const actual = workingBlobHash(workspace, file)
    if (actual === null) return invalid(`P3: test file ${file} is missing from the workspace`)
    if (actual !== expected) return invalid(`P3: test file ${file} hash ${actual} differs from red commit blob ${expected}`)
  }

  // Red validity: a target case must fail with a configured assertion type (AT-66).
  const failing = matched.filter(testcase => testcase.failures.length > 0 || testcase.errors.length > 0)
  if (failing.length === 0) return invalid('target test case(s) passed in the report; a red state requires a failure')
  const types = assertionFailureTypesFor(card, item, checkConfig)
  if (!failing.some(testcase => failureTypeMatches(types, testcase))) {
    const seen = [...new Set(failing.flatMap(testcase => [...testcase.failures, ...testcase.errors]).map(failure => failure.type ?? '(no type)'))]
    return invalid(`AT-66: failure type(s) ${seen.join(', ') || '(none)'} do not match assertionFailureTypes ${types.join(', ')}`)
  }
  return { id: item.id, tests: specs, baselinePasses: false, red: 'valid', reason: `four premises hold; failure type matches ${types.join(', ')}`, runId: run.runId, reportPath }
}

/** Evaluate a whole batch. `now` is only used for the generatedAt field. */
export function evaluateBatch({ stateDir, workspace, taskCards, checkConfig = null, now = new Date() }) {
  const runsByTicket = discoverRedRuns(stateDir)
  const cards = taskCards instanceof Map ? taskCards : new Map(Object.entries(taskCards ?? {}))
  const ticketIds = [...new Set([...runsByTicket.keys(), ...cards.keys()])].sort()
  const tickets = []
  let valid = 0
  let invalidCount = 0
  let absent = 0
  let needRed = 0
  for (const ticketId of ticketIds) {
    const card = cards.get(ticketId) ?? (existsSync(join(resolve(stateDir), 'hephi', ticketId, 'task-card.json'))
      ? readJson(join(resolve(stateDir), 'hephi', ticketId, 'task-card.json'), 'task card')
      : null)
    if (!card) {
      tickets.push({ ticketId, acceptance: [], error: 'no v3 task card found for this ticket' })
      continue
    }
    const acceptance = Array.isArray(card.acceptance) ? card.acceptance : []
    const runs = runsByTicket.get(ticketId) ?? []
    const items = []
    for (const item of acceptance) {
      if (!item || typeof item.id !== 'string' || item.id === '') throw new UsageError(`task card for ${ticketId} has an acceptance item without an id`)
      item._siblingCount = acceptance.filter(other => Array.isArray(other.tests) && other.tests.length > 0).length
      const runsForItem = runForItem(runs, item)
      const result = evaluateAcceptanceItem({ item, run: runsForItem, workspace, card, checkConfig })
      delete item._siblingCount
      const required = !result.baselinePasses && Array.isArray(item.tests) && item.tests.length > 0
      items.push({ ...result, redStateRequired: required })
      if (required) needRed += 1
      if (result.red === 'valid') valid += 1
      else if (result.red === 'invalid') invalidCount += 1
      else absent += 1
    }
    tickets.push({
      ticketId,
      acceptance: items,
      summary: {
        items: items.length,
        valid: items.filter(item => item.red === 'valid').length,
        invalid: items.filter(item => item.red === 'invalid').length,
        absent: items.filter(item => item.red === 'absent').length,
        redStateRequired: items.filter(item => item.redStateRequired).length,
      },
    })
  }
  return {
    schemaVersion: RED_CHECK_SCHEMA_VERSION,
    generatedBy: 'eval/offline-red-check.mjs',
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    inputs: { stateDir: resolve(stateDir), workspace: resolve(workspace), note: 'batch-local red-state determination; not an experiment result' },
    tickets,
    coverage: { valid, needRed, ratio: needRed === 0 ? null : Math.round((valid / needRed) * 10000) / 10000 },
    totals: { items: valid + invalidCount + absent, valid, invalid: invalidCount, absent, redStateRequired: needRed },
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
export function parseArgs(argv) {
  const options = { stateDir: null, workspace: null, taskCards: null, checkConfig: null, out: null, dryRun: false, selfTest: false, help: false }
  const valueFlags = ['--state-dir', '--workspace', '--task-cards', '--check-config', '--out']
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--self-test') { options.selfTest = true; continue }
    if (arg === '--dry-run') { options.dryRun = true; continue }
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (!valueFlags.includes(arg)) throw new UsageError(`unknown argument: ${arg}`)
    const value = argv[index + 1]
    if (value === undefined) throw new UsageError(`missing value for ${arg}`)
    index += 1
    if (arg === '--state-dir') options.stateDir = value
    if (arg === '--workspace') options.workspace = value
    if (arg === '--task-cards') options.taskCards = value
    if (arg === '--check-config') options.checkConfig = value
    if (arg === '--out') options.out = value
  }
  if (options.selfTest || options.help) return options
  if (options.stateDir === null) throw new UsageError('--state-dir is required')
  if (options.workspace === null) throw new UsageError('--workspace is required')
  if (options.out === null && !options.dryRun) throw new UsageError('--out is required unless --dry-run is used')
  return options
}

function usage() {
  return 'usage: node eval/offline-red-check.mjs --state-dir <dir> --workspace <git repo> [--task-cards <file|dir>] [--check-config <json>] (--out <json> | --dry-run)\n       node eval/offline-red-check.mjs --self-test'
}

// ---------------------------------------------------------------------------
// Self-test: temporary git workspace + fake stateDir + hand-written junit/run
// fixtures. Covers AT-65 (four premises), AT-66 (type mismatch), AT-67
// (coverage denominator) and AT-68 (missing/skipped target case).
// ---------------------------------------------------------------------------
function pass(list, name, condition, detail = '') {
  if (condition) { list.push(`PASS ${name}`); return }
  list.push(`FAIL ${name}${detail ? ` :: ${detail}` : ''}`)
}

const g = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }

const TEST_FILE = 'backend/tests/test_money.py'
const TEST_CONTENT = 'def test_window():\n    assert windows(3) == [1, 2, 3]\n'
const JUNIT_VALID = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="pytest" tests="1" failures="1" errors="0" skipped="0">
    <testcase classname="backend.tests.test_money" name="test_window" file="${TEST_FILE}" time="0.01">
      <failure message="assert [1, 2] == [1, 2, 3]" type="AssertionError">traceback</failure>
    </testcase>
  </testsuite>
</testsuites>
`
const JUNIT_TYPE_ERROR = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="pytest" tests="1" failures="0" errors="1" skipped="0">
    <testcase classname="backend.tests.test_money" name="test_window" file="${TEST_FILE}" time="0.01">
      <error message="windows() takes 1 argument" type="TypeError">traceback</error>
    </testcase>
  </testsuite>
</testsuites>
`
const JUNIT_SKIPPED = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="pytest" tests="1" failures="0" errors="0" skipped="1">
    <testcase classname="backend.tests.test_money" name="test_window" file="${TEST_FILE}"><skipped message="not run"/></testcase>
  </testsuite>
</testsuites>
`
const JUNIT_NOT_XML = 'this is not a junit report\n'
const JUNIT_NO_COUNTERS = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites><testsuite name="pytest"><testcase classname="backend.tests.test_money" name="test_window" file="${TEST_FILE}"><failure type="AssertionError" message="boom"/></testcase></testsuite></testsuites>
`
const JUNIT_MISSING_CASE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="pytest" tests="1" failures="1" errors="0">
    <testcase classname="backend.tests.test_money" name="test_other" file="${TEST_FILE}"><failure type="AssertionError" message="other"/></testcase>
  </testsuite>
</testsuites>
`

// --- R01: report integrity fixtures ---------------------------------------
const JUNIT_TRUNCATED = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="pytest" tests="1" failures="1" errors="0">
    <testcase classname="backend.tests.test_money" name="test_window" file="${TEST_FILE}">
      <failure message="boom" type="AssertionError">traceback</failure>
`
const JUNIT_MISMATCHED_TAGS = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="pytest" tests="1" failures="1" errors="0">
    <testcase classname="backend.tests.test_money" name="test_window" file="${TEST_FILE}">
      <failure message="boom" type="AssertionError">traceback</failure>
    </testcase>
  </testsuites>
</testsuites>
`
const JUNIT_COUNTER_MISMATCH = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="pytest" tests="1" failures="0" errors="0">
    <testcase classname="backend.tests.test_money" name="test_window" file="${TEST_FILE}">
      <failure message="boom" type="AssertionError">traceback</failure>
    </testcase>
  </testsuite>
</testsuites>
`
const JUNIT_TESTS_COUNT_MISMATCH = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="pytest" tests="5" failures="1" errors="0">
    <testcase classname="backend.tests.test_money" name="test_window" file="${TEST_FILE}">
      <failure message="boom" type="AssertionError">traceback</failure>
    </testcase>
  </testsuite>
</testsuites>
`

// --- N06: XML counter integrity fixtures ----------------------------------
const JUNIT_DUP_ATTR = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="pytest" tests="1" failures="0" failures="1" errors="0">
    <testcase classname="backend.tests.test_money" name="test_window" file="${TEST_FILE}">
      <failure message="boom" type="AssertionError">traceback</failure>
    </testcase>
  </testsuite>
</testsuites>
`
const JUNIT_NONNUM_COUNTER = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="pytest" tests="nonsense" failures="1" errors="0">
    <testcase classname="backend.tests.test_money" name="test_window" file="${TEST_FILE}">
      <failure message="boom" type="AssertionError">traceback</failure>
    </testcase>
  </testsuite>
</testsuites>
`
const JUNIT_OFFSET_COUNTERS = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="A" tests="1" failures="0" errors="0">
    <testcase classname="backend.tests.test_money" name="test_window" file="${TEST_FILE}">
      <failure message="real failure but suite A declares failures=0" type="AssertionError">traceback</failure>
    </testcase>
  </testsuite>
  <testsuite name="B" tests="1" failures="1" errors="0">
    <testcase classname="backend.tests.test_money" name="test_pass" file="${TEST_FILE}"/>
  </testsuite>
</testsuites>
`
const JUNIT_MULTI_SUITE_OK = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="A" tests="1" failures="1" errors="0">
    <testcase classname="backend.tests.test_money" name="test_window" file="${TEST_FILE}">
      <failure message="boom" type="AssertionError">traceback</failure>
    </testcase>
  </testsuite>
  <testsuite name="B" tests="1" failures="0" errors="0">
    <testcase classname="backend.tests.test_money" name="test_pass" file="${TEST_FILE}"/>
  </testsuite>
</testsuites>
`

// --- R02: failure type fixtures -------------------------------------------
const JUNIT_TYPE_WITH_ASSERTION_MESSAGE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="pytest" tests="1" failures="0" errors="1">
    <testcase classname="backend.tests.test_money" name="test_window" file="${TEST_FILE}">
      <error message="expected AssertionError but got TypeError" type="TypeError">traceback</error>
    </testcase>
  </testsuite>
</testsuites>
`
const JUNIT_NO_TYPE_PYTEST_ASSERT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="pytest" tests="1" failures="1" errors="0">
    <testcase classname="backend.tests.test_money" name="test_window" file="${TEST_FILE}">
      <failure message="assert [1, 2] == [1, 2, 3]">traceback</failure>
    </testcase>
  </testsuite>
</testsuites>
`
const JUNIT_NO_TYPE_MESSAGE_MENTIONS_ASSERTION = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="pytest" tests="1" failures="1" errors="0">
    <testcase classname="backend.tests.test_money" name="test_window" file="${TEST_FILE}">
      <failure message="AssertionError but actually a different exception">traceback</failure>
    </testcase>
  </testsuite>
</testsuites>
`

// --- R04: file-level aggregation fixtures (same set, opposite order) ------
const FILE_CASE_PASS = `<testcase classname="backend.tests.test_money" name="test_pass" file="${TEST_FILE}"/>`
const FILE_CASE_FAIL = `<testcase classname="backend.tests.test_money" name="test_window" file="${TEST_FILE}"><failure message="assert 1 == 2" type="AssertionError">traceback</failure></testcase>`
const FILE_CASE_SKIP = `<testcase classname="backend.tests.test_money" name="test_skip" file="${TEST_FILE}"><skipped message="not run"/></testcase>`
const FILE_CASE_TYPE_ERROR = `<testcase classname="backend.tests.test_money" name="test_window" file="${TEST_FILE}"><error message="boom" type="TypeError">traceback</error></testcase>`
const fileReport = (cases, failures, errors, skipped) => `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="pytest" tests="${cases.length}" failures="${failures}" errors="${errors}" skipped="${skipped}">
    ${cases.join('\n    ')}
  </testsuite>
</testsuites>
`
const JUNIT_FILE_FAIL_FIRST = fileReport([FILE_CASE_FAIL, FILE_CASE_PASS], 1, 0, 0)
const JUNIT_FILE_PASS_FIRST = fileReport([FILE_CASE_PASS, FILE_CASE_FAIL], 1, 0, 0)
const JUNIT_FILE_ALL_PASS = fileReport([FILE_CASE_PASS], 0, 0, 0)
const JUNIT_FILE_ALL_SKIPPED = fileReport([FILE_CASE_SKIP], 0, 0, 1)
const JUNIT_FILE_WRONG_TYPE = fileReport([FILE_CASE_TYPE_ERROR, FILE_CASE_PASS], 0, 1, 0)
const JUNIT_FILE_MISSING = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="pytest" tests="1" failures="1" errors="0">
    <testcase classname="backend.tests.test_other" name="test_window" file="backend/tests/test_other.py"><failure message="boom" type="AssertionError">traceback</failure></testcase>
  </testsuite>
</testsuites>
`

function buildWorkspace(root) {
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  g(workspace, 'init', '-q', '-b', 'main')
  g(workspace, 'config', 'user.email', 'red-check@test.invalid')
  g(workspace, 'config', 'user.name', 'red check self-test')
  write(join(workspace, TEST_FILE), TEST_CONTENT)
  g(workspace, 'add', '.')
  g(workspace, 'commit', '-q', '-m', 'red commit')
  return { workspace, redCommit: g(workspace, 'rev-parse', 'HEAD').trim() }
}

function buildState(root, redCommit, { ticketId = 'ticket-1', acceptanceId = 'AC1', report = JUNIT_VALID, startedAt, reportDir = 'run-1', junitName = 'junit.xml', testFiles = [TEST_FILE], mtime } = {}) {
  const runDir = join(root, 'state', 'hephi', ticketId, 'checks', reportDir)
  mkdirSync(runDir, { recursive: true })
  write(join(runDir, 'run.json'), JSON.stringify({
    version: 3,
    ticketId,
    acceptanceId,
    phase: 'red',
    startedAt: startedAt ?? '2026-01-01T00:00:00Z',
    before: { headCommit: redCommit },
    testFiles,
  }, null, 2))
  write(join(runDir, junitName), report)
  if (mtime !== undefined) execFileSync('touch', ['-t', mtime, join(runDir, junitName)])
  return { stateDir: join(root, 'state'), runDir }
}

const CARD = {
  version: 3,
  acceptance: [{ id: 'AC1', tests: [`${TEST_FILE}::test_window`], check: 'tests' }],
  assertionFailureTypes: ['AssertionError'],
}

export function selfTest() {
  const results = []
  const root = mkdtempSync(join(tmpdir(), 'offline-red-self-'))
  try {
    const { workspace, redCommit } = buildWorkspace(root)
    const oldMtime = '200001010000' // P2 violation: report older than startedAt

    // AT-65: all four premises hold + AssertionError => valid.
    const fixture = buildState(join(root, 'ok'), redCommit, {})
    const okBatch = evaluateBatch({ stateDir: fixture.stateDir, workspace, taskCards: { 'ticket-1': CARD }, now: '2026-03-01T00:00:00Z' })
    const okItem = okBatch.tickets[0].acceptance[0]
    pass(results, 'T18 AT-65 four premises hold + AssertionError => valid', okItem.red === 'valid', JSON.stringify(okItem))
    pass(results, 'T18 AT-65 coverage counts the valid red item (1/1)', okBatch.coverage.valid === 1 && okBatch.coverage.needRed === 1 && okBatch.coverage.ratio === 1, JSON.stringify(okBatch.coverage))
    pass(results, 'T18 output is batch-local, not an experiment result', okBatch.generatedBy === 'eval/offline-red-check.mjs' && /not an experiment result/.test(okBatch.inputs.note) && okBatch.tickets[0].ticketId === 'ticket-1')

    // AT-65: each broken premise => invalid (P1/P2/P3/P4).
    const p1 = buildState(join(root, 'p1'), redCommit, { report: JUNIT_MISSING_CASE })
    const p1Item = evaluateBatch({ stateDir: p1.stateDir, workspace, taskCards: { 'ticket-1': CARD } }).tickets[0].acceptance[0]
    pass(results, 'T18 AT-65 P1 missing target case => invalid', p1Item.red === 'invalid' && p1Item.reason.startsWith('P1:'), JSON.stringify(p1Item))

    const p2 = buildState(join(root, 'p2'), redCommit, { startedAt: '2026-06-01T00:00:00Z', mtime: oldMtime })
    const p2Item = evaluateBatch({ stateDir: p2.stateDir, workspace, taskCards: { 'ticket-1': CARD } }).tickets[0].acceptance[0]
    pass(results, 'T18 AT-65 P2 stale report mtime => invalid', p2Item.red === 'invalid' && p2Item.reason.startsWith('P2:'), JSON.stringify(p2Item))

    const p3 = buildState(join(root, 'p3'), redCommit, {})
    write(join(workspace, TEST_FILE), `${TEST_CONTENT}# local edit not in the red commit\n`)
    const p3Item = evaluateBatch({ stateDir: p3.stateDir, workspace, taskCards: { 'ticket-1': CARD } }).tickets[0].acceptance[0]
    write(join(workspace, TEST_FILE), TEST_CONTENT)
    pass(results, 'T18 AT-65 P3 test file hash differs from red commit => invalid', p3Item.red === 'invalid' && p3Item.reason.startsWith('P3:'), JSON.stringify(p3Item))

    const p4 = buildState(join(root, 'p4'), redCommit, { report: JUNIT_NO_COUNTERS })
    const p4Item = evaluateBatch({ stateDir: p4.stateDir, workspace, taskCards: { 'ticket-1': CARD } }).tickets[0].acceptance[0]
    pass(results, 'T18 AT-65 P4 missing failures/errors counters => invalid', p4Item.red === 'invalid' && p4Item.reason.startsWith('P4:'), JSON.stringify(p4Item))

    const p4broken = buildState(join(root, 'p4-broken'), redCommit, { report: JUNIT_NOT_XML })
    const p4BrokenItem = evaluateBatch({ stateDir: p4broken.stateDir, workspace, taskCards: { 'ticket-1': CARD } }).tickets[0].acceptance[0]
    pass(results, 'T18 AT-65 P4 unparsable report => invalid', p4BrokenItem.red === 'invalid' && p4BrokenItem.reason.startsWith('P4:'), JSON.stringify(p4BrokenItem))

    const p2outside = buildState(join(root, 'p2-outside'), redCommit, { junitName: '../junit-outside.xml' })
    const p2OutsideItem = evaluateBatch({ stateDir: p2outside.stateDir, workspace, taskCards: { 'ticket-1': CARD } }).tickets[0].acceptance[0]
    pass(results, 'T18 AT-65 P2 report outside the run directory => invalid', p2OutsideItem.red === 'invalid' && p2OutsideItem.reason.startsWith('P2:'), JSON.stringify(p2OutsideItem))

    // AT-66: TypeError failure type does not match the default AssertionError.
    const typeError = buildState(join(root, 'type-error'), redCommit, { report: JUNIT_TYPE_ERROR })
    const typeErrorItem = evaluateBatch({ stateDir: typeError.stateDir, workspace, taskCards: { 'ticket-1': CARD } }).tickets[0].acceptance[0]
    pass(results, 'T18 AT-66 TypeError failure => invalid', typeErrorItem.red === 'invalid' && /AT-66/.test(typeErrorItem.reason), JSON.stringify(typeErrorItem))
    const configured = evaluateBatch({ stateDir: typeError.stateDir, workspace, taskCards: { 'ticket-1': { ...CARD, assertionFailureTypes: ['TypeError'] } } }).tickets[0].acceptance[0]
    pass(results, 'T18 AT-66 configured failure type is honoured', configured.red === 'valid', JSON.stringify(configured))

    // AT-67: one item needs red (valid) and one already passes on baseline => denominator 1.
    const coverageRoot = join(root, 'coverage')
    const coverageState = buildState(coverageRoot, redCommit, {})
    const coverageCard = {
      version: 3,
      acceptance: [
        { id: 'AC1', tests: [`${TEST_FILE}::test_window`], check: 'tests' },
        { id: 'AC2', tests: [`${TEST_FILE}::test_window`], check: 'tests', baselinePasses: true },
      ],
      assertionFailureTypes: ['AssertionError'],
    }
    const coverage = evaluateBatch({ stateDir: coverageState.stateDir, workspace, taskCards: { 'ticket-1': coverageCard } })
    const ac1 = coverage.tickets[0].acceptance.find(item => item.id === 'AC1')
    const ac2 = coverage.tickets[0].acceptance.find(item => item.id === 'AC2')
    pass(results, 'T18 AT-67 baseline-pass item stays absent and is not required', ac2.red === 'absent' && ac2.baselinePasses === true && ac2.redStateRequired === false, JSON.stringify(ac2))
    pass(results, 'T18 AT-67 coverage denominator excludes baseline-pass items (1/1)', coverage.coverage.valid === 1 && coverage.coverage.needRed === 1 && coverage.coverage.ratio === 1, JSON.stringify(coverage.coverage))
    pass(results, 'T18 AT-67 valid item covers the required red state', ac1.red === 'valid' && ac1.redStateRequired === true, JSON.stringify(ac1))

    // AT-68: missing target case / skipped target case => invalid.
    const missing = buildState(join(root, 'missing'), redCommit, { report: JUNIT_MISSING_CASE })
    const missingItem = evaluateBatch({ stateDir: missing.stateDir, workspace, taskCards: { 'ticket-1': CARD } }).tickets[0].acceptance[0]
    pass(results, 'T18 AT-68 missing target case => invalid', missingItem.red === 'invalid', JSON.stringify(missingItem))
    const skipped = buildState(join(root, 'skipped'), redCommit, { report: JUNIT_SKIPPED })
    const skippedItem = evaluateBatch({ stateDir: skipped.stateDir, workspace, taskCards: { 'ticket-1': CARD } }).tickets[0].acceptance[0]
    pass(results, 'T18 AT-68 skipped target case => invalid', skippedItem.red === 'invalid' && /AT-68/.test(skippedItem.reason), JSON.stringify(skippedItem))

    // R01: report integrity / counter consistency.
    const truncated = buildState(join(root, 'r01-truncated'), redCommit, { report: JUNIT_TRUNCATED })
    const truncatedItem = evaluateBatch({ stateDir: truncated.stateDir, workspace, taskCards: { 'ticket-1': CARD } }).tickets[0].acceptance[0]
    pass(results, 'R01 truncated report => invalid', truncatedItem.red === 'invalid' && truncatedItem.reason.startsWith('P4:'), JSON.stringify(truncatedItem))

    const mismatched = buildState(join(root, 'r01-mismatched'), redCommit, { report: JUNIT_MISMATCHED_TAGS })
    const mismatchedItem = evaluateBatch({ stateDir: mismatched.stateDir, workspace, taskCards: { 'ticket-1': CARD } }).tickets[0].acceptance[0]
    pass(results, 'R01 mismatched closing tag => invalid', mismatchedItem.red === 'invalid' && mismatchedItem.reason.startsWith('P4:'), JSON.stringify(mismatchedItem))

    const counterMismatch = buildState(join(root, 'r01-counters'), redCommit, { report: JUNIT_COUNTER_MISMATCH })
    const counterMismatchItem = evaluateBatch({ stateDir: counterMismatch.stateDir, workspace, taskCards: { 'ticket-1': CARD } }).tickets[0].acceptance[0]
    pass(results, 'R01 declared failures=0 but a <failure> node exists => invalid', counterMismatchItem.red === 'invalid' && counterMismatchItem.reason.startsWith('P4:') && /counters disagree/.test(counterMismatchItem.reason), JSON.stringify(counterMismatchItem))

    const testsMismatch = buildState(join(root, 'r01-tests-count'), redCommit, { report: JUNIT_TESTS_COUNT_MISMATCH })
    const testsMismatchItem = evaluateBatch({ stateDir: testsMismatch.stateDir, workspace, taskCards: { 'ticket-1': CARD } }).tickets[0].acceptance[0]
    pass(results, 'R01 declared tests=5 but 1 testcase node => invalid', testsMismatchItem.red === 'invalid' && testsMismatchItem.reason.startsWith('P4:'), JSON.stringify(testsMismatchItem))

    // N06: counter integrity gaps (duplicate attrs, non-numeric counters, per-suite offsetting).
    const dupAttr = buildState(join(root, 'n06-dup-attr'), redCommit, { report: JUNIT_DUP_ATTR })
    const dupAttrItem = evaluateBatch({ stateDir: dupAttr.stateDir, workspace, taskCards: { 'ticket-1': CARD } }).tickets[0].acceptance[0]
    pass(results, 'N06 duplicate attribute is rejected', dupAttrItem.red === 'invalid' && dupAttrItem.reason.startsWith('P4:') && /duplicate attribute/.test(dupAttrItem.reason), JSON.stringify(dupAttrItem))

    const nonNumeric = buildState(join(root, 'n06-nonnumeric'), redCommit, { report: JUNIT_NONNUM_COUNTER })
    const nonNumericItem = evaluateBatch({ stateDir: nonNumeric.stateDir, workspace, taskCards: { 'ticket-1': CARD } }).tickets[0].acceptance[0]
    pass(results, 'N06 non-numeric tests counter is rejected (not skipped)', nonNumericItem.red === 'invalid' && nonNumericItem.reason.startsWith('P4:') && /counters invalid/.test(nonNumericItem.reason), JSON.stringify(nonNumericItem))

    const offsetCounters = buildState(join(root, 'n06-offset'), redCommit, { report: JUNIT_OFFSET_COUNTERS })
    const offsetCountersItem = evaluateBatch({ stateDir: offsetCounters.stateDir, workspace, taskCards: { 'ticket-1': CARD } }).tickets[0].acceptance[0]
    pass(results, 'N06 per-suite counters: cross-suite offsetting is rejected', offsetCountersItem.red === 'invalid' && offsetCountersItem.reason.startsWith('P4:') && /counters disagree in testsuite/.test(offsetCountersItem.reason), JSON.stringify(offsetCountersItem))

    const multiSuiteOk = buildState(join(root, 'n06-multisuite-ok'), redCommit, { report: JUNIT_MULTI_SUITE_OK })
    const multiSuiteOkItem = evaluateBatch({ stateDir: multiSuiteOk.stateDir, workspace, taskCards: { 'ticket-1': CARD } }).tickets[0].acceptance[0]
    pass(results, 'N06 complete normal two-suite report still passes', multiSuiteOkItem.red === 'valid', JSON.stringify(multiSuiteOkItem))

    // R02: explicit type decides; message mentioning AssertionError cannot override TypeError.
    const typeMessage = buildState(join(root, 'r02-type-message'), redCommit, { report: JUNIT_TYPE_WITH_ASSERTION_MESSAGE })
    const typeMessageItem = evaluateBatch({ stateDir: typeMessage.stateDir, workspace, taskCards: { 'ticket-1': CARD } }).tickets[0].acceptance[0]
    pass(results, 'R02 type=TypeError with AssertionError in message => invalid', typeMessageItem.red === 'invalid' && /AT-66/.test(typeMessageItem.reason), JSON.stringify(typeMessageItem))

    const noTypePytest = buildState(join(root, 'r02-no-type'), redCommit, { report: JUNIT_NO_TYPE_PYTEST_ASSERT })
    const noTypePytestItem = evaluateBatch({ stateDir: noTypePytest.stateDir, workspace, taskCards: { 'ticket-1': CARD } }).tickets[0].acceptance[0]
    pass(results, 'R02 no-type pytest plain assert message => valid', noTypePytestItem.red === 'valid', JSON.stringify(noTypePytestItem))

    const noTypeMention = buildState(join(root, 'r02-no-type-mention'), redCommit, { report: JUNIT_NO_TYPE_MESSAGE_MENTIONS_ASSERTION })
    const noTypeMentionItem = evaluateBatch({ stateDir: noTypeMention.stateDir, workspace, taskCards: { 'ticket-1': CARD } }).tickets[0].acceptance[0]
    pass(results, 'R02 no-type arbitrary message mentioning AssertionError => invalid', noTypeMentionItem.red === 'invalid' && /AT-66/.test(noTypeMentionItem.reason), JSON.stringify(noTypeMentionItem))

    // R03: symlinked report escaping the run directory is not owned by the run.
    const externalDir = join(root, 'external-report')
    const externalReport = join(externalDir, 'junit.xml')
    write(externalReport, JUNIT_VALID)
    execFileSync('touch', ['-t', '202601010000', externalReport])
    const symlinkFixture = buildState(join(root, 'r03-symlink'), redCommit, {})
    rmSync(join(symlinkFixture.runDir, 'junit.xml'))
    symlinkSync(externalReport, join(symlinkFixture.runDir, 'junit.xml'))
    const symlinkItem = evaluateBatch({ stateDir: symlinkFixture.stateDir, workspace, taskCards: { 'ticket-1': CARD } }).tickets[0].acceptance[0]
    pass(results, 'R03 junit.xml symlink to a report outside the run dir => invalid', symlinkItem.red === 'invalid' && symlinkItem.reason.startsWith('P2:') && /symlink|outside/.test(symlinkItem.reason), JSON.stringify(symlinkItem))

    const outsideParent = join(root, 'r03-outside-parent')
    const outsideRun = buildState(outsideParent, redCommit, {})
    const linkedDir = join(root, 'external-dir')
    write(join(linkedDir, 'junit.xml'), JUNIT_VALID)
    symlinkSync(linkedDir, join(outsideRun.runDir, 'reports'))
    write(join(outsideRun.runDir, 'run.json'), JSON.stringify({
      version: 3,
      ticketId: 'ticket-1',
      acceptanceId: 'AC1',
      phase: 'red',
      startedAt: '2026-01-01T00:00:00Z',
      before: { headCommit: redCommit },
      testFiles: [TEST_FILE],
      junit: 'reports/junit.xml',
    }, null, 2))
    const outsideParentItem = evaluateBatch({ stateDir: outsideRun.stateDir, workspace, taskCards: { 'ticket-1': CARD } }).tickets[0].acceptance[0]
    pass(results, 'R03 report under a symlinked parent outside the run dir => invalid', outsideParentItem.red === 'invalid' && outsideParentItem.reason.startsWith('P2:'), JSON.stringify(outsideParentItem))

    // R04: file-level spec aggregates every matching testcase; report order is irrelevant.
    const FILE_CARD = { version: 3, acceptance: [{ id: 'AC1', tests: [TEST_FILE], check: 'tests' }], assertionFailureTypes: ['AssertionError'] }
    const fileFailFirst = buildState(join(root, 'r04-fail-first'), redCommit, { report: JUNIT_FILE_FAIL_FIRST })
    const filePassFirst = buildState(join(root, 'r04-pass-first'), redCommit, { report: JUNIT_FILE_PASS_FIRST })
    const failFirstItem = evaluateBatch({ stateDir: fileFailFirst.stateDir, workspace, taskCards: { 'ticket-1': FILE_CARD } }).tickets[0].acceptance[0]
    const passFirstItem = evaluateBatch({ stateDir: filePassFirst.stateDir, workspace, taskCards: { 'ticket-1': FILE_CARD } }).tickets[0].acceptance[0]
    pass(results, 'R04 file-level pass+failure: failure-first => valid', failFirstItem.red === 'valid', JSON.stringify(failFirstItem))
    pass(results, 'R04 file-level pass+failure: pass-first => valid (order invariant)', passFirstItem.red === 'valid', JSON.stringify(passFirstItem))
    pass(results, 'R04 same testcase set in either order => same verdict', failFirstItem.red === passFirstItem.red, `${failFirstItem.red} vs ${passFirstItem.red}`)

    const fileAllPass = buildState(join(root, 'r04-all-pass'), redCommit, { report: JUNIT_FILE_ALL_PASS })
    const fileAllPassItem = evaluateBatch({ stateDir: fileAllPass.stateDir, workspace, taskCards: { 'ticket-1': FILE_CARD } }).tickets[0].acceptance[0]
    pass(results, 'R04 file-level all testcases pass => invalid (no failure)', fileAllPassItem.red === 'invalid' && /passed in the report/.test(fileAllPassItem.reason), JSON.stringify(fileAllPassItem))

    const fileAllSkipped = buildState(join(root, 'r04-all-skipped'), redCommit, { report: JUNIT_FILE_ALL_SKIPPED })
    const fileAllSkippedItem = evaluateBatch({ stateDir: fileAllSkipped.stateDir, workspace, taskCards: { 'ticket-1': FILE_CARD } }).tickets[0].acceptance[0]
    pass(results, 'R04 file-level all testcases skipped => invalid (AT-68)', fileAllSkippedItem.red === 'invalid' && /AT-68/.test(fileAllSkippedItem.reason), JSON.stringify(fileAllSkippedItem))

    const fileWrongType = buildState(join(root, 'r04-wrong-type'), redCommit, { report: JUNIT_FILE_WRONG_TYPE })
    const fileWrongTypeItem = evaluateBatch({ stateDir: fileWrongType.stateDir, workspace, taskCards: { 'ticket-1': FILE_CARD } }).tickets[0].acceptance[0]
    pass(results, 'R04 file-level failure type mismatch => invalid (AT-66)', fileWrongTypeItem.red === 'invalid' && /AT-66/.test(fileWrongTypeItem.reason), JSON.stringify(fileWrongTypeItem))

    const fileMissing = buildState(join(root, 'r04-missing'), redCommit, { report: JUNIT_FILE_MISSING })
    const fileMissingItem = evaluateBatch({ stateDir: fileMissing.stateDir, workspace, taskCards: { 'ticket-1': FILE_CARD } }).tickets[0].acceptance[0]
    pass(results, 'R04 file-level no matching testcase => invalid (P1)', fileMissingItem.red === 'invalid' && fileMissingItem.reason.startsWith('P1:'), JSON.stringify(fileMissingItem))

    // absent: no phase === 'red' run is not a failure, just not observed.
    const nonRedRoot = join(root, 'non-red')
    const nonRedRun = join(nonRedRoot, 'state', 'hephi', 'ticket-1', 'checks', 'run-1')
    mkdirSync(nonRedRun, { recursive: true })
    write(join(nonRedRun, 'run.json'), JSON.stringify({ phase: 'green', startedAt: '2026-01-01T00:00:00Z', before: { headCommit: redCommit } }))
    write(join(nonRedRun, 'junit.xml'), JUNIT_VALID)
    const nonRed = evaluateBatch({ stateDir: join(nonRedRoot, 'state'), workspace, taskCards: { 'ticket-1': CARD } }).tickets[0].acceptance[0]
    pass(results, 'T18 only phase=red records are treated as red states (absent otherwise)', nonRed.red === 'absent', JSON.stringify(nonRed))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  for (const line of results) console.log(line)
  const failed = results.filter(line => line.startsWith('FAIL')).length
  if (failed > 0) { console.log(`\nFAILED: ${failed} assertion(s)`); return 1 }
  console.log(`\nPASS: ${results.length} assertions (offline-red-check self-test)`)
  return 0
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
      const taskCards = loadTaskCards(options)
      const checkConfig = options.checkConfig === null ? null : readJson(options.checkConfig, '--check-config')
      const batch = evaluateBatch({ stateDir: options.stateDir, workspace: options.workspace, taskCards, checkConfig })
      const text = `${JSON.stringify(batch, null, 2)}\n`
      if (options.dryRun) process.stdout.write(text)
      else writeFileSync(options.out, text)
      if (!options.dryRun) console.error(`red-state report written: ${options.out} (items=${batch.totals.items}, valid=${batch.totals.valid}, needRed=${batch.totals.redStateRequired}, coverage=${batch.coverage.ratio})`)
    } catch (error) {
      const usageError = error instanceof UsageError
      console.error(error instanceof Error ? error.message : String(error))
      if (usageError) { console.error(usage()); process.exitCode = 2 } else process.exitCode = 1
    }
  }
}
