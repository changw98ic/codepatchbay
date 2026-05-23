import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { projectRuntimeRoot } from "./runtime-root.js";

const SCHEMA_VERSION = 1;

// --- Ignore rules ---

const IGNORED_DIR_NAMES = new Set([
  ".git", "node_modules", "cpb-task", ".cpb", "dist", "build", "coverage",
  ".next", ".turbo", "target", "__pycache__",
  "vendor", "generated", ".cache", ".parcel-cache", ".nuxt", ".output",
  "out", ".svelte-kit",
]);

const SECRET_FILE_NAMES = new Set([
  ".env", "id_rsa", "id_dsa", "id_ed25519",
]);

const SECRET_FILE_PREFIXES = [".env."];
const SECRET_FILE_SUFFIXES = [".pem", ".key", ".p12"];
const GENERATED_SUFFIXES = [".min.js", ".min.css", ".map", ".bundle.js", ".chunk.js"];

function isIgnoredDir(name) {
  return IGNORED_DIR_NAMES.has(name);
}

function isIgnoredFile(name) {
  if (SECRET_FILE_NAMES.has(name)) return true;
  for (const p of SECRET_FILE_PREFIXES) { if (name.startsWith(p)) return true; }
  for (const s of SECRET_FILE_SUFFIXES) { if (name.endsWith(s)) return true; }
  for (const s of GENERATED_SUFFIXES) { if (name.endsWith(s)) return true; }
  return false;
}

// --- Helpers ---

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function langFromExt(ext) {
  const map = {
    ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
    ".jsx": "JavaScript (JSX)", ".ts": "TypeScript", ".tsx": "TypeScript (TSX)",
    ".py": "Python", ".rs": "Rust",
    ".go": "Go", ".java": "Java", ".rb": "Ruby",
    ".css": "CSS", ".scss": "SCSS", ".less": "Less",
    ".html": "HTML", ".htm": "HTML", ".vue": "Vue", ".svelte": "Svelte",
    ".json": "JSON", ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML",
    ".md": "Markdown", ".txt": "Text", ".xml": "XML",
    ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell",
    ".sql": "SQL", ".graphql": "GraphQL", ".proto": "Protocol Buffers",
    ".c": "C", ".h": "C", ".cpp": "C++", ".hpp": "C++",
    ".swift": "Swift", ".kt": "Kotlin", ".dart": "Dart",
  };
  return map[ext] || null;
}

function classifyFile(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  const name = path.basename(relPath).toLowerCase();
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "config";
  if (name === "makefile" || name === "cmakelists.txt") return "config";
  if (name === "license" || name.startsWith("license.") || name === "copying") return "license";
  if (name === "readme" || name.startsWith("readme.") || name === "changelog") return "docs";
  if (name === "package.json" || name === "cargo.toml" || name === "go.mod" || name === "pyproject.toml") return "manifest";
  if (name === ".gitignore" || name === ".dockerignore" || name === ".eslintrc" || name === ".prettierrc") return "config";
  if (name.endsWith(".config.js") || name.endsWith(".config.mjs") || name.endsWith(".config.ts")) return "config";
  if (name.endsWith(".test.js") || name.endsWith(".test.ts") || name.endsWith(".spec.js") || name.endsWith(".spec.ts")) return "test";
  const lang = langFromExt(ext);
  if (lang) return "source";
  return "other";
}

// --- File inventory ---

async function walkDir(dir, sourceRoot, runtimeRoot, results) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".git") && entry.name !== ".github") {
      if (entry.isDirectory() && entry.name === ".git") continue;
    }
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(sourceRoot, fullPath);
    if (entry.isDirectory()) {
      if (isIgnoredDir(entry.name)) continue;
      if (runtimeRoot && fullPath.startsWith(runtimeRoot + path.sep)) continue;
      await walkDir(fullPath, sourceRoot, runtimeRoot, results);
    } else if (entry.isFile()) {
      if (isIgnoredFile(entry.name)) continue;
      let fileInfo;
      try { fileInfo = await stat(fullPath); } catch { continue; }
      const ext = path.extname(entry.name).toLowerCase();
      const lang = langFromExt(ext);
      const classification = classifyFile(relPath);
      results.push({
        path: toPosix(relPath),
        size: fileInfo.size,
        language: lang,
        type: classification,
      });
    }
  }
}

// --- Symbol extraction (heuristic, bounded) ---

const MAX_READ_BYTES = 256 * 1024;

const SYMBOL_PATTERNS = [
  { exts: [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"],
    extract(content, relPath) {
      const syms = [];
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const ln = i + 1;
        const line = lines[i];
        let m = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
        if (m) { syms.push({ path: relPath, name: m[1], kind: "function", line: ln }); continue; }
        m = line.match(/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\()/);
        if (m) { syms.push({ path: relPath, name: m[1], kind: "function", line: ln }); continue; }
        m = line.match(/(?:export\s+)?(?:default\s+)?class\s+(\w+)/);
        if (m) { syms.push({ path: relPath, name: m[1], kind: "class", line: ln }); continue; }
      }
      return syms;
    },
  },
  {
    exts: [".py"],
    extract(content, relPath) {
      const syms = [];
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const ln = i + 1;
        const line = lines[i];
        let m = line.match(/^def\s+(\w+)/);
        if (m) { syms.push({ path: relPath, name: m[1], kind: "function", line: ln }); continue; }
        m = line.match(/^class\s+(\w+)/);
        if (m) { syms.push({ path: relPath, name: m[1], kind: "class", line: ln }); continue; }
      }
      return syms;
    },
  },
  {
    exts: [".rs"],
    extract(content, relPath) {
      const syms = [];
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const ln = i + 1;
        const line = lines[i];
        let m = line.match(/pub\s+(?:async\s+)?fn\s+(\w+)/);
        if (m) { syms.push({ path: relPath, name: m[1], kind: "function", line: ln }); continue; }
        m = line.match(/pub\s+struct\s+(\w+)/);
        if (m) { syms.push({ path: relPath, name: m[1], kind: "struct", line: ln }); continue; }
        m = line.match(/pub\s+enum\s+(\w+)/);
        if (m) { syms.push({ path: relPath, name: m[1], kind: "enum", line: ln }); continue; }
        m = line.match(/pub\s+trait\s+(\w+)/);
        if (m) { syms.push({ path: relPath, name: m[1], kind: "trait", line: ln }); continue; }
      }
      return syms;
    },
  },
  {
    exts: [".go"],
    extract(content, relPath) {
      const syms = [];
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const ln = i + 1;
        const line = lines[i];
        let m = line.match(/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/);
        if (m) { syms.push({ path: relPath, name: m[1], kind: "function", line: ln }); continue; }
        m = line.match(/^type\s+(\w+)\s+struct/);
        if (m) { syms.push({ path: relPath, name: m[1], kind: "struct", line: ln }); continue; }
      }
      return syms;
    },
  },
];

async function extractSymbols(files, sourceRoot) {
  const allSymbols = [];
  for (const file of files) {
    const ext = path.extname(file.path).toLowerCase();
    const matcher = SYMBOL_PATTERNS.find((p) => p.exts.includes(ext));
    if (!matcher) continue;
    if (file.type === "test") continue;
    const fullPath = path.join(sourceRoot, file.path);
    let content;
    try {
      const buf = await readFile(fullPath);
      if (buf.length > MAX_READ_BYTES) continue;
      content = buf.toString("utf8");
    } catch { continue; }
    const syms = matcher.extract(content, file.path);
    allSymbols.push(...syms);
  }
  return allSymbols;
}

// --- Command detection ---

// We need sync read for detectCommands
import { readFileSync } from "node:fs";

function detectCommands(sourceRoot, files) {
  const commands = [];
  const packageManagers = [];

  const hasPkg = files.some((f) => f.path === "package.json");
  if (hasPkg) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
      const scripts = pkg.scripts || {};
      if (scripts.test) commands.push({ name: "test", command: scripts.test, source: "package.json", type: "test" });
      if (scripts.build) commands.push({ name: "build", command: scripts.build, source: "package.json", type: "build" });
      if (scripts.lint) commands.push({ name: "lint", command: scripts.lint, source: "package.json", type: "lint" });
      for (const [name, cmd] of Object.entries(scripts)) {
        if (["test", "build", "lint"].includes(name)) continue;
        commands.push({ name, command: cmd, source: "package.json", type: "script" });
      }
      if (files.some((f) => f.path === "pnpm-lock.yaml")) packageManagers.push("pnpm");
      else if (files.some((f) => f.path === "yarn.lock")) packageManagers.push("yarn");
      else packageManagers.push("npm");
    } catch { /* ignore */ }
  }

  if (files.some((f) => f.path === "Cargo.toml")) {
    commands.push({ name: "build", command: "cargo build", source: "Cargo.toml", type: "build" });
    commands.push({ name: "test", command: "cargo test", source: "Cargo.toml", type: "test" });
    packageManagers.push("cargo");
  }
  if (files.some((f) => f.path === "go.mod")) {
    commands.push({ name: "build", command: "go build ./...", source: "go.mod", type: "build" });
    commands.push({ name: "test", command: "go test ./...", source: "go.mod", type: "test" });
    packageManagers.push("go");
  }
  if (files.some((f) => f.path === "pyproject.toml")) {
    commands.push({ name: "test", command: "pytest", source: "pyproject.toml", type: "test" });
    packageManagers.push("pip");
  }

  return { commands, packageManagers: [...new Set(packageManagers)] };
}

// --- Git info ---

function gitInfo(sourceRoot) {
  const git = { branch: null, head: null, headShort: null, status: null, changedFiles: 0 };
  try {
    const branch = execFileSync("git", ["-C", sourceRoot, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    git.branch = branch;
  } catch { /* not a git repo */ }
  try {
    const head = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
      encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    git.head = head;
    git.headShort = head.slice(0, 7);
  } catch { /* ignore */ }
  try {
    const status = execFileSync("git", ["-C", sourceRoot, "status", "--porcelain"], {
      encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    git.status = status ? "dirty" : "clean";
    git.changedFiles = status ? status.split("\n").length : 0;
  } catch { /* ignore */ }
  return git;
}

// --- Atomic write ---

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

// --- Content hash (deterministic, excludes updatedAt) ---

function computeContentHash(filesJson, symbolsJson, commandsJson, git, configHashes) {
  const hash = createHash("sha256");
  hash.update(filesJson);
  hash.update(symbolsJson);
  hash.update(commandsJson);
  if (git.head) hash.update(git.head);
  if (git.branch) hash.update(git.branch);
  if (configHashes) {
    for (const key of Object.keys(configHashes).sort()) {
      hash.update(`${key}:${configHashes[key]}`);
    }
  }
  return hash.digest("hex").slice(0, 16);
}

// --- Summary generation ---

function buildSummary(project, manifest, files, symbols, commands, git) {
  const lines = [];
  lines.push(`# ${project.id || "project"} Code Index`);
  lines.push("");
  if (git.branch) lines.push(`- Branch: \`${git.branch}\` (${git.headShort || "unknown head"})`);
  if (git.status) lines.push(`- Working tree: ${git.status}${git.changedFiles ? ` (${git.changedFiles} changed)` : ""}`);
  lines.push(`- Files: ${manifest.stats.fileCount}`);
  lines.push(`- Symbols: ${manifest.stats.symbolCount}`);
  lines.push(`- Commands: ${manifest.stats.commandCount}`);
  lines.push("");

  const langCounts = {};
  for (const f of files) {
    if (f.language) langCounts[f.language] = (langCounts[f.language] || 0) + 1;
  }
  const topLangs = Object.entries(langCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (topLangs.length > 0) {
    lines.push("## Languages");
    for (const [lang, count] of topLangs) lines.push(`- ${lang}: ${count} files`);
    lines.push("");
  }

  if (commands.length > 0) {
    lines.push("## Commands");
    for (const cmd of commands.slice(0, 15)) {
      lines.push(`- \`${cmd.name}\`: ${cmd.command} (${cmd.source})`);
    }
    lines.push("");
  }

  const topDirs = new Set();
  for (const f of files) {
    const parts = f.path.split("/");
    if (parts.length > 1) topDirs.add(parts[0]);
  }
  if (topDirs.size > 0) {
    lines.push("## Top directories");
    lines.push([...topDirs].sort().map((d) => `\`${d}/\``).join(", "));
    lines.push("");
  }

  return lines.join("\n");
}

// --- Key config hash computation ---

const KEY_CONFIG_FILES = [
  "package.json", "tsconfig.json", "jsconfig.json",
  "Cargo.toml", "go.mod", "pyproject.toml",
  ".eslintrc", ".eslintrc.json", ".eslintrc.js",
  ".prettierrc", ".prettierrc.json",
  "vite.config.js", "vite.config.ts",
  "next.config.js", "next.config.mjs",
];

async function computeConfigHashes(sourceRoot, files) {
  const hashes = {};
  const fileSet = new Set(files.map((f) => f.path));
  for (const cfg of KEY_CONFIG_FILES) {
    if (!fileSet.has(cfg)) continue;
    const fullPath = path.join(sourceRoot, cfg);
    try {
      const content = await readFile(fullPath, "utf8");
      const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
      hashes[cfg] = hash;
    } catch { /* skip unreadable configs */ }
  }
  return hashes;
}

// --- Public API ---

export function indexDirForProject(project, hubRoot) {
  const root = project.projectRuntimeRoot || (hubRoot ? projectRuntimeRoot(hubRoot, project.id) : null);
  if (!root) throw new Error(`cannot resolve index directory for project ${project.id}: no projectRuntimeRoot and no hubRoot`);
  return path.join(root, "index");
}

export async function refreshProjectCodeIndex(project, { hubRoot } = {}) {
  const sourcePath = project.sourcePath;
  if (!sourcePath) throw new Error(`project ${project.id} has no sourcePath`);
  const idxDir = indexDirForProject(project, hubRoot);
  const runtimeRoot = project.projectRuntimeRoot || (hubRoot ? projectRuntimeRoot(hubRoot, project.id) : null);

  // 1. Walk files
  const files = [];
  await walkDir(sourcePath, sourcePath, runtimeRoot, files);

  // 2. Extract symbols
  const symbols = await extractSymbols(files, sourcePath);

  // 3. Detect commands
  const { commands, packageManagers } = detectCommands(sourcePath, files);

  // 4. Git info
  const git = gitInfo(sourcePath);

  // 5. Key config hashes
  const configHashes = await computeConfigHashes(sourcePath, files);

  // 6. Build stable JSON
  const filesArtifact = JSON.stringify({ schemaVersion: SCHEMA_VERSION, files });
  const symbolsArtifact = JSON.stringify({ schemaVersion: SCHEMA_VERSION, symbols });
  const commandsArtifact = JSON.stringify({ schemaVersion: SCHEMA_VERSION, commands, packageManagers });

  // 7. Content hash
  const contentHash = computeContentHash(filesArtifact, symbolsArtifact, commandsArtifact, git, configHashes);

  // 8. Manifest
  const updatedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    projectId: project.id,
    sourcePath,
    indexRoot: idxDir,
    updatedAt,
    git,
    configHashes,
    stats: {
      fileCount: files.length,
      symbolCount: symbols.length,
      commandCount: commands.length,
    },
    contentHash,
  };

  // 9. Summary
  const summary = buildSummary(project, manifest, files, symbols, commands, git);

  // 10. Atomic writes
  await mkdir(idxDir, { recursive: true });
  await writeAtomic(path.join(idxDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeAtomic(path.join(idxDir, "files.json"), `${filesArtifact}\n`);
  await writeAtomic(path.join(idxDir, "symbols.json"), `${symbolsArtifact}\n`);
  await writeAtomic(path.join(idxDir, "commands.json"), `${commandsArtifact}\n`);
  await writeAtomic(path.join(idxDir, "summary.md"), summary);

  return {
    status: "ready",
    fileCount: files.length,
    symbolCount: symbols.length,
    commandCount: commands.length,
    contentHash,
    updatedAt,
    branch: git.branch,
    headShort: git.headShort,
  };
}

function staleFromManifest(manifest) {
  return {
    status: "stale",
    fileCount: manifest.stats?.fileCount ?? 0,
    symbolCount: manifest.stats?.symbolCount ?? 0,
    commandCount: manifest.stats?.commandCount ?? 0,
    contentHash: manifest.contentHash ?? null,
    updatedAt: manifest.updatedAt ?? null,
    branch: manifest.git?.branch ?? null,
    headShort: manifest.git?.headShort ?? null,
    gitStatus: manifest.git?.status ?? null,
    changedFiles: manifest.git?.changedFiles ?? 0,
  };
}

export async function readProjectCodeIndexStatus(project, { hubRoot } = {}) {
  const idxDir = indexDirForProject(project, hubRoot);
  const empty = { status: "missing", fileCount: 0, symbolCount: 0, commandCount: 0, contentHash: null, updatedAt: null, branch: null, headShort: null, gitStatus: null, changedFiles: 0 };

  let manifest;
  try {
    const raw = await readFile(path.join(idxDir, "manifest.json"), "utf8");
    manifest = JSON.parse(raw);
  } catch {
    return empty;
  }

  if (!manifest || typeof manifest !== "object") {
    return { ...empty, status: "error" };
  }

  // Check required artifacts exist, are parseable, and have expected shape
  const artifactShape = {
    "files.json": { requiredArray: "files" },
    "symbols.json": { requiredArray: "symbols" },
    "commands.json": { requiredArray: "commands" },
  };
  for (const [artifact, shape] of Object.entries(artifactShape)) {
    try {
      const content = await readFile(path.join(idxDir, artifact), "utf8");
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== "object") return staleFromManifest(manifest);
      if (!Array.isArray(parsed[shape.requiredArray])) return staleFromManifest(manifest);
    } catch {
      return staleFromManifest(manifest);
    }
  }

  return {
    status: "ready",
    fileCount: manifest.stats?.fileCount ?? 0,
    symbolCount: manifest.stats?.symbolCount ?? 0,
    commandCount: manifest.stats?.commandCount ?? 0,
    contentHash: manifest.contentHash ?? null,
    updatedAt: manifest.updatedAt ?? null,
    branch: manifest.git?.branch ?? null,
    headShort: manifest.git?.headShort ?? null,
    gitStatus: manifest.git?.status ?? null,
    changedFiles: manifest.git?.changedFiles ?? 0,
  };
}

export async function readCompactProjectCodeIndexSummary(project, { hubRoot, maxBytes = 12000 } = {}) {
  const idxDir = indexDirForProject(project, hubRoot);
  try {
    let summary = await readFile(path.join(idxDir, "summary.md"), "utf8");
    if (Buffer.byteLength(summary, "utf8") > maxBytes) {
      summary = summary.slice(0, maxBytes);
    }
    return summary;
  } catch {
    return "";
  }
}

function extractKeywords(taskDescription) {
  if (!taskDescription || typeof taskDescription !== "string") return [];
  const tokens = taskDescription
    .replace(/[^a-zA-Z0-9_.\/\-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  return [...new Set(tokens.map((t) => t.toLowerCase()))];
}

export async function readFilteredCodeIndexSummary(project, { hubRoot, taskDescription, maxBytes = 4096 } = {}) {
  const idxDir = indexDirForProject(project, hubRoot);
  try {
    const summary = await readFile(path.join(idxDir, "summary.md"), "utf8");
    if (!summary) return "";

    const keywords = extractKeywords(taskDescription);
    if (keywords.length === 0) {
      return summary.slice(0, maxBytes);
    }

    const lines = summary.split("\n");
    const matched = [];
    const unmatched = [];

    for (const line of lines) {
      const lower = line.toLowerCase();
      const hits = keywords.filter((kw) => lower.includes(kw)).length;
      if (hits > 0) {
        matched.push({ line, score: hits });
      } else {
        unmatched.push(line);
      }
    }

    matched.sort((a, b) => b.score - a.score);

    const result = [];
    let bytes = 0;
    for (const { line } of matched) {
      if (bytes + line.length + 1 > maxBytes) break;
      result.push(line);
      bytes += line.length + 1;
    }

    if (bytes < maxBytes * 0.3) {
      for (const line of unmatched) {
        if (bytes + line.length + 1 > maxBytes) break;
        result.push(line);
        bytes += line.length + 1;
      }
    }

    return result.join("\n");
  } catch {
    return "";
  }
}
