type ConversationKeyInput = {
  project: unknown;
  jobId: unknown;
  attemptId?: unknown;
  role?: unknown;
};

function keyPart(value: unknown, fallback: string) {
  const text = typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
  return encodeURIComponent(text || fallback);
}

/**
 * Stable identity for one role's conversation inside one job attempt.
 *
 * A provider/agent name is intentionally not part of this key: provider
 * handoff may change the transport, but it must not silently merge two task
 * attempts or two cognitive roles into the same conversation.
 */
export function buildConversationKey({
  project,
  jobId,
  attemptId = null,
  role = "agent",
}: ConversationKeyInput) {
  return [
    "cpb",
    keyPart(project, "project"),
    keyPart(jobId, "job"),
    keyPart(attemptId, "attempt-0"),
    keyPart(role, "agent"),
  ].join(":");
}
