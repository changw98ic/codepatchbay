#!/usr/bin/env node
process.env.CPB_FAKE_ACP_MODE = "default";
await import("./fake-acp-base.mjs");
