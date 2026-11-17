// e2e: 防刷分检查（2026-10-07）—— countMatches / referencesExist 两类组合一致性检查。
// SpecBench 教训：声明式检查可被针对性刷穿；组合检查迫使刷单必须整条链一起伪造。
// 纯检查测试 + 一次 board 集成，不碰现网。
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const V = await import(new URL("../lib/verify.js", import.meta.url).href);

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
};

const dir = mkdtempSync(join(tmpdir(), "bridge-antifraud-"));
const root = join(dir, "work");
mkdirSync(join(root, "out"), { recursive: true });
mkdirSync(join(root, "assets"), { recursive: true });

// 工件：产物 + 台账 + 引用资源
writeFileSync(join(root, "out", "ledger.json"), JSON.stringify({ items: [{ id: 1 }, { id: 2 }, { id: 3 }], rendered: 3 }));
writeFileSync(join(root, "out", "manifest.json"), JSON.stringify({ count: 3 }));
writeFileSync(join(root, "out", "refs.json"), JSON.stringify({ files: ["assets/a.png", "assets/b.png"] }));
writeFileSync(join(root, "out", "badrefs.json"), JSON.stringify({ files: ["assets/a.png", "assets/ghost.png"] }));
writeFileSync(join(root, "out", "norefs.json"), JSON.stringify({ files: [] }));
writeFileSync(join(root, "assets", "a.png"), "fake-image-a");
writeFileSync(join(root, "assets", "b.png"), "fake-image-b");

try {
  // ---- countMatches ----
  {
    const r = V.evaluateAcceptance({ acceptance: { baseDir: root, checks: [
      { type: "countMatches", path: "out/ledger.json", jsonPath: "$.items", withPath: "out/manifest.json", withJsonPath: "$.count", min: 3 },
    ] } });
    ok("M1a 数量一致且达标 → PASS", r?.pass === true, JSON.stringify(r?.checks?.[0]));
  }
  {
    const r = V.evaluateAcceptance({ acceptance: { baseDir: root, checks: [
      { type: "countMatches", path: "out/ledger.json", jsonPath: "$.items", withPath: "out/manifest.json", withJsonPath: "$.count" },
    ] } });
    ok("M1b 一致但缺 min（默认1）此处 3≥1 → PASS", r?.pass === true);
  }
  {
    const r = V.evaluateAcceptance({ acceptance: { baseDir: root, checks: [
      { type: "countMatches", path: "out/ledger.json", jsonPath: "$.items", withPath: "out/ledger.json", withJsonPath: "$.rendered", min: 3 },
    ] } });
    // items=3 vs rendered=3 → 相等 → pass（同文件自比也合法）
    ok("M1c 同文件两路径相等 → PASS", r?.pass === true);
  }
  {
    // 刷分模拟：产物说 3，台账只给了 2 —— 不一致必须 FAIL
    writeFileSync(join(root, "out", "liar.json"), JSON.stringify({ count: 2 }));
    const r = V.evaluateAcceptance({ acceptance: { baseDir: root, checks: [
      { type: "countMatches", path: "out/ledger.json", jsonPath: "$.items", withPath: "out/liar.json", withJsonPath: "$.count", min: 3 },
    ] } });
    ok("M2a 数量不一致 → FAIL（work 类）", r?.pass === false && r.checks[0].invalid !== true, r?.checks?.[0]?.evidence);
  }
  {
    const r = V.evaluateAcceptance({ acceptance: { baseDir: root, checks: [
      { type: "countMatches", path: "out/ledger.json", jsonPath: "$.nonexistent", withPath: "out/manifest.json", withJsonPath: "$.count" },
    ] } });
    ok("M2b 路径未命中 → FAIL（work 类，取值不可计数）", r?.pass === false && r.checks[0].invalid !== true);
  }
  {
    const r = V.evaluateAcceptance({ acceptance: { baseDir: root, checks: [
      { type: "countMatches", path: "out/ledger.json", withPath: "out/manifest.json" },
    ] } });
    ok("M3a 缺 jsonPath → spec 类 invalid", r?.pass === false && r.checks[0].invalid === true);
  }
  {
    // 相等但为 0：没有 min 时默认 1，防"两边都是空的也算过"
    writeFileSync(join(root, "out", "zero.json"), JSON.stringify({ a: 0 }));
    const r = V.evaluateAcceptance({ acceptance: { baseDir: root, checks: [
      { type: "countMatches", path: "out/zero.json", jsonPath: "$.a", withPath: "out/zero.json", withJsonPath: "$.a" },
    ] } });
    ok("M3b 相等但为 0 → FAIL（默认 min 1）", r?.pass === false, r?.checks?.[0]?.evidence);
  }

  // ---- referencesExist ----
  {
    const r = V.evaluateAcceptance({ acceptance: { baseDir: root, checks: [
      { type: "referencesExist", path: "out/refs.json", jsonPath: "$.files" },
    ] } });
    ok("R1a 引用全部存在 → PASS", r?.pass === true, JSON.stringify(r?.checks?.[0]?.evidence));
  }
  {
    const r = V.evaluateAcceptance({ acceptance: { baseDir: root, checks: [
      { type: "referencesExist", path: "out/badrefs.json", jsonPath: "$.files" },
    ] } });
    ok("R2a 幽灵引用 → FAIL（work 类，证据点名缺失项）", r?.pass === false && String(r.checks[0].evidence).includes("ghost.png"), r?.checks?.[0]?.evidence);
  }
  {
    const r = V.evaluateAcceptance({ acceptance: { baseDir: root, checks: [
      { type: "referencesExist", path: "out/norefs.json", jsonPath: "$.files" },
    ] } });
    ok("R2b 引用列表为空 → FAIL（fail-closed）", r?.pass === false && r.checks[0].invalid !== true);
  }
  {
    const r = V.evaluateAcceptance({ acceptance: { baseDir: root, checks: [
      { type: "referencesExist", path: "out/refs.json", jsonPath: "$.files", baseDir: root },
    ] } });
    ok("R3a 显式 baseDir 相对解析 → PASS", r?.pass === true);
  }
  {
    const r = V.evaluateAcceptance({ acceptance: { baseDir: root, checks: [
      { type: "referencesExist", path: "out/refs.json" },
    ] } });
    ok("R3b 缺 jsonPath → spec 类 invalid", r?.pass === false && r.checks[0].invalid === true);
  }

  // ---- 混合：防刷分检查与三类既有检查同场 ----
  {
    const r = V.evaluateAcceptance({ acceptance: { baseDir: root, checks: [
      { type: "fileExists", path: "out/ledger.json" },
      { type: "countAtLeast", path: "out/ledger.json", jsonPath: "$.items", min: 3 },
      { type: "countMatches", path: "out/ledger.json", jsonPath: "$.items", withPath: "out/manifest.json", withJsonPath: "$.count" },
      { type: "referencesExist", path: "out/refs.json", jsonPath: "$.files" },
    ] } });
    ok("X1 四类检查同场全过 → aggregate PASS", r?.pass === true && r.checks.length === 4);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { }
}
