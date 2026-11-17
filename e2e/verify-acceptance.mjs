// e2e: acceptance verification V1 (验证层 Part B) — pure checks + full fail-path
// integration against a TEST board and a temp store. Never touches the real board.
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const V = await import(new URL("../lib/verify.js", import.meta.url).href);
const { Store } = await import(new URL("../lib/store.js", import.meta.url).href);
const boardCh = await import(new URL("../lib/board.js", import.meta.url).href);

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
};

const dir = mkdtempSync(join(tmpdir(), "bridge-verify-"));
const boardDir = join(dir, "board");
const storeDir = mkdtempSync(join(tmpdir(), "bridge-vstore-"));
const store = new Store(join(storeDir, "state.json"));
await boardCh.init(fileURLToPath(new URL("../board", import.meta.url)));
const cfg = { dir: boardDir, identity: "bridge" };

// ---------- P1: parseBridgeBlock ----------
{
  const d1 = '正文\n```bridge\n{ "priority": "P1", "retry": {"max": 1}, "acceptance": { "checks": [] } }\n```\n尾部';
  const b1 = V.parseBridgeBlock(d1);
  ok("P1a valid block parsed", b1?.priority === "P1" && b1?.retry?.max === 1);
  ok("P1b no block → null", V.parseBridgeBlock("没有围栏") === null && V.parseBridgeBlock(null) === null);
  ok("P1c malformed JSON → null", V.parseBridgeBlock("```bridge\n{oops}\n```") === null);
  ok("P1d array payload → null", V.parseBridgeBlock("```bridge\n[1,2]\n```") === null);
}

// ---------- P2: evaluateAcceptance ----------
{
  const root = join(dir, "work");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "out.md"), "## 第1首\n内容\n## 第2首\n内容\n");
  writeFileSync(join(root, "ledger.json"), JSON.stringify({ items: [{ a: 1 }, { a: 2 }, { a: 3 }], total: 7 }));
  writeFileSync(join(root, "empty.txt"), "");

  ok("P2a null acceptance → null", V.evaluateAcceptance({ acceptance: null }) === null);
  ok("P2b empty checks → null", V.evaluateAcceptance({ acceptance: { checks: [] } }) === null);
  ok("P2c mode human → null (V3 待建)", V.evaluateAcceptance({ acceptance: { mode: "human", checks: [{ type: "fileExists", path: "out.md" }] } }) === null);

  const allPass = V.evaluateAcceptance({
    acceptance: { baseDir: root, checks: [
      { type: "fileExists", path: "out.md" },
      { type: "countAtLeast", path: "ledger.json", jsonPath: "$.items", min: 3 },
      { type: "countAtLeast", path: "ledger.json", jsonPath: "$.total", min: 7 },
      { type: "countOccurrences", path: "out.md", text: "## 第", minCount: 2 },
    ] },
  });
  ok("P2d all-pass aggregate", allPass?.pass === true && allPass.checks.length === 4, JSON.stringify(allPass?.checks?.map(c => c.pass)));

  const short = V.evaluateAcceptance({
    acceptance: { baseDir: root, checks: [
      { type: "countAtLeast", path: "ledger.json", jsonPath: "$.items", min: 20 },
      { type: "fileExists", path: "missing.md" },
      { type: "countOccurrences", path: "out.md", text: "## 第", minCount: 9 },
    ] },
  });
  ok("P2e work-level fails detected", short?.pass === false && short.checks.filter((c) => !c.pass).length === 3 && short.checks.every((c) => c.invalid !== true),
    JSON.stringify(short.checks.filter(c => !c.pass).map(c => c.evidence)));

  const invalid = V.evaluateAcceptance({
    acceptance: { baseDir: root, checks: [
      { type: "fileExsits", path: "out.md" },
      { type: "countOccurrences", path: "out.md" },
      { type: "countAtLeast", path: "ledger.json", jsonPath: "$.nope.deep", min: 1 },
    ] },
  });
  ok("P2f spec errors flagged invalid, path-miss is work-level",
    invalid?.pass === false && invalid.checks[0].invalid === true && invalid.checks[1].invalid === true && invalid.checks[2].invalid !== true,
    JSON.stringify(invalid.checks.map(c => ({ p: c.pass, inv: !!c.invalid }))));

  ok("P2g empty file fails fileExists (minBytes default 1)",
    V.evaluateAcceptance({ acceptance: { baseDir: root, checks: [{ type: "fileExists", path: "empty.txt" }] } }).pass === false);
  ok("P2h absolute path works", V.evaluateAcceptance({ acceptance: { checks: [{ type: "fileExists", path: join(root, "out.md").replaceAll("\\", "/") }] } }).pass === true);
}

// ---------- P3: full fail-path integration on a TEST board ----------
{
  await boardCh.withBoard(cfg, (b) => {
    b.defineTask("zcode", "e2e-verify-1", { title: "verify e2e", description: "测试任务" });
  });

  const v = { pass: false, checks: [
    { type: "countAtLeast", target: "out.md $.items", pass: false, evidence: "got 12 < 20" },
    { type: "fileExists", target: "missing.md", pass: false, evidence: "不存在" },
  ] };

  // 第一次：未用尽 → retry-scheduled + 回 open + note/message
  let res;
  await boardCh.withBoard(cfg, (b) => {
    res = V.applyVerifyFail({ b, io: boardCh, store, ID: "bridge", owner: "kemu", key: "e2e-verify-1", agent: "trae", task: { createdBy: "zcode" }, v, maxAttempts: 2, baseMs: 60000, maxDelayMs: 240000, holdBase: 300000, holdMax: 7200000, now: Date.now() });
  });
  ok("P3a first verify-fail schedules retry", res.outcome === "retry-scheduled" && res.attempts === 1, JSON.stringify(res));
  ok("P3b retries ledger written", store.s.retries["e2e-verify-1"]?.n === 1 && store.s.retries["e2e-verify-1"]?.why === "verify-fail");
  await boardCh.withBoard(cfg, (b) => {
    const t = b.getTask("e2e-verify-1");
    ok("P3c task back to open", t?.status === "open", t?.status);
    const evs = b.timeline(200);
    const note = evs.filter((e) => e.kind === "note" && String(e.summary).includes("[[verify]]")).pop();
    ok("P3d structured verify FAIL note on chain", !!note && String(note.summary).includes("verdict=FAIL") && String(note.summary).includes("checks=0/2"), String(note?.summary).slice(0, 80));
    const msgs = b.inbox("zcode", true);
    ok("P3e creator notified", msgs.some((m) => (m.body ?? "").includes("未通过验收") || JSON.stringify(m).includes("未通过验收")));
  });

  // 第二、三次：attempts 递增到用尽 → blocked + verification 熔断
  await boardCh.withBoard(cfg, (b) => {
    res = V.applyVerifyFail({ b, io: boardCh, store, ID: "bridge", owner: "kemu", key: "e2e-verify-1", agent: "trae", task: { createdBy: "zcode" }, v, maxAttempts: 2, baseMs: 60000, maxDelayMs: 240000, holdBase: 300000, holdMax: 7200000, now: Date.now() });
  });
  ok("P3f-pre second retry scheduled (max=2 → 还允许最后一试)", res.outcome === "retry-scheduled" && res.attempts === 2, JSON.stringify(res));
  await boardCh.withBoard(cfg, (b) => {
    res = V.applyVerifyFail({ b, io: boardCh, store, ID: "bridge", owner: "kemu", key: "e2e-verify-1", agent: "trae", task: { createdBy: "zcode" }, v, maxAttempts: 2, baseMs: 60000, maxDelayMs: 240000, holdBase: 300000, holdMax: 7200000, now: Date.now() });
  });
  ok("P3f exhaustion → blocked + face latched", res.outcome === "exhausted" && res.streak === 1, JSON.stringify(res));
  ok("P3g verification latch recorded", store.supplyGet("trae")?.category === "verification");
  ok("P3h retries ledger cleared", store.s.retries["e2e-verify-1"] === undefined);
  await boardCh.withBoard(cfg, (b) => {
    ok("P3i task blocked", b.getTask("e2e-verify-1")?.status === "blocked");
    ok("P3j chain intact", b.verifyChain().brokenAtSeq === null);
  });

  // PASS 路径
  const vp = { pass: true, checks: [{ type: "fileExists", target: "out.md", pass: true, evidence: "12B" }] };
  await boardCh.withBoard(cfg, (b) => V.applyVerifyPass({ b, io: boardCh, ID: "bridge", key: "e2e-verify-1", v: vp }));
  await boardCh.withBoard(cfg, (b) => {
    const evs = b.timeline(300);
    const note = evs.filter((e) => e.kind === "note" && String(e.summary).includes("[[verify]]")).pop();
    ok("P3k structured PASS note", !!note && String(note.summary).includes("verdict=PASS") && String(note.summary).includes("checks=1/1"));
    ok("P3l chain still intact", b.verifyChain().brokenAtSeq === null);
  });
}

// ---------- P4: formatVerifyNote ----------
{
  const n = V.formatVerifyNote({ key: "k1", verdict: "FAIL", checks: [
    { type: "fileExists", target: "a.md", pass: false, evidence: "不存在" },
    { type: "fileExists", target: "b.md", pass: true, evidence: "1B" },
  ], by: "bridge" });
  ok("P4a note format stable", n.startsWith("[[verify]] key=k1 verdict=FAIL level=V1 by=bridge checks=1/2") && n.includes("· FAIL fileExists a.md"), n.slice(0, 100));
}

rmSync(dir, { recursive: true, force: true });
rmSync(storeDir, { recursive: true, force: true });
console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
