import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const extensionDir = path.join(repoRoot, "extension");
const projectPath = process.env.LLM_WIKI_TEST_PROJECT
  ? path.resolve(process.env.LLM_WIKI_TEST_PROJECT)
  : path.join(repoRoot, "portable-artifacts", "llm-wiki-demo-project");
const clipServerBase = process.env.LLM_WIKI_CLIP_SERVER || "http://127.0.0.1:19827";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function ensureClipServer() {
  const res = await fetch(`${clipServerBase}/status`);
  const data = await res.json();
  assert(data.ok, "LLM Wiki clip server did not return ok");
}

async function copyDirectory(src, dest) {
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(from, to);
    } else {
      await fs.copyFile(from, to);
    }
  }
}

async function patchManifest(testExtensionDir, origin) {
  const manifestPath = path.join(testExtensionDir, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.host_permissions = Array.from(new Set([
    ...(manifest.host_permissions || []),
    `${origin}/*`,
  ]));
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

function startTestServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/article") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<html>
  <head>
    <title>LLM Wiki Auto Clip Smoke Article</title>
    <meta name="description" content="A deterministic article used by the LLM Wiki clipper smoke test.">
  </head>
  <body>
    <main>
      <article>
        <h1>LLM Wiki Auto Clip Smoke Article</h1>
        <p>This article is intentionally long enough for the clipper's minimum content threshold.</p>
        <p>The automated test loads the Chrome extension, enables auto clipping for this local origin, and waits for the LLM Wiki clip server to write a Markdown source file.</p>
        <p>Expected result: a file appears under raw/sources with origin web-clip and this article title.</p>
      </article>
    </main>
  </body>
</html>`);
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        origin: `http://127.0.0.1:${address.port}`,
        url: `http://127.0.0.1:${address.port}/article`,
      });
    });
  });
}

async function latestClipFile(before) {
  const sourcesDir = path.join(projectPath, "raw", "sources");
  const names = await fs.readdir(sourcesDir);
  const candidates = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const fullPath = path.join(sourcesDir, name);
    const stat = await fs.stat(fullPath);
    if (stat.mtimeMs > before) candidates.push({ fullPath, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.fullPath || null;
}

async function waitForClip(before, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const file = await latestClipFile(before);
    if (file) return file;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function main() {
  assert(fssync.existsSync(extensionDir), `Extension directory not found: ${extensionDir}`);
  assert(fssync.existsSync(path.join(projectPath, "schema.md")), `Invalid LLM Wiki project: ${projectPath}`);

  await ensureClipServer();
  await fetch(`${clipServerBase}/project`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: projectPath }),
  });
  await fetch(`${clipServerBase}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projects: [{ name: path.basename(projectPath), path: projectPath }] }),
  });

  const testServer = await startTestServer();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm-wiki-extension-smoke-"));
  const testExtensionDir = path.join(tempRoot, "extension");
  const userDataDir = path.join(tempRoot, "chrome-profile");
  await copyDirectory(extensionDir, testExtensionDir);
  await patchManifest(testExtensionDir, testServer.origin);

  const before = Date.now();
  const launchOptions = {
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${testExtensionDir}`,
      `--load-extension=${testExtensionDir}`,
    ],
  };
  if (process.env.PLAYWRIGHT_CHROME_CHANNEL) {
    launchOptions.channel = process.env.PLAYWRIGHT_CHROME_CHANNEL;
  }

  const context = await chromium.launchPersistentContext(userDataDir, launchOptions);

  try {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent("serviceworker", { timeout: 10000 });
    }

    await serviceWorker.evaluate(async ({ origin, projectPath }) => {
      await chrome.storage.local.set({
        apiUrl: "http://127.0.0.1:19827",
        defaultProjectPath: projectPath,
        autoClipEnabled: true,
        autoClipOrigins: [origin],
        sessionTag: "smoke-test",
        minContentLength: 50,
        whitelistDwellMs: 250,
        autoClipHistory: {},
      });
    }, { origin: testServer.origin, projectPath });

    const page = await context.newPage();
    await page.goto(testServer.url, { waitUntil: "domcontentloaded" });

    const clipFile = await waitForClip(before);
    assert(clipFile, "Timed out waiting for auto-clipped Markdown file");

    const content = await fs.readFile(clipFile, "utf8");
    assert(content.includes("LLM Wiki Auto Clip Smoke Article"), "Clip file did not contain article title");
    assert(content.includes("origin: web-clip"), "Clip file did not include web-clip frontmatter");
    assert(content.includes('clip_trigger: "whitelist"'), "Clip file did not include clip trigger metadata");
    assert(content.includes('tags: ["smoke-test"]'), "Clip file did not include session tag metadata");

    console.log(JSON.stringify({
      ok: true,
      clipFile,
      projectPath,
      testUrl: testServer.url,
    }, null, 2));
  } finally {
    await context.close();
    testServer.server.close();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exit(1);
});
