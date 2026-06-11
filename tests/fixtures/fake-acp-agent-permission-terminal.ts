#!/usr/bin/env node
// @ts-nocheck
process.env.CPB_FAKE_ACP_MODE = "permission-terminal";
await import("./fake-acp-base.js");
