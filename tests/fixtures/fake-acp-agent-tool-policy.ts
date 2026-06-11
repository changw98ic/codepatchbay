#!/usr/bin/env node
process.env.CPB_FAKE_ACP_MODE = "tool-policy";
await import("./fake-acp-base.js");
