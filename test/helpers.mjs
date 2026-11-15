// Shared helpers of the tests: local HTTP servers that stand in for the
// watched address and for the Slack Incoming Webhook, and a runner for
// scripts/watch-check.sh. Node built-ins only.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CHECK_SCRIPT = join(ROOT, "scripts", "watch-check.sh");

/** Secrets used by the tests; no output or posted body may hold either. */
export const TOKEN = "tok-6f1c0d2e9b7a4c35-SECRET";
export const HOOK_SECRET = "HOOKSECRET9d41c7e2";

/**
 * Starts a server that answers its requests from `responses` in order and
 * repeats the last one. Each response is { status, body, delayMs, location }.
 * `requests` records the path and the Authorization header of every request.
 */
export async function startTarget(responses) {
  const requests = [];
  const server = createServer((req, res) => {
    const index = Math.min(requests.length, responses.length - 1);
    requests.push({ url: req.url, authorization: req.headers.authorization ?? null });
    const { status = 200, body = "", delayMs = 0, location } = responses[index];
    setTimeout(() => {
      res.writeHead(status, location ? { location } : {});
      res.end(body);
    }, delayMs);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    requests,
    url: `http://127.0.0.1:${port}/healthz`,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Starts a stub Incoming Webhook that records every POST and answers `status`. */
export async function startHook(status = 200) {
  const posts = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      posts.push({ method: req.method, path: req.url, contentType: req.headers["content-type"] ?? null, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(status);
      res.end("ok");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    posts,
    url: `http://127.0.0.1:${port}/services/T000/B000/${HOOK_SECRET}`,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/** The text of a posted payload. */
export const postedText = (post) => JSON.parse(post.body).text;

/** Runs the check script and resolves { code, output } with stdout and stderr together. */
export function runCheck(kind, env, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [CHECK_SCRIPT, ...(kind === null ? [] : [kind]), ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME ?? "/", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

/** The environment of a test run: test mode with short waits, the stubs as targets. */
export const testEnv = (target, hook, extra = {}) => ({
  WATCH_TEST_MODE: "1",
  WATCH_TEST_TIMEOUT: "1",
  WATCH_TEST_RETRY_DELAY: "0.1",
  WATCH_URL: target.url,
  WATCH_TOKEN: TOKEN,
  WATCH_WEBHOOK: hook.url,
  WATCH_ENVIRONMENT: "production",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "Zeyadigital/EmDashFleet-Watch",
  GITHUB_RUN_ID: "123456789",
  ...extra,
});
