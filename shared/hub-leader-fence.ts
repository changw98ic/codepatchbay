import type { RedisLeaderFence } from "./hub-state-redis.js";

const processFences = new Map<string, RedisLeaderFence>();

export function registerProcessLeaderFence(identityFingerprint: string, fence: RedisLeaderFence) {
  processFences.set(identityFingerprint, { ...fence });
}

export function processLeaderFence(identityFingerprint: string) {
  const fence = processFences.get(identityFingerprint);
  return fence ? { ...fence } : null;
}
