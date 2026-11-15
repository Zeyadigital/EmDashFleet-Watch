// Tests of the repository hygiene files (tracker APB-001, APC-005): Dependabot,
// the gitleaks configuration, the absence of git hooks, the exact Node.js version,
// the absence of dependencies and the workflow ci.yml. Workflow files are parsed as
// text, without a YAML package, like test/workflows.test.mjs. Run with `npm test`.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ROOT, TOKEN } from "./helpers.mjs";

const read = (path) => readFileSync(join(ROOT, path), "utf8");
/** The file without comment lines, which may name things the file must not use. */
const code = (path) => read(path).split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
const WORKFLOWS = readdirSync(join(ROOT, ".github", "workflows")).filter((name) => /\.ya?ml$/.test(name)).sort();

describe("dependabot.yml", () => {
  const text = code(".github/dependabot.yml");

  test("updates the GitHub Actions weekly into dev, and nothing else", () => {
    assert.match(text, /^version: 2$/m);
    assert.deepEqual([...text.matchAll(/package-ecosystem: (\S+)/g)].map((match) => match[1]), ["github-actions"]);
    assert.match(text, /^ {4}directory: \/$/m);
    assert.match(text, /^ {4}target-branch: dev$/m);
    assert.match(text, /^ {6}interval: weekly$/m);
  });

  test("covers every ecosystem in use: package.json holds no dependency and there is no other manifest", () => {
    const manifest = JSON.parse(read("package.json"));
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      assert.equal(manifest[field], undefined, `${field} would need an npm entry in dependabot.yml and an exact pin`);
    }
    const tracked = readdirSync(ROOT).filter((name) => ["package-lock.json", "Dockerfile", "go.mod", "requirements.txt", "Gemfile"].includes(name));
    assert.deepEqual(tracked, []);
  });
});

describe("gitleaks", () => {
  test(".gitleaks.toml extends the default rules and allows only the made-up token of the tests", () => {
    const text = code(".gitleaks.toml");
    assert.match(text, /^\[extend\]\s*\nuseDefault = true$/m);
    assert.equal(text.match(/^\[\[allowlists\]\]$/gm)?.length, 1);
    assert.ok(text.includes("paths = ['''^test/helpers\\.mjs$''']"), "the allowlist is limited to test/helpers.mjs");
    assert.ok(text.includes(`regexes = ['''^${TOKEN}$''']`), "the allowlist must name the exact token of test/helpers.mjs");
  });

  test("gitleaks runs in ci.yml only: no git hooks directory, and no hooks path or signing instruction (HR-162)", () => {
    assert.ok(!readdirSync(ROOT).includes(".githooks"), "the repository has a hooks directory");
    for (const file of ["CONTRIBUTING.md", "README.md"]) {
      assert.doesNotMatch(read(file), /hooksPath|gpgsign|signingkey|\.githooks/, file);
    }
    assert.match(read("CONTRIBUTING.md"), /gitleaks 8\.30\.1/);
  });
});

describe(".nvmrc", () => {
  test("is one exact Node.js version that the README names", () => {
    const version = read(".nvmrc").trim();
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.ok(read("README.md").includes(version), "the README names a different Node.js version");
  });
});

describe("ci.yml", () => {
  const text = code(".github/workflows/ci.yml");

  test("runs on pushes to dev and main and on pull requests to dev and main only, with a read-only token", () => {
    assert.match(text, /^on:\n {2}push:\n {4}branches: \[dev, main\]\n {2}pull_request:\n {4}branches: \[dev, main\]\n/m);
    assert.match(text, /^permissions:\n {2}contents: read\n(?! {2}\S)/m);
    assert.match(text, /^ {4}timeout-minutes: \d+$/m);
  });

  test("uses no secret, no deploy and no Slack post, and no expression inside a run: script", () => {
    assert.doesNotMatch(text, /secrets\.|WATCH_|SLACK_|webhook|workflow_dispatch|schedule:|pull_request_target/i);
    const lines = text.split("\n");
    const scripts = [];
    lines.forEach((line, index) => {
      if (!/^\s+(?:- )?run: /.test(line)) return;
      const indent = line.search(/\S/) + (line.trimStart().startsWith("- ") ? 2 : 0);
      scripts.push(line);
      if (/run: [|>]/.test(line)) {
        for (const next of lines.slice(index + 1)) {
          if (next.trim() !== "" && next.search(/\S/) <= indent) break;
          scripts.push(next);
        }
      }
    });
    assert.ok(scripts.length > 0);
    assert.doesNotMatch(scripts.join("\n"), /\$\{\{/);
  });

  test("runs gitleaks 8.30.1 over the commits of the push or pull request after checking the archive", () => {
    assert.match(text, /fetch-depth: 0/);
    assert.match(text, /GITLEAKS_VERSION: 8\.30\.1$/m);
    assert.match(text, /GITLEAKS_SHA256: 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb$/m);
    assert.match(text, /sha256sum --check --strict/);
    assert.match(text, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.before \}\}/);
    assert.match(text, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
    assert.match(text, /git rev-list --quiet "\$\{BASE_SHA\}\.\.\$\{HEAD_SHA\}"/);
    assert.match(text, /gitleaks" git .*--log-opts="\$\{BASE_SHA\}\.\.\$\{HEAD_SHA\}"/);
  });

  test("takes Node.js from .nvmrc and runs npm test", () => {
    assert.match(text, /node-version-file: \.nvmrc/);
    assert.match(text, /^ {6}- run: npm test$/m);
  });
});

describe("every workflow", () => {
  test("pins every action by full commit SHA with its version comment", () => {
    for (const file of WORKFLOWS) {
      const uses = read(`.github/workflows/${file}`).split("\n").filter((line) => /^\s*(?:- )?uses: /.test(line));
      assert.ok(uses.length > 0, file);
      for (const line of uses) assert.match(line, /uses: [\w./-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/, `${file}: ${line.trim()}`);
    }
  });
});
