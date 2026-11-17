// e2e: review queue (验证层 V2 交叉 / V3 人工) — queueReview / accept / reject against
// a TEST board + temp store. Never touches the real board.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const R = await import(new URL("../lib/review.js", import.meta.url).href);
const { Store } = await import(new URL("../lib/store.js", import.meta.url).href);
const boardCh = await import(new URL("../lib/board.js", import.meta.url).href);

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
};

const dir = mkdtempSync(join(tmpdir(), "bridge-review-"));
const storeDir = mkdtempSync(join(tmpdir(), "bridge-rstore-"));
const store = new Store(join(storeDir, "state.json"));
await boardCh.init(fileURLToPath(new URL("../board", import.meta.url)));
const cfg = { dir: join(dir, "board"), identity: "bridge" };

// ---- queueReview: cross → V2 ----
{
  await boardCh.withBoard(cfg, (b) => b.defineTask("zcode", "rev-cross-1", { title: "cross e2e", description: "测试" }));
  let res;
  await boardCh.withBoard(cfg, (b) => {
    res = R.queueReview({ b, io: boardCh, store, ID: "bridge", key: "rev-cross-1", agent: "trae", mode: "cross", reviewer: "reviewer1", runDir: "D:/runs/x", v1Note: "（V1 机械项已过 2/2）" });
  });
  ok("Q1a cross → V2 queued", res.level === "V2" && res.reviewer === "reviewer1", JSON.stringify(res));
  ok("Q1b ledger entry", store.s.review["rev-cross-1"]?.mode === "cross" && store.s.review["rev-cross-1"]?.agent === "trae");
  await boardCh.withBoard(cfg, (b) => {
    const evs = b.timeline(100);
    ok("Q1c REVIEW note with level+reviewer", evs.some((e) => String(e.summary).includes("verdict=REVIEW level=V2 reviewer=reviewer1")));
    ok("Q1d v1Note carried", evs.some((e) => String(e.summary).includes("V1 机械项已过 2/2")));
    const msgs = b.inbox("reviewer1", true);
    ok("Q1e reviewer notified with commands", msgs.some((m) => JSON.stringify(m).includes("review-accept rev-cross-1")));
  });
}

// ---- accept: done + PASS note ----
{
  let res;
  await boardCh.withBoard(cfg, (b) => {
    res = R.applyReviewAccept({ b, io: boardCh, store, ID: "bridge", key: "rev-cross-1" });
  });
  ok("Q2a accept ok", res.ok === true && res.mode === "cross", JSON.stringify(res));
  ok("Q2b ledger cleared", store.s.review["rev-cross-1"] === undefined);
  await boardCh.withBoard(cfg, (b) => {
    ok("Q2c task done", b.getTask("rev-cross-1")?.status === "done");
    ok("Q2d PASS note (复核人 recorded)", b.timeline(200).some((e) => String(e.summary).includes("verdict=PASS level=V2") && String(e.summary).includes("复核人=reviewer1")));
    ok("Q2e executor notified", b.inbox("trae", true).some((m) => JSON.stringify(m).includes("复核通过")));
    ok("Q2f chain ok", b.verifyChain().brokenAtSeq === null);
  });
  await boardCh.withBoard(cfg, (b) => {
    const r = R.applyReviewAccept({ b, io: boardCh, store, ID: "bridge", key: "rev-cross-1" });
    ok("Q2g accept on empty queue → refused", r.ok === false && String(r.why).includes("不在复核队列"));
  });
}

// ---- reject: open + FAIL note; human → V3 ----
{
  await boardCh.withBoard(cfg, (b) => b.defineTask("zcode", "rev-human-1", { title: "human e2e", description: "测试" }));
  await boardCh.withBoard(cfg, (b) => {
    R.queueReview({ b, io: boardCh, store, ID: "bridge", key: "rev-human-1", agent: "codex", mode: "human", reviewer: "kemu", runDir: "D:/runs/y" });
  });
  ok("Q3a human → V3 queued", store.s.review["rev-human-1"]?.mode === "human");
  let res;
  await boardCh.withBoard(cfg, (b) => {
    res = R.applyReviewReject({ b, io: boardCh, store, ID: "bridge", key: "rev-human-1", reason: "第三节口径不对" });
  });
  ok("Q3b reject ok", res.ok === true, JSON.stringify(res));
  ok("Q3c ledger cleared", store.s.review["rev-human-1"] === undefined);
  await boardCh.withBoard(cfg, (b) => {
    ok("Q3d task back to open", b.getTask("rev-human-1")?.status === "open");
    ok("Q3e FAIL note carries reason + V3", b.timeline(300).some((e) => String(e.summary).includes("verdict=FAIL level=V3") && String(e.summary).includes("第三节口径不对")));
    ok("Q3f executor notified with requeue hint", b.inbox("codex", true).some((m) => JSON.stringify(m).includes("requeue rev-human-1")));
    ok("Q3g chain ok", b.verifyChain().brokenAtSeq === null);
  });
}

rmSync(dir, { recursive: true, force: true });
rmSync(storeDir, { recursive: true, force: true });
console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
