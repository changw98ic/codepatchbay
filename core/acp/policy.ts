import { recordValue, type LooseRecord } from "../../shared/types.js";
import {
  codexFilesystemBoundaryConfigArgs,
  parseAgentFilesystemBoundary,
} from "../policy/filesystem-boundary.js";
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
  // Headless coding lanes expose only the MCP servers that CPB declares
  // explicitly. Codex `apps` otherwise opens the signed-in product-service
  // MCP (`/backend-api/ps/mcp`) even with an isolated HOME, making startup
  // and task outcomes depend on an undeclared remote tool boundary.
  '-c', 'features.apps=false',
  '-c', 'features.plugins=false',
  '-c', 'features.remote_plugin=false',
  '-c', 'plugins."computer-use@openai-bundled".enabled=false',
  '-c', 'plugins."browser@openai-bundled".enabled=false',
  '-c', 'plugins."chrome@openai-bundled".enabled=false',
  '-c', 'notify=[]',
];

const CODEX_COMMANDS = new Set(["codex-acp", "npx"]);

const CODEX_MUTATING_PHASES = new Set(["execute", "remediate"]);
const CODEX_MUTATING_ROLES = new Set(["executor", "remediator"]);

type CodexExecutionEnv = Record<string, string | undefined>;

/**
 * Codex ACP starts with an isolated HOME, so it cannot inherit a user's
 * sandbox defaults. Resolve the inner Codex sandbox from CPB's phase contract
 * instead of relying on whichever process happened to start first.
 */
export function codexSandboxModeForExecution(env: CodexExecutionEnv = {}) {
  const phase = String(env.CPB_ACP_PHASE || "").trim().toLowerCase();
  const role = String(env.CPB_ACP_ROLE || "").trim().toLowerCase();
  const writableVerificationReplay = (
    phase === "verify" || phase === "adversarial_verify"
  ) && (
    env.CPB_VERIFIER_REPLAY_WORKSPACE_WRITE === "1"
    || env.CPB_CODEX_VERIFIER_WORKSPACE_WRITE === "1"
  );
  return CODEX_MUTATING_PHASES.has(phase)
    || (!phase && CODEX_MUTATING_ROLES.has(role))
    || writableVerificationReplay
    ? "workspace-write"
    : "read-only";
}

export function codexSandboxEnforcementForExecution(env: CodexExecutionEnv = {}) {
  if (env.CPB_AGENT_SANDBOX_INHERITED === "1") return "codex-inner";
  const outerMode = String(env.CPB_AGENT_SANDBOX || env.CPB_AGENT_SANDBOX_MODE || "required")
    .trim()
    .toLowerCase();
  return outerMode === "required" || outerMode === "strict"
    ? "cpb-outer"
    : "codex-inner";
}

export function codexConfiguredSandboxModeForExecution(env: CodexExecutionEnv = {}) {
  // macOS sandbox-exec (and common Linux namespace sandboxes) cannot be
  // reliably nested. When CPB's required outer sandbox is active, let that
  // already-bounded process enforce the effective phase mode and disable the
  // redundant Codex child sandbox. Without a required outer sandbox, Codex
  // enforces the phase mode itself.
  return codexSandboxEnforcementForExecution(env) === "cpb-outer"
    ? "danger-full-access"
    : codexSandboxModeForExecution(env);
}

export function codexExecutionConfigArgs(
  command: string,
  args: string[] = [],
  env: CodexExecutionEnv = {},
) {
  const baseCommand = String(command).split("/").pop();
  const isCodexAcp = baseCommand === "codex-acp"
    || (baseCommand === "npx" && Array.isArray(args) && args.some((arg) => arg === "@zed-industries/codex-acp"));
  if (!isCodexAcp) return [];

  const filesystemBoundary = parseAgentFilesystemBoundary(env.CPB_AGENT_FS_BOUNDARY_JSON);
  if (filesystemBoundary) {
    return codexFilesystemBoundaryConfigArgs(
      filesystemBoundary,
      codexSandboxModeForExecution(env) === "workspace-write" ? "write" : "read",
      [env.HOME, env.CODEX_HOME, env.TMPDIR, env.TMP, env.TEMP]
        .filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
    );
  }

  return [
    "-c", `sandbox_mode=${JSON.stringify(codexConfiguredSandboxModeForExecution(env))}`,
    // ACP is non-interactive. Waiting for an approval that CPB cannot surface
    // turns a recoverable command denial into an unexplained phase timeout.
    "-c", 'approval_policy="never"',
  ];
}

export function normalizeAcpProfile(profile: unknown): string | null {
  if (profile === undefined || profile === null || profile === "") return "headless";
  const lower = String(profile).toLowerCase();
  if (VALID_PROFILES.has(lower)) return lower;
  return null;
}

export function resolveAcpLane({ profile, uiLane, uiLaneReason }: LooseRecord = {}) {
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

export function headlessCodexConfigArgs(command: string, args: string[] = []) {
  const baseCommand = String(command).split("/").pop();
  if (baseCommand === "codex-acp") return [...CODEX_HEADLESS_CONFIG_OVERRIDES];
  // npx fallback: npx -y @zed-industries/codex-acp
  if (baseCommand === "npx" && Array.isArray(args) && args.some(a => a === "@zed-industries/codex-acp")) {
    return [...CODEX_HEADLESS_CONFIG_OVERRIDES];
  }
  return [];
}

export function classifyUiToolRequest(message: unknown) {
  const request = recordValue(message);
  const method = typeof request.method === "string" ? request.method : "";
  const params = recordValue(request.params);

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

export function detectUiEscalation(text: string) {
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
