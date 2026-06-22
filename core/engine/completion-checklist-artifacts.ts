import { readActiveChecklistArtifacts } from "../workflow/checklist-artifacts.js";

type LooseRecord = Record<string, unknown>;

type ArtifactIndex = {
  entries?: LooseRecord[];
};

export type CompletionChecklistArtifactMap = {
  ok?: boolean;
  reason?: string;
  "acceptance-checklist"?: LooseRecord;
  "execution-map"?: LooseRecord;
  "evidence-ledger"?: LooseRecord;
  "checklist-verdict"?: LooseRecord;
  [key: string]: unknown;
};

type GetArtifactIndex = (
  cpbRoot: string,
  project: string,
  jobId: string,
  options: { dataRoot?: string },
) => Promise<ArtifactIndex | null> | ArtifactIndex | null;

type CompletionChecklistArtifactsInput = {
  cpbRoot: string;
  project: string;
  jobId: string;
  dataRoot?: string;
  attemptId?: string | null;
  getArtifactIndex?: GetArtifactIndex | unknown;
};

type CompletionChecklistArtifactsResult = {
  checklistArtifacts: CompletionChecklistArtifactMap;
  artifactInvalidReason: string | null;
};

const REQUIRED_CHECKLIST_ARTIFACT_KINDS = [
  "acceptance-checklist",
  "execution-map",
  "evidence-ledger",
  "checklist-verdict",
];

function artifactEntries(artifactIndex: ArtifactIndex | null): LooseRecord[] {
  return Array.isArray(artifactIndex?.entries) ? artifactIndex.entries : [];
}

function hasChecklistAnchor(artifactIndex: ArtifactIndex | null) {
  return artifactEntries(artifactIndex).some((entry) => entry.kind === "acceptance-checklist");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function loadCompletionChecklistArtifacts({
  cpbRoot,
  project,
  jobId,
  dataRoot,
  attemptId = null,
  getArtifactIndex = null,
}: CompletionChecklistArtifactsInput): Promise<CompletionChecklistArtifactsResult> {
  if (typeof getArtifactIndex !== "function") {
    return { checklistArtifacts: {}, artifactInvalidReason: null };
  }

  try {
    const artifactIndex = await getArtifactIndex(cpbRoot, project, jobId, { dataRoot });
    if (!hasChecklistAnchor(artifactIndex)) {
      return { checklistArtifacts: {}, artifactInvalidReason: null };
    }

    const checklistArtifacts = await readActiveChecklistArtifacts({
      artifactIndex,
      attemptId,
      requiredKinds: REQUIRED_CHECKLIST_ARTIFACT_KINDS,
    }) as CompletionChecklistArtifactMap;
    return {
      checklistArtifacts,
      artifactInvalidReason: checklistArtifacts.ok === false
        ? String(checklistArtifacts.reason || "artifact loading failed")
        : null,
    };
  } catch (error) {
    return {
      checklistArtifacts: {},
      artifactInvalidReason: `artifact index read failed: ${errorMessage(error)}`,
    };
  }
}
