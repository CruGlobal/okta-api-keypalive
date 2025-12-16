import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm'
import { Client } from '@okta/okta-sdk-nodejs'
import rollbar from '../config/rollbar'

const ssmClient = new SSMClient({ region: 'us-east-1' })

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
    const apiKeyPathChunks = apiKeyPaths.reduce((acc, _, index) => {
      acc.push(apiKeyPaths.slice(index, index + 10))
      return acc
    }, [])

    for (const keys of apiKeyPathChunks) {
      const command = new GetParametersCommand({ Names: keys, WithDecryption: true })
      const results = await ssmClient.send(command)
      for (const parameter of results.Parameters) {
        try {
          console.log(`Keypalive: ${parameter.Name}`)
          const client = new Client({
            orgUrl: process.env.OKTA_ORG_URL,
            token: parameter.Value,
            cacheMiddleware: null,
          })
          const collection = await client.userApi.listUsers({
            search: 'profile.firstName sw "John"',
            limit: 1
          })
          await collection.each(user => {
            console.log("Keypalive user: ", user)
          })
        } catch (error) {
          console.error(`${parameter.Name}: ${error.message}`)
          console.error(error.stack)
        }
      }
    }
  } catch (error) {
    console.error(error)
    await rollbar.error(error.message, error)
    throw error
  }
}
