#!/usr/bin/env node
import { inspectProcessIdentityCapability } from "../shared/primitives/process-identity-capability.js";

const capability = inspectProcessIdentityCapability();
const report = {
  capability: "process-identity",
  checkedAt: new Date().toISOString(),
  ...capability,
  lockPolicy: capability.staleOwnerRecovery
    ? "exact-owner recovery enabled"
    : "new exclusive locks allowed; automatic stale-owner recovery disabled",
};

console.log(JSON.stringify(report, null, 2));
if (!capability.ok) process.exitCode = 1;
