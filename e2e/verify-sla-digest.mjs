// e2e: batch ③ — SLA overdue flagging (C.4) + per-face concurrency (C.5) + owner digest (C.6).
// Pure functions + Store wiring + test-board integration; never touches the real board.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const S = await import(new URL("../lib/sla.js", import.meta.url).href);
const { parseBridgeBlock } = await import(new URL("../lib/verify.js", import.meta.url).href);
const { Store } = await import(new URL("../lib/store.js", import.meta.url).href);
const boardCh = await import(new URL("../lib/board.js", import.meta.url).href);

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
};

const now = 1_800_000_000_000;

// ---------- S1: parseDueAt / overdueDecision ----------
ok("S1a epoch ms passthrough", S.parseDueAt(now - 1000) === now - 1000);
ok("S1b ISO parsed", S.parseDueAt(new Date(now).toISOString()) === now);
ok("S1c invalid → null", S.parseDueAt("not-a-date") === null && S.parseDueAt(null) === null && S.parseDueAt({}) === null);

ok("S2a no dueAt → null", S.overdueDecision({ dueAt: undefined, status: "open", now }) === null);
ok("S2b terminal states ignored", S.overdueDecision({ dueAt: now - 1000, status: "done", now }) === null && S.overdueDecision({ dueAt: now - 1000, status: "blocked", now }) === null);
ok("S2c not yet due → null", S.overdueDecision({ dueAt: now + 60000, status: "open", now }) === null);
{
  const r = S.overdueDecision({ dueAt: now - 3600000, status: "in-progress", now });
  ok("S2d overdue fires with duration", r?.overdueMs === 3600000, JSON.stringify(r));
}
ok("S2e notified once → silent", S.overdueDecision({ dueAt: now - 3600000, status: "open", now, notifiedAt: now - 1000 }) === null);

// ---------- D1: buildDigest ----------
ok("D1a all empty → empty", S.buildDigest({}).empty === true && S.buildDigest({ unreadBy: {}, pending: [], overdue: [], retries: [], blockedRecent: [] }).empty === true);
{
  const d = S.buildDigest({
    unreadBy: { reviewer1: 2, buddy: 1 },
    pending: [{ key: "a1", reason: "命中禁词: 部署" }],
    overdue: ["k9"],
    retries: [{ key: "r1", n: 2 }],
    blockedRecent: ["b1", "b2"],
    running: ["run1"],
  });
  ok("D1b sections rendered", !d.empty && d.text.includes("未读消息 3 条（reviewer1×2、buddy×1）") && d.text.includes("待审批 1 张") && d.text.includes("逾期 1 张") && d.text.includes("自动重派排队 1 张") && d.text.includes("近期失败/阻塞 2 张") && d.text.includes("正在跑 1 张"), d.text.replaceAll("\n", " | ").slice(0, 160));
}
{
  const many = S.buildDigest({ overdue: ["a", "b", "c", "d", "e", "f"] });
  ok("D1c >5 truncated with ellipsis", many.text.includes("逾期 6 张：a, b, c, d, e…"), many.text);
}

// ---------- C1: Store.runsFor + face concurrency arithmetic ----------
{
  const dir = mkdtempSync(join(tmpdir(), "bridge-sla-"));
  const store = new Store(join(dir, "state.json"));
  store.beginRun("t1", { agent: "trae" });
  ok("C1a face gate at 1 run: max1 closed, max2 open", !(store.runsFor("trae") < 1) && (store.runsFor("trae") < 2));
  store.beginRun("t2", { agent: "trae" });
  store.beginRun("t3", { agent: "codex" });
  ok("C1b runsFor counts per face", store.runsFor("trae") === 2 && store.runsFor("codex") === 1 && store.runsFor("pi") === 0);
  ok("C1c face gate at 2 runs: max2 closed too", !(store.runsFor("trae") < 2));
  rmSync(dir, { recursive: true, force: true });
}

// ---------- B1: test-board integrated overdue scan (replicates maybeSla's decision flow) ----------
{
  const dir = mkdtempSync(join(tmpdir(), "bridge-sla-board-"));
  const boardDir = join(dir, "board");
  await boardCh.init(fileURLToPath(new URL("../board", import.meta.url)));
  const cfg = { dir: boardDir, identity: "bridge" };
  const desc = '任务说明\n```bridge\n{ "dueAt": "2020-01-01T00:00:00Z" }\n```\n';
  await boardCh.withBoard(cfg, (b) => b.defineTask("zcode", "sla-e2e-1", { title: "sla e2e", description: desc }));
  const notified = {};
  let flagged;
  await boardCh.withBoard(cfg, (b) => {
    const t = b.getTask("sla-e2e-1");
    const bb = parseBridgeBlock(t.description);
    const dec = S.overdueDecision({ dueAt: bb?.dueAt, status: t.status, now: Date.now(), notifiedAt: notified[t.key] });
    ok("B1a bridge block dueAt extracted, overdue fires", bb?.dueAt === "2020-01-01T00:00:00Z" && !!dec);
    if (dec) {
      notified[t.key] = Date.now();
      boardCh.note(b, "bridge", `[OVERDUE] ${t.key} 已逾期 — 测试`);
      boardCh.message(b, "bridge", t.createdBy ?? "kemu", `[bridge] 任务 ${t.key} 已逾期，请处置。`);
      flagged = t.key;
    }
  });
  ok("B1b flagged key", flagged === "sla-e2e-1");
  await boardCh.withBoard(cfg, (b) => {
    const evs = b.timeline(100);
    ok("B1c [OVERDUE] note on chain", evs.some((e) => String(e.summary).includes("[OVERDUE] sla-e2e-1")));
    const msgs = b.inbox("zcode", true);
    ok("B1d creator notified", msgs.some((m) => JSON.stringify(m).includes("已逾期")));
    // 第二次扫描：notified 台账拦住，不再重复
    const t = b.getTask("sla-e2e-1");
    const bb = parseBridgeBlock(t.description);
    const again = S.overdueDecision({ dueAt: bb?.dueAt, status: t.status, now: Date.now(), notifiedAt: notified[t.key] });
    ok("B1e second scan silent (once-per-card)", again === null);
    ok("B1f chain intact", b.verifyChain().brokenAtSeq === null);
  });
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
