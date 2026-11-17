// replay（2026-10-07 采纳建议④）：把 append-only 哈希链当事件源，折叠出"任意 seq
// 时刻的任务卡状态"。只读、本地、不依赖守护活着——排查纠纷/还原现场从翻日志变一条命令。
// 这是 durable execution lite 的第一步（只读时间旅行）；重入式恢复另行设计评审。
//
// 折叠规则（与 Board 的写路径一一对应）：
//   kind=task        → 任务出现（open；payload 只带 key，不带 number）
//   kind=claim       → claimedBy=actor（不改 status——claim 只登记持有）
//   kind=progress    → progress=payload.progress（≥100 同步 done，与 setProgress 语义一致）
//   kind=complete    → status=done
//   kind=task-status → status=payload.status（open 时释放持有者，对应 requeue/重开）
// 其余 kind（note/message/verify/...）不影响任务状态，但保留计数。

const STATUS_KINDS = new Set(["task", "claim", "progress", "complete", "task-status"]);

function payloadOf(e) {
  if (e.payload == null) return {};
  if (typeof e.payload === "object") return e.payload;
  try { return JSON.parse(e.payload); } catch { return {}; }
}

/**
 * foldTasks(events, uptoSeq) -> Map<key, {status, claimedBy, progress, number, lastSeq, lastAt, events}>
 * events 须按 seq 升序（b.since(0) 即是）。uptoSeq 缺省 = 全部。
 */
export function foldTasks(events, uptoSeq = Infinity) {
  const tasks = new Map();
  for (const e of events) {
    if (e.seq > uptoSeq) break;
    if (!STATUS_KINDS.has(e.kind)) continue;
    const p = payloadOf(e);
    const key = p.key ?? e.refId;
    if (!key) continue;
    const t = tasks.get(key) ?? { status: "open", claimedBy: null, progress: 0, lastSeq: 0, lastAt: null, events: 0 };
    t.events++;
    t.lastSeq = e.seq;
    t.lastAt = e.at ?? null;
    if (e.kind === "claim") {
      t.claimedBy = e.actor; // 只登记持有，不动状态
    } else if (e.kind === "progress") {
      if (Number.isFinite(p.progress)) {
        t.progress = p.progress;
        if (p.progress >= 100) t.status = "done";
        else if (t.status === "open") t.status = "in-progress";
      }
    } else if (e.kind === "complete") {
      t.status = "done";
      t.progress = Math.max(t.progress, 100);
    } else if (e.kind === "task-status") {
      if (typeof p.status === "string") {
        t.status = p.status;
        if (p.status === "open") { t.claimedBy = null; t.progress = 0; } // 重派/人工重开 → 释放持有
      }
    }
    tasks.set(key, t);
  }
  return tasks;
}

/** 与"现在"对比：返回 [{key, atSeq, now}] —— 状态在 uptoSeq 之后变过的任务。 */
export function diffToNow(folded, currentTasks) {
  const diffs = [];
  for (const [key, t] of folded) {
    const cur = currentTasks.get(key);
    const nowStatus = cur?.status ?? "(已删除)";
    if (nowStatus !== t.status) diffs.push({ key, atSeq: t.status, now: nowStatus });
  }
  return diffs;
}
