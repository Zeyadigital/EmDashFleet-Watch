# EmDashFleet-Watch

Checks EmDash Fleet from outside Cloudflare. The scheduled workflows `watch.yml` (production) and `watch-staging.yml` (staging) request Fleet's public URLs, post to Slack when a check fails and check in with Fleet, so Fleet notices when the watch itself stops. Their run logs are public and hold nothing but the HTTP status of each URL checked.

## Branches

- A co-founder pushes alone (emdashfleet_app_plan.md D31, HR-162): there is no pull request, review, approver, signed commit or local hook.
- `dev` is the integration branch: push to it while working.
- `main` runs the scheduled workflows, because GitHub runs scheduled workflows from the default branch only: push to it when a change is ready. `scripts/keepalive.sh` adds an empty commit to `main` only, so merge `main` into `dev` before the next push of `dev` to `main`.

## Files

- `.github/workflows/watch.yml` checks production: `https://app.emdashfleet.com/healthz` with the Bearer token `WATCH_CHECKIN_TOKEN` (which is also the check-in Fleet reads) and `https://emdashfleet.com/`, as two steps. A check fails on a status other than 200 or on no answer within 10 seconds and is repeated once 5 minutes later; when both attempts fail the step posts to Slack through `SLACK_WATCH_WEBHOOK_URL` and the run fails. Repository secrets: `WATCH_CHECKIN_TOKEN` and `SLACK_WATCH_WEBHOOK_URL`.
- `.github/workflows/watch-staging.yml` is the same watch for staging: `https://staging.emdashfleet.com/healthz` with `WATCH_CHECKIN_TOKEN_STAGING` (which writes the staging `cron_checkin` row `watch.yml`) and the address in the repository variable `STAGING_SITE_URL`, alerts through `SLACK_WATCH_WEBHOOK_URL_STAGING` to `#fleet-alerts-staging` only. Repository secrets: `WATCH_CHECKIN_TOKEN_STAGING` and `SLACK_WATCH_WEBHOOK_URL_STAGING`; variable: `STAGING_SITE_URL`.
- `.github/workflows/ci.yml` checks every push to `dev` and `main` and every pull request into them (Dependabot's) with a read-only token and no secret: gitleaks 8.30.1 over the commits of the push or pull request (the archive is checked against its SHA-256) and `npm test`. `.github/dependabot.yml` opens the weekly pull requests into `dev` for the GitHub Actions, the only ecosystem in use (`package.json` holds no dependency), and a co-founder merges them. `.nvmrc` holds the exact Node.js version and `.gitleaks.toml` configures gitleaks, which runs in `ci.yml` only: nothing is installed or configured in a clone.
- `scripts/watch-check.sh` is the one check script of the workflows. It needs `bash` and `curl` only and prints nothing but each URL's HTTP status.
- `scripts/keepalive.sh` is run by the monthly privileged-access review. GitHub disables scheduled workflows in a public repository after 60 days without activity, so the script pushes one empty commit, made with the operator's own git identity, to `main` as a fast-forward, from a temporary clone. Run it as `bash scripts/keepalive.sh` (add `--dry-run` to push nothing and `--check-state` to read the state of `watch.yml` with `gh` afterwards). It is a push to `main` like any other.

## Tests

The tests need Node.js 26.13.0 or newer (`.nvmrc`) and no package: `npm test` runs `node --test "test/*.test.mjs"`. They run the check script against a local HTTP server and a stub webhook, parse the workflow files and check the hygiene files (`test/hygiene.test.mjs`). They never reach a real address or a real webhook.
