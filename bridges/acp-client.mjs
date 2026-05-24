#!/usr/bin/env node
// acp-client.mjs — Moved to runtime/acp-client.mjs
// This file kept for backward compatibility (CLI + import paths)
export { AcpClient, parseToolPolicy, resolveWriteAllowPaths, resolveAgentCommand, main } from "../runtime/acp-client.mjs";

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const { main } = await import("../runtime/acp-client.mjs");
  await main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
