#!/usr/bin/env node
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { composePromptContext } from "../server/services/prompt/prompt-resources.js";
import { findPromotionCandidates, resolveKnowledgePath, } from "../server/services/knowledge/knowledge.js";
import { ensureKnowledgePaths, initSessionPaths, sessionPath, } from "../server/services/knowledge/knowledge.js";
async function pathExists(filePath) {
    try {
        await stat(filePath);
        return true;
    }
    catch {
        return false;
    }
}
test("session knowledge paths resolve and initialize under explicit runtime root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cpb-knowledge-session-"));
    const sourcePath = path.join(root, "source");
    const dataRoot = path.join(root, "runtime");
    await mkdir(sourcePath, { recursive: true });
    assert.equal(sessionPath(sourcePath, "sess-001", { dataRoot }), path.join(dataRoot, "sessions", "sess-001"));
    await initSessionPaths(sourcePath, "sess-001", { dataRoot });
    await ensureKnowledgePaths(sourcePath, "sess-002", { projectRuntimeRoot: dataRoot });
    assert.equal(await pathExists(path.join(dataRoot, "sessions", "sess-001")), true);
    assert.equal(await pathExists(path.join(dataRoot, "sessions", "sess-002")), true);
    assert.equal(await pathExists(path.join(sourcePath, ".cpb", "wiki")), true);
    assert.equal(await pathExists(path.join(sourcePath, ".cpb", "memory.md")), false);
    assert.equal(await pathExists(path.join(sourcePath, "cpb-task")), false);
});
test("session knowledge paths fail closed without runtime root and reject unsafe session ids", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cpb-knowledge-session-"));
    const sourcePath = path.join(root, "source");
    await mkdir(sourcePath, { recursive: true });
    assert.throws(() => sessionPath(sourcePath, "sess-001"), /projectRuntimeRoot or dataRoot is required/);
    await assert.rejects(initSessionPaths(sourcePath, "sess-001"), /projectRuntimeRoot or dataRoot is required/);
    await assert.rejects(ensureKnowledgePaths(sourcePath, "../escape", { dataRoot: path.join(root, "runtime") }), /invalid sessionId/);
    assert.throws(() => sessionPath(sourcePath, "bad/session", { dataRoot: path.join(root, "runtime") }), /invalid sessionId/);
    assert.equal(await pathExists(path.join(sourcePath, "cpb-task")), false);
});
test("resolveKnowledgePath writes session files under runtime root only", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cpb-knowledge-session-"));
    const sourcePath = path.join(root, "source");
    const dataRoot = path.join(root, "runtime");
    await mkdir(sourcePath, { recursive: true });
    assert.equal(resolveKnowledgePath({
        sourcePath,
        dataRoot,
        kind: "session-memory",
        sessionId: "sess-001",
        name: "memory",
    }), path.join(dataRoot, "sessions", "sess-001", "memory.md"));
    assert.throws(() => resolveKnowledgePath({ sourcePath, kind: "session-memory", sessionId: "sess-001", name: "memory" }), /projectRuntimeRoot or dataRoot is required/);
    assert.throws(() => resolveKnowledgePath({
        sourcePath,
        dataRoot,
        kind: "session-memory",
        sessionId: "../escape",
        name: "memory",
    }), /invalid sessionId/);
    assert.equal(await pathExists(path.join(sourcePath, "cpb-task")), false);
});
test("session prompt context reads runtime memory and ignores legacy cpb-task", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cpb-knowledge-session-"));
    const hubRoot = path.join(root, "hub");
    const sourcePath = path.join(root, "source");
    const dataRoot = path.join(root, "runtime");
    await mkdir(path.join(dataRoot, "sessions", "sess-001"), { recursive: true });
    await mkdir(path.join(sourcePath, "cpb-task", "sessions", "sess-001"), { recursive: true });
    await writeFile(path.join(dataRoot, "sessions", "sess-001", "memory.md"), "runtime memory\n", "utf8");
    await writeFile(path.join(sourcePath, "cpb-task", "sessions", "sess-001", "memory.md"), "legacy memory\n", "utf8");
    const composed = await composePromptContext({
        hubRoot,
        sourcePath,
        dataRoot,
        sessionId: "sess-001",
        task: "current task",
    });
    const sessionLayer = composed.layers.find((layer) => layer.name === "session-memory");
    assert.equal(sessionLayer?.content, "runtime memory\n");
    assert.match(composed.assembled, /runtime memory/);
    assert.doesNotMatch(composed.assembled, /legacy memory/);
    await assert.rejects(composePromptContext({ hubRoot, sourcePath, sessionId: "sess-001" }), /projectRuntimeRoot or dataRoot is required/);
    await assert.rejects(composePromptContext({ hubRoot, sourcePath, dataRoot, sessionId: "../escape" }), /invalid sessionId/);
});
test("findPromotionCandidates scans runtime sessions and ignores legacy cpb-task", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cpb-knowledge-session-"));
    const sourcePath = path.join(root, "source");
    const dataRoot = path.join(root, "runtime");
    await mkdir(path.join(dataRoot, "sessions", "sess-001"), { recursive: true });
    await mkdir(path.join(dataRoot, "sessions", "sess-002"), { recursive: true });
    await mkdir(path.join(sourcePath, "cpb-task", "sessions", "legacy"), { recursive: true });
    await writeFile(path.join(dataRoot, "sessions", "sess-001", "memory.md"), "runtime one\n", "utf8");
    await writeFile(path.join(dataRoot, "sessions", "sess-002", "memory.md"), "runtime two\n", "utf8");
    await writeFile(path.join(sourcePath, "cpb-task", "sessions", "legacy", "memory.md"), "legacy memory\n", "utf8");
    const candidates = await findPromotionCandidates(sourcePath, { dataRoot, sessionId: "sess-001" });
    assert.equal(candidates.length, 2);
    assert.deepEqual(candidates.map((candidate) => candidate.from).sort(), [
        path.join(dataRoot, "sessions", "sess-001", "memory.md"),
        path.join(dataRoot, "sessions", "sess-002", "memory.md"),
    ]);
    assert.equal(candidates.every((candidate) => !candidate.from.includes("cpb-task")), true);
    await assert.rejects(findPromotionCandidates(sourcePath), /projectRuntimeRoot or dataRoot is required/);
    await assert.rejects(findPromotionCandidates(sourcePath, { dataRoot, sessionId: "../escape" }), /invalid sessionId/);
    assert.equal(await readFile(path.join(sourcePath, "cpb-task", "sessions", "legacy", "memory.md"), "utf8"), "legacy memory\n");
});
