/**
 * Artifact gate — verifies a required artifact exists before proceeding.
 *
 * Checks ctx.artifacts for a matching artifact of the expected kind.
 * Useful for ensuring a plan or deliverable exists before running
 * execute/verify phases.
 *
 * Context fields:
 *   artifacts: Array<{ kind: string, id: string, ... }>
 *   requiredArtifactKind: string (e.g. "plan", "deliverable")
 *   requiredArtifactId: string (optional, checks specific artifact)
 */

import { gatePassed, gateFailed } from "./gate-result.js";

function findArtifact(artifacts, kind, id) {
  if (!Array.isArray(artifacts)) return null;
  return artifacts.find((a) => {
    if (a.kind !== kind) return false;
    if (id && a.id !== id) return false;
    return true;
  }) ?? null;
}

const artifactGate = {
  type: "artifact",
  description: "Verifies a required artifact exists before proceeding",

  async evaluate(ctx) {
    const kind = ctx.requiredArtifactKind;
    if (!kind) {
      return gatePassed({
        gateType: "artifact",
        reason: "no artifact kind specified, skipping",
      });
    }

    const artifact = findArtifact(ctx.artifacts, kind, ctx.requiredArtifactId);

    if (artifact) {
      return gatePassed({
        gateType: "artifact",
        reason: `artifact "${kind}" found`,
        metadata: { artifactId: artifact.id, artifactKind: kind },
      });
    }

    const detail = ctx.requiredArtifactId
      ? `artifact "${kind}:${ctx.requiredArtifactId}" not found`
      : `no artifact of kind "${kind}" found`;

    return gateFailed({
      gateType: "artifact",
      reason: detail,
      metadata: {
        requiredKind: kind,
        requiredId: ctx.requiredArtifactId || null,
        availableArtifacts: Array.isArray(ctx.artifacts)
          ? ctx.artifacts.map((a) => `${a.kind}:${a.id}`)
          : [],
      },
    });
  },
};

export default artifactGate;
