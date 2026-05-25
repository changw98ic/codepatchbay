import { detectSecretInput } from "./secret-policy.js";

export const CHANNEL_COMMAND_HELP = [
  "CodePatchBay channel commands:",
  "/cpb run <project> <task> [--workflow <name>] [--plan-mode <mode>] [--triage <auto|rules|none>]",
  "/cpb issue <project> <number> [--workflow <name>] [--plan-mode <mode>] [--triage <auto|rules|none>]",
  "/cpb status <job>",
  "/cpb approve <job>",
  "/cpb cancel <job>",
  "/cpb retry <job>",
  "/cpb logs <job>",
].join("\n");

const SAFE_PROJECT = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

function baseFields(extra = {}) {
  return {
    project: null,
    job: null,
    issue: null,
    task: null,
    workflow: null,
    planMode: null,
    triage: null,
    ...extra,
  };
}

function errorResult(code, message, extra = {}) {
  return {
    ok: false,
    type: "error",
    command: extra.command || null,
    code,
    message,
    help: CHANNEL_COMMAND_HELP,
    ...baseFields(extra),
  };
}

export function tokenizeChannelCommand(input) {
  const text = String(input ?? "");
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const ch of text) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaping) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

function stripInvocation(tokens) {
  const rest = [...tokens];
  while (rest[0] && (/^<@[^>]+>$/.test(rest[0]) || /^@\S+$/.test(rest[0]))) {
    rest.shift();
  }
  if (rest[0] === "/cpb" || rest[0]?.toLowerCase() === "cpb") {
    rest.shift();
    return rest;
  }
  return null;
}

function extractRoutingOptions(tokens, defaultWorkflow = "standard") {
  const positional = [];
  let workflow = defaultWorkflow;
  let planMode = null;
  let triage = null;
  let workflowRequested = false;
  let planModeRequested = false;
  let triageRequested = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--workflow" || token === "-w") {
      const value = tokens[i + 1];
      if (!value) {
        return { error: "missing workflow value", positional, workflow, planMode, triage };
      }
      workflow = value;
      workflowRequested = true;
      i += 1;
      continue;
    }
    if (token.startsWith("--workflow=")) {
      const value = token.slice("--workflow=".length);
      if (!value) {
        return { error: "missing workflow value", positional, workflow, planMode, triage };
      }
      workflow = value;
      workflowRequested = true;
      continue;
    }
    if (token === "--plan-mode") {
      const value = tokens[i + 1];
      if (!value) {
        return { error: "missing plan-mode value", positional, workflow, planMode, triage };
      }
      planMode = value;
      planModeRequested = true;
      i += 1;
      continue;
    }
    if (token.startsWith("--plan-mode=")) {
      const value = token.slice("--plan-mode=".length);
      if (!value) {
        return { error: "missing plan-mode value", positional, workflow, planMode, triage };
      }
      planMode = value;
      planModeRequested = true;
      continue;
    }
    if (token === "--triage") {
      const value = tokens[i + 1];
      if (!value || value.startsWith("--")) {
        triage = "auto";
      } else {
        triage = value;
        i += 1;
      }
      triageRequested = true;
      continue;
    }
    if (token.startsWith("--triage=")) {
      const value = token.slice("--triage=".length);
      if (!value) {
        return { error: "missing triage value", positional, workflow, planMode, triage };
      }
      triage = value;
      triageRequested = true;
      continue;
    }
    if (token === "--no-triage") {
      triage = "none";
      triageRequested = true;
      continue;
    }
    positional.push(token);
  }

  return {
    positional,
    workflow,
    planMode,
    triage,
    workflowRequested,
    planModeRequested,
    triageRequested,
    error: null,
  };
}

function validProject(project) {
  return typeof project === "string" && SAFE_PROJECT.test(project);
}

function parsePositiveInteger(value) {
  if (!/^[0-9]+$/.test(String(value ?? ""))) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function okResult(type, fields) {
  return {
    ok: true,
    type,
    command: type,
    ...baseFields(fields),
  };
}

function parseRun(command, tokens) {
  const {
    positional,
    workflow,
    planMode,
    triage,
    workflowRequested,
    planModeRequested,
    triageRequested,
    error,
  } = extractRoutingOptions(tokens, "standard");
  if (error) return errorResult("INVALID_COMMAND", error, { command });

  const [project, ...taskParts] = positional;
  const task = taskParts.join(" ").trim();
  if (!validProject(project) || !task) {
    return errorResult("INVALID_COMMAND", "run requires project and task", { command });
  }

  return okResult("run", {
    project,
    task,
    workflow,
    planMode,
    triage,
    workflowRequested,
    planModeRequested,
    triageRequested,
  });
}

function parseIssue(command, tokens) {
  const {
    positional,
    workflow,
    planMode,
    triage,
    workflowRequested,
    planModeRequested,
    triageRequested,
    error,
  } = extractRoutingOptions(tokens, "standard");
  if (error) return errorResult("INVALID_COMMAND", error, { command });

  const [project, issueValue] = positional;
  const issue = parsePositiveInteger(issueValue);
  if (!validProject(project) || !issue) {
    return errorResult("INVALID_COMMAND", "issue requires project and numeric issue", { command });
  }

  return okResult("issue", {
    project,
    issue,
    workflow,
    planMode,
    triage,
    workflowRequested,
    planModeRequested,
    triageRequested,
  });
}

function parseJobCommand(command, tokens) {
  const [job] = tokens;
  if (!job) {
    return errorResult("INVALID_COMMAND", `${command} requires job`, { command });
  }
  return okResult(command, { job });
}

export function parseChannelCommand(input) {
  const detection = detectSecretInput(input);
  if (detection.matched) {
    return {
      ...errorResult("SECRET_INPUT_REJECTED", detection.guidance),
      guidance: detection.guidance,
      detection,
    };
  }

  const tokens = stripInvocation(tokenizeChannelCommand(input));
  if (!tokens) {
    return errorResult("NOT_CPB_COMMAND", "message is not a CodePatchBay command");
  }
  const command = tokens.shift()?.toLowerCase() || "";
  if (!command) {
    return errorResult("INVALID_COMMAND", "missing command");
  }

  if (command === "run") return parseRun(command, tokens);
  if (command === "issue") return parseIssue(command, tokens);
  if (command === "status" || command === "approve" || command === "cancel" || command === "retry" || command === "logs") {
    return parseJobCommand(command, tokens);
  }

  return errorResult("UNKNOWN_COMMAND", `unknown command: ${command}`, { command });
}
