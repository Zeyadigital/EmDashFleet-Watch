#!/usr/bin/env bash
# The check of one URL for watch.yml and watch-staging.yml (EmDash Fleet app
# plan, Operations, Alerts, the outside watch; alerts A20, A21 and A44;
# pre-mortem PM-AP-31; tracker APC-030 and APC-032). One script serves both
# workflows, so a rule changes in one place. It needs bash and curl only.
#
# Usage: bash scripts/watch-check.sh healthz|landing
#
# healthz   requests WATCH_URL with `Authorization: Bearer $WATCH_TOKEN`, which
#           is also the check-in that writes the cron_checkin row watch.yml;
#           failing posts A21, or A20 when both attempts answered 503 with the
#           body cron_stale;
# landing   requests WATCH_URL without a header; failing posts A44.
#
# Environment (the workflow step's env: and nothing else):
#   WATCH_URL          the address to request, https only
#   WATCH_TOKEN        the check-in token (healthz only)
#   WATCH_WEBHOOK      the Incoming Webhook URL of the Slack channel
#   WATCH_ENVIRONMENT  production or staging, named in the message (default production)
#
# Rules (app plan, Operations, Alerts):
# - A check fails on a status other than 200 or on no answer within 10 seconds;
#   a redirect is not followed, so it is a status other than 200.
# - A failed check is repeated once 5 minutes later in the same run (a sleep in
#   the job). A good answer on either attempt posts nothing and exits 0; no
#   recovery message exists.
# - When both attempts fail the script posts one message with <!channel> to the
#   webhook and exits 1, so the run fails and GitHub emails the co-founder who
#   last changed the schedule. Every later failing run posts again.
# - The repository is public, so the run log holds nothing but each URL's HTTP
#   status ("no answer" when none arrived) and the status of the webhook post.
#   curl's stderr is discarded because it can quote the URL. The token and the
#   webhook reach curl through stdin, never through an argument or the log.
# - A missing or malformed setting stops the run with exit 2 before any request,
#   so a misconfigured watch fails loudly instead of checking nothing.
#
# Test mode: WATCH_TEST_MODE=1 allows http addresses, any webhook address and
# the shorter WATCH_TEST_TIMEOUT and WATCH_TEST_RETRY_DELAY (seconds). Only
# test/ sets it; test/workflows.test.mjs fails if a workflow mentions it.
set -uo pipefail

readonly WEBHOOK_PREFIX="https://hooks.slack.com/services/"
readonly RUNBOOK_DEPLOY="Roll back a Fleet deploy"

kind="${1:-}"
case "$kind" in
  healthz) alert="A21"; severity="S1"; runbook="$RUNBOOK_DEPLOY"; signal="the /healthz check of the Fleet dashboard" ;;
  landing) alert="A44"; severity="S2"; runbook="$RUNBOOK_DEPLOY"; signal="the check of the landing page" ;;
  *) echo "usage: watch-check.sh healthz|landing"; exit 2 ;;
esac

url="${WATCH_URL:-}"
token="${WATCH_TOKEN:-}"
webhook="${WATCH_WEBHOOK:-}"
environment="${WATCH_ENVIRONMENT:-production}"

timeout=10
retry_delay=300
proto="=https"
url_prefix="https://"
if [ "${WATCH_TEST_MODE:-}" = "1" ]; then
  timeout="${WATCH_TEST_TIMEOUT:-$timeout}"
  retry_delay="${WATCH_TEST_RETRY_DELAY:-$retry_delay}"
  proto="=http,https"
  url_prefix="http"
  webhook_prefix="http"
else
  webhook_prefix="$WEBHOOK_PREFIX"
fi

fail_config() {
  echo "$1"
  exit 2
}

[ -n "$url" ] || fail_config "The address to check is not set."
case "$url" in "$url_prefix"*) ;; *) fail_config "The address to check is not an https address." ;; esac
case "$url" in *[[:space:]\"\\]*) fail_config "The address to check holds a character that is not allowed." ;; esac
[ -n "$webhook" ] || fail_config "The alert webhook is not set."
case "$webhook" in "$webhook_prefix"*) ;; *) fail_config "The alert webhook is not a Slack Incoming Webhook address." ;; esac
case "$webhook" in *[[:space:]\"\\]*) fail_config "The alert webhook holds a character that is not allowed." ;; esac
case "$environment" in production|staging) ;; *) fail_config "WATCH_ENVIRONMENT is neither production nor staging." ;; esac
if [ "$kind" = "healthz" ]; then
  [ -n "$token" ] || fail_config "The check-in token is not set."
  case "$token" in *[[:space:]]*) fail_config "The check-in token holds whitespace." ;; esac
fi

work="$(mktemp -d)" || fail_config "No temporary directory."
trap 'rm -rf "$work"' EXIT

code=000
stale=0

# Requests the address once; sets `code` (000 when no answer arrived) and
# `stale` (1 for a 503 whose body is exactly cron_stale).
attempt() {
  local n="$1"
  rm -f "$work/body"
  local common=(--silent --max-time "$timeout" --max-redirs 0 --proto "$proto" --output "$work/body" --write-out '%{http_code}')
  if [ -n "$token" ]; then
    code="$(printf 'Authorization: Bearer %s\n' "$token" | curl "${common[@]}" --header @- "$url" 2>/dev/null)"
  else
    code="$(curl "${common[@]}" "$url" 2>/dev/null)"
  fi
  case "$code" in [0-9][0-9][0-9]) ;; *) code=000 ;; esac
  stale=0
  if [ "$code" = "503" ] && [ "$kind" = "healthz" ] && [ "$(head -c 64 "$work/body" 2>/dev/null | tr -d '\r\n')" = "cron_stale" ]; then
    stale=1
  fi
  if [ "$code" = "000" ]; then echo "$kind attempt $n: no answer"; else echo "$kind attempt $n: HTTP $code"; fi
}

describe() {
  if [ "$1" = "000" ]; then echo "no answer"; else echo "HTTP $1"; fi
}

attempt 1
if [ "$code" = "200" ]; then exit 0; fi
first_code="$code"
first_stale="$stale"

sleep "$retry_delay"

attempt 2
if [ "$code" = "200" ]; then exit 0; fi

if [ "$first_stale" = "1" ] && [ "$stale" = "1" ]; then
  alert="A20"; severity="S2"; runbook="Cron Trigger not firing"
  signal="the Cron check-in of the Fleet dashboard (503 cron_stale)"
fi

# The run address is built from the runner's own variables and cleaned to the
# characters of an address, so the message holds fixed text and numbers only.
run_url="${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"
run_url="$(printf '%s' "$run_url" | tr -cd 'A-Za-z0-9:/._-')"
text="<!channel> $alert ($severity): $signal failed twice, 5 minutes apart ($(describe "$first_code"), then $(describe "$code")). Environment: $environment. Runbook: $runbook. Run: $run_url"
printf '{"text":"%s"}' "$text" >"$work/payload"

status="$(printf 'url = "%s"\n' "$webhook" | curl --config - --silent --max-time 10 --max-redirs 0 --proto "$proto" --request POST --header 'Content-Type: application/json' --data @"$work/payload" --output /dev/null --write-out '%{http_code}' 2>/dev/null)"
case "$status" in [0-9][0-9][0-9]) ;; *) status=000 ;; esac
if [ "$status" = "000" ]; then echo "alert post: no answer"; else echo "alert post: HTTP $status"; fi
exit 1
