import { buildJobArtifactDetail } from "../services/job/job-projection.js";

export function registerJobArtifactDetailRoute(
  fastify: any,
  routePath: string,
  { projectParam = "project", resolveDataRoot }: { projectParam?: string; resolveDataRoot?: (req: any, project: string) => string | Promise<string> } = {},
) {
  fastify.get(routePath, async (req) => {
    const project = req.params[projectParam];
    const { jobId } = req.params;
    const dataRoot = resolveDataRoot ? await resolveDataRoot(req, project) : undefined;
    return buildJobArtifactDetail(req.cpbRoot, project, jobId, { dataRoot });
  });
}
