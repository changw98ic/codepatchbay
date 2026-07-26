import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  assertGithubRemoteWriteAuthorized,
  decodeGithubRemoteCapability,
  encodeGithubRemoteCapability,
  normalizeGithubRemoteCapability,
  reconcileGithubRemoteFinalization,
  verifyGithubRemoteWriteCommitted,
  type GithubRemoteRunCommand,
} from "../server/services/github/github-remote-capability.js";

function capability(overrides: Record<string, unknown> = {}) {
  return {
    schema: "cpb.github-remote-capability.v1",
    repository: "example/cpb-disposable",
    repositoryId: "R_disposable",
    defaultBranch: "main",
    markerPath: ".cpb-disposable-target.json",
    markerSha: "a".repeat(40),
    issueNumber: 17,
    automationLabel: "cpb-e2e",
    allowedBranchPrefix: "cpb-release-rehearsal/",
    permissions: {
      repositoryPush: true,
      pullRequestCreate: true,
      pullRequestMerge: true,
      issueClose: true,
    },
    ...overrides,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
}

function capabilityDigest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(normalizeGithubRemoteCapability(value))), "utf8")
    .digest("hex");
}

function assertCapabilityEvidence(
  value: unknown,
  expectedCapability: Record<string, unknown> = capability(),
) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  const evidence = value as Record<string, unknown>;
  const normalized = normalizeGithubRemoteCapability(expectedCapability);
  assert.equal(evidence.repository, normalized.repository);
  assert.equal(evidence.repositoryId, normalized.repositoryId);
  assert.equal(evidence.issueNumber, normalized.issueNumber);
  assert.equal(evidence.capabilityDigest, capabilityDigest(normalized));
}

function marker(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    purpose: "codepatchbay-release-rehearsal",
    repository: "example/cpb-disposable",
    disposable: true,
    allowCodePatchBayE2E: true,
    allowedIssueNumbers: [17],
    allowedAutomationLabels: ["cpb-e2e"],
    allowedBranchPrefix: "cpb-release-rehearsal/",
    allowRepositoryPush: true,
    allowDraftPullRequests: true,
    allowPullRequestMerge: true,
    allowIssueClose: true,
    ...overrides,
  };
}

function pullRequestRest(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    state: "open",
    draft: true,
    title: "[cpb] Exact reviewed change",
    body: "Exact reviewed body\n",
    html_url: "https://github.com/example/cpb-disposable/pull/7",
    user: { login: "cpb-bot", id: 91 },
    head: {
      ref: "cpb-release-rehearsal/job-17",
      sha: "d".repeat(40),
      repo: { full_name: "example/cpb-disposable" },
    },
    base: {
      ref: "main",
      repo: { full_name: "example/cpb-disposable" },
    },
    ...overrides,
  };
}

function authorizedRunCommand({
  defaultBranch = "main",
  markerSha = "a".repeat(40),
  markerOverrides = {},
  refSha = "d".repeat(40),
  issueState = "OPEN",
  issueLabels = [{ name: "cpb-e2e" }],
  issueNumber = 17,
  issueUrl = "https://github.com/example/cpb-disposable/issues/17",
}: {
  defaultBranch?: string;
  markerSha?: string;
  markerOverrides?: Record<string, unknown>;
  refSha?: string;
  issueState?: string;
  issueLabels?: unknown[];
  issueNumber?: unknown;
  issueUrl?: string;
} = {}): GithubRemoteRunCommand {
  return async (command, args) => {
    assert.equal(command, "gh");
    if (args[0] === "repo") {
      return {
        stdout: JSON.stringify({
          id: "R_disposable",
          nameWithOwner: "example/cpb-disposable",
          defaultBranchRef: { name: defaultBranch },
        }),
      };
    }
    if (args[0] === "api" && String(args[1]).includes("/contents/")) {
      return {
        stdout: JSON.stringify({
          path: ".cpb-disposable-target.json",
          sha: markerSha,
          content: Buffer.from(JSON.stringify(marker(markerOverrides)), "utf8").toString("base64"),
        }),
      };
    }
    if (args[0] === "api" && args[1] === "user") {
      return { stdout: JSON.stringify({ login: "cpb-bot", id: 91 }) };
    }
    if (args[0] === "api" && String(args[1]).includes("/git/ref/heads/")) {
      const encodedBranch = String(args[1]).split("/git/ref/heads/")[1] || "main";
      return {
        stdout: JSON.stringify({
          ref: `refs/heads/${decodeURIComponent(encodedBranch)}`,
          object: { sha: refSha },
        }),
      };
    }
    if (args[0] === "issue" && args[1] === "view") {
      return {
        stdout: JSON.stringify({ number: issueNumber, state: issueState, labels: issueLabels, url: issueUrl }),
      };
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
}

test("GitHub remote capability encoding round-trips an exact immutable authority", () => {
  const normalized = normalizeGithubRemoteCapability(capability());
  assert.equal(normalized.repository, "example/cpb-disposable");
  assert.equal(normalized.issueNumber, 17);
  assert.deepEqual(decodeGithubRemoteCapability(encodeGithubRemoteCapability(normalized)), normalized);
});

test("GitHub remote capability revalidates repository, marker, issue, label, branch, and operation", async () => {
  const evidence = await assertGithubRemoteWriteAuthorized({
    capability: capability(),
    operation: "repository.push",
    repository: "example/cpb-disposable",
    issueNumber: 17,
    targetBranch: "main",
    pushKind: "default-branch",
  }, { runCommand: authorizedRunCommand() });

  assert.equal(evidence.repositoryId, "R_disposable");
  assert.equal(evidence.markerSha, "a".repeat(40));
  assert.equal(evidence.operation, "repository.push");
  assertCapabilityEvidence(evidence);
});

test("GitHub remote capability rejects repository drift before a remote write", async () => {
  await assert.rejects(
    assertGithubRemoteWriteAuthorized({
      capability: capability(),
      operation: "issue.close",
      repository: "example/cpb-disposable",
      issueNumber: 17,
    }, { runCommand: authorizedRunCommand({ defaultBranch: "successor" }) }),
    /identity or default branch changed/,
  );
});

test("GitHub remote capability rejects issue or label drift before a remote write", async () => {
  await assert.rejects(
    assertGithubRemoteWriteAuthorized({
      capability: capability(),
      operation: "issue.close",
      repository: "example/cpb-disposable",
      issueNumber: 17,
    }, { runCommand: authorizedRunCommand({ issueLabels: [{ name: "unrelated" }] }) }),
    /identity, state, or automation label changed/,
  );

  await assert.rejects(
    assertGithubRemoteWriteAuthorized({
      capability: capability(),
      operation: "issue.close",
      repository: "example/cpb-disposable",
      issueNumber: 17,
    }, { runCommand: authorizedRunCommand({ issueLabels: [{ name: 17 }] }) }),
    /invalid issue label/,
  );
});

test("GitHub remote capability rejects non-canonical or coercible issue identities before a write", async () => {
  for (const options of [
    { issueUrl: "https://github.com/attacker/foreign/issues/17" },
    { issueUrl: "https://github.com/example/cpb-disposable/pull/17" },
    { issueNumber: "17" },
  ]) {
    await assert.rejects(
      assertGithubRemoteWriteAuthorized({
        capability: capability(),
        operation: "issue.close",
        repository: "example/cpb-disposable",
        issueNumber: 17,
      }, { runCommand: authorizedRunCommand(options) }),
      /invalid issue (?:identity|number)/,
    );
  }
});

test("GitHub remote capability requires both disposable and CodePatchBay E2E marker safety switches", async () => {
  for (const markerOverrides of [
    { disposable: false },
    { allowCodePatchBayE2E: false },
  ]) {
    await assert.rejects(
      assertGithubRemoteWriteAuthorized({
        capability: capability(),
        operation: "repository.push",
        repository: "example/cpb-disposable",
        issueNumber: 17,
        targetBranch: "main",
        pushKind: "default-branch",
      }, { runCommand: authorizedRunCommand({ markerOverrides }) }),
      /must explicitly/,
    );
  }
});

test("GitHub remote capability rejects coercible issue-number marker entries", async () => {
  await assert.rejects(
    assertGithubRemoteWriteAuthorized({
      capability: capability(),
      operation: "repository.push",
      repository: "example/cpb-disposable",
      issueNumber: 17,
      targetBranch: "main",
      pushKind: "default-branch",
    }, {
      runCommand: authorizedRunCommand({ markerOverrides: { allowedIssueNumbers: ["17"] } }),
    }),
    /positive safe integers/,
  );
});

test("GitHub PR-create authority binds the exact remote head SHA before submission", async () => {
  await assert.rejects(
    assertGithubRemoteWriteAuthorized({
      capability: capability(),
      operation: "pull_request.create",
      repository: "example/cpb-disposable",
      issueNumber: 17,
      headBranch: "cpb-release-rehearsal/job-17",
      baseBranch: "main",
      commit: "d".repeat(40),
      title: "[cpb] Exact reviewed change",
      body: "Exact reviewed body\n",
      draft: true,
    }, {
      runCommand: authorizedRunCommand({ refSha: "e".repeat(40) }),
    }),
    /head branch moved/,
  );
});

test("GitHub PR-create authority and readback preserve the bound transport principal", async () => {
  const principal = {
    kind: "github_app" as const,
    stableId: "501",
    login: "cpb-test[bot]",
    authorId: "91",
  };
  const baseRunner = authorizedRunCommand();
  let ambientActorReads = 0;
  const runCommand: GithubRemoteRunCommand = async (command, args, options) => {
    if (args[0] === "api" && args[1] === "user") ambientActorReads += 1;
    return baseRunner(command, args, options);
  };
  const request = {
    capability: capability(),
    operation: "pull_request.create" as const,
    repository: "example/cpb-disposable",
    issueNumber: 17,
    headBranch: "cpb-release-rehearsal/job-17",
    baseBranch: "main",
    commit: "d".repeat(40),
    title: "[cpb] Exact reviewed change",
    body: "Exact reviewed body\n",
    draft: true,
  };
  const authority = await assertGithubRemoteWriteAuthorized(request, { runCommand, principal });
  const authorityRecord = authority as Record<string, unknown>;
  assert.equal(ambientActorReads, 0);
  assert.equal(authorityRecord.authorLogin, principal.login);
  assert.equal(authorityRecord.authorId, principal.authorId);
  assert.deepEqual(authorityRecord.principal, principal);

  const verification = await verifyGithubRemoteWriteCommitted({
    ...request,
    pullRequestNumber: 7,
    authorLogin: principal.login,
    authorId: principal.authorId,
  }, {
    principal,
    runCommand: async () => ({ stdout: JSON.stringify(pullRequestRest({
      user: { login: principal.login, id: Number(principal.authorId) },
    })) }),
  });
  assert.equal(verification.committed, true);
  assert.deepEqual(verification.principal, principal);
  assertCapabilityEvidence(verification.evidence);
});

test("GitHub remote capability cannot treat a PR head push as default-branch finalization", async () => {
  let commandCalls = 0;
  await assert.rejects(
    assertGithubRemoteWriteAuthorized({
      capability: capability(),
      operation: "repository.push",
      repository: "example/cpb-disposable",
      issueNumber: 17,
      targetBranch: "cpb-release-rehearsal/job-17",
      pushKind: "default-branch",
    }, {
      runCommand: async () => {
        commandCalls += 1;
        return { stdout: "{}" };
      },
    }),
    /must push the bound default branch/,
  );
  assert.equal(commandCalls, 0);
});

test("GitHub remote capability rejects a fulfilled non-zero status before revalidation continues", async () => {
  let commandCalls = 0;
  await assert.rejects(
    assertGithubRemoteWriteAuthorized({
      capability: capability(),
      operation: "issue.close",
      repository: "example/cpb-disposable",
      issueNumber: 17,
    }, {
      runCommand: async () => {
        commandCalls += 1;
        return {
          status: 1,
          stdout: JSON.stringify({
            id: "R_disposable",
            nameWithOwner: "example/cpb-disposable",
            defaultBranchRef: { name: "main" },
          }),
        };
      },
    }),
    /exited with status 1/,
  );
  assert.equal(commandCalls, 1);
});

test("GitHub merge authority cannot be transplanted to another pull request", async () => {
  const mergeCapability = capability({
    pullRequest: {
      number: 7,
      headBranch: "cpb-release-rehearsal/job-17",
      baseBranch: "main",
      headSha: "d".repeat(40),
    },
  });
  let commandCalls = 0;
  await assert.rejects(
    assertGithubRemoteWriteAuthorized({
      capability: mergeCapability,
      operation: "pull_request.merge",
      repository: "example/cpb-disposable",
      issueNumber: 17,
      pullRequestNumber: 8,
      headBranch: "cpb-release-rehearsal/job-17",
      baseBranch: "main",
      commit: "d".repeat(40),
    }, {
      runCommand: async () => {
        commandCalls += 1;
        return { stdout: "{}" };
      },
    }),
    /outside the bound capability/,
  );
  assert.equal(commandCalls, 0);
});

test("GitHub merge authority revalidates the bound pull request identity immediately before merge", async () => {
  const mergeCapability = capability({
    pullRequest: {
      number: 7,
      headBranch: "cpb-release-rehearsal/job-17",
      baseBranch: "main",
      headSha: "d".repeat(40),
    },
  });
  const baseRunCommand = authorizedRunCommand();
  const commands: string[] = [];
  await assert.rejects(
    assertGithubRemoteWriteAuthorized({
      capability: mergeCapability,
      operation: "pull_request.merge",
      repository: "example/cpb-disposable",
      issueNumber: 17,
      pullRequestNumber: 7,
      headBranch: "cpb-release-rehearsal/job-17",
      baseBranch: "main",
      commit: "d".repeat(40),
    }, {
      runCommand: async (command, args, options) => {
        commands.push(String(args[0]));
        if (args[0] === "pr") {
          return {
            stdout: JSON.stringify({
              number: 7,
              state: "OPEN",
              headRefName: "cpb-release-rehearsal/job-17",
              baseRefName: "main",
              headRefOid: "e".repeat(40),
            }),
          };
        }
        return baseRunCommand(command, args, options);
      },
    }),
    /head SHA changed before merge/,
  );
  assert.deepEqual(commands, ["repo", "api", "issue", "pr"]);
});

test("GitHub remote post-condition reports committed true, false, or null without guessing", async () => {
  const request = {
    capability: capability(),
    operation: "repository.push" as const,
    repository: "example/cpb-disposable",
    issueNumber: 17,
    targetBranch: "main",
    pushKind: "default-branch" as const,
    commit: "b".repeat(40),
  };
  const committed = await verifyGithubRemoteWriteCommitted(request, {
    runCommand: async () => ({
      stdout: JSON.stringify({ ref: "refs/heads/main", object: { sha: "b".repeat(40) } }),
    }),
  });
  assert.equal(committed.committed, true);
  assertCapabilityEvidence(committed.evidence);

  const notCommitted = await verifyGithubRemoteWriteCommitted(request, {
    runCommand: async () => ({
      stdout: JSON.stringify({ ref: "refs/heads/main", object: { sha: "c".repeat(40) } }),
    }),
  });
  assert.equal(notCommitted.committed, false);

  const unknown = await verifyGithubRemoteWriteCommitted(request, {
    runCommand: async () => {
      throw new Error("reply lost");
    },
  });
  assert.equal(unknown.committed, null);

  const wrongRef = await verifyGithubRemoteWriteCommitted(request, {
    runCommand: async () => ({
      stdout: JSON.stringify({ ref: "refs/heads/foreign", object: { sha: "b".repeat(40) } }),
    }),
  });
  assert.equal(wrongRef.committed, false);

  let transplantedCalls = 0;
  const transplanted = await verifyGithubRemoteWriteCommitted({
    ...request,
    repository: "attacker/foreign",
  }, {
    runCommand: async () => {
      transplantedCalls += 1;
      return { stdout: "{}" };
    },
  });
  assert.equal(transplanted.committed, null);
  assert.equal(transplantedCalls, 0);
});

test("GitHub remote post-conditions preserve unknown truth for missing or non-object response schemas", async () => {
  const pushRequest = {
    capability: capability(),
    operation: "repository.push" as const,
    repository: "example/cpb-disposable",
    issueNumber: 17,
    targetBranch: "main",
    pushKind: "default-branch" as const,
    commit: "b".repeat(40),
  };
  const missingPushRef = await verifyGithubRemoteWriteCommitted(pushRequest, {
    runCommand: async () => ({ stdout: "{}" }),
  });
  assert.equal(missingPushRef.committed, null);

  const arrayResponse = await verifyGithubRemoteWriteCommitted(pushRequest, {
    runCommand: async () => ({ stdout: "[]" }),
  });
  assert.equal(arrayResponse.committed, null);

  const missingPrState = await verifyGithubRemoteWriteCommitted({
    capability: capability(),
    operation: "pull_request.create",
    repository: "example/cpb-disposable",
    issueNumber: 17,
    pullRequestNumber: 7,
    headBranch: "cpb-release-rehearsal/job-17",
    baseBranch: "main",
    commit: "d".repeat(40),
    title: "[cpb] Exact reviewed change",
    body: "Exact reviewed body\n",
    draft: true,
    authorLogin: "cpb-bot",
    authorId: "91",
  }, {
    runCommand: async () => ({
      stdout: JSON.stringify({
        number: 7,
      }),
    }),
  });
  assert.equal(missingPrState.committed, null);

  const missingIssueState = await verifyGithubRemoteWriteCommitted({
    capability: capability(),
    operation: "issue.close",
    repository: "example/cpb-disposable",
    issueNumber: 17,
  }, {
    runCommand: async () => ({
      stdout: JSON.stringify({
        number: 17,
        url: "https://github.com/example/cpb-disposable/issues/17",
      }),
    }),
  });
  assert.equal(missingIssueState.committed, null);
});

test("GitHub remote post-conditions distinguish complete mismatch from unknown truth", async () => {
  const prRequest = {
    capability: capability(),
    operation: "pull_request.create" as const,
    repository: "example/cpb-disposable",
    issueNumber: 17,
    pullRequestNumber: 7,
    headBranch: "cpb-release-rehearsal/job-17",
    baseBranch: "main",
    commit: "d".repeat(40),
    title: "[cpb] Exact reviewed change",
    body: "Exact reviewed body\n",
    draft: true,
    authorLogin: "cpb-bot",
    authorId: "91",
  };
  const draftOpen = await verifyGithubRemoteWriteCommitted(prRequest, {
    runCommand: async () => ({
      stdout: JSON.stringify(pullRequestRest()),
    }),
  });
  assert.equal(draftOpen.committed, true);
  assertCapabilityEvidence(draftOpen.evidence);

  for (const mismatch of [
    { head: { ref: "cpb-release-rehearsal/job-17", sha: "e".repeat(40), repo: { full_name: "example/cpb-disposable" } } },
    { title: "[cpb] Successor change" },
    { html_url: "https://github.com/attacker/foreign/pull/7" },
    { body: "successor body\n" },
    { user: { login: "attacker", id: 666 } },
  ]) {
    const mismatched = await verifyGithubRemoteWriteCommitted(prRequest, {
      runCommand: async () => ({
        stdout: JSON.stringify(pullRequestRest(mismatch)),
      }),
    });
    assert.equal(mismatched.committed, false);
  }

  const readyOpen = await verifyGithubRemoteWriteCommitted(prRequest, {
    runCommand: async () => ({
      stdout: JSON.stringify(pullRequestRest({ draft: false })),
    }),
  });
  assert.equal(readyOpen.committed, false);

  const closed = await verifyGithubRemoteWriteCommitted({
    capability: capability(),
    operation: "issue.close",
    repository: "example/cpb-disposable",
    issueNumber: 17,
  }, {
    runCommand: async () => ({
      stdout: JSON.stringify({
        number: 17,
        state: "CLOSED",
        url: "https://github.com/example/cpb-disposable/issues/17",
      }),
    }),
  });
  assert.equal(closed.committed, true);
  assertCapabilityEvidence(closed.evidence);

  for (const invalidIssue of [
    { number: "17", state: "CLOSED", url: "https://github.com/example/cpb-disposable/issues/17" },
    { number: 17, state: "CLOSED", url: "https://github.com/attacker/foreign/issues/17" },
    { number: 17, state: "CLOSED", url: "https://github.com/example/cpb-disposable/pull/17" },
  ]) {
    const invalidIdentity = await verifyGithubRemoteWriteCommitted({
      capability: capability(),
      operation: "issue.close",
      repository: "example/cpb-disposable",
      issueNumber: 17,
    }, {
      runCommand: async () => ({ stdout: JSON.stringify(invalidIssue) }),
    });
    assert.equal(invalidIdentity.committed, null);
  }
});

test("GitHub PR creation discovery uniquely binds the complete generation and retries empty reads", async () => {
  const request = {
    capability: capability(),
    operation: "pull_request.create" as const,
    repository: "example/cpb-disposable",
    issueNumber: 17,
    headBranch: "cpb-release-rehearsal/job-17",
    baseBranch: "main",
    commit: "d".repeat(40),
    title: "[cpb] Exact reviewed change",
    body: "Exact reviewed body\n",
    draft: true,
    authorLogin: "cpb-bot",
    authorId: "91",
  };
  let query = "";
  const unique = await verifyGithubRemoteWriteCommitted(request, {
    runCommand: async (_command, args) => {
      query = String(args[args.length - 1]);
      assert.ok(args.includes("--paginate"));
      assert.ok(args.includes("--slurp"));
      return { stdout: JSON.stringify([[pullRequestRest()]]) };
    },
  });
  assert.equal(unique.committed, true);
  assertCapabilityEvidence(unique.evidence);
  assert.match(query, /state=all/);
  assert.match(query, /head=example%3Acpb-release-rehearsal%2Fjob-17/);
  assert.match(query, /base=main/);
  assert.equal(unique.evidence?.matchCount, 1);
  assert.equal((unique.evidence?.pullRequest as Record<string, unknown>).bodyMatches, true);
  assert.equal(Object.hasOwn(unique.evidence?.pullRequest as object, "body"), false);

  let emptyReads = 0;
  const absent = await verifyGithubRemoteWriteCommitted(request, {
    runCommand: async () => {
      emptyReads += 1;
      return { stdout: "[[]]" };
    },
  });
  assert.equal(absent.committed, null);
  assert.equal(emptyReads, 3);
  assert.equal(absent.evidence?.readCount, 3);
});

test("GitHub PR creation discovery never guesses across mismatched or duplicate candidates", async () => {
  const request = {
    capability: capability(),
    operation: "pull_request.create" as const,
    repository: "example/cpb-disposable",
    issueNumber: 17,
    headBranch: "cpb-release-rehearsal/job-17",
    baseBranch: "main",
    commit: "d".repeat(40),
    title: "[cpb] Exact reviewed change",
    body: "Exact reviewed body\n",
    draft: true,
    authorLogin: "cpb-bot",
    authorId: "91",
  };
  const mismatched = await verifyGithubRemoteWriteCommitted(request, {
    runCommand: async () => ({
      stdout: JSON.stringify([[pullRequestRest({ user: { login: "attacker", id: 666 } })]]),
    }),
  });
  assert.equal(mismatched.committed, null);
  assert.equal(mismatched.evidence?.candidateCount, 1);

  const duplicate = await verifyGithubRemoteWriteCommitted(request, {
    runCommand: async () => ({
      stdout: JSON.stringify([[
        pullRequestRest(),
        pullRequestRest({ number: 8, html_url: "https://github.com/example/cpb-disposable/pull/8" }),
      ]]),
    }),
  });
  assert.equal(duplicate.committed, null);
  assert.equal(duplicate.evidence?.matchCount, 2);

  const invalid = await verifyGithubRemoteWriteCommitted(request, {
    runCommand: async () => ({ stdout: "{}" }),
  });
  assert.equal(invalid.committed, null);
});

test("unknown runtime operations fail closed instead of falling through to issue.close", async () => {
  let authorityCalls = 0;
  await assert.rejects(
    assertGithubRemoteWriteAuthorized({
      capability: capability(),
      operation: "typo" as any,
      repository: "example/cpb-disposable",
      issueNumber: 17,
    }, {
      runCommand: async () => {
        authorityCalls += 1;
        return { stdout: "{}" };
      },
    }),
    /unknown GitHub remote write operation/,
  );
  assert.equal(authorityCalls, 0);

  let verifierCalls = 0;
  const verification = await verifyGithubRemoteWriteCommitted({
    capability: capability(),
    operation: "typo" as any,
    repository: "example/cpb-disposable",
    issueNumber: 17,
  }, {
    runCommand: async () => {
      verifierCalls += 1;
      return { stdout: "{}" };
    },
  });
  assert.equal(verification.committed, null);
  assert.equal(verifierCalls, 0);
});

test("remote finalization reconciliation observes historical truth without current write authority", async () => {
  const calls: string[] = [];
  const reconciliationCapability = capability({
    permissions: {
      repositoryPush: false,
      pullRequestCreate: false,
      pullRequestMerge: false,
      issueClose: false,
    },
  });
  const result = await reconcileGithubRemoteFinalization({
    capability: reconciliationCapability,
    repository: "example/cpb-disposable",
    issueNumber: 17,
    targetBranch: "main",
    commit: "d".repeat(40),
  }, {
    runCommand: async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (args[0] === "repo") {
        return { stdout: JSON.stringify({
          id: "R_disposable",
          nameWithOwner: "example/cpb-disposable",
          defaultBranchRef: { name: "main" },
        }) };
      }
      if (args[0] === "issue") {
        return { stdout: JSON.stringify({
          number: 17,
          state: "CLOSED",
          labels: [],
          url: "https://github.com/example/cpb-disposable/issues/17",
        }) };
      }
      if (args[0] === "api" && String(args[1]).includes("/git/ref/heads/")) {
        return { stdout: JSON.stringify({
          ref: "refs/heads/main",
          object: { sha: "d".repeat(40) },
        }) };
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    },
  });

  assert.deepEqual(
    { committed: result.committed, pushed: result.pushed, closed: result.closed, next: result.nextOperation },
    { committed: true, pushed: true, closed: true, next: null },
  );
  assert.equal(calls.some((call) => call.includes("/contents/")), false);
  assert.equal(calls.some((call) => call.includes("labels")), false);
  assertCapabilityEvidence(result.evidence, reconciliationCapability);
});

test("GitHub verification proofs bind the exact capability and cannot be replayed across repositories", async () => {
  const primaryCapability = capability();
  const foreignCapability = capability({
    repository: "example/cpb-other",
    repositoryId: "R_other",
    issueNumber: 23,
  });
  const verifyPush = (boundCapability: Record<string, unknown>) => verifyGithubRemoteWriteCommitted({
    capability: boundCapability,
    operation: "repository.push",
    repository: String(boundCapability.repository),
    issueNumber: Number(boundCapability.issueNumber),
    targetBranch: "main",
    pushKind: "default-branch",
    commit: "b".repeat(40),
  }, {
    runCommand: async () => ({
      stdout: JSON.stringify({ ref: "refs/heads/main", object: { sha: "b".repeat(40) } }),
    }),
  });

  const primary = await verifyPush(primaryCapability);
  const foreign = await verifyPush(foreignCapability);
  assert.equal(primary.committed, true);
  assert.equal(foreign.committed, true);
  assertCapabilityEvidence(primary.evidence, primaryCapability);
  assertCapabilityEvidence(foreign.evidence, foreignCapability);
  assert.notEqual(primary.evidence?.repository, foreign.evidence?.repository);
  assert.notEqual(primary.evidence?.repositoryId, foreign.evidence?.repositoryId);
  assert.notEqual(primary.evidence?.issueNumber, foreign.evidence?.issueNumber);
  assert.notEqual(primary.evidence?.capabilityDigest, foreign.evidence?.capabilityDigest);
});

test("remote finalization reconciliation never treats a missing or successor ref as permission to push again", async () => {
  const successor = await reconcileGithubRemoteFinalization({
    capability: capability(),
    repository: "example/cpb-disposable",
    issueNumber: 17,
    targetBranch: "main",
    commit: "d".repeat(40),
  }, { runCommand: authorizedRunCommand({ refSha: "e".repeat(40), issueState: "OPEN" }) });
  assert.equal(successor.committed, null);
  assert.equal(successor.pushed, null);
  assert.equal(successor.closed, false);
  assert.equal(successor.nextOperation, null);

  const missing = await reconcileGithubRemoteFinalization({
    capability: capability(),
    repository: "example/cpb-disposable",
    issueNumber: 17,
    targetBranch: "main",
    commit: "d".repeat(40),
  }, {
    runCommand: async (command, args) => {
      if (args[0] === "repo") return authorizedRunCommand()(command, args);
      if (args[0] === "issue") return authorizedRunCommand({ issueState: "CLOSED" })(command, args);
      if (args[0] === "api" && String(args[1]).includes("/git/ref/heads/")) {
        throw new Error("HTTP 404 ref missing");
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    },
  });
  assert.equal(missing.committed, null);
  assert.equal(missing.pushed, null);
  assert.equal(missing.closed, true);
  assert.equal(missing.nextOperation, null);
});

test("remote finalization reconciliation advances only from an exact pushed ref", async () => {
  const open = await reconcileGithubRemoteFinalization({
    capability: capability(),
    repository: "example/cpb-disposable",
    issueNumber: 17,
    targetBranch: "main",
    commit: "d".repeat(40),
  }, { runCommand: authorizedRunCommand({ refSha: "d".repeat(40), issueState: "OPEN" }) });
  assert.deepEqual(
    { committed: open.committed, pushed: open.pushed, closed: open.closed, next: open.nextOperation },
    { committed: false, pushed: true, closed: false, next: "issue.close" },
  );
});

test("remote finalization reconciliation preserves independent ref and issue truth", async () => {
  const issueUnreadable = await reconcileGithubRemoteFinalization({
    capability: capability(),
    repository: "example/cpb-disposable",
    issueNumber: 17,
    targetBranch: "main",
    commit: "d".repeat(40),
  }, {
    runCommand: async (command, args) => {
      if (args[0] === "issue") throw new Error("issue read unavailable");
      return authorizedRunCommand({ refSha: "d".repeat(40) })(command, args);
    },
  });
  assert.equal(issueUnreadable.committed, null);
  assert.equal(issueUnreadable.pushed, true);
  assert.equal(issueUnreadable.closed, null);
  assert.equal(issueUnreadable.nextOperation, null);

  const refUnreadable = await reconcileGithubRemoteFinalization({
    capability: capability(),
    repository: "example/cpb-disposable",
    issueNumber: 17,
    targetBranch: "main",
    commit: "d".repeat(40),
  }, {
    runCommand: async (command, args) => {
      if (args[0] === "api" && String(args[1]).includes("/git/ref/heads/")) {
        throw new Error("ref read unavailable");
      }
      return authorizedRunCommand({ issueState: "CLOSED" })(command, args);
    },
  });
  assert.equal(refUnreadable.committed, null);
  assert.equal(refUnreadable.pushed, null);
  assert.equal(refUnreadable.closed, true);
  assert.equal(refUnreadable.nextOperation, null);
});
