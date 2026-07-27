# Working in this repo (for coding agents)

This repository is **`okta-api-keypalive`** — a small **AWS Lambda** function
that keeps Okta API tokens from expiring. It is invoked on a schedule (there is
no HTTP surface and no port): for each SSM Parameter Store path listed in
`API_KEY_PATHS`, it fetches the token, makes one trivial Okta call
(`listUsers`, limit 1) with it, and moves on. Per-token errors are logged and
skipped; a failure of the whole run is reported to Rollbar and rethrown so the
invocation fails visibly.

The function is packaged as a **container image** (not a zip): the final stage is
`public.ecr.aws/lambda/nodejs`, wrapped by Cru's
**secrets-lambda-extension** (`AWS_LAMBDA_EXEC_WRAPPER`, which injects secrets as
environment variables at runtime) and the **DataDog lambda-extension**. Leave
that wiring in place when you edit the `Dockerfile`.

> The pipeline-v2 design doc spells the project `okta-api-keepalive` in one
> place. The real project and ECR repo name is **`okta-api-keypalive`** — the
> spelling in this repo.

## Layout & language

```
.
├── AGENTS.md / CLAUDE.md
├── Dockerfile          # builder → secrets-lambda-extension → lambda/nodejs runtime
├── build.sh            # what CI runs to build the image (docker buildx)
├── .tool-versions      # pinned Node version (asdf / mise)
├── .github/workflows/pipeline-v2.yml          # nightly build + release-candidate deploy
├── .github/workflows/build-deploy-lambda.yml  # parked v1 workflow
├── handlers/keypalive.js  # the handler (the whole app)
└── config/rollbar.js      # Rollbar client (enabled by ENVIRONMENT)
```

Plain **JavaScript** (ESM source, bundled to CJS), Node version pinned in
`.tool-versions`, AWS SDK v3 (`@aws-sdk/client-ssm`) and
`@okta/okta-sdk-nodejs`.

## The loop

| Command | What it does |
| --- | --- |
| `npm ci` | install dependencies |
| `npm run lint` | `standard --verbose` — the only automated check that exists |
| `npm run build` | esbuild bundle → `dist/keypalive.js` (what the Dockerfile runs) |
| `./build.sh` | build the Lambda container image the way CI does |

**There is no test suite and no CI workflow in this repo**, and the
default-branch ruleset requires a pull request and linear history but **no**
status checks — so `npm run lint` and `npm run build` before opening a PR are on
you. If you add meaningful logic, add tests and a CI workflow with it.

To exercise the built image locally, run it under the AWS Lambda Runtime
Interface Emulator. If you build an image you intend to actually deploy, note
that Lambda **cannot** run an image whose top-level manifest is an OCI index —
CI passes `--provenance=false` to buildx for exactly this reason (buildx emits a
manifest list by default and `UpdateFunctionCode` rejects it).

## Configuration

Read at invocation time from `process.env`; everything secret is delivered by the
secrets-lambda-extension, and the non-secret values are function environment
variables owned by Terraform:

| Variable | Meaning |
| --- | --- |
| `API_KEY_PATHS` | comma-separated SSM parameter paths holding the Okta tokens (required) |
| `OKTA_ORG_URL` | the Okta org to call (required) |
| `DRY_RUN` | `"true"` ⇒ log what would happen and make **no** Okta calls |
| `ENVIRONMENT` | enables Rollbar (`staging` / `production` / `lab`) and tags its payloads |
| `ROLLBAR_ACCESS_TOKEN` | Rollbar token |

**`.env` in this repo is a tracked, empty template** (`.gitignore` deliberately
un-ignores it with `!.env` while ignoring `.env.*`). Keep the values blank —
never commit real tokens, paths, or ARNs to it.

## How this app ships

This repo is on **pipeline v2: build once, then promote the artifact**. One
environment-agnostic image is built from `main`, deployed to
**release-candidate** (the stage surface), and — if it is good — promoted
byte-for-byte (by digest) to **production**. The authoritative reference is
[`docs/pipeline-v2.md`](https://github.com/CruGlobal/.github/blob/pipeline-v2/docs/pipeline-v2.md)
in `CruGlobal/.github`.

There is **no `staging` branch, no `On Staging` label, and no merge-bot** in this
flow, and the old `lab-dev1` branch mapping is gone too. If you find those
referenced anywhere, the reference is stale.

1. **Work on a branch** off `main` and open a **Pull Request** back to `main`.
   The repo is **squash-only with auto-merge enabled**, and the PR title becomes
   the squash commit subject — so write it as a **Conventional Commit**
   (`feat: …`, `fix: …`). (Fleet convention; unlike some Cru repos, this one has
   no "Validate PR Title" check wired up yet, so nothing enforces it
   mechanically.)
2. **Builds do not run on push.** `.github/workflows/pipeline-v2.yml` runs on a
   **nightly cron at midnight UTC** (`cron: '0 0 * * *'` — one unstaggered slot
   shared by the whole v2 fleet) and on manual **`workflow_dispatch`**. Merging
   to `main` does not deploy anything by itself. GitHub's scheduled dispatch is
   best-effort and top-of-hour crons queue: a nightly that starts several
   minutes late is expected, not a failure.
3. **A build produces a candidate.** It pushes `candidate-<yyyy-mm-dd>-<n>` and
   `sha-<gitsha>` to the app's ECR repo
   (`056154071827.dkr.ecr.us-east-1.amazonaws.com/okta-api-keypalive`), then
   dispatches a deploy of that candidate to **release-candidate**. A night with
   no new commits is a true end-to-end no-op: the build reuses the already-built
   sha, and the deploy skips a digest release-candidate is already running.
4. **Release-candidate is a dry-run surface — that is this app's whole test
   strategy.** The release-candidate function runs the candidate image on its
   normal cron with **`DRY_RUN=true`**, so the code path is exercised against
   real SSM parameters without touching any Okta tenant. `DRY_RUN` is a per-env
   **function environment variable owned by Terraform** (`aws/lambda/app`), not
   something baked into the image — the identical digest runs in both
   environments. Never read it at module load, never bake it in, and check the
   release-candidate logs before promoting.
5. **Promotion and rollback live in
   [`cru-deploy`](https://github.com/CruGlobal/cru-deploy)**, not here — the
   **Promote (v2)** and **Rollback (v2)** `workflow_dispatch` Actions. Promote
   ships the exact digest already running on release-candidate to the
   **production** function(s), where it runs for real, and stamps it
   `release-<yyyy-mm-dd>-<n>`; it first checks that the person dispatching it has
   **push permission on this repo**. `release-*` tags are permanent, so any past
   release stays rollback-able. **Deploy Candidate (v2)** (`force: true`) is the
   force-redeploy escape hatch.
6. **Slack.** Every deploy, promote, and rollback — and every failure, as an
   `:x:` message — posts to the channel in this app's `CruApplicationInfo` row
   (`SlackChannel`), with a `deploys.cru.org/changelog` link for what changed.
   Deploys run in cru-deploy's Actions tab, so Slack (or that tab) is where you
   see results; a red cru-deploy run does not turn this repo red.
7. **The image is environment-agnostic — never bake environment-specific values
   into it.** A v2 build passes no `PROJECT_NAME`/`ENVIRONMENT` build args (v1
   did); those arrive as function environment variables at runtime. The one
   build-identity exception is the pair at the *end* of the `Dockerfile`:

   ```dockerfile
   ARG VERSION="dev"
   ENV DD_VERSION=${VERSION}
   ```

   The build passes `--build-arg VERSION=<yyyy-mm-dd>-<n>`, so Datadog's
   `version` is the build's identity in every environment. (Function-config env
   overlays image ENV per name, and nothing sets `DD_VERSION` there, so the baked
   value shines through.) Keep those two lines last.
8. **A deploy updates every matching function.** It calls
   `UpdateFunctionCode` on each `okta-api-keypalive-<prod|stage>*` **image**
   function whose current image is in this app's ECR repo (or still on the
   `scratch` placeholder, which is how a brand-new function gets its first real
   image), and waits for each update to finish before returning. Production may
   run several functions — one per tenant — and they all move to the same digest.
9. **The v1 workflow is parked, not removed.**
   `.github/workflows/build-deploy-lambda.yml` still exists but its push
   triggers are gone — it is `workflow_dispatch`-only, an escape hatch back to
   the v1 build+deploy path. Don't use it for normal work, and don't add push
   triggers to it.

Watch a run with `gh run watch`, or the Actions tab here (build) and in
`cru-deploy` (deploy/promote/rollback).

> Pilot note: `pipeline-v2.yml` pins the reusable workflow and actions to the
> `@pipeline-v2` branch of `CruGlobal/.github` and passes
> `workflow-ref: pipeline-v2` so both match. Those references get re-pinned to
> `@v2` when the pipeline is released — change them together or not at all.

## Infrastructure & secrets

- **Provisioning** (the Lambda function(s), IAM role, the schedule, the SSM
  parameters, the deploy permissions) lives in
  [`cru-terraform`](https://github.com/CruGlobal/cru-terraform) via the
  `aws/lambda/app` module, generated by **TerraBloks** (available as the
  `terrabloks` MCP server: `list_templates` → `get_template` → `preview_pr` →
  `create_pr`). Don't hand-write cloud infrastructure — that includes `DRY_RUN`
  and any new environment variable.
- **Runtime metadata the pipeline reads** (provider, type, Slack channel) is the
  app's `CruApplicationInfo` row, written by that module. Read it at
  `https://deploys.cru.org/info?project=okta-api-keypalive&environment=production`.
- **Secrets** are injected at runtime by the secrets-lambda-extension — never
  commit them. Use `cru application impersonate -e staging -- <command>` to run
  against a real environment's values.
- **BUILD-time secrets** (if ever needed) are Actions secrets on this repo named
  `BUILD_<NAME>`; the build exports only `BUILD_*` into the build environment
  with the prefix stripped.
- **The `secrets-lambda-extension` version is deliberately unpinned** in the
  `Dockerfile` (it resolves `latest`, records it, then fetches that exact
  version). Under build-once the artifact itself is the pin, and a bad extension
  release is caught on the dry-run release-candidate surface. Don't "fix" this by
  hardcoding a version.

## Leftovers you can ignore

- `.github/merge-bot.yml` — v1 merge-bot config. The v2 flow has no `staging`
  branch for it to act on.
- Stale `staging` and `lab-dev1` branches still exist on the remote; the lab
  environment was collapsed into prod. `main` is the only live branch.

## If you're not sure what to do

- **Keep changes small and on a branch.** Open a PR; don't push to `main`.
- **Respect `DRY_RUN`.** Any new side effect must be behind the same guard, or
  the release-candidate surface stops being a safe rehearsal.
- **Keep per-token failures non-fatal.** One bad parameter should not stop the
  remaining tokens from being kept alive — that is why the inner `try/catch`
  exists.
- **Don't invent infrastructure.** New AWS resources, SSM parameters, or
  environment variables are a TerraBloks / `cru-terraform` change.
- **Never paste secrets** into files (including `.env`). Use env vars and the Cru
  CLI for real values.
- **Confirm before anything outward-facing or hard to undo** — pushing, opening
  PRs, dispatching a promote or rollback, deleting things.
