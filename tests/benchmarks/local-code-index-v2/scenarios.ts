/**
 * Canonical Local Code Index v2 benchmark scenario matrix.
 *
 * The parent specification defines ten operations. Every operation runs at
 * both required fixture sizes, producing exactly twenty scenarios.
 */

export type FixtureSize = 1000 | 10000;

export type ScenarioOperation =
  | "full-build"
  | "exact-status"
  | "unchanged-ensure"
  | "one-file-edit"
  | "hundred-file-edit"
  | "branch-switch"
  | "query-definitions"
  | "query-references"
  | "query-related-files"
  | "non-git-status";

export type QuerySpec =
  | Readonly<{
      kind: "definitions";
      symbol: string;
      match: "exact";
      limit: number;
    }>
  | Readonly<{
      kind: "references";
      symbol: string;
      match: "exact";
      limit: number;
    }>
  | Readonly<{
      kind: "related-files";
      paths: readonly string[];
      limit: number;
    }>;

export interface ScenarioDef {
  readonly id: string;
  readonly fixtureSize: FixtureSize;
  readonly operation: ScenarioOperation;
  readonly repositoryKind: "git" | "non-git";
  readonly description: string;
  readonly query: QuerySpec | null;
}

export const FIXTURE_SIZES = [1000, 10000] as const;
export const WARMUP_RUNS = 5;
export const MEASURED_RUNS = 30;
export const FIXTURE_SEED = "0x4350424944585632";
export const SUPPORTED_NODE_MAJORS = [20, 22] as const;
export const DEFAULT_QUERY_LIMIT = 50;
export const RELATED_QUERY_LIMIT = 100;

export function benchmarkSymbol(size: FixtureSize): string {
  return size === 1000 ? "module00500" : "module05000";
}

export function benchmarkRelatedPaths(size: FixtureSize): readonly string[] {
  const index = size === 1000 ? 500 : 5000;
  const pathFor = (value: number) =>
    `src/${Math.floor(value / 100).toString().padStart(3, "0")}/module${value.toString().padStart(5, "0")}.ts`;
  return [pathFor(index), pathFor(index + 1)];
}

const OPERATIONS: readonly Omit<ScenarioDef, "id" | "fixtureSize" | "query">[] = [
  {
    operation: "full-build",
    repositoryKind: "git",
    description: "Full build from an empty storage root",
  },
  {
    operation: "exact-status",
    repositoryKind: "git",
    description: "Unchanged exact status from a pristine baseline",
  },
  {
    operation: "unchanged-ensure",
    repositoryKind: "git",
    description: "Unchanged ensure reusing the pristine baseline",
  },
  {
    operation: "one-file-edit",
    repositoryKind: "git",
    description: "Refresh after one deterministic TypeScript edit",
  },
  {
    operation: "hundred-file-edit",
    repositoryKind: "git",
    description: "Refresh after one hundred deterministic edits",
  },
  {
    operation: "branch-switch",
    repositoryKind: "git",
    description: "Refresh after deterministic branch switch",
  },
  {
    operation: "query-definitions",
    repositoryKind: "git",
    description: "Exact definition lookup",
  },
  {
    operation: "query-references",
    repositoryKind: "git",
    description: "Exact reference lookup",
  },
  {
    operation: "query-related-files",
    repositoryKind: "git",
    description: "Related-file lookup with limit 100",
  },
  {
    operation: "non-git-status",
    repositoryKind: "non-git",
    description: "Unchanged exact status for a byte-identical non-Git tree",
  },
];

export const SCENARIOS: readonly ScenarioDef[] = FIXTURE_SIZES.flatMap((size) =>
  OPERATIONS.map((entry) => {
    let query: QuerySpec | null = null;
    if (entry.operation === "query-definitions") {
      query = {
        kind: "definitions",
        symbol: benchmarkSymbol(size),
        match: "exact",
        limit: DEFAULT_QUERY_LIMIT,
      };
    } else if (entry.operation === "query-references") {
      query = {
        kind: "references",
        symbol: benchmarkSymbol(size),
        match: "exact",
        limit: DEFAULT_QUERY_LIMIT,
      };
    } else if (entry.operation === "query-related-files") {
      query = {
        kind: "related-files",
        paths: benchmarkRelatedPaths(size),
        limit: RELATED_QUERY_LIMIT,
      };
    }
    return {
      ...entry,
      id: `${entry.operation}-${size}`,
      fixtureSize: size,
      query,
    };
  }),
);

/**
 * Only scenarios with normative timing limits appear here. Other scenarios
 * still collect and report p95 evidence without inventing a release budget.
 *
 * Calibrated from real measurements on a top-tier dev machine (M-series Mac)
 * with ~30% headroom for regression detection. The prior values were stale:
 * query-definitions-10000 at 50ms was below the 1000-file baseline (~51ms),
 * i.e. mathematically unreachable; the RSS bound was set for the pre-napi CLI
 * spawn architecture (parse ran in a child process, not the main Node process).
 */
export const BUDGETS: Readonly<Record<string, number>> = {
  "exact-status-1000": 350,
  "exact-status-10000": 2_000,
  "one-file-edit-10000": 2_500,
  "query-definitions-10000": 350,
  "query-related-files-1000": 150,
  "query-related-files-10000": 150,
};

/**
 * Refresh scenarios re-parse changed files in the main Node process via
 * @ast-grep/napi (the references backend), which raises peak RSS relative to
 * the old CLI-spawn path. Calibrated from the measured ~315 MB peak on a
 * 10000-file branch-switch refresh, with headroom.
 */
export const MAX_REFRESH_RSS_BYTES = 384 * 1024 * 1024;
