import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getDescriptor, loadRegistry } from "../core/agents/registry.js";
import {
  applyProviderEnvironment,
  providerKeyForSelection,
} from "../core/agents/provider-config.js";
import {
  configuredProviderEnvironmentKeys,
  ensureProviderCatalog,
  providerCatalogPath,
} from "../core/agents/provider-catalog.js";
import { envForAgent } from "../server/services/acp/acp-pool.js";
import { buildChildEnv } from "../core/policy/child-env.js";
import {
  mergeAgentConfig,
  readProjectConfig,
  resolveAgentsForEntry,
  writeProjectJson,
} from "../server/services/agent/agent-config.js";

test("providers.json maps a project-selected provider and model onto the agent transport", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-global-provider-"));
  const providersFile = path.join(root, "providers.json");
  try {
    await loadRegistry(path.join(root, "empty-agents"));
    await writeFile(providersFile, `${JSON.stringify({
      providers: {
        glm: {
          agent: "claude",
          key: "glm",
          family: "glm",
          baseUrlEnv: "GLM_BASE_URL",
          apiKeyEnv: "GLM_API_KEY",
          modelEnv: "GLM_MODEL",
        },
      },
    }, null, 2)}\n`, "utf8");

    const input: Record<string, string | undefined> = {
      CPB_PROVIDERS_FILE: providersFile,
      GLM_BASE_URL: "https://glm.example.invalid/anthropic",
      GLM_API_KEY: "not-a-real-secret",
      GLM_MODEL: "glm-default",
    };
    const descriptor = getDescriptor("claude");
    assert.ok(descriptor);
    const resolved = applyProviderEnvironment(input, "claude", descriptor, {
      provider: "glm",
      model: "glm-project-model",
    });

    assert.equal(providerCatalogPath(input), providersFile);
    assert.equal(resolved.providerKey, "glm");
    assert.equal(resolved.provider, "glm");
    assert.equal(resolved.model, "glm-project-model");
    assert.equal(input.ANTHROPIC_BASE_URL, "https://glm.example.invalid/anthropic");
    assert.equal(input.ANTHROPIC_API_KEY, "not-a-real-secret");
    assert.equal(input.ANTHROPIC_AUTH_TOKEN, "not-a-real-secret");
    assert.equal(input.ANTHROPIC_MODEL, "glm-project-model");
    assert.equal(providerKeyForSelection("claude", descriptor, "glm", null, "glm-project-model", input), "glm");

    const poolEnvironment = envForAgent("claude", input, null, "glm", "glm-pool-model");
    assert.equal(poolEnvironment.CPB_PROVIDER, "glm");
    assert.equal(poolEnvironment.CPB_MODEL, "glm-pool-model");
    assert.equal(poolEnvironment.ANTHROPIC_MODEL, "glm-pool-model");
    const child = buildChildEnv(poolEnvironment, {}, { agent: "claude", provider: "glm", model: "glm-pool-model" });
    assert.equal(child.GLM_API_KEY, "not-a-real-secret");
    assert.equal(child.ANTHROPIC_API_KEY, "not-a-real-secret");

    const keys = configuredProviderEnvironmentKeys(input);
    assert.ok(keys.has("GLM_API_KEY"));
    assert.ok(keys.has("ANTHROPIC_AUTH_TOKEN"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("providers.json rejects a project agent that does not match the configured provider transport", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-provider-agent-mismatch-"));
  const providersFile = path.join(root, "providers.json");
  try {
    await writeFile(providersFile, `${JSON.stringify({
      providers: {
        glm: {
          agent: "claude-glm",
          key: "glm",
          family: "glm",
        },
      },
    })}\n`, "utf8");
    assert.throws(
      () => applyProviderEnvironment(
        { CPB_PROVIDERS_FILE: providersFile },
        "claude",
        getDescriptor("claude"),
        { provider: "glm", model: "glm-project-model" },
      ),
      /requires agent 'claude-glm', got 'claude'/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the global provider catalog is created empty without overwriting user configuration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-provider-catalog-"));
  const file = path.join(root, "nested", "providers.json");
  try {
    assert.equal(await ensureProviderCatalog({ CPB_PROVIDERS_FILE: file }), file);
    assert.equal(JSON.parse(await readFile(file, "utf8")).providers.constructor, Object);
    await writeFile(file, '{"providers":{"custom":{"family":"custom"}}}\n', "utf8");
    assert.equal(await ensureProviderCatalog({ CPB_PROVIDERS_FILE: file }), file);
    assert.equal(JSON.parse(await readFile(file, "utf8")).providers.custom.family, "custom");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project.json is canonical under <cpb-home>/<project> and carries agent/provider/model", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-project-config-"));
  const runtimeRoot = path.join(root, "hub", "projects", "demo");
  try {
    await mkdir(path.join(runtimeRoot, "wiki"), { recursive: true });
    await writeFile(
      path.join(runtimeRoot, "wiki", "project.json"),
      `${JSON.stringify({ sourcePath: "/tmp/demo", name: "demo" })}\n`,
      "utf8",
    );
    await writeProjectJson(runtimeRoot, "demo", {
      sourcePath: "/tmp/demo",
      name: "demo",
      agent: "claude",
      provider: "glm",
      model: "glm-project-model",
    });

    const canonical = path.join(root, "hub", "demo", "project.json");
    const stored = JSON.parse(await readFile(canonical, "utf8"));
    assert.equal(stored.agent, "claude");
    assert.equal(stored.provider, "glm");
    assert.equal(stored.model, "glm-project-model");

    const projectAgents = await readProjectConfig(runtimeRoot, "demo");
    assert.deepEqual(projectAgents?.default, {
      agent: "claude",
      provider: "glm",
      model: "glm-project-model",
      variant: null,
    });

    const merged = mergeAgentConfig(null, projectAgents, null);
    assert.deepEqual(merged.executor, projectAgents?.default);
    assert.deepEqual(merged.verifier, projectAgents?.default);
  } finally {
    await rm(root, { recursive: true, force: true });
    await loadRegistry(undefined);
  }
});

test("queue-entry agent resolution carries the canonical project selection into every role", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-entry-agent-config-"));
  const hubRoot = path.join(root, "hub");
  const runtimeRoot = path.join(hubRoot, "projects", "demo");
  try {
    await mkdir(hubRoot, { recursive: true });
    await writeFile(path.join(hubRoot, "projects.json"), `${JSON.stringify({
      version: 1,
      revision: 0,
      projects: {
        demo: {
          id: "demo",
          sourcePath: "/tmp/demo",
          projectRuntimeRoot: runtimeRoot,
        },
      },
      projectRevisions: {},
      mutationId: null,
    })}\n`, "utf8");
    await writeProjectJson(runtimeRoot, "demo", {
      sourcePath: "/tmp/demo",
      name: "demo",
      agent: "claude",
      provider: "glm",
      model: "glm-project-model",
    });

    const resolved = await resolveAgentsForEntry(hubRoot, root, "demo", {});
    const agents = resolved.agents as Record<string, Record<string, unknown>>;
    assert.equal(agents.planner?.agent, "claude");
    assert.equal(agents.executor?.provider, "glm");
    assert.equal(agents.verifier?.model, "glm-project-model");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("queue-entry agent resolution preserves role-specific project provider and model selections", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-entry-role-agent-config-"));
  const hubRoot = path.join(root, "hub");
  const runtimeRoot = path.join(hubRoot, "projects", "demo");
  try {
    await mkdir(hubRoot, { recursive: true });
    await writeFile(path.join(hubRoot, "projects.json"), `${JSON.stringify({
      version: 1,
      revision: 0,
      projects: {
        demo: {
          id: "demo",
          sourcePath: "/tmp/demo",
          projectRuntimeRoot: runtimeRoot,
        },
      },
      projectRevisions: {},
      mutationId: null,
    })}\n`, "utf8");
    await writeProjectJson(runtimeRoot, "demo", {
      agents: {
        planner: { agent: "claude-glm", provider: "glm", model: "glm-5.2" },
        executor: { agent: "claude-glm", provider: "glm", model: "glm-5.2" },
        verifier: { agent: "claude-mimo", provider: "mimo", model: "mimo-v2.5-pro" },
        adversarial_verifier: { agent: "claude-mimo", provider: "mimo", model: "mimo-v2.5-pro" },
      },
    });

    const resolved = await resolveAgentsForEntry(hubRoot, root, "demo", {});
    const agents = resolved.agents as Record<string, Record<string, unknown>>;
    assert.equal(agents.planner.agent, "claude-glm");
    assert.equal(agents.executor.provider, "glm");
    assert.equal(agents.verifier.model, "mimo-v2.5-pro");
    assert.equal(agents.adversarial_verifier.provider, "mimo");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
