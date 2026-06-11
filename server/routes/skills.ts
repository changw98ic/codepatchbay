import { extractSkillFromJob, reviewSkill, listExtractedSkills, loadActiveExtractedSkills } from "../services/prompt/prompt-resources.js";
import { getJob } from "../services/job/job-store.js";
import { getProject } from "../services/hub/hub-registry.js";

async function resolveProjectDataRoot(req: any, reply: any, projectId: string) {
  if (!req.cpbHubRoot) {
    reply.code(400).send({ error: "hub root required" });
    return null;
  }

  const project = await getProject(req.cpbHubRoot, projectId);
  if (!project) {
    reply.code(404).send({ error: `project not found: ${projectId}` });
    return null;
  }

  if (!project.projectRuntimeRoot) {
    reply.code(400).send({ error: `project runtime root required: ${projectId}` });
    return null;
  }

  return project.projectRuntimeRoot;
}

export function skillRoutes(fastify: any, _opts: any, done: () => void) {
  // GET /api/skills/:role — list extracted skills for a role
  fastify.get("/skills/:role", async (req, reply) => {
    const skills = await listExtractedSkills(req.cpbRoot, req.params.role);
    return { skills };
  });

  // GET /api/skills/:role/active — list only active skills
  fastify.get("/skills/:role/active", async (req, reply) => {
    const skills = await loadActiveExtractedSkills(req.cpbRoot, req.params.role);
    return { skills };
  });

  // POST /api/skills/extract — extract skill from a completed job
  fastify.post("/skills/extract", async (req, reply) => {
    const { project, jobId } = req.body;
    if (!project || !jobId) return reply.code(400).send({ error: "project and jobId required" });

    const dataRoot = await resolveProjectDataRoot(req, reply, project);
    if (!dataRoot) return;

    const job = await getJob(req.cpbRoot, project, jobId, { dataRoot });
    if (!job?.jobId) return reply.code(404).send({ error: "job not found" });

    const result = await extractSkillFromJob(req.cpbRoot, project, jobId, job);
    if (!result) return reply.code(204).send();
    return reply.code(201).send(result);
  });

  // POST /api/skills/:role/:fileName/review — approve or reject a draft skill
  fastify.post("/skills/:role/:fileName/review", async (req, reply) => {
    const { approve, reviewer } = req.body;
    if (approve === undefined) return reply.code(400).send({ error: "approve (boolean) required" });

    const result = await reviewSkill(req.cpbRoot, req.params.role, req.params.fileName, {
      approve: !!approve,
      reviewer: reviewer || "api",
    });
    if (!result) return reply.code(404).send({ error: "skill file not found" });
    return result;
  });

  done();
}
