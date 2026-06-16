#!/usr/bin/env node
process.env.CPB_FAKE_ACP_MODE = "permission-terminal";
await import("./fake-acp-base.js");
export {};
