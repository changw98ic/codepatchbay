import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertValidSetupAgentCatalog, validateSetupAgentManifest } from "./manifest-schema.js";
const BUILTIN_MANIFEST_DIR = path.join(import.meta.dirname, "manifests");
const BUILTIN_ORDER = new Map([
    ["codex", 10],
    ["claude", 20],
    ["opencode", 30],
    ["cursor", 40],
    ["reasonix", 50],
]);
function clone(value) {
    return JSON.parse(JSON.stringify(value));
}
function orderFor(agent) {
    return BUILTIN_ORDER.get(agent.id) ?? 1000;
}
function sortCatalog(agents) {
    return [...agents].sort((a, b) => {
        const byOrder = orderFor(a) - orderFor(b);
        return byOrder || a.id.localeCompare(b.id);
    });
}
function failOrSkip(error, strict) {
    if (strict)
        throw error;
    return null;
}
export function loadSetupAgentCatalog({ manifestDir = BUILTIN_MANIFEST_DIR, strict = false } = {}) {
    let files;
    try {
        files = readdirSync(manifestDir, { withFileTypes: true });
    }
    catch (error) {
        if (error?.code === "ENOENT" && !strict)
            return [];
        throw error;
    }
    const agents = [];
    for (const entry of files) {
        if (!entry.isFile() || !entry.name.endsWith(".json"))
            continue;
        const file = path.join(manifestDir, entry.name);
        let manifest;
        try {
            manifest = JSON.parse(readFileSync(file, "utf8"));
        }
        catch (error) {
            failOrSkip(new Error(`Invalid setup agent manifest JSON ${entry.name}: ${error.message}`), strict);
            continue;
        }
        const validation = validateSetupAgentManifest(manifest);
        if (!validation.valid) {
            failOrSkip(new Error(`Invalid setup agent manifest ${entry.name}: ${validation.errors.join("; ")}`), strict);
            continue;
        }
        agents.push(manifest);
    }
    return clone(sortCatalog(agents));
}
export function listSetupAgents({ includeOptional = true } = {}) {
    const agents = loadSetupAgentCatalog({ strict: true });
    assertValidSetupAgentCatalog(agents);
    return includeOptional ? agents : agents.filter((agent) => agent.recommended);
}
export function getSetupAgent(id) {
    const agents = loadSetupAgentCatalog({ strict: true });
    assertValidSetupAgentCatalog(agents);
    const agent = agents.find((entry) => entry.id === id);
    return agent ? clone(agent) : null;
}
