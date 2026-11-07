# EmDashFleet-Watch

Checks EmDash Fleet from outside Cloudflare. The scheduled workflows `watch.yml` (production) and `watch-staging.yml` (staging) request Fleet's public URLs, post to Slack when a check fails and check in with Fleet, so Fleet notices when the watch itself stops. Their run logs are public and hold nothing but the HTTP status of each URL checked.

## Branches

- `dev` is the integration branch. Changes are squash-merged into it after the other co-founder approves them.
- `main` runs the scheduled workflows, because GitHub runs scheduled workflows from the default branch only. Changes reach it only through a release pull request from `dev`, merged with a merge commit.
