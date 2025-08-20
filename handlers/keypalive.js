import {SSMClient, GetParametersCommand} from "@aws-sdk/client-ssm"
import { Client as Okta } from '@okta/okta-sdk-nodejs'
import rollbar from '../config/rollbar'

export const handler = async (lambdaEvent) => {
  try {
    const apiKeyPaths = process.env.API_KEY_PATHS.split(',')
    if (apiKeyPaths.length > 0) {
      const ssm = new SSMClient({region: 'us-east-1'})
      const command = new GetParametersCommand({Names: apiKeyPaths, WithDecryption: true})
      const results = await ssm.send(command)
      await Promise.allSettled(results.Parameters.map(parameter => {
        const okta = new Okta({ orgUrl: process.env.OKTA_ORG_URL, token: parameter.Value })
        return okta.userApi.listUsers({ q: 'John', limit: 1 })
      }))
    }
  } catch (error) {
    await rollbar.error(error.message, error)
    throw error
  }
}
