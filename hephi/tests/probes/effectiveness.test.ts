import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { activationPath, loadActivation, type ActivationContract } from '../../src/control/activation.js'
import { checkRunDir, saveRun } from '../../src/control/check-store.js'
import { createEvidenceVerifier } from '../../src/control/evidence-verifier.js'
import { gitFingerprint, sha256 } from '../../src/verification/fingerprint.js'
import { check, commitAll, PRICE, project, readyCall, verifier, type Project } from './harness.js'

// Delivery-discipline scenarios for Issue #7 "total() must add".
async function deliver(p: Project) {
  const statuses: Record<string, string> = {}
  for (const id of ['tests', 'price']) statuses[id] = await check(p, id)
  return { statuses, ready: await verifier(p)(p.contract, readyCall(p.dir)) }
}

const fix = (dir: string) => writeFile(join(dir, 'src/price.js'), 'exports.total = (a, b) => a + b\n')
const sweep = async (dir: string) => {
  for (let i = 0; i < 20; i++) await writeFile(join(dir, `src/m${String(i).padStart(2, '0')}.js`), `'use strict'\nmodule.exports = { value${i}: () => ${i} }\n`)
}

describe('focused delivery', () => {
  it('the focused fix passes with Session-bound evidence', async () => {
    const p = await project()
    await fix(p.dir); await commitAll(p.dir, 'fix total')
    expect(await deliver(p)).toEqual({ statuses: { tests: 'passed', price: 'passed' }, ready: { ok: true } })
  })

  it('a behaviour-preserving rewrite is accepted: the named check need not fail on base', async () => {
    const p = await project({ check: 'tests' })
    await writeFile(join(p.dir, 'src/price.js'), 'function total(a, b) {\n  return a - b\n}\nexports.total = total\n')
    await commitAll(p.dir, 'restructure total without changing behaviour')
    expect((await deliver(p)).ready).toEqual({ ok: true })
  })

  it('an ordinary task without a budget is not limited by one', async () => {
    const p = await project({ paths: ['src/**', 'tests/price*'] })
    await fix(p.dir); await sweep(p.dir); await commitAll(p.dir, 'fix + tidy')
    expect((await deliver(p)).ready).toEqual({ ok: true })
  })
})

describe('scope creep and refactoring', () => {
  it('editing a file outside the item scope is refused at check time and at ready', async () => {
    const p = await project()
    await fix(p.dir); await writeFile(join(p.dir, 'src/m05.js'), 'exports.value5 = () => 5\n'); await commitAll(p.dir, 'fix + tidy')
    const result = await deliver(p)
    expect(result.statuses.tests).toContain('changed path outside contract')
    expect(result.ready).toMatchObject({ ok: false, reason: expect.stringContaining('outside the task scope: src/m05.js') })
  })

  it('a budget the Issue asked for refuses a sweeping rewrite inside a broad scope', async () => {
    const p = await project({ paths: ['src/**', 'tests/price*'], budget: { maxFiles: 3 } })
    await fix(p.dir); await sweep(p.dir); await commitAll(p.dir, 'fix + refactor')
    expect((await deliver(p)).ready).toMatchObject({ ok: false, reason: expect.stringContaining('the task budget is 3') })
  })
})

describe('goal drift', () => {
  it('not fixing total() is refused even though the project tests pass', async () => {
    const p = await project({ paths: ['src/**', 'tests/price*'] })
    await writeFile(join(p.dir, 'src/m05.js'), 'exports.value5 = () => 50\n'); await commitAll(p.dir, 'unrelated change')
    const result = await deliver(p)
    expect(result.statuses).toEqual({ tests: 'passed', price: 'blocked' })
    expect(result.ready).toMatchObject({ ok: false, reason: 'missing, failed or stale evidence: price' })
  })

  it('deleting an existing test is refused', async () => {
    const p = await project({ paths: ['src/price.js', 'tests/**'] })
    await fix(p.dir); await unlink(join(p.dir, 'tests/legacy.test.sh')); await commitAll(p.dir, 'fix + drop test')
    expect((await deliver(p)).ready).toMatchObject({ ok: false, reason: expect.stringContaining('existing tests must not be deleted: tests/legacy.test.sh') })
  })

  it('a build check cannot be named as acceptance', async () => {
    await expect(project({ check: 'build' }, [{ id: 'build', kind: 'build', purpose: 'compile', command: 'true', args: [] }])).rejects.toThrow('must name a behaviour test check')
  })
})

describe('evidence integrity', () => {
  it('a hand-written passing record is refused because the Session has no such native execution', async () => {
    const p = await project()
    await fix(p.dir); await commitAll(p.dir, 'fix total')
    await deliver(p)
    const fp = await gitFingerprint(p.dir, p.baseSha)
    await mkdir(checkRunDir(p.stateDir, p.contract.ticketId, 'forged'), { recursive: true })
    await writeFile(join(checkRunDir(p.stateDir, p.contract.ticketId, 'forged'), 'output.log'), 'ok')
    await saveRun(p.stateDir, {
      version: 2, runId: 'forged', sequence: 100, ticketId: p.contract.ticketId, contractHash: p.contract.contractHash, checkId: 'price',
      sessionId: 'x', callId: 'x', innerCallId: 'fake-call', argv: ['node', '-e', PRICE], cwd: p.dir, startedAt: 'x', finishedAt: 'x',
      status: 'passed', exitCode: 0, before: fp, after: fp, outputHash: sha256('ok'),
    })
    expect(await verifier(p)(p.contract, readyCall(p.dir))).toMatchObject({ ok: false, reason: expect.stringContaining('expected one native call fake-call') })
  })

  it('without a Session reader, a verifier that requires binding cannot be built', () => {
    expect(() => createEvidenceVerifier({ stateDir: '/tmp', requireSessionBinding: true })).toThrow('requires a Session reader')
  })

  it('a contract whose task card was edited no longer loads', async () => {
    const p = await project()
    const path = activationPath(p.stateDir, p.contract.ticketId)
    const edited: ActivationContract = { ...p.contract, task: { ...p.contract.task!, budget: { maxFiles: 200 } } }
    await writeFile(path, JSON.stringify(edited))
    await expect(loadActivation(path)).rejects.toThrow('hash mismatch')
  })
})
