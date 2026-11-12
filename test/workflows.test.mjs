// Tests of the two workflow files, parsed as text without a YAML package
// (tracker APC-030, APC-032): permissions, schedule, secrets wiring, pinned
// actions, expressions in run: blocks and the separation of the production and
// the staging secrets. Run with `npm test`.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ROOT } from "./helpers.mjs";

const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";

/** What each workflow must hold; the staging file differs in these values only. */
const WORKFLOWS = {
  "watch.yml": {
    name: "watch",
    healthzUrl: "https://app.emdashfleet.com/healthz",
    landingUrl: "https://emdashfleet.com/",
    tokenSecret: "WATCH_CHECKIN_TOKEN",
    hookSecret: "SLACK_WATCH_WEBHOOK_URL",
    environment: "production",
  },
  "watch-staging.yml": {
    name: "watch-staging",
    healthzUrl: "https://staging.emdashfleet.com/healthz",
    landingUrl: "${{ vars.STAGING_SITE_URL }}",
    tokenSecret: "WATCH_CHECKIN_TOKEN_STAGING",
    hookSecret: "SLACK_WATCH_WEBHOOK_URL_STAGING",
    environment: "staging",
  },
};

const read = (file) => readFileSync(join(ROOT, ".github", "workflows", file), "utf8");
/** The file without comment lines, which may name things the file must not use. */
const code = (file) => read(file).split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

/** The steps of the one job: { name, if, uses, env, run, lines }. */
function steps(file) {
  const lines = code(file).split("\n");
  const starts = lines.flatMap((line, index) => (/^      - /.test(line) ? [index] : []));
  return starts.map((start, i) => {
    const block = lines.slice(start, starts[i + 1] ?? lines.length);
    const text = block.join("\n");
    const field = (key) => new RegExp(`^(?:      - |        )${key}: (.*)$`, "m").exec(text)?.[1] ?? null;
    const env = {};
    const at = block.findIndex((line) => line === "        env:");
    if (at >= 0) {
      for (const line of block.slice(at + 1)) {
        const entry = /^          ([A-Z_]+): (.*)$/.exec(line);
        if (entry === null) break;
        env[entry[1]] = entry[2];
      }
    }
    return { name: field("name"), if: field("if"), uses: field("uses"), run: field("run"), env, text };
  });
}

for (const [file, want] of Object.entries(WORKFLOWS)) {
  describe(file, () => {
    test("is named, and triggers on a 15 minute schedule and by hand only", () => {
      const text = code(file);
      assert.match(text, new RegExp(`^name: ${want.name}$`, "m"));
      assert.match(text, /^on:\n  schedule:\n    - cron: "\*\/15 \* \* \* \*"\n  workflow_dispatch:\n\npermissions:/m);
      assert.equal(text.match(/cron:/g).length, 1);
      for (const trigger of ["push", "pull_request", "pull_request_target", "workflow_run", "issue_comment", "repository_dispatch"]) {
        assert.doesNotMatch(text, new RegExp(`^  ${trigger}:`, "m"));
      }
    });

    test("declares permissions contents: read and no other permission", () => {
      const text = code(file);
      assert.match(text, /^permissions:\n  contents: read\n\njobs:/m);
      assert.equal(text.match(/permissions:/g).length, 1);
    });

    test("pins every action by full commit SHA with its version", () => {
      const uses = [...code(file).matchAll(/uses: (.*)$/gm)].map((match) => match[1]);
      assert.deepEqual(uses, [CHECKOUT]);
      for (const use of uses) assert.match(use, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
      assert.match(code(file), /persist-credentials: false/);
    });

    test("runs one job with a timeout that holds both steps and their retry", () => {
      const text = code(file);
      assert.equal(text.match(/^  [a-z-]+:$/gm).filter((key) => key !== "  schedule:").length, 1);
      const minutes = Number(/timeout-minutes: (\d+)/.exec(text)?.[1]);
      assert.ok(minutes >= 12 && minutes <= 30, `timeout-minutes is ${minutes}`);
      assert.match(text, /runs-on: ubuntu-latest/);
      assert.doesNotMatch(text, /continue-on-error/);
    });

    test("has the two separate steps, healthz first, the landing page after a failed one", () => {
      const [checkout, healthz, landing, ...rest] = steps(file);
      assert.equal(rest.length, 0);
      assert.equal(checkout.uses, CHECKOUT);
      assert.equal(healthz.name, "healthz");
      assert.equal(healthz.run, "bash scripts/watch-check.sh healthz");
      assert.equal(healthz.if, null);
      assert.equal(landing.name, "landing page");
      assert.equal(landing.run, "bash scripts/watch-check.sh landing");
      assert.equal(landing.if, "${{ !cancelled() }}");
      assert.ok(existsSync(join(ROOT, "scripts", "watch-check.sh")));
    });

    test("wires the secrets of its own environment into the step env and nowhere else", () => {
      const [, healthz, landing] = steps(file);
      assert.deepEqual(healthz.env, {
        WATCH_URL: want.healthzUrl,
        WATCH_TOKEN: `\${{ secrets.${want.tokenSecret} }}`,
        WATCH_WEBHOOK: `\${{ secrets.${want.hookSecret} }}`,
        WATCH_ENVIRONMENT: want.environment,
      });
      assert.deepEqual(landing.env, {
        WATCH_URL: want.landingUrl,
        WATCH_WEBHOOK: `\${{ secrets.${want.hookSecret} }}`,
        WATCH_ENVIRONMENT: want.environment,
      });
      const secretLines = code(file).split("\n").filter((line) => line.includes("secrets."));
      assert.equal(secretLines.length, 3);
      for (const line of secretLines) assert.match(line, /^          WATCH_(TOKEN|WEBHOOK): \$\{\{ secrets\.[A-Z_]+ \}\}$/);
      assert.doesNotMatch(code(file), /secrets: inherit|secrets\[|toJSON|GITHUB_TOKEN/);
    });

    test("holds no expression in a run: block and no expression but the allowed ones", () => {
      const text = code(file);
      for (const step of steps(file)) {
        if (step.run !== null) assert.ok(!step.run.includes("${{"), `${step.name} run: holds an expression`);
      }
      assert.doesNotMatch(text, /^\s+run: [|>]/m, "a multi-line run: block would need a review of its expressions");
      const expressions = [...text.matchAll(/\$\{\{ (.*?) \}\}/g)].map((match) => match[1]);
      for (const expression of expressions) {
        assert.match(expression, /^(secrets\.[A-Z_]+|!cancelled\(\)|vars\.STAGING_SITE_URL)$/);
        assert.ok(!expression.startsWith("github."), "a github context value reaches the file");
      }
    });

    test("does not use the test mode of the check script and does not trace", () => {
      const text = code(file);
      assert.doesNotMatch(text, /WATCH_TEST_|set -x|ACTIONS_STEP_DEBUG|xtrace/);
    });
  });
}

describe("production and staging", () => {
  const production = code("watch.yml").split("\n");
  const staging = code("watch-staging.yml").split("\n");

  test("watch-staging.yml is watch.yml with only the staging values changed", () => {
    assert.equal(staging.length, production.length);
    const differing = production.flatMap((line, index) => (line === staging[index] ? [] : [[line.trim(), staging[index].trim()]]));
    assert.deepEqual(differing, [
      ["name: watch", "name: watch-staging"],
      ["WATCH_URL: https://app.emdashfleet.com/healthz", "WATCH_URL: https://staging.emdashfleet.com/healthz"],
      ["WATCH_TOKEN: ${{ secrets.WATCH_CHECKIN_TOKEN }}", "WATCH_TOKEN: ${{ secrets.WATCH_CHECKIN_TOKEN_STAGING }}"],
      ["WATCH_WEBHOOK: ${{ secrets.SLACK_WATCH_WEBHOOK_URL }}", "WATCH_WEBHOOK: ${{ secrets.SLACK_WATCH_WEBHOOK_URL_STAGING }}"],
      ["WATCH_ENVIRONMENT: production", "WATCH_ENVIRONMENT: staging"],
      ["WATCH_URL: https://emdashfleet.com/", "WATCH_URL: ${{ vars.STAGING_SITE_URL }}"],
      ["WATCH_WEBHOOK: ${{ secrets.SLACK_WATCH_WEBHOOK_URL }}", "WATCH_WEBHOOK: ${{ secrets.SLACK_WATCH_WEBHOOK_URL_STAGING }}"],
      ["WATCH_ENVIRONMENT: production", "WATCH_ENVIRONMENT: staging"],
    ]);
  });

  test("watch-staging.yml never names a production secret, even in a comment", () => {
    const text = read("watch-staging.yml");
    assert.doesNotMatch(text, /SLACK_WATCH_WEBHOOK_URL(?!_STAGING)/);
    assert.doesNotMatch(text, /WATCH_CHECKIN_TOKEN(?!_STAGING)/);
    assert.doesNotMatch(text, /NIGHTLY_CHECKIN|SLACK_CI_WEBHOOK|SLACK_MAIL_WEBHOOK|app\.emdashfleet\.com|https:\/\/emdashfleet\.com/);
    assert.match(text, /SLACK_WATCH_WEBHOOK_URL_STAGING/);
  });

  test("watch.yml never names a staging secret or address", () => {
    const text = code("watch.yml");
    assert.doesNotMatch(text, /_STAGING|staging|STAGING_SITE_URL/);
  });

  test("every script and workflow other than the check scripts uses the same check script", () => {
    for (const file of Object.keys(WORKFLOWS)) {
      const runs = steps(file).flatMap((step) => (step.run === null ? [] : [step.run]));
      assert.deepEqual(runs, ["bash scripts/watch-check.sh healthz", "bash scripts/watch-check.sh landing"]);
    }
  });
});
