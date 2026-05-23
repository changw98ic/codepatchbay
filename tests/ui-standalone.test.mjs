import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

describe("ui standalone (packed install)", { concurrency: false, timeout: 120_000 }, () => {
  let tmpDir;
  let packFile;
  let installDir;
  let runtimeDir;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `cpb-ui-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    installDir = path.join(tmpDir, "package");
    runtimeDir = path.join(tmpDir, "runtime");
    await mkdir(installDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("packs and installs successfully", async () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");

    // Build web if not already built
    if (!existsSync(path.join(projectRoot, "web", "dist"))) {
      execSync("npm run build:web", { cwd: projectRoot, stdio: "pipe" });
    }

    // Pack
    const packOutput = execSync("npm pack --pack-destination " + tmpDir, {
      cwd: projectRoot,
      stdio: "pipe",
    }).toString();

    // Find the tarball
    const { readdirSync } = await import("node:fs");
    const tarballs = readdirSync(tmpDir).filter((f) => f.endsWith(".tgz"));
    assert.ok(tarballs.length >= 1, "expected at least one tarball");
    packFile = path.join(tmpDir, tarballs[tarballs.length - 1]);

    // Install
    execSync(`npm install --omit=dev "${packFile}"`, {
      cwd: installDir,
      stdio: "pipe",
    });

    // Verify server file exists
    const serverPath = path.join(installDir, "node_modules", "codepatchbay", "server", "index.js");
    assert.ok(existsSync(serverPath), "server/index.js should exist in installed package");
  });

  it("serves static UI and rejects API traversal in standalone mode", async () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");

    // Build web if needed
    if (!existsSync(path.join(projectRoot, "web", "dist"))) {
      execSync("npm run build:web", { cwd: projectRoot, stdio: "pipe" });
    }

    // Pack + install
    execSync("npm pack --pack-destination " + tmpDir, { cwd: projectRoot, stdio: "pipe" });
    const { readdirSync } = await import("node:fs");
    const tarballs = readdirSync(tmpDir).filter((f) => f.endsWith(".tgz"));
    packFile = path.join(tmpDir, tarballs[tarballs.length - 1]);
    execSync(`npm install --omit=dev "${packFile}"`, { cwd: installDir, stdio: "pipe" });

    const executorRoot = path.join(installDir, "node_modules", "codepatchbay");

    // Create a fake adjacent directory to test prefix bypass
    const leakDir = path.join(executorRoot, "web", "dist-leak");
    await mkdir(leakDir, { recursive: true });
    await writeFile(path.join(leakDir, "secret.txt"), "LEAK_SECRET");

    const PORT = 13000 + Math.floor(Math.random() * 1000);
    const env = {
      ...process.env,
      CPB_ROOT: runtimeDir,
      CPB_EXECUTOR_ROOT: executorRoot,
      CPB_PORT: String(PORT),
      CPB_HOST: "127.0.0.1",
    };

    // Start server
    const server = spawn("node", [path.join(executorRoot, "server", "index.js")], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let serverReady = false;
    const serverLogs = [];
    server.stderr.on("data", (d) => serverLogs.push(d.toString()));
    server.stdout.on("data", (d) => {
      const line = d.toString();
      serverLogs.push(line);
      if (line.includes("running at")) serverReady = true;
    });

    // Wait for server ready (max 10s)
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("server start timeout: " + serverLogs.join(""))), 10_000);
      const check = setInterval(() => {
        if (serverReady) { clearTimeout(timeout); clearInterval(check); resolve(); }
      }, 200);
    });

    try {
      // Test 1: /api/definitely-missing returns 404 JSON (not HTML)
      const apiRes = await fetch(`http://127.0.0.1:${PORT}/api/definitely-missing`);
      assert.equal(apiRes.status, 404, "/api/missing should be 404");
      const apiBody = await apiRes.text();
      assert.ok(!apiBody.includes("<!DOCTYPE"), "/api/missing should not return HTML");
      // Should be JSON
      assert.doesNotThrow(() => JSON.parse(apiBody), "/api/missing should return valid JSON");

      // Test 2: path traversal blocked (curl --path-as-is sends raw /../ without normalization)
      const curlOut = execSync(
        `curl -s -o /dev/null -w '%{http_code}' --path-as-is 'http://127.0.0.1:${PORT}/../dist-leak/secret.txt'`,
        { stdio: ["pipe", "pipe", "pipe"] },
      ).toString().trim();
      assert.equal(curlOut, "404", "path traversal should be 404");

      // Test 3: / returns 200 HTML (if web/dist exists)
      if (existsSync(path.join(executorRoot, "web", "dist", "index.html"))) {
        const rootRes = await fetch(`http://127.0.0.1:${PORT}/`);
        assert.equal(rootRes.status, 200, "/ should return 200");
        const rootBody = await rootRes.text();
        assert.ok(rootBody.includes("<!DOCTYPE") || rootBody.includes("<html"), "/ should return HTML");
      }
    } finally {
      server.kill("SIGTERM");
      await new Promise((r) => server.on("close", r)).catch(() => {});
    }
  });
});
