import type { LocalLeaderFence } from "./types/leader-fence.js";

const processFences = new Map<string, LocalLeaderFence>();

export function registerProcessLeaderFence(identityFingerprint: string, fence: LocalLeaderFence) {
  processFences.set(identityFingerprint, { ...fence });
}

export function processLeaderFence(identityFingerprint: string) {
  const fence = processFences.get(identityFingerprint);
  return fence ? { ...fence } : null;
}
