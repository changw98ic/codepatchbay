import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";

const dir = "dist-tests/tests";
const files = (await readdir(dir)).filter((f) => f.endsWith(".test.js"));
const env = { ...process.env, CPB_WORKER_DISPATCH_ENABLED: "0", CPB_CHECKLIST_DECOMPOSE: "0" };
const results = [];

for (const f of files) {
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", `${dir}/${f}`], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve({ file: f, ms: -1, exit: "TIMEOUT" });
    }, 30000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const m = out.match(/duration_ms\s+([\d.]+)/);
      const ms = m ? Number(m[1]) : (code === 0 ? 0 : -2);
      resolve({ file: f, ms, exit: code });
    });
  });
  results.push(r);
  const tag = r.ms >= 0 ? r.ms.toFixed(0).padStart(7) : (r.exit === "TIMEOUT" ? "  T/O30" : "   ERR");
  console.log(`${tag}  exit=${String(r.exit).padEnd(4)}  ${r.file}`);
}

console.log("\n=== TOP 30 SLOWEST ===");
const sortable = results.filter((r) => r.ms >= 0).sort((a, b) => b.ms - a.ms);
for (const r of sortable.slice(0, 30)) console.log(`${r.ms.toFixed(0).padStart(7)} ms  ${r.file}`);
console.log(`\nTOTAL files=${results.length}  >1s=${results.filter((r) => r.ms > 1000).length}  >5s=${results.filter((r) => r.ms > 5000).length}  timeouts=${results.filter((r) => r.exit === "TIMEOUT").length}  errors=${results.filter((r) => r.ms === -2).length}`);
