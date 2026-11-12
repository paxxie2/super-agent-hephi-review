/** Signed GitHub Issue webhooks: one loopback listener that turns `issues.opened` into the Trigger polling reads, verified before its body is parsed. */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { z } from 'zod'
import type { ReceiveResult } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { githubContext } from './github-repository.ts'
import { IssueSchema, issueTrigger, mentions, SOURCE } from './github-trigger.ts'
import type { SourceContext } from './host.ts'

/** The path the external HTTPS route forwards; GitHub sends every delivery, including `ping`, to it. */
export const WEBHOOK_PATH = '/github/issues'
/** Deployment variable naming the loopback port the listener binds; unset means the Source polls only. */
export const WEBHOOK_PORT_VARIABLE = 'DSH_SUPERAGENT_GITHUB_WEBHOOK_PORT'
/** Deployment variable carrying the secret both sides sign with; never logged. */
export const WEBHOOK_SECRET_VARIABLE = 'DSH_SUPERAGENT_GITHUB_WEBHOOK_SECRET'
/** Largest accepted request body; an Issue delivery is far smaller. */
export const WEBHOOK_MAX_BODY_BYTES = 1_000_000
/** The listener accepts connections from this machine only. */
const LOOPBACK = '127.0.0.1'
const LOOPBACK_ORIGIN = `http://${LOOPBACK}`
/** The Source fields this module reads; the GitHub kind's configuration fills the rest. */
type WebhookConfig = Record<string, unknown> & { allowSelfAuthoredIssues?: boolean; observeIssues?: boolean }
/** Port and secret the deployment provides for the loopback webhook listener. */
export interface WebhookSettings { port: number; secret: string }
/** Options of one webhook listener: the Source it feeds, the deployment's port and secret, and an optional diagnostic log. */
export interface GithubWebhookOptions {
  context: SourceContext
  /** Loopback port; `0` lets the operating system choose one, which only tests use. */
  port: number
  secret: string
  maxBodyBytes?: number
  /** One line per delivery or lifecycle event; never receives the secret or the Issue body. */
  log?: (line: string) => void
}
/** A running loopback listener. */
export interface GithubWebhook { readonly port: number; close(): Promise<void> }
const DeliverySchema = z.looseObject({
  action: z.string(),
  issue: IssueSchema,
  repository: z.looseObject({ full_name: z.string() }),
})
/** Reads the deployment-provided port and secret; returns undefined when the deployment configures neither. */
export function webhookSettings(env: NodeJS.ProcessEnv = process.env): WebhookSettings | undefined {
  const portText = env[WEBHOOK_PORT_VARIABLE]?.trim() ?? ''
  const secret = env[WEBHOOK_SECRET_VARIABLE] ?? ''
  if (!portText && !secret) return undefined
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${WEBHOOK_PORT_VARIABLE} must be a port number`)
  if (!secret) throw new Error(`${WEBHOOK_SECRET_VARIABLE} must be set when the webhook port is`)
  return { port, secret }
}
/** Verifies `X-Hub-Signature-256` over the raw request bytes before anything parses them. */
export function validWebhookSignature(secret: string, body: Buffer, header: string | undefined): boolean {
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(header?.trim() ?? '')
  if (!match) return false
  const expected = createHmac('sha256', secret).update(body).digest()
  const received = Buffer.from(match[1]!, 'hex')
  return received.length === expected.length && timingSafeEqual(received, expected)
}
/** The repositories this Source watches, canonical names as setup resolved them. */
function watched(context: SourceContext): string[] {
  const repositories = context.deployment.repositories
  return repositories?.length ? repositories : [context.deployment.repository]
}
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}
function send(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (response.headersSent) { response.end(); return }
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' })
  response.end(text)
}
/** Signals a body over the listener's byte limit; its request is answered without parsing anything. */
class WebhookBodyTooLarge extends Error {}
function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    request.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      size += chunk.length
      if (size > limit) { tooLarge = true; chunks.length = 0; reject(new WebhookBodyTooLarge()); return }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
    request.on('aborted', () => reject(new Error('Webhook request aborted')))
  })
}
/**
 * One delivery: only `POST /github/issues` is served; the signature is checked over the bounded raw body before JSON is
 * parsed; only an `issues/opened` event for a watched repository of an enabled Source observing Issues is taken in, through
 * the same `githubContext` and `issueTrigger` as polling, so both paths share the Trigger ID and the Engine deduplicates them.
 */
async function handle(options: GithubWebhookOptions, request: IncomingMessage, response: ServerResponse, log: (line: string) => void): Promise<void> {
  let path: string
  try { path = new URL(request.url ?? '/', LOOPBACK_ORIGIN).pathname } catch { send(response, 400, { ok: false, error: 'bad_request' }); return }
  if (path !== WEBHOOK_PATH) { send(response, 404, { ok: false, error: 'not_found' }); return }
  if (request.method !== 'POST') { send(response, 405, { ok: false, error: 'method_not_allowed' }); return }
  const receivedAt = new Date().toISOString()
  let body: Buffer
  try { body = await readBody(request, options.maxBodyBytes ?? WEBHOOK_MAX_BODY_BYTES) }
  catch (error) {
    if (error instanceof WebhookBodyTooLarge) { send(response, 413, { ok: false, error: 'body_too_large' }); request.resume(); return }
    throw error
  }
  if (!validWebhookSignature(options.secret, body, header(request, 'x-hub-signature-256'))) { send(response, 401, { ok: false, error: 'bad_signature' }); return }
  const event = header(request, 'x-github-event')
  if (event === 'ping') { log(`github webhook ping received=${receivedAt}`); send(response, 200, { ok: true, message: 'pong' }); return }
  if (event !== 'issues') { send(response, 202, { ok: true, ignored: 'event' }); return }
  const config = options.context.config<WebhookConfig>(SOURCE)
  if (!config) { send(response, 202, { ok: true, ignored: 'source_off' }); return }
  if (!config.observeIssues) { send(response, 202, { ok: true, ignored: 'issues_not_observed' }); return }
  let delivery: z.infer<typeof DeliverySchema>
  try { delivery = DeliverySchema.parse(JSON.parse(body.toString('utf8'))) }
  catch { send(response, 400, { ok: false, error: 'invalid_payload' }); return }
  if (delivery.action !== 'opened') { send(response, 202, { ok: true, ignored: 'action' }); return }
  const repository = watched(options.context).find(name => sameName(name, delivery.repository.full_name))
  if (!repository) { send(response, 202, { ok: true, ignored: 'repository_not_configured' }); return }
  const { login } = options.context.deployment.github
  const { issue } = delivery
  // The same author rules as polling: the agent's own Issue is taken in only with the opt-in and a body that mentions it.
  const selfAuthored = sameName(issue.user.login, login)
  const allowSelfAuthored = selfAuthored && !!config.allowSelfAuthoredIssues && mentions(issue.body ?? '', login)
  if (selfAuthored && !allowSelfAuthored) { send(response, 202, { ok: true, ignored: 'self_authored' }); return }
  const trigger = issueTrigger(issue, login, allowSelfAuthored ? { allowSelfAuthored: true } : undefined)
  let result: ReceiveResult
  try { result = await githubContext(options.context, repository).receive(trigger) }
  catch (error) { log(`github webhook failed ${repository}#${issue.number}: ${String(error)}`); send(response, 500, { ok: false, error: 'receive_failed' }); return }
  const ingestedAt = new Date().toISOString()
  if (result === 'filtered') {
    log(`github webhook filtered ${repository}#${issue.number} id=${trigger.id} received=${receivedAt} ingested=${ingestedAt}`)
    send(response, 202, { ok: true, ignored: 'filtered', triggerId: trigger.id, receivedAt, ingestedAt })
    return
  }
  log(`github webhook ${result} ${repository}#${issue.number} id=${trigger.id} received=${receivedAt} ingested=${ingestedAt}`)
  send(response, 200, { ok: true, triggerId: trigger.id, result, receivedAt, ingestedAt })
}
function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  return new Promise(resolve => {
    for (const socket of sockets) socket.destroy()
    if (!server.listening) { resolve(); return }
    server.close(() => resolve())
  })
}
/** Binds the loopback listener; resolves once it accepts deliveries, rejects when the port is unavailable. */
export async function startGithubWebhook(options: GithubWebhookOptions): Promise<GithubWebhook> {
  const log = options.log ?? (() => {})
  const sockets = new Set<Socket>()
  const server = createServer((request, response) => {
    handle(options, request, response, log).catch((error: unknown) => {
      // The path, the method and the body's errors are answered in `handle`; reaching here means reading the body failed.
      log(`github webhook request failed: ${String(error)}`)
      send(response, 500, { ok: false, error: 'internal' })
    })
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.keepAliveTimeout = 5_000
  await new Promise<void>((resolve, reject) => {
    const ready = (): void => { server.off('error', fail); resolve() }
    const fail = (error: Error): void => { server.off('listening', ready); reject(error) }
    server.once('error', fail)
    server.once('listening', ready)
    server.listen(options.port, LOOPBACK)
  })
  server.on('error', error => log(`github webhook server error: ${String(error)}`))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  return { port, close: () => closeServer(server, sockets) }
}
