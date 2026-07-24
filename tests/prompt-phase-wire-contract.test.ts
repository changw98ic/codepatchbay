import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  parseParentPlanCacheJson,
  parseSourceContextJson,
} from "../server/services/prompt/prompt-builder.js";
import {
  normalizePhaseEnv,
  parentPlanRecordPath,
  readParentPlanRecord,
} from "../server/services/phase-runner.js";

const temporaryRoots = new Set<string>();

async function temporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-wire-contract-"));
  temporaryRoots.add(root);
  return root;
}

afterEach(async () => {
  await Promise.all([...temporaryRoots].map((root) => rm(root, { recursive: true, force: true })));
  temporaryRoots.clear();
});

describe("prompt JSON wire contracts", () => {
  it("accepts a valid parent-plan cache envelope and rejects malformed or partial envelopes", () => {
    assert.deepEqual(
      parseParentPlanCacheJson(JSON.stringify({
        planGroupId: "plan-group-123456789abc",
        planCacheKey: "1234567890abcdef",
        cacheHit: false,
      })),
      {
        planGroupId: "plan-group-123456789abc",
        planCacheKey: "1234567890abcdef",
        cacheHit: false,
      },
    );
    assert.equal(parseParentPlanCacheJson(undefined), null);
    assert.throws(() => parseParentPlanCacheJson("{broken"), /CPB_PARENT_PLAN_CACHE_JSON.*valid JSON/i);
    assert.throws(() => parseParentPlanCacheJson("[]"), /CPB_PARENT_PLAN_CACHE_JSON.*object/i);
    assert.throws(
      () => parseParentPlanCacheJson(JSON.stringify({ planGroupId: "plan-group-x", cacheHit: true })),
      /CPB_PARENT_PLAN_CACHE_JSON.*planCacheKey/i,
    );
    assert.throws(
      () => parseParentPlanCacheJson(JSON.stringify({
        planGroupId: "plan-group-x",
        planCacheKey: "cache-key",
        cacheHit: "yes",
      })),
      /CPB_PARENT_PLAN_CACHE_JSON.*cacheHit/i,
    );
  });

  it("accepts source context objects and rejects malformed context-pack locators", () => {
    assert.deepEqual(
      parseSourceContextJson(JSON.stringify({
        repo: "openai/codepatchbay",
        contextPack: { path: "/runtime/context-pack.json" },
      })),
      {
        repo: "openai/codepatchbay",
        contextPack: { path: "/runtime/context-pack.json" },
      },
    );
    assert.equal(parseSourceContextJson(undefined), null);
    assert.throws(() => parseSourceContextJson("null"), /CPB_SOURCE_CONTEXT_JSON.*object/i);
    assert.throws(
      () => parseSourceContextJson(JSON.stringify({ contextPack: { path: 42 } })),
      /CPB_SOURCE_CONTEXT_JSON.*contextPack\.path/i,
    );
    assert.throws(
      () => parseSourceContextJson(JSON.stringify({ contextPackPath: "" })),
      /CPB_SOURCE_CONTEXT_JSON.*contextPackPath/i,
    );
  });
});

describe("phase runner wire contracts", () => {
  it("copies string-valued phase environments and rejects invalid values instead of coercing them", () => {
    const fallback = { CPB_FALLBACK: "1" };
    assert.deepEqual(normalizePhaseEnv(undefined, fallback), fallback);
    assert.notEqual(normalizePhaseEnv(undefined, fallback), fallback);
    assert.deepEqual(normalizePhaseEnv({ CPB_MODE: "strict", EMPTY: "" }), {
      CPB_MODE: "strict",
      EMPTY: "",
    });
    assert.throws(() => normalizePhaseEnv(null, fallback), /phase environment.*object/i);
    assert.throws(() => normalizePhaseEnv(["CPB_MODE=strict"], fallback), /phase environment.*object/i);
    assert.throws(
      () => normalizePhaseEnv({ CPB_RETRY_COUNT: 2 }, fallback),
      /phase environment.*CPB_RETRY_COUNT.*string/i,
    );
  });

  it("rejects structurally invalid or mismatched parent-plan cache records", async () => {
    const dataRoot = await temporaryRoot();
    const project = "flow";
    const planCacheKey = "1234567890abcdef";
    assert.throws(
      () => parentPlanRecordPath("/unused", project, "../escape", { dataRoot }),
      /parent plan cache record.*planCacheKey.*safe identifier/i,
    );
    assert.throws(
      () => parentPlanRecordPath("/unused", "../escape", planCacheKey, { dataRoot }),
      /parent plan cache record.*project.*safe identifier/i,
    );
    const cachePath = parentPlanRecordPath("/unused", project, planCacheKey, { dataRoot });
    await mkdir(path.dirname(cachePath), { recursive: true });

    const validRecord = {
      schemaVersion: 1,
      source: "parent_plan_cache",
      project,
      task: "Tighten dynamic contracts",
      planGroupId: "plan-group-123456789abc",
      planCacheKey,
      parentPlanId: "parent-1",
      planId: "parent-1",
      planArtifact: "plan-parent-1",
      planArtifactPath: path.join(dataRoot, "wiki", "inbox", "plan-parent-1.md"),
      mergedPlanIds: ["parent-1"],
      payload: { project, task: "Tighten dynamic contracts" },
      updatedAt: "2026-07-20T00:00:00.000Z",
    };

    await writeFile(cachePath, `${JSON.stringify(validRecord)}\n`, "utf8");
    assert.deepEqual(
      await readParentPlanRecord("/unused", project, planCacheKey, { dataRoot }),
      validRecord,
    );

    await writeFile(cachePath, `${JSON.stringify({ ...validRecord, project: "other" })}\n`, "utf8");
    await assert.rejects(
      readParentPlanRecord("/unused", project, planCacheKey, { dataRoot }),
      /parent plan cache record.*project/i,
    );

    await writeFile(cachePath, `${JSON.stringify({ ...validRecord, planId: "../../escape" })}\n`, "utf8");
    await assert.rejects(
      readParentPlanRecord("/unused", project, planCacheKey, { dataRoot }),
      /parent plan cache record.*planId/i,
    );

    await writeFile(cachePath, "[]\n", "utf8");
    await assert.rejects(
      readParentPlanRecord("/unused", project, planCacheKey, { dataRoot }),
      /parent plan cache record.*object/i,
    );
  });
});
