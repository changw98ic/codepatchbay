// @ts-nocheck
// acp-lane-policy.js — Headless/UI ACP lane resolution and UI tool enforcement for issue #62

const VALID_PROFILES = new Set(["headless", "ui"]);

const UI_TOOL_ALIASES = new Set([
  "computer-use",
  "computer_use",
  "SkyComputerUseClient",
  "browser",
  "chrome",
  "desktop",
  "desktop_automation",
  "text_edit",
]);

const UI_TOOL_PREFIXES = [
  "computer-use/",
  "computer_use/",
  "browser/",
  "chrome/",
  "desktop/",
  "desktop_automation/",
];

const MCP_UI_SERVER_NAMES = new Set([
  "computer-use",
  "computer_use",
  "SkyComputerUseClient",
  "browser",
  "chrome",
  "desktop",
  "desktop_automation",
]);

const ESCALATION_MARKERS = ["needs_ui_observation", "needs_browser_check", "blocked_requires_ui_lane"];

const CODEX_HEADLESS_CONFIG_OVERRIDES = [
  '-c', 'plugins."computer-use@openai-bundled".enabled=false',
  '-c', 'plugins."browser@openai-bundled".enabled=false',
  '-c', 'plugins."chrome@openai-bundled".enabled=false',
  '-c', 'notify=[]',
];

const CODEX_COMMANDS = new Set(["codex-acp", "npx"]);

export function normalizeAcpProfile(profile) {
  if (profile === undefined || profile === null || profile === "") return "headless";
  const lower = String(profile).toLowerCase();
  if (VALID_PROFILES.has(lower)) return lower;
  return null;
}

export function resolveAcpLane({ profile, uiLane, uiLaneReason } = {}) {
  const normalized = normalizeAcpProfile(profile);
  if (normalized === null) {
    return { error: `invalid ACP profile: ${profile}. Accepted values: headless, ui` };
  }
  const isUi = normalized === "ui";
  if (isUi && (!uiLaneReason || String(uiLaneReason).trim() === "")) {
    return { error: "ui profile requires a non-empty uiLaneReason" };
  }
  return {
    profile: normalized,
    uiLane: isUi,
    uiLaneReason: isUi ? String(uiLaneReason).trim() : "",
  };
}

export function headlessCodexConfigArgs(command, args = []) {
  const baseCommand = String(command).split("/").pop();
  if (baseCommand === "codex-acp") return [...CODEX_HEADLESS_CONFIG_OVERRIDES];
  // npx fallback: npx -y @zed-industries/codex-acp
  if (baseCommand === "npx" && Array.isArray(args) && args.some(a => a === "@zed-industries/codex-acp")) {
    return [...CODEX_HEADLESS_CONFIG_OVERRIDES];
  }
  return [];
}

export function classifyUiToolRequest(message) {
  if (!message || typeof message !== "object") return false;
  const method = message.method || "";
  const params = message.params || {};

  // Direct method match against known UI aliases
  for (const alias of UI_TOOL_ALIASES) {
    if (method === alias) return true;
  }

  // Prefix match for slash-separated tool names
  for (const prefix of UI_TOOL_PREFIXES) {
    if (method.startsWith(prefix)) return true;
  }

  // Dot-prefixed names like .browser, .computer-use
  if (method.startsWith(".")) {
    const afterDot = method.slice(1);
    for (const alias of UI_TOOL_ALIASES) {
      if (afterDot === alias || afterDot.startsWith(alias + "/") || afterDot.startsWith(alias + ".")) return true;
    }
  }

  // Dot-separated tool calls like browser.navigate, computer.use, chrome.tab
  const DOT_UI_PREFIXES = ["computer.use.", "computer-use.", "browser.", "chrome.", "desktop.", "desktop_automation.", "SkyComputerUseClient."];
  for (const prefix of DOT_UI_PREFIXES) {
    if (method.startsWith(prefix) || method === prefix.replace(/\.$/, "")) return true;
  }

  // MCP-shaped request: check server name fields
  const serverNameFields = [
    params.serverName,
    params.mcpServerName,
    params.name,
    params.toolName,
    params.title,
  ];
  for (const field of serverNameFields) {
    if (field && MCP_UI_SERVER_NAMES.has(String(field))) return true;
  }

  return false;
}

export function mergeHeadlessDenyTools(existingDenyTools = "") {
  const uiTools = [
    "computer-use",
    "computer_use",
    "SkyComputerUseClient",
    "browser",
    "chrome",
    "desktop",
    "desktop_automation",
  ];
  const existing = existingDenyTools.split(",").map((t) => t.trim()).filter(Boolean);
  const combined = new Set([...existing, ...uiTools]);
  return [...combined].join(",");
}

export function detectUiEscalation(text) {
  if (!text || typeof text !== "string") return [];
  const found = [];
  for (const marker of ESCALATION_MARKERS) {
    const regex = new RegExp(`\\b${marker}\\b`, "g");
    const match = regex.exec(text);
    if (match) {
      // Extract a short reason after the marker (rest of line, up to 200 chars)
      const afterMarker = text.slice(match.index + marker.length).split("\n")[0].trim();
      const reason = afterMarker.replace(/^[:\s-]*/, "").slice(0, 200) || "";
      found.push({ marker, reason });
    }
  }
  return found;
}
