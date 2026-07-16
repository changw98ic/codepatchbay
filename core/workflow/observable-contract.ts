import { createHash } from "node:crypto";

import { recordValue, type LooseRecord } from "../contracts/types.js";
import { recordArray, text } from "./checklist-shared.js";

export const OBSERVATION_KINDS = new Set([
  "exact_text",
  "contains_text",
  "state_transition",
  "invariant",
]);

const TEXT_OBSERVATION_KINDS = new Set(["exact_text", "contains_text"]);
const TEXT_BEHAVIOR_SIGNAL = /(?:diagnostic|error\s+message|exception\s+message|message\s+(?:text|wording)|human[- ]readable|render(?:ed|ing)?|format(?:ted|ting)?|stdout|stderr|response\s+body|output\s+text|错误信息|异常信息|提示文本|提示语|文案|输出文本)/i;

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map((entry) => text(entry)).filter(Boolean) : [];
}

function normalizedSourceRefs(value: unknown) {
  return recordArray(value)
    .map((ref) => ({
      kind: text(ref.kind),
      locator: text(ref.locator),
      ...(text(ref.sha256) ? { sha256: text(ref.sha256) } : {}),
    }))
    .filter((ref) => ref.kind && ref.locator);
}

export function normalizeObservableContract(value: unknown) {
  const contract = recordValue(value);
  return {
    observationKind: text(contract.observationKind),
    probeInput: text(contract.probeInput),
    expectedObservation: text(contract.expectedObservation),
    forbiddenObservations: stringArray(contract.forbiddenObservations),
    oracleSourceRefs: normalizedSourceRefs(contract.oracleSourceRefs),
    candidateIndependent: contract.candidateIndependent === true,
  };
}

export function validateObservableContract(value: unknown, prefix = "observableContract") {
  const contract = normalizeObservableContract(value);
  if (!OBSERVATION_KINDS.has(contract.observationKind)) {
    return { ok: false as const, reason: `${prefix}.observationKind is invalid` };
  }
  if (!contract.probeInput) return { ok: false as const, reason: `${prefix}.probeInput is required` };
  if (!contract.expectedObservation) return { ok: false as const, reason: `${prefix}.expectedObservation is required` };
  if (contract.oracleSourceRefs.length === 0) {
    return { ok: false as const, reason: `${prefix}.oracleSourceRefs is required` };
  }
  if (contract.candidateIndependent !== true) {
    return { ok: false as const, reason: `${prefix}.candidateIndependent must be true` };
  }
  if (TEXT_OBSERVATION_KINDS.has(contract.observationKind) && contract.forbiddenObservations.length === 0) {
    return { ok: false as const, reason: `${prefix}.forbiddenObservations must include at least one negative oracle` };
  }
  if (contract.forbiddenObservations.includes(contract.expectedObservation)) {
    return { ok: false as const, reason: `${prefix}.expectedObservation cannot also be forbidden` };
  }
  return { ok: true as const, reason: "", contract };
}

export function validatePlanObservableContracts(
  items: LooseRecord[],
  { task = "", problemModel = "" }: { task?: string; problemModel?: string } = {},
) {
  const normalized: LooseRecord[] = [];
  for (const [index, item] of items.entries()) {
    const validation = validateObservableContract(item.observableContract, `decomposedItems[${index}].observableContract`);
    if (!validation.ok) return { ok: false as const, reason: validation.reason };
    normalized.push({ ...item, observableContract: validation.contract });
  }
  const observableText = [
    task,
    problemModel,
    ...items.flatMap((item) => [text(item.requirement), text(item.expectedEvidence)]),
  ].join("\n");
  if (
    TEXT_BEHAVIOR_SIGNAL.test(observableText)
    && !normalized.some((item) => TEXT_OBSERVATION_KINDS.has(text(recordValue(item.observableContract).observationKind)))
  ) {
    return {
      ok: false as const,
      reason: "a user-visible text or diagnostic task requires an exact_text or contains_text observableContract",
    };
  }
  return { ok: true as const, reason: "", items: normalized };
}

export function freezeObservableContract(value: unknown, itemIndex: number) {
  const contract = normalizeObservableContract(value);
  const contractId = `OBS-${String(itemIndex + 1).padStart(3, "0")}`;
  const frozen = {
    ...contract,
    contractId,
    frozenBeforeExecution: true,
  };
  return {
    ...frozen,
    contractSha256: observableContractSha256(frozen),
  };
}

export function observableContractSha256(value: unknown) {
  const contract = recordValue(value);
  const hashInput = {
    ...normalizeObservableContract(contract),
    contractId: text(contract.contractId),
    frozenBeforeExecution: contract.frozenBeforeExecution === true,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(hashInput)).digest("hex")}`;
}

function decodedCommand(command: string) {
  return command
    .replaceAll("\\\"", "\"")
    .replaceAll("\\'", "'")
    .replaceAll("\\\\", "\\");
}

function commandContains(command: string, value: string) {
  if (!value) return false;
  const decoded = decodedCommand(command);
  return command.includes(value)
    || decoded.includes(value)
    || command.includes(JSON.stringify(value).slice(1, -1));
}

function commandIsAssertion(command: string, observationKind: string) {
  const decoded = decodedCommand(command);
  if (!/(?:\bassert\b|assertEqual|assert_equals?|expect\s*\(|should\b|raise\s+SystemExit|process\.exit\s*\()/i.test(decoded)) {
    return false;
  }
  if (observationKind === "exact_text") {
    return /(?:===|==|assertEqual|assert_equals?|toBe\s*\(|equal\s*\()/i.test(decoded);
  }
  return /(?:\bin\b|contains?\s*\(|includes?\s*\(|match\s*\(|===|==|assert)/i.test(decoded);
}

type FrozenTextContract = {
  contractId: string;
  checklistId: string;
  observationKind: string;
  expectedObservation: string;
  forbiddenObservations: string[];
  allowedFiles: string[];
};

function frozenTextContracts(checklist: LooseRecord | null | undefined): FrozenTextContract[] {
  const items = recordArray(recordValue(checklist).items);
  return items.flatMap((item) => {
    const contract = recordValue(item.observableContract);
    const observationKind = text(contract.observationKind);
    if (!TEXT_OBSERVATION_KINDS.has(observationKind) || contract.frozenBeforeExecution !== true) return [];
    const contractId = text(contract.contractId);
    const checklistId = text(item.id);
    const expectedObservation = text(contract.expectedObservation);
    const forbiddenObservations = stringArray(contract.forbiddenObservations);
    if (!contractId || !checklistId || !expectedObservation || forbiddenObservations.length === 0) return [];
    return [{
      contractId,
      checklistId,
      observationKind,
      expectedObservation,
      forbiddenObservations,
      allowedFiles: stringArray(item.allowedFiles),
    }];
  });
}

function commandBindsContract(command: string, contract: FrozenTextContract) {
  return commandIsAssertion(command, contract.observationKind)
    && commandContains(command, contract.expectedObservation)
    && contract.forbiddenObservations.every((forbidden) => commandContains(command, forbidden));
}

export function observableContractExecutionCoverage(
  checklist: LooseRecord | null | undefined,
  independentExecutions: LooseRecord | null | undefined,
) {
  const contracts = frozenTextContracts(checklist);
  if (contracts.length === 0) {
    return {
      required: false,
      ok: true,
      requiredContractIds: [],
      passedContractIds: [],
      failedContractIds: [],
      missingContractIds: [],
      targetChecklistIds: [],
      fixScope: [],
    };
  }
  const attempts = recordArray(independentExecutions?.attempts).length > 0
    ? recordArray(independentExecutions?.attempts)
    : recordArray(independentExecutions?.observations);
  const passed = new Set<string>();
  const failed = new Set<string>();
  for (const contract of contracts) {
    for (const attempt of attempts) {
      if (text(attempt.executionClass) !== "runtime_probe") continue;
      if (!commandBindsContract(text(attempt.command), contract)) continue;
      const status = text(attempt.status).toLowerCase();
      if (status === "completed") passed.add(contract.contractId);
      else if (["failed", "error", "cancelled"].includes(status)) failed.add(contract.contractId);
    }
  }
  for (const contractId of passed) failed.delete(contractId);
  const missing = contracts
    .map((contract) => contract.contractId)
    .filter((contractId) => !passed.has(contractId) && !failed.has(contractId));
  const affected = contracts.filter((contract) => failed.has(contract.contractId) || missing.includes(contract.contractId));
  return {
    required: true,
    ok: passed.size === contracts.length,
    requiredContractIds: contracts.map((contract) => contract.contractId),
    passedContractIds: [...passed].sort(),
    failedContractIds: [...failed].sort(),
    missingContractIds: missing.sort(),
    targetChecklistIds: [...new Set(affected.map((contract) => contract.checklistId))].sort(),
    fixScope: [...new Set(affected.flatMap((contract) => contract.allowedFiles))].sort(),
  };
}
