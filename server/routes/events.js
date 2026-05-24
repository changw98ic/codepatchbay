import { ingestEvent, listCandidates, updateCandidate, githubIssueToCandidate, ciFailureToCandidate } from "../services/event-source.js";
import { scanCandidates, evaluateCandidate, checkProactiveBudget } from "../services/task-brain.js";
import { createJob } from "../services/job-store.js";

export function eventRoutes(fastify, opts, done) {
  // POST /api/events/ingest — ingest an external event
  fastify.post("/events/ingest", async (req, reply) => {
    const event = req.body;
    try {
      const result = await ingestEvent(req.cpbRoot, event);
      return reply.code(result.status === "duplicate" ? 200 : 201).send(result);
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // POST /api/events/github — ingest GitHub issue as candidate
  fastify.post("/events/github", async (req, reply) => {
    const { issue, projectId } = req.body;
    if (!issue) return reply.code(400).send({ error: "issue required" });
    const candidate = githubIssueToCandidate(issue, { projectId });
    const result = await ingestEvent(req.cpbRoot, candidate);
    return reply.code(result.status === "duplicate" ? 200 : 201).send(result);
  });

  // POST /api/events/ci-failure — ingest CI failure as candidate
  fastify.post("/events/ci-failure", async (req, reply) => {
    const { failure, projectId } = req.body;
    if (!failure) return reply.code(400).send({ error: "failure required" });
    const candidate = ciFailureToCandidate(failure, { projectId });
    const result = await ingestEvent(req.cpbRoot, candidate);
    return reply.code(result.status === "duplicate" ? 200 : 201).send(result);
  });

  // GET /api/events/candidates — list candidate events
  fastify.get("/events/candidates", async (req, reply) => {
    const { status, source } = req.query;
    const candidates = await listCandidates(req.cpbRoot, { status, source });
    return { candidates };
  });

  // PATCH /api/events/candidates/:id — update candidate status
  fastify.patch("/events/candidates/:id", async (req, reply) => {
    const { status, reason } = req.body;
    if (!status) return reply.code(400).send({ error: "status required" });
    const result = await updateCandidate(req.cpbRoot, req.params.id, { status, reason });
    if (!result) return reply.code(404).send({ error: "candidate not found" });
    return result;
  });

  // POST /api/proactive/scan — scan candidates and evaluate
  fastify.post("/proactive/scan", async (req, reply) => {
    const results = await scanCandidates(req.cpbRoot);
    return { evaluations: results };
  });

  // GET /api/proactive/budget — check proactive budget
  fastify.get("/proactive/budget", async (req, reply) => {
    const budget = await checkProactiveBudget(req.cpbRoot);
    return budget;
  });

  // POST /api/proactive/dispatch — create jobs from safe-auto candidates
  fastify.post("/proactive/dispatch", async (req, reply) => {
    const budget = await checkProactiveBudget(req.cpbRoot);
    if (!budget.allowed) {
      return reply.code(429).send({ error: budget.reason });
    }

    const evaluations = await scanCandidates(req.cpbRoot);
    const safeAuto = evaluations.filter((e) => e.recommendation.autoExecutable);

    if (safeAuto.length === 0) {
      return { dispatched: [], message: "no safe-auto candidates" };
    }

    const dispatched = [];
    for (const { candidate, recommendation } of safeAuto) {
      if (dispatched.length >= budget.remaining) break;

      try {
        const job = await createJob(req.cpbRoot, {
          project: candidate.projectId || recommendation.candidateId,
          task: recommendation.taskDescription,
          workflow: recommendation.recommendedWorkflow,
          sourceContext: {
            type: "proactive",
            candidateId: candidate.id,
            source: candidate.source,
            category: recommendation.category,
          },
        });

        await updateCandidate(req.cpbRoot, candidate.id, {
          status: "dispatched",
          reason: `job ${job.jobId}`,
        });

        dispatched.push({ candidateId: candidate.id, jobId: job.jobId, category: recommendation.category });
      } catch (err) {
        dispatched.push({ candidateId: candidate.id, error: err.message });
      }
    }

    return { dispatched };
  });

  done();
}
