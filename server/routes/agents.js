import { collectAgentMetrics, getAgentDetail, getAgentJobs } from "../services/agent-metrics.js";

export function agentRoutes(fastify, opts, done) {
  // GET /api/agents — list all registered agents with status
  fastify.get("/agents", async (req, reply) => {
    const metrics = await collectAgentMetrics(req.cpbRoot);
    return metrics;
  });

  // GET /api/agents/:name — single agent details
  fastify.get("/agents/:name", async (req, reply) => {
    const agent = await getAgentDetail(req.cpbRoot, req.params.name);
    if (!agent) return reply.code(404).send({ error: `Agent '${req.params.name}' not found` });
    return agent;
  });

  // GET /api/agents/:name/jobs — jobs for this agent
  fastify.get("/agents/:name/jobs", async (req, reply) => {
    const jobs = await getAgentJobs(req.cpbRoot, req.params.name);
    return { jobs };
  });

  // GET /api/agents/:name/metrics — aggregated metrics
  fastify.get("/agents/:name/metrics", async (req, reply) => {
    const agent = await getAgentDetail(req.cpbRoot, req.params.name);
    if (!agent) return reply.code(404).send({ error: `Agent '${req.params.name}' not found` });
    return { name: agent.name, jobs: agent.jobs, pool: agent.pool, timestamp: new Date().toISOString() };
  });

  done();
}
