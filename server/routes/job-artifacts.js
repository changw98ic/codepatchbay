import { buildJobArtifactDetail } from "../services/job-artifact-detail.js";

export function registerJobArtifactDetailRoute(fastify, routePath, { projectParam, resolveDataRoot } = {}) {
  fastify.get(routePath, async (req) => {
    const project = req.params[projectParam];
    const { jobId } = req.params;
    const dataRoot = resolveDataRoot ? await resolveDataRoot(req, project) : undefined;
    return buildJobArtifactDetail(req.cpbRoot, project, jobId, { dataRoot });
  });
}
