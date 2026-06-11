import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

const DIAGNOSTICS_ROOT = path.join(os.homedir(), ".cpb", "browser-agents")

export async function saveDiagnostic({ provider, phase, project, jobId, error, page, tracePath }) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  const dir = path.join(DIAGNOSTICS_ROOT, provider, "diagnostics", ts)
  await mkdir(dir, { recursive: true })

  const diag = {
    provider,
    phase,
    project,
    jobId,
    error: error?.message || String(error),
    code: error?.code || null,
    selector: error?.selector || null,
    tracePath: tracePath || null,
    timestamp: new Date().toISOString(),
  }

  await writeFile(path.join(dir, "failure.json"), JSON.stringify(diag, null, 2), "utf8")

  if (page) {
    try {
      await page.screenshot({ path: path.join(dir, "screenshot.png"), fullPage: true })
    } catch {}
  }

  return dir
}
