import type { ProcessIdentity } from "../primitives/process-tree.js";

/**
 * Leader fence for local hub coordination.
 * Anchors identity to a local ProcessIdentity.
 */
export type LocalLeaderFence = {
  hubId: string;
  lockToken: string;
  epoch: number;
  processIdentity: ProcessIdentity;
};
