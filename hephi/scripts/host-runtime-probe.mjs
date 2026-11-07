#!/usr/bin/env node
// 一次性本地 DSH profile 的 jobs.get/readAt 运行期探针（仅证据工具，不参与产品部署）。
//
// 用途：在一个可销毁、无业务源的 DSH profile 中加载本插件，订阅真实 job 事件，
// 对真实原生 bash Job 记录：本 Session 终态、错误 Session 拒绝、完整输出、
// 截断/lossy、readAt 文本，以及该 Job 的命令输出（可用于 H6/网络边界的受控尝试）。
// 输出只写到 HEPHI_RUNTIME_PROBE_OUT 指定的临时文件；不修改宿主仓库或生产配置。
//
// 环境变量：
//   HEPHI_RUNTIME_PROBE_OUT              必填，报告 JSON 路径（建议 /tmp 下）
//   HEPHI_RUNTIME_PROBE_HOST             可选，来源标签，默认 disposable-local-profile
//   HEPHI_RUNTIME_PROBE_PROFILE          可选，profile 名，默认 probe
//   HEPHI_RUNTIME_PROBE_FOREIGN_SESSION  可选，用于错误 Session 拒绝测试的其它 session id
//
// 限制：这是可销毁 profile 上的运行期行为证据，不是 A1-BIND 端到端验收，
// 也不能替代真实生产 Session 的检查；报告不得提交会话内容或凭据。
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'hephi-host-runtime-probe'
export const inject = ['jobs']

function chunkText(chunks) {
  return (chunks ?? []).map((chunk) => (typeof chunk.text === 'string' ? chunk.text : '')).join('')
}

function chunkBytes(chunks) {
  return (chunks ?? []).reduce((total, chunk) => total + Buffer.byteLength(typeof chunk.text === 'string' ? chunk.text : '', 'utf8'), 0)
}

export function apply(ctx) {
  const outFile = process.env.HEPHI_RUNTIME_PROBE_OUT
  if (!outFile) {
    console.error('[hephi-runtime-probe] HEPHI_RUNTIME_PROBE_OUT is not set; probe is inert')
    return
  }
  const hostLabel = process.env.HEPHI_RUNTIME_PROBE_HOST || 'disposable-local-profile'
  const profile = process.env.HEPHI_RUNTIME_PROBE_PROFILE || 'probe'
  const foreignSession = process.env.HEPHI_RUNTIME_PROBE_FOREIGN_SESSION || 'session-hephi-runtime-probe-foreign'
  const records = []
  let nativeBashLossy = null
  let flushError = null

  const flush = (extra = {}) => {
    const report = {
      generatedBy: 'hephi-host-runtime-probe',
      host: hostLabel,
      profile,
      pid: process.pid,
      node: process.version,
      generatedAt: new Date().toISOString(),
      jobCount: records.length,
      jobs: records,
      nativeBashLossy,
      ...extra,
    }
    try {
      mkdirSync(dirname(outFile), { recursive: true })
      writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    } catch (error) {
      flushError = error.message
    }
  }

  // 截断/lossy 语义：前台 agent Job 在工具收集后会被移除，ring 只在“消费读”时裁剪到 settled cap。
  // 因此启动一个真实 /bin/sh 子进程作为 Job 的 pull 源（输出由子进程真实产生，不预写 ring 数据），
  // 经真实 ctx.jobs 注册与消费后，从 0 读观察保留窗口丢失。kind=probe，不冒充 agent bash Job。
  const runNativeBashLossyProbe = () => {
    try {
      const chunks = []
      let total = 0
      const child = spawn('/bin/sh', ['-c', 'yes x | head -c 40000'], { stdio: ['ignore', 'pipe', 'ignore'] })
      child.stdout.on('data', (buffer) => { chunks.push(buffer); total += buffer.length })
      const done = new Promise((resolve) => {
        child.once('close', (code) => resolve({ status: code === 0 ? 'completed' : 'failed', detail: `exit code: ${code === null ? 'null' : code}` }))
        child.once('error', () => resolve({ status: 'failed', detail: 'spawn failed' }))
      })
      const jobId = ctx.jobs.start({
        kind: 'probe',
        label: 'hephi-runtime-probe native bash lossy (real /bin/sh child, real registry)',
        output: [{
          read(fromByte) {
            const all = Buffer.concat(chunks)
            return { text: all.subarray(fromByte).toString('utf8'), nextOffset: all.length, lossy: false }
          },
        }],
        run() {
          return { cancel() { child.kill('SIGKILL') }, done }
        },
      })
      ctx.jobs.wait(jobId, 10000).then(() => {
        const beforeTrim = ctx.jobs.readAt(jobId, 0)
        const modelRead = ctx.jobs.read(jobId)
        const afterTrim = ctx.jobs.readAt(jobId, 0)
        nativeBashLossy = {
          jobId,
          producer: '/bin/sh -c "yes x | head -c 40000"',
          producedBytes: total,
          beforeTrim: { bytes: chunkBytes(beforeTrim.chunks), lossy: beforeTrim.lossy, next: beforeTrim.next },
          modelRead: { bytes: chunkBytes(modelRead.chunks), lossy: modelRead.lossy },
          afterTrim: { bytes: chunkBytes(afterTrim.chunks), lossy: afterTrim.lossy, tail: chunkText(afterTrim.chunks).slice(-80) },
        }
        flush()
      }).catch((error) => {
        nativeBashLossy = { jobId, error: error.message }
        flush()
      })
    } catch (error) {
      nativeBashLossy = { error: error.message }
      flush()
    }
  }
  setTimeout(runNativeBashLossyProbe, 0)

  const recordJob = (job, cause, awaited) => {
    const owner = job.owner
    const record = {
      jobId: job.id,
      owner,
      kind: job.kind,
      label: job.label,
      status: job.status,
      detail: job.detail ?? null,
      output: job.output,
      cause,
      awaited,
    }
    // 本 Session 终态：get 必须返回同一 Job 的终态投影。
    try {
      const view = ctx.jobs.get(job.id, owner)
      record.ownGet = { status: view.status, detail: view.detail ?? null, output: view.output }
    } catch (error) {
      record.ownGet = { threw: true, error: error.message }
    }
    // 完整输出 / 截断-lossing：从 0 读（可能 lossy）与从 earliest 读（保留窗口内完整）。
    record.reads = {}
    for (const [label, from] of [['fromHead', 0], ['fromEarliest', job.output?.earliest ?? 0]]) {
      try {
        const read = ctx.jobs.readAt(job.id, from, owner)
        record.reads[label] = {
          from,
          next: read.next,
          lossy: read.lossy,
          chunkCount: read.chunks.length,
          bytes: chunkBytes(read.chunks),
          text: chunkText(read.chunks),
        }
      } catch (error) {
        record.reads[label] = { threw: true, error: error.message }
      }
    }
    // 错误 Session 拒绝：必须抛错或返回 undefined，并由调用方按失败处理。
    try {
      const foreign = ctx.jobs.get(job.id, foreignSession)
      record.foreignGet = foreign === undefined ? { undefined: true } : { accepted: true, owner: foreign.owner, status: foreign.status }
    } catch (error) {
      record.foreignGet = { threw: true, error: error.message }
    }
    try {
      const foreign = ctx.jobs.readAt(job.id, 0, foreignSession)
      record.foreignReadAt = foreign === undefined ? { undefined: true } : { accepted: true, next: foreign.next }
    } catch (error) {
      record.foreignReadAt = { threw: true, error: error.message }
    }
    records.push(record)
    flush()
    // 终态后模型/工具会消费同一条 ring，并把保留窗口裁剪到 settled cap；
    // 延迟再读一次，才能观察到真实 lossy 语义（读 0 时低于窗口 → lossy=true）。
    setTimeout(() => {
      try {
        const view = ctx.jobs.get(record.jobId, owner)
        const read = ctx.jobs.readAt(record.jobId, 0, owner)
        record.afterConsume = {
          earliest: view.output?.earliest ?? null,
          total: view.output?.total ?? null,
          lossy: read.lossy,
          chunkCount: read.chunks.length,
          bytes: chunkBytes(read.chunks),
          tail: chunkText(read.chunks).slice(-120),
        }
      } catch (error) {
        record.afterConsume = { threw: true, error: error.message }
      }
      flush()
    }, 400).unref?.()
  }

  const dispose = ctx.jobs.events.subscribe({ owners: 'all' }, (event) => {
    if (!event || event.type !== 'settled') return
    const job = event.job
    if (!job || job.kind !== 'bash') return
    try {
      recordJob(job, event.cause, event.awaited)
    } catch (error) {
      flush({ probeError: error.message })
    }
  })
  ctx.effect(() => dispose)
  flush({ mounted: true, foreignSession })
  console.error('[hephi-runtime-probe] attached to ctx.jobs settlement events')
}
