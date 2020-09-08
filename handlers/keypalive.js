import { Client } from '@okta/okta-sdk-nodejs'
import rollbar from '../config/rollbar'
import { SSM } from 'aws-sdk'

export const handler = async (lambdaEvent) => {
  try {
    const ssm = new SSM({ region: 'us-east-1' })
    const apiKeyPaths = process.env.API_KEY_PATHS.split(',')
    if (apiKeyPaths.length > 0) {
      const response = await ssm.getParameters({ Names: apiKeyPaths, WithDecryption: true }).promise()
      await Promise.allSettled(response.Parameters.map(parameter => {
        const client = new Client({ orgUrl: process.env.OKTA_ORG_URL, token: parameter.Value })
        return client.listUsers({ q: 'John', limit: 1 }).each(user => {})
      }))
    }
  } catch (error) {
    await rollbar.error(error.message, error)
    throw error
  }
}
