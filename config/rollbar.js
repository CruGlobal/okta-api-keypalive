'use strict'

import Rollbar from 'rollbar'

const environments = ['staging', 'production', 'lab']

// Reporting fails CLOSED: no notifier is built unless both the token and the
// endpoint are present. There is deliberately no built-in endpoint default --
// the notifier's own default is the Rollbar SaaS, which is not where these
// errors belong, and a token aimed at the wrong host is rejected without a
// word. Both values are supplied per environment by Terraform, so until they
// are both there, reporting is simply off: a visible safe state instead of a
// silent wrong one, in whichever order the app and the infrastructure change.
const configured = Boolean(process.env.ROLLBAR_ACCESS_TOKEN) && Boolean(process.env.ROLLBAR_ENDPOINT)

if (!configured && environments.includes(process.env.ENVIRONMENT)) {
  console.warn('Error reporting is OFF: it needs both ROLLBAR_ACCESS_TOKEN and ROLLBAR_ENDPOINT.')
}

const rollbar = configured
  ? new Rollbar({
    // https://rollbar.com/docs/notifier/rollbar.js/#configuration-reference
    accessToken: process.env.ROLLBAR_ACCESS_TOKEN,
    endpoint: process.env.ROLLBAR_ENDPOINT,
    enabled: environments.includes(process.env.ENVIRONMENT),
    captureUncaught: true,
    captureUnhandledRejections: true,
    payload: {
      environment: process.env.ENVIRONMENT,
      // This is a server-side notifier, so `code_version` belongs at the top
      // level of the payload -- the `client.javascript` block is the browser
      // contract and means nothing here. Stack frames are resolved in-process
      // by Node (`NODE_OPTIONS=--enable-source-maps` plus the `.map` shipped
      // beside the bundle), so nothing needs to be uploaded for them to be
      // readable.
      //
      // DD_VERSION is the build identity baked into the image by the Dockerfile
      // (`--build-arg VERSION`), which is also what this app reports to Datadog
      // as `version` -- so an error and a deploy can be lined up by the same
      // string. It is the only build identity a bundled entrypoint can see: the
      // bundle carries no package.json and reads no config file at runtime.
      code_version: process.env.DD_VERSION
    }
  })
  : null

/** Report at `level`, or do nothing at all when reporting is not configured. */
const report = level => (...args) =>
  rollbar
    ? new Promise(resolve => rollbar[level](...args, resolve))
    : Promise.resolve()

export default {
  error: report('error'),
  warning: report('warning')
}
