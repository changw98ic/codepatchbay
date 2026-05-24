import { createHash } from "node:crypto";

const DEFAULT_MAX_SLUG_LENGTH = 48;

function shortHash(value) {
  return createHash("sha1").update(String(value || "")).digest("hex").slice(0, 8);
}

export function slugifyBranchComponent(value, { fallback = "github-issue", maxLength = DEFAULT_MAX_SLUG_LENGTH } = {}) {
  const raw = String(value || "").trim();
  let slug = raw
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!slug) slug = fallback;
  if (slug.length <= maxLength) return slug;

  const suffix = shortHash(raw);
  const prefixLength = Math.max(1, maxLength - suffix.length - 1);
  const prefix = slug.slice(0, prefixLength).replace(/-+$/g, "") || fallback.slice(0, prefixLength);
  return `${prefix}-${suffix}`;
}

export function buildGithubIssueBranchParts({ issueNumber, title, jobId, maxSlugLength = DEFAULT_MAX_SLUG_LENGTH } = {}) {
  const number = Number.parseInt(issueNumber, 10);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error("issueNumber is required for GitHub issue branch naming");
  }
  const jobComponent = `issue-${number}`;
  const slug = slugifyBranchComponent(title || jobId || jobComponent, { maxLength: maxSlugLength });
  const worktreeName = `${jobComponent}-${slug}`;
  return {
    jobComponent,
    slug,
    worktreeName,
    branch: `cpb/${worktreeName}`,
  };
}
