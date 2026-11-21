# Contributing

This repository is the outside watch of EmDash Fleet. It is public, so nothing in it, in an issue or in a pull request may name a secret value, a token or customer personal data; name the variable instead.

## Changes

- A co-founder pushes to `dev` while working and to `main` when the change is ready (emdashfleet_app_plan.md D31, HR-162). There is no pull request, review, approver, signed commit or local hook to set up. Dependabot opens the weekly pull requests into `dev` for the GitHub Actions and a co-founder merges them.
- `ci.yml` runs on every push to `dev` and `main` and on Dependabot's pull requests: gitleaks 8.30.1 over the commits of the push and `npm test`, with a read-only token and no secret. Do not rebase or force-push `dev` or `main`: the check reads the commits since the previous push. For the same reason a commit message never holds a skip instruction (`[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]` or a `skip-checks: true` trailer): GitHub then starts no run for the push, and its commits are in no later scan. gitleaks also skips the paths its default configuration exempts (images, fonts, documents, binaries, lockfiles, `node_modules/`, `vendor/`); `test/hygiene.test.mjs` fails when such a file is added. `scripts/keepalive.sh` (README) adds an empty commit to `main` by default.
- `.nvmrc` holds one exact Node.js version and an action is pinned by its full commit SHA; `package.json` holds no dependency.
