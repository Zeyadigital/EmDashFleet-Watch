# EmDashFleet-Watch

Checks EmDash Fleet from outside Cloudflare. The scheduled workflows `watch.yml` (production) and `watch-staging.yml` (staging) request Fleet's public URLs, post to Slack when a check fails and check in with Fleet, so Fleet notices when the watch itself stops. Their run logs are public and hold nothing but the HTTP status of each URL checked.

## Branches

- `dev` is the integration branch. Changes are squash-merged into it after the other co-founder approves them.
- `main` runs the scheduled workflows, because GitHub runs scheduled workflows from the default branch only. Changes reach it only through a release pull request from `dev`, merged with a merge commit.

## Files

- `.github/workflows/watch.yml` checks production: `https://app.emdashfleet.com/healthz` with the Bearer token `WATCH_CHECKIN_TOKEN` (which is also the check-in Fleet reads) and `https://emdashfleet.com/`, as two steps. A check fails on a status other than 200 or on no answer within 10 seconds and is repeated once 5 minutes later; when both attempts fail the step posts to Slack through `SLACK_WATCH_WEBHOOK_URL` and the run fails. Repository secrets: `WATCH_CHECKIN_TOKEN` and `SLACK_WATCH_WEBHOOK_URL`.
- `scripts/watch-check.sh` is the one check script of the workflows. It needs `bash` and `curl` only and prints nothing but each URL's HTTP status.
- `scripts/keepalive.sh` is run by the monthly privileged-access review. GitHub disables scheduled workflows in a public repository after 60 days without activity, so the script pushes one empty commit, signed with the operator's own key, to `main` as a fast-forward, from a temporary clone. Run it as `bash scripts/keepalive.sh` (add `--dry-run` to push nothing and `--check-state` to read the state of `watch.yml` with `gh` afterwards). It is the one direct push to `main` the branch rules above allow, because the plan asks for it; a ruleset that blocks direct pushes must let the owner's push through.

## Tests

The tests need Node.js 26.13.0 or newer (`.nvmrc` of Fleet) and no package: `npm test` runs `node --test "test/*.test.mjs"`. They run the check script against a local HTTP server and a stub webhook, and parse the workflow files. They never reach a real address or a real webhook.
