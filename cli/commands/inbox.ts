// @ts-nocheck
import path from "node:path";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const NC = "\x1b[0m";

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (const arg of args) {
    if (arg.startsWith("--")) {
      if (arg.includes("=")) {
        const [key, ...rest] = arg.slice(2).split("=");
        flags[key] = rest.join("=");
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

export async function run(args, { cpbRoot }) {
  const { positional, flags } = parseArgs(args);
  const project = positional[0];
  if (!project) {
    console.error("Usage: cpb inbox <project> [read|ack|done <id>] [--json] [--owner <role>]");
    process.exit(1);
  }

  const subcommand = positional[1] || null;
  const targetId = positional[2] || null;

  if (!subcommand) {
    return listMessages(cpbRoot, project, flags);
  }

  switch (subcommand) {
    case "read":
      return readMessage(cpbRoot, project, targetId);
    case "ack":
      return ackMessage(cpbRoot, project, targetId, flags);
    case "done":
      return doneMessage(cpbRoot, project, targetId);
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.error("Usage: cpb inbox <project> [read|ack|done <id>] [--json] [--owner <role>]");
      process.exit(1);
  }
}

async function listMessages(cpbRoot, project, flags) {
  const { listInboxMessages } = await import("../../server/services/inbox-mail.js");

  const messages = await listInboxMessages(cpbRoot, project);

  if (flags.json) {
    console.log(JSON.stringify(messages, null, 2));
    return;
  }

  console.log(`${BOLD}Inbox: ${project}${NC}`);

  if (messages.length === 0) {
    console.log("  (empty)");
    return;
  }

  for (const msg of messages) {
    const statusColor = msg.status === "completed" ? GREEN : msg.status === "acknowledged" ? YELLOW : "";
    const statusLabel = statusColor ? `${statusColor}[${msg.status}]${NC}` : `[${msg.status}]`;
    const typeLabel = `${DIM}${msg.type}${NC}`;
    const dirLabel = msg.from && msg.to ? `${DIM}${msg.from} -> ${msg.to}${NC}` : "";
    console.log(`  ${msg.id.padEnd(22)} ${statusLabel} ${typeLabel} ${dirLabel}`);
  }
}

async function readMessage(cpbRoot, project, id) {
  if (!id) {
    console.error("Usage: cpb inbox <project> read <id>");
    process.exit(1);
  }

  const { readInboxMessage } = await import("../../server/services/inbox-mail.js");
  const msg = await readInboxMessage(cpbRoot, project, id);

  if (!msg) {
    console.error(`Message not found: ${id}`);
    process.exit(1);
  }

  console.log(`${BOLD}Message: ${msg.id}${NC}`);
  console.log(`  Type:    ${msg.type}`);
  console.log(`  Status:  ${msg.status}`);
  console.log(`  From:    ${msg.from || "(none)"}`);
  console.log(`  To:      ${msg.to || "(none)"}`);
  console.log(`  Owner:   ${msg.owner || "(none)"}`);
  console.log(`  Job:     ${msg.jobId || "(none)"}`);
  console.log(`  Phase:   ${msg.phase || "(none)"}`);
  console.log(`  Created: ${msg.createdAt}`);
  console.log(`  Updated: ${msg.updatedAt}`);
  if (msg.content) {
    console.log();
    console.log(msg.content);
  }
}

async function ackMessage(cpbRoot, project, id, flags) {
  if (!id) {
    console.error("Usage: cpb inbox <project> ack <id> --owner <role>");
    process.exit(1);
  }

  const owner = flags.owner || "";
  if (!owner) {
    console.error("Error: --owner <role> is required for ack");
    process.exit(1);
  }

  const { ackInboxMessage } = await import("../../server/services/inbox-mail.js");

  try {
    const result = await ackInboxMessage(cpbRoot, project, id, { owner });
    if (!result) {
      console.error(`Message not found: ${id}`);
      process.exit(1);
    }
    console.log(`${GREEN}Acknowledged${NC} ${id} (owner: ${owner})`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

async function doneMessage(cpbRoot, project, id) {
  if (!id) {
    console.error("Usage: cpb inbox <project> done <id>");
    process.exit(1);
  }

  const { completeInboxMessage } = await import("../../server/services/inbox-mail.js");

  try {
    const result = await completeInboxMessage(cpbRoot, project, id);
    if (!result) {
      console.error(`Message not found: ${id}`);
      process.exit(1);
    }
    console.log(`${GREEN}Completed${NC} ${id}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
