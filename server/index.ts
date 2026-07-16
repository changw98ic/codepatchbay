#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertExplicitInsecureHttpOptIn,
  isLoopbackHost,
} from "../shared/network.js";
import {
  authenticateHubRequest,
  hubPrincipalCanAccessProject,
  hubPrincipalHasScope,
  openHubAuthProvider,
  type HubScope,
} from "../shared/hub-auth.js";
import { openHubOidcProvider } from "../shared/hub-oidc.js";
import { openHubRedisStateBackend } from "../shared/hub-state-redis.js";
import { assertHubWritable, recoverStaleHubMaintenance } from "../shared/hub-maintenance.js";
import { openHubAccessAudit, type HubAuditOutcome } from "./services/audit/hub-access-audit.js";
import { handleWorkerStateBroker, readWorkerBrokerBody } from "./services/hub/worker-state-broker.js";

import {
  getHubRuntime,
  listProjects,
  resolveHubRoot,
} from "./services/hub/hub-registry.js";

type HubServerOptions = {
  cpbRoot?: string;
  hubRoot?: string;
  host?: string;
  port?: number;
  bearerToken?: string;
  serviceTokensFile?: string;
  oidcConfigFile?: string;
  oidcFetcher?: typeof fetch;
  oidcNow?: () => number;
  accessAuditMaxBytes?: number;
  allowInsecureHttp?: boolean | string;
  allowAnonymousDev?: boolean | string;
};

type HubResponse = {
  statusCode: number;
  payload: unknown;
  headers?: Record<string, string>;
  requiredScope?: HubScope | null;
};

export type RunningHubServer = {
  close: () => Promise<void>;
  host: string;
  hubRoot: string;
  port: number;
  server: Server;
  url: string;
};

function parsePort(value: string | undefined) {
  const port = Number(value ?? "3456");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid CPB_PORT: ${value}`);
  }
  return port;
}

async function assertCpbRoot(cpbRoot: string) {
  await access(cpbRoot);
  const info = await stat(cpbRoot);
  if (!info.isDirectory()) throw new Error(`Invalid CPB_ROOT: ${cpbRoot}`);
}

function sendJson(reply: ServerResponse, statusCode: number, payload: unknown, headers: Record<string, string> = {}) {
  const body = `${JSON.stringify(payload)}\n`;
  reply.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  reply.end(body);
}

function bearerChallenge(error?: "invalid_token" | "insufficient_scope", scope?: HubScope) {
  let value = 'Bearer realm="CodePatchBay Hub"';
  if (error) value += `, error="${error}"`;
  if (scope) value += `, scope="${scope}"`;
  return value;
}

function responseErrorCode(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const code = (payload as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

function thrownErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function auditOutcome(statusCode: number): HubAuditOutcome {
  if (statusCode >= 200 && statusCode < 400) return "allowed";
  if (statusCode === 401) return "authentication_denied";
  if (statusCode === 403) return "authorization_denied";
  if (statusCode === 404) return "not_found";
  return "error";
}

function requestPath(rawUrl: string | undefined) {
  try {
    return new URL(rawUrl || "/", "http://localhost").pathname;
  } catch {
    return "/<invalid-url>";
  }
}

function listen(server: Server, port: number, host: string) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    // Do not let idle keep-alive sockets delay a controlled shutdown. Active
    // requests are still allowed to drain through server.close().
    server.closeIdleConnections?.();
  });
}

export async function startHubServer(options: HubServerOptions = {}): Promise<RunningHubServer> {
  const cpbRoot = path.resolve(options.cpbRoot || process.env.CPB_ROOT || path.resolve(import.meta.dirname, ".."));
  const hubRoot = path.resolve(options.hubRoot || resolveHubRoot(cpbRoot));
  const host = options.host || process.env.CPB_HOST || "127.0.0.1";
  const requestedPort = options.port ?? parsePort(process.env.CPB_PORT);
  const allowAnonymousDev = [true, "1", "true", "yes"].includes(
    options.allowAnonymousDev ?? process.env.CPB_HUB_ALLOW_ANONYMOUS_DEV ?? false,
  );
  if (allowAnonymousDev && !isLoopbackHost(host)) {
    throw new Error("CPB_HUB_ALLOW_ANONYMOUS_DEV is restricted to loopback development binds");
  }
  const oidcProvider = await openHubOidcProvider({
    configFile: options.oidcConfigFile ?? process.env.CPB_HUB_OIDC_CONFIG_FILE,
    hubRoot,
    fetcher: options.oidcFetcher,
    now: options.oidcNow,
  });
  const authProvider = await openHubAuthProvider({
    bearerToken: options.bearerToken ?? process.env.CPB_HUB_BEARER_TOKEN,
    serviceTokensFile: options.serviceTokensFile ?? process.env.CPB_HUB_SERVICE_TOKENS_FILE,
    hubRoot,
    requireAuthentication: oidcProvider.configured || !allowAnonymousDev,
  });
  const initialAuthConfig = authProvider.initial;

  if (initialAuthConfig.credentialCount === 0 && !oidcProvider.configured && !allowAnonymousDev) {
    throw new Error(
      "CPB Hub authentication is required; "
      + "configure CPB_HUB_BEARER_TOKEN, CPB_HUB_SERVICE_TOKENS_FILE, or CPB_HUB_OIDC_CONFIG_FILE",
    );
  }
  assertExplicitInsecureHttpOptIn(
    host,
    options.allowInsecureHttp ?? process.env.CPB_HUB_ALLOW_INSECURE_HTTP,
    "CPB_HUB_ALLOW_INSECURE_HTTP",
    "CPB Hub",
  );

  await assertCpbRoot(cpbRoot);
  const { recoverHubRedisMigration } = await import("./services/hub/hub-redis-migration.js");
  await recoverHubRedisMigration({
    hubRoot,
    configFile: process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
    backupSigningKey: process.env.CPB_HUB_BACKUP_SIGNING_KEY,
  });
  const { recoverInterruptedHubRestore } = await import("./services/hub/hub-backup.js");
  await recoverInterruptedHubRestore({
    hubRoot,
    signingKey: process.env.CPB_HUB_BACKUP_SIGNING_KEY,
  });
  await recoverStaleHubMaintenance(hubRoot);
  await assertHubWritable(hubRoot);
  const stateBackend = await openHubRedisStateBackend({
    configFile: process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
    hubRoot,
  });
  await stateBackend?.preflight();
  const runtime = getHubRuntime(cpbRoot, hubRoot);
  const accessAudit = await openHubAccessAudit({
    hubRoot,
    maxBytes: options.accessAuditMaxBytes,
    redisBackend: stateBackend,
  });

  const server = createServer(async (request, reply) => {
    const requestId = randomUUID();
    const startedAt = process.hrtime.bigint();
    let auditPath = requestPath(request.url);
    let principal: ReturnType<typeof authenticateHubRequest> = null;
    let response: HubResponse;
    try {
      const internalPath = requestPath(request.url);
      if (request.method === "POST" && internalPath === "/internal/worker-state") {
        const body = await readWorkerBrokerBody(request);
        const workerId = String(body.workerId || "");
        const auditWorkerId = /^[A-Za-z0-9._-]{1,120}$/.test(workerId)
          ? workerId
          : `sha256:${createHash("sha256").update(workerId, "utf8").digest("hex")}`;
        const operation = typeof body.op === "string" && /^[a-z][a-zA-Z]*(?:\.[a-zA-Z][a-zA-Z]*)+$/.test(body.op)
          ? body.op
          : "unknown";
        const attributeWorkerRequest = () => {
          principal = {
            id: `worker:${auditWorkerId}`,
            scopes: [],
            projects: [],
            source: "worker-broker",
            expiresAt: null,
          };
          auditPath = `/internal/worker-state/${operation}`;
        };
        const result = await handleWorkerStateBroker({
          cpbRoot,
          hubRoot,
          headers: request.headers,
          body,
          beforeMutation: async () => {
            attributeWorkerRequest();
            const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
            await accessAudit.append({
              requestId,
              method: request.method || "UNKNOWN",
              path: auditPath,
              statusCode: 202,
              outcome: "mutation_intent",
              principalId: principal?.id || null,
              principalSource: principal?.source || null,
              remoteAddress: request.socket.remoteAddress || null,
              requiredScope: null,
              errorCode: null,
              durationMs,
            });
          },
        });
        attributeWorkerRequest();
        response = { statusCode: 200, payload: { ok: true, result } };
      } else {
      let authenticationUnavailable: unknown = null;
      try {
        const authConfig = await authProvider.getConfig();
        principal = authenticateHubRequest(request.headers.authorization, authConfig);
      } catch (error) {
        if (thrownErrorCode(error) !== "HUB_AUTH_CONFIGURATION_UNAVAILABLE") throw error;
        authenticationUnavailable = error;
      }
      if (!principal) {
        try {
          const oidcConfig = await oidcProvider.getConfig();
          principal = await oidcProvider.authenticate(request.headers.authorization, oidcConfig);
        } catch (error) {
          const code = thrownErrorCode(error);
          if (code !== "HUB_OIDC_CONFIGURATION_UNAVAILABLE" && code !== "HUB_IDENTITY_PROVIDER_UNAVAILABLE") throw error;
          authenticationUnavailable ||= error;
        }
      }
      if (!principal && authenticationUnavailable) throw authenticationUnavailable;
      if (!principal) {
        response = {
          statusCode: 401,
          payload: {
            error: "unauthorized",
            code: "HUB_AUTHENTICATION_REQUIRED",
            message: "A valid Hub bearer token is required",
          },
          headers: {
            "www-authenticate": request.headers.authorization
              ? bearerChallenge("invalid_token")
              : bearerChallenge(),
          },
        };
      } else {
        const url = new URL(request.url || "/", "http://localhost");
        if (request.method === "GET" && url.pathname === "/api/auth/whoami") {
          response = { statusCode: 200, payload: principal };
        } else if (request.method === "GET" && url.pathname === "/api/health") {
          const requiredScope: HubScope = "hub:health";
          response = hubPrincipalHasScope(principal, requiredScope)
            ? {
              statusCode: 200,
              payload: {
                ok: true,
                status: "ok",
                uptimeMs: Math.round(process.uptime() * 1000),
              },
              requiredScope,
            }
            : {
              statusCode: 403,
              payload: {
                error: "forbidden",
                code: "HUB_SCOPE_REQUIRED",
                message: `Hub scope '${requiredScope}' is required`,
                requiredScope,
              },
              headers: { "www-authenticate": bearerChallenge("insufficient_scope", requiredScope) },
              requiredScope,
            };
        } else if (request.method === "GET" && url.pathname === "/api/projects") {
          const requiredScope: HubScope = "hub:read";
          if (!hubPrincipalHasScope(principal, requiredScope)) {
            response = {
              statusCode: 403,
              payload: {
                error: "forbidden",
                code: "HUB_SCOPE_REQUIRED",
                message: `Hub scope '${requiredScope}' is required`,
                requiredScope,
              },
              headers: { "www-authenticate": bearerChallenge("insufficient_scope", requiredScope) },
              requiredScope,
            };
          } else {
            const projects = await listProjects(hubRoot);
            response = {
              statusCode: 200,
              payload: projects.filter((project) => hubPrincipalCanAccessProject(principal!, project.id)),
              requiredScope,
            };
          }
        } else {
          response = {
            statusCode: 404,
            payload: { message: `Route ${request.method || "GET"}:${url.pathname} not found` },
          };
        }
      }
      }
    } catch (error) {
      const code = thrownErrorCode(error);
      if (code?.startsWith("HUB_WORKER_BROKER_")) {
        const statusCode = error && typeof error === "object" && "statusCode" in error
          ? Number(error.statusCode) : 500;
        response = {
          statusCode: Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 500,
          payload: {
            error: statusCode === 401 ? "unauthorized" : statusCode === 403 ? "forbidden" : "worker_broker_error",
            code,
            message: error instanceof Error ? error.message : "worker broker request failed",
            requestId,
          },
        };
      } else if (code === "HUB_AUTH_CONFIGURATION_UNAVAILABLE"
        || code === "HUB_OIDC_CONFIGURATION_UNAVAILABLE"
        || code === "HUB_IDENTITY_PROVIDER_UNAVAILABLE"
        || code === "HUB_STATE_BACKEND_CONFIGURATION_UNAVAILABLE"
        || code === "HUB_STATE_BACKEND_UNAVAILABLE"
        || code === "HUB_STATE_BACKEND_NOT_PRIMARY"
        || code === "HUB_REGISTRY_INVALID"
        || code === "HUB_QUEUE_INVALID"
        || code === "HUB_QUEUE_TOO_LARGE"
        || code === "HUB_QUEUE_MIGRATION_REQUIRED"
        || code === "HUB_ASSIGNMENT_MIGRATION_REQUIRED"
        || code === "HUB_WORKER_MIGRATION_REQUIRED"
        || code === "HUB_LEASE_MIGRATION_REQUIRED"
        || code === "HUB_JOB_MIGRATION_REQUIRED"
        || code === "HUB_LEADER_INVALID"
        || code === "HUB_LEADER_PROCESS_RESTART_REQUIRED"
        || code === "HUB_STATE_RECORD_INVALID"
        || code === "HUB_STATE_RECORD_TOO_LARGE") {
        const message = code === "HUB_AUTH_CONFIGURATION_UNAVAILABLE"
          ? "Hub authentication configuration is unavailable"
          : code === "HUB_OIDC_CONFIGURATION_UNAVAILABLE"
            ? "Hub OIDC configuration is unavailable"
            : code === "HUB_IDENTITY_PROVIDER_UNAVAILABLE"
              ? "Hub identity provider is unavailable"
              : code === "HUB_STATE_BACKEND_CONFIGURATION_UNAVAILABLE"
                ? "Hub state backend configuration is unavailable"
                : "Hub state backend is unavailable";
        response = {
          statusCode: 503,
          payload: {
            error: "service_unavailable",
            code,
            message,
            requestId,
          },
          headers: { "retry-after": "5" },
        };
      } else if (code === "HUB_BACKUP_REDIS_SNAPSHOT_REQUIRED" || code === "HUB_RESTORE_REDIS_SNAPSHOT_REQUIRED") {
        response = {
          statusCode: 409,
          payload: {
            error: "external_snapshot_required",
            code,
            message: "Redis authority must be snapshotted or restored through the Redis service",
            requestId,
          },
        };
      } else if (code === "HUB_QUEUE_CONFLICT" || code === "HUB_STATE_RECORD_CONFLICT" || code === "HUB_LEADER_FENCED") {
        response = {
          statusCode: 409,
          payload: {
            error: "state_conflict",
            code,
            message: "Hub state changed before the request could commit",
            requestId,
          },
        };
      } else {
        console.error(`[hub-request] ${requestId}: ${error instanceof Error ? error.message : String(error)}`);
        response = {
          statusCode: 500,
          payload: {
            error: "internal_error",
            code: "HUB_INTERNAL_ERROR",
            message: "Hub request processing failed",
            requestId,
          },
        };
      }
    }

    const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    try {
      await accessAudit.append({
        requestId,
        method: request.method || "UNKNOWN",
        path: auditPath,
        statusCode: response.statusCode,
        outcome: auditOutcome(response.statusCode),
        principalId: principal?.id || null,
        principalSource: principal?.source || null,
        remoteAddress: request.socket.remoteAddress || null,
        requiredScope: response.requiredScope || null,
        errorCode: responseErrorCode(response.payload),
        durationMs,
      });
    } catch (error) {
      console.error(`[hub-access-audit] ${requestId}: ${error instanceof Error ? error.message : String(error)}`);
      response = {
        statusCode: 503,
        payload: {
          error: "service_unavailable",
          code: "HUB_ACCESS_AUDIT_UNAVAILABLE",
          message: "Hub access audit is unavailable",
          requestId,
        },
        headers: { "retry-after": "5" },
      };
    }

    reply.setHeader("x-cpb-request-id", requestId);
    if (principal) reply.setHeader("x-cpb-principal-id", principal.id);
    sendJson(reply, response.statusCode, response.payload, response.headers);
  });

  try {
    await listen(server, requestedPort, host);
  } catch (error) {
    await accessAudit.close();
    throw error;
  }
  try {
    await runtime.persist();
  } catch (error) {
    await closeServer(server).catch(() => {});
    await accessAudit.close();
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server).catch(() => {});
    await accessAudit.close();
    throw new Error("Hub server did not expose a TCP address");
  }

  let closing: Promise<void> | null = null;
  return {
    server,
    host,
    hubRoot,
    port: address.port,
    url: `http://${host}:${address.port}`,
    close: () => {
      if (!closing) {
        closing = (async () => {
          const errors: unknown[] = [];
          await closeServer(server).catch((error) => errors.push(error));
          await accessAudit.close().catch((error) => errors.push(error));
          await runtime.markDead().catch((error) => errors.push(error));
          if (errors.length > 0) throw new AggregateError(errors, "Hub shutdown did not complete cleanly");
        })();
      }
      return closing;
    },
  };
}

async function main() {
  const hub = await startHubServer();
  console.log(`CodePatchbay Hub running at ${hub.url}`);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down...`);
    try {
      await hub.close();
      process.exitCode = 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
