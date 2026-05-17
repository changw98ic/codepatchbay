import { AcpPool } from "../../bridges/acp-pool.mjs";

const runtimes = new Map();
const managedViews = new Map();

function managedStatus(pool) {
  const status = pool.status();
  return {
    ...status,
    mode: "managed-shared",
    poolSingleton: true,
    pools: Object.fromEntries(Object.entries(status.pools).map(([agent, state]) => [
      agent,
      {
        ...state,
        mode: "pool-admission-singleton",
        poolSingleton: true,
        capabilities: [...new Set([...(state.capabilities || []), "pool-singleton"])],
      },
    ])),
  };
}

function managedView(pool) {
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === "status") return () => managedStatus(target);
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function getPoolRuntime(hubRoot, cpbRoot, opts = {}) {
  if (!runtimes.has(hubRoot)) {
    const persistentProcesses = opts.persistentProcesses ?? (
      opts.runner ? false : process.env.CPB_ACP_PERSISTENT_PROCESS !== "0"
    );
    runtimes.set(hubRoot, new AcpPool({ ...opts, cpbRoot, hubRoot, persistentProcesses }));
  }
  return runtimes.get(hubRoot);
}

export function getManagedAcpPool({ cpbRoot, hubRoot, ...opts } = {}) {
  const pool = getPoolRuntime(hubRoot, cpbRoot, opts);
  if (!managedViews.has(hubRoot)) {
    managedViews.set(hubRoot, managedView(pool));
  }
  return managedViews.get(hubRoot);
}

export function resetPoolRuntime(hubRoot) {
  const pool = runtimes.get(hubRoot);
  if (pool) {
    pool.stop();
    runtimes.delete(hubRoot);
    managedViews.delete(hubRoot);
  }
}

export function resetAllPoolRuntimes() {
  for (const pool of runtimes.values()) pool.stop();
  runtimes.clear();
  managedViews.clear();
}

export const resetManagedAcpPoolsForTests = resetAllPoolRuntimes;
