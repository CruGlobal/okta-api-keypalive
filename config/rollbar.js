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

// The notifier's transport has no working timeout of its own: it never listens
// for the socket's `timeout` event and never destroys a stalled request, so
// neither a per-item callback nor `wait()` is guaranteed to ever fire. A POST
// that stalled once held this function open until the Lambda timeout killed it,
// with the report never arriving -- so the flush is bounded here instead.
// Losing a report is bad; losing the keepalive run is worse.
//
// The budget covers the WHOLE attempt, enqueue included, and the deadline is
// taken before the notifier is handed anything: a report that spends its budget
// building the item does not then get a fresh timeout to wait in. The one thing
// this cannot bound is the sandbox running out of CPU -- a timer that is never
// scheduled cannot fire on time -- which is what the log line below exists to
// tell apart.
//
// 8s, from measurement rather than taste: in this app's base image, held to a
// CPU share comparable to the deployed function, a report that was delivered
// took 3.2s of which almost all was the first HTTPS connection (building the
// TLS context and handshaking, once per execution environment). A 5s budget
// left so little margin that it would have started dropping reports that were
// about to succeed. 8s still leaves a stalled attempt far inside the function
// timeout, with the whole run finishing normally afterwards.
const FLUSH_TIMEOUT_MS = 8000

/**
 * Report at `level` and wait for the notifier's queue to drain, for at most
 * FLUSH_TIMEOUT_MS.
 *
 * `wait()` rather than a per-item callback, for two reasons. `Notifier.log`
 * enqueues the item synchronously before any transform runs, so a `wait()`
 * issued straight after the call always sees it -- there is no race. And the
 * drain also covers the items `captureUncaught` / `captureUnhandledRejections`
 * queue with no callback of their own, which would otherwise be stranded when
 * the execution environment freezes after the handler returns. When reporting
 * is disabled the notifier short-circuits before enqueuing anything, so the
 * queue is already empty and this resolves immediately.
 *
 * Always resolves, never rejects and never hangs: the handler awaits this, so a
 * reporting problem must not become a failed invocation.
 */
const report = level => async (...args) => {
  if (!rollbar) return

  const startedAt = Date.now()
  const deadline = startedAt + FLUSH_TIMEOUT_MS

  try {
    rollbar[level](...args)
  } catch (error) {
    console.error(`Error reporting could not enqueue a ${level}: ${error.message}`)
    return
  }

  const enqueuedAt = Date.now()
  const budget = Math.max(deadline - enqueuedAt, 0)

  if (budget > 0) await flush(budget)

  // One line per report, permanently, because this cost is not otherwise
  // visible and it has already burned one invocation. Read it like this:
  //
  //   enqueue large             -> synchronous work inside the notifier
  //                                (building the item, parsing the stack,
  //                                reading the frames' files)
  //   flush ~= budget           -> the transport stalled; we gave up on time
  //   flush >> budget           -> our own timer fired late, so the event loop
  //                                was blocked or the sandbox was starved of
  //                                CPU, and the delay is not in this code
  console.log(`Error reporting ${level}: enqueue ${enqueuedAt - startedAt}ms, flush ${Date.now() - enqueuedAt}ms of ${budget}ms budget`)
}

/** Wait for the notifier's queue to drain, for at most `budget` ms. */
const flush = budget =>
  new Promise(resolve => {
    // Giving up leaves the stalled request in the notifier's queue, which has
    // two consequences worth knowing. Its 500ms drain poll keeps running (only
    // a drained queue clears it) -- one stray interval, replaced by the next
    // report rather than accumulating, holding nothing open. And a later report
    // from the same execution environment will hit this bound too, because the
    // queue it waits on can no longer empty: the item still gets sent, we just
    // stop waiting for confirmation. Hence the wording below -- "not confirmed"
    // is the honest description, not "not sent".
    const timer = setTimeout(() => {
      console.warn(`Error reporting did not confirm within ${budget}ms; continuing rather than holding the invocation open (the report may not have been delivered).`)
      resolve()
    }, budget)

    rollbar.wait(() => {
      clearTimeout(timer)
      resolve()
    })
  })

export default {
  error: report('error'),
  warning: report('warning')
}
