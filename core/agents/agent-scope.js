export function poolClientKey({ role, agent, projectId, workspaceId, cwd, policyHash }) {
  if (role === "supervisor") return `supervisor:${agent}`;
  return ["execution", agent, projectId, workspaceId, cwd, policyHash].join("\0");
}
