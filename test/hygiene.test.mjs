// Tests of the repository hygiene files (tracker APB-001, APC-005): Dependabot,
// the gitleaks configuration, the absence of git hooks, the exact Node.js version,
// the absence of dependencies and the workflow ci.yml. Workflow files are parsed as
// text, without a YAML package, like test/workflows.test.mjs. Run with `npm test`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

  // The default configuration that useDefault pulls in exempts whole paths from every
  // rule, and .gitleaks.toml cannot remove an entry, so a secret committed under one of
  // these paths is never reported (security audit of 2026-11-21, Watch h15). The list
  // is the global allowlist of gitleaks 8.30.1 (`strings` over the release binary,
  // section "global allow lists"); re-read it whenever GITLEAKS_VERSION changes.
  test("no tracked file sits in a path the gitleaks 8.30.1 default exempts, other than .gitleaks.toml", () => {
    const exempt = [
    String.raw`gitleaks\.toml`,
    String.raw`(?i)\.(?:bmp|gif|jpe?g|png|svg|tiff?)$`,
    String.raw`(?i)\.(?:eot|[ot]tf|woff2?)$`,
    String.raw`(?i)\.(?:docx?|xlsx?|pdf|bin|socket|vsidx|v2|suo|wsuo|.dll|pdb|exe|gltf)$`,
    String.raw`go\.(?:mod|sum|work(?:\.sum)?)$`,
    String.raw`(?:^|/)vendor/modules\.txt$`,
    String.raw`(?:^|/)vendor/(?:github\.com|golang\.org/x|google\.golang\.org|gopkg\.in|istio\.io|k8s\.io|sigs\.k8s\.io)(?:/.*)?$`,
    String.raw`(?:^|/)gradlew(?:\.bat)?$`,
    String.raw`(?:^|/)gradle\.lockfile$`,
    String.raw`(?:^|/)mvnw(?:\.cmd)?$`,
    String.raw`(?:^|/)\.mvn/wrapper/MavenWrapperDownloader\.java$`,
    String.raw`(?:^|/)node_modules(?:/.*)?$`,
    String.raw`(?:^|/)(?:deno\.lock|npm-shrinkwrap\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$`,
    String.raw`(?:^|/)bower_components(?:/.*)?$`,
    String.raw`(?:^|/)(?:angular|bootstrap|jquery(?:-?ui)?|plotly|swagger-?ui)[a-zA-Z0-9.-]*(?:\.min)?\.js(?:\.map)?$`,
    String.raw`(?:^|/)javascript\.json$`,
    String.raw`(?:^|/)(?:Pipfile|poetry)\.lock$`,
    String.raw`(?i)(?:^|/)(?:v?env|virtualenv)/lib(?:64)?(?:/.*)?$`,
    String.raw`(?i)(?:^|/)(?:lib(?:64)?/python[23](?:\.\d{1,2})+|python/[23](?:\.\d{1,2})+/lib(?:64)?)(?:/.*)?$`,
    String.raw`(?i)(?:^|/)[a-z0-9_.]+-[0-9.]+\.dist-info(?:/.+)?$`,
    String.raw`(?:^|/)vendor/(?:bundle|ruby)(?:/.*?)?$`,
    String.raw`\.gem$`,
    String.raw`verification-metadata\.xml`,
    String.raw`Database.refactorlog`,
    String.raw`(?:^|/)\.git$`,
    ].map((pattern) => (pattern.startsWith("(?i)") ? new RegExp(pattern.slice(4), "i") : new RegExp(pattern)));
    const listed = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stderr);
    const files = listed.stdout.split("\0").filter((file) => file !== "");
    assert.ok(files.includes("scripts/watch-check.sh"), "git ls-files listed the repository");
    assert.deepEqual(files.filter((file) => file !== ".gitleaks.toml" && exempt.some((pattern) => pattern.test(file))), []);
    assert.ok(exempt.some((pattern) => pattern.test("img/logo.PNG")) && exempt.some((pattern) => pattern.test("a/package-lock.json")));
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
    // The whole on: block, up to the next top-level key, so no trigger can be appended
    // (security audit of 2026-11-21, Watch h20).
    assert.match(text, /^on:\n {2}push:\n {4}branches: \[dev, main\]\n {2}pull_request:\n {4}branches: \[dev, main\]\n\n*(?=\S)/m);
    assert.match(text, /^permissions:\n {2}contents: read\n(?! {2}\S)/m);
    assert.match(text, /^ {4}timeout-minutes: \d+$/m);
    // A GitHub-hosted runner, named by its exact label (security audit of 2026-11-21, Watch h16).
    assert.deepEqual(text.match(/^\s*runs-on:.*$/gm), ["    runs-on: ubuntu-latest"]);
  });

  test("uses no secret, no deploy and no Slack post, and no expression inside a run: script", () => {
    // secrets.X, secrets['X'] and toJSON(secrets) alike (security audit of 2026-11-21, Watch h20).
    assert.doesNotMatch(text, /\bsecrets\s*[.[)]|WATCH_|SLACK_|webhook|workflow_dispatch|schedule:|pull_request_target/i);
    // Every expression of the file, comment lines included (GitHub evaluates an expression
    // in a run: script's comment line too), is one of these four lines.
    assert.deepEqual(
      read(".github/workflows/ci.yml").split("\n").filter((line) => line.includes("${{")).map((line) => line.trim()),
      [
        "group: ci-${{ github.event_name }}-${{ github.event.pull_request.number || github.run_id }}",
        "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
        "BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.before }}",
        "HEAD_SHA: ${{ github.event.pull_request.head.sha || github.sha }}",
      ],
    );
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
    assert.match(text, /git log --numstat --format= --no-renames -m "\$\{BASE_SHA\}\.\.\$\{HEAD_SHA\}" \| awk -F'\\t' '\$1 == "-" && \$2 == "-" \{ print \$3 \}'/);
    assert.ok(text.indexOf("git log --numstat") < text.indexOf('"$RUNNER_TEMP/gitleaks" git'), "the binary guard runs before gitleaks");
    // The exact scan line, with --redact (a found token never reaches the public log), and
    // nothing in the file that would let a failed check pass: no `|| true`, exit code
    // override, continue-on-error, step or job condition, `exit 0` or other shell
    // (security audit of 2026-11-21, Watch h20).
    assert.match(text, /^ {10}"\$RUNNER_TEMP\/gitleaks" git --redact --no-banner --verbose --log-opts="--text -m \$\{BASE_SHA\}\.\.\$\{HEAD_SHA\}" \.$/m);
    assert.doesNotMatch(text, /\|\|\s*(?:true|:)|--exit-code|continue-on-error|^\s*(?:- )?if:|\bexit 0\b|^\s*shell:|set \+e/m);
    assert.match(text, /^ {10}persist-credentials: false$/m);
  });

  test("takes Node.js from .nvmrc and runs npm test", () => {
    assert.match(text, /node-version-file: \.nvmrc/);
    assert.match(text, /^ {6}- run: npm test$/m);
  });
});

describe("every workflow", () => {
  // A new workflow, or a .gitleaksignore that would silence a finding, is covered by no
  // other assertion, so the set is fixed here (security audit of 2026-11-21, Watch h20).
  test("is one of ci.yml, watch.yml and watch-staging.yml, and there is no .gitleaksignore", () => {
    assert.deepEqual(WORKFLOWS, ["ci.yml", "watch-staging.yml", "watch.yml"]);
    assert.ok(!readdirSync(ROOT).includes(".gitleaksignore"));
  });

  test("pins every action by full commit SHA with its version comment", () => {
    for (const file of WORKFLOWS) {
      const lines = code(`.github/workflows/${file}`).split("\n");
      const uses = lines.filter((line) => /^\s*(?:- )?uses: /.test(line));
      assert.ok(uses.length > 0, file);
      // Every uses: of the file, flow-style mappings included, is one of these lines.
      assert.equal(lines.filter((line) => /\buses\s*:/.test(line)).length, uses.length, `${file}: a uses: outside the block style`);
      for (const line of uses) {
        assert.match(line, /uses: actions\/(?:checkout|setup-node)@[0-9a-f]{40} # v\d+(\.\d+)*$/, `${file}: ${line.trim()}`);
      }
    }
  });
});

describe("scripts", () => {
  // A syntax error in a script surfaces only when a scheduled run reaches it,
  // so every script is parsed here (security audit of 2026-11-21).
  test("every script under scripts/ parses with bash -n", () => {
    const scripts = readdirSync(join(ROOT, "scripts")).filter((name) => name.endsWith(".sh")).sort();
    assert.deepEqual(scripts, ["keepalive.sh", "watch-check.sh"]);
    for (const name of scripts) {
      const result = spawnSync("bash", ["-n", join(ROOT, "scripts", name)], { encoding: "utf8", env: { PATH: process.env.PATH } });
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    }
  });
});
