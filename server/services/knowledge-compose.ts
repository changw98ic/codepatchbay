import fs from "node:fs/promises";
import path from "node:path";

import {
  PROMPT_COMPOSITION_ORDER,
} from "./knowledge-policy.js";
import { isSecretPath, notifySecretBlocked } from "./secret-policy.js";

async function readFileOrNull(filePath, onSecretBlocked) {
  if (isSecretPath(filePath)) {
    notifySecretBlocked(onSecretBlocked, filePath, "secret path read blocked");
    return null;
  }
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function writePolicyForLayer(layerName) {
  const explicit = new Set(["global-soul-profile", "global-provider-runtime-policy"]);
  if (explicit.has(layerName)) return "explicit-confirmation";
  const semi = new Set(["project-memory", "project-wiki-excerpts", "project-context"]);
  if (semi.has(layerName)) return "semi-automatic";
  if (layerName === "session-memory") return "automatic";
  if (layerName === "current-task") return "automatic";
  return "unknown";
}

async function resolveLayerContent(layerName, { hubRoot, sourcePath, sessionId, profile, task, onSecretBlocked }) {
  const hub = path.resolve(hubRoot);
  const src = path.resolve(sourcePath);

  switch (layerName) {
    case "global-soul-profile": {
      const soulPath = path.join(hub, "profiles", profile || "default", "soul.md");
      return { content: await readFileOrNull(soulPath, onSecretBlocked), source: "file" };
    }
    case "global-provider-runtime-policy": {
      const policyPath = path.join(hub, "providers", "policy.md");
      return { content: await readFileOrNull(policyPath, onSecretBlocked), source: "file" };
    }
    case "project-context": {
      const ctxPath = path.join(src, ".cpb", "context.md");
      return { content: await readFileOrNull(ctxPath, onSecretBlocked), source: "file" };
    }
    case "project-wiki-excerpts": {
      const wikiFiles = ["overview.md", "architecture.md", "conventions.md", "workflows.md"];
      const parts = [];
      for (const f of wikiFiles) {
        const c = await readFileOrNull(path.join(src, ".cpb", "wiki", f), onSecretBlocked);
        if (c) parts.push(`### ${f}\n${c}`);
      }
      return { content: parts.length ? parts.join("\n\n") : null, source: "file" };
    }
    case "project-memory": {
      const memPath = path.join(src, ".cpb", "memory.md");
      return { content: await readFileOrNull(memPath, onSecretBlocked), source: "file" };
    }
    case "session-memory": {
      const sessMemPath = path.join(src, "cpb-task", "sessions", sessionId, "memory.md");
      return { content: await readFileOrNull(sessMemPath, onSecretBlocked), source: "file" };
    }
    case "current-task": {
      return { content: task || null, source: "inline" };
    }
    default:
      return { content: null, source: "unknown" };
  }
}

export async function composePromptContext({ hubRoot, sourcePath, sessionId, task, profile, onSecretBlocked }: Record<string, any> = {}) {
  const layers = [];

  for (const layerName of PROMPT_COMPOSITION_ORDER) {
    const { content, source } = await resolveLayerContent(layerName, {
      hubRoot,
      sourcePath,
      sessionId,
      task,
      profile,
      onSecretBlocked,
    });
    layers.push({
      name: layerName,
      content,
      source,
      writePolicy: writePolicyForLayer(layerName),
    });
  }

  const assembled = layers
    .filter((l) => l.content !== null)
    .map((l) => `## ${l.name}\n${l.content}`)
    .join("\n\n");

  return { layers, assembled };
}
