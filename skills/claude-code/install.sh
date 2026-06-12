#!/bin/bash
# install.sh — Register CPB MCP server in Claude Code settings
#
# Usage:
#   bash skills/claude-code/install.sh
#
# Adds an "cpb" entry to ~/.claude/settings.json so Claude Code can use
# CPB tools natively.  Safe to run multiple times -- it updates in place.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CPB_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVER_PATH="$SCRIPT_DIR/cpb-mcp-server.ts"

SETTINGS_FILE="$HOME/.claude/settings.json"

echo "CPB root:      $CPB_ROOT"
echo "Server path:   $SERVER_PATH"
echo "Settings file: $SETTINGS_FILE"
echo

# Verify dist/ exists (MCP server imports from compiled JS)
if [ ! -d "$CPB_ROOT/dist/server/services/hub" ]; then
  echo "ERROR: dist/ not found. Build the project first:" >&2
  echo "  cd $CPB_ROOT && npm run build" >&2
  exit 1
fi

# Ensure settings file exists with valid JSON
if [ ! -f "$SETTINGS_FILE" ]; then
  echo "Creating $SETTINGS_FILE ..."
  mkdir -p "$(dirname "$SETTINGS_FILE")"
  echo '{}' > "$SETTINGS_FILE"
fi

# Use node to do the JSON merge (avoids jq dependency)
node -e '
const fs = require("fs");
const path = require("path");

const settingsPath = process.argv[1];
const serverPath = process.argv[2];
const cpbRoot = process.argv[3];

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
} catch {
  settings = {};
}

if (!settings.mcpServers) settings.mcpServers = {};

settings.mcpServers.cpb = {
  command: "node",
  args: [serverPath],
  env: {
    CPB_ROOT: cpbRoot,
  },
};

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log("Updated " + settingsPath);
console.log("  mcpServers.cpb = { command: \"node\", args: [\"" + serverPath + "\"] }");
' "$SETTINGS_FILE" "$SERVER_PATH" "$CPB_ROOT"

echo
echo "Done. Restart Claude Code (or reload) to pick up the new MCP server."
