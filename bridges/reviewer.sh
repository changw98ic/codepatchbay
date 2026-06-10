#!/usr/bin/env bash
# reviewer.sh - Thin wrapper delegating to run-phase.mjs
script_dir="$(cd "$(dirname "$0")" && pwd)"
exec node "${script_dir}/run-phase.mjs" review "$@"
