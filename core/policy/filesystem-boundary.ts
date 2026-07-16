import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

export const SOURCE_BOUNDARY_PROFILE = "cpb_source_boundary";

export type AgentFilesystemBoundary = {
  schemaVersion: 1;
  homeDenyRoot: string | null;
  projectPackageNames: string[];
  dependencyReadRoots: string[];
  denyReadPaths: string[];
};

function normalizedPaths(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry): entry is string => typeof entry === "string" && path.isAbsolute(entry))
    .map((entry) => path.resolve(entry)))]
    .sort();
}

export function parseAgentFilesystemBoundary(value: unknown): AgentFilesystemBoundary | null {
  let input = value;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (record.schemaVersion !== 1) return null;
  const homeDenyRoot = typeof record.homeDenyRoot === "string" && path.isAbsolute(record.homeDenyRoot)
    ? path.resolve(record.homeDenyRoot)
    : null;
  return {
    schemaVersion: 1,
    homeDenyRoot,
    projectPackageNames: Array.isArray(record.projectPackageNames)
      ? [...new Set(record.projectPackageNames.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))].sort()
      : [],
    dependencyReadRoots: normalizedPaths(record.dependencyReadRoots),
    denyReadPaths: normalizedPaths(record.denyReadPaths),
  };
}

function tomlKey(value: string) {
  return JSON.stringify(value);
}

export function codexFilesystemBoundaryConfigArgs(
  boundary: AgentFilesystemBoundary,
  workspaceAccess: "read" | "write",
  runtimeWriteRoots: string[] = [],
) {
  const rules = new Map<string, "read" | "write" | "deny">();
  for (const root of boundary.dependencyReadRoots) rules.set(root, "read");
  for (const root of normalizedPaths(runtimeWriteRoots)) rules.set(root, "write");
  for (const denied of boundary.denyReadPaths) rules.set(denied, "deny");
  const entries = [
    `${tomlKey(":minimal")}=\"read\"`,
    `${tomlKey(":workspace_roots")}={${tomlKey(".")}=\"${workspaceAccess}\"}`,
    ...[...rules.entries()].map(([target, access]) => `${tomlKey(target)}=\"${access}\"`),
  ];
  return [
    "-c", `default_permissions=${JSON.stringify(SOURCE_BOUNDARY_PROFILE)}`,
    "-c", `permissions.${SOURCE_BOUNDARY_PROFILE}.filesystem={${entries.join(",")}}`,
    "-c", `permissions.${SOURCE_BOUNDARY_PROFILE}.network={enabled=false}`,
    "-c", 'approval_policy="never"',
  ];
}

export function claudeAbsoluteReadRule(target: string) {
  const absolute = path.resolve(target).replaceAll(path.sep, "/");
  return `Read(//${absolute.replace(/^\/+/, "")}/**)`;
}

async function readGitControlFile(target: string) {
  const value = await readFile(target, "utf8");
  if (value.length > 16_384) throw new Error("git control file exceeds size limit");
  return value.trim();
}

function resolveGitControlTarget(parent: string, value: string) {
  return path.resolve(parent, value);
}

function isNestedPath(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

/**
 * Resolve the read-only Git metadata required by a managed linked worktree.
 *
 * A linked worktree's `.git` is a control file that points outside the
 * checkout, commonly into the source clone's `.git/worktrees/<name>` folder.
 * Claude's native sandbox otherwise permits the checkout but denies that
 * task-local metadata, which makes ordinary `git diff`/`git status` fail.
 *
 * Do not trust the pointer on its own. The per-worktree metadata must point
 * back to the exact checkout control file and be a direct descendant of the
 * common Git directory's `worktrees` folder. Invalid or incomplete metadata
 * fails closed with no additional read roots.
 */
export async function resolveLinkedGitMetadataReadRoots(worktreeRoot: string) {
  const controlPath = path.join(path.resolve(worktreeRoot), ".git");
  try {
    const controlStat = await lstat(controlPath);
    if (controlStat.isDirectory()) return [controlPath];
    if (!controlStat.isFile()) return [];

    const pointer = await readGitControlFile(controlPath);
    const match = /^gitdir:\s*(.+)$/i.exec(pointer);
    if (!match?.[1]) return [];
    const gitDir = resolveGitControlTarget(path.dirname(controlPath), match[1].trim());
    if (!(await lstat(gitDir)).isDirectory()) return [];

    const backlinkValue = await readGitControlFile(path.join(gitDir, "gitdir"));
    const backlink = resolveGitControlTarget(gitDir, backlinkValue);
    if (backlink !== controlPath) return [];

    const commonValue = await readGitControlFile(path.join(gitDir, "commondir"));
    const commonDir = resolveGitControlTarget(gitDir, commonValue);
    if (!(await lstat(commonDir)).isDirectory()) return [];
    const worktreesRoot = path.join(commonDir, "worktrees");
    if (!isNestedPath(worktreesRoot, gitDir) || path.dirname(gitDir) !== worktreesRoot) return [];

    return [...new Set([commonDir, gitDir])].sort();
  } catch {
    return [];
  }
}

export function claudeFilesystemBoundarySettings(
  boundary: AgentFilesystemBoundary,
  allowReadRoots: string[],
) {
  const safeDependencyRoots = boundary.dependencyReadRoots.filter((root) => {
    if (!boundary.homeDenyRoot) return false;
    const relativeToHome = path.relative(boundary.homeDenyRoot, root);
    const insideDeniedHome = relativeToHome === "" || (!relativeToHome.startsWith(`..${path.sep}`) && relativeToHome !== "..");
    if (!insideDeniedHome) return false;
    return !boundary.denyReadPaths.some((denied) => {
      const relative = path.relative(root, denied);
      return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
    });
  });
  return {
    denyRead: [
      ...(boundary.homeDenyRoot ? [boundary.homeDenyRoot] : []),
      ...boundary.denyReadPaths,
    ],
    allowRead: [...new Set([...allowReadRoots, ...safeDependencyRoots].map((entry) => path.resolve(entry)))].sort(),
    permissionDeny: boundary.denyReadPaths.map(claudeAbsoluteReadRule),
  };
}
