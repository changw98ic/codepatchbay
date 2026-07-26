import { readFile } from "node:fs/promises";
import type { LooseRecord } from "../../shared/types.js";
import { phasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { runAgent } from "../agents/agent-runner.js";
import { parsePlannerJson } from "../agents/response-parser.js";
import { writeArtifact } from "../artifacts/artifact-store.js";
import { writePromptArtifact, withPromptArtifactDiagnostics } from "../artifacts/prompt-artifact.js";
import { validatePlanMarkdown } from "../artifacts/validators.js";
import { classifyPoisonedSession } from "../engine/poisoned-session.js";
import { phaseExecutionContract } from "./prompt-contract.js";
import { buildPhaseAcpEnv } from "./phase-env.js";
import { extractTaskRequirementSlices } from "../workflow/checklist-build.js";

const JSON_INSTRUCTION = `

You MUST respond with ONLY a JSON envelope inside a code block. No text before or after.

Example response:
\`\`\`json
{
  "status": "ok",
  "planMarkdown": "## Analysis\\n- The task requires adding a new REST endpoint\\n\\n## Bounded Handoff\\n- Real actors: User model and users route\\n- Entrypoints: GET /users\\n- Bypass candidates: alternate user-list handlers\\n- Edit files: src/routes/api.js, src/models/user.js\\n- Verification targets: model unit test and route integration test\\n- Blockers: none\\n\\n## Files to modify\\n- src/routes/api.js (add GET /users endpoint)\\n- src/models/user.js (add findAll method)\\n\\n## Implementation Steps\\n1. Add findAll() to User model\\n2. Add GET /users route handler\\n3. Add input validation\\n\\n## Testing\\n- Unit test for findAll()\\n- Integration test for GET /users\\n\\n## Risks\\n- Large result sets may need pagination"
}
\`\`\`

Rules:
- The response MUST be valid JSON inside a \`\`\`json code block
- Do NOT include any text outside the code block
- The planMarkdown field must contain the full plan in markdown
- When a Bounded Handoff is required, include every exact label shown in the example inside that section; use \`none\` rather than omitting a label
- Do NOT write any files yourself. The system will persist the plan`;

type ResolvedAgent = {
  agent: string;
  variant: string | null;
};

const PLAN_CARRY_FORWARD_EVENT_LIMIT = 12;

function phaseAbortError(signal?: AbortSignal) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const err = new Error("plan phase aborted");
  err.name = "AbortError";
  return err;
}

function throwIfPhaseAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw phaseAbortError(signal);
}

function recordValue(value: unknown): LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function eventSummary(event: LooseRecord) {
  return {
    event: stringValue(event.event),
    title: stringValue(event.title),
    kind: stringValue(event.kind),
    status: stringValue(event.status),
    toolName: stringValue(event.toolName),
    toolCallId: stringValue(event.toolCallId),
    classification: stringValue(event.classification),
    reason: stringValue(event.reason).slice(0, 500),
  };
}

function compactSummary(summary: LooseRecord) {
  return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== ""));
}

function isReadOrSearchSummary(summary: LooseRecord) {
  const text = [summary.kind, summary.title, summary.toolName].map(String).join(" ");
  return /\b(?:read|search|grep|glob|find)\b/i.test(text);
}

async function planAuditCarryForward(diagnostics: LooseRecord): Promise<LooseRecord | null> {
  const auditFile = stringValue(diagnostics.acpAuditFile);
  if (!auditFile) return null;
  let raw = "";
  try {
    raw = await readFile(auditFile, "utf8");
  } catch {
    return { auditFile, unavailable: true };
  }
  const events: LooseRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(recordValue(JSON.parse(line)));
    } catch {
      // Ignore malformed audit lines; the audit file remains linked.
    }
  }
  const relevant = events
    .filter((event) => [
      "tool_call",
      "tool_blocked",
      "tool_budget_exceeded",
      "prompt_idle_timeout",
      "session_update_idle_timeout",
    ].includes(stringValue(event.event)))
    .map((event) => compactSummary(eventSummary(event)));
  const toolCalls = relevant.filter((event) => event.event === "tool_call");
  const readSearch = toolCalls.filter(isReadOrSearchSummary);
  const timeoutEvents = relevant.filter((event) => /timeout/i.test(stringValue(event.event)) || /timeout/i.test(stringValue(event.reason)));
  return {
    auditFile,
    eventCount: events.length,
    toolCallCount: toolCalls.length,
    readSearchCount: readSearch.length,
    toolCalls: toolCalls.slice(-PLAN_CARRY_FORWARD_EVENT_LIMIT),
    readSearchTools: readSearch.slice(-PLAN_CARRY_FORWARD_EVENT_LIMIT),
    terminalEvents: timeoutEvents.slice(-PLAN_CARRY_FORWARD_EVENT_LIMIT),
  };
}

function shouldClassifyPlanBoundedHandoffTimeout(ctx: LooseRecord, sourceContext: LooseRecord, failureKind: string) {
  return failureKind === FailureKind.TIMEOUT && requiresPlanBoundedHandoff(ctx, sourceContext);
}

function markdownSection(content: string, heading: RegExp) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line.trim()));
  if (start < 0) return "";
  const startLevel = (lines[start].match(/^#+/) || [""])[0].length;
  const sectionLines: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^(#{1,6})\s+/);
    if (match && match[1].length <= startLevel) break;
    sectionLines.push(line);
  }
  return sectionLines.join("\n");
}

function requiresPlanBoundedHandoff(ctx: LooseRecord, sourceContext: LooseRecord) {
  if (sourceContext.requireBoundedHandoff === false) return false;
  if (sourceContext.requireBoundedHandoff === true) return true;

  const workflow = stringValue(ctx.workflow);
  if (workflow !== "standard" && workflow !== "complex") return false;
  const planMode = stringValue(ctx.planMode, "full");
  if (planMode === "light" || planMode === "none" || planMode === "parent") return false;

  return Boolean(stringValue(ctx.sourcePath));
}

function validatePlanBoundedHandoff(content: string) {
  const section = markdownSection(content, /^#{1,6}\s+.*bounded handoff\b/i);
  if (!section.trim()) {
    return {
      ok: false,
      reason: "plan must include a Bounded Handoff section before execute",
      missingFields: ["Bounded Handoff"],
    };
  }

  const required = [
    { label: "real actors", pattern: /\breal\s+actors?\b/i },
    { label: "entrypoints", pattern: /\bentrypoints?\b/i },
    { label: "bypass candidates", pattern: /\bbypass(?:es|\s+candidates?)?\b/i },
    { label: "edit files", pattern: /\b(?:edit|modified?|target)\s+files?\b|\bfiles?\s+(?:to\s+)?(?:edit|modify|change)\b/i },
    { label: "verification targets", pattern: /\bverification\s+targets?\b/i },
    { label: "blockers", pattern: /\bblockers?\b/i },
  ];
  const missingFields = required
    .filter(({ pattern }) => !pattern.test(section))
    .map(({ label }) => label);
  if (missingFields.length) {
    return {
      ok: false,
      reason: `plan Bounded Handoff is missing required fields: ${missingFields.join(", ")}`,
      missingFields,
    };
  }

  return { ok: true, missingFields: [] };
}

export async function runPlan(ctx: LooseRecord) {
  throwIfPhaseAborted(ctx.signal as AbortSignal | undefined);
  const { task, project, cpbRoot, pool, sourcePath, jobId } = ctx;
  const { dataRoot } = ctx;
  const role = stringValue(ctx.role, "planner");

  // High-assurance jobs already completed their read-only plan tournament
  // before checklist scope was frozen. Reuse that immutable artifact so the
  // sequential DAG can preserve its normal plan -> execute dependency without
  // asking a new single planner to redefine the accepted scope.
  const assuranceTournament = recordValue(recordValue(ctx.sourceContext).assuranceTournament);
  const precomputedPlanArtifact = recordValue(assuranceTournament.planArtifact);
  if (stringValue(precomputedPlanArtifact.path)) {
    try {
      const planMarkdown = await readFile(stringValue(precomputedPlanArtifact.path), "utf8");
      const validation = recordValue(validatePlanMarkdown(planMarkdown));
      if (!validation.ok) throw new Error(stringValue(validation.reason, "precomputed plan is invalid"));
      if (requiresPlanBoundedHandoff(ctx, recordValue(ctx.sourceContext))) {
        const handoffValidation = recordValue(validatePlanBoundedHandoff(planMarkdown));
        if (!handoffValidation.ok) throw new Error(stringValue(handoffValidation.reason, "precomputed plan handoff is invalid"));
      }
      return phasePassed({
        phase: "plan",
        artifact: precomputedPlanArtifact,
        diagnostics: {
          assuranceMode: "high",
          precomputedPlan: true,
          tournamentDecision: recordValue(assuranceTournament.decision).decision || null,
          supportingArtifacts: assuranceTournament.supportingArtifacts || [],
        },
      });
    } catch (err) {
      return phaseFailed({
        phase: "plan",
        failure: failure({
          kind: FailureKind.ARTIFACT_INVALID,
          phase: "plan",
          reason: `precomputed high-assurance plan is unavailable: ${err instanceof Error ? err.message : String(err)}`,
          retryable: false,
          cause: { planArtifact: precomputedPlanArtifact },
        }),
      });
    }
  }

  // Build prompt — reuse existing prompt-builder if available, else minimal
  const prompt = await buildPlanPrompt(ctx) + JSON_INSTRUCTION;
  const resolvedAgent = resolveAgent(ctx, "codex");
  throwIfPhaseAborted(ctx.signal as AbortSignal | undefined);
  const promptArtifact = await writePromptArtifact(cpbRoot, {
    project,
    jobId,
    phase: "plan",
    role,
    agent: resolvedAgent.agent,
    prompt,
    dataRoot,
    signal: ctx.signal as AbortSignal | undefined,
  });

  const agentResult: LooseRecord = await runAgent({
    phase: "plan",
    role,
    ...resolvedAgent,
    project,
    jobId,
    prompt,
    cwd: sourcePath || cpbRoot,
    pool,
    timeoutMs: typeof recordValue(ctx.timeouts).plan === "number" ? recordValue(ctx.timeouts).plan : 0,
    scope: ctx.scope,
    env: buildPhaseAcpEnv(ctx, "plan"),
    dataRoot,
    onProgress: ctx.onProgress,
    signal: ctx.signal as AbortSignal | undefined,
  });

  throwIfPhaseAborted(ctx.signal as AbortSignal | undefined);
  if (!agentResult.ok) {
    const sourceContext = recordValue(ctx.sourceContext);
    const originalFailureKind = typeof agentResult.kind === "string" ? agentResult.kind : FailureKind.UNKNOWN;
    const diagnostics = recordValue(agentResult.diagnostics);
    const boundedHandoffTimeout = shouldClassifyPlanBoundedHandoffTimeout(ctx, sourceContext, originalFailureKind);
    const handoffCarryForward = boundedHandoffTimeout ? await planAuditCarryForward(diagnostics) : null;
    const failureKind = boundedHandoffTimeout ? FailureKind.PLAN_BOUNDED_HANDOFF_TIMEOUT : originalFailureKind;
    const reason = boundedHandoffTimeout
      ? `plan_bounded_handoff_timeout: plan timed out before producing the required Bounded Handoff; retry must reuse carry-forward static evidence and emit the handoff or a concrete blocker. Original reason: ${agentResult.reason}`
      : agentResult.reason;
    const cause = {
      ...recordValue(agentResult.cause),
      ...(boundedHandoffTimeout ? {
        originalFailureKind,
        originalReason: agentResult.reason,
        handoffCarryForward,
      } : {}),
    };
    return phaseFailed({
      phase: "plan",
      failure: failure({
        kind: failureKind,
        phase: "plan",
        reason,
        retryable: agentResult.retryable === true,
        exitCode: typeof agentResult.exitCode === "number" ? agentResult.exitCode : null,
        signal: stringValue(agentResult.signal) || null,
        cause,
      }),
      diagnostics: withPromptArtifactDiagnostics(diagnostics, promptArtifact),
    });
  }

  throwIfPhaseAborted(ctx.signal as AbortSignal | undefined);
  const parsed = recordValue(parsePlannerJson(agentResult.output));
  if (!parsed.ok) {
    return phaseFailed({
      phase: "plan",
      failure: failure({
        kind: FailureKind.AGENT_CONTRACT_INVALID,
        phase: "plan",
        reason: parsed.reason,
        retryable: true,
        stderrSnippet: stringValue(agentResult.output).slice(-500),
        cause: { rawOutput: stringValue(agentResult.output).slice(0, 2000) },
      }),
      diagnostics: withPromptArtifactDiagnostics(recordValue(agentResult.diagnostics), promptArtifact),
    });
  }

  const planMarkdown = stringValue(parsed.planMarkdown);
  const validation = recordValue(validatePlanMarkdown(planMarkdown));
  if (!validation.ok) {
    return phaseFailed({
      phase: "plan",
      failure: failure({
        kind: FailureKind.ARTIFACT_INVALID,
        phase: "plan",
        reason: validation.reason,
        retryable: true,
        cause: { rawOutput: planMarkdown.slice(0, 2000) },
      }),
      diagnostics: withPromptArtifactDiagnostics(recordValue(agentResult.diagnostics), promptArtifact),
    });
  }
  const sourceContext = recordValue(ctx.sourceContext);
  if (requiresPlanBoundedHandoff(ctx, sourceContext) && !classifyPoisonedSession(planMarkdown).poisoned) {
    const handoffValidation = recordValue(validatePlanBoundedHandoff(planMarkdown));
    if (!handoffValidation.ok) {
      return phaseFailed({
        phase: "plan",
        failure: failure({
          kind: FailureKind.ARTIFACT_INVALID,
          phase: "plan",
          reason: handoffValidation.reason,
          retryable: true,
          cause: {
            missingFields: stringArray(handoffValidation.missingFields),
            rawOutput: planMarkdown.slice(0, 2000),
          },
        }),
        diagnostics: withPromptArtifactDiagnostics(recordValue(agentResult.diagnostics), promptArtifact),
      });
    }
  }

  throwIfPhaseAborted(ctx.signal as AbortSignal | undefined);
  const artifact = await writeArtifact(cpbRoot, {
    signal: ctx.signal as AbortSignal | undefined,
    project,
    jobId,
    kind: "plan",
    content: planMarkdown,
    dataRoot,
    metadata: { task, agent: agentResult.agent },
  });

  return phasePassed({
    phase: "plan",
    artifact,
    diagnostics: withPromptArtifactDiagnostics(recordValue(agentResult.diagnostics), promptArtifact),
  });
}

async function buildPlanPrompt(ctx: LooseRecord) {
  const retrySection = buildRetrySection(recordValue(ctx.sourceContext));
  if (typeof ctx.buildPrompt === "function") {
    return await ctx.buildPrompt("plan", ctx) + retrySection;
  }

  const { task, project } = ctx;
  const explicitTaskRequirements = extractTaskRequirementSlices(task)
    .filter((slice) => slice.locator !== "task:0");
  const explicitTaskSection = explicitTaskRequirements.length > 0
    ? `\n\n## Explicit Structured Requirements\n${explicitTaskRequirements.map((slice) => `- ${slice.locator}: ${slice.text}`).join("\n")}\nTreat every entry as a separate acceptance obligation and cite it in the plan/checklist. Do not silently defer or collapse an explicit obligation.`
    : "";

  const sourceContext = recordValue(ctx.sourceContext);
  const checklist = sourceContext.acceptanceChecklist;
  const checklistArtifact = recordValue(sourceContext.acceptanceChecklistArtifact);
  if (checklist && !checklistArtifact.name) {
    throw new Error("plan received checklist context without an event-indexed artifact handle");
  }
  const checklistSection = checklist
    ? `\n\n## Frozen Acceptance Checklist\nThis checklist is the task contract. Do not silently mutate it. If it is wrong, report the issue in the plan risks.\n\n${JSON.stringify(checklist, null, 2)}`
    : "";

  let repoSection = "";
  if (ctx.sourcePath) {
    repoSection = `

## Repository
Use the local checked-out repository at: ${ctx.sourcePath}
Inspect the local checkout as the source of truth; do not depend on external repository pages.`;
  }

  let filesSection = "";
  const contextPack = recordValue(sourceContext.contextPack || sourceContext);
  const files = stringArray(contextPack.files);
  if (files.length) {
    filesSection = `

## Relevant Files
${files.map((f) => `- ${f}`).join("\n")}`;
  }

  return `You are a software planning agent. Create a detailed implementation plan for the following task:
${repoSection}${filesSection}

${phaseExecutionContract("plan")}${checklistSection}

## Task
${task}${explicitTaskSection}

## Project
${project}

The plan should include:
- Analysis of the task requirements
- Problem-space expansion: named real actors (classes/functions/routes/configs/users), suspected execution paths, and the real failing path the fix must reach
- Minimal repro vs real path: state what would only prove a small reproduction and what would prove the original task path
- Bypass candidates: subclasses, wrappers, adapters, alternate entrypoints, feature flags, caches, or caller paths that could avoid the intended fix
- Bounded Handoff: include this exact section and every label, using \`none\` rather than omitting any field:
  ## Bounded Handoff
  - Real actors: ...
  - Entrypoints: ...
  - Bypass candidates: ...
  - Edit files: ...
  - Verification targets: ...
  - Blockers: ...
- Files that need to be modified or created
- Implementation steps in order
- Testing strategy, including at least one proof that covers the real task path and not only an agent-authored minimal regression
- For versioned, phased, future/current, migration, or deprecation work, establish the checkout's applicable phase from repository-native version/changelog/whatsnew/config/test evidence. A commit date alone is not evidence; unresolved phase state must remain an explicit blocker or assumption.
- Potential risks and mitigations${retrySection}`;
}

function resolveAgent(ctx: LooseRecord, fallback: string) {
  const role = stringValue(ctx.role, "planner");
  const agents = recordValue(ctx.agents);
  const raw = agents[role] || agents.planner || ctx.agent || fallback;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const record = recordValue(raw);
    return { agent: stringValue(record.agent, fallback), variant: stringValue(record.variant) || null };
  }
  return { agent: stringValue(raw, fallback), variant: null };
}

function buildRetrySection(sourceContext: LooseRecord) {
  const retry = recordValue(sourceContext?.retry);
  if (Object.keys(retry).length === 0) return "";
  const handoffCarryForward = recordValue(retry.handoffCarryForward);
  const carryForwardSection = Object.keys(handoffCarryForward).length
    ? `\n\n## Carry-Forward Static Evidence\nThe previous plan attempt timed out before producing a bounded handoff. Reuse this already-collected static evidence; do not restart broad exploration. Complete the Bounded Handoff from it or state a concrete blocker.\n\n\`\`\`json\n${JSON.stringify(handoffCarryForward, null, 2)}\n\`\`\``
    : "";
  return `

## Previous Attempt Failed
Your previous plan was rejected. Fix the issue and provide a corrected response.

Error type: ${retry.failureKind}
Error: ${retry.failureReason}
Failure class: ${retry.failureClass || "unknown"}
Failure fingerprint: ${retry.failureFingerprint || "unavailable"}
Recovery strategy: ${retry.retryStrategy || "unavailable"}
Strategy changed: ${retry.strategyChanged === true ? "yes" : "no"}
${retry.retryClass ? `Repair class: ${retry.retryClass}` : ""}
${Array.isArray(retry.fixScope) && retry.fixScope.length > 0 ? `Fix scope: ${retry.fixScope.join(", ")}` : ""}
${retry.failureEvidence ? `Failure evidence:\n\`\`\`json\n${JSON.stringify(retry.failureEvidence, null, 2)}\n\`\`\`` : ""}
${retry.instruction ? `Repair instruction: ${retry.instruction}` : ""}
${retry.previousOutput ? `\nPrevious output for reference:\n\`\`\`\n${retry.previousOutput}\n\`\`\`` : ""}${carryForwardSection}`;
}
