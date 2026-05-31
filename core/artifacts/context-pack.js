import { createArtifact, ArtifactKind } from "./canonical-artifact.js";

export function createContextPack({
  id,
  path: artifactPath,
  project,
  jobId,
  task = null,
  target = null,
  files = [],
  edges = [],
  graphStats = null,
  producerAgent = null,
  content = "",
}) {
  return {
    ...createArtifact({
      kind: ArtifactKind.CONTEXT_PACK,
      id,
      path: artifactPath,
      content,
      project,
      jobId,
      producerAgent,
    }),
    task,
    target,
    files,
    edges,
    graphStats,
  };
}
