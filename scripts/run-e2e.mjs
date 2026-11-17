// Cross-platform e2e suite runner (CI + local).
// Usage: node scripts/run-e2e.mjs [pattern]
// Runs every e2e/verify-*.mjs against a temp board; exits non-zero on any failure.
// Backend lever: OCTOBOARD_BACKEND=better-sqlite3 exercises the legacy backend.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pattern = process.argv[2] ?? "";
const tests = readdirSync(join(root, "e2e"))
  .filter((f) => f.startsWith("verify-") && f.endsWith(".mjs"))
  .filter((f) => f.includes(pattern));

console.log(`proofdeck e2e — ${tests.length} suites, backend=${process.env.OCTOBOARD_BACKEND || "native(node:sqlite)"}, node=${process.version}, platform=${process.platform}`);
let green = 0;
const red = [];
for (const t of tests) {
  const r = spawnSync(process.execPath, [join(root, "e2e", t)], {
    encoding: "utf8",
    timeout: 240000,
    cwd: root,
    env: { ...process.env },
  });
  const out = (r.stdout || "") + (r.stderr || "");
  // only lines that START with FAIL are failures — PASS detail text may contain the word
  const realFails = out.split(/\r?\n/).filter((l) => l.startsWith("FAIL ")).length;
  const ok = r.status === 0 && realFails === 0;
  const last = out.trim().split(/\r?\n/).filter(Boolean).pop() ?? "(no output)";
  if (ok) green++;
  else red.push(t);
  console.log(`${ok ? "GREEN" : "RED  "} ${t} rc=${r.status} fails=${realFails} :: ${last.slice(0, 90)}`);
  if (!ok && out) {
    for (const l of out.split(/\r?\n/).filter((l) => l.startsWith("FAIL "))) console.log("      " + l.trim().slice(0, 140));
  }
}
console.log(`\n=== ${green}/${tests.length} GREEN ===`);
process.exit(red.length ? 1 : 0);
