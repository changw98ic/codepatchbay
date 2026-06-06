import { readdir, access, constants, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { listProviders, loadProvider } from "../../core/agents/drivers/browser/provider-loader.mjs";
import { LoginRequiredError } from "../../core/agents/drivers/browser/profile-schema.mjs";
import { BrowserAgentLoginRequiredError } from "../../core/agents/drivers/browser/errors.mjs";

const CYAN = "\x1b[0;36m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const RED = "\x1b[0;31m";
const BOLD = "\x1b[1m";
const NC = "\x1b[0m";

const PROFILE_ROOT = path.join(os.homedir(), ".cpb", "browser-agents");

function isJson(args) {
  return args.includes("--json");
}

async function profileExists(providerName) {
  try {
    const statePath = path.join(PROFILE_ROOT, providerName, "profile-0", "state.json");
    await access(statePath, constants.F_OK);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    return state.status === "ready";
  } catch {
    return false;
  }
}

async function writeProfileState(providerName) {
  const statePath = path.join(PROFILE_ROOT, providerName, "profile-0", "state.json");
  await writeFile(statePath, JSON.stringify({ status: "ready", readyAt: new Date().toISOString() }, null, 2));
}

function formatMinutes(ms) {
  return `${Math.round(ms / 60000)}min`;
}

async function cmdProviders(args) {
  const providers = await listProviders();
  const json = isJson(args);

  if (json) {
    const out = [];
    for (const p of providers) {
      out.push({
        name: p.name,
        displayName: p.displayName,
        support: p.support.tier,
        requiresManualLogin: p.support.requiresManualLogin,
        loggedIn: await profileExists(p.name),
      });
    }
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }

  console.log(`${BOLD}Provider       Status        Support        Login${NC}`);
  for (const p of providers) {
    const status = await profileExists(p.name) ? `${GREEN}logged-in${NC}` : `${YELLOW}unknown${NC}`;
    const support = p.support.tier;
    const login = p.support.requiresManualLogin ? "required" : "optional";
    console.log(`${p.name.padEnd(14)} ${status.padEnd(13)} ${support.padEnd(14)} ${login}`);
  }
  return 0;
}

async function cmdShow(args) {
  const providerName = args[0];
  if (!providerName) {
    console.error("Usage: cpb browser show <provider>");
    return 1;
  }

  let provider;
  try {
    provider = await loadProvider(providerName);
  } catch (err) {
    console.error(`Provider not found: ${providerName}`);
    return 1;
  }

  const json = isJson(args);
  if (json) {
    console.log(JSON.stringify(provider, null, 2));
    return 0;
  }

  console.log(`Name: ${provider.name}`);
  console.log(`Display: ${provider.displayName}`);
  console.log(`Support: ${provider.support.tier} (requiresManualLogin: ${provider.support.requiresManualLogin})`);
  console.log(`URL: ${provider.startUrl}`);
  console.log(`Input: ${provider.input.kind} via ${provider.input.submit.mode}`);
  console.log(`Response: ${provider.response.mode}, stableRounds=${provider.response.stableRounds}, maxWait=${formatMinutes(provider.response.maxWaitMs)}`);
  console.log(`Continue: ${provider.continue.enabled ? "enabled" : "disabled"} (maxClicks=${provider.continue.maxClicks || 5})`);
  console.log(`Diagnostics: screenshotOnFailure=${provider.diagnostics.screenshotOnFailure}`);
  return 0;
}

async function cmdLogin(args) {
  const providerName = args[0];
  if (!providerName) {
    console.error("Usage: cpb browser login <provider>");
    return 1;
  }

  let provider;
  try {
    provider = await loadProvider(providerName);
  } catch (err) {
    console.error(`Provider not found: ${providerName}`);
    return 1;
  }

  const profileDir = path.join(PROFILE_ROOT, providerName, "profile-0");
  await mkdir(profileDir, { recursive: true });

  console.log(`Opening ${provider.displayName} login page...`);
  console.log("Please log in manually. The browser will stay open for 60 seconds after login.");

  const { chromium } = await import("playwright");
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  try {
    const page = await context.newPage();
    await page.goto(provider.auth.loginUrl);

    try {
      await page.waitForSelector(provider.auth.readyCheck.selector, { timeout: 60000 });
      await writeProfileState(providerName);
      console.log(`Login detected for ${providerName}!`);
    } catch {
      console.log(`Timeout waiting for login. You can retry with: cpb browser login ${providerName}`);
    }
  } finally {
    await context.close();
  }

  return 0;
}

async function cmdLogout(args) {
  const providerName = args[0];
  if (!providerName) {
    console.error("Usage: cpb browser logout <provider>");
    return 1;
  }

  const profileDir = path.join(PROFILE_ROOT, providerName);
  await rm(profileDir, { recursive: true, force: true });
  console.log(`Logged out and removed profile for ${providerName}`);
  return 0;
}

const TEST_PROMPT = `Reply with exactly:\n{"status":"ok","message":"browser-agent-ready"}`;

async function cmdTest(args) {
  const providerName = args[0];
  if (!providerName) {
    console.error("Usage: cpb browser test <provider>");
    return 1;
  }

  let result;
  try {
    const { executeBrowserAgent } = await import("../../core/agents/drivers/browser/engine.mjs");
    result = await executeBrowserAgent({
      providerName,
      prompt: TEST_PROMPT,
      timeoutMs: 120000,
    });
  } catch (err) {
    if (err instanceof LoginRequiredError || err instanceof BrowserAgentLoginRequiredError) {
      console.error(JSON.stringify({ ok: false, provider: providerName, error: "login required" }));
      return 1;
    }
    console.error(JSON.stringify({ ok: false, provider: providerName, error: err.message }));
    return 1;
  }

  try {
    const parsed = JSON.parse(result.text);
    if (parsed.status === "ok" && parsed.message === "browser-agent-ready") {
      console.log(JSON.stringify({ ok: true, provider: providerName, status: "ready" }));
      return 0;
    }
  } catch {}

  console.error(JSON.stringify({
    ok: false,
    provider: providerName,
    error: "unexpected response",
    response: result.text.slice(0, 200),
  }));
  return 1;
}

async function cmdDoctor(args, cpbRoot) {
  const json = isJson(args);
  const checks = [];
  let ok = true;

  // 1. Playwright installed
  try {
    const { chromium: _chromium } = await import("playwright");
    checks.push({ name: "playwright", status: "ok" });
  } catch {
    checks.push({ name: "playwright", status: "fail", detail: "playwright package not installed" });
    ok = false;
  }

  // 2. Chromium executable
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    checks.push({ name: "chromium", status: "ok" });
  } catch (err) {
    checks.push({ name: "chromium", status: "fail", detail: err.message });
    ok = false;
  }

  // 3. Profile directory writable
  try {
    await mkdir(PROFILE_ROOT, { recursive: true });
    checks.push({ name: "profile-dir", status: "ok" });
  } catch (err) {
    checks.push({ name: "profile-dir", status: "fail", detail: err.message });
    ok = false;
  }

  // 4. Provider profiles
  try {
    const providers = await listProviders();
    checks.push({ name: "profiles", status: "ok", count: providers.length });
  } catch (err) {
    checks.push({ name: "profiles", status: "fail", detail: err.message });
    ok = false;
  }

  // 5. Descriptor registered
  const descriptorPath = path.join(cpbRoot, "core/agents/descriptors/browser-agent.json");
  try {
    await access(descriptorPath, constants.F_OK);
    checks.push({ name: "descriptor", status: "ok" });
  } catch {
    checks.push({ name: "descriptor", status: "fail", detail: `missing ${descriptorPath}` });
    ok = false;
  }

  // 6. ACP adapter executable
  const acpPath = path.join(cpbRoot, "server/services/browser-agent-acp.mjs");
  try {
    await access(acpPath, constants.X_OK);
    checks.push({ name: "acp-adapter", status: "ok" });
  } catch {
    checks.push({ name: "acp-adapter", status: "fail", detail: `not executable: ${acpPath}` });
    ok = false;
  }

  // 7. Each provider login status
  try {
    const providers = await listProviders();
    for (const p of providers) {
      const loggedIn = await profileExists(p.name);
      checks.push({ name: `login:${p.name}`, status: loggedIn ? "ok" : "warn", detail: loggedIn ? "logged in" : "not logged in" });
    }
  } catch (err) {
    checks.push({ name: "login-check", status: "fail", detail: err.message });
  }

  if (json) {
    console.log(JSON.stringify({ ok, checks }, null, 2));
    return ok ? 0 : 1;
  }

  for (const c of checks) {
    const color = c.status === "ok" ? GREEN : c.status === "warn" ? YELLOW : RED;
    console.log(`  ${color}${c.name}${NC}: ${c.status}${c.detail ? ` — ${c.detail}` : ""}${c.count !== undefined ? ` (${c.count})` : ""}`);
  }

  return ok ? 0 : 1;
}

function cmdInstall() {
  return new Promise((resolve) => {
    const child = spawn("npx", ["playwright", "install", "chromium"], {
      stdio: "inherit",
      shell: false,
    });
    child.on("close", (code) => resolve(code || 0));
  });
}

async function cmdReset(args) {
  const providerName = args[0];
  if (!providerName) {
    console.error("Usage: cpb browser reset <provider>");
    return 1;
  }

  await cmdLogout([providerName]);
  console.log(`Profile reset for ${providerName}. Run: cpb browser login ${providerName}`);
  return 0;
}

async function cmdDiagnostics(args) {
  const providerName = args[0];
  if (!providerName) {
    console.error("Usage: cpb browser diagnostics <provider>");
    return 1;
  }

  const diagDir = path.join(PROFILE_ROOT, providerName, "diagnostics");
  const entries = await readdir(diagDir).catch(() => []);

  const json = isJson(args);
  if (json) {
    console.log(JSON.stringify(entries.sort().reverse(), null, 2));
    return 0;
  }

  if (entries.length === 0) {
    console.log(`No diagnostics found for ${providerName}`);
    return 0;
  }

  console.log(`${BOLD}Diagnostics for ${providerName}:${NC}`);
  for (const entry of entries.sort().reverse().slice(0, 10)) {
    console.log(`  ${entry}/`);
  }
  return 0;
}

export async function run(args, { cpbRoot }) {
  const subcmd = args[0];
  const subArgs = args.slice(1);

  if (subcmd === "--help" || subcmd === "-h") {
    console.log("Usage: cpb browser <providers|show|login|logout|test|doctor|install|reset|diagnostics>");
    return 0;
  }

  switch (subcmd) {
    case "providers": return cmdProviders(subArgs);
    case "show": return cmdShow(subArgs);
    case "login": return cmdLogin(subArgs);
    case "logout": return cmdLogout(subArgs);
    case "test": return cmdTest(subArgs);
    case "doctor": return cmdDoctor(subArgs, cpbRoot);
    case "install": return cmdInstall();
    case "reset": return cmdReset(subArgs);
    case "diagnostics": return cmdDiagnostics(subArgs);
    default:
      if (subcmd && !subcmd.startsWith("-")) {
        console.error(`Unknown browser command: ${subcmd}`);
      }
      console.log("Usage: cpb browser <providers|show|login|logout|test|doctor|install|reset|diagnostics>");
      return subcmd ? 1 : 0;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2), { cpbRoot: process.env.CPB_ROOT || path.resolve("..") })
    .then((code) => {
      if (Number.isInteger(code)) process.exitCode = code;
    })
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    });
}
