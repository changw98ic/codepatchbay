import { createHash } from "node:crypto";
import os from "node:os";

export type ReleaseRedactorContext = Readonly<{
  sourceRoot?: string;
  runtimeRoot?: string;
}>;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+\S+/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b[A-Za-z0-9+/_=-]{40,}\b/g,
];

const ABSOLUTE_PATH_PATTERN = /\/(?:[A-Za-z0-9._@-]+\/)+[A-Za-z0-9._@-]+/g;
const MAX_REDACTED_STRING_LENGTH = 16_384;

function sha256Short(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function sanitizeReleaseGateText(value: string, ctx: ReleaseRedactorContext = {}): string {
  let out = value;
  const prefixes = [ctx.sourceRoot, ctx.runtimeRoot].filter((p): p is string => Boolean(p));
  prefixes.sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (prefix && out.includes(prefix)) {
      out = out.split(prefix).join(`<root:${sha256Short(prefix)}>`);
    }
  }
  const tmp = os.tmpdir();
  if (tmp && out.includes(tmp)) {
    out = out.split(tmp).join("<tmp>");
  }
  const home = os.homedir();
  if (home && out.includes(home)) {
    out = out.split(home).join("<home>");
  }
  out = out.replace(ABSOLUTE_PATH_PATTERN, (match) => `<path:${sha256Short(match)}>`);
  for (const pattern of SECRET_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, () => "[REDACTED:sha256:12]");
  }
  return out.length <= MAX_REDACTED_STRING_LENGTH
    ? out
    : `${out.slice(0, MAX_REDACTED_STRING_LENGTH)}…[truncated]`;
}

export function sanitizeReleaseGateBuffer(buffer: Buffer, ctx: ReleaseRedactorContext = {}): Buffer {
  return Buffer.from(sanitizeReleaseGateText(buffer.toString("utf8"), ctx), "utf8");
}
