import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ActivationContract } from './activation.js'
import { allowedPath } from './repository.js'

const exec = promisify(execFile)
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 })).stdout

/** Project scope always applies; a task card narrows it to the union of its acceptance paths. */
export function inScope(contract: ActivationContract, file: string): boolean {
  if (!allowedPath(file, contract.allowedPaths)) return false
  return !contract.task || contract.task.acceptance.some(item => allowedPath(file, item.paths))
}

export type ChangeSummary = { files: string[]; changedLines: number; deleted: string[] }

export async function summarizeChanges(workspace: string, baseSha: string): Promise<ChangeSummary> {
  const files = (await git(workspace, 'diff', '--name-only', '-z', '--no-renames', baseSha, '--')).split('\0').filter(Boolean)
  let changedLines = 0
  for (const line of (await git(workspace, 'diff', '--numstat', '-z', '--no-renames', baseSha, '--')).split('\0').filter(Boolean)) {
    const [added, removed] = line.split('\t')
    // Binary files report "-"; count each as one line so they still consume a budget.
    changedLines += added === '-' ? 1 : Number(added) + Number(removed)
  }
  const deleted = (await git(workspace, 'diff', '--name-only', '-z', '--no-renames', '--diff-filter=D', baseSha, '--')).split('\0').filter(Boolean)
  return { files, changedLines, deleted }
}

const sample = (items: string[]) => items.slice(0, 10).join(', ') + (items.length > 10 ? ` (+${items.length - 10} more)` : '')

/**
 * Mechanical limits only: paths, an explicitly requested budget, and protected
 * test deletion. They do not detect semantic drift inside allowed paths.
 */
export function disciplineProblems(contract: ActivationContract, changes: ChangeSummary): string[] {
  const problems: string[] = []
  const outside = changes.files.filter(file => !inScope(contract, file))
  if (outside.length) problems.push(`revert files outside the task scope: ${sample(outside)}`)
  const task = contract.task
  if (!task) return problems
  const { maxFiles, maxChangedLines } = task.budget ?? {}
  if (maxFiles !== undefined && changes.files.length > maxFiles) problems.push(`change touches ${changes.files.length} files, the task budget is ${maxFiles}`)
  if (maxChangedLines !== undefined && changes.changedLines > maxChangedLines) problems.push(`change has ${changes.changedLines} changed lines, the task budget is ${maxChangedLines}`)
  const protectedDeleted = changes.deleted.filter(file => allowedPath(file, task.protect))
  if (protectedDeleted.length) problems.push(`existing tests must not be deleted: ${sample(protectedDeleted)}`)
  return problems
}

export async function checkDiscipline(contract: ActivationContract, workspace: string): Promise<ChangeSummary> {
  const changes = await summarizeChanges(workspace, contract.baseSha)
  const problems = disciplineProblems(contract, changes)
  if (problems.length) throw new Error(`HEPHI change discipline: ${problems.join('; ')}`)
  return changes
}
