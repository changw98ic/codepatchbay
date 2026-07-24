import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  rehearseDisposableDraftPr,
  runDisposableDraftPrCli,
  writeEvidenceFile,
} from "../scripts/rehearse-disposable-draft-pr.js";
import {
  JsonWriteRecoveryError,
  withFsUtilsTestHooks,
} from "../shared/fs-utils.js";
import { tempRoot } from "./helpers.js";

function fixedNow() {
  return new Date("2026-07-20T00:00:00.000Z");
}

function marker(repository = "safe/disposable", sha = "a".repeat(40)) {
  return JSON.stringify({
    path: ".cpb-disposable-target.json",
    sha,
    content: Buffer.from(JSON.stringify({
      schemaVersion: 1,
      purpose: "codepatchbay-release-rehearsal",
      repository,
      disposable: true,
      allowDraftPullRequests: true,
      allowPullRequestClose: true,
      allowBranchDeletion: true,
      allowedBranchPrefix: "cpb-release-rehearsal/",
      allowedPayloadPrefix: ".cpb-release-rehearsals/",
    })).toString("base64"),
  });
}

const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const BASE_TREE_SHA = "b".repeat(40);
const ANCHOR_BLOB_SHA = "1".repeat(40);
const PAYLOAD_BLOB_SHA = "2".repeat(40);
const ANCHOR_TREE_SHA = "3".repeat(40);
const PAYLOAD_TREE_SHA = "4".repeat(40);
const ANCHOR_COMMIT_SHA = "e".repeat(40);
const PAYLOAD_COMMIT_SHA = "c".repeat(40);

function branchRef(branch: string, sha = BASE_SHA) {
  return JSON.stringify({ ref: `refs/heads/${branch}`, object: { sha } });
}

function draftPullRequest(id: string, number: number, sha = PAYLOAD_COMMIT_SHA) {
  const branch = `cpb-release-rehearsal/${id}`;
  return JSON.stringify({
    number,
    html_url: `https://github.com/safe/disposable/pull/${number}`,
    draft: true,
    state: "open",
    title: `CodePatchBay disposable draft PR rehearsal ${id}`,
    head: { ref: branch, sha },
    base: { ref: "main" },
  });
}

function createRunner(
  handlers: Array<(command: string, args: string[], options?: { signal?: AbortSignal }) => unknown>,
  {
    autoRevalidation = true,
    effectiveOrigin,
  }: {
    autoRevalidation?: boolean;
    effectiveOrigin?: string;
  } = {},
) {
  const calls: Array<{ command: string; args: string[]; signalAborted?: boolean }> = [];
  let repositoryViewCount = 0;
  let markerReadCount = 0;
  let graphQlDeleteStarted = false;
  let branchRefSha: string | null = null;
  let cachedPullRequest: Record<string, unknown> | null = null;
  let configuredOrigin = "git@github.com:source/repo.git";
  let blobCreateCount = 0;
  let treeCreateCount = 0;
  let commitCreateCount = 0;
  const blobs = new Map<string, string>();
  const trees = new Map<string, { path: string; blobSha: string }>();
  const commits = new Map<string, { treeSha: string; parentSha: string; message: string }>();
  const runCommand = async (command: string, args: string[], options?: { signal?: AbortSignal }) => {
    calls.push({ command, args, signalAborted: options?.signal?.aborted });
    const endpoint = args[1] || "";
    const isRepositoryView = command === "gh" && args[0] === "repo" && args[1] === "view";
    const isMarkerRead = command === "gh" && args[0] === "api" && endpoint.includes("/contents/.cpb-disposable-target.json?");
    if (autoRevalidation && command === "git" && args[0] === "remote" && args[1] === "get-url") {
      return { stdout: `${effectiveOrigin || configuredOrigin}\n`, stderr: "" };
    }
    if (autoRevalidation && isRepositoryView && repositoryViewCount++ > 0) {
      return { stdout: JSON.stringify({ id: "R_safe", defaultBranchRef: { name: "main" } }), stderr: "" };
    }
    if (autoRevalidation && isMarkerRead && markerReadCount++ > 0) {
      return { stdout: marker(), stderr: "" };
    }
    if (autoRevalidation && command === "gh" && args[0] === "api" && endpoint === `repos/safe/disposable/git/commits/${BASE_SHA}`) {
      return {
        stdout: JSON.stringify({ sha: BASE_SHA, tree: { sha: BASE_TREE_SHA }, parents: [], message: "base" }),
        stderr: "",
      };
    }
    if (autoRevalidation && command === "gh" && args[0] === "api" && endpoint.endsWith("/git/blobs") && args.includes("POST")) {
      const sha = blobCreateCount++ === 0 ? ANCHOR_BLOB_SHA : PAYLOAD_BLOB_SHA;
      const content = String(args.find((arg) => arg.startsWith("content=")) || "").slice(8);
      blobs.set(sha, content);
      return { stdout: JSON.stringify({ sha }), stderr: "" };
    }
    if (autoRevalidation && command === "gh" && args[0] === "api" && endpoint.includes("/git/blobs/") && args.includes("GET")) {
      const sha = endpoint.split("/git/blobs/")[1];
      return { stdout: JSON.stringify({ sha, encoding: "base64", content: blobs.get(sha) || "" }), stderr: "" };
    }
    if (autoRevalidation && command === "gh" && args[0] === "api" && endpoint.endsWith("/git/trees") && args.includes("POST")) {
      const sha = treeCreateCount++ === 0 ? ANCHOR_TREE_SHA : PAYLOAD_TREE_SHA;
      const payloadPath = String(args.find((arg) => arg.startsWith("tree[][path]=")) || "").slice(13);
      const blobSha = String(args.find((arg) => arg.startsWith("tree[][sha]=")) || "").slice(12);
      trees.set(sha, { path: payloadPath, blobSha });
      return { stdout: JSON.stringify({ sha }), stderr: "" };
    }
    if (autoRevalidation && command === "gh" && args[0] === "api" && endpoint.includes("/git/trees/") && args.includes("GET")) {
      const sha = endpoint.split("/git/trees/")[1].split("?")[0];
      const tree = trees.get(sha);
      return {
        stdout: JSON.stringify({
          sha,
          truncated: false,
          tree: tree ? [{ path: tree.path, mode: "100644", type: "blob", sha: tree.blobSha }] : [],
        }),
        stderr: "",
      };
    }
    if (autoRevalidation && command === "gh" && args[0] === "api" && endpoint.endsWith("/git/commits") && args.includes("POST")) {
      const sha = commitCreateCount++ === 0 ? ANCHOR_COMMIT_SHA : PAYLOAD_COMMIT_SHA;
      const treeSha = String(args.find((arg) => arg.startsWith("tree=")) || "").slice(5);
      const parentSha = String(args.find((arg) => arg.startsWith("parents[]=")) || "").slice(10);
      const message = String(args.find((arg) => arg.startsWith("message=")) || "").slice(8);
      commits.set(sha, { treeSha, parentSha, message });
      return { stdout: JSON.stringify({ sha }), stderr: "" };
    }
    if (autoRevalidation && command === "gh" && args[0] === "api" && endpoint.includes("/git/commits/") && args.includes("GET")) {
      const sha = endpoint.split("/git/commits/")[1];
      const commit = commits.get(sha);
      if (!commit) throw new Error(`unknown test commit ${sha}`);
      return {
        stdout: JSON.stringify({
          sha,
          tree: { sha: commit.treeSha },
          parents: [{ sha: commit.parentSha }],
          message: commit.message,
        }),
        stderr: "",
      };
    }
    if (autoRevalidation
      && command === "gh"
      && args[0] === "api"
      && endpoint.includes("/git/ref/heads/cpb-release-rehearsal/")
      && args.includes("GET")) {
      if (!branchRefSha) throw new Error("test branch is unexpectedly absent");
      const branch = endpoint.split("/git/ref/heads/")[1];
      return {
        stdout: JSON.stringify({ ref: `refs/heads/${branch}`, object: { sha: branchRefSha } }),
        stderr: "",
      };
    }
    if (autoRevalidation
      && command === "gh"
      && args[0] === "api"
      && endpoint.includes("/pulls/")
      && args.includes("GET")) {
      if (!cachedPullRequest) throw new Error("test pull request identity is unavailable");
      return { stdout: JSON.stringify(cachedPullRequest), stderr: "" };
    }
    if (autoRevalidation
      && command === "gh"
      && args[0] === "api"
      && endpoint.includes("/git/matching-refs/heads/")
      && !graphQlDeleteStarted) {
      const branch = endpoint.split("/git/matching-refs/heads/")[1];
      return {
        stdout: branchRefSha
          ? JSON.stringify([{ ref: `refs/heads/${branch}`, object: { sha: branchRefSha } }])
          : "[]",
        stderr: "",
      };
    }
    const handler = handlers.shift();
    if (!handler) throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    const result = await handler(command, args, options);
    if (result instanceof Error) throw result;
    const normalized = typeof result === "string"
      ? { stdout: result, stderr: "" }
      : result as { stdout?: string; stderr?: string };
    let stdout = String(normalized.stdout || "");
    if (autoRevalidation && command === "git" && args[0] === "config" && args.includes("remote.origin.url")) {
      configuredOrigin = stdout.trim() || configuredOrigin;
    }
    if (autoRevalidation && command === "gh" && args[0] === "api" && endpoint.endsWith("/git/refs") && args.includes("POST")) {
      branchRefSha = String(args.find((arg) => arg.startsWith("sha=")) || "").slice(4);
      const parsed = JSON.parse(stdout || "{}");
      parsed.object = { sha: branchRefSha };
      stdout = JSON.stringify(parsed);
    }
    if (autoRevalidation && command === "gh" && args[0] === "api" && endpoint.includes("/.cpb-release-rehearsals/") && args.includes("PUT")) {
      branchRefSha = PAYLOAD_COMMIT_SHA;
      const parsed = JSON.parse(stdout || "{}");
      parsed.commit = { sha: branchRefSha };
      stdout = JSON.stringify(parsed);
    }
    if (autoRevalidation && command === "gh" && args[0] === "api" && endpoint.endsWith("/pulls") && args.includes("POST") && stdout) {
      const parsed = JSON.parse(stdout);
      const branch = String(args.find((arg) => arg.startsWith("head=")) || "").slice(5);
      const base = String(args.find((arg) => arg.startsWith("base=")) || "").slice(5);
      const title = String(args.find((arg) => arg.startsWith("title=")) || "").slice(6);
      const body = String(args.find((arg) => arg.startsWith("body=")) || "").slice(5);
      parsed.head = {
        ...(parsed.head || {}),
        ref: branch,
        sha: branchRefSha,
        repo: { full_name: "safe/disposable" },
      };
      parsed.base = { ...(parsed.base || {}), ref: base };
      parsed.title = title;
      parsed.body = body;
      cachedPullRequest = parsed;
      stdout = JSON.stringify(parsed);
    } else if (autoRevalidation && command === "gh" && args[0] === "api" && endpoint.includes("/pulls/") && !args.includes("PATCH") && stdout) {
      const parsed = JSON.parse(stdout);
      cachedPullRequest = {
        ...(cachedPullRequest || {}),
        ...parsed,
        head: (cachedPullRequest as { head?: unknown } | null)?.head,
        base: (cachedPullRequest as { base?: unknown } | null)?.base,
        title: (cachedPullRequest as { title?: unknown } | null)?.title,
      };
      stdout = JSON.stringify(cachedPullRequest);
    } else if (autoRevalidation && command === "gh" && args[0] === "api" && endpoint.includes("/pulls/") && args.includes("PATCH") && stdout) {
      const parsed = JSON.parse(stdout);
      cachedPullRequest = { ...(cachedPullRequest || {}), ...parsed };
      stdout = JSON.stringify(cachedPullRequest);
    }
    if (autoRevalidation && command === "gh" && args[0] === "api" && endpoint.endsWith("/pulls") && args.includes("GET") && stdout) {
      const branch = String(args.find((arg) => arg.startsWith("head=")) || "").split(":").slice(1).join(":");
      const id = branch.split("/").at(-1) || "";
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed)) {
        const identified = parsed.map((pullRequest) => ({
          ...pullRequest,
          head: {
            ...(pullRequest.head || {}),
            ref: branch,
            sha: branchRefSha,
            repo: { full_name: "safe/disposable" },
          },
          base: { ...(pullRequest.base || {}), ref: "main" },
          title: `CodePatchBay disposable draft PR rehearsal ${id}`,
          body: `Automated disposable draft PR rehearsal generation ${id} on ${branch}. This PR must be closed by the rehearsal script.`,
        }));
        if (identified.length === 1) cachedPullRequest = identified[0];
        stdout = JSON.stringify(identified);
      }
    }
    if (autoRevalidation && command === "gh" && args[0] === "api" && endpoint === "graphql") {
      const clientMutationId = String(args.find((arg) => arg.startsWith("clientMutationId=")) || "").slice(17);
      const afterOid = String(args.find((arg) => arg.startsWith("afterOid=")) || "").slice(9);
      if (afterOid === "0".repeat(40)) {
        graphQlDeleteStarted = true;
        branchRefSha = null;
      } else {
        branchRefSha = afterOid;
      }
      stdout = JSON.stringify({ data: { updateRefs: { clientMutationId } } });
    }
    return { ...normalized, stdout };
  };
  return { calls, runCommand };
}

type MutationOutcome = "ok" | "error" | "commit_then_error" | "malformed_after_commit";

type ScenarioRunnerOptions = {
  id: string;
  configuredOrigins?: string[];
  fetchOrigins?: string[];
  pushOrigins?: string[];
  markerRepository?: string;
  initialBranchSha?: string | null;
  branchCreateOutcome?: MutationOutcome;
  payloadUpdateOutcome?: MutationOutcome | "cas_conflict_successor";
  pullRequestCreateOutcome?: MutationOutcome;
  pullRequestCloseOutcome?: MutationOutcome;
  branchDeleteOutcome?: MutationOutcome;
  successorSha?: string;
  repositoryIdentityChangesAt?: number;
  markerChangesAt?: number;
  afterPullRequestPostBranchSha?: string | null;
  afterMainPullRequestReadBranchSha?: string | null;
  pullRequestDiscoveryPage?: number;
  closeReconciliationError?: Error;
  finalBranchReadError?: Error;
  onPayloadUpdateAttempt?: (options?: { signal?: AbortSignal }) => void;
};

function createScenarioRunner(options: ScenarioRunnerOptions) {
  const branch = `cpb-release-rehearsal/${options.id}`;
  const payloadPath = `.cpb-release-rehearsals/${options.id}.json`;
  const expectedTitle = `CodePatchBay disposable draft PR rehearsal ${options.id}`;
  const expectedBody = `Automated disposable draft PR rehearsal generation ${options.id} on ${branch}. This PR must be closed by the rehearsal script.`;
  const calls: Array<{ command: string; args: string[]; signalAborted?: boolean }> = [];
  const configuredOrigins = options.configuredOrigins || ["git@github.com:source/repo.git"];
  const fetchOrigins = options.fetchOrigins || configuredOrigins;
  const pushOrigins = options.pushOrigins || fetchOrigins;
  const successorSha = options.successorSha || "d".repeat(40);
  const blobs = new Map<string, string>();
  const trees = new Map<string, { path: string; blobSha: string }>();
  const commits = new Map<string, { treeSha: string; parentSha: string; message: string }>();
  let repositoryViewCount = 0;
  let markerReadCount = 0;
  let blobCreateCount = 0;
  let treeCreateCount = 0;
  let commitCreateCount = 0;
  let branchSha = options.initialBranchSha ?? null;
  let pullRequest: Record<string, any> | null = null;
  let mainPullRequestRead = false;
  let closeNeedsReconciliation = false;
  let closeReconciliationFailed = false;
  let deletionAttempted = false;

  const result = (stdout = "") => ({ stdout, stderr: "" });
  const exactPullRequest = (state = "open") => ({
    number: 41,
    html_url: "https://github.com/safe/disposable/pull/41",
    draft: true,
    state,
    title: expectedTitle,
    body: expectedBody,
    head: {
      ref: branch,
      sha: PAYLOAD_COMMIT_SHA,
      repo: { full_name: "safe/disposable" },
    },
    base: { ref: "main" },
  });
  const updateBranchAfterPullRequest = (sha: string | null) => {
    branchSha = sha;
    if (sha && pullRequest) pullRequest.head.sha = sha;
  };

  const runCommand = async (command: string, args: string[], commandOptions?: { signal?: AbortSignal }) => {
    calls.push({ command, args, signalAborted: commandOptions?.signal?.aborted });
    const endpoint = args[1] || "";

    if (command === "git" && args[0] === "config" && args.includes("remote.origin.url")) {
      return result(`${configuredOrigins.join("\n")}\n`);
    }
    if (command === "git" && args[0] === "remote" && args[1] === "get-url") {
      const origins = args.includes("--push") ? pushOrigins : fetchOrigins;
      return result(`${origins.join("\n")}\n`);
    }
    if (command === "gh" && args[0] === "auth" && args[1] === "status") return result();

    if (command === "gh" && args[0] === "repo" && args[1] === "view") {
      const callIndex = repositoryViewCount++;
      const changed = callIndex > 0
        && options.repositoryIdentityChangesAt !== undefined
        && callIndex >= options.repositoryIdentityChangesAt;
      return result(JSON.stringify({
        id: changed ? "R_replaced" : "R_safe",
        defaultBranchRef: { name: "main" },
      }));
    }

    if (command === "gh" && args[0] === "api" && endpoint.includes("/contents/.cpb-disposable-target.json?")) {
      const callIndex = markerReadCount++;
      const changed = callIndex > 0
        && options.markerChangesAt !== undefined
        && callIndex >= options.markerChangesAt;
      return result(marker(options.markerRepository || "safe/disposable", changed ? "9".repeat(40) : "a".repeat(40)));
    }

    if (command === "gh" && args[0] === "api" && endpoint === "repos/safe/disposable/git/ref/heads/main") {
      return result(`${BASE_SHA}\n`);
    }
    if (command === "gh" && args[0] === "api" && endpoint === `repos/safe/disposable/git/commits/${BASE_SHA}`) {
      return result(JSON.stringify({ sha: BASE_SHA, tree: { sha: BASE_TREE_SHA }, parents: [], message: "base" }));
    }

    if (command === "gh" && args[0] === "api" && endpoint.endsWith("/git/blobs") && args.includes("POST")) {
      const sha = blobCreateCount++ === 0 ? ANCHOR_BLOB_SHA : PAYLOAD_BLOB_SHA;
      const content = String(args.find((arg) => arg.startsWith("content=")) || "").slice(8);
      blobs.set(sha, content);
      return result(JSON.stringify({ sha }));
    }
    if (command === "gh" && args[0] === "api" && endpoint.includes("/git/blobs/") && args.includes("GET")) {
      const sha = endpoint.split("/git/blobs/")[1];
      return result(JSON.stringify({ sha, encoding: "base64", content: blobs.get(sha) || "" }));
    }
    if (command === "gh" && args[0] === "api" && endpoint.endsWith("/git/trees") && args.includes("POST")) {
      const sha = treeCreateCount++ === 0 ? ANCHOR_TREE_SHA : PAYLOAD_TREE_SHA;
      const pathValue = String(args.find((arg) => arg.startsWith("tree[][path]=")) || "").slice(13);
      const blobSha = String(args.find((arg) => arg.startsWith("tree[][sha]=")) || "").slice(12);
      trees.set(sha, { path: pathValue, blobSha });
      return result(JSON.stringify({ sha }));
    }
    if (command === "gh" && args[0] === "api" && endpoint.includes("/git/trees/") && args.includes("GET")) {
      const sha = endpoint.split("/git/trees/")[1].split("?")[0];
      const tree = trees.get(sha);
      return result(JSON.stringify({
        sha,
        truncated: false,
        tree: tree ? [{ path: tree.path, mode: "100644", type: "blob", sha: tree.blobSha }] : [],
      }));
    }
    if (command === "gh" && args[0] === "api" && endpoint.endsWith("/git/commits") && args.includes("POST")) {
      const sha = commitCreateCount++ === 0 ? ANCHOR_COMMIT_SHA : PAYLOAD_COMMIT_SHA;
      const treeSha = String(args.find((arg) => arg.startsWith("tree=")) || "").slice(5);
      const parentSha = String(args.find((arg) => arg.startsWith("parents[]=")) || "").slice(10);
      const message = String(args.find((arg) => arg.startsWith("message=")) || "").slice(8);
      commits.set(sha, { treeSha, parentSha, message });
      return result(JSON.stringify({ sha }));
    }
    if (command === "gh" && args[0] === "api" && endpoint.includes("/git/commits/") && args.includes("GET")) {
      const sha = endpoint.split("/git/commits/")[1];
      const commit = commits.get(sha);
      if (!commit) throw new Error(`unknown scenario commit ${sha}`);
      return result(JSON.stringify({
        sha,
        tree: { sha: commit.treeSha },
        parents: [{ sha: commit.parentSha }],
        message: commit.message,
      }));
    }

    if (command === "gh" && args[0] === "api" && endpoint.includes("/git/matching-refs/heads/")) {
      if (deletionAttempted && options.finalBranchReadError) throw options.finalBranchReadError;
      return result(branchSha
        ? JSON.stringify([{ ref: `refs/heads/${branch}`, object: { sha: branchSha } }])
        : "[]");
    }
    if (command === "gh" && args[0] === "api" && endpoint.endsWith("/git/refs") && args.includes("POST")) {
      const outcome = options.branchCreateOutcome || "ok";
      if (outcome === "error") throw new Error("branch create failed");
      branchSha = ANCHOR_COMMIT_SHA;
      if (outcome === "commit_then_error") throw new Error("branch create transport failed after commit");
      if (outcome === "malformed_after_commit") return result(JSON.stringify({ ref: "refs/heads/wrong-branch" }));
      return result(branchRef(branch, ANCHOR_COMMIT_SHA));
    }
    if (command === "gh" && args[0] === "api" && endpoint === `repos/safe/disposable/git/ref/heads/${branch}`) {
      if (!branchSha) throw new Error("scenario branch is absent");
      return result(branchRef(branch, branchSha));
    }

    if (command === "gh" && args[0] === "api" && endpoint === "graphql") {
      const beforeOid = String(args.find((arg) => arg.startsWith("beforeOid=")) || "").slice(10);
      const afterOid = String(args.find((arg) => arg.startsWith("afterOid=")) || "").slice(9);
      const clientMutationId = String(args.find((arg) => arg.startsWith("clientMutationId=")) || "").slice(17);
      if (afterOid === "0".repeat(40)) {
        deletionAttempted = true;
        const outcome = options.branchDeleteOutcome || "ok";
        if (outcome === "error") throw new Error("primary delete failed ghp_primarysecret");
        if (branchSha !== beforeOid) throw new Error("branch delete compare-and-swap rejected successor");
        branchSha = null;
        if (outcome === "commit_then_error") throw new Error("branch delete transport failed after commit");
        if (outcome === "malformed_after_commit") return result("{}");
        return result(JSON.stringify({ data: { updateRefs: { clientMutationId } } }));
      }

      options.onPayloadUpdateAttempt?.(commandOptions);
      const outcome = options.payloadUpdateOutcome || "ok";
      if (outcome === "cas_conflict_successor") {
        branchSha = successorSha;
        throw new Error("payload compare-and-swap rejected successor");
      }
      if (outcome === "error") throw new Error("payload update failed");
      if (branchSha !== beforeOid) throw new Error("payload compare-and-swap rejected unexpected ref");
      branchSha = afterOid;
      if (outcome === "commit_then_error") throw new Error("payload update transport failed after commit");
      if (outcome === "malformed_after_commit") return result("{}");
      return result(JSON.stringify({ data: { updateRefs: { clientMutationId } } }));
    }

    if (command === "gh" && args[0] === "api" && endpoint.endsWith("/pulls") && args.includes("POST")) {
      const outcome = options.pullRequestCreateOutcome || "ok";
      if (outcome === "error") throw new Error("pull request create failed");
      const created = exactPullRequest();
      pullRequest = structuredClone(created);
      if ("afterPullRequestPostBranchSha" in options) {
        updateBranchAfterPullRequest(options.afterPullRequestPostBranchSha ?? null);
      }
      if (outcome === "commit_then_error") throw new Error("pull request create transport failed after commit");
      if (outcome === "malformed_after_commit") return result("");
      return result(JSON.stringify(created));
    }
    if (command === "gh" && args[0] === "api" && endpoint.endsWith("/pulls") && args.includes("GET")) {
      const open = pullRequest?.state === "open" ? [pullRequest] : [];
      const pageCount = Math.max(1, options.pullRequestDiscoveryPage || 1);
      const pages = Array.from({ length: pageCount }, (_, index) => index === pageCount - 1 ? open : []);
      return result(JSON.stringify(pages));
    }
    if (command === "gh" && args[0] === "api" && endpoint.includes("/pulls/") && args.includes("PATCH")) {
      if (!pullRequest) throw new Error("scenario pull request is absent");
      const outcome = options.pullRequestCloseOutcome || "ok";
      if (outcome === "error") {
        closeNeedsReconciliation = true;
        throw new Error("pull request close failed ghp_close_primary_secret");
      }
      pullRequest.state = "closed";
      closeNeedsReconciliation = outcome !== "ok";
      if (outcome === "commit_then_error") throw new Error("pull request close transport failed after commit ghp_close_primary_secret");
      if (outcome === "malformed_after_commit") return result("");
      return result(JSON.stringify(pullRequest));
    }
    if (command === "gh" && args[0] === "api" && endpoint.includes("/pulls/")) {
      if (!pullRequest) throw new Error("scenario pull request is absent");
      if (closeNeedsReconciliation && options.closeReconciliationError && !closeReconciliationFailed) {
        closeReconciliationFailed = true;
        throw options.closeReconciliationError;
      }
      const response = structuredClone(pullRequest);
      if (!args.includes("GET") && !mainPullRequestRead) {
        mainPullRequestRead = true;
        if ("afterMainPullRequestReadBranchSha" in options) {
          updateBranchAfterPullRequest(options.afterMainPullRequestReadBranchSha ?? null);
        }
      }
      return result(JSON.stringify(response));
    }

    throw new Error(`unexpected scenario command ${command} ${args.join(" ")}`);
  };

  return { branch, calls, runCommand };
}

const argv = [
  "node",
  "scripts/rehearse-disposable-draft-pr.js",
  "--execute",
  "--repository",
  "safe/disposable",
];

test("live rehearsal requires exact ack before gh side effects", async () => {
  const { calls, runCommand } = createRunner([
    () => "git@github.com:source/repo.git\n",
  ]);
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: {},
    runCommand,
    now: fixedNow,
    idGenerator: () => "run-1",
  });

  assert.equal(evidence.ok, false);
  assert.equal(evidence.mode, "live");
  assert.match(evidence.violations[0].reason, /CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK/);
  assert.deepEqual(calls.map((call) => [call.command, call.args[0]]), [
    ["git", "config"],
    ["git", "remote"],
    ["git", "remote"],
  ]);
});

test("live rehearsal blocks when disposable target matches current origin", async () => {
  const { calls, runCommand } = createRunner([
    () => "https://github.com/safe/disposable.git\n",
  ]);
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "run-1",
  });

  assert.equal(evidence.ok, false);
  assert.match(evidence.violations[0].reason, /must not match/);
  assert.equal(calls.length, 3);
});

test("live rehearsal blocks on mismatched disposable marker", async () => {
  const { calls, runCommand } = createRunner([
    () => "git@github.com:source/repo.git\n",
    () => "",
    () => JSON.stringify({ id: "R_1", defaultBranchRef: { name: "main" } }),
    () => marker("other/repo"),
  ]);
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "run-1",
  });

  assert.equal(evidence.ok, false);
  assert.equal(evidence.target.markerVerified, false);
  assert.match(evidence.violations[0].reason, /repository does not match/);
  assert.equal(calls.length, 6);
});

test("successful live rehearsal creates draft PR then closes PR and deletes branch", async () => {
  const { calls, runCommand } = createRunner([
    () => "git@github.com:source/repo.git\n",
    () => "",
    () => JSON.stringify({ id: "R_safe", defaultBranchRef: { name: "main" } }),
    () => marker(),
    () => "0123456789abcdef0123456789abcdef01234567\n",
    () => JSON.stringify({ ref: "refs/heads/cpb-release-rehearsal/run-1" }),
    () => JSON.stringify({ content: { path: ".cpb-release-rehearsals/run-1.json", sha: "b".repeat(40) } }),
    () => JSON.stringify({
      number: 17,
      html_url: "https://github.com/safe/disposable/pull/17",
      draft: true,
      state: "open",
    }),
    () => JSON.stringify({
      number: 17,
      html_url: "https://github.com/safe/disposable/pull/17",
      draft: true,
      state: "open",
    }),
    () => JSON.stringify({ number: 17, state: "closed" }),
    () => "[]",
    () => "",
    () => "[]",
  ]);
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "run-1",
  });

  assert.equal(evidence.ok, true);
  assert.equal(evidence.mode, "live");
  assert.equal(evidence.target.repository, "safe/disposable");
  assert.equal(evidence.target.repositoryId, "R_safe");
  assert.equal(evidence.target.markerVerified, true);
  assert.equal(evidence.target.disposable, true);
  assert.equal(evidence.target.markerPath, ".cpb-disposable-target.json");
  assert.equal(evidence.target.markerSha, "a".repeat(40));
  assert.equal(evidence.branch, "cpb-release-rehearsal/run-1");
  assert.equal(evidence.pullRequest.number, 17);
  assert.equal(evidence.pullRequest.draft, true);
  assert.equal(evidence.pullRequest.state, "closed");
  assert.deepEqual(evidence.cleanup, { pullRequestClosed: true, branchDeleted: true });
  assert.deepEqual(evidence.violations, []);
  const operationNames = evidence.operations.map((operation) => operation.name);
  for (const requiredOperation of [
    "branch.create.verify",
    "payload.ref_update.verify",
    "pull_request.create.verify",
    "pull_request.close.verify",
    "branch.delete.atomic.commit",
    "branch.delete.verify",
  ]) {
    assert.equal(operationNames.includes(requiredOperation), true, `missing operation ${requiredOperation}`);
  }
  assert.equal(operationNames.filter((name) => name === "remote_authority.reverify").length, 11);
  const atomicDelete = calls.find((call) => call.command === "gh"
    && call.args[1] === "graphql"
    && call.args.includes(`afterOid=${"0".repeat(40)}`));
  assert.ok(atomicDelete);
  assert.equal(atomicDelete.args.includes(`beforeOid=${PAYLOAD_COMMIT_SHA}`), true);
  assert.equal(atomicDelete.args.includes(`afterOid=${"0".repeat(40)}`), true);
  assert.equal(calls.some((call) => call.args.includes("DELETE")), false);
});

test("failure after PR creation still closes PR and deletes branch", async () => {
  const { calls, runCommand } = createRunner([
    () => "git@github.com:source/repo.git\n",
    () => "",
    () => JSON.stringify({ id: "R_safe", defaultBranchRef: { name: "main" } }),
    () => marker(),
    () => "0123456789abcdef0123456789abcdef01234567\n",
    () => JSON.stringify({ ref: "refs/heads/cpb-release-rehearsal/run-2" }),
    () => JSON.stringify({ content: { path: ".cpb-release-rehearsals/run-2.json", sha: "b".repeat(40) } }),
    () => JSON.stringify({
      number: 18,
      html_url: "https://github.com/safe/disposable/pull/18",
      draft: true,
      state: "open",
    }),
    () => new Error("verification failed ghp_secretvalue"),
    () => JSON.stringify({ number: 18, state: "closed" }),
    () => "[]",
    () => "",
    () => "[]",
  ]);
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "run-2",
  });

  assert.equal(evidence.ok, false);
  assert.equal(evidence.cleanup.pullRequestClosed, true);
  assert.equal(evidence.cleanup.branchDeleted, true);
  assert.match(JSON.stringify(evidence), /REDACTED/);
  assert.doesNotMatch(JSON.stringify(evidence), /ghp_secretvalue/);
  assert.equal(calls.some((call) => call.args[1] === "graphql"
    && call.args.includes(`beforeOid=${PAYLOAD_COMMIT_SHA}`)), true);
});

test("malformed PR creation response discovers open PR by rehearsal branch before deleting branch", async () => {
  const { calls, runCommand } = createRunner([
    () => "git@github.com:source/repo.git\n",
    () => "",
    () => JSON.stringify({ id: "R_safe", defaultBranchRef: { name: "main" } }),
    () => marker(),
    () => "0123456789abcdef0123456789abcdef01234567\n",
    () => JSON.stringify({ ref: "refs/heads/cpb-release-rehearsal/ambiguous-create" }),
    () => JSON.stringify({ content: { path: ".cpb-release-rehearsals/ambiguous-create.json", sha: "b".repeat(40) } }),
    () => "",
    () => JSON.stringify([{
      number: 29,
      html_url: "https://github.com/safe/disposable/pull/29",
      draft: true,
      state: "open",
      head: {
        ref: "cpb-release-rehearsal/ambiguous-create",
        label: "safe:cpb-release-rehearsal/ambiguous-create",
      },
    }]),
    () => JSON.stringify({
      number: 29,
      html_url: "https://github.com/safe/disposable/pull/29",
      draft: true,
      state: "closed",
    }),
    () => "",
    () => "[]",
  ]);
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "ambiguous-create",
  });

  assert.equal(evidence.ok, false);
  assert.equal(evidence.pullRequest.number, 29);
  assert.equal(evidence.pullRequest.state, "closed");
  assert.deepEqual(evidence.cleanup, { pullRequestClosed: true, branchDeleted: true });
  assert.match(evidence.violations[0].reason, /disposable draft PR rehearsal failed/);
  const ambiguousOperations = evidence.operations.map((operation) => operation.name);
  assert.equal(ambiguousOperations.includes("pull_request.close.discovered.verify"), true);
  assert.equal(ambiguousOperations.includes("branch.delete.atomic.commit"), true);
  assert.equal(ambiguousOperations.includes("branch.delete.verify"), true);
  assert.equal(calls.some((call) => call.args[1] === "graphql"), true);
});

test("transient PR close failure retries discovery cleanup before deleting branch", async () => {
  const { calls, runCommand } = createRunner([
    () => "git@github.com:source/repo.git\n",
    () => "",
    () => JSON.stringify({ id: "R_safe", defaultBranchRef: { name: "main" } }),
    () => marker(),
    () => "0123456789abcdef0123456789abcdef01234567\n",
    () => JSON.stringify({ ref: "refs/heads/cpb-release-rehearsal/transient-close" }),
    () => JSON.stringify({ content: { path: ".cpb-release-rehearsals/transient-close.json", sha: "b".repeat(40) } }),
    () => JSON.stringify({
      number: 31,
      html_url: "https://github.com/safe/disposable/pull/31",
      draft: true,
      state: "open",
    }),
    () => JSON.stringify({
      number: 31,
      html_url: "https://github.com/safe/disposable/pull/31",
      draft: true,
      state: "open",
    }),
    () => new Error("temporary close outage"),
    () => JSON.stringify([{
      number: 31,
      html_url: "https://github.com/safe/disposable/pull/31",
      draft: true,
      state: "open",
      head: {
        ref: "cpb-release-rehearsal/transient-close",
        label: "safe:cpb-release-rehearsal/transient-close",
      },
    }]),
    () => JSON.stringify({
      number: 31,
      html_url: "https://github.com/safe/disposable/pull/31",
      draft: true,
      state: "closed",
    }),
    () => "",
    () => "[]",
  ]);
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "transient-close",
  });

  assert.equal(evidence.ok, false);
  assert.equal(evidence.pullRequest.number, 31);
  assert.equal(evidence.pullRequest.state, "closed");
  assert.deepEqual(evidence.cleanup, { pullRequestClosed: true, branchDeleted: true });
  assert.equal(evidence.violations[0].gate, "cleanup.pr");
  const transientOperations = evidence.operations.map((operation) => operation.name);
  assert.equal(transientOperations.includes("pull_request.close.failed"), true);
  assert.equal(transientOperations.includes("pull_request.close.discovered.verify"), true);
  assert.equal(transientOperations.includes("branch.delete.atomic.commit"), true);
  assert.equal(transientOperations.includes("branch.delete.verify"), true);
  assert.equal(calls.some((call) => call.args[1] === "graphql"), true);
});

test("branch creation failure never deletes a pre-existing branch with the same name", async () => {
  const { calls, runCommand } = createScenarioRunner({
    id: "existing-branch",
    initialBranchSha: "d".repeat(40),
  });
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "existing-branch",
  });

  assert.equal(evidence.ok, false);
  assert.equal(evidence.cleanup.branchDeleted, false);
  assert.equal(calls.some((call) => call.args[1] === "graphql"), false);
  assert.equal(calls.some((call) => call.args[1]?.endsWith("/git/refs") && call.args.includes("POST")), false);
  assert.match(JSON.stringify(evidence.violations), /already exists before mutation/);
});

test("cleanup preserves a successor when the created ref is replaced before the next action", async () => {
  const successorSha = "d".repeat(40);
  const { calls, runCommand } = createScenarioRunner({
    id: "replaced-after-create",
    payloadUpdateOutcome: "cas_conflict_successor",
    successorSha,
  });

  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "replaced-after-create",
  });

  assert.equal(evidence.ok, false);
  assert.equal(evidence.cleanup.branchDeleted, false);
  assert.equal(evidence.violations.some((violation) => violation.gate === "cleanup.branch.successor"), true);
  assert.equal(evidence.operations.some((operation) => operation.name === "branch.reconcile.foreign_generation"
    && operation.successorPreserved === true
    && operation.observedSha === successorSha), true);
  assert.equal(calls.some((call) => call.args[1] === "graphql"
    && call.args.includes(`afterOid=${"0".repeat(40)}`)), false);
});

test("marker generation is revalidated before every later mutation and cleanup", async () => {
  const { calls, runCommand } = createScenarioRunner({
    id: "marker-rotated",
    markerChangesAt: 8,
  });

  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "marker-rotated",
  });

  assert.equal(evidence.ok, false);
  assert.equal(evidence.cleanup.branchDeleted, false);
  assert.match(JSON.stringify(evidence.violations), /marker generation changed before payload\.ref_update/);
  assert.match(JSON.stringify(evidence.violations), /marker generation changed before branch\.delete/);
  assert.equal(calls.some((call) => call.args[1] === "graphql"), false);
});

test("target repository identity is revalidated between remote mutations", async () => {
  const { calls, runCommand } = createScenarioRunner({
    id: "target-replaced",
    repositoryIdentityChangesAt: 8,
  });

  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "target-replaced",
  });

  assert.equal(evidence.ok, false);
  assert.equal(evidence.cleanup.branchDeleted, false);
  assert.match(JSON.stringify(evidence.violations), /repository identity changed before payload\.ref_update/);
  assert.match(JSON.stringify(evidence.violations), /repository identity changed before branch\.delete/);
  assert.equal(calls.some((call) => call.args[1] === "graphql"), false);
});

test("cleanup evidence retains both atomic deletion and verification failures", async () => {
  const { runCommand } = createScenarioRunner({
    id: "dual-cleanup-failure",
    payloadUpdateOutcome: "error",
    branchDeleteOutcome: "error",
    finalBranchReadError: new Error("secondary verification failed github_pat_secondarysecret"),
  });

  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "dual-cleanup-failure",
  });

  assert.equal(evidence.ok, false);
  assert.equal(evidence.cleanup.branchDeleted, false);
  assert.equal(evidence.violations.some((violation) => violation.gate === "cleanup.branch.delete"), true);
  assert.equal(evidence.violations.some((violation) => violation.gate === "cleanup.branch.verify"), true);
  assert.match(JSON.stringify(evidence), /primary delete failed/);
  assert.match(JSON.stringify(evidence), /secondary verification failed/);
  assert.doesNotMatch(JSON.stringify(evidence), /ghp_primarysecret|github_pat_secondarysecret/);
});

test("malformed branch creation response still cleans up the owned branch", async () => {
  const { calls, runCommand } = createScenarioRunner({
    id: "malformed-branch-create",
    branchCreateOutcome: "malformed_after_commit",
  });
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "malformed-branch-create",
  });

  assert.equal(evidence.ok, false);
  assert.equal(evidence.cleanup.branchDeleted, true);
  const malformedBranchOperations = evidence.operations.map((operation) => operation.name);
  assert.equal(malformedBranchOperations.includes("branch.create.owned"), true);
  assert.equal(malformedBranchOperations.includes("branch.create.verify"), false);
  assert.equal(malformedBranchOperations.includes("branch.delete.atomic.commit"), true);
  assert.equal(malformedBranchOperations.includes("branch.delete.verify"), true);
  assert.equal(calls.some((call) => call.args[1] === "graphql"
    && call.args.includes(`beforeOid=${ANCHOR_COMMIT_SHA}`)
    && call.args.includes(`afterOid=${"0".repeat(40)}`)), true);
});

test("branch creation committed-then-error reconciles and deletes only the anchor generation", async () => {
  const { calls, runCommand } = createScenarioRunner({
    id: "branch-create-committed-error",
    branchCreateOutcome: "commit_then_error",
  });
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "branch-create-committed-error",
  });

  assert.equal(evidence.ok, false);
  assert.equal(evidence.cleanup.branchDeleted, true);
  assert.equal(evidence.operations.some((operation) => operation.name === "remote_mutation.committed_unknown"
    && operation.mutation === "branch.create"), true);
  assert.equal(evidence.operations.some((operation) => operation.name === "branch.reconcile.anchor_generation"
    && operation.observedSha === ANCHOR_COMMIT_SHA), true);
  assert.equal(calls.some((call) => call.args[1] === "graphql"
    && call.args.includes(`beforeOid=${ANCHOR_COMMIT_SHA}`)
    && call.args.includes(`afterOid=${"0".repeat(40)}`)), true);
});

test("payload ref update committed-then-error reconciles and deletes only the payload generation", async () => {
  const { calls, runCommand } = createScenarioRunner({
    id: "payload-committed-error",
    payloadUpdateOutcome: "commit_then_error",
  });
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "payload-committed-error",
  });

  assert.equal(evidence.ok, false);
  assert.equal(evidence.cleanup.branchDeleted, true);
  assert.equal(evidence.operations.some((operation) => operation.name === "remote_mutation.committed_unknown"
    && operation.mutation === "payload.ref_update"), true);
  assert.equal(evidence.operations.some((operation) => operation.name === "branch.reconcile.payload_generation"
    && operation.observedSha === PAYLOAD_COMMIT_SHA), true);
  assert.equal(calls.some((call) => call.args[1] === "graphql"
    && call.args.includes(`beforeOid=${PAYLOAD_COMMIT_SHA}`)
    && call.args.includes(`afterOid=${"0".repeat(40)}`)), true);
});

test("PR creation committed-then-error discovers the exact generation before branch deletion", async () => {
  const { calls, runCommand } = createScenarioRunner({
    id: "pr-create-committed-error",
    pullRequestCreateOutcome: "commit_then_error",
  });
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "pr-create-committed-error",
  });

  assert.equal(evidence.ok, false);
  assert.equal(evidence.pullRequest.number, 41);
  assert.deepEqual(evidence.cleanup, { pullRequestClosed: true, branchDeleted: true });
  const operationNames = evidence.operations.map((operation) => operation.name);
  assert.equal(operationNames.includes("pull_request.discover.open"), true);
  assert.equal(operationNames.includes("pull_request.close.discovered.verify"), true);
  const closeIndex = operationNames.indexOf("pull_request.close.discovered.verify");
  const deleteIndex = operationNames.indexOf("branch.delete.atomic.commit");
  assert.equal(closeIndex >= 0 && deleteIndex > closeIndex, true);
  assert.equal(calls.some((call) => call.args[1] === "graphql"
    && call.args.includes(`beforeOid=${PAYLOAD_COMMIT_SHA}`)), true);
});

test("unknown-number PR discovery closes an exact generation from a later page", async () => {
  const { calls, runCommand } = createScenarioRunner({
    id: "pr-create-later-page",
    pullRequestCreateOutcome: "commit_then_error",
    pullRequestDiscoveryPage: 2,
  });
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "pr-create-later-page",
  });

  assert.equal(evidence.pullRequest.number, 41);
  assert.deepEqual(evidence.cleanup, { pullRequestClosed: true, branchDeleted: true });
  const discoveryCall = calls.find((call) => call.args[1] === "repos/safe/disposable/pulls"
    && call.args.includes("GET"));
  assert.ok(discoveryCall);
  assert.equal(discoveryCall.args.includes("--paginate"), true);
  assert.equal(discoveryCall.args.includes("--slurp"), true);
  assert.equal(discoveryCall.args.includes("per_page=100"), true);
});

test("unknown-number PR cleanup remains bound when the owned branch head advances", async () => {
  const successorSha = "d".repeat(40);
  const { calls, runCommand } = createScenarioRunner({
    id: "unknown-pr-successor",
    pullRequestCreateOutcome: "commit_then_error",
    afterPullRequestPostBranchSha: successorSha,
  });
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "unknown-pr-successor",
  });

  assert.equal(evidence.cleanup.pullRequestClosed, true);
  assert.equal(evidence.cleanup.branchDeleted, false);
  assert.equal(evidence.operations.some((operation) => operation.name === "pull_request.cleanup.generation_head_changed"
    && operation.observedHeadSha === successorSha), true);
  assert.equal(evidence.operations.some((operation) => operation.name === "pull_request.close.discovered.verify"), true);
  assert.equal(evidence.operations.some((operation) => operation.name === "branch.reconcile.foreign_generation"
    && operation.observedSha === successorSha), true);
  assert.equal(calls.some((call) => call.args[1] === "graphql"
    && call.args.includes(`afterOid=${"0".repeat(40)}`)), false);
});

test("known PR is closed before a successor branch is preserved", async () => {
  const successorSha = "d".repeat(40);
  const { calls, runCommand } = createScenarioRunner({
    id: "known-pr-successor",
    afterMainPullRequestReadBranchSha: successorSha,
  });
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "known-pr-successor",
  });

  assert.equal(evidence.cleanup.pullRequestClosed, true);
  assert.equal(evidence.cleanup.branchDeleted, false);
  const operationNames = evidence.operations.map((operation) => operation.name);
  assert.equal(operationNames.indexOf("pull_request.close.verify")
    < operationNames.indexOf("branch.reconcile.foreign_generation"), true);
  assert.equal(calls.some((call) => call.args[1] === "graphql"
    && call.args.includes(`afterOid=${"0".repeat(40)}`)), false);
});

test("known PR is closed even when the branch is already absent", async () => {
  const { runCommand } = createScenarioRunner({
    id: "known-pr-branch-absent",
    afterMainPullRequestReadBranchSha: null,
  });
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "known-pr-branch-absent",
  });

  assert.equal(evidence.cleanup.pullRequestClosed, true);
  assert.equal(evidence.cleanup.branchDeleted, true);
  const operationNames = evidence.operations.map((operation) => operation.name);
  assert.equal(operationNames.indexOf("pull_request.close.verify")
    < operationNames.indexOf("branch.reconcile.absent"), true);
});

test("PR close committed-then-error is reconciled as closed before branch deletion", async () => {
  const { runCommand } = createScenarioRunner({
    id: "close-committed-error",
    pullRequestCloseOutcome: "commit_then_error",
  });
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "close-committed-error",
  });

  assert.equal(evidence.cleanup.pullRequestClosed, true);
  assert.equal(evidence.cleanup.branchDeleted, true);
  assert.equal(evidence.operations.some((operation) => operation.name === "pull_request.close.verify.committed_unknown_reconciled"), true);
});

test("PR close committed with an empty response is reconciled by exact GET", async () => {
  const { runCommand } = createScenarioRunner({
    id: "close-malformed-response",
    pullRequestCloseOutcome: "malformed_after_commit",
  });
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "close-malformed-response",
  });

  assert.equal(evidence.cleanup.pullRequestClosed, true);
  assert.equal(evidence.cleanup.branchDeleted, true);
  assert.equal(evidence.operations.some((operation) => operation.name === "pull_request.close.verify.committed_unknown_reconciled"), true);
});

test("PR close uncertainty retains and redacts both mutation and reconciliation failures", async () => {
  const { runCommand } = createScenarioRunner({
    id: "close-dual-failure",
    pullRequestCloseOutcome: "commit_then_error",
    closeReconciliationError: new Error("close verification failed github_pat_close_secondary_secret"),
  });
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "close-dual-failure",
  });
  const serialized = JSON.stringify(evidence);

  assert.equal(evidence.cleanup.pullRequestClosed, false);
  assert.equal(evidence.cleanup.branchDeleted, true);
  assert.equal(evidence.violations.some((violation) => violation.gate === "cleanup.pr"
    && Array.isArray((violation.error as { failures?: unknown[] })?.failures)
    && (violation.error as { failures: unknown[] }).failures.length === 2), true);
  assert.match(serialized, /pull request close transport failed after commit/);
  assert.match(serialized, /close verification failed/);
  assert.doesNotMatch(serialized, /ghp_close_primary_secret|github_pat_close_secondary_secret/);
});

test("branch deletion committed-then-error is verified absent without a second delete", async () => {
  const { calls, runCommand } = createScenarioRunner({
    id: "delete-committed-error",
    pullRequestCreateOutcome: "error",
    branchDeleteOutcome: "commit_then_error",
  });
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "delete-committed-error",
  });

  assert.equal(evidence.cleanup.branchDeleted, true);
  assert.equal(evidence.operations.some((operation) => operation.name === "branch.delete.verify"
    && operation.mutationReportedError === true), true);
  const deletionCalls = calls.filter((call) => call.args[1] === "graphql"
    && call.args.includes(`afterOid=${"0".repeat(40)}`));
  assert.equal(deletionCalls.length, 1);
});

test("ssh URL origin equality is recognized and blocks the disposable target", async () => {
  const origin = "ssh://git@github.com/safe/disposable.git";
  const { calls, runCommand } = createScenarioRunner({
    id: "ssh-origin",
    configuredOrigins: [origin],
    fetchOrigins: [origin],
    pushOrigins: [origin],
  });
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "ssh-origin",
  });

  assert.match(JSON.stringify(evidence.violations), /must not match/);
  assert.equal(calls.some((call) => call.command === "gh"), false);
});

test("unknown effective origin URL fails closed before GitHub access", async () => {
  const { calls, runCommand } = createScenarioRunner({
    id: "unknown-origin",
    fetchOrigins: ["file:///private/tmp/source"],
    pushOrigins: ["file:///private/tmp/source"],
  });
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "unknown-origin",
  });

  assert.equal(evidence.violations[0].gate, "origin");
  assert.match(JSON.stringify(evidence.violations), /not an unambiguous GitHub repository/);
  assert.equal(calls.some((call) => call.command === "gh"), false);
});

test("bare owner/repo origin paths fail closed before GitHub access", async () => {
  const { calls, runCommand } = createScenarioRunner({
    id: "relative-origin",
    configuredOrigins: ["source/repo"],
    fetchOrigins: ["source/repo"],
    pushOrigins: ["source/repo"],
  });
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "relative-origin",
  });

  assert.equal(evidence.violations[0].gate, "origin");
  assert.match(JSON.stringify(evidence.violations), /not an unambiguous GitHub repository/);
  assert.equal(calls.some((call) => call.command === "gh"), false);
});

test("different fetch and push origin repositories fail closed", async () => {
  const { calls, runCommand } = createScenarioRunner({
    id: "split-origin",
    fetchOrigins: ["git@github.com:source/repo.git"],
    pushOrigins: ["https://github.com/safe/disposable.git"],
  });
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "split-origin",
  });

  assert.equal(evidence.violations[0].gate, "origin");
  assert.match(JSON.stringify(evidence.violations), /resolve to different repositories/);
  assert.equal(calls.some((call) => call.command === "gh"), false);
});

test("multiple effective origin URLs fail closed", async () => {
  const { calls, runCommand } = createScenarioRunner({
    id: "multiple-origins",
    fetchOrigins: ["git@github.com:source/repo.git", "https://github.com/source/repo.git"],
  });
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "multiple-origins",
  });

  assert.equal(evidence.violations[0].gate, "origin");
  assert.match(JSON.stringify(evidence.violations), /exactly one fetch URL and one push URL/);
  assert.equal(calls.some((call) => call.command === "gh"), false);
});

test("cleanup uses a fresh bounded signal after main abort", async () => {
  const controller = new AbortController();
  const { calls, runCommand } = createScenarioRunner({
    id: "abort-cleanup",
    payloadUpdateOutcome: "error",
    onPayloadUpdateAttempt: (options) => {
      assert.equal(options?.signal?.aborted, false);
      controller.abort(new Error("main aborted after branch create"));
    },
  });
  const evidence = await rehearseDisposableDraftPr({
    argv,
    env: { CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable" },
    runCommand,
    now: fixedNow,
    idGenerator: () => "abort-cleanup",
    signal: controller.signal,
  });

  assert.equal(evidence.ok, false);
  assert.equal(evidence.cleanup.branchDeleted, true);
  assert.equal(evidence.violations[0].gate, "live");
  assert.deepEqual(calls.slice(-3).map((call) => call.signalAborted), [false, false, false]);
});

test("CLI drains cleanup and writes evidence before signal-specific exit", async (t) => {
  for (const { signal, exitCode } of [
    { signal: "SIGINT" as const, exitCode: 130 },
    { signal: "SIGTERM" as const, exitCode: 143 },
  ]) {
    await t.test(signal, async () => {
      const root = await tempRoot(`cpb-rehearsal-${signal.toLowerCase()}`);
      const output = path.join(root, "evidence.json");
      const processRef = new EventEmitter() as EventEmitter & {
        argv: string[];
        env: Record<string, string | undefined>;
        exitCode?: number;
      };
      processRef.argv = [...argv, "--output", output];
      processRef.env = {
        CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK: "execute-disposable-draft-pr:safe/disposable",
      };
      const { calls, runCommand } = createScenarioRunner({
        id: `cli-${signal.toLowerCase()}`,
        payloadUpdateOutcome: "error",
        onPayloadUpdateAttempt: (options) => {
          assert.equal(options?.signal?.aborted, false);
          processRef.emit(signal);
          assert.equal(options?.signal?.aborted, true);
        },
      });
      const stdout: string[] = [];

      const evidence = await runDisposableDraftPrCli({
        processRef,
        runCommand,
        now: fixedNow,
        idGenerator: () => `cli-${signal.toLowerCase()}`,
        writeStdout: (value) => stdout.push(value),
        writeStderr: () => assert.fail("CLI should return structured evidence after signal cleanup"),
      });

      assert.ok(evidence);
      assert.equal(evidence.ok, false);
      assert.equal(evidence.cleanup.branchDeleted, true);
      assert.equal(processRef.exitCode, exitCode);
      assert.equal(processRef.listenerCount("SIGINT"), 0);
      assert.equal(processRef.listenerCount("SIGTERM"), 0);
      const persisted = JSON.parse(await readFile(output, "utf8"));
      assert.equal(persisted.cleanup.branchDeleted, true);
      assert.match(stdout[0], /"branchDeleted": true/);
      assert.deepEqual(calls.slice(-3).map((call) => call.signalAborted), [false, false, false]);
    });
  }
});

test("evidence publication retains its exclusive temp generation when rename fails", async () => {
  const root = await tempRoot("cpb-rehearsal-publication");
  const output = path.join(root, "evidence.json");
  const renameFailure = Object.assign(new Error("synthetic evidence rename failure"), { code: "EIO" });
  const { runCommand } = createRunner([
    () => "git@github.com:source/repo.git\n",
  ]);
  const evidence = await rehearseDisposableDraftPr({
    argv: ["node", "script", "--repository", "safe/disposable"],
    env: {},
    runCommand,
    now: fixedNow,
    idGenerator: () => "publication-failure",
  });
  let retainedTemporary = "";

  await assert.rejects(
    withFsUtilsTestHooks({
      rename: async (source) => {
        retainedTemporary = String(source);
        throw renameFailure;
      },
    }, () => writeEvidenceFile(output, evidence)),
    (error: unknown) => {
      assert.ok(error instanceof JsonWriteRecoveryError);
      assert.equal(error.committed, false);
      assert.equal(error.cause, renameFailure);
      assert.deepEqual(error.recoveryPaths, [retainedTemporary, output]);
      return true;
    },
  );

  assert.ok(retainedTemporary.startsWith(path.join(root, ".evidence.json.tmp-")));
  assert.deepEqual(JSON.parse(await readFile(retainedTemporary, "utf8")), evidence);
  await assert.rejects(readFile(output, "utf8"), { code: "ENOENT" });
});

test("CLI exposes structured recovery evidence when evidence publication fails", async () => {
  const root = await tempRoot("cpb-rehearsal-cli-publication");
  const output = path.join(root, "evidence.json");
  const renameFailure = Object.assign(new Error("synthetic CLI evidence rename failure"), { code: "EIO" });
  const processRef = new EventEmitter() as EventEmitter & {
    argv: string[];
    env: Record<string, string | undefined>;
    exitCode?: number;
  };
  processRef.argv = ["node", "script", "--repository", "safe/disposable", "--output", output];
  processRef.env = {};
  const { runCommand } = createRunner([
    () => "git@github.com:source/repo.git\n",
  ]);
  const stderr: string[] = [];
  let retainedTemporary = "";

  const result = await withFsUtilsTestHooks({
    rename: async (source) => {
      retainedTemporary = String(source);
      throw renameFailure;
    },
  }, () => runDisposableDraftPrCli({
    processRef,
    runCommand,
    now: fixedNow,
    idGenerator: () => "cli-publication-failure",
    writeStdout: () => assert.fail("CLI must not report success after evidence publication fails"),
    writeStderr: (value) => stderr.push(value),
  }));

  assert.equal(result, null);
  assert.equal(processRef.exitCode, 1);
  assert.equal(processRef.listenerCount("SIGINT"), 0);
  assert.equal(processRef.listenerCount("SIGTERM"), 0);
  assert.equal(stderr.length, 1);
  const diagnostic = JSON.parse(stderr[0]);
  assert.equal(diagnostic.ok, false);
  assert.equal(diagnostic.error.committed, false);
  assert.equal(diagnostic.error.renameCommitted, false);
  assert.deepEqual(diagnostic.error.recoveryPaths, [retainedTemporary, output]);
  assert.ok(retainedTemporary.startsWith(path.join(root, ".evidence.json.tmp-")));
  await assert.rejects(readFile(output, "utf8"), { code: "ENOENT" });
});

test("preflight mode is default and records no live side effects", async () => {
  const { calls, runCommand } = createRunner([
    () => "git@github.com:source/repo.git\n",
  ]);
  const evidence = await rehearseDisposableDraftPr({
    argv: ["node", "script", "--repository", "safe/disposable"],
    env: {},
    runCommand,
    now: fixedNow,
    idGenerator: () => "run-1",
  });

  assert.equal(evidence.ok, false);
  assert.equal(evidence.mode, "preflight");
  assert.equal(evidence.branch, null);
  assert.equal(evidence.pullRequest.number, null);
  assert.equal(evidence.cleanup.pullRequestClosed, false);
  assert.equal(evidence.cleanup.branchDeleted, false);
  assert.equal(calls.length, 3);
});
