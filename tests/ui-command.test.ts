import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assertSafeUiBind,
  buildUiServerEnv,
  isUiPortAvailable,
  parseUiArgs,
  run,
  uiUsage,
} from "../cli/commands/ui.js";

async function captureConsole<T>(fn: () => Promise<T>) {
  const originalLog = console.log;
  const originalError = console.error;
  const logs: string[] = [];
  const errors: string[] = [];
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  try {
    const result = await fn();
    return { result, logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function listen(server: net.Server, port: number, host: string) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: net.Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}

async function freePort(host = "127.0.0.1") {
  const server = net.createServer();
  await listen(server, 0, host);
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await closeServer(server);
  return port;
}

test("ui command parses help without starting a server", () => {
  const options = parseUiArgs(["--help"], { CPB_PORT: "4567", CPB_HOST: "0.0.0.0" });

  assert.equal(options.help, true);
  assert.equal(options.port, "4567");
  assert.equal(options.host, "0.0.0.0");
  assert.match(uiUsage(), /Usage:\s+cpb ui/);
});

test("ui command help is not blocked by an invalid CPB_PORT", () => {
  const options = parseUiArgs(["--help"], { CPB_PORT: "not-a-port" });

  assert.equal(options.help, true);
  assert.equal(options.port, "3456");
  assert.equal(options.host, "127.0.0.1");
});

test("ui command CLI port overrides an invalid CPB_PORT", () => {
  const options = parseUiArgs(["--port", "4567"], { CPB_PORT: "not-a-port" });

  assert.equal(options.help, false);
  assert.equal(options.port, "4567");
});

test("ui command rejects malformed flags before spawning servers", () => {
  assert.throws(
    () => parseUiArgs(["--port"], {}),
    /missing value for --port/
  );
  assert.throws(
    () => parseUiArgs(["--port", "0"], {}),
    /invalid --port/
  );
  assert.throws(
    () => parseUiArgs(["--bogus"], {}),
    /unknown option/
  );
});

test("ui command rejects malformed hosts before spawning servers", () => {
  assert.throws(
    () => parseUiArgs(["--host", "http://0.0.0.0"], {}),
    /invalid --host/
  );
  assert.throws(
    () => parseUiArgs(["--host", "bad host"], {}),
    /invalid --host/
  );
});

test("ui command rejects public unauthenticated binds", () => {
  assert.throws(
    () => assertSafeUiBind("0.0.0.0", {}),
    /requires CPB_API_KEYS/
  );
  assert.doesNotThrow(() => assertSafeUiBind("0.0.0.0", { CPB_API_KEYS: "dev-key" }));
  assert.doesNotThrow(() => assertSafeUiBind("127.0.0.1", {}));
  assert.doesNotThrow(() => assertSafeUiBind("localhost", {}));
});

test("ui server env preserves API keys when public bind auth depends on them", () => {
  const env = buildUiServerEnv(
    { CPB_API_KEYS: "dev-key", NOT_ALLOWED_FLAG: "1" },
    { cpbRoot: "/cpb", executorRoot: "/executor", port: "4567", host: "0.0.0.0" }
  );

  assert.equal(env.CPB_API_KEYS, "dev-key");
  assert.equal(env.NOT_ALLOWED_FLAG, undefined);
  assert.equal(env.CPB_HOST, "0.0.0.0");
  assert.equal(env.CPB_PORT, "4567");
});

test("ui command help returns without requiring a server entrypoint", async () => {
  const { result, logs, errors } = await captureConsole(() =>
    run(["--help"], { cpbRoot: "/definitely/missing/cpb-root" })
  );

  assert.equal(result, 0);
  assert.match(logs.join("\n"), /Usage:\s+cpb ui/);
  assert.equal(errors.join("\n"), "");
});

test("ui command port preflight returns before spawning servers", async () => {
  const server = net.createServer();
  await listen(server, 0, "127.0.0.1");
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    const { result, logs, errors } = await captureConsole(() =>
      run(["--host", "127.0.0.1", "--port", String(address.port)], { cpbRoot: "/definitely/missing/cpb-root" })
    );
    assert.equal(result, 1);
    assert.equal(logs.join("\n"), "");
    assert.match(errors.join("\n"), /not available/);
  } finally {
    await closeServer(server);
  }
});

test("ui command checks the vite port before spawning the backend", async (t) => {
  const frontendPort = net.createServer();
  try {
    await listen(frontendPort, 5173, "127.0.0.1");
  } catch (error: any) {
    if (error?.code === "EADDRINUSE") {
      t.skip("frontend port 5173 is already occupied");
      return;
    }
    throw error;
  }

  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-ui-vite-port-"));
  try {
    await mkdir(path.join(cpbRoot, "web"), { recursive: true });
    await writeFile(path.join(cpbRoot, "web", "vite.config.js"), "export default {};\n", "utf8");
    const backendPort = await freePort();

    const { result, logs, errors } = await captureConsole(() =>
      run(["--host", "127.0.0.1", "--port", String(backendPort)], { cpbRoot })
    );

    assert.equal(result, 1);
    assert.equal(logs.join("\n"), "");
    assert.match(errors.join("\n"), /frontend port 5173 is not available/);
  } finally {
    await closeServer(frontendPort);
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("ui port preflight reports occupied ports", async () => {
  const server = net.createServer();
  await listen(server, 0, "127.0.0.1");
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    assert.equal(await isUiPortAvailable("127.0.0.1", address.port), false);
  } finally {
    await closeServer(server);
  }
});
