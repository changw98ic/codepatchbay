#!/usr/bin/env node
process.env.CPB_FAKE_ACP_MODE = "env-capture";
await import("./fake-acp-base.js");
