// e2e: scheduling layer (调度层 C.2 priority+aging / C.3 auto-retry) — pure core +
// Store wiring on a temp state file. Never touches the real board or daemon state.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { normPriority, effectiveRank, bestLaneIndex, retryDecision } = await import(new URL("../lib/schedule.js", import.meta.url).href);
const { Store } = await import(new URL("../lib/store.js", import.meta.url).href);

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
};

// ---------- P1: priority normalization ----------
ok("P1a null/unknown → P2", normPriority(null) === "P2" && normPriority("P9") === "P2" && normPriority(undefined) === "P2");
ok("P1b case-insensitive valid", normPriority("p0") === "P0" && normPriority("P3") === "P3");

// ---------- P2: aging math ----------
const H = 3600000;
ok("P2a fresh P3 stays 3", effectiveRank("P3", 0, H) === 3);
ok("P2b P3 lifts one rank per aging period", effectiveRank("P3", H, H) === 2 && effectiveRank("P3", 2 * H, H) === 1);
ok("P2c clamps at P0", effectiveRank("P3", 10 * H, H) === 0 && effectiveRank("P0", 10 * H, H) === 0);
ok("P2d negative wait never lifts", effectiveRank("P2", -5000, H) === 2);

// ---------- P3: bestLaneIndex ordering ----------
const now = 1_000_000_000_000;
const aging = H;
ok("P3a empty lane → -1", bestLaneIndex({ lane: [], laneAt: {}, now, agingMs: aging }) === -1);
{
  const lane = ["a", "b"];
  const laneAt = { a: { at: now, priority: "P2" }, b: { at: now, priority: "P0" } };
  ok("P3b P0 beats P2 regardless of order", bestLaneIndex({ lane, laneAt, now, agingMs: aging }) === 1);
}
{
  const lane = ["a", "b"];
  const laneAt = { a: { at: now - 1000, priority: "P2" }, b: { at: now, priority: "P2" } };
  ok("P3c same rank → FIFO (older first)", bestLaneIndex({ lane, laneAt, now, agingMs: aging }) === 0);
}
{
  const lane = ["old", "p0"];
  const laneAt = { old: { at: now - 2.5 * H, priority: "P3" }, p0: { at: now, priority: "P0" } };
  ok("P3d aged P3 (rank1) still loses to fresh P0", bestLaneIndex({ lane, laneAt, now, agingMs: aging }) === 1);
}
{
  const lane = ["old", "fresh"];
  const laneAt = { old: { at: now - 2.5 * H, priority: "P3" }, fresh: { at: now, priority: "P1" } };
  ok("P3e aged P3 (rank1, older) beats fresh P1 (rank1) — anti-starvation", bestLaneIndex({ lane, laneAt, now, agingMs: aging }) === 0);
}
{
  const lane = ["x", "y"];
  ok("P3f missing laneAt treated as now (no aging)", bestLaneIndex({ lane, laneAt: {}, now, agingMs: aging }) === 0);
}

// ---------- R1: retryDecision matrix ----------
const base = { why: "自报 success=false", result: { exitCode: 1 }, attempts: 0, maxAttempts: 2, baseMs: 30 * 60000, maxDelayMs: 4 * 3600000 };
ok("R1a transient failure retries with base delay", retryDecision(base).retry === true && retryDecision(base).delayMs === 30 * 60000 && retryDecision(base).attempt === 1);
ok("R1b backoff doubles per attempt", retryDecision({ ...base, attempts: 1 }).delayMs === 60 * 60000);
ok("R1c cap stops retrying", retryDecision({ ...base, attempts: 2 }).retry === false);
ok("R1d delay clamps at maxDelayMs", retryDecision({ ...base, attempts: 1, baseMs: 2 * H, maxDelayMs: 3 * H }).delayMs === 3 * H);
ok("R1e supply latch → no retry", retryDecision({ ...base, latch: { streak: 2 } }).retry === false);
ok("R1f manual kill → no retry", retryDecision({ ...base, killedBy: "manual" }).retry === false);
ok("R1g spawn error → no retry", retryDecision({ ...base, result: { spawnError: "ENOENT" } }).retry === false);
ok("R1h timeout kill → retry", retryDecision({ ...base, result: { killed: true, exitCode: null } }).retry === true);
ok("R1i stall kill → retry", retryDecision({ ...base, result: { stalled: true, exitCode: 1 } }).retry === true);

// ---------- S1: Store wiring on temp state ----------
{
  const dir = mkdtempSync(join(tmpdir(), "bridge-sched-"));
  const store = new Store(join(dir, "state.json"));
  const t0 = now;
  store.queue("t1", "trae", { priority: "P1" });
  store.queue("t2", "trae", { priority: "P0" });
  store.queue("t3", "trae", { priority: null }); // legacy → P2
  ok("S1a queue records laneAt meta", store.s.laneAt.t1?.priority === "P1" && Number.isFinite(store.s.laneAt.t1?.at));
  const pick1 = store.pickBest("trae", (k) => store.s.laneAt[k]?.priority, t0, aging, bestLaneIndex);
  ok("S1b pickBest pops highest priority first", pick1 === "t2" && !store.s.lanes.trae.includes("t2"));
  ok("S1c laneAt cleaned on pop", store.s.laneAt.t2 === undefined);
  const pick2 = store.pickBest("trae", (k) => store.s.laneAt[k]?.priority, t0, aging, bestLaneIndex);
  ok("S1d then P1 before P2", pick2 === "t1");
  const pick3 = store.pickBest("trae", (k) => store.s.laneAt[k]?.priority, t0, aging, bestLaneIndex);
  ok("S1e legacy P2 last; empty lane → null", pick3 === "t3" && store.pickBest("trae", (k) => null, t0, aging, bestLaneIndex) === null);

  // retry lifecycle through the real requeue path (finished key must be clearable)
  store.queue("r1", "codex", {});
  ok("S1f-pre dispatch pops the card before beginRun", store.shiftLane("codex") === "r1");
  store.endRun("r1", "failed rc=1", "codex"); // simulate settle bookkeeping (no run was open: endRun tolerates)
  ok("S1f finished key blocks a plain re-queue", store.queue("r1", "codex") === false);
  const rq = store.requeue("r1", "codex", { priority: "P0" });
  ok("S1g requeue clears finished and re-lanes with meta", rq.ok === true && store.s.laneAt.r1?.priority === "P0", JSON.stringify(rq));

  // busy-requeue semantics used by maybeRetry: run active → refused, entry kept by caller
  store.queue("r2", "trae", {});
  store.beginRun("r2", { agent: "trae" });
  const busy = store.requeue("r2", "trae");
  ok("S1h running key refused with 正在运行", busy.ok === false && String(busy.why).includes("正在运行"));

  // legacy state (no laneAt/retries keys) must not crash
  const legacy = new Store(join(dir, "legacy.json"));
  legacy.state = { cursor: 1, pid: 1, lanes: { trae: ["k1"] } }; // simulate pre-laneAt state
  const lk = legacy.pickBest("trae", () => null, t0, aging, bestLaneIndex);
  ok("S1i legacy state without laneAt works", lk === "k1" && (legacy.s.laneAt?.k1 === undefined || true));

  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
