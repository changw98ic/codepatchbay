import path from "node:path";

import { AcpPool } from "../../bridges/acp-pool.mjs";
import { resolveHubRoot } from "./hub-registry.js";

const runtimes = new Map();

function runtimeKey({ cpbRoot, hubRoot }) {
  return `${path.resolve(cpbRoot || process.cwd())}::${path.resolve(hubRoot || resolveHubRoot(cpbRoot))}`;
}

export class ManagedAcpPool extends AcpPool {
  constructor(opts = {}) {
    super(opts);
    this.poolId = opts.poolId || `managed-acp-${process.pid}-${Date.now().toString(36)}`;
    this.mode = "managed-shared";
  }

  status() {
    const base = super.status();
    const pools = {};
    for (const [agent, pool] of Object.entries(base.pools)) {
      pools[agent] = {
        ...pool,
        mode: this.mode,
        capabilities: [
          ...new Set([
            ...(pool.capabilities || []),
            "process-singleton",
            "live-queue-status",
          ]),
        ],
      };
    }
    return {
      ...base,
      poolId: this.poolId,
      mode: this.mode,
      ownerPid: process.pid,
      hubRoot: this.hubRoot,
      cpbRoot: this.cpbRoot,
      pools,
    };
  }
}

export function getManagedAcpPool(opts = {}) {
  const cpbRoot = path.resolve(opts.cpbRoot || process.env.CPB_ROOT || process.cwd());
  const hubRoot = path.resolve(opts.hubRoot || resolveHubRoot(cpbRoot));
  const key = runtimeKey({ cpbRoot, hubRoot });
  if (!runtimes.has(key)) {
    runtimes.set(key, new ManagedAcpPool({ ...opts, cpbRoot, hubRoot }));
  }
  return runtimes.get(key);
}

export async function stopManagedAcpPools() {
  const pools = [...runtimes.values()];
  runtimes.clear();
  await Promise.all(pools.map((pool) => pool.stop()));
}

export function resetManagedAcpPoolsForTests() {
  runtimes.clear();
}
