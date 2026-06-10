#!/usr/bin/env node
process.env.CPB_FAKE_ACP_MODE = "active";
await import("./fake-acp-base.mjs");
