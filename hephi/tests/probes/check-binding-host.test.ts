import { describe, expect, it } from 'vitest'
// @ts-expect-error -- the zero-dependency probe is plain ESM with no type declarations
import { analyzeSession, evaluateJobEvidence, h1Ring, h2Ring, h3Ring, h4Ring, h5Ring, validateJobEvidence } from '../../scripts/check-binding-host.mjs'

// Focused fixture tests for hephi/scripts/check-binding-host.mjs.
// These synthetic Sessions are NOT real host evidence: they only pin the parser and
// the two documented encodings (path A: tool/call+tool/result; path B: job events).
// Real end-to-end A1-BIND evidence still requires the host probe + disposable profile.

const ROOT = 'call_fixture_root_0001'
const INNER = 'hephi-fixture-inner-0001'
const SESSION = 'worker-fixture-000000000001'
const OTHER_SESSION = 'worker-other-000000000002'
const CWD = '/tmp/fixture-workspace'
const BASE = 'b'.repeat(40)
const COMMAND = `HEPHI_BASE_COMMIT='${BASE}' 'bash' 'scripts/check.sh'`
const JOB_ID = 'bash-fixture-0001'

const record = {
  version: 3,
  runId: 'run-fixture',
  sessionId: SESSION,
  callId: ROOT,
  innerCallId: INNER,
  argv: ['bash', 'scripts/check.sh'],
  cwd: CWD,
  before: { baseCommit: BASE },
  status: 'passed',
  exitCode: 0,
  jobId: JOB_ID,
}

const redact = (value: unknown) => String(value ?? '')

type SessionOptions = {
  innerCall?: boolean
  value?: boolean
  job?: boolean
  owner?: string
  label?: string
  detail?: string
  status?: string
}

function makeSession(options: SessionOptions = {}) {
  const {
    innerCall = true,
    value = true,
    // F4: the two encodings are mutually exclusive. Default fixtures are path A only;
    // path-B tests opt in with job: true, and the ambiguous coexistence case sets both.
    job = false,
    owner = SESSION,
    label = COMMAND,
    detail = 'exit code: 0',
    status = 'completed',
  } = options
  const jobData = { jobId: JOB_ID, owner, kind: 'bash', label, toolCall: { callId: INNER, rootCallId: ROOT } }
  const events: Array<{ type: string; data: Record<string, unknown> }> = [
    { type: 'session', data: { type: 'session', version: 4, id: SESSION } },
    { type: 'tool/call', data: { callId: ROOT, name: 'hephi_check', arguments: '{"checkId":"project-regression"}' } },
    ...(job ? [{ type: 'job/registered', data: { ...jobData } }] : []),
    ...(innerCall
      ? [
          { type: 'tool/call', data: { callId: INNER, name: 'bash', arguments: JSON.stringify({ command: COMMAND, workdir: CWD }) } },
          {
            type: 'tool/result',
            data: {
              message: {
                role: 'tool',
                toolCallId: INNER,
                isError: false,
                content: [{ type: 'text', text: '[exit code: 0]' }],
                ...(value
                  ? {
                      value: {
                        kind: 'foreground',
                        exitCode: 0,
                        timedOut: false,
                        aborted: false,
                        stdout: { text: 'ok', truncated: false },
                        stderr: { text: '', truncated: false },
                      },
                    }
                  : {}),
              },
            },
          },
        ]
      : []),
    ...(job ? [{ type: 'job/settled', data: { ...jobData, status, cause: 'producer', producerReported: true, detail } }] : []),
    {
      type: 'tool/result',
      data: { message: { role: 'tool', toolCallId: ROOT, isError: false, content: [{ type: 'text', text: '{"status":"passed"}' }] } },
    },
  ]
  return { headerId: SESSION, events }
}

const h1 = (session: ReturnType<typeof makeSession>, override = record) => h1Ring(analyzeSession(session), override, redact)

function jobEvidence(overrides: Record<string, unknown> = {}) {
  return {
    generatedBy: 'host-runtime-probe',
    host: 'http://127.0.0.1:0000',
    profile: 'disposable-fixture-profile',
    sessionId: SESSION,
    jobId: JOB_ID,
    own: {
      status: 'completed',
      detail: 'exit code: 0',
      readAt: { text: 'ok\n', lossy: false, truncated: false, chunks: [{ at: 0, text: 'ok\n' }] },
    },
    foreign: { threw: true, error: 'Job belongs to another Session' },
    ...overrides,
  }
}

describe('check-binding-host path A (focused fixtures)', () => {
  it('passes when the inner bash tool/call and structured result match the record', () => {
    const ring = h1(makeSession({ innerCall: true, value: true }))
    expect(ring.status).toBe('pass')
    expect(ring.evidence.encoding).toBe('path-A')
    expect(ring.evidence.innerCallFound).toBe(true)
    expect(ring.evidence.inner.commandMatches).toBe(true)
    expect(ring.evidence.inner.workdirMatchesRecordCwd).toBe(true)
  })

  it('reports ambiguous/fail when path A and path B evidence coexist (runtime verifier refuses both shapes)', () => {
    const ring = h1(makeSession({ innerCall: true, value: true, job: true }))
    expect(ring.status).toBe('fail')
    expect(ring.evidence.encoding).toBe('ambiguous')
    expect(ring.evidence.ambiguous).toBe(true)
    expect(ring.evidence.pathBJobEventCount).toBeGreaterThan(0)
    expect(String(ring.evidence.notes)).toContain('双形状')
  })

  it('does not let disagreeing path B events downgrade an ambiguous snapshot to a path-A pass', () => {
    const ring = h1(makeSession({ innerCall: true, value: true, job: true, owner: OTHER_SESSION, label: `${COMMAND} --extra` }))
    expect(ring.status).toBe('fail')
    expect(ring.evidence.encoding).toBe('ambiguous')
  })
})

describe('check-binding-host path B (focused fixtures)', () => {
  it('passes on root call + job/registered + job/settled with owner, command and exit code', () => {
    const ring = h1(makeSession({ innerCall: false, job: true }))
    expect(ring.status).toBe('pass')
    expect(ring.evidence.encoding).toBe('path-B')
    expect(ring.evidence.jobId).toBe('bash-f…0001') // masked form of JOB_ID
    expect(ring.evidence.ownerMatchesSession).toBe(true)
    expect(ring.evidence.rootCallFound).toBe(true)
    expect(ring.evidence.innerCallFound).toBe(false)
    expect(ring.evidence.jobRegisteredFound).toBe(true)
    expect(ring.evidence.jobSettledFound).toBe(true)
    expect(ring.evidence.labelMatchesCommand).toBe(true)
    expect(ring.evidence.exitCode).toBe(0)
    expect(ring.evidence.status).toBe('completed')
  })

  it('fails when the job owner is another Session', () => {
    const ring = h1(makeSession({ innerCall: false, job: true, owner: OTHER_SESSION }))
    expect(ring.status).toBe('fail')
    expect(ring.evidence.ownerMatchesSession).toBe(false)
  })

  it('fails when the job label differs from the rebuilt command', () => {
    const ring = h1(makeSession({ innerCall: false, job: true, label: `${COMMAND} --extra` }))
    expect(ring.status).toBe('fail')
    expect(ring.evidence.labelMatchesCommand).toBe(false)
  })

  it('fails on a truncated label instead of accepting a prefix', () => {
    const ring = h1(makeSession({ innerCall: false, job: true, label: COMMAND.slice(0, 50) }))
    expect(ring.status).toBe('fail')
    expect(ring.evidence.labelMatchesCommand).toBe(false)
    expect(String(ring.evidence.notes)).toContain('截断')
  })

  it('fails when the settled exit code disagrees with record.exitCode', () => {
    const ring = h1(makeSession({ innerCall: false, job: true, detail: 'exit code: 1' }))
    expect(ring.status).toBe('fail')
    expect(ring.evidence.exitCode).toBe(1)
  })

  it('fails when the session header id differs from record.sessionId', () => {
    const ring = h1(makeSession({ innerCall: false, job: true }), { ...record, sessionId: OTHER_SESSION })
    expect(ring.status).toBe('fail')
  })

  it('fails with encoding=null when neither path A nor path B evidence exists', () => {
    const ring = h1(makeSession({ innerCall: false, job: false }))
    expect(ring.status).toBe('fail')
    expect(ring.evidence.encoding).toBeNull()
  })
})

describe('check-binding-host H4 (focused fixtures)', () => {
  it('passes when record.sessionId equals the session header id', () => {
    expect(h4Ring(makeSession(), record, redact).status).toBe('pass')
  })

  it('fails on a session id mismatch', () => {
    expect(h4Ring(makeSession(), { ...record, sessionId: OTHER_SESSION }, redact).status).toBe('fail')
  })
})

describe('check-binding-host job-evidence for H3/H5 (focused fixtures)', () => {
  it('accepts provenance-complete evidence whose own job is terminal and whose foreign call was rejected', () => {
    expect(validateJobEvidence(jobEvidence()).ok).toBe(true)
    const evaluated = evaluateJobEvidence(jobEvidence(), { record, headerId: SESSION, recordSessionId: SESSION, redact })
    expect(evaluated.status).toBe('pass')
  })

  it('keeps H3 pass only through the ring evaluation, not through a self-description', () => {
    const ring = h3Ring(analyzeSession(makeSession()), redact, { jobEvidence: jobEvidence(), record, headerId: SESSION })
    expect(ring.status).toBe('pass')
    expect(ring.evidence.jobEvidence.own.readAt.textChars).toBe(3)
  })

  it('keeps H3 manual when readAt.text is missing', () => {
    const evidence = jobEvidence()
    delete (evidence.own.readAt as { text?: string }).text
    const ring = h3Ring(analyzeSession(makeSession()), redact, { jobEvidence: evidence, record, headerId: SESSION })
    expect(ring.status).toBe('manual')
  })

  it('fails H3 when the foreign-session call was accepted', () => {
    const evidence = jobEvidence({ foreign: { threw: false, returned: true } })
    const ring = h3Ring(analyzeSession(makeSession()), redact, { jobEvidence: evidence, record, headerId: SESSION })
    expect(ring.status).toBe('fail')
  })

  it('fails H3 when own status is not terminal', () => {
    const evidence = jobEvidence({ own: { ...jobEvidence().own, status: 'running' } })
    expect(h3Ring(analyzeSession(makeSession()), redact, { jobEvidence: evidence, record, headerId: SESSION }).status).toBe('fail')
  })

  it('fails H3 when the evidence belongs to another session or job', () => {
    const otherSession = h3Ring(analyzeSession(makeSession()), redact, {
      jobEvidence: jobEvidence({ sessionId: OTHER_SESSION }), record, headerId: SESSION,
    })
    const otherJob = h3Ring(analyzeSession(makeSession()), redact, {
      jobEvidence: jobEvidence({ jobId: 'bash-other-0002' }), record, headerId: SESSION,
    })
    expect(otherSession.status).toBe('fail')
    expect(otherJob.status).toBe('fail')
  })

  it('passes H5 when readAt is readable and not lossy/truncated', () => {
    expect(h5Ring(analyzeSession(makeSession()), redact, { jobEvidence: jobEvidence() }).status).toBe('pass')
  })

  it('fails H5 when readAt is lossy and stays manual without job evidence', () => {
    const evidence = jobEvidence()
    evidence.own.readAt.lossy = true
    expect(h5Ring(analyzeSession(makeSession()), redact, { jobEvidence: evidence }).status).toBe('fail')
    expect(h5Ring(analyzeSession(makeSession()), redact).status).toBe('manual')
  })
})

// task-38: h2Ring must count EVERY bash tool/result (full-set statistics), not a 5-sample
// window. Regression: >5 all-structured results used to fail because 5 samples were compared
// against the total count. Tolerating a real missing value or loosening the field criterion
// would defeat the R1 acceptance precondition, so the negative cases stay fail.
describe('H2 full-set structured-value statistics (task-38)', () => {
  const foregroundValue = (exitCode = 0) => ({
    kind: 'foreground', exitCode, timedOut: false, aborted: false, signal: null,
    stdout: { text: 'ok', truncated: false }, stderr: { text: '', truncated: false },
  })

  function multiBashSession(values: Array<Record<string, unknown> | null>) {
    const callIds = values.map((_, index) => `call_h2_multi_${index}`)
    const events: Array<{ type: string; data: Record<string, unknown> }> = [
      { type: 'session', data: { type: 'session', version: 4, id: SESSION } },
    ]
    for (const callId of callIds) {
      events.push({ type: 'tool/call', data: { callId, name: 'bash', arguments: JSON.stringify({ command: COMMAND, workdir: CWD }) } })
    }
    values.forEach((value, index) => {
      events.push({
        type: 'tool/result',
        data: {
          message: {
            role: 'tool', toolCallId: callIds[index], isError: false,
            content: [{ type: 'text', text: '[exit code: 0]' }],
            ...(value ? { value } : {}),
          },
        },
      })
    })
    return { headerId: SESSION, events }
  }

  const h2 = (values: Array<Record<string, unknown> | null>) => h2Ring(analyzeSession(multiBashSession(values)), redact)

  it('passes when more than five bash results are all structured (no 5-sample window)', () => {
    const ring = h2(Array.from({ length: 7 }, () => foregroundValue(0)))
    expect(ring.status).toBe('pass')
    expect(ring.evidence?.bashResultCount).toBe(7)
    expect(ring.evidence?.structuredValueCount).toBe(7)
    // samples are human-readable only and may be capped; they must not drive the verdict
    expect(ring.evidence?.samples?.length).toBe(5)
  })

  it('fails when more than five results contain a real missing structured value', () => {
    const ring = h2([...Array.from({ length: 6 }, () => foregroundValue(0)), null])
    expect(ring.status).toBe('fail')
    expect(ring.evidence?.structuredValueCount).toBe(6)
    expect(ring.evidence?.problemCounts?.['missing-structured-value']).toBe(1)
  })

  it('keeps the <=5 behavior and does not loosen the field criterion', () => {
    expect(h2(Array.from({ length: 5 }, () => foregroundValue(0))).status).toBe('pass')
    expect(h2([foregroundValue(0), { kind: 'foreground', timedOut: false, aborted: false, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }]).status).toBe('fail')
    expect(h2([{ kind: 'promoted', jobId: 'bash-1', exitCode: 0 }]).status).toBe('fail')
    expect(h2([{ kind: 'promoted', timeoutMs: 1000 }]).status).toBe('fail')
    expect(h2([foregroundValue(0), { kind: 'promoted', jobId: 'bash-2', timeoutMs: 1000 }]).status).toBe('pass')
  })

  it('records uncovered promoted/background branches instead of claiming them', () => {
    const ring = h2([foregroundValue(0), foregroundValue(1)])
    expect(ring.status).toBe('pass')
    expect(ring.evidence?.uncoveredKinds).toEqual(['background', 'promoted'])
    expect(String(ring.notes)).toContain('未覆盖分支')
  })
})

