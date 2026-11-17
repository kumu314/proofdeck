// Demo: a "fake done" gets caught by the real verification engine.
// This is NOT a mock — it calls lib/verify.js evaluateAcceptance with the same
// fail-closed check types the daemon runs before accepting a done claim.
//
// Output is a plain-text terminal transcript (no ANSI), so render-demo.mjs can
// turn an actual run into the demo GIF honestly.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const { evaluateAcceptance } = await import(pathToFileURL(join(root, "..", "lib", "verify.js")).href);

const work = mkdtempSync(join(tmpdir(), "proofdeck-demo-"));
const line = (s) => console.log(s);

try {
  // The agent "finished" the task and wrote its report — but only 1 item, not 3.
  mkdirSync(join(work, "out"), { recursive: true });
  writeFileSync(join(work, "out", "report.json"), JSON.stringify({ count: 1, note: "everything done!" }));

  line("$ proofdeck task claim fix-pagination   # agent starts working");
  line("$ ... agent edits files, runs tests, writes out/report.json");
  line("$ proofdeck task done fix-pagination     # agent claims DONE");
  line("");

  const acceptance = {
    baseDir: work,
    checks: [
      { type: "countAtLeast", path: "out/report.json", jsonPath: "count", min: 3 },
      { type: "fileExists", path: "out/notes.md" },
    ],
  };

  line("  acceptance gate — fail-closed:");
  for (const c of acceptance.checks) line(`    · ${c.type}  ${c.path}${c.jsonPath ? " ." + c.jsonPath : ""}${c.min != null ? " >= " + c.min : ""}`);
  line("");
  line("  verify V1 running...");

  const v = evaluateAcceptance({ acceptance });
  for (const r of v.checks) {
    line(`    ${r.pass ? "PASS" : "FAIL"}  ${r.type}  ${r.target ?? ""}  ${r.evidence ?? ""}`);
  }
  line("");

  if (!v.pass) {
    line("  done REJECTED — no evidence, no completion.");
    line("  => task returns to open for redispatch (retry/breaker applies).");
    line("  => a verify event is appended to the sha256 hash chain.");
    line("  => upstream UI shows: \"agent said done; ProofDeck demanded proof.\"");
    line("");
    line(`  demo workspace: ${work}`);
  } else {
    line("  PASS — done accepted (this demo expects FAIL; something changed!)");
  }
} finally {
  // Keep the demo output stable; workspace is a throwaway — delete it.
  try { rmSync(work, { recursive: true, force: true }); } catch { }
}
