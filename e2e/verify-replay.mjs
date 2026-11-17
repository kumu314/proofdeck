// e2e: replay 时间旅行（采纳建议④）—— foldTasks 折叠规则 × 真实 Board 事件流 + diffToNow。
// 纯 TEST board，不碰现网。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const boardCh = await import(new URL("../lib/board.js", import.meta.url).href);
const R = await import(new URL("../lib/replay.js", import.meta.url).href);

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
};

const dir = mkdtempSync(join(tmpdir(), "bridge-replay-"));
await boardCh.init(fileURLToPath(new URL("../board", import.meta.url)));
const cfg = { dir: join(dir, "board"), identity: "bridge" };

// 在已知 seq 点位记录快照锚点
const marks = {};
const mark = (name) => {
  return boardCh.withBoard(cfg, (b) => { marks[name] = b.head().seq; });
};

await mark("defined");
await boardCh.withBoard(cfg, (b) => {
  b.defineTask("zcode", "rp-a", { title: "A" });
  b.defineTask("zcode", "rp-b", { title: "B" });
  b.note("zcode", "中间的 note 不该影响折叠");
});
await mark("defined2");
await boardCh.withBoard(cfg, (b) => { b.claim("trae", "rp-a"); });
await mark("claimed");
await boardCh.withBoard(cfg, (b) => { b.setProgress("trae", "rp-a", 40); });
await mark("progress40");
await boardCh.withBoard(cfg, (b) => { b.complete("trae", "rp-a"); b.setTaskStatus("zcode", "rp-b", "blocked"); });
await mark("settled");
await boardCh.withBoard(cfg, (b) => { b.setTaskStatus("zcode", "rp-a", "open"); }); // 重开：释放持有
await mark("reopened");

try {
  const events = await boardCh.withBoard(cfg, (b) => b.since(0));

  {
    const f = R.foldTasks(events, marks.defined);
    ok("R1 定义前无任务", f.size === 0);
  }
  {
    const f = R.foldTasks(events, marks.defined2);
    ok("R2 两张卡已出现且 open", f.get("rp-a")?.status === "open" && f.get("rp-b")?.status === "open" && f.size === 2);
    ok("R2b claim 前无持有者", f.get("rp-a")?.claimedBy === null);
  }
  {
    const f = R.foldTasks(events, marks.claimed);
    ok("R3 claim 登记持有（不改状态）", f.get("rp-a")?.claimedBy === "trae" && f.get("rp-a")?.status === "open", JSON.stringify(f.get("rp-a")));
  }
  {
    const f = R.foldTasks(events, marks.progress40);
    ok("R4 progress 40 → in-progress", f.get("rp-a")?.status === "in-progress" && f.get("rp-a")?.progress === 40);
  }
  {
    const f = R.foldTasks(events, marks.settled);
    ok("R5a complete → done 且 progress≥100", f.get("rp-a")?.status === "done" && f.get("rp-a")?.progress >= 100);
    ok("R5b task-status blocked 生效", f.get("rp-b")?.status === "blocked");
  }
  {
    const f = R.foldTasks(events);
    ok("R6a 重开释放持有者", f.get("rp-a")?.status === "open" && f.get("rp-a")?.claimedBy === null && f.get("rp-a")?.progress === 0);
    // 全量折叠应与当前板一致（diff 为空）
    const current = await boardCh.withBoard(cfg, (b) => new Map(b.listTasks().map((t) => [t.key, t])));
    const diffs = R.diffToNow(f, current);
    ok("R6b 全量折叠 vs 现板 无差异", diffs.length === 0, JSON.stringify(diffs));
  }
  {
    // 时间旅行差异：在 claimed 时刻看，rp-a 现在也回到了 open（done→重开）⇒ 无差异；
    // rp-b 则是 open→blocked ⇒ 有差异
    const f = R.foldTasks(events, marks.claimed);
    const current = await boardCh.withBoard(cfg, (b) => new Map(b.listTasks().map((t) => [t.key, t])));
    const diffs = R.diffToNow(f, current);
    const da = diffs.find((d) => d.key === "rp-a");
    const db = diffs.find((d) => d.key === "rp-b");
    ok("R7a rp-a 终态回到 open ⇒ 无差异", da === undefined, JSON.stringify(da));
    ok("R7b 差异点名 rp-b（open→blocked）", db && db.now === "blocked", JSON.stringify(db));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { }
}
