import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  authenticateHubRequest,
  hubPrincipalHasScope,
  hubPrincipalCanAccessProject,
} from "../../shared/hub-auth.js";
import type { HubAuthConfig, HubPrincipal, HubScope } from "../../shared/hub-auth.js";

// --- authenticateHubRequest ---

describe("authenticateHubRequest", () => {
  test("returns local-anonymous when auth not required", () => {
    const config: HubAuthConfig = {
      required: false,
      sourceFile: null,
      sourceFingerprint: null,
      credentialCount: 0,
      credentials: [],
    };
    const result = authenticateHubRequest(null, config);
    assert.equal(result?.id, "local-anonymous");
    assert.deepEqual(result?.scopes, ["hub:admin"]);
    assert.equal(result?.projects, "*");
    assert.equal(result?.source, "local-anonymous");
  });

  test("returns null when auth required but no token", () => {
    const config: HubAuthConfig = {
      required: true,
      sourceFile: null,
      sourceFingerprint: null,
      credentialCount: 0,
      credentials: [],
    };
    assert.equal(authenticateHubRequest(null, config), null);
  });

  test("returns null for invalid bearer format", () => {
    const config: HubAuthConfig = {
      required: true,
      sourceFile: null,
      sourceFingerprint: null,
      credentialCount: 0,
      credentials: [],
    };
    assert.equal(authenticateHubRequest("Basic abc", config), null);
    assert.equal(authenticateHubRequest("Bearer", config), null);
    assert.equal(authenticateHubRequest("", config), null);
  });

  test("returns null for expired token", async () => {
    const { createHash } = await import("node:crypto");
    const token = "test-token-123";
    const digest = createHash("sha256").update(token, "utf8").digest();
    const config: HubAuthConfig = {
      required: true,
      sourceFile: "/tmp/tokens.json",
      sourceFingerprint: "fp",
      credentialCount: 1,
      credentials: [
        {
          digest,
          expiresAtMs: 1000, // expired long ago
          principal: {
            id: "test-user",
            scopes: ["hub:read"],
            projects: "*",
            source: "service-token-file",
            expiresAt: "1970-01-01T00:00:01.000Z",
          },
        },
      ],
    };
    assert.equal(authenticateHubRequest(`Bearer ${token}`, config, 2000), null);
  });

  test("returns principal for valid non-expired token", async () => {
    const { createHash } = await import("node:crypto");
    const token = "valid-token-456";
    const digest = createHash("sha256").update(token, "utf8").digest();
    const config: HubAuthConfig = {
      required: true,
      sourceFile: "/tmp/tokens.json",
      sourceFingerprint: "fp",
      credentialCount: 1,
      credentials: [
        {
          digest,
          expiresAtMs: null, // never expires
          principal: {
            id: "admin-user",
            scopes: ["hub:admin"],
            projects: "*",
            source: "service-token-file",
            expiresAt: null,
          },
        },
      ],
    };
    const result = authenticateHubRequest(`Bearer ${token}`, config);
    assert.equal(result?.id, "admin-user");
    assert.deepEqual(result?.scopes, ["hub:admin"]);
    assert.equal(result?.projects, "*");
  });
});

// --- hubPrincipalHasScope ---

describe("hubPrincipalHasScope", () => {
  function makePrincipal(scopes: HubScope[]): HubPrincipal {
    return { id: "test", scopes, projects: "*", source: "local-anonymous", expiresAt: null };
  }

  test("hub:admin grants all scopes", () => {
    const principal = makePrincipal(["hub:admin"]);
    assert.equal(hubPrincipalHasScope(principal, "hub:admin"), true);
    assert.equal(hubPrincipalHasScope(principal, "hub:read"), true);
    assert.equal(hubPrincipalHasScope(principal, "hub:health"), true);
  });

  test("hub:read grants hub:health", () => {
    const principal = makePrincipal(["hub:read"]);
    assert.equal(hubPrincipalHasScope(principal, "hub:health"), true);
    assert.equal(hubPrincipalHasScope(principal, "hub:read"), true);
    assert.equal(hubPrincipalHasScope(principal, "hub:admin"), false);
  });

  test("hub:health only grants hub:health", () => {
    const principal = makePrincipal(["hub:health"]);
    assert.equal(hubPrincipalHasScope(principal, "hub:health"), true);
    assert.equal(hubPrincipalHasScope(principal, "hub:read"), false);
    assert.equal(hubPrincipalHasScope(principal, "hub:admin"), false);
  });
});

// --- hubPrincipalCanAccessProject ---

describe("hubPrincipalCanAccessProject", () => {
  function makePrincipal(projects: "*" | string[]): HubPrincipal {
    return { id: "test", scopes: ["hub:read"], projects, source: "local-anonymous", expiresAt: null };
  }

  test("wildcard grants access to any project", () => {
    const principal = makePrincipal("*");
    assert.equal(hubPrincipalCanAccessProject(principal, "any-project"), true);
    assert.equal(hubPrincipalCanAccessProject(principal, ""), true);
  });

  test("specific project list grants access to listed projects", () => {
    const principal = makePrincipal(["project-a", "project-b"]);
    assert.equal(hubPrincipalCanAccessProject(principal, "project-a"), true);
    assert.equal(hubPrincipalCanAccessProject(principal, "project-b"), true);
    assert.equal(hubPrincipalCanAccessProject(principal, "project-c"), false);
  });

  test("wildcard projects returns true for non-string projectId", () => {
    const principal = makePrincipal("*");
    // wildcard projects grants access regardless of projectId type
    assert.equal(hubPrincipalCanAccessProject(principal, 123), true);
    assert.equal(hubPrincipalCanAccessProject(principal, null), true);
  });
});
