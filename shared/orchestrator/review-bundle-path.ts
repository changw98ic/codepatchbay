import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

function identityText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.includes("\0")) {
    throw new Error(`review bundle ${field} identity is invalid`);
  }
  return value;
}

function ownerSegment(value: string): string {
  if (/^[A-Za-z0-9_-]{1,96}$/.test(value) && value !== "." && value !== "..") return value;
  const readable = value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "owner";
  const identityDigest = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
  return `${readable}-${identityDigest}`;
}

function assertStrictChild(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("review bundle path escaped its canonical authority root");
  }
}

export function canonicalReviewBundleDirectory(hubRoot: string, projectValue: unknown): string {
  if (typeof hubRoot !== "string" || !path.isAbsolute(hubRoot)) {
    throw new Error("review bundle authority root must be absolute");
  }
  const project = identityText(projectValue, "project");
  const reviewRoot = path.resolve(hubRoot, "review-bundles");
  const directory = path.resolve(reviewRoot, ownerSegment(project));
  assertStrictChild(reviewRoot, directory);
  return directory;
}

export function canonicalReviewBundlePath(
  hubRoot: string,
  projectValue: unknown,
  jobIdValue: unknown,
): string {
  const project = identityText(projectValue, "project");
  const jobId = identityText(jobIdValue, "jobId");
  const directory = canonicalReviewBundleDirectory(hubRoot, project);
  const safeIdentity = /^[A-Za-z0-9_-]{1,96}$/.test(project)
    && /^[A-Za-z0-9_-]{1,96}$/.test(jobId)
    && project !== "."
    && project !== ".."
    && jobId !== "."
    && jobId !== "..";
  const legacySlug = `${project}-${jobId}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 192);
  const combinedDigest = createHash("sha256")
    .update(JSON.stringify([project, jobId]), "utf8")
    .digest("hex")
    .slice(0, 16);
  const filename = `${legacySlug || "review-bundle"}${safeIdentity ? "" : `-${combinedDigest}`}-review-bundle.json`;
  const candidate = path.resolve(directory, filename);
  assertStrictChild(directory, candidate);
  return candidate;
}

export async function verifiedCanonicalReviewBundlePath(
  hubRoot: string,
  projectValue: unknown,
  jobIdValue: unknown,
): Promise<string> {
  if (typeof hubRoot !== "string" || !path.isAbsolute(hubRoot)) {
    throw new Error("review bundle authority root must be absolute");
  }
  const canonicalHubRoot = await realpath(hubRoot);
  const expectedPath = canonicalReviewBundlePath(canonicalHubRoot, projectValue, jobIdValue);
  const reviewRoot = path.dirname(path.dirname(expectedPath));
  const ownerDirectory = path.dirname(expectedPath);
  for (const [candidate, label] of [[reviewRoot, "review root"], [ownerDirectory, "owner directory"]] as const) {
    const info = await lstat(candidate);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(candidate) !== candidate) {
      throw new Error(`review bundle ${label} is not a canonical directory authority`);
    }
  }
  assertStrictChild(reviewRoot, ownerDirectory);
  assertStrictChild(ownerDirectory, expectedPath);
  return expectedPath;
}
