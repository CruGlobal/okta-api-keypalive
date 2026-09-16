import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Declared through `vi.hoisted` so the `vi.mock` factories below -- which
// vitest lifts above every import in this file -- can close over these without
// tripping a temporal-dead-zone error.
const mocks = vi.hoisted(() => ({
  ssmClientConfigs: [],
  getParametersInputs: [],
  oktaClientConfigs: [],
  ssmSend: vi.fn(),
  listUsers: vi.fn(),
  each: vi.fn(),
  rollbarError: vi.fn(),
  rollbarWarning: vi.fn()
}))

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class SSMClient {
    constructor (config) {
      mocks.ssmClientConfigs.push(config)
    }

    send (command) {
      return mocks.ssmSend(command)
    }
  },

  GetParametersCommand: class GetParametersCommand {
    constructor (input) {
      this.input = input
      mocks.getParametersInputs.push(input)
    }
  }
}))

vi.mock('@okta/okta-sdk-nodejs', () => ({
  Client: class Client {
    constructor (config) {
      mocks.oktaClientConfigs.push(config)
      this.userApi = { listUsers: mocks.listUsers }
    }
  }
}))

// The real module builds a Rollbar client at import time; stub it so no test
// needs a token and so we can assert on what gets reported.
vi.mock('../config/rollbar', () => ({
  default: { error: mocks.rollbarError, warning: mocks.rollbarWarning }
}))

// Imported after the mocks are registered. The handler module constructs its
// SSMClient at module scope, so this import is what exercises that.
const { handler } = await import('./keypalive.js')

// Snapshotted at import time: `beforeEach` clears the per-test capture arrays,
// but the module-scope client is only ever constructed once.
const ssmClientConfigAtImport = mocks.ssmClientConfigs[0]

/** Build the SSM response shape for the given parameter paths. */
const ssmParameters = (...names) => ({
  Parameters: names.map(name => ({ Name: name, Value: `token-for-${name}` }))
})

/** The names requested across every GetParameters call, chunk by chunk. */
const requestedChunks = () => mocks.getParametersInputs.map(input => input.Names)

const paths = count =>
  Array.from({ length: count }, (_, index) => `/okta/api-key/${index}`)

/**
 * The single aggregate report a run sent, whatever level it came in at --
 * asserting along the way that there was exactly one of them.
 */
const aggregateReport = () => {
  const calls = [
    ...mocks.rollbarError.mock.calls.map(call => ({ level: 'error', call })),
    ...mocks.rollbarWarning.mock.calls.map(call => ({ level: 'warning', call }))
  ]
  expect(calls).toHaveLength(1)
  const { level, call: [message, custom] } = calls[0]
  return { level, message, custom }
}

let originalEnv

beforeEach(() => {
  originalEnv = process.env
  process.env = { ...originalEnv }
  delete process.env.API_KEY_PATHS
  delete process.env.OKTA_ORG_URL
  delete process.env.DRY_RUN

  vi.clearAllMocks()
  mocks.getParametersInputs.length = 0
  mocks.oktaClientConfigs.length = 0

  // Default happy path: every requested name comes back decrypted, and the
  // Okta probe resolves to a drainable collection.
  mocks.ssmSend.mockImplementation(command =>
    Promise.resolve(ssmParameters(...command.input.Names))
  )
  mocks.each.mockResolvedValue(undefined)
  mocks.listUsers.mockResolvedValue({ each: mocks.each })

  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  process.env = originalEnv
  vi.restoreAllMocks()
})

describe('required configuration', () => {
  it('rejects when API_KEY_PATHS is not set', async () => {
    process.env.OKTA_ORG_URL = 'https://cru.okta.com'

    await expect(handler({}, {})).rejects.toThrow(
      'API_KEY_PATHS secret is not set.'
    )
  })

  it('rejects when OKTA_ORG_URL is not set', async () => {
    process.env.API_KEY_PATHS = '/okta/api-key/one'

    await expect(handler({}, {})).rejects.toThrow(
      'OKTA_ORG_URL secret is not set.'
    )
  })

  it('touches neither SSM nor Okta when configuration is missing', async () => {
    await expect(handler({}, {})).rejects.toThrow()

    expect(mocks.ssmSend).not.toHaveBeenCalled()
    expect(mocks.listUsers).not.toHaveBeenCalled()
  })

  it('reports the failure to Rollbar before rethrowing', async () => {
    process.env.API_KEY_PATHS = '/okta/api-key/one'

    await expect(handler({}, {})).rejects.toThrow()

    expect(mocks.rollbarError).toHaveBeenCalledTimes(1)
    const [message, error] = mocks.rollbarError.mock.calls[0]
    expect(message).toBe('OKTA_ORG_URL secret is not set.')
    expect(error).toBeInstanceOf(Error)
  })

  it('treats an empty API_KEY_PATHS as unset', async () => {
    process.env.API_KEY_PATHS = ''
    process.env.OKTA_ORG_URL = 'https://cru.okta.com'

    await expect(handler({}, {})).rejects.toThrow(
      'API_KEY_PATHS secret is not set.'
    )
  })
})

describe('SSM parameter fetching', () => {
  beforeEach(() => {
    process.env.OKTA_ORG_URL = 'https://cru.okta.com'
  })

  it('constructs its SSM client for us-east-1', () => {
    expect(ssmClientConfigAtImport).toEqual({ region: 'us-east-1' })
  })

  it('requests the single configured path with decryption', async () => {
    process.env.API_KEY_PATHS = '/okta/api-key/one'

    await handler({}, {})

    expect(mocks.getParametersInputs).toEqual([
      { Names: ['/okta/api-key/one'], WithDecryption: true }
    ])
  })

  it('splits a comma-separated list into individual parameter names', async () => {
    process.env.API_KEY_PATHS = '/okta/a,/okta/b,/okta/c'

    await handler({}, {})

    expect(requestedChunks()).toEqual([['/okta/a', '/okta/b', '/okta/c']])
  })

  it('requests decryption on every call', async () => {
    process.env.API_KEY_PATHS = paths(23).join(',')

    await handler({}, {})

    for (const input of mocks.getParametersInputs) {
      expect(input.WithDecryption).toBe(true)
    }
  })

  it('sends a single call for exactly 10 paths', async () => {
    process.env.API_KEY_PATHS = paths(10).join(',')

    await handler({}, {})

    expect(requestedChunks()).toEqual([paths(10)])
  })

  it('never puts more than 10 names in one GetParameters call', async () => {
    process.env.API_KEY_PATHS = paths(25).join(',')

    await handler({}, {})

    expect(requestedChunks()).toHaveLength(3)
    for (const chunk of requestedChunks()) {
      expect(chunk.length).toBeLessThanOrEqual(10)
    }
  })

  // Regression pin for "fix: chunk API key paths without overlap": every path
  // must be requested exactly once, in order.
  it('chunks without overlap or omission', async () => {
    const all = paths(25)
    process.env.API_KEY_PATHS = all.join(',')

    await handler({}, {})

    expect(requestedChunks()).toEqual([
      all.slice(0, 10),
      all.slice(10, 20),
      all.slice(20, 25)
    ])
    expect(requestedChunks().flat()).toEqual(all)
  })
})

// The property the release-candidate surface depends on: that environment runs
// the identical image with DRY_RUN=true against real SSM parameters, and must
// not touch any Okta tenant. If these tests fail, stage is no longer a safe
// rehearsal.
describe('DRY_RUN safety', () => {
  beforeEach(() => {
    process.env.OKTA_ORG_URL = 'https://cru.okta.com'
    process.env.DRY_RUN = 'true'
  })

  it('makes NO Okta keepalive call', async () => {
    process.env.API_KEY_PATHS = '/okta/a,/okta/b'

    await handler({}, {})

    expect(mocks.listUsers).not.toHaveBeenCalled()
    expect(mocks.each).not.toHaveBeenCalled()
  })

  // `continue` (not `break`): the skip must hold for every parameter in every
  // chunk, not just the first one.
  it('makes no Okta call for any parameter, across chunk boundaries', async () => {
    process.env.API_KEY_PATHS = paths(12).join(',')

    await handler({}, {})

    expect(requestedChunks()).toHaveLength(2)
    expect(mocks.listUsers).not.toHaveBeenCalled()
    expect(mocks.each).not.toHaveBeenCalled()
  })

  it('still fetches the decrypted parameters, so the SSM path is rehearsed', async () => {
    process.env.API_KEY_PATHS = '/okta/a,/okta/b'

    await handler({}, {})

    expect(mocks.ssmSend).toHaveBeenCalledTimes(1)
    expect(mocks.getParametersInputs).toEqual([
      { Names: ['/okta/a', '/okta/b'], WithDecryption: true }
    ])
  })

  it('resolves successfully', async () => {
    process.env.API_KEY_PATHS = '/okta/a'

    await expect(handler({}, {})).resolves.toBeUndefined()
    expect(mocks.rollbarError).not.toHaveBeenCalled()
  })

  // Promotion is gated on reading these logs, so the announcement is part of
  // the contract, not incidental noise.
  it('announces the dry run and every skipped parameter', async () => {
    process.env.API_KEY_PATHS = '/okta/a,/okta/b'

    await handler({}, {})

    const logged = console.log.mock.calls.map(([line]) => line)
    expect(logged.some(line => line.includes('DRY_RUN enabled'))).toBe(true)
    expect(
      logged.some(
        line =>
          line.includes('DRY_RUN enabled') &&
          line.includes('https://cru.okta.com') &&
          line.includes('2 key(s)')
      )
    ).toBe(true)
    expect(
      logged.filter(line => line.includes('[DRY_RUN]: skipping Okta call'))
    ).toHaveLength(2)
  })

  // DRY_RUN is a Terraform-owned per-environment function variable compared with
  // `=== 'true'`. Anything else -- including a capitalised typo -- means the
  // real Okta call happens. Pinned because getting this wrong in Terraform
  // would silently turn stage into a live run.
  it.each(['True', 'TRUE', '1', 'yes', 'false', ''])(
    'treats DRY_RUN=%o as NOT a dry run',
    async value => {
      process.env.API_KEY_PATHS = '/okta/a'
      process.env.DRY_RUN = value

      await handler({}, {})

      expect(mocks.listUsers).toHaveBeenCalledTimes(1)
    }
  )

  it('performs the keepalive call when DRY_RUN is unset', async () => {
    process.env.API_KEY_PATHS = '/okta/a'
    delete process.env.DRY_RUN

    await handler({}, {})

    expect(mocks.listUsers).toHaveBeenCalledTimes(1)
  })
})

describe('keepalive call', () => {
  beforeEach(() => {
    process.env.OKTA_ORG_URL = 'https://cru.okta.com'
    process.env.DRY_RUN = 'false'
  })

  it('builds one Okta client per parameter with that parameter decrypted token', async () => {
    process.env.API_KEY_PATHS = '/okta/a,/okta/b'

    await handler({}, {})

    expect(mocks.oktaClientConfigs).toEqual([
      {
        orgUrl: 'https://cru.okta.com',
        token: 'token-for-/okta/a',
        cacheMiddleware: null
      },
      {
        orgUrl: 'https://cru.okta.com',
        token: 'token-for-/okta/b',
        cacheMiddleware: null
      }
    ])
  })

  it('issues the trivial probe and drains the collection', async () => {
    process.env.API_KEY_PATHS = '/okta/a'

    await handler({}, {})

    expect(mocks.listUsers).toHaveBeenCalledWith({
      search: 'profile.firstName sw "John"',
      limit: 1
    })
    expect(mocks.each).toHaveBeenCalledTimes(1)
  })

  it('keeps alive every parameter across every chunk', async () => {
    process.env.API_KEY_PATHS = paths(23).join(',')

    await handler({}, {})

    expect(mocks.listUsers).toHaveBeenCalledTimes(23)
    expect(mocks.oktaClientConfigs.map(config => config.token)).toEqual(
      paths(23).map(path => `token-for-${path}`)
    )
  })

  // GetParameters silently omits paths that do not exist (they come back under
  // InvalidParameters instead), so a bad path is skipped rather than fatal.
  it('only keeps alive the parameters SSM actually returned', async () => {
    process.env.API_KEY_PATHS = '/okta/real,/okta/missing'
    mocks.ssmSend.mockResolvedValue(ssmParameters('/okta/real'))

    await handler({}, {})

    expect(mocks.listUsers).toHaveBeenCalledTimes(1)
    expect(mocks.oktaClientConfigs).toEqual([
      {
        orgUrl: 'https://cru.okta.com',
        token: 'token-for-/okta/real',
        cacheMiddleware: null
      }
    ])
  })
})

describe('error handling', () => {
  beforeEach(() => {
    process.env.OKTA_ORG_URL = 'https://cru.okta.com'
  })

  it('keeps a failing token from stopping the remaining tokens', async () => {
    process.env.API_KEY_PATHS = '/okta/bad,/okta/good'
    mocks.listUsers
      .mockRejectedValueOnce(new Error('401 invalid token'))
      .mockResolvedValueOnce({ each: mocks.each })

    await expect(handler({}, {})).resolves.toBeUndefined()

    expect(mocks.listUsers).toHaveBeenCalledTimes(2)
    expect(mocks.each).toHaveBeenCalledTimes(1)
  })

  // A per-token failure is reported (see "aggregate failure reporting") but it
  // is still non-fatal: the invocation resolves.
  it('does not fail the invocation on a per-token failure', async () => {
    process.env.API_KEY_PATHS = '/okta/bad'
    mocks.listUsers.mockRejectedValue(new Error('401 invalid token'))

    await expect(handler({}, {})).resolves.toBeUndefined()

    expect(console.error).toHaveBeenCalled()
  })

  it('logs the offending parameter name with a per-token failure', async () => {
    process.env.API_KEY_PATHS = '/okta/bad'
    mocks.listUsers.mockRejectedValue(new Error('401 invalid token'))

    await handler({}, {})

    const logged = console.error.mock.calls.map(([line]) => line)
    expect(
      logged.some(
        line =>
          typeof line === 'string' &&
          line.includes('/okta/bad') &&
          line.includes('401 invalid token')
      )
    ).toBe(true)
  })

  it('fails the whole invocation when SSM fails, and reports it', async () => {
    process.env.API_KEY_PATHS = '/okta/a'
    mocks.ssmSend.mockRejectedValue(new Error('AccessDeniedException'))

    await expect(handler({}, {})).rejects.toThrow('AccessDeniedException')

    expect(mocks.rollbarError).toHaveBeenCalledTimes(1)
    expect(mocks.rollbarError.mock.calls[0][0]).toBe('AccessDeniedException')
    expect(mocks.listUsers).not.toHaveBeenCalled()
  })

  it('stops at the failing chunk when SSM fails midway', async () => {
    process.env.API_KEY_PATHS = paths(15).join(',')
    mocks.ssmSend
      .mockImplementationOnce(command =>
        Promise.resolve(ssmParameters(...command.input.Names))
      )
      .mockRejectedValueOnce(new Error('ThrottlingException'))

    await expect(handler({}, {})).rejects.toThrow('ThrottlingException')

    expect(mocks.ssmSend).toHaveBeenCalledTimes(2)
    expect(mocks.listUsers).toHaveBeenCalledTimes(10)
  })
})

// A key that fails its keepalive is a key on its way to expiring -- the one
// thing this function exists to prevent -- so the run reports the outcome even
// though it keeps going. One aggregate item per run, tiered by how bad the run
// was, and fingerprinted so every run lands in the same error group.
describe('aggregate failure reporting', () => {
  beforeEach(() => {
    process.env.OKTA_ORG_URL = 'https://cru.okta.com'
    process.env.DRY_RUN = 'false'
  })

  it('reports at error level when every attempted key failed', async () => {
    process.env.API_KEY_PATHS = '/okta/a,/okta/b'
    mocks.listUsers.mockRejectedValue(new Error('401 invalid token'))

    await expect(handler({}, {})).resolves.toBeUndefined()

    const { level, custom } = aggregateReport()
    expect(level).toBe('error')
    expect(custom.keypalive).toMatchObject({
      attempted: 2,
      failed: 2,
      succeeded: 0
    })
  })

  it('reports at warning level when only some attempted keys failed', async () => {
    process.env.API_KEY_PATHS = '/okta/bad,/okta/good'
    mocks.listUsers
      .mockRejectedValueOnce(new Error('401 invalid token'))
      .mockResolvedValueOnce({ each: mocks.each })

    await handler({}, {})

    const { level, custom } = aggregateReport()
    expect(level).toBe('warning')
    expect(mocks.rollbarError).not.toHaveBeenCalled()
    expect(custom.keypalive).toMatchObject({
      attempted: 2,
      failed: 1,
      succeeded: 1
    })
    expect(custom.keypalive.failures).toEqual([
      { parameter: '/okta/bad', message: '401 invalid token' }
    ])
  })

  it('reports nothing when every key is kept alive', async () => {
    process.env.API_KEY_PATHS = paths(12).join(',')

    await handler({}, {})

    expect(mocks.listUsers).toHaveBeenCalledTimes(12)
    expect(mocks.rollbarError).not.toHaveBeenCalled()
    expect(mocks.rollbarWarning).not.toHaveBeenCalled()
  })

  // Nothing attempted, nothing reported: a dry run makes no Okta call, so it
  // has no keepalive outcome to report and must stay silent.
  it('reports nothing for a dry run', async () => {
    process.env.DRY_RUN = 'true'
    process.env.API_KEY_PATHS = '/okta/a,/okta/b'

    await handler({}, {})

    expect(mocks.rollbarError).not.toHaveBeenCalled()
    expect(mocks.rollbarWarning).not.toHaveBeenCalled()
  })

  // GetParameters omits paths that do not exist, so a run can legitimately
  // attempt nothing at all. Zero of zero is not a total failure.
  it('reports nothing when SSM returns no parameters', async () => {
    process.env.API_KEY_PATHS = '/okta/missing'
    mocks.ssmSend.mockResolvedValue({ Parameters: [] })

    await handler({}, {})

    expect(mocks.listUsers).not.toHaveBeenCalled()
    expect(mocks.rollbarError).not.toHaveBeenCalled()
    expect(mocks.rollbarWarning).not.toHaveBeenCalled()
  })

  it('sends one aggregate item for the run, never one per key', async () => {
    process.env.API_KEY_PATHS = paths(23).join(',')
    mocks.listUsers.mockRejectedValue(new Error('401 invalid token'))

    await handler({}, {})

    expect(mocks.listUsers).toHaveBeenCalledTimes(23)
    const { level, custom } = aggregateReport()
    expect(level).toBe('error')
    expect(custom.keypalive.failed).toBe(23)
  })

  // A frameless item is grouped by its message, so counts in the message text
  // would open a new error group -- and fire a new alert -- on every run with a
  // different tally. They belong in the custom data.
  it('keeps the counts out of the message and in the custom data', async () => {
    process.env.API_KEY_PATHS = '/okta/bad,/okta/a,/okta/b'
    mocks.listUsers
      .mockRejectedValueOnce(new Error('401 invalid token'))
      .mockResolvedValue({ each: mocks.each })

    await handler({}, {})

    const { message, custom } = aggregateReport()
    expect(message).not.toMatch(/\d/)
    expect(custom.keypalive).toMatchObject({
      attempted: 3,
      failed: 1,
      succeeded: 2
    })
  })

  it('fingerprints the report the same however many keys failed', async () => {
    process.env.API_KEY_PATHS = '/okta/bad,/okta/good'
    mocks.listUsers
      .mockRejectedValueOnce(new Error('401 invalid token'))
      .mockResolvedValueOnce({ each: mocks.each })

    await handler({}, {})
    const partial = aggregateReport()

    mocks.rollbarError.mockClear()
    mocks.rollbarWarning.mockClear()
    mocks.listUsers.mockReset()
    mocks.listUsers.mockRejectedValue(new Error('500 upstream failure'))
    process.env.API_KEY_PATHS = paths(3).join(',')

    await handler({}, {})
    const total = aggregateReport()

    // Different tiers, different counts, different underlying errors -- same
    // group.
    expect(partial.level).toBe('warning')
    expect(total.level).toBe('error')
    expect(typeof partial.custom.fingerprint).toBe('string')
    expect(total.custom.fingerprint).toBe(partial.custom.fingerprint)
    expect(total.message).toBe(partial.message)
    expect(total.custom.keypalive.failed).not.toBe(partial.custom.keypalive.failed)
  })

  it('keeps every remaining key alive when one of them fails', async () => {
    process.env.API_KEY_PATHS = '/okta/bad,/okta/a,/okta/b,/okta/c'
    mocks.listUsers
      .mockRejectedValueOnce(new Error('401 invalid token'))
      .mockResolvedValue({ each: mocks.each })

    await expect(handler({}, {})).resolves.toBeUndefined()

    expect(mocks.listUsers).toHaveBeenCalledTimes(4)
    expect(mocks.each).toHaveBeenCalledTimes(3)
    expect(aggregateReport().custom.keypalive.succeeded).toBe(3)
  })
})
