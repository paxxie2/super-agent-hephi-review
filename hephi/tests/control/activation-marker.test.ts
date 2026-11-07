import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply as applyIndex } from '../../src/index.js'
import { apply as applyTools } from '../../src/tools.js'
import { ACTIVATION_MARKER_PREFIX, activationMarker, pluginCommit, pluginName } from '../../src/version.js'

async function stateDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'hephi-activation-marker-'))
}

// 聚焦测试：只验证两个 bundle entry 在注册完成后各写一行可解析的激活标识。
// 部署脚本对真实宿主日志的门禁由假宿主套件与真实验证分别覆盖，这里不是端到端证据。
describe('plugin activation markers (issue #26)', () => {
  it('formats one stable single-line marker per bundle entry', () => {
    const index = activationMarker('index')
    const tools = activationMarker('tools')
    for (const marker of [index, tools]) {
      expect(marker.startsWith(`${ACTIVATION_MARKER_PREFIX} `)).toBe(true)
      expect(marker).toContain(`plugin=${pluginName} `)
      expect(marker).toContain(`commit=${pluginCommit()} `)
      expect(marker).toContain(`pid=${process.pid}`)
      expect(marker).not.toContain('\n')
    }
    expect(index).toBe(`${ACTIVATION_MARKER_PREFIX} entry=index plugin=${pluginName} commit=${pluginCommit()} pid=${process.pid}`)
    expect(tools).toBe(`${ACTIVATION_MARKER_PREFIX} entry=tools plugin=${pluginName} commit=${pluginCommit()} pid=${process.pid}`)
  })

  it('index apply logs its marker only after registration', async () => {
    const dir = await stateDir()
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)) })
    try {
      const ctx = {
        get: () => undefined,
        on: () => () => {},
        effect: () => {},
        agents: { list: () => [] },
      } as unknown as Context
      applyIndex(ctx, { stateDir: dir })
    } finally {
      spy.mockRestore()
    }
    expect(logs).toEqual([activationMarker('index')])
  })

  it('tools apply logs its marker only after registration', async () => {
    const dir = await stateDir()
    const logs: string[] = []
    const registered: unknown[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)) })
    try {
      const ctx = {
        tools: { register: (definition: unknown) => { registered.push(definition); return () => {} } },
        effect: () => {},
      } as unknown as Context
      applyTools(ctx, { stateDir: dir })
    } finally {
      spy.mockRestore()
    }
    // 0.1.0 注册 hephi_get_contract 与 hephi_kb_search 两个工具，然后写一条激活标识。
    expect(registered).toHaveLength(2)
    expect(logs).toEqual([activationMarker('tools')])
  })
})
