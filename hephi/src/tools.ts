/** Public tool module consumed by the Super Agent integration layer. */
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { searchKnowledgeBase } from './kb/index.js'
import { activationPath, defaultStateDir, loadActivation } from './control/activation.js'
import { resolveWorkspace } from './control/workspace.js'
import { activationMarker } from './version.js'
import { isWorkerAgent, workerTicketId } from './control/worker-mount.js'


const jsonOutput = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

export function hephiToolDefinitions(configuredStateDir?: string) {
  const stateDir = defaultStateDir(configuredStateDir)
  const loadWorkerContract = async (exec: ToolRunContext) => {
    if (!exec.agent || !isWorkerAgent(exec.agent)) throw new Error('HEPHI tools require the current Super Agent Worker Session')
    const ticketId = workerTicketId(exec.agent)
    if (!ticketId) throw new Error('HEPHI Worker Session has no Ticket ID')
    const activation = await loadActivation(activationPath(stateDir, ticketId))
    if (activation.ticketId !== ticketId) throw new Error('HEPHI contract belongs to a different Ticket')
    return activation
  }
  const kbSearch = defineTool({
    name: 'hephi_kb_search',
    description: 'Search the configured project knowledge base and return a baseSha-bound code context pack. Results are historical references only.',
    parameters: { query: { type: 'string', required: true }, limit: { type: 'integer' } },
    output: jsonOutput,
    async execute(args, exec: ToolRunContext) {
      const contract = await loadWorkerContract(exec)
      const sessionCwd = exec.agent?.session.header.cwd
      const workspace = await resolveWorkspace(contract.workspace, typeof sessionCwd === 'string' ? sessionCwd : undefined)
      const result = await searchKnowledgeBase(contract, args.query, args.limit, stateDir, workspace)
      return JSON.parse(JSON.stringify(result))
    },
  })
  const contract = defineTool({
    name: 'hephi_get_contract',
    description: 'Load and validate the current HEPHI delivery contract from the Super Agent Ticket.',
    parameters: {},
    output: jsonOutput,
    async execute(_args, exec: ToolRunContext) { return loadWorkerContract(exec) },
  })
  return [contract, kbSearch]
}

export const name = 'hephi-superagent-plugin/tools'
export const inject = ['tools']

/** Register contract and knowledge tools globally; Super Agent's worker preset controls visibility. */
export function apply(ctx: Context, config: { stateDir?: string } = {}): void {
  const tools = (ctx as Context & { tools: { register(definition: unknown): () => void } }).tools
  const disposers = hephiToolDefinitions(config.stateDir).map((tool) => tools.register(tool))
  ctx.effect(() => () => { for (const dispose of disposers) dispose() })
  // Registration completed: emit the deploy-verifiable activation marker (issue #26).
  console.log(activationMarker('tools'))
}
