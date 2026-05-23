import path from "node:path";
import { readFile } from "node:fs/promises";
import { buildPhaseLocator, locatorEnvelope } from "./phase-locator.js";
import { readEvents, materializeJob } from "./event-store.js";
import { readFilteredCodeIndexSummary } from "./project-code-index.js";

const DEFAULT_MAX_BYTES = 8192;

/**
 * Build a compact phase context packet for agent prompts.
 *
 * Contains locators (file paths) instead of full plan/deliverable content,
 * plus budget-controlled optional sections (code index summary, event tail).
 *
 * @param {string} cpbRoot
 * @param {string} project
 * @param {string} jobId
 * @param {string} phase
 * @param {{ maxBytes?: number, hubRoot?: string }} options
 */
export async function buildPhaseContextPacket(
  cpbRoot,
  project,
  jobId,
  phase,
  options = {},
) {
  const maxBytes =
    options.maxBytes ??
    (process.env.CPB_PHASE_CONTEXT_MAX_BYTES
      ? Number(process.env.CPB_PHASE_CONTEXT_MAX_BYTES)
      : null) ??
    DEFAULT_MAX_BYTES;

  // 1. Build locator (never clipped)
  const locator = await buildPhaseLocator(cpbRoot, project, jobId, phase);
  const locators = locatorEnvelope(locator);

  // 2. Materialize job from event log
  const events = await readEvents(cpbRoot, project, jobId);
  const job = materializeJob(events);

  // 3. Completed phases from materialized state
  const completedPhases = job.completedPhases || [];

  // 4. Artifacts as id/path map only (no content bodies)
  const artifacts = { ...(job.artifacts || {}) };

  // 5. Source context
  const sourceContext = locator.sourcePath || job.sourceContext || null;

  // 6. Build readInstructions based on phase and available paths
  const readInstructions = buildReadInstructions(locator, job, phase);

  // --- Assemble the mandatory (never-clipped) skeleton ---
  const packet = {
    schemaVersion: 1,
    project,
    jobId,
    phase,
    locators,
    task: job.task || null,
    workflow: job.workflow || null,
    artifacts,
    completedPhases,
    sourceContext,
    readInstructions,
    budget: { maxBytes, actualBytes: 0, clipped: false },
  };

  // Compute mandatory skeleton size
  let usedBytes = measureUtf8Bytes(packet);

  // 7. Optional: code index summary (budget-gated)
  let indexSummary = null;
  if (sourceContext && maxBytes > usedBytes) {
    const indexBudget = maxBytes - usedBytes;
    try {
      const summary = await readFilteredCodeIndexSummary(
        { id: project, sourcePath: sourceContext },
        {
          hubRoot: options.hubRoot,
          taskDescription: job.task || "",
          maxBytes: indexBudget,
        },
      );
      if (summary) {
        const summaryBytes = measureUtf8Bytes(summary);
        if (usedBytes + summaryBytes <= maxBytes) {
          indexSummary = summary;
          usedBytes += summaryBytes;
        }
      }
    } catch {
      // Index not available — skip silently
    }
  }
  packet.indexSummary = indexSummary;

  // 8. Optional: event tail summary (budget-gated)
  let eventTailSummary = null;
  if (events.length > 0 && maxBytes > usedBytes) {
    const tailBudget = maxBytes - usedBytes;
    const tail = buildEventTail(events);
    const tailBytes = measureUtf8Bytes(tail);
    if (tailBytes <= tailBudget) {
      eventTailSummary = tail;
      usedBytes += tailBytes;
    }
  }
  packet.eventTailSummary = eventTailSummary;

  // 9. Finalize budget
  packet.budget.actualBytes = usedBytes;
  packet.budget.clipped = usedBytes > maxBytes;

  return packet;
}

// --- Helpers ---

/**
 * Build an array of instruction strings telling the agent which files to read.
 */
function buildReadInstructions(locator, job, phase) {
  const instructions = [];
  const workflow = job.workflow || "standard";

  // Always read the event log for full history
  if (locator.eventLogPath) {
    instructions.push(`Read event log: ${locator.eventLogPath}`);
  }

  // Phase-specific artifact reads
  if (locator.prevArtifactPath) {
    instructions.push(
      `Read previous phase artifact (${locator.prevPhase}): ${locator.prevArtifactPath}`,
    );
  }

  // Plan phase reads the inbox
  if (phase === "plan" && locator.inboxDir) {
    instructions.push(
      `Check inbox directory for existing plans: ${locator.inboxDir}`,
    );
  }

  // Execute/verify phases read the plan artifact
  if (["execute", "review", "verify"].includes(phase) && job.artifacts?.plan) {
    const planArtifact = job.artifacts.plan;
    const planPath = resolveArtifactName(locator, planArtifact);
    if (planPath) {
      instructions.push(`Read plan artifact: ${planPath}`);
    }
  }

  // Review/verify phases read the execute deliverable
  if (["review", "verify"].includes(phase) && job.artifacts?.execute) {
    const execArtifact = job.artifacts.execute;
    const execPath = resolveArtifactName(locator, execArtifact);
    if (execPath) {
      instructions.push(`Read execute deliverable: ${execPath}`);
    }
  }

  // Verify phase reads review artifact if present
  if (phase === "verify" && job.artifacts?.review) {
    const reviewArtifact = job.artifacts.review;
    const reviewPath = resolveArtifactName(locator, reviewArtifact);
    if (reviewPath) {
      instructions.push(`Read review artifact: ${reviewPath}`);
    }
  }

  // Project context and decisions
  if (locator.wikiDir) {
    instructions.push(
      `Read project context (if exists): ${path.join(locator.wikiDir, "context.md")}`,
    );
    instructions.push(
      `Read project decisions (if exists): ${path.join(locator.wikiDir, "decisions.md")}`,
    );
  }

  // Source code
  if (locator.sourcePath) {
    instructions.push(`Source code root: ${locator.sourcePath}`);
  }

  return instructions;
}

/**
 * Resolve an artifact name to its full path.
 */
function resolveArtifactName(locator, artifact) {
  if (!artifact || typeof artifact !== "string") return null;
  if (path.isAbsolute(artifact)) return artifact;
  const normalized = artifact.endsWith(".md") ? artifact : `${artifact}.md`;
  const dir = normalized.startsWith("plan-")
    ? locator.inboxDir
    : locator.outputsDir;
  return path.join(dir, normalized);
}

/**
 * Build a compact tail summary from events (last N events, type + phase only).
 */
function buildEventTail(events) {
  const tail = events.slice(-10);
  return tail
    .map((e) => {
      const parts = [e.type];
      if (e.phase) parts.push(`phase=${e.phase}`);
      if (e.artifact) parts.push(`artifact=${e.artifact}`);
      if (e.status) parts.push(`status=${e.status}`);
      return parts.join(" ");
    })
    .join("\n");
}

/**
 * Measure UTF-8 byte length of a value (JSON-serialized if object).
 */
function measureUtf8Bytes(value) {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.byteLength(str, "utf8");
}
