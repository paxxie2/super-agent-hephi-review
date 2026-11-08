#!/usr/bin/env node
// P12 盲评一致性：按冻结口径计算 Cohen's kappa，只有达到门槛才算通过。
// 输入 JSON：{ "labels": ["pass","fail"], "items": [{ "id": "...", "raterA": "pass", "raterB": "fail" }, ...] }
// 用法：node eval/kappa.mjs --scores <file.json> [--min 0.7]
import { existsSync, readFileSync } from 'node:fs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const file = arg('scores')
const min = Number(arg('min', '0.7'))
if (!file) {
  console.error('usage: node eval/kappa.mjs --scores <file.json> [--min 0.7]')
  process.exit(2)
}
if (!existsSync(file)) {
  console.error(`评分文件不存在：${file}`)
  process.exit(2)
}

let data
try {
  data = JSON.parse(readFileSync(file, 'utf8'))
} catch (error) {
  console.error(`评分文件不是合法 JSON：${error.message}`)
  process.exit(2)
}

const items = Array.isArray(data.items) ? data.items : []
if (items.length === 0) {
  console.error('items 为空，无法计算 kappa')
  process.exit(2)
}
const labels = Array.isArray(data.labels) && data.labels.length > 0
  ? data.labels
  : [...new Set(items.flatMap((item) => [item.raterA, item.raterB]))]
// K01：与 eval/stats/kappa.py 同口径——labels 有重复项直接拒绝（重复类别会把 pe 抬到 2、
// kappa 虚高为 1），不得继续计算。
if (new Set(labels).size !== labels.length) {
  console.error(`labels 有重复项：${labels.join(',')}（与 eval/stats/kappa.py 的拒绝口径一致）`)
  process.exit(2)
}
for (const item of items) {
  for (const key of ['raterA', 'raterB']) {
    if (!labels.includes(item[key])) {
      console.error(`未知标签 ${String(item[key])}（${item.id ?? '?'}），labels=${labels.join(',')}`)
      process.exit(2)
    }
  }
}

const n = items.length
const observed = items.filter((item) => item.raterA === item.raterB).length / n
const expected = labels.reduce((sum, label) => {
  const a = items.filter((item) => item.raterA === label).length / n
  const b = items.filter((item) => item.raterB === label).length / n
  return sum + a * b
}, 0)
const kappa = expected === 1 ? null : (observed - expected) / (1 - expected)
const pass = kappa !== null && kappa >= min

console.log(JSON.stringify({ file, n, labels, po: observed, pe: expected, kappa, min, pass }, null, 2))
if (kappa === null) console.error('两名评分者分布完全一致（pe=1），kappa 无定义，需补充样本或改口径')
process.exit(pass ? 0 : 1)
