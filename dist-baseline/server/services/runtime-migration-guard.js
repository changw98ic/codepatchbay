import { readdir, stat } from "node:fs/promises";
import path from "node:path";
const IGNORED_LEGACY_ENTRIES = new Set([".DS_Store", ".gitignore"]);
async function collectMeaningfulFiles(dir, base = dir, limit = 25) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch (err) {
        if (err && err.code === "ENOENT")
            return [];
        throw err;
    }
    const files = [];
    for (const entry of entries) {
        if (IGNORED_LEGACY_ENTRIES.has(entry.name))
            continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await collectMeaningfulFiles(fullPath, base, limit - files.length));
        }
        else if (entry.isFile() || entry.isSymbolicLink()) {
            files.push(path.relative(base, fullPath));
        }
        else {
            files.push(path.relative(base, fullPath));
        }
        if (files.length >= limit)
            break;
    }
    return files;
}
export function legacyRuntimeRoot(cpbRoot) {
    return path.join(path.resolve(cpbRoot), "cpb-task");
}
export async function listLegacyRuntimeData(cpbRoot) {
    const root = legacyRuntimeRoot(cpbRoot);
    try {
        const info = await stat(root);
        if (!info.isDirectory())
            return [];
    }
    catch (err) {
        if (err && err.code === "ENOENT")
            return [];
        throw err;
    }
    return collectMeaningfulFiles(root);
}
export async function hasLegacyRuntimeData(cpbRoot) {
    return (await listLegacyRuntimeData(cpbRoot)).length > 0;
}
export async function assertNoLegacyRuntimeData(cpbRoot) {
    const entries = await listLegacyRuntimeData(cpbRoot);
    if (entries.length === 0)
        return;
    const root = legacyRuntimeRoot(cpbRoot);
    const examples = entries.slice(0, 5).map((entry) => `cpb-task/${entry}`).join(", ");
    throw new Error(`legacy runtime data remains under ${root}. ` +
        `Run cpb migrate-runtime-root --execute before starting CodePatchBay. ` +
        `Examples: ${examples}`);
}
