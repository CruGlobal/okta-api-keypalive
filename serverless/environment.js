'use strict'

module.exports = () => {
  // Use dotenv to load local development overrides
  require('dotenv').config()
  return {
    ENVIRONMENT: process.env['ENVIRONMENT'] || 'development',
    ROLLBAR_ACCESS_TOKEN: process.env['ROLLBAR_ACCESS_TOKEN'] || '',
    OKTA_ORG_URL: process.env['OKTA_ORG_URL'] || 'https://signon.okta.com',
    API_KEY_PATHS: process.env['API_KEY_PATHS'] || '',
  }
}
