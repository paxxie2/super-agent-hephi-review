import { describe, expect, it } from 'vitest'
import { parseVerificationConfig, type VerificationCheck } from '../../src/contracts/checks.js'

// T08 (A2): `assertionFailureTypes` is additive and optional on every frozen check.
// AT-54(a) pins the pre-change shape byte-for-byte, so this literal is the fixed JSON
// that a legacy config (no assertionFailureTypes) must still produce.
const legacyConfig = {
  version: 1,
  checks: [
    {
      id: 'unit', kind: 'test', purpose: 'run the unit tests', command: 'pnpm',
      args: ['vitest', 'run', '--reporter=dot'], cwd: 'app', required: true, timeoutMs: 30_000,
    },
    {
      id: 'build', kind: 'build', purpose: 'compile the project', command: 'pnpm', args: ['build'],
    },
  ],
}

const legacyExpected: { version: 1; checks: VerificationCheck[] } = {
  version: 1,
  checks: [
    {
      id: 'unit', kind: 'test', purpose: 'run the unit tests', command: 'pnpm',
      args: ['vitest', 'run', '--reporter=dot'], cwd: 'app', required: true, timeoutMs: 30_000,
    },
    {
      id: 'build', kind: 'build', purpose: 'compile the project', command: 'pnpm', args: ['build'],
      cwd: '.', required: true, timeoutMs: 600_000,
    },
  ],
}

const acceptanceCheck = {
  id: 'acceptance', kind: 'test' as const, purpose: 'run the acceptance tests', command: 'sh',
  args: ['-c', 'pnpm vitest run tests/acceptance --reporter=junit --outputFile="$HEPHI_RUN_DIR/junit.xml"'],
  cwd: '.', required: true, timeoutMs: 900_000,
}

describe('T08: check assertionFailureTypes (AT-54)', () => {
  it('AT-54(a): a legacy config parses exactly as before (no assertionFailureTypes key)', () => {
    const parsed = parseVerificationConfig(legacyConfig)
    // Byte-for-byte: same fields, same order, same defaults, no new key.
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(legacyExpected))
    expect(parsed).toEqual(legacyExpected)
    expect(Object.keys(parsed.checks[0])).not.toContain('assertionFailureTypes')
    expect(Object.keys(parsed.checks[1])).not.toContain('assertionFailureTypes')
  })

  it('AT-54(b): a config with assertionFailureTypes parses and keeps the trimmed values', () => {
    const parsed = parseVerificationConfig({
      version: 1,
      checks: [{ ...acceptanceCheck, assertionFailureTypes: [' AssertionError ', 'AssertionFailedError'] }],
    })
    expect(parsed.checks[0].assertionFailureTypes).toEqual(['AssertionError', 'AssertionFailedError'])
    // Optional: other fields are untouched and a config that omits the key still works.
    expect(parsed.checks[0]).toMatchObject({ id: 'acceptance', kind: 'test', required: true })
    expect(parseVerificationConfig({ version: 1, checks: [acceptanceCheck] }).checks[0].assertionFailureTypes).toBeUndefined()
    // Each entry must be a non-empty string after trim (not a scalar, not blank).
    expect(() => parseVerificationConfig({ version: 1, checks: [{ ...acceptanceCheck, assertionFailureTypes: 'AssertionError' }] })).toThrow()
    expect(() => parseVerificationConfig({ version: 1, checks: [{ ...acceptanceCheck, assertionFailureTypes: ['   '] }] })).toThrow()
  })

  it('AT-54(c): unknown fields are still rejected by the strict schemas', () => {
    expect(() => parseVerificationConfig({ version: 1, checks: [{ ...acceptanceCheck, expectedFailures: ['x'] }] })).toThrow(/unrecognized key/i)
    expect(() => parseVerificationConfig({ version: 1, checks: [acceptanceCheck], unexpectedTopLevel: true })).toThrow(/unrecognized key/i)
  })
})
