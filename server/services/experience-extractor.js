import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";

const FIX_SIGNALS = /\b(fix|bug|workaround|race|regression|repair|prevented|patch|hotfix|broken|crash|deadlock|leak|orphan|zombie|stale)\b/i;

const TERMINAL_GOTCHA_EVENTS = new Set([
  "pool_exhausted",
  "budget_exceeded",
  "approval_timed_out",
  "job_cancelled",
]);

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function stableKey(project, jobId, source, category) {
  return `${project}-${jobId}-${source}-${category}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Categorize a parsed verdict envelope into experience category.
 * Returns { category, severity } or null to skip.
 */
export function categorizeVerdictEnvelope(envelope) {
  const status = String(envelope?.status || "").toLowerCase();

  if (status === "fail") {
    return { category: "failure", severity: "high" };
  }
  if (status === "infra_error") {
    return { category: "gotcha", severity: "high" };
  }
  if (status === "inconclusive") {
    const hasBlocking = Array.isArray(envelope?.blocking) && envelope.blocking.length > 0;
    return { category: "gotcha", severity: hasBlocking ? "medium" : "low" };
  }
  if (status === "pass") {
    const reason = String(envelope?.reason || "");
    if (FIX_SIGNALS.test(reason)) {
      return { category: "pattern", severity: "low" };
    }
    return null; // pure pass with no fix signal — skip
  }

  return null;
}

/**
 * Extract tags from verdict envelope content.
 */
function extractTags(envelope, content) {
  const tags = new Set();

  // From fix_scope
  if (Array.isArray(envelope?.fix_scope)) {
    for (const f of envelope.fix_scope) {
      const clean = path.basename(String(f), path.extname(String(f)));
      if (clean && clean.length < 40) tags.add(clean);
    }
  }

  // From blocking entries
  if (Array.isArray(envelope?.blocking)) {
    for (const entry of envelope.blocking) {
      if (typeof entry === "object" && entry?.file) {
        const clean = path.basename(String(entry.file), path.extname(String(entry.file)));
        if (clean && clean.length < 40) tags.add(clean);
      }
    }
  }

  // From failed layers
  if (envelope?.layers && typeof envelope.layers === "object") {
    for (const [name, layer] of Object.entries(envelope.layers)) {
      if (String(layer?.status || "").toLowerCase() === "fail") {
        tags.add(name);
      }
    }
  }

  // Fallback: extract keywords from reason
  if (tags.size === 0 && envelope?.reason) {
    const keywords = String(envelope.reason).match(/\b[a-z][a-z0-9-]{2,20}\b/gi);
    if (keywords) {
      for (const kw of keywords.slice(0, 5)) tags.add(kw.toLowerCase());
    }
  }

  return [...tags].slice(0, 8);
}

/**
 * Build experience object from verdict envelope.
 */
function buildExperienceFromVerdict(project, jobId, artifactId, artifactPath, envelope) {
  const cat = categorizeVerdictEnvelope(envelope);
  if (!cat) return null;

  const key = stableKey(project, jobId, artifactId, cat.category);
  const tags = extractTags(envelope);

  return {
    key,
    slug: slugify(key),
    category: cat.category,
    severity: cat.severity,
    project,
    jobId,
    source: artifactId,
    source_type: "verdict",
    source_artifact: artifactPath,
    confidence: envelope.confidence ?? null,
    date: today(),
    tags,
    title: buildTitle(cat.category, envelope),
    reason: String(envelope?.reason || "no reason provided"),
    details: buildDetails(envelope),
    fix: buildFix(envelope),
    prevention: buildPrevention(envelope),
  };
}

function buildTitle(category, envelope) {
  const reason = String(envelope?.reason || "").slice(0, 120);
  const prefix = category === "failure" ? "FAIL" : category === "pattern" ? "FIX" : "GOTCHA";
  return `[${prefix}] ${reason || "unknown"}`;
}

function buildDetails(envelope) {
  const parts = [];
  if (envelope?._legacyDetails) {
    parts.push(envelope._legacyDetails);
  }
  if (Array.isArray(envelope?.blocking) && envelope.blocking.length > 0) {
    parts.push(`Blocking: ${envelope.blocking.length} item(s)`);
  }
  if (Array.isArray(envelope?.fix_scope) && envelope.fix_scope.length > 0) {
    parts.push(`Fix scope: ${envelope.fix_scope.join(", ")}`);
  }
  if (envelope?.layers && typeof envelope.layers === "object") {
    const failed = Object.entries(envelope.layers)
      .filter(([, l]) => String(l?.status || "").toLowerCase() === "fail")
      .map(([name]) => name);
    if (failed.length > 0) parts.push(`Failed layers: ${failed.join(", ")}`);
  }
  return parts.join("\n");
}

function buildFix(envelope) {
  const parts = [];
  if (Array.isArray(envelope?.fix_scope) && envelope.fix_scope.length > 0) {
    parts.push(`修复范围: ${envelope.fix_scope.join(", ")}`);
  }
  if (Array.isArray(envelope?.blocking) && envelope.blocking.length > 0) {
    for (const entry of envelope.blocking) {
      if (typeof entry === "string") parts.push(entry);
      else if (typeof entry === "object" && entry?.criterion) parts.push(entry.criterion);
    }
  }
  return parts.length > 0 ? parts.join("\n") : "待补充";
}

function buildPrevention(envelope) {
  const parts = [];
  if (envelope?.layers && typeof envelope.layers === "object") {
    const failed = Object.entries(envelope.layers)
      .filter(([, l]) => String(l?.status || "").toLowerCase() === "fail")
      .map(([name]) => name);
    if (failed.length > 0) parts.push(`下次提交前检查: ${failed.join(", ")} 层`);
  }
  if (Array.isArray(envelope?.blocking) && envelope.blocking.length > 0) {
    const criteria = envelope.blocking
      .map((e) => typeof e === "string" ? e : e?.criterion)
      .filter(Boolean);
    if (criteria.length > 0) parts.push(`验收标准: ${criteria.join("; ")}`);
  }
  return parts.length > 0 ? parts.join("\n") : "待补充";
}

/**
 * Extract ## Status / ## Reason / ## Details / ## Confidence from legacy Markdown verdict.
 */
function extractLegacyMarkdownSections(content) {
  const result = {};
  const sections = content.split(/^## /m);
  for (const section of sections) {
    const headerMatch = section.match(/^(\w[\w -]*)\s*\n([\s\S]*)/);
    if (!headerMatch) continue;
    const heading = headerMatch[1].trim().toLowerCase();
    const body = headerMatch[2].trim();
    if (heading === "status") {
      const statusLine = body.split(/\n/)[0].trim();
      const m = statusLine.match(/^(pass|fail|partial|inconclusive|infra_error)\b/i);
      if (m) result.status = m[1];
    } else if (heading === "reason") {
      result.reason = body.slice(0, 500);
    } else if (heading === "details") {
      result.details = body.slice(0, 1000);
    } else if (heading === "confidence") {
      const num = parseFloat(body);
      if (!Number.isNaN(num) && num >= 0 && num <= 1) result.confidence = num;
    }
  }
  return result;
}

/**
 * Build experience object from terminal job state (no verdict).
 */
function buildExperienceFromTerminalState(project, jobId, state, eventType) {
  // job_failed / phase_failed without verdict → failure; others → gotcha
  const category = (eventType === "job_failed" || eventType === "phase_failed") ? "failure" : "gotcha";
  const key = stableKey(project, jobId, eventType, category);
  const severity = category === "failure" ? "high" : (eventType === "pool_exhausted" || eventType === "approval_timed_out") ? "high" : "medium";

  const reason = state?.blockedReason || state?.failureCode || eventType;
  const tags = [];
  if (state?.failureCode) tags.push(state.failureCode);
  if (state?.failurePhase) tags.push(state.failurePhase);
  if (eventType) tags.push(eventType);

  const fixParts = [];
  if (state?.failureCode) fixParts.push(`failureCode: ${state.failureCode}`);
  if (state?.failurePhase) fixParts.push(`failurePhase: ${state.failurePhase}`);
  const preventionMap = {
    pool_exhausted: "检查 ACP pool 配额和并发限制",
    budget_exceeded: "检查任务预算配置",
    approval_timed_out: "确保审批通道畅通或缩短超时",
    job_cancelled: "确认取消原因，避免误操作",
    job_failed: "检查 worker 日志和 failureCode",
    phase_failed: "检查失败阶段的输入和依赖",
  };

  return {
    key,
    slug: slugify(key),
    category,
    severity,
    project,
    jobId,
    source: eventType,
    source_type: "terminal-event",
    source_artifact: null,
    confidence: null,
    date: today(),
    tags,
    title: category === "failure" ? `[FAIL] ${eventType}: ${reason}` : `[GOTCHA] ${eventType}: ${reason}`,
    reason,
    details: `Status: ${state?.status ?? "unknown"}\nPhase: ${state?.phase ?? state?.failurePhase ?? "unknown"}\nCode: ${state?.failureCode ?? "none"}`,
    fix: fixParts.length > 0 ? fixParts.join("\n") : "待补充",
    prevention: preventionMap[eventType] || "待补充",
  };
}

/**
 * Write experience file if it doesn't exist (idempotent).
 * Returns true if written, false if skipped.
 */
export async function writeExperience(cpbRoot, experience, { force = false, skipIndexRebuild = false } = {}) {
  const dir = path.join(cpbRoot, "wiki", "experience", `${experience.category}s`);
  await mkdir(dir, { recursive: true });

  const filePath = path.join(dir, `${experience.slug}.md`);

  if (!force) {
    try {
      await readFile(filePath, "utf8");
      return false; // already exists, skip
    } catch { /* file doesn't exist — proceed */ }
  }

  const content = formatExperienceFile(experience);
  await writeFile(filePath, content, "utf8");

  // Auto-rebuild index after writing (fire-and-forget)
  if (!skipIndexRebuild) rebuildExperienceIndex(cpbRoot).catch(() => {});

  return true;
}

function formatExperienceFile(exp) {
  const frontmatter = [
    "---",
    `source: ${exp.source}`,
    `source_type: ${exp.source_type}`,
    `source_job_id: "${exp.jobId}"`,
    exp.source_artifact ? `source_artifact: "${exp.source_artifact}"` : null,
    `project: ${exp.project}`,
    `date: ${exp.date}`,
    `category: ${exp.category}`,
    `tags: [${exp.tags.join(", ")}]`,
    `severity: ${exp.severity}`,
    exp.confidence != null ? `confidence: ${exp.confidence}` : null,
    "---",
  ].filter(Boolean).join("\n");

  return [
    frontmatter,
    "",
    `# ${exp.title}`,
    "",
    "## 现象",
    exp.reason,
    "",
    "## 根因",
    exp.details || "未确认",
    "",
    "## 修复",
    exp.fix || "待补充",
    "",
    "## 预防",
    exp.prevention || "待补充",
    "",
  ].join("\n");
}

/**
 * Extract experience from a verdict artifact for a completed job.
 */
export async function extractExperienceFromVerdict(cpbRoot, project, jobId, artifactPath, { force = false, skipIndexRebuild = false } = {}) {
  const { parseVerdictEnvelope } = await import("../../core/workflow/verdict.js");

  let content;
  try {
    content = await readFile(artifactPath, "utf8");
  } catch {
    return null; // artifact not readable — skip silently
  }

  let envelope = parseVerdictEnvelope(content);

  // Enrich legacy Markdown verdicts that parseVerdictEnvelope returns as legacy/inconclusive
  // by extracting ## Status / ## Reason / ## Details / ## Confidence sections
  if (envelope.source === "legacy" || envelope.source === "unknown") {
    const legacy = extractLegacyMarkdownSections(content);
    if (legacy.status) {
      const normalizedStatus = legacy.status.toLowerCase();
      if (["pass", "fail", "partial", "inconclusive", "infra_error"].includes(normalizedStatus)) {
        envelope = {
          ...envelope,
          status: normalizedStatus === "partial" ? "fail" : normalizedStatus,
          reason: legacy.reason || envelope.reason,
          confidence: legacy.confidence ?? envelope.confidence,
          source: "legacy-enriched",
        };
        // Store details for buildDetails fallback
        if (legacy.details) envelope._legacyDetails = legacy.details;
      }
    }
  }
  const artifactId = path.basename(artifactPath, ".md");
  const experience = buildExperienceFromVerdict(project, jobId, artifactId, artifactPath, envelope);
  if (!experience) return null;

  return writeExperience(cpbRoot, experience, { force, skipIndexRebuild });
}

/**
 * Extract experience from a terminal job state (cancel/budget/pool_exhausted/etc).
 */
export async function extractExperienceFromTerminalState(cpbRoot, project, jobId, state, eventType, { force = false, skipIndexRebuild = false } = {}) {
  if (!TERMINAL_GOTCHA_EVENTS.has(eventType) && eventType !== "job_failed" && eventType !== "phase_failed") return null;

  const experience = buildExperienceFromTerminalState(project, jobId, state, eventType);
  return writeExperience(cpbRoot, experience, { force, skipIndexRebuild });
}

/**
 * Main entry: extract experience for a job.
 * Tries verdict artifact first, then falls back to terminal state.
 */
export async function extractExperienceForJob(cpbRoot, project, jobId, { dataRoot, force = false, skipIndexRebuild = false } = {}) {
  const { getJob } = await import("./job-store.js");

  const state = await getJob(cpbRoot, project, jobId, { dataRoot });
  if (!state?.jobId) return null;

  // Try verdict artifact via artifact index (authoritative path resolution)
  const verdictPath = await findVerdictArtifactPath(cpbRoot, project, jobId, state, { dataRoot });
  if (verdictPath) {
    return extractExperienceFromVerdict(cpbRoot, project, jobId, verdictPath, { force, skipIndexRebuild });
  }

  // Fall back to terminal state
  if (state.status === "failed" || state.status === "blocked" || state.status === "cancelled") {
    const eventType = inferTerminalEventType(state);
    return extractExperienceFromTerminalState(cpbRoot, project, jobId, state, eventType, { force, skipIndexRebuild });
  }

  return null;
}

/**
 * Find verdict artifact path using artifact index (authoritative),
 * falling back to job state artifacts + standard wiki path.
 */
async function findVerdictArtifactPath(cpbRoot, project, jobId, state, { dataRoot } = {}) {
  // Primary: use artifact index for authoritative path resolution
  try {
    const { buildArtifactIndex } = await import("./artifact-index.js");
    const index = await buildArtifactIndex(cpbRoot, project, jobId, { dataRoot });
    const verdictEntry = [...index.entries].reverse().find((e) => e.kind === "verdict" && !e.broken);
    if (verdictEntry?.path) return verdictEntry.path;
  } catch { /* index not available — fall through */ }

  // Fallback: job state artifacts + standard wiki path
  if (!state?.artifacts) return null;
  for (const [phase, artifact] of Object.entries(state.artifacts)) {
    if (phase === "verify" || phase.includes("verdict") || (typeof artifact === "string" && artifact.includes("verdict"))) {
      if (path.isAbsolute(artifact)) return artifact;
      return path.join(cpbRoot, "wiki", "projects", project, "outputs", artifact);
    }
  }
  return null;
}

function inferTerminalEventType(state) {
  if (state.failureCode === "pool_exhausted") return "pool_exhausted";
  if (state.blockedReason?.includes("budget")) return "budget_exceeded";
  if (state.blockedReason?.includes("approval") || state.blockedReason?.includes("timed out")) return "approval_timed_out";
  if (state.status === "cancelled") return "job_cancelled";
  if (state.status === "failed") return "job_failed";
  return "unknown_terminal";
}

/**
 * Rebuild wiki/experience/index.md from filesystem.
 */
export async function rebuildExperienceIndex(cpbRoot) {
  const expDir = path.join(cpbRoot, "wiki", "experience");

  const sections = { failures: [], patterns: [], gotchas: [] };

  for (const category of Object.keys(sections)) {
    const dir = path.join(expDir, category);
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith(".md") || file === ".gitkeep") continue;
        try {
          const content = await readFile(path.join(dir, file), "utf8");
          const meta = parseFrontmatter(content);
          sections[category].push({
            file,
            title: extractTitle(content),
            project: meta.project || "?",
            date: meta.date || "?",
            severity: meta.severity || "?",
            tags: meta.tags || [],
          });
        } catch { /* skip unreadable files */ }
      }
    } catch { /* dir doesn't exist yet */ }
  }

  const lines = [
    "# Experience Index",
    "",
    "> Auto-generated by `rebuildExperienceIndex()`. Do not edit manually.",
    "",
  ];

  for (const [category, entries] of Object.entries(sections)) {
    const heading = category.charAt(0).toUpperCase() + category.slice(1);
    lines.push(`## ${heading}`);
    lines.push("");
    if (entries.length === 0) {
      lines.push("_(none)_");
    } else {
      entries.sort((a, b) => b.date.localeCompare(a.date));
      for (const e of entries) {
        const tagStr = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
        lines.push(`- **${e.title}** (${e.project}, ${e.date}, ${e.severity})${tagStr} — \`${e.file}\``);
      }
    }
    lines.push("");
  }

  await writeFile(path.join(expDir, "index.md"), lines.join("\n"), "utf8");
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)/);
    if (kv) {
      let val = kv[2].trim();
      if (val.startsWith("[") && val.endsWith("]")) {
        val = val.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
      }
      meta[kv[1]] = val;
    }
  }
  return meta;
}

function extractTitle(content) {
  const match = content.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : "untitled";
}
