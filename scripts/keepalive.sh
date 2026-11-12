#!/usr/bin/env bash
# Pushes a signed keepalive commit to EmDashFleet-Watch (EmDash Fleet app
# plan, Operations, Alerts: "GitHub disables scheduled workflows in a public
# repository after 60 days without repository activity ... so the monthly
# privileged-access review pushes a keepalive commit to
# Zeyadigital/EmDashFleet-Watch"; internal documentation plan, Runbooks,
# Monthly privileged-access review and Re-enable the outside watch; tracker
# APC-031). The co-founder who runs the review runs this script on day 1 of
# each month from a terminal signed in to GitHub with their own login.
#
# Usage: bash scripts/keepalive.sh [--remote <url or path>] [--branch <name>]
#                                  [--dry-run] [--check-state]
#
# --remote       the repository to push to (default
#                https://github.com/Zeyadigital/EmDashFleet-Watch.git); the
#                tests pass a local bare repository;
# --branch       the branch to commit to (default main, the branch the
#                scheduled workflows run from);
# --dry-run      creates and checks the commit in the temporary clone and
#                pushes nothing;
# --check-state  after the push, reads the state of watch.yml with
#                `gh api repos/Zeyadigital/EmDashFleet-Watch/actions/workflows/watch.yml`
#                and fails unless it is active.
#
# What it does: clones the branch into a temporary directory (the operator's
# own checkout is never touched), makes one empty commit signed with the
# operator's own signing key (git commit -S, so a GPG, SSH or S/MIME setup
# works), refuses to continue when the commit carries no signature, and pushes
# it as a fast-forward: never a force push. The commit changes no file, so it
# cannot alter a workflow. The script creates no token and reads no secret.
#
# Branch model: README.md says main changes only through a release pull request
# from dev, but the plan's keepalive is a push, and the tracker's acceptance
# names a signed commit on main. The script follows the plan, so a ruleset or
# protection on main that blocks direct pushes makes the push fail with a hint;
# the repository's rule set must then let the owner's push through. After a
# push to main, dev lacks the empty commit; the next release pull request is
# merged with a merge commit and loses nothing.
set -uo pipefail

remote="https://github.com/Zeyadigital/EmDashFleet-Watch.git"
branch="main"
dry_run=0
check_state=0

die() {
  echo "$1"
  exit "${2:-1}"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --remote) [ "$#" -ge 2 ] || die "--remote needs a value." 2; remote="$2"; shift 2 ;;
    --branch) [ "$#" -ge 2 ] || die "--branch needs a value." 2; branch="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --check-state) check_state=1; shift ;;
    *) die "usage: keepalive.sh [--remote <url or path>] [--branch <name>] [--dry-run] [--check-state]" 2 ;;
  esac
done

[ -n "$remote" ] || die "The remote is empty." 2
case "$branch" in
  ''|-*|*[!A-Za-z0-9._/-]*|*..*) die "The branch name is not allowed." 2 ;;
esac

work="$(mktemp -d)" || die "No temporary directory."
trap 'rm -rf "$work"' EXIT
repo="$work/repo"

git clone --quiet --branch "$branch" --single-branch -- "$remote" "$repo" >/dev/null 2>&1 || die "The branch $branch could not be cloned from the remote."

message="Keepalive $(date -u +%Y-%m-%d)

Empty commit that keeps the scheduled workflows enabled: GitHub disables them
after 60 days without repository activity."

git -C "$repo" commit --quiet --allow-empty -S -m "$message" >/dev/null 2>&1 || die "The commit could not be created or signed. Set up commit signing (user.signingkey, and gpg.format for an SSH key) and run again."

# git commit -S fails when signing fails; the header check keeps an unsigned
# commit from ever being pushed, whatever the configuration says.
git -C "$repo" cat-file commit HEAD | grep -q '^gpgsig' || die "The commit carries no signature, so it was not pushed."

sha="$(git -C "$repo" rev-parse --short=12 HEAD)"

if [ "$dry_run" = "1" ]; then
  echo "Dry run: created the signed commit $sha on $branch; nothing was pushed."
  exit 0
fi

git -C "$repo" push --quiet origin "HEAD:refs/heads/$branch" >/dev/null 2>&1 || die "The push to $branch was refused (a protected branch, a ruleset or no permission). Nothing was changed."
echo "Pushed the signed keepalive commit $sha to $branch."

if [ "$check_state" = "1" ]; then
  state="$(gh api repos/Zeyadigital/EmDashFleet-Watch/actions/workflows/watch.yml --jq .state 2>/dev/null)" || die "The state of watch.yml could not be read with gh."
  echo "watch.yml state: $state"
  [ "$state" = "active" ] || die "watch.yml is not active. Run the runbook Re-enable the outside watch."
fi
