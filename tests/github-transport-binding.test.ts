import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import {
  resolveGithubTransport,
  saveGithubAppConfig,
} from "../server/services/github/github-api.js";

type CapturedCall = {
  executable: string;
  args: string[];
  options: Record<string, unknown>;
};

async function transportFixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-github-transport-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const hubRoot = path.join(root, "hub");
  const homeDir = path.join(root, "home");
  const configDir = path.join(homeDir, ".config", "gh");
  const executable = path.join(root, "bin", "gh");
  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o755);
  return {
    root,
    hubRoot,
    homeDir,
    configDir,
    executable,
    canonicalConfigDir: await realpath(configDir),
    canonicalExecutable: await realpath(executable),
  };
}

function environment(call: CapturedCall) {
  return call.options.env as NodeJS.ProcessEnv;
}

function assertSanitizedEnvironment(call: CapturedCall, expectedToken: string | null) {
  const env = environment(call);
  assert.equal(env.GH_HOST, "github.com");
  assert.equal(env.GH_PROMPT_DISABLED, "1");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GH_TOKEN, expectedToken || undefined);
  for (const forbidden of [
    "GITHUB_TOKEN",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]) {
    assert.equal(env[forbidden], undefined, `${forbidden} must not reach controlled gh`);
  }
}

function remoteCapability() {
  return {
    schema: "cpb.github-remote-capability.v1",
    repository: "example/cpb-disposable",
    repositoryId: "R_disposable",
    defaultBranch: "main",
    markerPath: ".cpb-disposable-target.json",
    markerSha: "a".repeat(40),
    issueNumber: 17,
    automationLabel: "cpb-e2e",
    allowedBranchPrefix: "cpb-release-rehearsal/",
    permissions: {
      repositoryPush: true,
      pullRequestCreate: true,
      pullRequestMerge: true,
      issueClose: true,
    },
  };
}

function disposableMarker() {
  return {
    schemaVersion: 1,
    purpose: "codepatchbay-release-rehearsal",
    repository: "example/cpb-disposable",
    disposable: true,
    allowCodePatchBayE2E: true,
    allowedIssueNumbers: [17],
    allowedAutomationLabels: ["cpb-e2e"],
    allowedBranchPrefix: "cpb-release-rehearsal/",
    allowRepositoryPush: true,
    allowDraftPullRequests: true,
    allowPullRequestMerge: true,
    allowIssueClose: true,
  };
}

test("gh fallback captures one actor and reuses one credential through a canonical runner", async (t) => {
  const fixture = await transportFixture(t);
  const calls: CapturedCall[] = [];
  const boundToken = "ghp_bound_transport_token";
  const execute = async (executable: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ executable, args: [...args], options });
    if (args[0] === "--version") return { stdout: "gh version 2.80.0\n", stderr: "" };
    if (args[0] === "auth" && args[1] === "token") return { stdout: `${boundToken}\n`, stderr: "" };
    if (args[0] === "api" && args[1] === "user") {
      return { stdout: JSON.stringify({ id: 91, login: "Cpb-Bot" }), stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "comment") return { stdout: "", stderr: "" };
    throw new Error(`unexpected gh command: ${args.join(" ")}`);
  };

  const transport = await resolveGithubTransport(fixture.hubRoot, {
    env: {
      GH_TOKEN: "ambient-token",
      GITHUB_TOKEN: "ambient-github-token",
      HTTPS_PROXY: "https://attacker.invalid",
      NODE_EXTRA_CA_CERTS: "/tmp/attacker.pem",
      PATH: "/tmp/attacker-bin",
    },
    execFile: execute,
    ghExecutable: fixture.executable,
    ghHomeDir: fixture.homeDir,
    ghConfigDir: fixture.configDir,
  });

  assert.equal(transport.mode, "gh");
  assert.equal(transport.healthy, true);
  assert.deepEqual(transport.principal, {
    kind: "gh_user",
    stableId: "91",
    login: "cpb-bot",
  });
  assert.equal(typeof transport.remoteAuthorityValidator, "function");
  assert.equal(typeof transport.remoteCommitVerifier, "function");
  assert.equal(await (transport.getToken as () => Promise<string>)(), boundToken);

  await (transport.postComment as (request: Record<string, unknown>) => Promise<unknown>)({
    repo: "example/cpb-disposable",
    issueNumber: 17,
    body: "bound transport",
  });

  assert.ok(calls.length >= 4);
  assert.ok(calls.every((call) => call.executable === fixture.canonicalExecutable));
  const bootstrap = calls.find((call) => call.args[0] === "auth" && call.args[1] === "token");
  const actor = calls.find((call) => call.args[0] === "api" && call.args[1] === "user");
  const write = calls.find((call) => call.args[0] === "issue" && call.args[1] === "comment");
  assert.ok(bootstrap);
  assert.ok(actor);
  assert.ok(write);
  assert.equal(environment(bootstrap).GH_CONFIG_DIR, fixture.canonicalConfigDir);
  assertSanitizedEnvironment(bootstrap, null);
  assertSanitizedEnvironment(actor, boundToken);
  assertSanitizedEnvironment(write, boundToken);
  assert.notEqual(environment(write).GH_CONFIG_DIR, fixture.canonicalConfigDir);
});

test("GitHub App mode binds authority reads and returned principal to its installation credential", async (t) => {
  const fixture = await transportFixture(t);
  await saveGithubAppConfig(fixture.hubRoot, {
    appId: "101",
    installationId: "202",
    webhookSecretRef: "env:WEBHOOK_SECRET",
    privateKeyRef: "env:APP_PRIVATE_KEY",
  });

  const calls: CapturedCall[] = [];
  const fetches: Array<{ url: string; options: Record<string, unknown> }> = [];
  const token = "ghs_installation_transport_token";
  let tokenReads = 0;
  const execute = async (executable: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ executable, args: [...args], options });
    if (args[0] === "--version") return { stdout: "gh version 2.80.0\n", stderr: "" };
    if (args[0] === "repo") {
      return {
        stdout: JSON.stringify({
          id: "R_disposable",
          nameWithOwner: "example/cpb-disposable",
          defaultBranchRef: { name: "main" },
        }),
        stderr: "",
      };
    }
    if (args[0] === "api" && String(args[1]).includes("/contents/")) {
      return {
        stdout: JSON.stringify({
          path: ".cpb-disposable-target.json",
          sha: "a".repeat(40),
          content: Buffer.from(JSON.stringify(disposableMarker()), "utf8").toString("base64"),
        }),
        stderr: "",
      };
    }
    if (args[0] === "issue" && args[1] === "view") {
      return {
        stdout: JSON.stringify({
          number: 17,
          state: "OPEN",
          labels: [{ name: "cpb-e2e" }],
          url: "https://github.com/example/cpb-disposable/issues/17",
        }),
        stderr: "",
      };
    }
    throw new Error(`unexpected gh command: ${args.join(" ")}`);
  };

  const transport = await resolveGithubTransport(fixture.hubRoot, {
    env: {
      APP_PRIVATE_KEY: "test-private-key-material",
      GH_TOKEN: "ambient-token",
      HTTPS_PROXY: "https://attacker.invalid",
      SSL_CERT_FILE: "/tmp/attacker.pem",
    },
    execFile: execute,
    ghExecutable: fixture.executable,
    getAppJwtFn: async () => "jwt_app_identity_token",
    fetchJsonFn: async (url, options = {}) => {
      fetches.push({ url, options });
      if (url.endsWith("/app")) return { id: 101, slug: "cpb-app" };
      if (url.endsWith("/installation")) {
        return { id: 202, app_id: 101, app_slug: "cpb-app" };
      }
      if (url.endsWith("/users/cpb-app%5Bbot%5D")) {
        return { id: 901, login: "cpb-app[bot]", type: "Bot" };
      }
      throw new Error(`unexpected GitHub API read: ${url}`);
    },
    getInstallationTokenFn: async () => {
      tokenReads += 1;
      return token;
    },
  });

  assert.equal(transport.mode, "api");
  assert.equal(transport.healthy, true);
  assert.deepEqual(transport.principal, {
    kind: "github_app",
    stableId: "202",
    login: "cpb-app[bot]",
    authorId: "901",
  });
  assert.equal(await (transport.getToken as () => Promise<string>)(), token);

  const authority = await (transport.remoteAuthorityValidator as (
    request: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>)({
    capability: remoteCapability(),
    operation: "issue.close",
    repository: "example/cpb-disposable",
    issueNumber: 17,
  });
  assert.deepEqual(authority.principal, transport.principal);
  assert.ok(tokenReads >= 6);
  assert.equal(fetches.length, 3);
  assert.equal((fetches[0].options.headers as Record<string, string>).Authorization, "Bearer jwt_app_identity_token");
  assert.equal((fetches[1].options.headers as Record<string, string>).Authorization, `Bearer ${token}`);
  assert.equal((fetches[2].options.headers as Record<string, string>).Authorization, `Bearer ${token}`);

  const remoteReads = calls.filter((call) => call.args[0] !== "--version");
  assert.equal(remoteReads.length, 3);
  assert.ok(remoteReads.every((call) => call.executable === fixture.canonicalExecutable));
  for (const call of remoteReads) assertSanitizedEnvironment(call, token);
});

test("relative gh executable input is never resolved through ambient PATH", async (t) => {
  const fixture = await transportFixture(t);
  let executed = false;
  const transport = await resolveGithubTransport(fixture.hubRoot, {
    ghExecutable: "gh",
    execFile: async () => {
      executed = true;
      return { stdout: "" };
    },
  });

  assert.equal(transport.mode, "unavailable");
  assert.equal(transport.healthy, false);
  assert.equal(transport.principal, null);
  assert.equal(executed, false);
});

test("configured App mode fails closed when its exact bot identity cannot be bound", async (t) => {
  const fixture = await transportFixture(t);
  await saveGithubAppConfig(fixture.hubRoot, {
    appId: "101",
    installationId: "202",
    webhookSecretRef: "env:WEBHOOK_SECRET",
    privateKeyRef: "env:APP_PRIVATE_KEY",
  });
  const argsSeen: string[][] = [];
  const transport = await resolveGithubTransport(fixture.hubRoot, {
    env: { APP_PRIVATE_KEY: "test-private-key-material" },
    ghExecutable: fixture.executable,
    ghHomeDir: fixture.homeDir,
    ghConfigDir: fixture.configDir,
    getAppJwtFn: async () => "jwt_app_identity_token",
    getInstallationTokenFn: async () => "ghs_installation_transport_token",
    fetchJsonFn: async (url) => {
      if (url.endsWith("/app")) return { id: 999, slug: "different-app" };
      throw new Error(`unexpected GitHub API read: ${url}`);
    },
    execFile: async (_executable, args) => {
      argsSeen.push([...args]);
      if (args[0] === "--version") return { stdout: "gh version 2.80.0\n" };
      if (args[0] === "auth" && args[1] === "token") {
        throw new Error("must not downgrade an App transport to a gh user");
      }
      throw new Error(`unexpected gh command: ${args.join(" ")}`);
    },
  });

  assert.equal(transport.mode, "unavailable");
  assert.equal(transport.healthy, false);
  assert.equal(transport.principal, null);
  assert.equal(argsSeen.some((args) => args[0] === "auth" && args[1] === "token"), false);
});
