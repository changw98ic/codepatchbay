import crypto from "node:crypto";
import { writeArtifact } from "./artifact-store.js";

const WEBHOOK_URL_PATTERN = /https?:\/\/[^\s"']*(?:webhook|hook|bot)[^\s"']*/gi;
const QUERY_SECRET_PATTERN = /([?&](?:token|secret|key|signature)=)[^&\s"']+/gi;
const GITHUB_URL_TOKEN_PATTERN = /https:\/\/x-access-token:[^@\s"']+@github\.com\/[^\s"']*/gi;

export async function writePromptArtifact(cpbRoot: string, { project, jobId, phase, role, agent, prompt }: { project: string; jobId: string; phase: string; role?: string; agent?: string; prompt: unknown }) {
  const rawContent = String(prompt);
  const content = redactPromptContent(rawContent);
  const rawSha256 = sha256(rawContent);
  const promptHash = sha256(content);
  return writeArtifact(cpbRoot, {
    project,
    jobId,
    kind: "prompt",
    content,
    metadata: {
      phase,
      role,
      agent,
      jobId,
      project,
      sha256: promptHash,
      rawSha256,
      redacted: content !== rawContent,
    },
  });
}

export function withPromptArtifactDiagnostics(diagnostics: Record<string, unknown> | null | undefined, promptArtifact: unknown) {
  return {
    ...(diagnostics || {}),
    promptArtifact: promptArtifact || null,
  };
}

function sha256(content: string) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function redactPromptContent(value: unknown) {
  return String(value || "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(GITHUB_URL_TOKEN_PATTERN, "[REDACTED_URL]")
    .replace(QUERY_SECRET_PATTERN, "$1[REDACTED]")
    .replace(/\bsk-(?:ant-)?[a-zA-Z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{8,}\b/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}/g, "[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{35}/g, "[REDACTED]")
    .replace(/\b([A-Za-z0-9_]*(?:api[_-]?key|auth[_-]?token|token|secret|password|credential)[A-Za-z0-9_]*)(\s*[:=]\s*)(['"]?)[^\s,'"&?]+/gi, "$1$2$3[REDACTED]")
    .replace(WEBHOOK_URL_PATTERN, "[REDACTED_URL]")
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}
