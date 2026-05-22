import { readFile, stat } from "node:fs/promises";

export async function validateNonEmptyMarkdownArtifact({ path: filePath, kind, id }) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      return { valid: false, reason: "not_a_file", kind, id, path: filePath };
    }
    if (info.size === 0) {
      return { valid: false, reason: "empty_file", kind, id, path: filePath };
    }
    const content = await readFile(filePath, "utf8");
    if (content.trim().length === 0) {
      return { valid: false, reason: "whitespace_only", kind, id, path: filePath };
    }
    return { valid: true, kind, id, path: filePath, content };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { valid: false, reason: "missing", kind, id, path: filePath };
    }
    return { valid: false, reason: `read_error: ${err.message}`, kind, id, path: filePath };
  }
}

const GITHUB_ISSUE_RE = /(?:issue\s*#?(\d+)|(?:github\.com\/[^/\s]+\/[^/\s]+\/issues\/|#)(\d+))/gi;

export function extractGithubIssueRefs(text) {
  if (!text || typeof text !== "string") return [];
  const refs = [];
  let match;
  while ((match = GITHUB_ISSUE_RE.exec(text)) !== null) {
    const num = match[1] || match[2];
    if (num) refs.push(parseInt(num, 10));
  }
  return [...new Set(refs)];
}

export function resolveDeliverableIssue(content) {
  if (!content || typeof content !== "string") return null;

  const lines = content.split(/\r?\n/).slice(0, 40);

  for (const line of lines) {
    const taskRefMatch = line.match(/Task-Ref[^:]*:\s*(?:plan-\S+\s*[/,]\s*)?GitHub\s+issue\s*#?(\d+)/i);
    if (taskRefMatch) return parseInt(taskRefMatch[1], 10);
  }

  for (const line of lines) {
    const headingMatch = line.match(/#{1,3}\s+Plan:?\s*GitHub\s+issue\s*#?(\d+)/i);
    if (headingMatch) return parseInt(headingMatch[1], 10);
  }

  for (const line of lines) {
    const urlMatch = line.match(/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)/);
    if (urlMatch) return parseInt(urlMatch[1], 10);
  }

  const first30 = lines.slice(0, 30).join("\n");
  const refs = extractGithubIssueRefs(first30);
  return refs.length > 0 ? refs[0] : null;
}

export function validateIssueMatch({ expectedIssueNumber, artifactIssueNumber, artifactPath }) {
  if (expectedIssueNumber == null || artifactIssueNumber == null) {
    return { match: true, expected: expectedIssueNumber, actual: artifactIssueNumber, path: artifactPath };
  }
  if (expectedIssueNumber === artifactIssueNumber) {
    return { match: true, expected: expectedIssueNumber, actual: artifactIssueNumber, path: artifactPath };
  }
  return {
    match: false,
    expected: expectedIssueNumber,
    actual: artifactIssueNumber,
    path: artifactPath,
    reason: `issue_mismatch: expected #${expectedIssueNumber}, got #${artifactIssueNumber}`,
  };
}
