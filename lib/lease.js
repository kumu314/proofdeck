// 认领租约（claim lease）——"状态在库里"形态的 K8s Lease / etcd 式租约。
// 问题：claim 免费且永久（Board API 没有 TTL），谁忘了收尾谁就把卡占死——
// 实测 codex 把 uumit-contract-matrix 持有 147h 无任何事件（2026-10-02）；
// 桥自己也有裸窗口：execute() 的 write-back 失败路径 runs 已被 endRun 清掉、
// 板面 claim 残留（daemon.js 结案 catch），守护重启 reap 结案用 setStatus(blocked)
// 也不释放 claim。先例调研见 docs/design/2026-10-02-调研-*.md §一。
//
// 形态选择：黑板没有 broker、没有"重投"原语，所以抄 K8s/etcd（读侧检测过期），
// 不抄 SQS（broker 重投）。心跳用两路现成信号，零新增写路径：
//   ① 任务级 task.updatedAt——claim/progress/setStatus 都会戳它；
//   ② 持有者级 activeSessions——heartbeat 各端已在打（桥自己每 60s 一跳）。
// 最小权力（fencing 思路）：Board.release 本就只允许持有者身份调用——
//   桥只自动释放【自己身份】的过期 claim；他人的过期 claim 只报告、绝不代释放：
//   桥分不清"对方死了"和"对方在做慢活没写进度"，而我们的任务没有 SQS 那样的
//   幂等前提，接管必须保守。
// 不自动重投（v1）：释放落回 open 后交给既有 assign/re-poke/人工流程。
//   10-01 一晚 54 连戳的教训：这套系统里"自动化再触发"比"自动化停手"危险。
import * as board from "./board.js";

const HOUR = 3600000;
const DONE_LIKE = new Set(["done", "closed", "cancelled"]);

/**
 * 一轮租约巡检（读侧检测；apply=false 时纯只读）。
 * @returns {{ownStale:Array, otherStale:Array, aliveOwn:Array, released:Array}}
 *   ownStale   自己身份持有、超 TTL、且不在 busyKeys 的 claim（apply 时被释放）
 *   otherStale 他人持有、超 TTL 且持有者无 active session 的 claim（只报告）
 *   aliveOwn   自己持有且在本守护 runs 里的键（在跑，不动）
 *   released   apply 后实际释放成功的键
 */
export async function leaseSweep({
  boardCfg, identity, ttlMs, sessionMs = 600000,
  busyKeys = new Set(), apply = false, log = () => {}, now = Date.now(),
}) {
  return board.withBoard(boardCfg, (b) => {
    const activeAgents = new Set(
      b.activeSessions(sessionMs).map((s) => s.agentName).filter(Boolean)
    );
    const ownStale = [], otherStale = [], aliveOwn = [];
    for (const c of b.listTaskCards()) {
      const t = c.task;
      if (!t?.claimedBy || DONE_LIKE.has(t.status)) continue;
      const rawAge = now - Date.parse(t.updatedAt ?? "");
      const rec = { key: t.key, status: t.status, ageMs: Number.isFinite(rawAge) ? rawAge : 0, progress: t.progress };
      if (t.claimedBy === identity) {
        // busy 豁免必须先于 TTL 判定：刚认领的卡 updatedAt 很新，本来也到不了 TTL，
        // 但豁免是"在跑"的语义声明，与年龄无关（也保住 aliveOwn 报告的完整性）。
        if (busyKeys.has(t.key)) { aliveOwn.push(rec); continue; }
        if (!Number.isFinite(rawAge) || rawAge <= ttlMs) continue;
        ownStale.push(rec);
      } else {
        if (!Number.isFinite(rawAge) || rawAge <= ttlMs) continue;
        if (!activeAgents.has(t.claimedBy)) otherStale.push({ ...rec, holder: t.claimedBy });
      }
    }
    const released = [];
    if (apply) {
      for (const s of ownStale) {
        try {
          b.release(identity, s.key);
          b.note(identity, `[${identity}] 租约到期自动释放：${s.key}（claimedBy=${identity}，最后活动 ${(s.ageMs / HOUR).toFixed(1)}h 前，status=${s.status}，progress=${s.progress}%）。桥只释放自己持有的 claim；若这张卡该继续做，请重新 claim。产物与 run 目录未被触碰，以磁盘为准。`);
          released.push(s.key);
          log(`lease released ${s.key}（own claim 超期 ${(s.ageMs / HOUR).toFixed(1)}h，status=${s.status}）`);
        } catch (e) {
          log(`lease release failed ${s.key}: ${e.message}`);
        }
      }
    }
    ownStale.sort((a, x) => x.ageMs - a.ageMs);
    otherStale.sort((a, x) => x.ageMs - a.ageMs);
    return { ownStale, otherStale, aliveOwn, released };
  });
}

const age = (ms) => (ms >= HOUR ? `${(ms / HOUR).toFixed(1)}h` : `${Math.round(ms / 60000)}min`);

/** 人读报告（bridge-ctl leases / 手动巡检共用）。纯只读，不写板。 */
export async function leaseReport({ boardCfg, identity, ttlMs, sessionMs, busyKeys, log }) {
  const r = await leaseSweep({ boardCfg, identity, ttlMs, sessionMs, busyKeys, apply: false, log });
  const lines = [];
  lines.push(`租约巡检（TTL=${age(ttlMs)}，判定=updatedAt 超时${identity === null ? "" : `，释放权仅限 ${identity} 自己的 claim`}）：`);
  if (!r.ownStale.length && !r.otherStale.length) {
    lines.push("  无过期 claim。");
  }
  for (const s of r.ownStale) {
    lines.push(`  [own-stale] ${s.key}  持有=${identity}  超 ${age(s.ageMs)}  status=${s.status}  progress=${s.progress}%  → apply 时将释放`);
  }
  for (const s of r.otherStale) {
    lines.push(`  [other-stale] ${s.key}  持有=${s.holder}  超 ${age(s.ageMs)}  status=${s.status}  progress=${s.progress}%  → 只报告不代释放（最小权力）`);
  }
  if (r.aliveOwn.length) lines.push(`  在跑（本守护 runs，豁免）：${r.aliveOwn.join(", ")}`);
  return { text: lines.join("\n"), ...r };
}
