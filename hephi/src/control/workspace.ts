import { execFile } from 'node:child_process'
import { readdir, realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const exec = promisify(execFile)

/** Return the Git root for a directory, or undefined when it is not a checkout. */
export async function gitRoot(directory: string): Promise<string | undefined> {
  try {
    const result = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: directory })
    return result.stdout.trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * The contract allows its own Git root or exactly one direct nested checkout.
 * Session cwd confirms that location; it cannot introduce an external clone.
 */
export async function resolveWorkspace(directory: string, sessionCwd?: string): Promise<string> {
  const container = await realpath(directory)
  const direct = await gitRoot(container)
  let checkout = direct && await realpath(direct) === container ? container : undefined
  if (!checkout) {
    const candidates: string[] = []
    for (const entry of await readdir(container, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.git') continue
      const candidate = await realpath(join(container, entry.name))
      // Exact child paths exclude symlink escapes and enclosing Git roots.
      if (candidate !== join(container, entry.name)) continue
      const root = await gitRoot(candidate)
      if (root && await realpath(root) === candidate) candidates.push(candidate)
    }
    if (candidates.length !== 1) {
      throw new Error(`activation workspace is not a git repository and does not contain exactly one nested worktree: ${directory}`)
    }
    checkout = candidates[0]
  }
  if (sessionCwd) {
    const cwd = await realpath(sessionCwd)
    const root = await gitRoot(cwd)
    if (cwd !== container && (!root || await realpath(root) !== checkout)) {
      throw new Error('Worker Session cwd does not match the activation workspace')
    }
  }
  return checkout
}

/**
 * Map a tool path onto the actual checkout. Relative paths resolve against the
 * Session cwd (or the contract workspace); symlinks are resolved through the
 * nearest existing ancestor. Returns undefined for anything outside the checkout.
 */
export async function checkoutRelative(checkout: string, base: string, path: string): Promise<string | undefined> {
  let target = resolve(base, path)
  const missing: string[] = []
  for (;;) {
    try {
      target = await realpath(target)
      break
    } catch {
      const parent = dirname(target)
      if (parent === target) return undefined
      missing.unshift(basename(target))
      target = parent
    }
  }
  const rel = relative(await realpath(checkout), join(target, ...missing))
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
  return rel.split(sep).join('/')
}
