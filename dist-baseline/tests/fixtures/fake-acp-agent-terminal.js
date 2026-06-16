#!/usr/bin/env node
process.env.CPB_FAKE_ACP_MODE = "terminal";
await import("./fake-acp-base.js");
export {};
