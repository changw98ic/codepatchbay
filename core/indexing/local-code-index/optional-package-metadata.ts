import { createRequire } from "node:module";

const requirePackage = createRequire(import.meta.url);

/** Return an installed optional package version, or null when it is absent. */
export function readOptionalPackageVersion(packageName: string): string | null {
  try {
    const value = (requirePackage(`${packageName}/package.json`) as { version?: unknown }).version;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
