import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm'
import { Client } from '@okta/okta-sdk-nodejs'
import rollbar from '../config/rollbar'

const ssmClient = new SSMClient({ region: 'us-east-1' })

// A run that fails some of its keys reports ONE aggregate item, and the message
// never varies: an item with no stack frames is grouped by its message, so
// spelling the counts into the text ("2 of 7 keys failed") would open a brand
// new error group -- and a brand new alert -- every time a different number of
// keys failed. The counts travel in `custom` instead, and the explicit
// fingerprint keeps every run in the same group.
const FAILURE_MESSAGE = 'Okta API keypalive failed for at least one API key'
const FAILURE_FINGERPRINT = 'okta-api-keypalive:keypalive-failures'

/**
 * Report a run's per-key failures as a single item, tiered by outcome:
 *
 * - every key that was attempted failed -> `error` (nothing was kept alive, so
 *   keys are on their way to expiring, which is the one thing this function
 *   exists to prevent)
 * - some but not all failed -> `warning`
 * - nothing was attempted (a dry run, or SSM returned no parameters), or
 *   nothing failed -> no report at all
 *
 * Per-key failures stay non-fatal: this reports and returns, it never throws
 * and never aborts the remaining keys.
 */
const reportFailedKeys = async (attempted, failed) => {
  if (attempted.length === 0 || failed.length === 0) return

  const level = failed.length === attempted.length ? 'error' : 'warning'
  await rollbar[level](FAILURE_MESSAGE, {
    fingerprint: FAILURE_FINGERPRINT,
    keypalive: {
      attempted: attempted.length,
      failed: failed.length,
      succeeded: attempted.length - failed.length,
      // Parameter paths and error messages only -- never a token value.
      failures: failed
    }
  })
}

export const handler = async (event, context) => {
  try {
    if (!process.env.API_KEY_PATHS) {
      throw new Error('API_KEY_PATHS secret is not set.')
    }
    if (!process.env.OKTA_ORG_URL) {
      throw new Error('OKTA_ORG_URL secret is not set.')
    }

    const apiKeyPaths = process.env.API_KEY_PATHS.split(',')
    console.log(`API Key Paths: ${JSON.stringify(apiKeyPaths, null, 2)}`)

    const dryRun = process.env.DRY_RUN === 'true'
    if (dryRun) {
      console.log(`DRY_RUN enabled: no keepalive calls will be executed. Would hit Okta org ${process.env.OKTA_ORG_URL} with ${apiKeyPaths.length} key(s): ${JSON.stringify(apiKeyPaths, null, 2)}`)
    }

    // Chunk into groups of 10 (GetParameters accepts at most 10 names per call).
    const apiKeyPathChunks = apiKeyPaths.reduce((acc, _, index) => {
      if (index % 10 === 0) acc.push(apiKeyPaths.slice(index, index + 10))
      return acc
    }, [])

    const attempted = []
    const failed = []

    for (const keys of apiKeyPathChunks) {
      const command = new GetParametersCommand({ Names: keys, WithDecryption: true })
      const results = await ssmClient.send(command)
      for (const parameter of results.Parameters) {
        // Counted before the attempt, so `failed` is always a subset of
        // `attempted` even when the failure happens before the Okta call. A dry
        // run attempts nothing, so it counts nothing.
        if (!dryRun) attempted.push(parameter.Name)
        try {
          console.log(`Keypalive: ${parameter.Name}`)
          const client = new Client({
            orgUrl: process.env.OKTA_ORG_URL,
            token: parameter.Value,
            cacheMiddleware: null
          })
          if (dryRun) {
            console.log(`Keypalive [DRY_RUN]: skipping Okta call for ${parameter.Name}`)
            continue
          }
          const collection = await client.userApi.listUsers({
            search: 'profile.firstName sw "John"',
            limit: 1
          })
          await collection.each(user => false)
        } catch (error) {
          // One bad key must not stop the rest: log it, remember it, carry on.
          failed.push({ parameter: parameter.Name, message: error.message })
          console.error(`${parameter.Name}: ${error.message}`)
          console.error(error.stack)
        }
      }
    }

    await reportFailedKeys(attempted, failed)
  } catch (error) {
    console.error(error)
    await rollbar.error(error.message, error)
    throw error
  }
}
