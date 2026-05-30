import path from "node:path";
import { readFileSync } from "node:fs";

const CPB_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

export { CPB_VERSION };

export async function run(args, { cpbRoot, executorRoot }) {
  if (args.includes("--json")) {
    const hubRoot = process.env.CPB_HUB_ROOT || path.join(process.env.HOME || ".", ".cpb");
    const result = {
      codeVersion: CPB_VERSION,
      runtimeBackend: "node",
      runtimeBinaryPath: null,
      CPB_ROOT: cpbRoot,
      CPB_EXECUTOR_ROOT: executorRoot,
      hubRoot: path.resolve(hubRoot),
      activeAppReleaseId: null,
      stateFormatVersions: {
        queue: 1,
        jobsEvents: 1,
        leases: 1,
        processRegistry: 1,
        releaseMetadata: 1,
      },
    };
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`cpb v${CPB_VERSION}`);
  }
}
