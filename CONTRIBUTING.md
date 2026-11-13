# Contributing

This repository is the outside watch of EmDash Fleet. It is public, so nothing in it, in an issue or in a pull request may name a secret value, a token or customer personal data; name the variable instead.

## Changes

- A co-founder pushes to `dev` while working and to `main` when the change is ready (emdashfleet_app_plan.md D31, HR-162). There is no pull request, review, approver, signed commit or local hook to set up. Dependabot opens the weekly pull requests into `dev` for the GitHub Actions and a co-founder merges them.
- `ci.yml` runs on every push to `dev` and `main` and on Dependabot's pull requests: gitleaks 8.30.1 over the commits of the push and `npm test`, with a read-only token and no secret. Do not rebase or force-push `dev` or `main`: the check reads the commits since the previous push. `scripts/keepalive.sh` (README) adds an empty commit to `main` only.
- `.nvmrc` holds one exact Node.js version and an action is pinned by its full commit SHA; `package.json` holds no dependency.
