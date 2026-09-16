import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'

// This suite runs against the REAL `rollbar` package on purpose. The properties
// it pins are properties of the library's own contract -- where it reads
// `endpoint` from, and where `code_version` and a per-item fingerprint land in
// the payload it sends -- and a stubbed notifier cannot notice the library
// moving any of them. A dependency bump carrying a security advisory merges here
// without a human in the loop, so these need a test and not a comment.
//
// Nothing leaves the machine: each test starts a loopback receiver and points
// the notifier at it through ROLLBAR_ENDPOINT, which is the same environment
// variable production uses. No token and no real host are involved.

const UNHANDLED_EVENTS = ['uncaughtException', 'unhandledRejection']

/**
 * Whether importing the module actually constructed a notifier. Rollbar's
 * constructor installs process-level handlers that it tags as its own, and it
 * does so whatever `enabled` says -- so this tells "no notifier was built"
 * apart from "a notifier was built and switched off", which is the difference
 * the fail-closed guard is about.
 */
const notifierConstructed = () =>
  UNHANDLED_EVENTS.some(event =>
    process.listeners(event).some(listener => listener._rollbarHandler)
  )

const removeNotifierHandlers = () => {
  for (const event of UNHANDLED_EVENTS) {
    for (const listener of process.listeners(event)) {
      if (listener._rollbarHandler) process.removeListener(event, listener)
    }
  }
}

// Deliberately not the notifier's own default path: if anything substituted a
// default endpoint, the receiver would see nothing at all.
const ENDPOINT_PATH = '/ingest-probe/api/1/item/'

let originalEnv
let server
let endpoint
let received

beforeEach(async () => {
  originalEnv = process.env
  process.env = { ...originalEnv }
  delete process.env.ROLLBAR_ACCESS_TOKEN
  delete process.env.ROLLBAR_ENDPOINT
  delete process.env.DD_VERSION
  process.env.ENVIRONMENT = 'staging'

  received = []
  server = http.createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      received.push({ path: request.url, payload: JSON.parse(body) })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"err":0}')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${server.address().port}${ENDPOINT_PATH}`

  removeNotifierHandlers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  removeNotifierHandlers()
  await new Promise(resolve => server.close(resolve))
  process.env = originalEnv
  vi.restoreAllMocks()
})

/** A fresh copy of the module, built against the environment the test set. */
const loadReporter = async () => {
  vi.resetModules()
  return (await import('./rollbar.js')).default
}

// Reporting is off unless BOTH variables are present. Half-configured is the
// dangerous state: the notifier's own default endpoint is the Rollbar SaaS, so a
// token with no endpoint would post this app's errors to the wrong host, where
// the rejection is silent.
describe('fail closed', () => {
  it.each([
    ['neither variable is set', { token: false, endpoint: false }],
    ['there is a token but no endpoint', { token: true, endpoint: false }],
    ['there is an endpoint but no token', { token: false, endpoint: true }]
  ])('constructs no notifier and posts nothing when %s', async (_label, shape) => {
    if (shape.token) process.env.ROLLBAR_ACCESS_TOKEN = 'server-token'
    if (shape.endpoint) process.env.ROLLBAR_ENDPOINT = endpoint

    const reporter = await loadReporter()

    expect(notifierConstructed()).toBe(false)

    // Load-bearing: the handler awaits these. Rejecting here would turn "not
    // configured" into a failed invocation.
    await expect(reporter.error('probe', new Error('probe'))).resolves.toBeUndefined()
    await expect(reporter.warning('probe', { fingerprint: 'probe' })).resolves.toBeUndefined()

    expect(received).toEqual([])
  })

  it('says so in the log when a reporting environment has no reporting', async () => {
    await loadReporter()

    const warned = console.warn.mock.calls.map(([line]) => line)
    expect(warned.some(line => line.includes('Error reporting is OFF'))).toBe(true)
  })

  it('stays quiet about it outside a reporting environment', async () => {
    delete process.env.ENVIRONMENT

    await loadReporter()

    expect(console.warn).not.toHaveBeenCalled()
  })
})

describe('with both variables set', () => {
  beforeEach(() => {
    process.env.ROLLBAR_ACCESS_TOKEN = 'server-token'
    process.env.DD_VERSION = '2026-09-16-10142'
  })

  it('posts to exactly the endpoint from the environment, with no default substituted', async () => {
    process.env.ROLLBAR_ENDPOINT = endpoint

    const reporter = await loadReporter()
    await reporter.error('probe failure', new Error('probe failure'))

    expect(notifierConstructed()).toBe(true)
    expect(received).toHaveLength(1)
    expect(received[0].path).toBe(ENDPOINT_PATH)
    expect(received[0].payload.access_token).toBe('server-token')
  })

  // The server contract: `code_version` at the top level of the payload. The
  // `client.javascript` block is the browser contract and must not come back.
  it('sends code_version at the payload top level and no browser client block', async () => {
    process.env.ROLLBAR_ENDPOINT = endpoint

    const reporter = await loadReporter()
    await reporter.error('probe failure', new Error('probe failure'))

    const { data } = received[0].payload
    expect(data.code_version).toBe('2026-09-16-10142')
    expect(data.client).toBeUndefined()
    expect(data.environment).toBe('staging')
  })

  // The handler's grouping depends on a per-item fingerprint reaching the top
  // level of the payload, which the library does by lifting custom keys it does
  // not recognise. If a bump stops lifting it, every run opens its own error
  // group again and this test is how we find out.
  it('lifts a per-item fingerprint to the top level of the payload', async () => {
    process.env.ROLLBAR_ENDPOINT = endpoint

    const reporter = await loadReporter()
    await reporter.warning('probe warning', {
      fingerprint: 'okta-api-keypalive:probe',
      keypalive: { attempted: 2, failed: 1 }
    })

    const { data } = received[0].payload
    expect(data.fingerprint).toBe('okta-api-keypalive:probe')
    expect(data.level).toBe('warning')
    expect(data.custom.keypalive).toMatchObject({ attempted: 2, failed: 1 })
  })

  // The ENVIRONMENT gate is unchanged and independent: both variables present
  // still reports nothing outside a reporting environment.
  it('posts nothing outside a reporting environment', async () => {
    process.env.ROLLBAR_ENDPOINT = endpoint
    delete process.env.ENVIRONMENT

    const reporter = await loadReporter()
    await reporter.error('probe failure', new Error('probe failure'))

    expect(received).toEqual([])
  })
})
