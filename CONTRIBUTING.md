# Contributing

This repository is the outside watch of EmDash Fleet. It is public, so nothing in it, in an issue or in a pull request may name a secret value, a token or customer personal data; name the variable instead.

## One-time setup

1. Install gitleaks 8.30.1 from https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1 (the version `ci.yml` runs) and check the archive against `gitleaks_8.30.1_checksums.txt` of the same release.
2. Enable the hook: `git config core.hooksPath .githooks`. The pre-commit hook scans the staged changes with gitleaks.
3. Sign every commit. With an SSH key already added to GitHub as a signing key:

   ```sh
   git config gpg.format ssh
   git config user.signingkey ~/.ssh/id_ed25519.pub
   git config commit.gpgsign true
   ```

   GitHub shows a signed commit as Verified, and "will automatically use GPG to sign commits you make using the web interface", the merge button included (https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification and https://docs.github.com/en/authentication/managing-commit-signature-verification/telling-git-about-your-signing-key).

## Changes

- Branch from `dev`, open a pull request into `dev`; `ci.yml` runs gitleaks and `npm test` with a read-only token and no secret.
- The other co-founder approves the pull request; it is then squash-merged with the GitHub merge button. Nobody pushes to `dev` or `main` directly, merges their own unapproved pull request, rebases `dev` or `main`, or force-pushes them. The one exception is `scripts/keepalive.sh` (README).
- A release is a pull request from `dev` into `main`, approved by the other co-founder and merged with a merge commit.
- `.nvmrc` holds one exact Node.js version and an action is pinned by its full commit SHA; `package.json` holds no dependency. Dependabot opens the weekly pull requests into `dev` for the GitHub Actions.
