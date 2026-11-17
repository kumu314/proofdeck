// e2e: 共享包扩展一等公民（2026-10-07）—— tasks.acceptance 列 + Board.verify/verificationsFor
// 公开写 API + 桥侧裁决落链。纯 TEST board + temp store，不碰现网。
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const boardCh = await import(new URL("../lib/board.js", import.meta.url).href);
const { Store } = await import(new URL("../lib/store.js", import.meta.url).href);
const V = await import(new URL("../lib/verify.js", import.meta.url).href);
const R = await import(new URL("../lib/review.js", import.meta.url).href);

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
};

const dir = mkdtempSync(join(tmpdir(), "bridge-fc-"));
const storeDir = mkdtempSync(join(tmpdir(), "bridge-fcstore-"));
const store = new Store(join(storeDir, "state.json"));
await boardCh.init(fileURLToPath(new URL("../board", import.meta.url)));
const cfg = { dir: join(dir, "board"), identity: "bridge" };
const acc1 = { baseDir: join(dir, "fc-base"), mode: "auto", checks: [{ type: "fileExists", path: "out/a.md" }] };

try {
  // ---- 1. Board 一等 acceptance 列 ----
  await boardCh.withBoard(cfg, (b) => {
    b.defineTask("zcode", "fc-1", { title: "first-class", acceptance: acc1 });
    const t = b.getTask("fc-1");
    ok("F1a defineTask 收 acceptance 并解析回对象", JSON.stringify(t.acceptance) === JSON.stringify(acc1), JSON.stringify(t.acceptance));
    ok("F1b taskCard 透传", JSON.stringify(b.taskCard("fc-1").task.acceptance) === JSON.stringify(acc1));
  });
  // 列优先：再定义（只给 description 围栏块）不清掉列值 —— COALESCE 语义
  await boardCh.withBoard(cfg, (b) => {
    b.defineTask("zcode", "fc-1", { description: "x\n```bridge\n{\"acceptance\":{\"mode\":\"human\"}}\n```\n" });
    ok("F1c 列值不被裸重定义清除（列优先于围栏块的前提）", b.getTask("fc-1").acceptance?.mode === "auto");
    b.defineTask("zcode", "fc-2", { title: "no acc" });
    ok("F1d 未声明的任务 acceptance=null", b.getTask("fc-2").acceptance === null);
    const t3 = b.defineTask("zcode", "fc-3", { title: "str", acceptance: '{"mode":"cross"}' });
    ok("F1e 字符串 spec 规范化为对象", t3.acceptance?.mode === "cross");
    const t4 = b.defineTask("zcode", "fc-4", { title: "bad", acceptance: "not-json" });
    ok("F1f 垃圾 spec fail-closed 落 null", t4.acceptance === null);
  });

  // ---- 2. Board.verify 公开写 API ----
  await boardCh.withBoard(cfg, (b) => {
    const ev = b.verify("bridge", "fc-1", "pass", { level: "V1", checks: [{ type: "fileExists", target: "out/a.md", pass: true }] });
    ok("F2a verify 返回事件且 kind=verify", ev?.kind === "verify");
    const vs = b.verificationsFor("fc-1");
    ok("F2b verificationsFor 读回裁决", vs.length === 1 && vs[0].verdict === "pass" && vs[0].level === "V1", JSON.stringify(vs[0] ?? {}));
    let threw = false;
    try { b.verify("bridge", "fc-1", "PROBABLY"); } catch { threw = true; }
    ok("F2c verdict fail-closed（非 pass/fail 抛错）", threw);
    ok("F2d 未知任务 verify 返回 undefined", b.verify("bridge", "nope", "pass") === undefined);
    ok("F2e 未知任务 verificationsFor 返回 []", b.verificationsFor("nope").length === 0);
    ok("F2f 链完整", b.verifyChain().brokenAtSeq === null);
  });

  // ---- 3. 桥侧裁决落链（真实 Board + io=boardCh 模块）----
  const vPass = { pass: true, checks: [{ type: "fileExists", target: "out/a.md", pass: true, evidence: "ok" }] };
  const vFail = { pass: false, checks: [{ type: "countAtLeast", target: "out/a.md", pass: false, evidence: "missing" }] };
  await boardCh.withBoard(cfg, (b) => {
    V.applyVerifyPass({ b, io: boardCh, ID: "bridge", key: "fc-1", v: vPass });
    const vs = b.verificationsFor("fc-1");
    ok("F3a applyVerifyPass 落 verify 事件", vs.length === 2 && vs[0].verdict === "pass" && vs[0].actor === "bridge", `n=${vs.length}`);
  });
  await boardCh.withBoard(cfg, (b) => {
    b.defineTask("zcode", "fc-5", { title: "fail path", acceptance: acc1 });
    const res = V.applyVerifyFail({ b, io: boardCh, store, ID: "bridge", owner: "reviewer1", key: "fc-5", agent: "trae", task: { createdBy: "reviewer1" }, v: vFail, maxAttempts: 2, baseMs: 1000, maxDelayMs: 2000, holdBase: 1000, holdMax: 4000, now: Date.now() });
    ok("F3b applyVerifyFail 走重试路径", res.outcome === "retry-scheduled", JSON.stringify(res));
    const vs = b.verificationsFor("fc-5");
    ok("F3c FAIL 裁决落链", vs.length === 1 && vs[0].verdict === "fail" && vs[0].level === "V1");
    ok("F3d 链完整（fail 分支后）", b.verifyChain().brokenAtSeq === null);
  });
  // 复核 accept/reject → V2 事件
  await boardCh.withBoard(cfg, (b) => {
    b.defineTask("zcode", "fc-6", { title: "review acc", acceptance: { mode: "cross" } });
    R.queueReview({ b, io: boardCh, store, ID: "bridge", key: "fc-6", agent: "trae", mode: "cross", reviewer: "reviewer1", runDir: "D:/runs/y" });
    const a = R.applyReviewAccept({ b, io: boardCh, store, ID: "bridge", key: "fc-6" });
    ok("F3e review accept ok", a.ok === true);
    ok("F3f V2 PASS 落链", b.verificationsFor("fc-6").some((v) => v.verdict === "pass" && v.level === "V2"));
  });
  await boardCh.withBoard(cfg, (b) => {
    b.defineTask("zcode", "fc-7", { title: "review rej", acceptance: { mode: "human" } });
    R.queueReview({ b, io: boardCh, store, ID: "bridge", key: "fc-7", agent: "trae", mode: "human", reviewer: "reviewer1", runDir: "D:/runs/z" });
    const r = R.applyReviewReject({ b, io: boardCh, store, ID: "bridge", key: "fc-7", reason: "工件不完整" });
    ok("F3g review reject ok", r.ok === true);
    ok("F3h V3 FAIL 落链（带理由）", b.verificationsFor("fc-7").some((v) => v.verdict === "fail" && v.level === "V3" && String(v.summary).includes("工件不完整")));
    ok("F3i 终局链完整", b.verifyChain().brokenAtSeq === null);
  });

  // ---- 4. MCP 面存在性（handleTool 未导出，做结构断言）----
  const mcpSrc = readFileSync(fileURLToPath(new URL("../board/dist/mcp.js", import.meta.url)), "utf8");
  ok("F4a board_task_define schema 带 acceptance", /name: "board_task_define"[\s\S]*?acceptance: \{/.test(mcpSrc));
  ok("F4b board_verify 工具已注册", mcpSrc.includes('name: "board_verify"') && /case "board_verify":/.test(mcpSrc));
  ok("F4c handler 透传 acceptance", /board_task_define[\s\S]{0,400}acceptance: args\.acceptance \?\? null/.test(mcpSrc));

  // ---- 5. 类型声明同步 ----
  const dts = readFileSync(fileURLToPath(new URL("../board/dist/board.d.ts", import.meta.url)), "utf8");
  const typesDts = readFileSync(fileURLToPath(new URL("../board/dist/types.d.ts", import.meta.url)), "utf8");
  ok("F5a board.d.ts 声明 verify/verificationsFor", dts.includes("verify(actor:") && dts.includes("verificationsFor(key:"));
  ok("F5b types.d.ts Task 带 acceptance", /interface Task [\s\S]{0,900}acceptance: Record<string, unknown> \| null;/.test(typesDts));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { }
  try { rmSync(storeDir, { recursive: true, force: true }); } catch { }
}
