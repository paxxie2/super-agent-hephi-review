import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/**
 * Small adapter between a frozen check and the installed host's tool
 * invocation surface.
 *
 * Host 0.2.2 gives `tools.execute` a `ToolBatchInput` of model calls, so a
 * plugin cannot hand it one nested `ToolExecutionInput` any more: the call is
 * rejected before dispatch and the check is recorded as `unknown`, which then
 * blocks every later check for the same contract. The supported nested path on
 * that host is the staged sequence exported by `@deepseek-ai/dsh-tools/pipeline`
 * — `prepare` → `dispatch` when the preparation asks for it → `complete` — which
 * is exactly what the shipped PTC executor uses. Older hosts still expose the
 * single-call `tools.execute(ToolExecutionInput)` surface, and that behavior is
 * preserved unchanged here.
 *
 * The module is resolved at runtime rather than imported statically for two
 * reasons: this plugin still type-depends on a host version without the
 * `./pipeline` subpath, and an unresolvable static import would prevent the
 * plugin from loading at all on an older host.
 */

/** One frozen check call plus the outer step admission current hosts accept. */
export type NativeCheckInput = ToolExecutionInput & {
  /** Step admission captured from the enclosing execution; ignored by legacy hosts. */
  readonly toolSet?: unknown
}

/** Preparation stage result of the current host pipeline. */
type Preparation =
  | { readonly kind: 'dispatch'; readonly exec: unknown }
  | { readonly kind: 'post-result' | 'final-result'; readonly exec: unknown; readonly result: ToolExecutionResult }

/** Dispatch stage result of the current host pipeline. */
type DispatchOutcome = { readonly kind: 'post-result' | 'final-result'; readonly result: ToolExecutionResult }

/** The subset of the current host's `ToolExecutionPipeline` a check uses. */
export type HostPipeline = {
  prepare(input: NativeCheckInput): Promise<Preparation>
  dispatch(exec: unknown): Promise<DispatchOutcome>
  complete(exec: unknown, outcome: Preparation | DispatchOutcome): Promise<ToolExecutionResult>
}

export type HostPipelineFactory = (ctx: unknown) => HostPipeline

/** Inject the current host's pipeline, or `undefined` when it does not exist. */
export type PipelineLoader = () => Promise<HostPipelineFactory | undefined>

const PIPELINE_SPECIFIER = '@deepseek-ai/dsh-tools/pipeline'

/** Thrown when the installed host cannot start a nested check execution safely. */
export class NativeCheckUnavailableError extends Error {
  override readonly name = 'NativeCheckUnavailableError'
}

/**
 * Candidate module locations, most trustworthy first.
 *
 * The host-install path wins because the pipeline must share the host's module
 * instances: its scope routing keeps module-local state, so a second copy of
 * `@deepseek-ai/dsh-scope` would misroute scoped policy listeners. The bare
 * specifier is the portable fallback for hosts whose plugin dependency graph
 * already carries the current `@deepseek-ai/dsh-tools`.
 */
export function pipelineCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const install = env.DSH_INSTALL_DIR?.trim()
  return [
    ...install === undefined || install === '' ? [] : [join(dirname(install), 'dsh-tools', 'lib', 'pipeline.js')],
    PIPELINE_SPECIFIER,
  ]
}

type PipelineModule = { readonly ToolExecutionPipeline?: unknown }
type HostPipelineConstructor = new (ctx: unknown) => HostPipeline

async function importCandidate(candidate: string): Promise<PipelineModule | undefined> {
  const specifier = candidate === PIPELINE_SPECIFIER ? candidate : pathToFileURL(candidate).href
  if (candidate !== PIPELINE_SPECIFIER && !existsSync(candidate)) return undefined
  return await import(/* runtime-resolved host module */ specifier) as PipelineModule
}

async function loadInstalledPipeline(env: NodeJS.ProcessEnv = process.env): Promise<HostPipelineFactory | undefined> {
  const failures: string[] = []
  for (const candidate of pipelineCandidates(env)) {
    let module: PipelineModule | undefined
    try {
      module = await importCandidate(candidate)
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (module === undefined) continue
    const Constructor = module.ToolExecutionPipeline
    if (typeof Constructor !== 'function') {
      failures.push(`${candidate}: no ToolExecutionPipeline export`)
      continue
    }
    return ctx => new (Constructor as HostPipelineConstructor)(ctx)
  }
  const detail = failures.length === 0
    ? 'no installed host pipeline module was found'
    : failures.join('; ')
  throw new NativeCheckUnavailableError(
    `the installed host requires staged tool execution (prepare/dispatch/complete) but ${PIPELINE_SPECIFIER} could not be loaded: ${detail}. Align the plugin's @deepseek-ai/dsh-tools with the host version, or run the plugin on a host that exposes DSH_INSTALL_DIR.`,
  )
}

/**
 * Whether the installed registry exposes the current staged-execution surface.
 * `executable` and `checkGuards` are the registry operations the staged
 * pipeline itself calls; the legacy runtime exposes neither, so this is the
 * same split the host made when it replaced single-call execute.
 */
function hasStagedExecution(tools: unknown): boolean {
  if (typeof tools !== 'object' || tools === null) return false
  const surface = tools as { executable?: unknown; checkGuards?: unknown }
  return typeof surface.executable === 'function' && typeof surface.checkGuards === 'function'
}

/** Native execution surface the check runner sees. */
export type NativeCheckExecution = {
  /** Resolve the host surface before a run is recorded; failure means `check not started`. */
  checkAvailable(): Promise<void>
  execute(input: NativeCheckInput): Promise<ToolExecutionResult>
}

/** The installed host's entry points the adapter needs. */
export type NativeCheckHost = {
  /** Context used to build the current host's pipeline; unused by legacy hosts. */
  readonly ctx: unknown
  /** Installed tool registry service. */
  readonly tools: unknown
}

/**
 * Bind one check session to the installed host's invocation API.
 * The returned executor never retries: a dispatch error propagates exactly once.
 */
export function createNativeCheckExecutor(
  host: NativeCheckHost,
  options: { loadPipeline?: PipelineLoader } = {},
): NativeCheckExecution {
  const loader = options.loadPipeline ?? (() => loadInstalledPipeline())
  const staged = hasStagedExecution(host.tools)
  let pipeline: HostPipeline | undefined

  const activePipeline = async (): Promise<HostPipeline> => {
    if (pipeline !== undefined) return pipeline
    const factory = await loader()
    if (factory === undefined) {
      throw new NativeCheckUnavailableError(
        `the installed host requires staged tool execution (prepare/dispatch/complete) but ${PIPELINE_SPECIFIER} did not load`,
      )
    }
    pipeline = factory(host.ctx)
    return pipeline
  }

  const legacyExecute = (): ((input: NativeCheckInput) => Promise<ToolExecutionResult>) => {
    const execute = (host.tools as { execute?: unknown } | undefined)?.execute
    if (typeof execute !== 'function') {
      throw new NativeCheckUnavailableError(
        'the installed host exposes neither staged tool execution (prepare/dispatch/complete) nor a single-call tools.execute',
      )
    }
    return input => (execute as (this: unknown, input: NativeCheckInput) => Promise<ToolExecutionResult>).call(host.tools, input)
  }

  return {
    async checkAvailable() {
      if (staged) {
        await activePipeline()
        return
      }
      legacyExecute()
    },
    async execute(input) {
      if (!staged) return await legacyExecute()(input)
      const active = await activePipeline()
      const prepared = await active.prepare(input)
      if (prepared.kind === 'dispatch') {
        const dispatched = await active.dispatch(prepared.exec)
        return await active.complete(prepared.exec, dispatched)
      }
      return await active.complete(prepared.exec, prepared)
    },
  }
}
