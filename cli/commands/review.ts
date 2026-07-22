import path from "node:path";

const CYAN = "\x1b[0;36m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const RED = "\x1b[0;31m";
const BOLD = "\x1b[1m";
const NC = "\x1b[0m";

export function resolveReviewWikiDir(cpbRoot: string, project: string, runtimeRoot = process.env.CPB_PROJECT_RUNTIME_ROOT) {
  return runtimeRoot
    ? path.join(runtimeRoot, "wiki")
    : path.join(cpbRoot, "wiki", "projects", project);
}

export async function run(args, { cpbRoot, executorRoot }) {
  const project = args[0];
  if (!project) {
    console.error("Usage: cpb review <project> [deliverable-id] [--agent <name>|--ai]");
    process.exit(1);
  }
  const { readdir, readFile, access, constants } = await import("node:fs/promises");
  const wdir = resolveReviewWikiDir(cpbRoot, project);

  let agentName = "";
  let mode = "";
  const filtered = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--agent") {
      if (args[i + 1] && !args[i + 1].startsWith("--")) {
        agentName = args[++i];
      } else {
        mode = "--agent";
      }
    } else if (args[i] === "--ai") {
      mode = "--ai";
    } else {
      filtered.push(args[i]);
    }
  }

  let did = filtered[0] || "";

  if (!did) {
    const outputsDir = path.join(wdir, "outputs");
    try {
      const files = (await readdir(outputsDir))
        .filter((f) => f.startsWith("deliverable-") && f.endsWith(".md"))
        .sort();
      if (files.length === 0) {
        console.error(`${RED}No deliverables found for ${project}${NC}`);
        process.exit(1);
      }
      did = files[files.length - 1].replace(/^deliverable-/, "").replace(/\.md$/, "");
    } catch {
      console.error(`${RED}No deliverables found for ${project}${NC}`);
      process.exit(1);
    }
  } else {
    did = did.replace(/^deliverable-/, "");
  }

  // Agent/AI mode: enqueue review through hub queue
  if (mode === "--agent" || mode === "--ai") {
    const hubRoot = process.env.CPB_HUB_ROOT || path.join(process.env.HOME || ".", ".cpb");
    const { enqueue } = await import(path.join(executorRoot, "server", "services", "hub", "hub-queue.js"));

    const entry = await enqueue(hubRoot, {
      projectId: project,
      priority: "P1",
      description: `Review deliverable-${did}`,
      type: "cli_review",
      metadata: {
        source: "cli",
        deliverableId: did,
        reviewAgent: agentName || undefined,
        actor: "cli",
        requestedAt: new Date().toISOString(),
      },
    });

    console.log(`Enqueued review ${entry.id} for deliverable-${did} (project=${project})`);
    return 0;
  }

  // Interactive review (read-only)
  const deliverable = path.join(wdir, "outputs", `deliverable-${did}.md`);
  const verdict = path.join(wdir, "outputs", `verdict-${did}.md`);

  try {
    await access(deliverable, constants.F_OK);
  } catch {
    console.error(`${RED}File not found: ${deliverable}${NC}`);
    process.exit(1);
  }

  console.log(`${BOLD}Review: ${project} / deliverable-${did}${NC}`);
  console.log("");

  try {
    const vContent = await readFile(verdict, "utf8");
    const vMatch = vContent.match(/^VERDICT:\s*(\w+)/m);
    const vStatus = vMatch?.[1] || "unknown";
    let vColor = YELLOW;
    if (vStatus === "PASS") vColor = GREEN;
    if (vStatus === "FAIL") vColor = RED;
    console.log(`Verdict: ${vColor}${vStatus}${NC}`);
    console.log("");
    console.log(`${CYAN}Evidence (first 10 lines):${NC}`);
    const lines = vContent.split("\n").filter((l) => !l.startsWith("VERDICT:"));
    console.log(lines.slice(0, 10).join("\n"));
    console.log("");
  } catch {
    console.log(`${YELLOW}No verdict yet.${NC}`);
    console.log("");
  }

  console.log(`${CYAN}Deliverable summary:${NC}`);
  const dContent = await readFile(deliverable, "utf8");
  console.log(dContent.split("\n").slice(0, 20).join("\n"));
  console.log("");

  const { getProject, resolveHubRoot } = await import("../../server/services/hub/hub-registry.js");
  const hubRoot = resolveHubRoot(cpbRoot);
  const registered = await getProject(hubRoot, project);
  const src = registered?.sourcePath;
  if (src) {
    try {
      const { spawn } = await import("node:child_process");
      const gitStat = spawn("git", ["-C", src, "diff", "--stat"], { stdio: "pipe" });
      let statOut = "";
      gitStat.stdout.on("data", (d) => { statOut += d; });
      await new Promise((resolve) => gitStat.on("close", resolve));
      if (statOut.trim()) {
        console.log(`${CYAN}Changes:${NC}`);
        console.log(statOut.trim());
        console.log("");
        console.log(`${CYAN}Diff (first 80 lines):${NC}`);
        const gitDiff = spawn("git", ["-C", src, "diff"], { stdio: "pipe" });
        let diffOut = "";
        gitDiff.stdout.on("data", (d) => { diffOut += d; });
        await new Promise((resolve) => gitDiff.on("close", resolve));
        console.log(diffOut.split("\n").slice(0, 80).join("\n"));
      } else {
        console.log(`${YELLOW}No uncommitted changes.${NC}`);
      }
    } catch {}
  }

  console.log("");
  console.log(`${BOLD}Actions:${NC}`);
  console.log("  a/accept   — keep changes");
  console.log("  r/reject   — reject review without modifying the working tree");
  console.log("  q/quit     — exit");
  console.log("");

  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const choice = await new Promise((resolve) => {
    rl.question("Choice [a/r/q]: ", (answer) => resolve(answer.trim()));
  });
  rl.close();

  if (choice === "a" || choice === "accept") {
    console.log(`${GREEN}Changes accepted.${NC}`);
  } else if (choice === "r" || choice === "reject") {
    if (src) {
      console.log(`${YELLOW}Review rejected; no files were modified.${NC}`);
      console.log(`Inspect ${src} and revert only the reviewed files after preserving unrelated work.`);
    } else {
      console.log(`${YELLOW}Review rejected; no files were modified.${NC}`);
    }
  } else {
    console.log("No action taken.");
  }
}
