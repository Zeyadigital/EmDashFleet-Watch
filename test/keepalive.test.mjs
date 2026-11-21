// Tests of scripts/keepalive.sh against a local bare repository (tracker
// APC-031). Nothing is pushed anywhere else: every run passes --remote with a
// temporary path, and the git configuration is a temporary file, so neither the
// operator's configuration nor GitHub is touched. Run with `npm test`.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { ROOT } from "./helpers.mjs";

const SCRIPT = join(ROOT, "scripts", "keepalive.sh");
let dir;
let bare;
let config;
let noIdentityConfig;

const git = (args, cwd, env = {}) => execFileSync("git", args, { cwd, env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", ...env }, encoding: "utf8" }).trim();
const bareGit = (...args) => git(["--git-dir", bare, ...args], dir);

/** Runs the script with a given global git configuration and extra PATH directories. */
function keepalive(args, { gitConfig = config, path = process.env.PATH, remote = bare } = {}) {
  const result = spawnSync("bash", [SCRIPT, ...(remote === null ? [] : ["--remote", remote]), ...args], {
    env: { PATH: path, HOME: dir, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" },
    encoding: "utf8",
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}`.trim() };
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "keepalive-test-"));
  config = join(dir, "operator.gitconfig");
  writeFileSync(config, "[user]\n\tname = Test Operator\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n");
  noIdentityConfig = join(dir, "no-identity.gitconfig");
  // No [user] section and no useConfigOnly: git would guess a name and address from the computer, which the script must refuse.
  writeFileSync(noIdentityConfig, "[init]\n\tdefaultBranch = main\n");

  bare = join(dir, "remote.git");
  git(["init", "--bare", "--quiet", "--initial-branch=main", bare], dir);
  const seed = join(dir, "seed");
  git(["init", "--quiet", seed], dir);
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(["add", "README.md"], seed);
  git(["commit", "--quiet", "-m", "seed"], seed);
  git(["push", "--quiet", bare, "HEAD:refs/heads/main", "HEAD:refs/heads/dev"], seed);
  git(["tag", "light1"], seed);
  git(["tag", "-a", "v1", "-m", "v1"], seed);
  git(["push", "--quiet", bare, "light1", "v1"], seed);
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe("keepalive.sh", () => {
  test("a dry run creates the commit in a temporary clone and pushes nothing", () => {
    const before = bareGit("rev-parse", "main");
    const { code, output } = keepalive(["--dry-run"]);
    assert.equal(code, 0);
    assert.match(output, /^Dry run: created the commit [0-9a-f]{12} on main as Test Operator <test@example\.invalid>; nothing was pushed\.$/);
    assert.equal(bareGit("rev-parse", "main"), before);
  });

  test("pushes one empty commit to main as a fast-forward", () => {
    const parent = bareGit("rev-parse", "main");
    const dev = bareGit("rev-parse", "dev");
    const { code, output } = keepalive([]);
    assert.equal(code, 0);
    assert.match(output, /^Pushed the keepalive commit [0-9a-f]{12} to main as Test Operator <test@example\.invalid>\.$/);
    const head = bareGit("rev-parse", "main");
    assert.notEqual(head, parent);
    assert.equal(bareGit("rev-parse", `${head}^`), parent, "the commit is a fast-forward of the old head");
    assert.equal(bareGit("rev-parse", `${head}^{tree}`), bareGit("rev-parse", `${parent}^{tree}`), "the commit changes no file");
    assert.match(bareGit("log", "-1", "--format=%s", head), /^Keepalive \d{4}-\d{2}-\d{2}$/);
    assert.equal(bareGit("rev-parse", "dev"), dev, "dev is left alone");
  });

  test("refuses to push when no git identity is configured, instead of letting git guess one", () => {
    const before = bareGit("rev-parse", "main");
    const { code, output } = keepalive([], { gitConfig: noIdentityConfig });
    assert.equal(code, 1);
    assert.match(output, /The commit could not be created\. Set user\.name and user\.email/);
    assert.equal(bareGit("rev-parse", "main"), before);
  });

  test("a tag given as --branch is refused, and no branch named after it is created", () => {
    for (const tag of ["v1", "light1"]) {
      const { code, output } = keepalive(["--branch", tag]);
      assert.equal(code, 1, tag);
      assert.match(output, new RegExp(`^${tag} is not a branch of the remote\\.$`));
      assert.throws(() => bareGit("rev-parse", "--verify", "--quiet", `refs/heads/${tag}`), undefined, tag);
    }
  });

  test("a refused push (a protected branch) changes nothing and says so", () => {
    const hooks = join(bare, "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-receive"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(hooks, "pre-receive"), 0o755);
    const before = bareGit("rev-parse", "main");
    try {
      const { code, output } = keepalive([]);
      assert.equal(code, 1);
      assert.match(output, /^git: .*\n.*The push to main was refused/);
      assert.equal(bareGit("rev-parse", "main"), before);
    } finally {
      rmSync(join(hooks, "pre-receive"));
    }
  });

  test("--branch commits to that branch only", () => {
    const main = bareGit("rev-parse", "main");
    const dev = bareGit("rev-parse", "dev");
    const { code } = keepalive(["--branch", "dev"]);
    assert.equal(code, 0);
    assert.equal(bareGit("rev-parse", "main"), main);
    assert.notEqual(bareGit("rev-parse", "dev"), dev);
  });

  test("a branch that does not exist is an error", () => {
    const { code, output } = keepalive(["--branch", "nope"]);
    assert.equal(code, 1);
    assert.match(output, /The branch nope could not be cloned from the remote\./);
  });

  test("bad arguments are refused before any clone", () => {
    for (const args of [["--branch", "--force"], ["--branch", "a..b"], ["--branch", "x y"], ["--bogus"], ["--branch"]]) {
      const { code } = keepalive(args);
      assert.equal(code, 2, args.join(" "));
    }
    assert.equal(keepalive([], { remote: "" }).code, 2);
  });

  test("--check-state reads both scheduled workflows through gh, after a push or a dry run, and fails unless both are active", () => {
    const stubs = join(dir, "stubs");
    mkdirSync(stubs, { recursive: true });
    const calls = join(dir, "gh-calls");
    // The stub answers GH_STATE for watch.yml and GH_STAGING for watch-staging.yml.
    writeFileSync(join(stubs, "gh"), `#!/bin/sh\necho "$@" >> "${calls}"\ncase "$*" in *watch-staging.yml*) printf '%s\\n' "$GH_STAGING" ;; *) printf '%s\\n' "$GH_STATE" ;; esac\n`);
    chmodSync(join(stubs, "gh"), 0o755);
    const run = (state, staging, extra = []) => {
      const result = spawnSync("bash", [SCRIPT, "--remote", bare, "--check-state", ...extra], {
        env: { PATH: `${stubs}:${process.env.PATH}`, HOME: dir, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", GH_STATE: state, GH_STAGING: staging },
        encoding: "utf8",
      });
      return { code: result.status, output: `${result.stdout}${result.stderr}`.trim() };
    };
    const active = run("active", "active");
    assert.equal(active.code, 0);
    assert.match(active.output, /watch\.yml state: active\nwatch-staging\.yml state: active/);
    const disabled = run("disabled_inactivity", "active");
    assert.equal(disabled.code, 1);
    assert.match(disabled.output, /watch\.yml is not active\. Run the runbook Re-enable the outside watch\./);
    const staging = run("active", "disabled_manually");
    assert.equal(staging.code, 1);
    assert.match(staging.output, /watch-staging\.yml is not active\./);
    const before = bareGit("rev-parse", "main");
    const dry = run("disabled_inactivity", "active", ["--dry-run"]);
    assert.equal(dry.code, 1, "a dry run still performs the requested check");
    assert.match(dry.output, /nothing was pushed\.\nwatch\.yml state: disabled_inactivity/);
    assert.equal(bareGit("rev-parse", "main"), before);
    const lines = readFileSync(calls, "utf8");
    assert.match(lines, /^api --hostname github\.com repos\/Zeyadigital\/EmDashFleet-Watch\/actions\/workflows\/watch\.yml --jq \.state$/m);
    assert.match(lines, /^api --hostname github\.com repos\/Zeyadigital\/EmDashFleet-Watch\/actions\/workflows\/watch-staging\.yml --jq \.state$/m);
  });

  test("the default remote is the public repository, and the script never forces a push", () => {
    const script = readFileSync(SCRIPT, "utf8");
    assert.match(script, /^remote="https:\/\/github\.com\/Zeyadigital\/EmDashFleet-Watch\.git"$/m);
    assert.doesNotMatch(script.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n"), /--force|push -f|\+HEAD|--no-verify/);
  });

  test("the commit never uses a guessed identity, on any host", () => {
    // The behavioural test above detects a regression only where git can guess
    // (a hostname with a dot, as macOS .local); an undotted CI host refuses
    // either way, so the option itself is pinned (security audit of 2026-11-21, Watch v06).
    const script = readFileSync(SCRIPT, "utf8");
    const commits = script.split("\n").filter((line) => /^\s*git .* commit /.test(line));
    assert.deepEqual(commits.map((line) => /^git -C "\$repo" -c user\.useConfigOnly=true commit /.test(line)), [true]);
  });
});
