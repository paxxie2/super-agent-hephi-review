import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  createNativeCheckExecutor, NativeCheckUnavailableError, pipelineCandidates,
  type HostPipeline, type NativeCheckInput,
} from '../../src/control/native-check-execution.js'

const signal = new AbortController().signal
const agent = { id: 'worker-session' }

function input(overrides: Partial<NativeCheckInput> = {}): NativeCheckInput {
  return {
    callId: 'hephi-inner' as never,
    rootCallId: 'outer-check' as never,
    name: 'bash',
    arguments: { command: 'true', workdir: '/tmp/workspace', timeoutMs: 5000 },
    agent: agent as never,
    parent: Symbol('outer') as never,
    signal,
    toolSet: { admitted: ['bash'] } as never,
    ...overrides,
  }
}

const passed = {
  isError: false, content: [], value: { kind: 'foreground', exitCode: 0 },
} as unknown as ToolExecutionResult

const refused = {
  isError: true, content: [{ type: 'text', text: 'Error: denied' }],
  error: { message: 'denied' },
} as unknown as ToolExecutionResult

function stagedPipeline(options: {
  prepared?: unknown
  dispatchResult?: unknown
  dispatchError?: Error
} = {}) {
  const preparedExec = { token: Symbol('inner') }
  const preparation = options.prepared ?? { kind: 'dispatch' as const, exec: preparedExec }
  const dispatched = options.dispatchResult ?? { kind: 'post-result' as const, result: passed }
  const calls: string[] = []
  const pipeline = {
    prepare: vi.fn(async (_input: NativeCheckInput) => { calls.push('prepare'); return preparation }),
    dispatch: vi.fn(async (_exec: unknown) => {
      calls.push('dispatch')
      if (options.dispatchError) throw options.dispatchError
      return dispatched
    }),
    complete: vi.fn(async (_exec: unknown, outcome: { result?: unknown }) => {
      calls.push('complete')
      return (outcome.result ?? passed) as ToolExecutionResult
    }),
  }
  return { pipeline: pipeline as unknown as HostPipeline, preparedExec, preparation, dispatched, calls }
}

function stagedTools() {
  return {
    executable: vi.fn(() => undefined),
    checkGuards: vi.fn(() => undefined),
    execute: vi.fn(async () => passed),
  }
}

describe('native check execution adapter', () => {
  it('uses the current host prepare -> dispatch -> complete sequence with the outer identity intact', async () => {
    const tools = stagedTools()
    const { pipeline, preparedExec, calls } = stagedPipeline()
    const factory = vi.fn(() => pipeline)
    const ctx = { marker: 'agent-ctx' }
    const executor = createNativeCheckExecutor({ ctx, tools }, { loadPipeline: async () => factory })

    await executor.checkAvailable()
    const call = input()
    const result = await executor.execute(call)

    expect(calls).toEqual(['prepare', 'dispatch', 'complete'])
    expect(factory).toHaveBeenCalledWith(ctx)
    expect(pipeline.prepare).toHaveBeenCalledWith(call)
    expect(pipeline.dispatch).toHaveBeenCalledWith(preparedExec)
    expect(pipeline.complete).toHaveBeenCalledWith(preparedExec, expect.objectContaining({ kind: 'post-result', result: passed }))
    // The removed single-call surface must never be used on a staged host.
    expect(tools.execute).not.toHaveBeenCalled()
    expect(result).toBe(passed)
    // The resolved pipeline is reused instead of reloaded for the next check.
    await executor.checkAvailable()
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('completes a preparation that is already final without dispatching it', async () => {
    const tools = stagedTools()
    const { pipeline, preparation } = stagedPipeline({
      prepared: { kind: 'final-result' as const, exec: { token: Symbol('inner') }, result: refused },
    })
    const executor = createNativeCheckExecutor({ ctx: {}, tools }, { loadPipeline: async () => () => pipeline })

    const result = await executor.execute(input())

    expect(pipeline.dispatch).not.toHaveBeenCalled()
    expect(pipeline.complete).toHaveBeenCalledWith((preparation as { exec: unknown }).exec, preparation)
    expect(result).toBe(refused)
  })

  it('propagates a dispatch error exactly once without retrying or falling back', async () => {
    const tools = stagedTools()
    const failure = new Error('native dispatch failed')
    const { pipeline } = stagedPipeline({ dispatchError: failure })
    const executor = createNativeCheckExecutor({ ctx: {}, tools }, { loadPipeline: async () => () => pipeline })

    await expect(executor.execute(input())).rejects.toBe(failure)

    expect(pipeline.prepare).toHaveBeenCalledTimes(1)
    expect(pipeline.dispatch).toHaveBeenCalledTimes(1)
    expect(pipeline.complete).not.toHaveBeenCalled()
    expect(tools.execute).not.toHaveBeenCalled()
  })

  it('keeps the installed single-call execute surface when the host still exposes it', async () => {
    const tools = { execute: vi.fn(async () => passed) }
    const loader = vi.fn()
    const executor = createNativeCheckExecutor({ ctx: {}, tools }, { loadPipeline: loader })

    await executor.checkAvailable()
    const call = input()
    expect(await executor.execute(call)).toBe(passed)

    expect(loader).not.toHaveBeenCalled()
    expect(tools.execute).toHaveBeenCalledTimes(1)
    expect(tools.execute).toHaveBeenCalledWith(call)
  })

  it('reports a staged host whose pipeline module is unavailable instead of using a wrong API', async () => {
    const tools = stagedTools()
    const executor = createNativeCheckExecutor({ ctx: {}, tools }, { loadPipeline: async () => undefined })

    await expect(executor.checkAvailable()).rejects.toBeInstanceOf(NativeCheckUnavailableError)
    await expect(executor.execute(input())).rejects.toThrow(/staged tool execution/)
    expect(tools.execute).not.toHaveBeenCalled()
  })

  it('reports a host with neither invocation surface', async () => {
    const executor = createNativeCheckExecutor({ ctx: {}, tools: {} })

    await expect(executor.checkAvailable()).rejects.toThrow(/neither staged tool execution/)
    await expect(executor.execute(input())).rejects.toBeInstanceOf(NativeCheckUnavailableError)
  })

  it('prefers the installed host module and keeps the portable specifier as fallback', () => {
    expect(pipelineCandidates({ DSH_INSTALL_DIR: '/host/app.asar/dsh/node_modules/@deepseek-ai/dsh' })).toEqual([
      '/host/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/pipeline.js',
      '@deepseek-ai/dsh-tools/pipeline',
    ])
    expect(pipelineCandidates({ DSH_INSTALL_DIR: '' })).toEqual(['@deepseek-ai/dsh-tools/pipeline'])
    expect(pipelineCandidates({})).toEqual(['@deepseek-ai/dsh-tools/pipeline'])
  })
})
