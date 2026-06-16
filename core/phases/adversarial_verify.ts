import { phasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { runAgent } from "../agents/agent-runner.js";
import { parseVerifierJson } from "../agents/response-parser.js";
import { writeArtifact } from "../artifacts/artifact-store.js";
import { writePromptArtifact, withPromptArtifactDiagnostics } from "../artifacts/prompt-artifact.js";

const JSON_INSTRUCTION = `

You MUST respond with ONLY a JSON envelope inside a code block. No text before or after.

Example response:
\`\`\`json
{
  "status": "ok",
  "verdict": "pass",
  "reason": "No exploitable verification gap remains",
  "details": "I attacked the assumptions around concurrency and provider fallback; the existing tests cover the risky paths.",
  "confidence": 0.9
}
\`\`\`

Rules:
- The response MUST be valid JSON inside a \`\`\`json code block
- Do NOT include any text outside the code block
- verdict MUST be exactly "pass", "fail", or "partial"
- Focus only on attack hypotheses, missing proof, and residual risk
- Do not implement fixes or edit files`;

export async function runAdversarialVerify(ctx: Record<string, any>) {
  const { project, cpbRoot, pool, sourcePath, jobId } = ctx;
  const { dataRoot } = ctx;
  const role = ctx.role || "adversarial_verifier";
  const prompt = await buildAdversarialPrompt(ctx) + JSON_INSTRUCTION;
  const resolvedAgent = resolveAgent(ctx, "codex");
  const promptArtifact = await writePromptArtifact(cpbRoot, {
    project,
    jobId,
    phase: "adversarial_verify",
    role,
    agent: resolvedAgent.agent,
    prompt,
    dataRoot,
  });

  const agentResult: Record<string, any> = await runAgent({
    role,
    ...resolvedAgent,
    project,
    jobId,
    prompt,
    cwd: sourcePath || cpbRoot,
    pool,
    timeoutMs: ctx.timeouts?.adversarial_verify ?? 0,
    scope: ctx.scope,
    env: ctx.env,
    dataRoot,
  });

  if (!agentResult.ok) {
    return phaseFailed({
      phase: "adversarial_verify",
      failure: failure({
        kind: agentResult.kind,
        phase: "adversarial_verify",
        reason: agentResult.reason,
        retryable: agentResult.retryable,
        exitCode: agentResult.exitCode,
        signal: agentResult.signal,
        cause: { ...(agentResult.cause || {}), adversarial: true },
      }),
      diagnostics: withPromptArtifactDiagnostics(agentResult.diagnostics, promptArtifact),
    });
  }

  const verdict: Record<string, unknown> = parseVerifierJson(agentResult.output) as Record<string, unknown>;
  if (!verdict.ok) {
    return phaseFailed({
      phase: "adversarial_verify",
      failure: failure({
        kind: FailureKind.VERDICT_INVALID,
        phase: "adversarial_verify",
        reason: verdict.reason,
        retryable: true,
        stderrSnippet: agentResult.output.slice(-500),
        cause: { adversarial: true },
      }),
      diagnostics: withPromptArtifactDiagnostics(agentResult.diagnostics, promptArtifact),
    });
  }

  const artifact = await writeArtifact(cpbRoot, {
    project,
    jobId,
    kind: "adversarial_verdict",
    content: renderAdversarialVerdictMarkdown(verdict, ctx.sourceContext?.riskMap),
    dataRoot,
    metadata: {
      ...verdict,
      adversarial: true,
      riskMap: ctx.sourceContext?.riskMap || null,
    },
  });

  const diagnostics = withPromptArtifactDiagnostics({
    ...agentResult.diagnostics,
    artifact,
    verdict,
    adversarialFocus: ctx.sourceContext?.riskMap?.adversarialFocus || [],
  }, promptArtifact);

  if (verdict.status !== "pass") {
    return phaseFailed({
      phase: "adversarial_verify",
      failure: failure({
        kind: FailureKind.VERIFICATION_FAILED,
        phase: "adversarial_verify",
        reason: verdict.reason || "adversarial verification failed",
        retryable: true,
        cause: {
          adversarial: true,
          verdict,
          artifact,
          focus: ctx.sourceContext?.riskMap?.adversarialFocus || [],
          fix_scope: verdict.fix_scope || verdict.fixScope || null,
        },
      }),
      diagnostics,
    });
  }

  return phasePassed({
    phase: "adversarial_verify",
    verdict: `VERDICT: ${verdict.status.toUpperCase()}`,
    artifact,
    diagnostics,
  } as { phase: string; artifact?: unknown; diagnostics?: Record<string, unknown>; verdict?: string });
}

function renderAdversarialVerdictMarkdown(verdict: Record<string, any>, riskMap: Record<string, any> | null = null) {
  const statusUpper = String(verdict.status || "unknown").toUpperCase();
  return `# Adversarial Verdict

VERDICT: ${statusUpper}

## Status
${statusUpper}

## Risk
${riskMap?.riskLevel || "unknown"}

## Reason
${verdict.reason || "N/A"}

## Details
${verdict.details || "N/A"}
`;
}

async function buildAdversarialPrompt(ctx: Record<string, any>) {
  if (typeof ctx.buildPrompt === "function") {
    return ctx.buildPrompt("adversarial_verify", ctx);
  }
  const riskMap = ctx.sourceContext?.riskMap || {};
  const verifyArtifact = ctx.previousResults?.findLast?.((result: Record<string, any>) => result.artifact?.kind === "verdict")?.artifact || null;
  return `You are an adversarial verifier. Try to disprove the ordinary verifier verdict without editing files.

Task: ${ctx.task}
Project: ${ctx.project}
Job: ${ctx.jobId}

Risk level: ${riskMap.riskLevel || "unknown"}
Risk domains: ${(riskMap.domains || []).join(", ") || "unknown"}
Focus: ${(riskMap.adversarialFocus || []).join(", ") || "verification gaps"}
Ordinary verify artifact: ${verifyArtifact?.name || "unavailable"}

Attack the assumptions, missing tests, unsafe provider/worktree state, and retry/remediation gaps.`;
}

function resolveAgent(ctx: Record<string, any>, fallback: string) {
  const role = ctx.role || "adversarial_verifier";
  const raw = ctx.agents?.[role] || ctx.agents?.adversarial_verifier || ctx.agents?.verifier || ctx.agent || fallback;
  if (typeof raw === "object" && raw !== null) return { agent: raw.agent || fallback, variant: raw.variant || null };
  return { agent: raw, variant: null };
}
