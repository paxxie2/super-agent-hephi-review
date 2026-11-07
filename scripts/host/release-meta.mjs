#!/usr/bin/env node
// 发布包元数据与校验工具（deploy-hephi.sh 专用，零依赖、只读校验 + 只写 incoming 目录）。
//
// 子命令：
//   prepare --build <dir> --incoming <dir> --sha <40hex> --tree <40hex>
//           --host-version <v> --node <path> --node-version <v> --peer-root <dir|"">
//     读取构建目录的 package.json/pnpm-lock.yaml，把生产依赖与显式 peer 解析写进
//     incoming：创建 incoming/node_modules/<peer> -> <peer-root>/<peer> 的符号链接，
//     校验每个 dependencies 都已随包，计算 node_modules 树哈希与 index/tools 入口哈希，
//     最后写 incoming/meta.json。
//   check --release <dir> --sha <sha>
//     校验不可变 release：meta 基本字段、入口哈希、依赖锁文件/树哈希、peer 链接。
//     旧格式 meta（无 entries/dependencies/activation）按历史字段校验，保持可回滚。
//   activation --release <dir>
//     输出 required:<entry,...>、legacy 或 none，供部署脚本判定激活门禁。
//   tree-hash --dir <dir>
//     输出目录的确定性树哈希（文件内容 + 符号链接目标），不存在时输出 null。
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

function fail(message) {
  console.error(message)
  process.exit(1)
}

function args(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) fail(`unexpected argument: ${key}`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) fail(`missing value for ${key}`)
    out[key.slice(2)] = value
    i += 1
  }
  return out
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

export function treeHash(root) {
  if (!existsSync(root)) return null
  const rows = []
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name)
      const row = rel === '' ? name : `${rel}/${name}`
      const stat = lstatSync(file)
      if (stat.isSymbolicLink()) {
        rows.push(`${row}|link|${readlinkSync(file)}`)
      } else if (stat.isDirectory()) {
        walk(file, row)
      } else {
        rows.push(`${row}|file|${sha256File(file)}`)
      }
    }
  }
  walk(root, '')
  return createHash('sha256').update(rows.join('\n')).digest('hex')
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`cannot read JSON ${file}: ${error.message}`)
  }
}

function lstatExists(file) {
  try {
    lstatSync(file)
    return true
  } catch {
    return false
  }
}

function shaOf(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) fail(`${label} must be a full 40-char SHA, got ${String(value)}`)
  return value
}

function entryFiles() {
  return ['index', 'tools']
}

function prepare(options) {
  const buildDir = resolve(options.build)
  const incoming = resolve(options.incoming)
  const sha = shaOf(options.sha, '--sha')
  const tree = shaOf(options['tree'], '--tree')
  const hostVersion = options['host-version']
  if (typeof hostVersion !== 'string' || hostVersion.trim() === '') fail('--host-version must be a non-empty single-line value')
  const nodeCommand = options.node ?? 'node'
  const nodeVersion = options['node-version'] ?? 'unknown'
  const peerRoot = options['peer-root'] ?? ''
  const pkg = readJson(join(buildDir, 'package.json'))
  const lockfile = join(incoming, 'pnpm-lock.yaml')
  if (!existsSync(lockfile)) fail(`the release copy is missing pnpm-lock.yaml: ${lockfile}`)

  // 1) 生产依赖必须已从同一冻结 lockfile 打进 incoming（不依赖源码工作区 node_modules）。
  //    版本在 peer 链接之后读取：同名依赖被宿主 peer 覆盖时，记录的是最终随包版本。

  // 2) peer 解析必须显式：链接到部署时提供的宿主 peer 根，不猜、不依赖源码 node_modules。
  const peers = {}
  const peersReplaced = []
  const peerDependencies = pkg.peerDependencies ?? {}
  const peerMeta = pkg.peerDependenciesMeta ?? {}
  if (Object.keys(peerDependencies).length > 0 && peerRoot === '') {
    fail('package.json declares peerDependencies; --peer-root <dir> is required so peer resolution is explicit')
  }
  if (peerRoot !== '') {
    for (const name of Object.keys(peerDependencies)) {
      const target = join(peerRoot, name)
      const optional = peerMeta[name]?.optional === true
      if (!existsSync(join(target, 'package.json'))) {
        if (optional) {
          peers[name] = 'optional-missing'
          continue
        }
        fail(`host peer package is missing in --peer-root ${peerRoot}: ${name}`)
      }
      const dest = join(incoming, 'node_modules', name)
      mkdirSync(join(dest, '..'), { recursive: true })
      // 生产安装可能已把同名包放进 incoming（autoInstallPeers 或它同时是生产依赖）。
      // 只在 incoming 内替换该入口，再显式链接 --peer-root；不改构建目录、不改宿主。
      if (lstatExists(dest)) {
        rmSync(dest, { recursive: true, force: true })
        peersReplaced.push(name)
      }
      symlinkSync(target, dest)
      peers[name] = target
    }
  }

  // 3) 校验并记录最终随包的生产依赖版本（含被宿主 peer 覆盖后的版本）。
  const resolved = {}
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    const file = join(incoming, 'node_modules', name, 'package.json')
    if (!existsSync(file)) fail(`production dependency was not packaged for ${sha}: ${name}`)
    resolved[name] = readJson(file).version ?? null
  }

  // 3) 入口哈希（index + tools）与依赖树哈希进入不可变 meta，后续校验可发现篡改。
  const entries = {}
  for (const name of entryFiles()) {
    const file = join(incoming, 'lib', `${name}.mjs`)
    if (!existsSync(file)) fail(`the build produced no lib/${name}.mjs for ${sha}`)
    entries[name] = sha256File(file)
  }
  const nodeModulesSha256 = treeHash(join(incoming, 'node_modules'))
  const meta = {
    formatVersion: 1,
    pluginCommit: sha,
    sourceTree: tree,
    entrySha256: entries.index,
    entries,
    builtAt: new Date().toISOString(),
    buildCommand: 'pnpm install --frozen-lockfile && pnpm check && pnpm install --prod --frozen-lockfile --offline',
    hostVersion,
    source: 'git-archive',
    node: { command: nodeCommand, version: nodeVersion },
    activation: { markerVersion: 1, entries: entryFiles(), marker: '[hephi-activation]' },
    dependencies: {
      lockfileSha256: sha256File(lockfile),
      nodeModulesSha256,
      resolved,
      peers,
      peersReplaced,
    },
  }
  writeFileSync(join(incoming, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  process.stdout.write(JSON.stringify({ pluginCommit: sha, entries, nodeModulesSha256, resolved, peers }))
}

function check(options) {
  const dir = resolve(options.release)
  const metaFile = join(dir, 'meta.json')
  if (!existsSync(metaFile)) fail(`release meta missing: ${metaFile}`)
  const meta = readJson(metaFile)
  if (meta.formatVersion !== 1) fail(`unsupported release meta format: ${meta.formatVersion}`)
  const expected = options.sha
  if (expected !== undefined && shaOf(expected, '--sha') !== meta.pluginCommit) {
    fail(`release meta pluginCommit does not match directory: ${meta.pluginCommit} vs ${expected}`)
  }
  if (typeof meta.hostVersion !== 'string' || meta.hostVersion.trim() === '') fail('release meta is missing hostVersion')
  if (!existsSync(join(dir, 'lib', 'index.mjs'))) fail(`release lib missing: ${join(dir, 'lib', 'index.mjs')}`)

  // 入口哈希：新格式校验 entries（index+tools）；旧格式沿用 entrySha256。
  if (meta.entries && typeof meta.entries === 'object') {
    for (const name of entryFiles()) {
      const want = meta.entries[name]
      if (typeof want !== 'string' || !/^[0-9a-f]{64}$/.test(want)) fail(`release meta is missing entries.${name} hash`)
      const file = join(dir, 'lib', `${name}.mjs`)
      if (!existsSync(file)) fail(`release entry missing: ${file}`)
      if (sha256File(file) !== want) fail(`entry hash mismatch: ${file}`)
    }
    if (typeof meta.entrySha256 !== 'string' || meta.entrySha256 !== meta.entries.index) fail('release meta entrySha256 does not match entries.index')
  } else {
    if (typeof meta.entrySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(meta.entrySha256)) fail('invalid entrySha256 in release meta')
    if (sha256File(join(dir, 'lib', 'index.mjs')) !== meta.entrySha256) fail(`entry hash mismatch: ${dir}`)
  }

  // 依赖记录：只有新格式 meta 才有；旧格式按历史语义接受（回滚边界）。
  if (meta.dependencies && typeof meta.dependencies === 'object') {
    const deps = meta.dependencies
    const lockfile = join(dir, 'pnpm-lock.yaml')
    if (!existsSync(lockfile)) fail(`release dependency record is missing pnpm-lock.yaml: ${lockfile}`)
    if (sha256File(lockfile) !== deps.lockfileSha256) fail(`release lockfile hash mismatch: ${lockfile}`)
    if (deps.nodeModulesSha256 !== null && deps.nodeModulesSha256 !== undefined) {
      const actual = treeHash(join(dir, 'node_modules'))
      if (actual !== deps.nodeModulesSha256) fail(`release dependency tree hash mismatch: ${join(dir, 'node_modules')}`)
    }
    for (const [name, version] of Object.entries(deps.resolved ?? {})) {
      const file = join(dir, 'node_modules', name, 'package.json')
      if (!existsSync(file)) fail(`release is missing production dependency: ${name}`)
      const actual = readJson(file).version ?? null
      if (actual !== version) fail(`release production dependency version mismatch: ${name} ${String(actual)} vs ${String(version)}`)
    }
    for (const [name, target] of Object.entries(deps.peers ?? {})) {
      if (target === 'optional-missing') continue
      if (!existsSync(join(dir, 'node_modules', name))) fail(`release is missing the explicit peer link: ${name}`)
      if (!existsSync(join(target, 'package.json'))) fail(`peer target is unavailable on this host: ${name} -> ${target}`)
    }
  }
  // 新格式 release 必须带 activation 元数据：缺少时 fail-closed，禁止静默退回 health-only 门禁。
  if (meta.entries || meta.dependencies) {
    const activation = meta.activation
    if (!activation || activation.markerVersion !== 1 || !Array.isArray(activation.entries) || activation.entries.length === 0) {
      fail('new-format release is missing activation metadata; refusing to fall back to the health-only gate')
    }
    for (const name of entryFiles()) {
      if (!activation.entries.includes(name)) fail(`release activation metadata does not cover the ${name} entry`)
    }
  }
  process.stdout.write(JSON.stringify({ ok: true, pluginCommit: meta.pluginCommit, activation: meta.activation ?? null }))
}

function activation(options) {
  const dir = resolve(options.release)
  const metaFile = join(dir, 'meta.json')
  if (!existsSync(metaFile)) {
    process.stdout.write('none')
    return
  }
  const meta = readJson(metaFile)
  if (meta.activation && meta.activation.markerVersion === 1 && Array.isArray(meta.activation.entries) && meta.activation.entries.length > 0) {
    process.stdout.write(`required:${meta.activation.entries.join(',')}`)
    return
  }
  // 新格式 release（有依赖/入口记录）缺 activation 视为 invalid，绝不静默降级。
  if (meta.entries || meta.dependencies) {
    process.stdout.write('invalid')
    return
  }
  process.stdout.write('legacy')
}

const [command, ...rest] = process.argv.slice(2)
const options = args(rest)
if (command === 'prepare') prepare(options)
else if (command === 'check') check(options)
else if (command === 'activation') activation(options)
else if (command === 'tree-hash') {
  if (!options.dir) fail('tree-hash requires --dir')
  process.stdout.write(String(treeHash(resolve(options.dir))))
} else fail(`unknown command: ${String(command)}`)
