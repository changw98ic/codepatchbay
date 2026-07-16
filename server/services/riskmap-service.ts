import { recordValue, type LooseRecord } from "../../shared/types.js";
import { getProject } from "./hub/hub-registry.js";
import { updateEntry } from "./hub/hub-queue.js";
import { checkCodeGraphReady } from "./readiness-checks.js";
import { generateDynamicAgentPlan } from "../../core/agents/dynamic-agent-plan.js";

export class ProjectCapabilityMapUnavailableError extends Error {
  code: string;
  details: LooseRecord;

  constructor(reason: string, details: LooseRecord = {}) {
    super(reason);
    this.name = "ProjectCapabilityMapUnavailableError";
    this.code = "codegraph_unavailable";
    this.details = details;
  }
}

const DOMAIN_RULES = [
  {
    domain: "security",
    patterns: [/security/i, /auth/i, /permission/i, /secret/i, /token/i, /credential/i, /github write/i],
    boundaries: ["secrets", "github_write"],
    focus: ["privilege boundary", "secret exposure"],
  },
  {
    domain: "scheduler",
    patterns: [/scheduler/i, /orchestrator/i, /queue/i, /claim/i, /dispatch/i, /dag/i],
    boundaries: ["provider_pool"],
    focus: ["stale state recovery", "ready-node ordering"],
  },
  {
    domain: "concurrency",
    patterns: [/concurr/i, /race/i, /lock/i, /lease/i, /parallel/i, /capacity/i],
    boundaries: ["state_locking"],
    focus: ["race conditions", "lease consistency"],
  },
  {
    domain: "provider_pool",
    patterns: [/provider/i, /quota/i, /rate.?limit/i, /acp/i, /pool/i, /handoff/i],
    boundaries: ["provider_pool"],
    focus: ["provider starvation", "fallback correctness"],
  },
  {
    domain: "worktree",
    patterns: [/worktree/i, /git/i, /merge/i, /branch/i, /finalizer/i],
    boundaries: ["filesystem", "git_write"],
    focus: ["cross-worktree contamination", "merge state"],
  },
  {
    domain: "event_store",
    patterns: [/event store/i, /event-store/i, /jsonl/i, /checkpoint/i, /materialize/i],
    boundaries: ["durable_state"],
    focus: ["event ordering", "terminal state integrity"],
  },
  {
    domain: "subprocess",
    patterns: [/subprocess/i, /spawn/i, /exec/i, /shell/i, /process/i],
    boundaries: ["subprocess"],
    focus: ["process lifecycle", "command boundary"],
  },
  {
    domain: "network",
    patterns: [/network/i, /webhook/i, /api/i, /http/i, /slack/i],
    boundaries: ["network"],
    focus: ["external side effects", "retry behavior"],
  },
];

const DOCS_ONLY_RE = /\b(doc|docs|readme|comment|copy|typo|spelling|markdown)\b/i;

function objectAt(source: LooseRecord, keys: string[]): LooseRecord | null {
  for (const key of keys) {
    const value = source?.[key];
    if (value && typeof value === "object" && !Array.isArray(value)) return recordValue(value);
  }
  return null;
}

function projectMaps(project: LooseRecord, sourceContext: LooseRecord = {}) {
  const metadata = recordValue(project.metadata);
  const merged = { ...sourceContext, ...metadata, ...project };
  const capabilityMap = objectAt(merged, [
    "project_capability_map",
    "projectCapabilityMap",
    "capabilityMap",
  ]);
  const safetyBoundaryMap = objectAt(merged, [
    "safety_boundary_map",
    "safetyBoundaryMap",
    "safetyBoundaries",
  ]);
  const highRiskAreaMap = objectAt(merged, [
    "high_risk_area_map",
    "highRiskAreaMap",
    "highRiskAreas",
  ]);
  const confidence =
    capabilityMap?.confidence ||
    metadata.confidence ||
    metadata.capabilityMapConfidence ||
    project?.confidence ||
    null;

  return { capabilityMap, safetyBoundaryMap, highRiskAreaMap, confidence };
}

function requireCapabilityMap(project: LooseRecord, sourceContext: LooseRecord) {
  const maps = projectMaps(project, sourceContext);
  if (!maps.capabilityMap) {
    throw new ProjectCapabilityMapUnavailableError("Project Capability Map is unavailable", {
      reason: "missing_project_capability_map",
      project: project?.id || null,
    });
  }
  if (maps.confidence !== "high") {
    throw new ProjectCapabilityMapUnavailableError("Project Capability Map is not high confidence", {
      reason: "project_capability_map_not_high_confidence",
      confidence: typeof maps.confidence === "string" || typeof maps.confidence === "number" ? maps.confidence : null,
      project: project?.id || null,
    });
  }
  return maps;
}

function valuesToStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(valuesToStrings);
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(valuesToStrings);
  }
  return [];
}

function filesForDomains(highRiskAreaMap: LooseRecord, domains: string[]) {
  const files = new Set();
  for (const domain of domains) {
    const direct = highRiskAreaMap?.[domain] || highRiskAreaMap?.[domain.replace(/_/g, "-")];
    for (const file of valuesToStrings(direct)) {
      if (/\.[cm]?[jt]sx?$|\.js$|\.cjs$|\.py$|\.go$|\.rs$|\.rb$|\.java$|\.swift$/.test(file)) {
        files.add(file);
      }
    }
    for (const area of Array.isArray(highRiskAreaMap?.areas) ? highRiskAreaMap.areas : []) {
      if (area?.domain !== domain) continue;
      for (const file of valuesToStrings(area.files || area.paths || area.modules)) {
        files.add(file);
      }
    }
  }
  for (const file of valuesToStrings(highRiskAreaMap?.files || highRiskAreaMap?.highRiskFiles)) {
    files.add(file);
  }
  return [...files].slice(0, 20);
}

function computeRiskMap({ task, maps, project, workflow, planMode }) {
  const text = String(task || "");
  const matched = DOMAIN_RULES.filter((rule) => rule.patterns.some((pattern) => pattern.test(text)));
  const domains = matched.length > 0 ? matched.map((rule) => rule.domain) : ["general"];
  const safetyBoundaries = new Set(matched.flatMap((rule) => rule.boundaries));
  for (const boundary of valuesToStrings(maps.safetyBoundaryMap)) {
    if (matched.some((rule) => rule.patterns.some((pattern) => pattern.test(boundary)))) {
      safetyBoundaries.add(boundary);
    }
  }

  const isDocsOnly = DOCS_ONLY_RE.test(text) && matched.length === 0;
  const highRisk = matched.some((rule) => [
    "security",
    "scheduler",
    "concurrency",
    "provider_pool",
    "worktree",
    "event_store",
    "subprocess",
  ].includes(rule.domain));
  const critical = domains.includes("security") && /\b(secret|credential|token|permission|auth)\b/i.test(text);
  const riskLevel = critical ? "critical" : highRisk ? "high" : isDocsOnly ? "low" : "medium";
  const verificationDepth = riskLevel === "critical" ? "paranoid" : riskLevel === "high" ? "strict" : "standard";
  const adversarialRequired = riskLevel === "high" || riskLevel === "critical";
  const adversarialFocus = [...new Set(matched.flatMap((rule) => rule.focus))];

  return {
    riskLevel,
    domains,
    highRiskFiles: filesForDomains(maps.highRiskAreaMap, domains),
    safetyBoundaries: [...safetyBoundaries],
    verificationDepth,
    adversarialRequired,
    adversarialFocus,
    confidence: "high",
    generatedAt: new Date().toISOString(),
    source: {
      project: project?.id || null,
      workflow: workflow || null,
      planMode: planMode || null,
    },
  };
}

async function resolveProjectForTask({ hubRoot, project, sourcePath }) {
  if (!hubRoot || !project) return { id: project, sourcePath };
  const registered = await getProject(hubRoot, project).catch(() => null);
  return registered || { id: project, sourcePath };
}

async function persistQueueRiskMap(hubRoot: string, sourceContext: LooseRecord, riskMap: LooseRecord, dynamicAgentPlan: LooseRecord | null = null) {
  const queue = recordValue(sourceContext.queue);
  const queueEntryId = sourceContext?.queueEntryId || sourceContext?.entryId || queue.entryId;
  if (!hubRoot || !queueEntryId) return;
  await updateEntry(hubRoot, String(queueEntryId), {
    metadata: {
      riskMap,
      riskLevel: riskMap.riskLevel,
      verificationDepth: riskMap.verificationDepth,
      adversarialRequired: riskMap.adversarialRequired,
      ...(dynamicAgentPlan ? { dynamicAgentPlan } : {}),
    },
  }).catch(() => {});
}

export async function prepareTask(cpbRootOrOptions: LooseRecord | string, options: LooseRecord = {}) {
  const cpbRoot = cpbRootOrOptions && typeof cpbRootOrOptions === "object"
    ? String(cpbRootOrOptions.cpbRoot || "")
    : cpbRootOrOptions;
  const {
    hubRoot,
    project,
    task,
    sourcePath,
    sourceContext = {},
    workflow = "standard",
    planMode = "full",
  } = cpbRootOrOptions && typeof cpbRootOrOptions === "object"
    ? { ...cpbRootOrOptions, ...options }
    : options;
  const sourceContextRecord = recordValue(sourceContext);
  const cpbRootValue = typeof cpbRoot === "string" ? cpbRoot : "";
  const hubRootValue = typeof hubRoot === "string" ? hubRoot : "";
  const sourcePathValue = typeof sourcePath === "string" ? sourcePath : "";
  const projectValue = typeof project === "string" ? project : "";
  const registeredProject = await resolveProjectForTask({ hubRoot: hubRootValue, project: projectValue, sourcePath: sourcePathValue });
  const effectiveSourcePath = sourcePath || registeredProject?.sourcePath;

  await checkCodeGraphReady({ cpbRoot: cpbRootValue, sourcePath: typeof effectiveSourcePath === "string" ? effectiveSourcePath : "" });
  const maps = requireCapabilityMap(recordValue(registeredProject), sourceContextRecord);
  const riskMap = computeRiskMap({
    task,
    maps,
    project: registeredProject,
    workflow,
    planMode,
  });
  const dynamicAgentPlan = generateDynamicAgentPlan({ riskMap, workflow, planMode });

  await persistQueueRiskMap(hubRootValue, sourceContextRecord, riskMap, dynamicAgentPlan);
  return { riskMap, dynamicAgentPlan };
}
