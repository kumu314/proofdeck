// agent-bridge daemon — real-time blackboard task executor.
// Doorbell (OS file event) -> timeline cursor catch-up -> gating -> headless
// agent spawn -> automatic claim/progress/done/note write-back.
// Board I/O exclusively via the shared octopus-blackboard Board library.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { killTree, getProcessInfo } from "./lib/platform.js";
import * as board from "./lib/board.js";
import { Store } from "./lib/store.js";
import { createNotifier } from "./lib/notify.js";
import { createGating, findDispatchFiles, nonAsciiProductNames, faceReachable } from "./lib/gating.js";
import { runTask, getAdapter } from "./lib/runner.js";
import { scanRunDir, supplyReason, hold, left } from "./lib/supply.js";
import { convertBillingTask, billingOwnerNotice } from "./lib/billing-convert.js";
import { maxSegments, capture, renderPriming, shouldStopSegmenting, segmentOverrun, SEGMENT_CAP } from "./lib/checkpoint.js";
import { STARVE_LIMIT } from "./lib/starve.js";
import { normalizeUsage, missingUsage, appendUsage } from "./lib/usage.js";
import { leaseSweep } from "./lib/lease.js";
import { bestLaneIndex, retryDecision } from "./lib/schedule.js";
import { parseBridgeBlock, evaluateAcceptance, formatVerifyNote, applyVerifyPass, applyVerifyFail } from "./lib/verify.js";
import { runJudge } from "./lib/judge.js";
import { parseNeeds, faceHasCaps, pickCapableFace } from "./lib/caps.js";
import { initSpans, emitSpan } from "./lib/spans.js";
import { queueReview } from "./lib/review.js";
import { overdueDecision, buildDigest } from "./lib/sla.js";
import { createControlServer } from "./lib/http.js";

const BASE = dirname(fileURLToPath(import.meta.url));
const USAGEF = join(BASE, "usage.jsonl"); // 用量台账：随 BASE 走，冒烟的第二实例天然写到自己目录
const cfgPath = process.argv[2] ? resolveCfg(process.argv[2]) : join(BASE, "daemon.config.json");
function resolveCfg(p) { return p.includes(":") || p.startsWith("/") ? p : join(BASE, p); }
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));

const ID = cfg.board.identity;
const DAY = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`; };
const LOGF = join(BASE, "logs", `daemon-${DAY()}.log`);
mkdirSync(dirname(LOGF), { recursive: true });
initSpans({ dir: join(BASE, "logs"), enabled: cfg.runtime?.spans?.enabled !== false });

let t0 = process.hrtime.bigint();
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  appendFileSync(LOGF, line + "\n");
  console.log(line);
}
const latencyMark = () => Number(process.hrtime.bigint() - t0) / 1e6;

const store = new Store(join(BASE, "state.json"));
const gating = createGating(cfg.gating);
const STOP = join(BASE, "STOP");
const enabledAgents = Object.entries(cfg.agents)
  .filter(([, a]) => a.enabled).map(([name]) => name);

// ---- 供应方熔断（#25）-------------------------------------------------------
// 判据是三条同时成立，缺一条都不冻：
//   ① 这次 run 判失败；② 它一步都没走（items===0）；③ run 目录里扫到供应方文案。
// ②不可省：拿 19 个历史 run 全量回归时，一个「成功交付 1991B 产物」的 codex run
// 因为 agent 自己在工具调用里引用了 "invalid api key" 字样而被 ①③ 命中——
// 只看文案会把活着的面冻掉，只看进度会把"0 步但没留下文案"的失败漏掉。
// 冻结只作用于「该面的派发」，队列不清空、卡不判死：供应方回来探针自己会放行。
const SUPPLY = cfg.runtime?.supply ?? {};
const HOLD_BASE = SUPPLY.baseMs ?? 300000;   // 第 1 次冻 5 分钟
const HOLD_MAX = SUPPLY.maxMs ?? 7200000;    // 封顶 2 小时
const holdMsFor = (streak) => Math.min(HOLD_BASE * 2 ** (streak - 1), HOLD_MAX);
// 供应方时长写法统一走 lib/supply.js 的 hold/left，别让板上有「暂停 0 分钟」这种读着像没冻的字符串。

// ---- 认领租约（claim lease）--------------------------------------------------
// 只自动释放【自己身份】的过期 claim，他人的只报告（最小权力，见 lib/lease.js 头注）。
// 豁免：本守护 runs 里正在跑的键（在跑=活着的持有）。
const LEASE = cfg.runtime?.lease ?? {};
const LEASE_TTL_MS = (LEASE.ttlHours ?? 24) * 3600000;
const LEASE_SESSION_MS = LEASE.sessionMs ?? 600000;   // 持有者心跳窗口：10 分钟内有 heartbeat 算活着
const RETRY = cfg.runtime?.retry ?? {};               // 自动重派（调度层 C.3）
const PRIORITY = cfg.runtime?.priority ?? {};         // 优先级 aging（调度层 C.2）
const VERIFY = cfg.runtime?.verify ?? {};             // 验收层 V1（验证层 Part B）
const JUDGE = cfg.runtime?.judge ?? {};               // 验收层 V1.5 judge（2026-10-07 采纳建议①）
const SLA = cfg.runtime?.sla ?? {};                   // 逾期标红（调度层 C.4）
const DIGEST = cfg.runtime?.digest ?? {};             // owner 摘要（调度层 C.6）
// owner 提醒开关：额度/账单类供应方事件由黑板内部消化，不再私信 owner 刷屏。
// cfg.runtime.notify.ownerSupply=false 时，首场供应方故障与恢复只进日志与卡级消息
// （创建人仍会收到），不再 ping owner。默认 true = 旧行为。
const NOTIFY = cfg.runtime?.notify ?? {};
const OWNER_SUPPLY_NOTIFY = NOTIFY.ownerSupply !== false;

// ---- 余额断供 → 转公开待认领任务 ----------------------------------------
// 现状（改前）：billing 类失败 → 卡落 blocked → 该面熔断 → 队列保留，等熔断到期或人工 requeue。
// 问题是「卡僵在那」：余额耗尽不会自己恢复，等下去永远等不到，而卡面上没人知道"这是断供、可以换人做"。
// 转化形态：不自动改派（同一部署的面往往共用一个钱包，改派很可能撞另一个同样空的），
// 而是把原卡标成"断供待认领"并在板上广播一张公开可认领的任务；owner 只在该面【首次】断供时报一次。
const BILLING_CONVERT = cfg.runtime?.billingConvert ?? {};
const BILLING_CONVERT_ON = BILLING_CONVERT.enabled !== false;
// 已转过的 key（进程内 + 落 state）：熔断会反复触发，广播只该发一次。
const billingConverted = store.s.billingConverted ??= {};

async function maybeLease() {
  if (!LEASE.enabled || existsSync(STOP)) return;
  try {
    const busy = new Set(Object.keys(store.s.runs));
    const r = await leaseSweep({
      boardCfg: cfg.board, identity: ID,
      ttlMs: LEASE_TTL_MS, sessionMs: LEASE_SESSION_MS,
      busyKeys: busy, apply: true, log,
    });
    // 他人过期 claim 的报告按集合变化记日志，不按节奏刷——这块改不了，反复喊也没用。
    const sig = r.otherStale.map((o) => o.key).sort().join(",");
    const prevSig = store.s.lease?.otherSig ?? "";
    if (sig !== prevSig) {
      (store.s.lease ??= {}).otherSig = sig;
      store.save();
      if (sig) log(`lease report: 他人持有的过期 claim（只报告不代释）：${r.otherStale.map((o) => `${o.key}(${o.holder},${(o.ageMs / 3600000).toFixed(0)}h)`).join(" ")}`);
    }
    if (r.released.length) {
      log(`lease sweep: released ${r.released.join(", ")}`);
      await board.withBoard(cfg.board, (b) => board.message(b, ID, cfg.owner,
        `[${ID}] 租约巡检：自动释放了自己持有的过期 claim ${r.released.join(", ")}（note 已上板）。`
        + (r.otherStale.length ? `另有 ${r.otherStale.length} 张他人持有的过期 claim 未动（最小权力，只报告）：${r.otherStale.map((o) => `${o.key}(${o.holder})`).join(" ")}。查看: node bridge-ctl.js leases` : "")));
    }
  } catch (e) {
    log(`lease sweep error: ${e.message}`);
  }
}

// 自动重派到期扫描（调度层 C.3）：到点把重试卡 requeue 回队。面忙就顺延一拍不丢卡；
// 已进人工审批的作废；面被熔断时 requeue 会成功但派发被 supply hold 挡住——排队等恢复，无害。
async function maybeRetry() {
  if (existsSync(STOP)) return;
  const now = Date.now();
  const due = Object.entries(store.s.retries ?? {}).filter(([, r]) => Number(r.dueAt) <= now);
  for (const [key, r] of due) {
    if (store.s.pending?.[key]) {
      delete store.s.retries[key];
      store.save();
      log(`auto-retry cancelled for ${key}: moved to human approval`);
      continue;
    }
    // 台账可能比结案活得久（复核中/人工改状态/历史遗留）：重派前看一眼板面。
    // 已 done/blocked 的卡不再重派（成功或人工裁定优先于过期的重试意图）；
    // 在复核队列里的卡不重派（复核结果才是裁决，重派会跟复核打架）。
    if (store.s.review?.[key]) {
      delete store.s.retries[key];
      store.save();
      log(`auto-retry dropped for ${key}: awaiting review`);
      continue;
    }
    let settled = null;
    try { settled = await board.withBoard(cfg.board, (b) => board.card(b, key)?.task?.status ?? null); } catch { }
    if (settled === "done" || settled === "blocked") {
      delete store.s.retries[key];
      store.save();
      log(`auto-retry dropped for ${key}: task already ${settled}`);
      continue;
    }
    const res = store.requeue(key, r.agent);
    if (res.ok) {
      delete store.s.retries[key];
      store.save();
      log(`auto-requeued ${key} -> ${r.agent} (attempt ${r.n})`);
      await board.withBoard(cfg.board, (b) =>
        board.note(b, ID, `[${ID}→${r.agent}] ${key} 自动重派第 ${r.n} 次尝试（上次失败：${r.why}）`))
        .catch((e) => log(`retry requeue note failed for ${key}: ${e.message}`));
      wake(`auto-retry ${key}`);
    } else if (String(res.why ?? "").includes("正在运行")) {
      r.dueAt = now + (RETRY.sweepMs ?? 60000) + 1000;
      store.save();
    } else {
      delete store.s.retries[key];
      store.save();
      log(`auto-retry dropped ${key}: ${res.why}`);
    }
  }
}

// 逾期标红（调度层 C.4）：任务书 bridge 块有 dueAt 且未终态、未提醒过 → 标 [OVERDUE] + 喊创建人。
// 一卡一次（v1），不强制取消——只做升级可见性。
async function maybeSla() {
  if (SLA.enabled === false || existsSync(STOP)) return;
  const now = Date.now();
  const hits = [];
  await board.withBoard(cfg.board, (b) => {
    for (const t of b.listTasks()) {
      if (t.status === "done" || t.status === "blocked") continue;
      const bb = parseBridgeBlock(t.description);
      const dec = overdueDecision({ dueAt: bb?.dueAt, status: t.status, now, notifiedAt: store.s.slaNotified?.[t.key] });
      if (!dec) continue;
      (store.s.slaNotified ??= {})[t.key] = now;
      hits.push(t.key);
      board.note(b, ID, `[OVERDUE] ${t.key} 已逾期 ${left(dec.overdueMs)}（状态=${t.status}）—— 需要人处置：催办/改期/撤卡。`);
      emitSpan("gen_ai.agent.sla", { task: t.key, overdueMs: dec.overdueMs, status: t.status });
      board.message(b, ID, t.createdBy ?? cfg.owner, `[${ID}] 任务 ${t.key} 已逾期 ${left(dec.overdueMs)}（状态=${t.status}），请处置（催办/改期/撤卡）。`);
    }
  });
  if (hits.length) {
    store.save();
    log(`sla: flagged overdue ${hits.join(", ")}`);
  }
}

// owner 摘要（调度层 C.6）：未读/在跑/待审批/逾期/重试/近期失败的聚合，一条消息摊薄裁决成本。
// 首见时从当下计时（防重启轰炸）；全空静默跳过且照常顺延计时。
async function maybeDigest() {
  if (DIGEST.enabled === false) return;
  const now = Date.now();
  const d = (store.s.digest ??= { lastAt: now });
  const everyMs = DIGEST.everyMs ?? 21600000;
  if (now - d.lastAt < everyMs) return;
  let digest = null;
  await board.withBoard(cfg.board, (b) => {
    const unreadBy = {};
    for (const m of b.inbox(cfg.owner, false)) {
      const from = m.from ?? m.actor ?? "?";
      unreadBy[from] = (unreadBy[from] ?? 0) + 1;
    }
    const pending = Object.entries(store.s.pending ?? {}).map(([key, p]) => ({ key, reason: p.reason }));
    const overdue = Object.keys(store.s.slaNotified ?? {});
    const retries = Object.entries(store.s.retries ?? {}).map(([key, r]) => ({ key, n: r.n }));
    const blockedRecent = Object.entries(store.s.finished ?? {})
      .filter(([, f]) => Date.parse(f.at ?? "") > now - everyMs && f.result !== "done").map(([k]) => k);
    const running = Object.keys(store.s.runs ?? {});
    // 验收覆盖（§17 推广）：本期新派卡（timeline kind=task 落在本周期内）里有多少带验收标准。
    let coverage = null;
    try {
      const cutoff = new Date(now - everyMs).toISOString();
      const rows = b.db.prepare("SELECT payload, at FROM timeline WHERE kind = 'task' AND at > ? ORDER BY seq").all(cutoff);
      const keys = rows.map((r) => { try { return JSON.parse(r.payload ?? "{}")?.key; } catch { return null; } }).filter(Boolean);
      const uniq = [...new Set(keys)];
      const unverified = uniq.filter((k) => { const t = b.getTask(k); return t && !t.acceptance; });
      coverage = { total: uniq.length, verified: uniq.length - unverified.length, unverified };
    } catch { /* 统计失败不砸摘要 */ }
    digest = buildDigest({ unreadBy, pending, overdue, retries, blockedRecent, running, coverage });
    if (!digest.empty) board.message(b, ID, cfg.owner, digest.text);
  });
  d.lastAt = now;
  store.save();
  log(digest?.empty ? "digest: nothing to report" : `digest sent to ${cfg.owner}`);
}

async function tick(why) {
  const state = store.s;
  // 1) catch up the durable cursor (truth), doorbell is just a trigger
  const { events, headSeq } = await board.withBoard(cfg.board, (b) => {
    const from = state.cursor ?? b.head().seq;
    return { events: board.since(b, from), headSeq: b.head().seq };
  });
  if (state.cursor == null) {
    state.cursor = headSeq; // first boot: don't replay history
    log(`cursor initialized at ${headSeq}`);
    store.save();
    return;
  }
  if (state.cursor > headSeq) {
    log(`cursor ${state.cursor} ahead of head ${headSeq}: re-anchored`);
    state.cursor = headSeq; // board switched / stale cursor — re-anchor, never replay
    store.save();
    return;
  }
  let queued = 0;
  for (const e of events) {
    state.cursor = Math.max(state.cursor, e.seq);
    if (e.kind === "assign" && e.actor !== ID) {
      const to = e.payload?.to, key = e.payload?.key;
        if (to === "workbuddy") {
          await pokeWorkbuddyWorker(`首戳 ${key}`);
          // 登记 re-poke 看门狗：未被认领前持续补戳，抵消"撞上在跑的 tick 被重置"的坑
          const watch = (store.s.repokes ??= {});
          watch[key] = { addedAt: Date.now(), lastPokeAt: Date.now(), attempts: 1 };
          store.save();
          log(`@workbuddy ${key} 实时侦测 (seq ${e.seq}, from ${e.actor}, +${latencyMark()}ms) → 已戳小羽 worker（~1-2min 拉起；未受理会自动补戳）`);
        } else {
        // direct exec agent (e.g. codex/pi) OR a board alias that routes to one
        // (e.g. bridge -> codex). @codex/@pi 仍由 daemon 用 headless codex/pi 引擎处理。
        const route = cfg.board?.route || {};
        const execAgent = (to && enabledAgents.includes(to)) ? to : (to && route[to]);
        if (execAgent && key) {
          if (store.queue(key, execAgent, { priority: e.payload?.priority })) { queued++; log(`queued ${key} -> ${execAgent} (via ${to}, seq ${e.seq}, from ${e.actor}, +${latencyMark()}ms since wake)`); }
        } else if (key) {
          log(`assign ${key} -> ${to ?? "?"} not for us (seq ${e.seq})`);
        }
      }
    }
  }
  store.save();

  // 2) schedule lanes (paused entirely while STOP is present)
  if (existsSync(STOP)) {
    if (store.s.lanes && Object.values(store.s.lanes).some((l) => l.length)) log("STOP present — scheduling paused");
    return;
  }
  for (const agent of enabledAgents) {
    if (store.supplyHeld(agent)) {
      // 队列原样留着：熔断只掐「现在要不要起子进程」，不改卡的状态、不丢任务。
      const held = store.supplyGet(agent);
      const lane = store.s.lanes?.[agent] ?? [];
      if (lane.length && Date.now() - (held.lastHoldLogAt ?? 0) > (SUPPLY.logEveryMs ?? 600000)) {
        held.lastHoldLogAt = Date.now();
        store.save();
        log(`supply hold: ${agent} 熔断中（${held.category} streak=${held.streak}，剩 ${left(held.holdUntil - Date.now())} 放行探针）→ 队列 ${lane.length} 张暂不派发`);
      }
      continue;
    }
    // 优先级出队（调度层 C.2）：assign 时的 laneAt 优先级 → 卡 payload.priority /
    // 任务书 description 里 ```bridge 块的 priority → 缺省 P2。
    // 队列里 >1 张才开一次板查任务书；0/1 张零开销直走。
    const laneKeys = store.s.lanes?.[agent] ?? [];
    let cardPrio = null;
    if (laneKeys.length > 1) {
      cardPrio = await board.withBoard(cfg.board, (b) =>
        Object.fromEntries(laneKeys.map((k) => {
          const t = board.card(b, k)?.task;
          return [k, t?.payload?.priority ?? parseBridgeBlock(t?.description)?.priority ?? null];
        })))
        .catch(() => null);
    }
    const priorityOf = (k) => store.s.laneAt?.[k]?.priority ?? cardPrio?.[k] ?? null;
    const agingMs = PRIORITY.agingMs ?? 7200000;
    // 面级并发（调度层 C.5）：每面 maxConcurrent（缺省 1 = 与旧行为一致——同面共享
    // workdir，并发调大前先确认该面适配器不会互相踩工作目录）。
    const faceMax = cfg.agents[agent]?.maxConcurrent ?? 1;
    while (store.runsFor(agent) < faceMax && store.runningCount() < (cfg.runtime.maxConcurrentTotal ?? 2)) {
      const key = store.pickBest(agent, priorityOf, Date.now(), agingMs, bestLaneIndex);
      if (!key) break;
      // reserve synchronously so the lane can't pop a second task for this agent
      store.beginRun(key, { agent, dir: null, pid: null, startedAt: Date.now(), reserving: true });
      store.save();
      handle(key, agent)
        .catch((e) => log(`handle(${key}) crashed: ${e.stack || e.message}`))
        .finally(() => {
          if (store.s.runs[key]?.reserving) { delete store.s.runs[key]; store.save(); }
        });
    }
  }
}

// 实时唤醒 小羽 worker（WorkBuddy automation 80a9684a）：把它的 next_run_at 改成 now，
// 宿主调度器扫到后约 1-2 分钟拉起一轮（实测干净空窗 ~97s 认领 / ~145s 完成）。
// 这样 @workbuddy 黑板任务由"小羽本体"执行，而非 headless codex。
// DB 锁竞争用 busy_timeout 兜底；返回是否真的命中那一行（false = 白戳或失败）。
//
// ⚠ 已知坑（2026-09-19 实测）：若这一戳落在 worker 某轮运行「进行中」的窗口里，
// 那轮跑完时宿主会把 next_run_at 重置成「结束时间 + 1 小时」，本戳就白戳了。
// 由 maybeRepoke() 看门狗负责在任务仍未被认领时重复补戳，把戳"跨过"那个重置窗口。
async function pokeWorkbuddyWorker(label) {
  const dbPath = cfg.board?.workbuddyDb;
  const automationId = cfg.board?.workbuddyAutomationId;
  if (!dbPath || !automationId) { log("poke 小羽 worker 跳过：未配置 board.workbuddyDb / workbuddyAutomationId"); return false; }
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA busy_timeout = 5000;");
      const now = Date.now();
      const res = db.prepare("UPDATE automations SET next_run_at = ?, updated_at = ? WHERE id = ?").run(now, now, automationId);
      log(`poked 小羽 worker next_run_at=${now} changes=${res.changes}${res.changes ? "" : " [automationId 未匹配]"}${label ? ` [${label}]` : ""}`);
      return res.changes > 0;
    } finally { db.close(); }
  } catch (e) {
    log(`poke 小羽 worker 失败（可能 DB 被锁）: ${e.message} —— 交给 re-poke 看门狗重试`);
    return false;
  }
}

// --- @workbuddy re-poke 看门狗 ---------------------------------------------
// 只要派给 workbuddy 的任务还没被认领/完结，就周期性把 worker 的 next_run_at 重新
// 戳成 now。目的：抵消上面那个"被运行中 tick 重置"的坑，也让 DB 偶发锁失败可自愈。
// 任务一旦被 claim / done / cancelled 就立刻停止催。
const REPOKE = {
  intervalMs: 20000,   // 多频繁检查一次待催列表
  graceMs: 40000,      // 距上次补戳多久之后再戳（给 worker 启动留出时间）
  maxAttempts: 18,     // 上限，避免无限骚扰（约 12 分钟）
};

async function maybeRepoke() {
  if (existsSync(STOP)) return;                      // STOP 期间不催
  const watch = store.s.repokes;
  if (!watch || Object.keys(watch).length === 0) return;
  const now = Date.now();
  let changed = false;
  for (const [key, w] of Object.entries(watch)) {
    try {
      const card = await board.withBoard(cfg.board, (b) => board.card(b, key));
      if (!card) { delete watch[key]; changed = true; continue; }
      const t = card.task;
      if (t.claimedBy || ["done", "closed", "cancelled"].includes(t.status)) {
        log(`re-poke watch: ${key} 已受理（status=${t.status}, claimedBy=${t.claimedBy ?? "-"}）→ 停止补戳`);
        delete watch[key];
        changed = true;
        continue;
      }
      if (now - w.lastPokeAt < REPOKE.graceMs) continue;
      if (w.attempts >= REPOKE.maxAttempts) {
        log(`re-poke watch: ${key} 已戳 ${w.attempts} 次仍未受理，放弃（等 worker 常规轮询兜底）`);
        delete watch[key];
        changed = true;
        continue;
      }
      const ok = await pokeWorkbuddyWorker(`补戳 #${w.attempts + 1} ${key}`);
      if (ok) {
        w.attempts += 1;
        w.lastPokeAt = now;
        log(`re-poke watch: ${key} 仍 open/unclaimed → 第 ${w.attempts} 次补戳`);
        changed = true;
      }
    } catch (err) {
      log(`re-poke watch: 检查 ${key} 出错: ${err.stack || err.message}`);
    }
  }
  if (changed) store.save();
}

async function handle(key, agent) {
  const state = store.s;
  if (existsSync(STOP)) {
    (state.lanes[agent] ??= []).unshift(key);
    store.save();
    log(`STOP present — ${key} returned to lane`);
    return;
  }
  const card = await board.withBoard(cfg.board, (b) => board.card(b, key));
  if (!card) return log(`skip ${key}: no such task`);
  const task = card.task;
  if (["done", "closed", "cancelled"].includes(task.status)) return log(`skip ${key}: status=${task.status}`);
  if (task.claimedBy && task.claimedBy !== ID) return log(`skip ${key}: claimed by ${task.claimedBy}`);

  const paths = findDispatchFiles([task.title, task.description]);
  const dispatch = gating.readDispatch(paths);

  // 面特定硬门限（2026-09-25 定）：trae 的 bash 是单条常驻 cmd.exe，输出只能按一个 OEM 码页回读，
  // 产出物文件名含非 ASCII 时盘上名字是对的、模型读回却是乱码 ⇒ 误判失败空烧到 max_steps。
  // 命中就改派兜底面，绝不让它静默空转。局限：只认带扩展名的文件名 token。
  const faceCfg = cfg.agents[agent] ?? {};
  // 能力匹配（采纳建议③ 第一步，2026-10-07）：任务书 bridge 块声明 needs（字符串或数组），
  // 各面 agents.<face>.capabilities 声明能力；未声明能力的面视为万能（存量配置零改动）。
  // 派发前校验：面缺能力 → 按 fallbacks 找有能力的可用面改派（与 asciiOnly 门同一形态）。
  const needs = parseNeeds(parseBridgeBlock(task?.description));
  if (needs.length && !faceHasCaps(faceCfg.capabilities, needs)) {
    const cands = (faceCfg.fallbacks ?? []).filter((f) => enabledAgents.includes(f));
    const { face: to, skipped } = await pickCapableFace({
      candidates: cands, needs, agentsCfg: cfg.agents,
      isReachable: (f) => faceReachable(cfg.agents[f]),
    });
    if (!to) {
      log(`refuse ${key}: 需要能力 [${needs.join(",")}]，${agent} 面不具备，候选 ${cands.join(",") || "未配置"} 均不可用（探不通=${skipped.join(",") || "无"}）`);
      await board.withBoard(cfg.board, (b) => board.note(b, ID,
        `[${ID}] ${key} 未执行：需要能力 [${needs.join(",")}] 而 ${agent} 面不具备，候选面 ${cands.join(", ") || "（未配置）"} 均不可用${skipped.length ? `（${skipped.join(", ")} 探活不通或缺能力）` : ""}。请改派有能力的面或修正任务书 needs。`));
      return;
    }
    await board.withBoard(cfg.board, (b) => board.note(b, ID,
      `[${ID}] ${key} 需要能力 [${needs.join(",")}]，${agent} 面不具备 ⇒ 已改派 ${to} 执行${skipped.length ? `（${skipped.join(", ")} 探活不通或缺能力，跳过）` : ""}`));
    log(`cap-route ${key}: ${agent} -> ${to} (needs [${needs.join(",")}])${skipped.length ? ` skipped=[${skipped.join(",")}]` : ""}`);
    agent = to;
  }
  if (faceCfg.asciiOnlyProducts) {
    const bad = nonAsciiProductNames([task.title, task.description, dispatch?.text].filter(Boolean).join("\n"));
    if (bad.length) {
      const cands = (faceCfg.fallbacks ?? []).filter((f) => enabledAgents.includes(f));
      const skipped = [];
      let to = null;
      for (const f of cands) {
        if (await faceReachable(cfg.agents[f])) { to = f; break; }
        skipped.push(f);
      }
      if (!to) {
        log(`refuse ${key}: ${agent} 门限命中，兜底面全不可用（候选=${cands.join(",") || "未配置"}，探不通=${skipped.join(",") || "无"}）`);
        await board.withBoard(cfg.board, (b) => board.note(b, ID,
          `[${ID}] ${key} 未执行：${agent} 面不适合非 ASCII 产出文件名（${bad.join(", ")}），兜底面 ${cands.join(", ") || "（未配置）"} 均不可达${skipped.length ? `（探不通: ${skipped.join(", ")}）` : ""}。请改派可执行的面。`));
        return;
      }
      await board.withBoard(cfg.board, (b) => board.note(b, ID,
        `[${ID}] ${key} 产出文件名含非 ASCII（${bad.join(", ")}）⇒ ${agent} 面会读回乱码并空烧步数，已改派 ${to} 执行${skipped.length ? `（${skipped.join(", ")} 探活不通，跳过）` : ""}`));
      log(`re-route ${key}: ${agent} -> ${to} (non-ASCII product names: ${bad.join(", ")})${skipped.length ? ` skipped=[${skipped.join(",")}]` : ""}`);
      agent = to;
    }
  }

  let decision;
  if (state.approved && state.approved[key]) {
    delete state.approved[key]; // one-shot: human already approved this exact key
    decision = { action: "auto", reason: "人工批准放行", fm: dispatch ? gating.decide(card, dispatch.text).fm : {} };
  } else {
    decision = gating.decide(card, dispatch?.text ?? null);
  }

  // §17 硬档（VERIFY.enforce，默认关）：产出型卡无验收标准 → 升级人工批准。
  // 人工 one-shot 批准（上面分支）优先于本档；开档前先用默认档（未验 note+周报）观察一段时间。
  if (VERIFY.enforce === true && decision.action === "auto"
      && !(task?.acceptance ?? parseBridgeBlock(task?.description)?.acceptance)) {
    decision = { action: "ask", reason: "未带验收标准（verify.enforce 已开）：补 acceptance 或声明 mode=human 后重新派发，或人工放行走自报通道" };
  }

  // gating v2 (2026-10-04)：软命中分流。TIER2 发布/凭据类词（推送/发布/上架/部署/
  // 安装/token/secret/credential…）不再 park，只往板面写一条 note 然后照常派发；
  // TIER1 真险词（rm -rf/drop table/删除/密码/密钥/生产环境…）仍走下面的 ask 分支。
  // 没有这一段的话 action:"soft" 会既不 park 也不留痕，直接静默派发 —— 降级形同虚设。
  if (decision.action === "soft") {
    await board.withBoard(cfg.board, (b) =>
      board.note(b, ID, `[${ID}→${agent}] ${key}: 软命中不拦截（${(decision.softHits ?? []).join(", ")}）——发布/凭据类词属 TIER2，仅留痕后照常派发`));
    log(`soft: ${key} proceeds with note (${(decision.softHits ?? []).join(", ")})`);
    decision = { ...decision, action: "auto" };
  }

  if (decision.action === "ask") {
    state.pending[key] = { agent, at: new Date().toISOString(), reason: decision.reason, dispatch: dispatch?.path ?? null };
    store.save();
    await board.withBoard(cfg.board, (b) => {
      board.message(b, ID, task.createdBy ?? cfg.owner,
        `[${ID}] 任务 ${key} 派给 ${agent}，但按分级策略需人工批准（${decision.reason}）。放行: node bridge-ctl.js approve ${key}；拒绝: ... deny ${key}`);
      board.note(b, ID, `[${ID}→${agent}] ${key}: awaiting approval (${decision.reason})`);
    });
    log(`ask: ${key} parked (${decision.reason})`);
    return;
  }

  if (cfg.runtime.dryRun) {
    log(`DRYRUN: would spawn ${agent} for ${key} (${decision.reason})`);
    state.finished[key] = { at: new Date().toISOString(), result: "dryrun", agent };
    store.save();
    return;
  }

  await execute(key, agent, task, dispatch, decision);
}

async function execute(key, agent, task, dispatch, decision) {
  let taskSessionId = null;
  try {
    const session = await board.withBoard(cfg.board, (b) => board.startSession(b, `task ${key}`, {
      project: task.project ?? null,
      taskKey: key,
      detached: true,
    }));
    taskSessionId = session?.id ?? null;
    if (taskSessionId) {
      store.s.runs[key] = { ...(store.s.runs[key] ?? {}), sessionId: taskSessionId };
      store.save();
      log(`task session started ${key}: ${taskSessionId} project=${task.project ?? "-"}`);
    }
  } catch (e) {
    log(`task session start failed for ${key}: ${e.message} — continue on daemon session`);
  }
  try {
    await executeInSession(key, agent, task, dispatch, decision, taskSessionId);
  } finally {
    if (taskSessionId) {
      await board.withBoard(cfg.board, (b) => board.stopSession(b, taskSessionId), taskSessionId)
        .catch((e) => log(`task session stop failed for ${key}/${taskSessionId}: ${e.message}`));
    }
  }
}

async function executeInSession(key, agent, task, dispatch, decision, taskSessionId = null) {
  const pendingSessionWrites = new Set();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const baseRunDir = join(BASE, "runs", key, ts);
  const agentCfg = cfg.agents[agent];
  const fm = decision.fm ?? {};
  const workdir = fm.cwd || agentCfg.workdir;
  mkdirSync(workdir, { recursive: true });
  const probe = (await import(`./lib/adapters/${agent}.js`)).probeModel?.(agentCfg) ?? {};
  // 分段续跑（#29）：默认 1 段=今天的行为；任务书 front matter 写 segments: 2|3 才切段，封顶 3。
  // 选默认关是因为多一段就是多一笔真钱，谁掏钱谁点。
  const totalSegments = maxSegments(fm);
  const canResume = !!getAdapter(agent).resumeSpec;

  const basePrompt = buildPrompt(key, task, dispatch, agent, totalSegments);

  await board.withBoard(cfg.board, (b) => {
    const r = board.claim(b, ID, key);
    if (r.conflict && r.conflict !== ID) throw new Error(`lost claim race for ${key} to ${r.conflict}`);
    board.progress(b, ID, key, 3);
    // §17 派活验收纪律（2026-10-24）：无验收标准的卡走自报通道——不拦人，但每次都留痕，
    // 让"未验"在板面可见、可统计（digest 周期点名）。mode=human 是显式豁免，不算未验。
    const blk = parseBridgeBlock(task?.description);
    if (VERIFY.enabled !== false && !(task?.acceptance ?? blk?.acceptance)) {
      board.note(b, ID, `[未验通道] ${key} 无验收标准（acceptance 列/bridge 块均未声明），done 将按执行面自报放行。派活方请按宪法 §17 补标准或声明 mode=human。`);
    }
  }, taskSessionId);
  log(`claim+progress(3) ok: ${key}${totalSegments > 1 ? ` segments=${totalSegments}` : ""}`);
  store.s.runs[key] = { agent, dir: baseRunDir, pid: null, startedAt: Date.now(), model: probe.model, segment: 1, segments: totalSegments, sessionId: taskSessionId };
  store.save();

  let prev = null, seg = 1;
  let result = null, ok = false, summary = "", why = null, stopWhy = null, killedBy = null;
  let usage = null, lastRunDir = baseRunDir, latch = null, supplyHit = null, prevSupply = null, recoveredFrom = null, lastHit = null;

  for (;;) {
    // 调用点硬闸（2026-10-02 加，起因是 10-01 的 P0：判据把"成功"写成"可再起一段"，
    // 一段已完成的活被连烧 7 段 / 466,241 token）。判据是纯函数可以写错，段号预算与全局封顶
    // 是两条独立算出来的界 —— 越过任何一条都不再起段，代价是钱的事不靠单点判断。
    if (segmentOverrun({ segment: seg, total: totalSegments })) {
      stopWhy = `段号越界（第 ${seg} 段 > 本卡预算 ${totalSegments} / 全局封顶 ${SEGMENT_CAP}），调用点硬闸拦下`;
      log(`SEGMENT GUARD ${key}: ${stopWhy}`);
      break;
    }
    // 每段一个独立 run 目录（seg1 沿用原路径不破坏既有台账）：
    // 适配器按目录读用量，同目录追加两段会让第二段把第一段的 token 再记一遍。
    const runDir = seg === 1 ? baseRunDir : join(BASE, "runs", key, `${ts}-seg${seg}`);
    mkdirSync(runDir, { recursive: true });
    lastRunDir = runDir;
    const promptFile = join(runDir, "prompt.md");
    writeFileSync(promptFile, prev ? `${basePrompt}\n\n${prev.priming}` : basePrompt, "utf8");
    writeFileSync(join(runDir, "meta.json"), JSON.stringify({
      key, agent, startedAt: ts, workdir, model: probe.model, provider: probe.provider,
      dispatch: dispatch?.path ?? null, gate: decision.reason,
      segment: seg, segments: totalSegments, resumeFrom: prev?.runDir ?? null,
    }, null, 1));
    store.s.runs[key] = { ...store.s.runs[key], dir: runDir, pid: null, segment: seg };
    store.save();

    let lastProgressAt = 0, items = 0;
    result = await runTask({
      agentCfg, adapter: agent, runDir, promptFile, workdir, fm,
      stall: cfg.runtime?.stall,
      resume: prev?.threadId ? { threadId: prev.threadId, segment: seg } : null,
      runId: `${key}@${ts}${seg > 1 ? `#seg${seg}` : ""}`, log,
      onSpawn: (pid) => { if (store.s.runs[key]) { store.s.runs[key].pid = pid; store.save(); log(`spawned pid=${pid} for ${key} seg=${seg}`); emitSpan("gen_ai.agent.dispatch", { task: key, agent, pid, segment: seg }); } },
      onMilestone: (m, st) => {
        if (m === "item") {
          items = st.lastMsgCount;
          const pct = Math.min(90, 5 + Math.floor(items / 3) * 5);
          const now = Date.now();
          if (now - lastProgressAt > 45000) {
            lastProgressAt = now;
            const write = board.withBoard(cfg.board, (b) => board.progress(b, ID, key, pct), taskSessionId)
              .then(() => log(`progress(${pct}) ${key} items=${items}`))
              .catch((e) => log(`progress write failed: ${e.message}`));
            pendingSessionWrites.add(write);
            write.then(() => pendingSessionWrites.delete(write));
          }
        }
      },
    });
    if (store.s.runs[key]) { store.s.runs[key].pid = null; }
    killedBy = store.s.runs[key]?.killedBy ?? null;

    summary = gating.redact(trunc(result.resultText ?? "", 1500));
    // agent 自报 success=false（例：步数耗尽）不能算完成——rc=0 只说明进程没崩。
    // stalled 也要算失败：判停是靠 taskkill 掐的，被掐那一刻子进程常常 rc=0 且已吐过一段话。
    ok = result.exitCode === 0 && !result.killed && !result.stalled && summary.length > 0 && result.agentSuccess !== false;
    why = ok ? null : failureWhy(result, killedBy, agentCfg);

    // 成本采集（#26）：每段各记一行——失败的那段照样烧了 token，混成一行会把段数藏掉。
    usage = await recordUsage({
      agent, agentCfg, runDir, key, ts, result, ok, probe,
      segment: seg, segments: totalSegments, resumeFrom: prev?.runDir ?? null,
    });

    // 供应方判定（#25）：三条同时成立才冻面 —— 失败 + 0 步进展 + 扫到供应方文案。
    const hit = ok ? null : scanRunDir(runDir);
    lastHit = hit;
    supplyHit = hit && (result.items ?? 0) === 0 ? hit : null;
    prevSupply = store.supplyGet(agent);
    if (supplyHit) {
      const streak = (prevSupply?.streak ?? 0) + 1; // 与 supplyLatch 内部同式（这中间没人 release）
      latch = store.supplyLatch(agent, {
        category: supplyHit.category, label: supplyHit.label,
        evidence: supplyHit.line, evidenceFile: supplyHit.file,
        key, to: task.createdBy ?? cfg.owner, runDir, holdMs: holdMsFor(streak),
      });
      emitSpan("gen_ai.agent.breaker", { agent, category: latch.category, streak: latch.streak, holdMs: latch.holdMs, task: key });
      // 熔断到点要有事件把队列叫醒：只靠 reconcile 兜底的话，恢复探针最多晚一个 reconcileMs（真配置 60s）才发。
      setTimeout(() => wake(`supply hold ${agent} 到点`), latch.holdMs + 500).unref?.();
    }
    recoveredFrom = ok ? prevSupply : null;
    if (ok && recoveredFrom) store.supplyRelease(agent);

    stopWhy = shouldStopSegmenting({
      ok, segment: seg, total: totalSegments, killedBy,
      stopFilePresent: existsSync(STOP), supplyLatched: !!supplyHit,
      starved: (result.starve ?? 0) >= STARVE_LIMIT,
    });
    if (stopWhy) break;

    // 走到这里 = 这一段没成、没被人工或供应方叫停、还有段数没用 ⇒ 落检查点，续下一段
    const cp = capture({ agent, workdir, runDir, segment: seg, result, usage, why });
    const willResume = canResume && !!result.threadId;
    const nextSeg = seg + 1;
    prev = {
      runDir, threadId: result.threadId ?? null,
      priming: renderPriming({ segment: nextSeg, total: totalSegments, cp, why, resumed: willResume }),
    };
    log(`segment ${seg}->${nextSeg} for ${key}: why=${why} checkpoint=${cp.file} kind=${cp.kind} resume=${willResume ? prev.threadId.slice(0, 8) : "否(检查点重进)"}`);
    await board.withBoard(cfg.board, (b) => {
      board.progress(b, ID, key, Math.min(85, 5 + seg * 20));
      board.note(b, ID, `[${ID}→${agent}] ${key} 第 ${seg}/${totalSegments} 段未完成（${why}）⇒ 续跑第 ${nextSeg} 段。检查点 ${cp.file}（来源=${cp.kind === "agent" ? "模型自写" : "桥派生"}，工作目录 ${cp.fileCount} 个文件）；工作目录不变 ${workdir}；接${willResume ? `原 thread ${String(result.threadId).slice(0, 8)}` : "新会话（这一面无会话级续跑，靠检查点题面重建状态）"}。`);
    }, taskSessionId);
    seg = nextSeg;
  }

  const segTag = totalSegments > 1 ? ` 段=${seg}/${totalSegments}` : "";
  // 验收判定（验证层 V1，毫秒级纯文件检查）：优先任务卡一等 acceptance 列
  // （2026-10-07 共享包扩展）；未声明时回退任务书 bridge 围栏块，兼容存量任务。
  // 在写板前算完，决定结案走哪条路径——执行者自报不算数。
  const bridgeBlock = parseBridgeBlock(task?.description);
  const acc = task?.acceptance ?? bridgeBlock?.acceptance ?? null;
  const accMode = acc?.mode === "human" ? "human"
    : acc?.mode === "cross" ? "cross" : "auto";
  // human 不跑机械项（直接进 V3 复核）；cross 先跑机械项（有的话），过了才进 V2 复核；
  // auto 或未声明跑机械项，全过即关单。
  let verifyRes = null;
  if (ok && VERIFY.enabled !== false && acc && accMode !== "human") {
    verifyRes = evaluateAcceptance({ acceptance: acc, baseDir: workdir });
  }
  const reviewMode = VERIFY.enabled !== false && (accMode === "human" || accMode === "cross");
  let reviewQueued = false;
  const verifyFailed = !!verifyRes && !verifyRes.pass;
  const verifyInvalid = verifyFailed && verifyRes.checks.some((c) => c.invalid);
  if (verifyFailed) log(`verify FAIL ${key}: ${verifyRes.checks.filter((c) => !c.pass).length}/${verifyRes.checks.length} 项未过${verifyInvalid ? "（含 spec 类错误）" : ""}`);
  // V1.5 judge（采纳建议①）：机械项验形，judge 验质。只对 auto 模式且声明了
  // acceptance 的任务跑（acceptance-only 档控制成本）；judge 只当信号不当闸门——
  // fail 升级 V3 复核、不可用则跳过，都不自动改判。
  let judgeRes = null;
  if (ok && !verifyFailed && !reviewMode && JUDGE.enabled && acc) {
    const judgeAgent = JUDGE.agent ?? "dsh";
    judgeRes = await runJudge({
      judgeAgent,
      agentCfg: cfg.agents?.[judgeAgent] ?? {},
      key, description: task?.description,
      rubric: acc?.judge?.rubric,
      workdir, runDirBase: baseRunDir, log,
    });
    log(`judge V1.5 ${key}: ${judgeRes.verdict}${judgeRes.reason ? ` — ${trunc(judgeRes.reason, 120)}` : ""}`);
  }
  try {
    await board.withBoard(cfg.board, (b) => {
      if (ok && verifyFailed) {
        // —— 验收未通过：不接受 done（验证层 V1）——
        if (verifyInvalid) {
          board.setStatus(b, ID, key, "blocked");
          board.note(b, ID, `[${ID}→${agent}] ${formatVerifyNote({ key, verdict: "FAIL", checks: verifyRes.checks, by: ID })}\n· 验收标准本身有误（spec 类：未知检查类型/缺字段）→ 不罚面、不烧重试；请任务作者修正任务书 bridge 块后 requeue。`);
          board.message(b, ID, task.createdBy ?? cfg.owner, `[${ID}] 任务 ${key} 的验收标准写错了（见 note），任务已落 blocked。修正任务的 acceptance（一等列或任务书 bridge 块）后：node bridge-ctl.js requeue ${key} ${agent}。`);
          log(`verify spec-invalid ${key}: parked for author fix`);
        } else {
          const max = Number(bridgeBlock?.retry?.max ?? task?.payload?.retry?.max ?? RETRY.max ?? 2);
          const res = applyVerifyFail({ b, io: board, store, ID, owner: cfg.owner, key, agent, task, v: verifyRes, maxAttempts: max, baseMs: RETRY.baseMs ?? 1800000, maxDelayMs: RETRY.maxMs ?? 14400000, holdBase: HOLD_BASE, holdMax: HOLD_MAX, now: Date.now() });
          emitSpan("gen_ai.agent.verify", { task: key, agent, level: "V1", verdict: "fail", outcome: res.outcome, attempts: res.attempts ?? null });
          log(`verify fail handled ${key}: ${res.outcome}${res.outcome === "retry-scheduled" ? ` attempt ${res.attempts}/${max} in ${left(res.delayMs)}` : ` streak=${res.streak}`}`);
        }
      } else if (ok && reviewMode) {
        // —— V2/V3：机械项已过（或未声明）但不自动关单，进复核队列（验证层 Part B）——
        const reviewer = acc?.reviewer ?? cfg.owner;
        const v1Note = verifyRes ? `（V1 机械项已过 ${verifyRes.checks.filter((c) => c.pass).length}/${verifyRes.checks.length}）` : "";
        const res = queueReview({ b, io: board, store, ID, key, agent, mode: accMode, reviewer, runDir: lastRunDir, v1Note });
        emitSpan("gen_ai.agent.review", { task: key, agent, mode: accMode, level: res.level, reviewer: res.reviewer, verdict: "queued" });
        if (verifyRes?.pass) board.verify?.(b, ID, key, "pass", { level: "V1", summary: `verify PASS ${key} (V1, pre-${res.level})`, checks: verifyRes.checks });
        reviewQueued = true;
        log(`review queued ${key} (${res.level}, reviewer=${res.reviewer})`);
      } else if (ok && judgeRes?.verdict === "fail") {
        // —— V1.5 judge 存疑：升级人工复核（V3），复核人才是裁决者（采纳建议①）——
        const reviewer = acc?.reviewer ?? cfg.owner;
        const res = queueReview({ b, io: board, store, ID, key, agent, mode: "human", reviewer, runDir: lastRunDir, v1Note: `（V1 机械项已过${verifyRes ? ` ${verifyRes.checks.filter((c) => c.pass).length}/${verifyRes.checks.length}` : ""}；V1.5 judge 存疑：${trunc(judgeRes.reason, 160)}）` });
        board.verify?.(b, ID, key, "fail", { level: "V1.5", summary: `verify FAIL ${key} (V1.5 judge) — ${trunc(judgeRes.reason, 120)}` });
        emitSpan("gen_ai.agent.verify", { task: key, agent, level: "V1.5", verdict: "fail", judgeModel: judgeRes.model ?? null });
        emitSpan("gen_ai.agent.review", { task: key, agent, mode: "human", level: "V3", reviewer: res.reviewer, verdict: "queued", reason: "V1.5 judge fail" });
        reviewQueued = true;
        log(`judge upgraded ${key} → V3 review (${res.reviewer})`);
      } else if (ok) {
        if (verifyRes) {
          applyVerifyPass({ b, io: board, ID, key, v: verifyRes });
          emitSpan("gen_ai.agent.verify", { task: key, agent, level: "V1", verdict: "pass", checks: verifyRes.checks.length });
          log(`verify PASS ${key} (${verifyRes.checks.length} checks)`);
        }
        if (judgeRes?.verdict === "pass") board.verify?.(b, ID, key, "pass", { level: "V1.5", summary: `verify PASS ${key} (V1.5 judge)` });
        board.progress(b, ID, key, 100);
        board.done(b, ID, key);
        board.note(b, ID, `[${ID}→${agent}] ${key} 完成（headless ${agent} exec, model=${result.model ?? probe.model ?? "?"}${result.threadId ? ", thread=" + result.threadId.slice(0, 8) : ""}, log=${lastRunDir}${segTag}）:\n${summary}`);
        board.message(b, ID, agent, `[${ID}] 任务 ${key} 已由你无头完成，结果：\n${trunc(summary, 600)}\n日志: ${lastRunDir}`);
        if (recoveredFrom) {
          // 熔断期间队列里可能还压着卡，恢复要立刻说出来，免得别人以为还在冻。
          const queued = (store.s.lanes?.[agent] ?? []).length;
          board.note(b, ID, `[${ID}→${agent}] 供应方恢复：${key} 正常跑完（items=${result.items}），解除 ${recoveredFrom.category} 熔断（此前连续失败 ${recoveredFrom.streak} 次）${queued ? `，队列还有 ${queued} 张待派` : ""}`);
          if (OWNER_SUPPLY_NOTIFY) board.message(b, ID, recoveredFrom.to ?? cfg.owner, `[${ID}] ${agent} 面的供应方已恢复（${recoveredFrom.category} 熔断解除），被熔断压住的队列会继续派发。`);
          else log(`supply recovered ${agent}: ${recoveredFrom.category} 熔断解除（owner 提醒已关闭）`);
        }
      } else {
        // 失败也要结案：板上没有 failed/cancelled 状态词，一律落 blocked，
        // 四档死因（人工掐死/超时被杀/自报 success=false/带 rc）写进下面的 note。
        board.setStatus(b, ID, key, "blocked");
        let extra = "";
        if (latch) {
          // 打扰 owner 只在该面「刚出事」或「毛病换了类」时；同场故障的每次探针失败只进日志。
          const first = latch.streak === 1 || (prevSupply?.category ?? null) !== latch.category;
          extra = `\n· 供应方熔断：${supplyReason(supplyHit)}，${agent} 面暂停派发 ${hold(latch.holdMs)}（第 ${latch.streak} 次连续失败，退避 ${hold(HOLD_BASE)}→${hold(HOLD_MAX)} 封顶；到期自动放一张探针过去）。证据 ${supplyHit.file}：「${trunc(supplyHit.line ?? "", 240)}」`;
          if (first) {
            if (OWNER_SUPPLY_NOTIFY) {
              board.message(b, ID, cfg.owner, `[${ID}] ${agent} 面的供应方出问题了（不是任务本身）：${supplyReason(supplyHit)}。本次任务 ${key} 已落 blocked，该面已熔断 ${hold(latch.holdMs)}、期间不再派卡（队列保留）。证据：${supplyHit.file}：「${trunc(supplyHit.line ?? "", 240)}」\n日志: ${lastRunDir}`);
            } else {
              log(`supply hold ${agent}: streak=${latch.streak}（首场故障，owner 提醒已关闭：${supplyReason(supplyHit)}）`);
            }
          } else {
            log(`supply hold ${agent}: streak=${latch.streak}（同场故障，不再打扰 owner）`);
          }
          // 余额/额度耗尽（billing）：卡不会自己恢复，转成公开待认领任务，别让它僵在 blocked 等人。
          // 只对 billing（rate 会自愈、auth 要换 key，都不该转派）；只转一次（幂等）。
          const conv = convertBillingTask({
            setStatus: (k, s) => board.setStatus(b, ID, k, s),
            defineTask: (k, o) => board.defineTask(b, ID, k, o),
            note: (t) => board.note(b, ID, `[${ID}] ${t}`),
          }, { key, agent, task, hit: supplyHit, runDir: lastRunDir, converted: billingConverted, enabled: BILLING_CONVERT_ON });
          if (conv.converted) {
            extra += `\n· 已转为公开待认领（余额断供不会自愈）—— 见卡面「供应方断供 · 公开待认领」段与广播 note。`;
            log(`billing-convert ${key}: ${agent} 余额断供 → 公开待认领`);
            // "只报一次"纪律：该面首次断供时私信 owner 一句人话。
            if (first) {
              board.message(b, ID, cfg.owner, `[${ID}] ${billingOwnerNotice({ agent, hit: supplyHit, key, runDir: lastRunDir })}`);
            }
          } else if (conv.reason === "already-converted") {
            extra += `\n· （此卡早已转公开待认领，本次不重复广播）`;
          }
        } else if (lastHit) {
          // 只记录不熔断：文案在、但这一步确实往前走了，说明多半是 agent 引用的内容而非 API 回的话。
          extra = `\n· 扫到供应方文案但本次有进展（items=${result.items}）⇒ 只记录不熔断。命中 ${lastHit.file}：「${trunc(lastHit.line, 240)}」`;
        }
        if (stopWhy && seg > 1) extra += `\n· 分段续跑：共跑 ${seg}/${totalSegments} 段仍未收敛（停手原因：${stopWhy}）；各段检查点在 ${dirname(lastRunDir)}\\${ts}-seg* 下，要人工拆题再派。`;
        board.note(b, ID, `[${ID}→${agent}] ${key} FAILED ${why}${totalSegments > 1 ? `（第 ${seg}/${totalSegments} 段）` : ""} log=${lastRunDir}${extra}`);
        if (latch) {
          // 卡级照报（谁的卡谁知道自己这张被挡了），故障级只在开场/换类时报 owner —— 免得刷屏。
          board.message(b, ID, task.createdBy ?? cfg.owner,
            `[${ID}] 任务 ${key} 落 blocked：不是任务本身的问题，是 ${agent} 面的供应方${supplyReason(supplyHit)}。该面已熔断 ${hold(latch.holdMs)}，到期自动放探针；要立刻重试: node bridge-ctl.js supply-clear ${agent} && node bridge-ctl.js requeue ${key} ${agent}。日志: ${lastRunDir}`);
        } else {
          board.message(b, ID, task.createdBy ?? cfg.owner, `[${ID}] 任务 ${key} 执行失败（${why}），日志: ${lastRunDir}${summary ? `\n它自报的收尾：\n${trunc(summary, 600)}` : ""}`);
        }
      }
    }, taskSessionId);
  } catch (e) {
    log(`write-back failed for ${key}: ${e.message}`);
  }
  store.save();
  store.endRun(key, ok ? (verifyFailed ? "verify-failed" : reviewQueued ? "review-pending" : "done") : `failed rc=${result.exitCode}`);
  // 自动重派（调度层 C.3）：瞬态类失败（自报失败/rc/stall/timeout）按退避自动 requeue；
  // terminal 类（人工掐、供应方熔断、spawn 失败）不自动重试。任务书 payload.retry.max 可覆盖次数。
  // 验收失败（verifyFailed 且非 spec 类）：重试台账由 applyVerifyFail 在写板回调里接管，这里不再动。
  if (!ok) {
    const attempts = store.s.retries?.[key]?.n ?? 0;
    const max = Number(task?.payload?.retry?.max ?? RETRY.max ?? 2);
    const d = retryDecision({ why, latch, killedBy, result, attempts, maxAttempts: max, baseMs: RETRY.baseMs ?? 1800000, maxDelayMs: RETRY.maxMs ?? 14400000 });
    if (d.retry) {
      (store.s.retries ??= {})[key] = { n: d.attempt, dueAt: Date.now() + d.delayMs, agent, why, lastAt: Date.now() };
      log(`auto-retry scheduled ${key}: attempt ${d.attempt}/${max} in ${left(d.delayMs)}`);
      emitSpan("gen_ai.agent.retry", { task: key, agent, attempt: d.attempt, delayMs: d.delayMs, why });
      await board.withBoard(cfg.board, (b) =>
        board.note(b, ID, `[${ID}→${agent}] ${key} 将自动重派（第 ${d.attempt}/${max} 次，${left(d.delayMs)} 后；上次失败：${why}）`), taskSessionId)
        .catch((e) => log(`retry note failed for ${key}: ${e.message}`));
    } else {
      delete store.s.retries?.[key];
      log(`no auto-retry for ${key}: ${d.reason}`);
    }
  } else if (!verifyFailed || verifyInvalid) {
    // 真成功（或 spec 类验收错误打回作者）时清重试账；work 类验收失败的重试账在
    // applyVerifyFail 里已写好，这里必须别碰。
    delete store.s.retries?.[key];
  }
  store.save();
  if (pendingSessionWrites.size) await Promise.all([...pendingSessionWrites]);
  log(`finished ${key}: ${ok ? "done" : "FAILED " + why}${result.threadId ? " thread=" + result.threadId.slice(0, 8) : ""}${segTag}`);
  // run 结束本身就是一条调度事件：车道刚腾出来、结案已落盘、重试台账已结算 ⇒ 立刻叫醒一次。
  // 不接这一下，下一张卡只能等 reconcile 兜底（真配置 60s），每张卡之间白等一轮。
  // execute 是被 tick await 着的，此时 ticking=true ⇒ wake() 走再入保护置 again，
  // 本轮 tick 收尾后自动补一次 wake("re-run")——这正是「不丢唤醒」要的语义，不会自激。
  log(`run-end wake ${key}`);
  wake(`run-end ${key}`);
}

/** 死因分档（原来内联在结案块里，分段后循环也要用同一个判据，抽出共用）。 */
function failureWhy(result, killedBy, agentCfg) {
  return result.spawnError
    ?? (killedBy === "manual" ? "人工掐死（bridge-ctl kill）"
      : result.stalled ? `无进展被掐（stall=${agentCfg.stallMs ?? cfg.runtime?.stall?.ms ?? 600000}ms 内没有新 milestone，items=${result.items}）`
        : result.killed ? "超时被杀（timeoutMs）"
          : (result.starve ?? 0) >= STARVE_LIMIT
            ? `输出预算饿死（连续 ${result.starve} 次 finish_reason=length 且 content 空且无 tool_calls，累计 ${result.starvedTotal ?? result.starve} 次）——面级 max_tokens 不足，抬预算或关思考，重派/续跑都只会再烧一遍`
            : result.agentSuccess === false ? "agent 自报 success=false"
            : "rc=" + result.exitCode);
}

/**
 * 成本采集（#26）：把这轮的权威用量追加到 usage.jsonl。
 * 铁律——读不到就记 missing，绝不补 0：账上的 0 会被读成「这一面没花钱」，
 * 而预算校验恰恰是靠这个数决定还要不要再往这面派卡。
 * 采集失败绝不能拖垮结案，所以整段自己吞错。
 */
async function recordUsage({ agent, agentCfg, runDir, key, ts, result, ok, probe, segment = 1, segments = 1, resumeFrom = null }) {
  let entry;
  try {
    const mod = await import(`./lib/adapters/${agent}.js`);
    entry = normalizeUsage(agent, mod.readUsage ? mod.readUsage({ runDir, agentCfg }) : null);
  } catch (e) {
    entry = missingUsage(agent, `readUsage 抛错：${e.message}`);
  }
  Object.assign(entry, {
    ts: new Date().toISOString(), key, runId: `${key}@${ts}${segment > 1 ? `#seg${segment}` : ""}`, runDir,
    outcome: ok ? "done" : "failed", exitCode: result.exitCode ?? null,
    killed: !!result.killed, stalled: !!result.stalled,
    // 分段续跑（#29）：一行 = 一段。不带段号的话，两张 2 段的卡在账上看起来像两次独立派发，
    // 成本对不上「这张卡实际跑了几段」。
    segment, segments, resumeFrom,
    model: result.model ?? probe?.model ?? null,
    provider: result.provider ?? probe?.provider ?? null,
  });
  try {
    appendUsage(USAGEF, entry);
  } catch (e) {
    log(`usage append failed: ${e.message}`);
  }
  log(entry.missing
    ? `usage MISSING ${key}/${agent}：${entry.reason}（不记 0）`
    : `usage ${key}/${agent} steps=${entry.steps ?? "?"}${entry.overflow ? "(达上限)" : ""} prompt=${entry.prompt ?? "?"} completion=${entry.completion ?? "?"} total=${entry.total ?? "?"}${entry.costUsd != null ? ` cost=$${entry.costUsd}` : ""}`);
  return entry;
}

function buildPrompt(key, task, dispatch, agent, totalSegments = 1) {
  return [
    `你是 ${agent}，正被 agent-bridge 无头调起，执行黑板任务 ${key}（#${task.number ?? "?"}）。`,
    `标题: ${task.title ?? key}`,
    task.description ? `描述: ${task.description}` : null,
    dispatch ? `任务书文件: ${dispatch.path}` : null,
    dispatch ? ["", "===== 任务书全文 =====", trunc(dispatch.text, 200000)].join("\n") : null,
    "",
    "要求：",
    "1) 完成该任务；产物留在工作目录内。",
    "2) 不要读写黑板（回报由 bridge 统一完成），不要再分派任务给任何 agent。",
    "3) 最后一条回复用中文简明汇报：做了什么 / 改了哪些文件 / 如何验证 / 未尽事项。",
    // 只在会分段时加：不写 segments 的卡保持今天的题面，一处字节差异都不留。
    totalSegments > 1 ? `4) 这一轮可能被步数或时间上限打断（任务分 ${totalSegments} 段跑）。若你预感到这一轮做不完，先在工作目录根部写 CHECKPOINT.md：已完成 / 现存产物文件 / 下一步（三步以内、可直接执行）。做完了就不用写。` : null,
  ].filter((s) => s !== null).join("\n");
}
const trunc = (s, n) => (s.length > n ? s.slice(0, n) + "\n…[截断]" : s);

// ---- wake serialization ----
let ticking = false, again = false;
async function wake(why) {
  if (ticking) { again = true; return; }
  ticking = true;
  t0 = process.hrtime.bigint();
  try {
    await tick(why);
  } catch (e) {
    log(`tick(${why}) error: ${e.stack || e.message}`);
  } finally {
    ticking = false;
    if (again) { again = false; wake("re-run"); }
  }
}

// Windows 不给孤儿进程重新认父：进程表里 ParentProcessId 仍是早已死去的老守护。
// 收割前用它验明正身——pid 会被复用，盲杀树可能杀掉无关进程。
// （进程观察原语在 lib/platform.js：win32 走排水版 PowerShell CIM，POSIX 走 ps。）
async function isOurChild(pid, parentPid) {
  if (!Number.isInteger(parentPid)) return false;
  const info = await getProcessInfo(pid);
  return info.parentPid === parentPid;
}

async function main() {
  // 单实例锁 = control 端口本身。bind 必须排在任何板上写入与定时器之前：
  // 旧顺序下抢输的实例已经写了一条 session-start、也 armed 了整套调度器，
  // 10-03 16:07:48/49/50 三实例并发各自抢占 state.json，rename 撞 EPERM。
  try {
    await createControlServer(cfg, { store, wake, log, BASE });
  } catch (e) {
    log(`refused to start: control port unavailable (${e.code ?? e.message}) — another daemon holds it, exiting before any board write`);
    // rc=3 = "我抢输了"，与 rc=1（崩溃）分开：run_daemon.bat 见 3 就自杀退场，
    // 否则每个抢输的循环会永远 10s 一轮地重烧一次几分钟的 node 冷启动。
    process.exit(3);
  }
  // single-instance lock: the bat restart-loop and the guard task may both
  // try to (re)start us; a second daemon would double-heartbeat and fight over runs.
  let prevPid = null;
  try {
    const prev = JSON.parse(readFileSync(join(BASE, "state.json"), "utf8"));
    prevPid = Number.isInteger(prev.pid) ? prev.pid : null;
    const pid = prev.pid;
      if (Number.isInteger(pid) && pid !== process.pid) {
        let ours = false;
        try { process.kill(pid, 0); ours = true; } catch { }
        if (ours) {
          // pid alive may be a recycled pid after reboot — confirm it really is this daemon
          const info = await getProcessInfo(pid);
          ours = !!info.commandLine && info.commandLine.includes("daemon.js");
        }
        if (ours) { console.log(`another daemon alive pid=${pid} — exiting`); process.exit(0); }
      }
  } catch { }
  log(`daemon start pid=${process.pid} dryRun=${cfg.runtime.dryRun} agents=[${enabledAgents.join(",")}] board=${cfg.board.dir}`);
  await board.init(cfg.board.package);
  store.s.pid = process.pid;
  store.s.startedAt = new Date().toISOString();
  // 必须立刻落盘：单实例锁与 guard 都以 state.json 的 pid 为唯一判据，
  // 晚一拍会让重启窗口里再起来一个守护，两条 run_daemon 循环并存。
  store.save();

  // reap runs left behind by a previous daemon death
  for (const [key, r] of Object.entries({ ...store.s.runs })) {
    let alive = false;
    try { if (r.pid) process.kill(r.pid, 0); alive = !!r.pid; } catch { alive = false; }
    // 老守护一死就没人再读它的 stdout、也没人结算。留着它跑=卡已判死但 agent
    // 还在改工作目录；重派时两个 agent 同写一处。只在能证明它确实是本守护的子进程
    // 时才掐（pid 重启后会被复用，盲 taskkill 可能杀掉无关系统进程）。
    let killed = false;
    if (alive && await isOurChild(r.pid, prevPid)) {
      killTree(r.pid, { log });
      killed = true;
      log(`killed orphan child pid=${r.pid} of ${key}`);
    }
    store.endRun(key, "interrupted-by-daemon-restart");
    // 必须落盘：runs 不清掉，下次重启会再收割一次——那时这个 pid 可能已被复用。
    store.save();
    // 守护重启打断不是任务的错（瞬态类）：接调度层自动重派（退避+上限防崩溃循环）；
    // 重试用尽仍落 blocked 转人工。台账格式与 maybeRetry 扫描一致。
    const nowMs = Date.now();
    const rd = retryDecision({ why: "daemon-restart", attempts: store.s.retries?.[key]?.n ?? 0, maxAttempts: RETRY.max ?? 2, baseMs: RETRY.baseMs ?? 1800000, maxDelayMs: RETRY.maxMs ?? 14400000 });
    await board.withBoard(cfg.board, (b) => {
      const t = board.card(b, key)?.task;
      // 上一任守护可能已经结过案（跑完/判死）却没来得及清 runs。
      const unsettled = t && t.status !== "done" && t.status !== "blocked";
      const why = unsettled ? `FAILED 守护重启，运行被中断（子进程 ${r.pid} ${killed ? "已掐" : alive ? "仍在跑，需人工 kill" : "已退出"}）` : "守护重启，运行被中断";
      const willRetry = unsettled && rd.retry;
      if (willRetry) {
        store.s.retries ??= {};
        store.s.retries[key] = { n: rd.attempt, dueAt: nowMs + rd.delayMs, agent: r.agent, why: "daemon-restart", lastAt: nowMs };
        store.save();
      }
      if (unsettled) board.setStatus(b, ID, key, willRetry ? "open" : "blocked");
      board.note(b, ID, `[${ID}→${r.agent}] ${key} ${why}${willRetry ? `；${left(rd.delayMs)} 后自动重派（第 ${rd.attempt}/${RETRY.max ?? 2} 次）` : ""} log=${r.dir}`);
      if (unsettled) board.message(b, ID, t.createdBy ?? cfg.owner,
        willRetry
          ? `[${ID}] 任务 ${key} 因守护重启中断（非任务自身问题），${left(rd.delayMs)} 后自动重派（第 ${rd.attempt}/${RETRY.max ?? 2} 次）。日志: ${r.dir}`
          : `[${ID}] 任务 ${key} 因守护重启中断，已落 blocked；重派: node bridge-ctl.js requeue ${key} ${r.agent ?? ""}。日志: ${r.dir}`);
    }).catch((e) => log(`orphan write-back failed for ${key}: ${e.message}`));
    if (r.sessionId) {
      await board.withBoard(cfg.board, (b) => board.stopSession(b, r.sessionId), r.sessionId)
        .catch((e) => log(`orphan session stop failed for ${key}/${r.sessionId}: ${e.message}`));
    }
    log(`reaped orphan run ${key} (child alive=${alive} killed=${killed})`);
    emitSpan("gen_ai.agent.reap", { task: key, killed, willRetry: !!(rd && rd.retry) });
  }

  await board.withBoard(cfg.board, (b) => board.startSession(b, "agent-bridge daemon")).catch((e) => log(`session start failed: ${e.message}`));
  setInterval(() => {
    board.withBoard(cfg.board, (b) => {
      board.heartbeat(b); // daemon session
      for (const r of Object.values(store.s.runs)) {
        if (r.sessionId) board.heartbeat(b, r.sessionId);
      }
    }).catch((e) => log(`heartbeat failed: ${e.message}`));
  }, cfg.runtime.heartbeatMs ?? 60000);
  // @workbuddy re-poke 看门狗：抵消 worker 运行窗口对本戳的覆盖
  setInterval(() => {
    maybeRepoke().catch((e) => log(`re-poke tick error: ${e.stack || e.message}`));
  }, REPOKE.intervalMs);
  // 认领租约巡检：TTL 是小时级的事，10 分钟一扫足够；漏一拍由下一拍兜住
  setInterval(() => {
    maybeLease().catch((e) => log(`lease tick error: ${e.stack || e.message}`));
  }, LEASE.sweepMs ?? 600000);
  // 自动重派到期扫描（调度层 C.3）
  setInterval(() => {
    maybeRetry().catch((e) => log(`retry sweep error: ${e.stack || e.message}`));
  }, RETRY.sweepMs ?? 60000);
  // 逾期标红（C.4）与 owner 摘要（C.6）
  setInterval(() => {
    maybeSla().catch((e) => log(`sla tick error: ${e.stack || e.message}`));
  }, SLA.sweepMs ?? 300000);
  setInterval(() => {
    maybeDigest().catch((e) => log(`digest tick error: ${e.stack || e.message}`));
  }, DIGEST.tickMs ?? 600000);
  log(`sla+digest armed (sla sweep ${SLA.sweepMs ?? 300000}ms; digest every ${DIGEST.everyMs ?? 21600000}ms)`);
  log(`scheduler armed (retry max=${RETRY.max ?? 2} base=${RETRY.baseMs ?? 1800000}ms cap=${RETRY.maxMs ?? 14400000}ms sweep=${RETRY.sweepMs ?? 60000}ms; priority aging=${PRIORITY.agingMs ?? 7200000}ms)`);
  if (VERIFY.enabled !== false) log("verify V1 armed (acceptance: task column first, bridge-block fallback)");
  if (JUDGE.enabled) log(`judge V1.5 armed (agent=${JUDGE.agent ?? "dsh"}, mode=${JUDGE.mode ?? "acceptance-only"}; fail→V3, unavailable→skip)`);
  // 冻结自愈看门狗（2026-10-02 事故缺口④）：worker 在独立线程里盯心跳，
  // 主线程事件循环冻结（任何 in-process 定时器都停摆）时由 worker SIGKILL 自杀，
  // run_daemon.bat 循环接手重启。graceMs 必须盖过启动期（收割孤儿 run 会静默跑几分钟）。
  // 2026-10-06 补 10-05 误杀的两道闸（决策核 lib/watchdog-core.mjs）：
  //   闸一 worker 自测自己那一拍，迟到即「整进程被挂起过」→ 静默读数不可解释，清零不 I/O；
  //   闸二 两振后先探控制口，端口能答（哪怕慢）= 主循环还活着 → 弃权。
  // 所以这里必须把 port/tokenPath 传下去：不传的话 probePort() 只能保守弃权，
  // 冻结自愈会静默退化成「永远不杀」——比误杀更糟，因为它不报警。
  const WATCHDOG = cfg.runtime?.watchdog ?? {};
  if (WATCHDOG.enabled !== false) {
    try {
      const hb = WATCHDOG.heartbeatMs ?? 5000;
      const w = new Worker(new URL("./lib/watchdog-worker.mjs", import.meta.url), {
        workerData: {
          pid: process.pid,
          staleMs: WATCHDOG.staleMs ?? 90000,
          graceMs: WATCHDOG.graceMs ?? 120000,
          checkMs: WATCHDOG.checkMs ?? 10000,
          logFile: LOGF,
          port: cfg.http?.port ?? 8790,
          tokenPath: join(BASE, "control.token"),
          probeBudgetMs: WATCHDOG.probeBudgetMs ?? 120000,   // 与 watchdog-worker 的同名默认保持一致（10-05 实测饥饿守护 36.989433s 才答 /ps）
          probeAttemptMs: WATCHDOG.probeAttemptMs ?? 8000,
        },
      });
      w.unref();
      setInterval(() => { try { w.postMessage("hb"); } catch { /* worker gone */ } }, hb).unref();
      const budget = WATCHDOG.probeBudgetMs ?? 120000;
      log(`watchdog armed (heartbeat ${hb}ms, stale ${WATCHDOG.staleMs ?? 90000}ms, grace ${WATCHDOG.graceMs ?? 120000}ms, port ${cfg.http?.port ?? 8790} probe budget ${budget}ms)`);
    } catch (e) { log(`watchdog start failed (running without freeze self-heal): ${e.message}`); }
  }
  createNotifier(cfg.board.dir, cfg.runtime, wake);
  wake("boot");
}

process.on("uncaughtException", (e) => log(`UNCAUGHT: ${e.stack || e.message}`));
process.on("unhandledRejection", (e) => log(`UNHANDLED: ${e?.stack || e}`));
main().catch((e) => { log(`fatal: ${e.stack || e.message}`); process.exit(1); });
