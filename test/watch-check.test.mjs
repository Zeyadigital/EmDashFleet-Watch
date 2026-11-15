// Tests of scripts/watch-check.sh against a local HTTP server and a stub
// Incoming Webhook (tracker APC-030, APC-032). Run with `npm test`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, test } from "node:test";
import { CHECK_SCRIPT, HOOK_SECRET, TOKEN, postedText, runCheck, startHook, startTarget, testEnv } from "./helpers.mjs";

const open = [];
async function setup(responses, hookStatus = 200) {
  const target = await startTarget(responses);
  const hook = await startHook(hookStatus);
  open.push(target, hook);
  return { target, hook };
}
afterEach(async () => {
  while (open.length > 0) await open.pop().close();
});

describe("a healthy run", () => {
  test("posts nothing, exits 0 and sends the Bearer token on /healthz", async () => {
    const { target, hook } = await setup([{ status: 200, body: "ok" }]);
    const { code, output } = await runCheck("healthz", testEnv(target, hook));
    assert.equal(code, 0);
    assert.equal(hook.posts.length, 0);
    assert.equal(target.requests.length, 1);
    assert.equal(target.requests[0].authorization, `Bearer ${TOKEN}`);
    assert.equal(output.trim(), "healthz attempt 1: HTTP 200");
  });

  test("the landing page check sends no Authorization header", async () => {
    const { target, hook } = await setup([{ status: 200 }]);
    const { code } = await runCheck("landing", testEnv(target, hook, { WATCH_TOKEN: "" }));
    assert.equal(code, 0);
    assert.equal(target.requests[0].authorization, null);
  });

  test("a second attempt that answers 200 posts nothing and exits 0", async () => {
    const { target, hook } = await setup([{ status: 500 }, { status: 200 }]);
    const { code, output } = await runCheck("healthz", testEnv(target, hook));
    assert.equal(code, 0);
    assert.equal(target.requests.length, 2);
    assert.equal(hook.posts.length, 0);
    assert.equal(output.trim(), "healthz attempt 1: HTTP 500\nhealthz attempt 2: HTTP 200");
  });

  test("a cron_stale answer followed by 200 posts nothing", async () => {
    const { target, hook } = await setup([{ status: 503, body: "cron_stale" }, { status: 200 }]);
    const { code } = await runCheck("healthz", testEnv(target, hook));
    assert.equal(code, 0);
    assert.equal(hook.posts.length, 0);
  });
});

describe("two failed attempts", () => {
  test("healthz posts A21 with <!channel> once and exits non-zero", async () => {
    const { target, hook } = await setup([{ status: 500 }, { status: 502 }]);
    const { code, output } = await runCheck("healthz", testEnv(target, hook));
    assert.equal(code, 1);
    assert.equal(target.requests.length, 2);
    assert.equal(hook.posts.length, 1);
    assert.equal(hook.posts[0].method, "POST");
    assert.equal(hook.posts[0].contentType, "application/json");
    const text = postedText(hook.posts[0]);
    assert.match(text, /^<!channel> A21 \(S1\): /);
    assert.match(text, /\(HTTP 500, then HTTP 502\)/);
    assert.match(text, /Environment: production\./);
    assert.match(text, /Runbook: Roll back a Fleet deploy\./);
    assert.match(text, /Run: https:\/\/github\.com\/Zeyadigital\/EmDashFleet-Watch\/actions\/runs\/123456789$/);
    assert.match(output, /alert post: HTTP 200/);
  });

  test("the landing page posts A44 once", async () => {
    const { target, hook } = await setup([{ status: 404 }, { status: 404 }]);
    const { code } = await runCheck("landing", testEnv(target, hook, { WATCH_TOKEN: "" }));
    assert.equal(code, 1);
    assert.equal(hook.posts.length, 1);
    assert.match(postedText(hook.posts[0]), /^<!channel> A44 \(S2\): /);
    assert.equal(target.requests[0].authorization, null);
  });

  test("503 cron_stale twice posts A20 with <!channel> instead of A21", async () => {
    const { target, hook } = await setup([{ status: 503, body: "cron_stale" }]);
    const { code, output } = await runCheck("healthz", testEnv(target, hook));
    assert.equal(code, 1);
    assert.equal(hook.posts.length, 1);
    const text = postedText(hook.posts[0]);
    assert.match(text, /^<!channel> A20 \(S2\): /);
    assert.match(text, /Runbook: Cron Trigger not firing\./);
    assert.doesNotMatch(text, /A21/);
    assert.doesNotMatch(output, /cron_stale/);
  });

  test("cron_stale once and another 503 posts A21", async () => {
    const { target, hook } = await setup([{ status: 503, body: "cron_stale" }, { status: 503, body: "maintenance" }]);
    const { code } = await runCheck("healthz", testEnv(target, hook));
    assert.equal(code, 1);
    assert.match(postedText(hook.posts[0]), /^<!channel> A21 /);
  });

  test("a 503 cron_stale body on the landing page is A44, not A20", async () => {
    const { target, hook } = await setup([{ status: 503, body: "cron_stale" }]);
    const { code } = await runCheck("landing", testEnv(target, hook, { WATCH_TOKEN: "" }));
    assert.equal(code, 1);
    assert.match(postedText(hook.posts[0]), /^<!channel> A44 /);
  });

  test("no answer within the timeout counts as a failed check", async () => {
    const { target, hook } = await setup([{ status: 200, delayMs: 3000 }]);
    const started = Date.now();
    const { code, output } = await runCheck("healthz", testEnv(target, hook));
    assert.equal(code, 1);
    assert.ok(Date.now() - started < 3000, "the script waited for the slow answer");
    assert.equal(target.requests.length, 2);
    assert.match(output, /healthz attempt 1: no answer\nhealthz attempt 2: no answer/);
    assert.match(postedText(hook.posts[0]), /\(no answer, then no answer\)/);
  });

  test("a refused connection counts as a failed check", async () => {
    const { target, hook } = await setup([{ status: 200 }]);
    const unreachable = { ...target, url: "http://127.0.0.1:1/healthz" };
    const { code, output } = await runCheck("healthz", testEnv(unreachable, hook));
    assert.equal(code, 1);
    assert.match(output, /attempt 2: no answer/);
    assert.equal(hook.posts.length, 1);
  });

  test("a redirect is not followed and fails the check", async () => {
    const { target, hook } = await setup([{ status: 301, location: "/elsewhere" }, { status: 301, location: "/elsewhere" }]);
    const { code, output } = await runCheck("landing", testEnv(target, hook, { WATCH_TOKEN: "" }));
    assert.equal(code, 1);
    assert.deepEqual(
      target.requests.map((request) => request.url),
      ["/healthz", "/healthz"],
    );
    assert.match(output, /HTTP 301/);
  });

  test("the staging environment is named in the message", async () => {
    const { target, hook } = await setup([{ status: 500 }]);
    await runCheck("healthz", testEnv(target, hook, { WATCH_ENVIRONMENT: "staging" }));
    assert.match(postedText(hook.posts[0]), /Environment: staging\./);
  });

  test("a failing webhook is reported by its status and the run still fails", async () => {
    const { target, hook } = await setup([{ status: 500 }], 500);
    const { code, output } = await runCheck("healthz", testEnv(target, hook));
    assert.equal(code, 1);
    assert.match(output, /alert post: HTTP 500/);
  });

  test("every failing run posts again and a later good run posts no recovery message", async () => {
    const { target, hook } = await setup([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 200 }]);
    assert.equal((await runCheck("healthz", testEnv(target, hook))).code, 1);
    assert.equal((await runCheck("healthz", testEnv(target, hook))).code, 1);
    assert.equal(hook.posts.length, 2);
    assert.equal((await runCheck("healthz", testEnv(target, hook))).code, 0);
    assert.equal(hook.posts.length, 2);
  });
});

describe("secrets and the public log", () => {
  test("neither the token nor the webhook address reaches the output or the message", async () => {
    const { target, hook } = await setup([{ status: 500 }, { status: 503, body: "cron_stale" }]);
    const { output } = await runCheck("healthz", testEnv(target, hook));
    for (const secret of [TOKEN, HOOK_SECRET, "127.0.0.1", String(new URL(hook.url).port)]) {
      assert.ok(!output.includes(secret), `the output holds ${secret}`);
    }
    for (const post of hook.posts) {
      assert.ok(!post.body.includes(TOKEN) && !post.body.includes(HOOK_SECRET) && !post.body.includes("127.0.0.1"));
    }
  });

  test("a failed run logs only HTTP statuses and the webhook status", async () => {
    const { target, hook } = await setup([{ status: 500 }]);
    const { output } = await runCheck("healthz", testEnv(target, hook));
    for (const line of output.trim().split("\n")) {
      assert.match(line, /^(healthz attempt [12]: HTTP \d{3}|alert post: HTTP \d{3})$/);
    }
  });

  test("the script gives curl the token and the webhook through stdin, never as an argument", () => {
    const script = readFileSync(CHECK_SCRIPT, "utf8").split("\n").filter((line) => !/^\s*#/.test(line));
    const curlLines = script.filter((line) => line.includes("curl "));
    assert.equal(curlLines.length, 3);
    for (const line of curlLines) assert.doesNotMatch(line.replace(/printf '[^']*' "\$(token|webhook)" \|/, ""), /\$\{?(token|webhook|url)\b.*\bcurl|curl[^|]*\$\{?(token|webhook)\b/);
    assert.ok(!script.some((line) => /set -[a-z]*x|xtrace|\becho\b.*\$\{?(token|webhook)\b/.test(line)));
  });

  test("the token reaches the server only as a header", async () => {
    const { target, hook } = await setup([{ status: 200 }]);
    await runCheck("healthz", testEnv(target, hook));
    assert.equal(target.requests[0].url, "/healthz");
    assert.equal(target.requests[0].authorization, `Bearer ${TOKEN}`);
  });
});

describe("configuration errors stop the run before any request", () => {
  const cases = [
    ["a missing address", (env) => ({ ...env, WATCH_URL: "" }), "The address to check is not set."],
    ["a missing webhook", (env) => ({ ...env, WATCH_WEBHOOK: "" }), "The alert webhook is not set."],
    ["a missing token for healthz", (env) => ({ ...env, WATCH_TOKEN: "" }), "The check-in token is not set."],
    ["an unknown environment", (env) => ({ ...env, WATCH_ENVIRONMENT: "dev" }), "WATCH_ENVIRONMENT is neither production nor staging."],
  ];
  for (const [name, change, message] of cases) {
    test(name, async () => {
      const { target, hook } = await setup([{ status: 500 }]);
      const { code, output } = await runCheck("healthz", change(testEnv(target, hook)));
      assert.equal(code, 2);
      assert.equal(output.trim(), message);
      assert.equal(target.requests.length, 0);
      assert.equal(hook.posts.length, 0);
    });
  }

  test("outside test mode an http address and a webhook that is not Slack's are refused", async () => {
    const { target, hook } = await setup([{ status: 500 }]);
    const live = { ...testEnv(target, hook), WATCH_TEST_MODE: "" };
    const http = await runCheck("healthz", live);
    assert.equal(http.code, 2);
    assert.equal(http.output.trim(), "The address to check is not an https address.");
    const webhook = await runCheck("healthz", { ...live, WATCH_URL: "https://127.0.0.1/healthz" });
    assert.equal(webhook.code, 2);
    assert.equal(webhook.output.trim(), "The alert webhook is not a Slack Incoming Webhook address.");
    assert.equal(target.requests.length, 0);
    assert.equal(hook.posts.length, 0);
  });

  test("outside test mode the timeout and the delay overrides are ignored", () => {
    const script = readFileSync(CHECK_SCRIPT, "utf8");
    assert.match(script, /^timeout=10$/m);
    assert.match(script, /^retry_delay=300$/m);
    assert.match(script, /if \[ "\$\{WATCH_TEST_MODE:-\}" = "1" \]; then\n\s+timeout="\$\{WATCH_TEST_TIMEOUT:-\$timeout\}"/);
  });

  test("an unknown check is a usage error", async () => {
    const { target, hook } = await setup([{ status: 200 }]);
    const { code, output } = await runCheck("bogus", testEnv(target, hook));
    assert.equal(code, 2);
    assert.match(output, /usage: watch-check\.sh healthz\|landing/);
    assert.equal((await runCheck(null, testEnv(target, hook))).code, 2);
  });
});
