import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe, beforeEach, afterEach } from "node:test";

import {
  classifyProject,
  filterVisibleProjects,
  scanHubPollution,
} from "../server/services/project-pollution.js";

describe("classifyProject", () => {
  test("production project has visibility=production", () => {
    const project = { id: "my-app", name: "My App", sourcePath: "/home/user/projects/my-app" };
    const result = classifyProject(project);
    assert.equal(result.visibility, "production");
    assert.equal(result.reasons.length, 0);
  });

  test("metadata.visibility=test is classified as test", () => {
    const project = { id: "app", metadata: { visibility: "test" } };
    const result = classifyProject(project);
    assert.equal(result.visibility, "test");
    assert.ok(result.reasons.includes("metadata.visibility=test"));
  });

  test("metadata.visibility=fixture is classified as test", () => {
    const project = { id: "app", metadata: { visibility: "fixture" } };
    const result = classifyProject(project);
    assert.equal(result.visibility, "test");
  });

  test("metadata.visibility=generated is classified as test", () => {
    const project = { id: "app", metadata: { visibility: "generated" } };
    const result = classifyProject(project);
    assert.equal(result.visibility, "test");
  });

  test("metadata.test=true is classified as test", () => {
    const project = { id: "app", metadata: { test: true } };
    const result = classifyProject(project);
    assert.equal(result.visibility, "test");
    assert.ok(result.reasons.includes("metadata.test=true"));
  });

  test("metadata.fixture=true is classified as test", () => {
    const project = { id: "app", metadata: { fixture: true } };
    const result = classifyProject(project);
    assert.equal(result.visibility, "test");
  });

  test("metadata.generated=true is classified as test", () => {
    const project = { id: "app", metadata: { generated: true } };
    const result = classifyProject(project);
    assert.equal(result.visibility, "test");
  });

  test("metadata.generatedBy string is classified as test", () => {
    const project = { id: "app", metadata: { generatedBy: "node:test" } };
    const result = classifyProject(project);
    assert.equal(result.visibility, "test");
    assert.ok(result.reasons[0].includes("generatedBy=node:test"));
  });

  test("fake-repo name is classified as test", () => {
    const project = { id: "fake-repo", name: "fake-repo", sourcePath: "/home/user/repo" };
    const result = classifyProject(project);
    assert.equal(result.visibility, "test");
    assert.ok(result.reasons.includes("fake-repo name"));
  });

  test("fake-repo contained in name is classified as test", () => {
    const project = { id: "my-fake-repo-thing", name: "my-fake-repo-thing", sourcePath: "/home/user/repo" };
    const result = classifyProject(project);
    assert.equal(result.visibility, "test");
    assert.ok(result.reasons.includes("fake-repo name"));
  });

  test("polluted name is caught when id is clean", () => {
    const project = { id: "clean-id", name: "fake-repo", sourcePath: "/home/user/repo" };
    const result = classifyProject(project);
    assert.equal(result.visibility, "test");
    assert.ok(result.reasons.includes("fake-repo name"));
  });

  test("polluted id is caught when name is clean", () => {
    const project = { id: "exec-123", name: "My Production App", sourcePath: "/home/user/repo" };
    const result = classifyProject(project);
    assert.equal(result.visibility, "test");
    assert.ok(result.reasons.includes("exec-prefix name"));
  });

  test("name ending in -test is classified as test", () => {
    const project = { id: "app-test", name: "app-test", sourcePath: "/home/user/repo" };
    const result = classifyProject(project);
    assert.equal(result.visibility, "test");
    assert.ok(result.reasons.includes("test-suffix name"));
  });

  test("name starting with exec- is classified as test", () => {
    const project = { id: "exec-123", name: "exec-123", sourcePath: "/home/user/repo" };
    const result = classifyProject(project);
    assert.equal(result.visibility, "test");
    assert.ok(result.reasons.includes("exec-prefix name"));
  });

  test("tmpdir sourcePath is classified as test", () => {
    const project = { id: "myapp", sourcePath: path.join(tmpdir(), "some-dir") };
    const result = classifyProject(project);
    assert.equal(result.visibility, "test");
    assert.ok(result.reasons.some((r) => r.includes("sourcePath under tmpdir")));
  });

  test("tmpdir projectRuntimeRoot is classified as test", () => {
    const project = {
      id: "myapp",
      sourcePath: "/home/user/repo",
      projectRuntimeRoot: path.join(tmpdir(), "cpb-runtime"),
    };
    const result = classifyProject(project);
    assert.equal(result.visibility, "test");
    assert.ok(result.reasons.some((r) => r.includes("projectRuntimeRoot under tmpdir")));
  });
});

describe("filterVisibleProjects", () => {
  test("filters test projects by default", () => {
    const projects = [
      { id: "prod-app", sourcePath: "/home/user/prod" },
      { id: "fake-repo", sourcePath: "/home/user/fake" },
      { id: "app-test", sourcePath: "/home/user/test" },
    ];
    const visible = filterVisibleProjects(projects);
    assert.equal(visible.length, 1);
    assert.equal(visible[0].id, "prod-app");
  });

  test("includes test projects when includeTest=true", () => {
    const projects = [
      { id: "prod-app", sourcePath: "/home/user/prod" },
      { id: "fake-repo", sourcePath: "/home/user/fake" },
    ];
    const visible = filterVisibleProjects(projects, { includeTest: true });
    assert.equal(visible.length, 2);
  });

  test("filters projects with tmpdir sourcePath even with clean names", () => {
    const projects = [
      { id: "prod-app", sourcePath: "/home/user/prod" },
      { id: "tmp-project", sourcePath: path.join(tmpdir(), "cpb-some-dir") },
    ];
    const visible = filterVisibleProjects(projects);
    assert.equal(visible.length, 1);
    assert.equal(visible[0].id, "prod-app");
  });

  test("filters projects with tmpdir projectRuntimeRoot even with clean names", () => {
    const projects = [
      { id: "prod-app", sourcePath: "/home/user/prod" },
      { id: "tmp-runtime", sourcePath: "/home/user/repo", projectRuntimeRoot: path.join(tmpdir(), "cpb-runtime") },
    ];
    const visible = filterVisibleProjects(projects);
    assert.equal(visible.length, 1);
    assert.equal(visible[0].id, "prod-app");
  });

  test("returns empty array for empty input", () => {
    const visible = filterVisibleProjects([]);
    assert.equal(visible.length, 0);
  });
});

describe("scanHubPollution", () => {
  let hubRoot;

  beforeEach(async () => {
    hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-poll-hub-"));
  });

  afterEach(async () => {
    await rm(hubRoot, { recursive: true, force: true });
  });

  test("returns empty for clean registry", async () => {
    const result = await scanHubPollution(hubRoot);
    assert.equal(result.candidates.length, 0);
    assert.equal(result.orphanRuntimeDirs.length, 0);
  });

  test("detects fake-repo project in registry", async () => {
    const registry = {
      version: 1,
      updatedAt: new Date().toISOString(),
      projects: {
        "fake-repo": {
          id: "fake-repo",
          sourcePath: "/home/user/fake",
        },
        "real-app": {
          id: "real-app",
          sourcePath: "/home/user/real",
        },
      },
    };
    await writeFile(path.join(hubRoot, "projects.json"), JSON.stringify(registry) + "\n", "utf8");

    const result = await scanHubPollution(hubRoot);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].projectId, "fake-repo");
  });

  test("detects orphan runtime directories", async () => {
    const registry = {
      version: 1,
      updatedAt: new Date().toISOString(),
      projects: {
        "real-app": {
          id: "real-app",
          sourcePath: "/home/user/real",
        },
      },
    };
    await writeFile(path.join(hubRoot, "projects.json"), JSON.stringify(registry) + "\n", "utf8");
    await mkdir(path.join(hubRoot, "projects", "orphan-dir"), { recursive: true });
    await mkdir(path.join(hubRoot, "projects", "real-app"), { recursive: true });

    const result = await scanHubPollution(hubRoot);
    assert.equal(result.orphanRuntimeDirs.length, 1);
    assert.equal(result.orphanRuntimeDirs[0].projectId, "orphan-dir");
  });
});
