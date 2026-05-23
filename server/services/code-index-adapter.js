/**
 * Code index adapter boundary.
 *
 * Provides a unified interface for reading task-relevant code index summaries,
 * with support for external provider commands via CPB_CODE_INDEX_COMMAND
 * and built-in fallback via readFilteredCodeIndexSummary.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFilteredCodeIndexSummary } from "./project-code-index.js";

const execFileAsync = promisify(execFile);

/**
 * Read a task-relevant code index summary.
 *
 * Provider order:
 * 1. If CPB_CODE_INDEX_COMMAND is set, call the external command
 * 2. Otherwise, use built-in readFilteredCodeIndexSummary
 * 3. If index is unavailable, return empty summary with diagnostic message
 *
 * @param {{ id: string, sourcePath?: string }} projectRecord
 * @param {{ hubRoot?: string, taskDescription?: string, maxBytes?: number }} options
 * @returns {Promise<string>}
 */
export async function readTaskRelevantIndex(
  projectRecord,
  { hubRoot, taskDescription = "", maxBytes = 4096 } = {},
) {
  const externalCommand = process.env.CPB_CODE_INDEX_COMMAND;

  if (externalCommand) {
    return callExternalProvider(externalCommand, projectRecord, {
      taskDescription,
      maxBytes,
    });
  }

  return callBuiltIn(projectRecord, { hubRoot, taskDescription, maxBytes });
}

/**
 * Call the built-in index reader.
 */
async function callBuiltIn(projectRecord, { hubRoot, taskDescription, maxBytes }) {
  try {
    const summary = await readFilteredCodeIndexSummary(projectRecord, {
      hubRoot,
      taskDescription,
      maxBytes,
    });
    if (summary) return summary;
    return buildUnavailableMessage(projectRecord.id);
  } catch {
    return buildUnavailableMessage(projectRecord.id);
  }
}

/**
 * Call an external provider command.
 *
 * Expected CLI interface: <command> --project <path> --task <desc> --max-bytes <n>
 * Must output JSON to stdout with a `summary` field.
 */
async function callExternalProvider(command, projectRecord, { taskDescription, maxBytes }) {
  const projectPath = projectRecord.sourcePath || projectRecord.id;
  const args = [
    "--project", projectPath,
    "--task", taskDescription,
    "--max-bytes", String(maxBytes),
  ];

  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });

    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed.summary === "string") {
      return parsed.summary;
    }
    return buildUnavailableMessage(projectRecord.id);
  } catch {
    return buildUnavailableMessage(projectRecord.id);
  }
}

/**
 * Build an empty summary with a diagnostic message.
 */
function buildUnavailableMessage(projectId) {
  return `[code-index: unavailable for project ${projectId}]`;
}
