import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// A7 host contract suite (opt-in). REBUILT VERSION (2026-11-12): the original
// `hephi/tests/host/host-contract.test.ts` was lost with the deleted
// agent/roadmap95 branch; this file is a rebuild from the surviving scripts and
// the recorded task-15 specification, not the original file.
//
// ROADMAP-95 §A7 asks for one host contract test covering the event structure,
// tools/pre-execute, tool guards, the Job interface and the system prompt, to be
// run before every host upgrade. This suite merges the two existing *real* host
// entry points into a single runner:
//
//   1. `node hephi/scripts/check-stage-host.mjs <rc.5 node_modules>` — staged fixture
//      against the real installed DSH tool runtime (dispatch, scoped visibility,
//      tools/pre-execute guard, progress events), and
//   2. `node hephi/scripts/check-binding-host.mjs --self-test` — the A2 H1/H2/H4
//      probe parser/verdict self-test on synthetic Session shapes.
//
// This is NOT a Worker/Issue E2E, NOT a host-upgrade regression (no upgrade event is
// simulated) and NOT evidence for A2/A5/A6. It only fixes the contract *shape* that
// the plugin relies on, using the real installed `@deepseek-ai/*` packages.
//
// The DSH packages are external to this repository, so the suite is gated: without
// `HEPHI_DSH_FIXTURE_ROOT` pointing at a node_modules root that contains
// `@deepseek-ai/dsh-tools`, the single integration test is skipped and plain
// `pnpm test` keeps working offline.
const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const fixtureRoot = (process.env.HEPHI_DSH_FIXTURE_ROOT ?? '').trim()
const fixtureTools = fixtureRoot ? join(fixtureRoot, '@deepseek-ai', 'dsh-tools') : ''
const fixtureAvailable = fixtureRoot !== '' && existsSync(fixtureRoot) && existsSync(fixtureTools)
const skipReason = fixtureRoot === ''
  ? 'HEPHI_DSH_FIXTURE_ROOT is not set (opt-in: point it at the DSH 0.2.1-rc.5 node_modules root, e.g. /Users/zm/dsh-instances/runtime/node_modules)'
  : `HEPHI_DSH_FIXTURE_ROOT=${fixtureRoot} does not contain @deepseek-ai/dsh-tools`

if (!fixtureAvailable) {
  // Say why the contract suite did not run; never let the missing external fixture
  // fail the offline test suite.
  console.warn(`[A7 host contract] SKIP: ${skipReason}`)
}

type Run = { status: number | null; stdout: string; stderr: string; timedOut: boolean }

function runNode(args: string[], timeoutMs: number): Run {
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8', timeout: timeoutMs })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: result.error !== undefined || result.signal !== null,
  }
}

function excerpt(text: string, limit = 4000): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed === '' ? '(empty)' : trimmed
  return `${trimmed.slice(0, limit)}\n… (${trimmed.length - limit} more chars omitted)`
}

function detail(label: string, run: Run): string {
  return [
    `${label}`,
    ` exit=${String(run.status)} timedOut=${run.timedOut}`,
    ` stdout:\n${excerpt(run.stdout)}`,
    ` stderr:\n${excerpt(run.stderr)}`,
  ].join('\n')
}

describe('A7 host contract suite (opt-in fixture)', () => {
  it.skipIf(!fixtureAvailable)(
    'stage fixture (real DSH dispatch/scope/guard/progress) + A2 binding self-test',
    () => {
      // Run both entry points before asserting so a stage failure does not hide the
      // binding self-test result in the record.
      const stage = runNode(
        [join(repoRoot, 'hephi/scripts/check-stage-host.mjs'), fixtureRoot],
        120_000,
      )
      const binding = runNode(
        [join(repoRoot, 'hephi/scripts/check-binding-host.mjs'), '--self-test'],
        120_000,
      )

      expect(stage.status, detail('stage fixture (check-stage-host.mjs) failed', stage)).toBe(0)
      expect(stage.stdout).toContain('PASS: real installed DSH tool dispatch/scoped visibility/guard/progress events')
      expect(binding.status, detail('A2 binding self-test (check-binding-host.mjs --self-test) failed', binding)).toBe(0)
      expect(binding.stdout).toContain('SELF-TEST: PASS')
    },
    180_000,
  )
})
