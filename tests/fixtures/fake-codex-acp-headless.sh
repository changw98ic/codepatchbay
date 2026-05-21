#!/usr/bin/env bash
# Wrapper that delegates to the Node.js fake agent for process-tree tests (issue #62).
# Records args to a marker file, writes a process-tree marker, then acts as
# a minimal ACP agent over stdio JSON-RPC.
exec "$(dirname "$0")/fake-codex-acp-headless.mjs" "$@"
