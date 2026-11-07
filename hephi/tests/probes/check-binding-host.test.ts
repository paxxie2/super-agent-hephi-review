import { describe, expect, it } from 'vitest'
// @ts-expect-error -- the zero-dependency probe is plain ESM with no type declarations
import { analyzeSession, evaluateJobEvidence, h1Ring, h3Ring, h4Ring, h5Ring, validateJobEvidence } from '../../scripts/check-binding-host.mjs'

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
    job = true,
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

  it('path A wins even when the job events disagree', () => {
    const ring = h1(makeSession({ innerCall: true, owner: OTHER_SESSION, label: `${COMMAND} --extra` }))
    expect(ring.status).toBe('pass')
    expect(ring.evidence.encoding).toBe('path-A')
  })
})

describe('check-binding-host path B (focused fixtures)', () => {
  it('passes on root call + job/registered + job/settled with owner, command and exit code', () => {
    const ring = h1(makeSession({ innerCall: false }))
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
    const ring = h1(makeSession({ innerCall: false, owner: OTHER_SESSION }))
    expect(ring.status).toBe('fail')
    expect(ring.evidence.ownerMatchesSession).toBe(false)
  })

  it('fails when the job label differs from the rebuilt command', () => {
    const ring = h1(makeSession({ innerCall: false, label: `${COMMAND} --extra` }))
    expect(ring.status).toBe('fail')
    expect(ring.evidence.labelMatchesCommand).toBe(false)
  })

  it('fails on a truncated label instead of accepting a prefix', () => {
    const ring = h1(makeSession({ innerCall: false, label: COMMAND.slice(0, 50) }))
    expect(ring.status).toBe('fail')
    expect(ring.evidence.labelMatchesCommand).toBe(false)
    expect(String(ring.evidence.notes)).toContain('截断')
  })

  it('fails when the settled exit code disagrees with record.exitCode', () => {
    const ring = h1(makeSession({ innerCall: false, detail: 'exit code: 1' }))
    expect(ring.status).toBe('fail')
    expect(ring.evidence.exitCode).toBe(1)
  })

  it('fails when the session header id differs from record.sessionId', () => {
    const ring = h1(makeSession({ innerCall: false }), { ...record, sessionId: OTHER_SESSION })
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
