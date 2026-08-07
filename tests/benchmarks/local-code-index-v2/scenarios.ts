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
 * Performance values are observations, not release gates. Every scenario
 * records its p95 and peak RSS so callers can compare runs on the same or
 * different machines without making a machine-specific budget part of the
 * correctness contract.
 */
