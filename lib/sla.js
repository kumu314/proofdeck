// SLA 逾期判定与 owner 摘要（调度层 C.4/C.6，2026-10-02 设计稿）——纯函数，可测。
// 逾期只做「升级可见性」：标红 + 提醒，不强制取消（v1 不给系统杀人权限）。
// 摘要把未读消息/待审批/逾期卡/重试排队/近期 blocked 摊成一条消息给 owner，摊薄裁决成本。

// 任务书 bridge 块的 dueAt（ISO 字符串或 epoch ms）。返回 null 表示未声明/不可解析。
export function parseDueAt(dueAt) {
  if (typeof dueAt === "number" && Number.isFinite(dueAt)) return dueAt;
  if (typeof dueAt === "string") {
    const t = Date.parse(dueAt);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// 逾期判定：终态（done/blocked）不管；未到期不管；已提醒过（v1 一卡一次）不再提醒。
export function overdueDecision({ dueAt, status, now, notifiedAt }) {
  const due = parseDueAt(dueAt);
  if (due == null) return null;
  if (status === "done" || status === "blocked") return null;
  if (!Number.isFinite(now) || now <= due) return null;
  if (notifiedAt) return null;
  return { due, overdueMs: now - due };
}

// owner 摘要文本。入参均为已聚合好的数字/短列表；全空 → {empty:true}（调用方跳过发送）。
// coverage = { total, verified, unverified[] }：统计周期内新派卡的验收覆盖（§17 推广可见性）。
export function buildDigest({ unreadBy = {}, pending = [], overdue = [], retries = [], blockedRecent = [], running = [], coverage = null } = {}) {
  const unreadTotal = Object.values(unreadBy).reduce((a, b) => a + b, 0);
  const lines = [];
  if (unreadTotal) lines.push(`· 未读消息 ${unreadTotal} 条（${Object.entries(unreadBy).map(([a, n]) => `${a}×${n}`).join("、")}）`);
  if (running.length) lines.push(`· 正在跑 ${running.length} 张：${running.slice(0, 5).join(", ")}${running.length > 5 ? "…" : ""}`);
  if (pending.length) lines.push(`· 待审批 ${pending.length} 张：${pending.slice(0, 5).map((p) => `${p.key}（${p.reason ?? "需人批"}）`).join("；")}${pending.length > 5 ? "…" : ""}`);
  if (overdue.length) lines.push(`· 逾期 ${overdue.length} 张：${overdue.slice(0, 5).join(", ")}${overdue.length > 5 ? "…" : ""}（已标 [OVERDUE]）`);
  if (retries.length) lines.push(`· 自动重派排队 ${retries.length} 张：${retries.slice(0, 5).map((r) => `${r.key}（第 ${r.n} 次）`).join("；")}${retries.length > 5 ? "…" : ""}`);
  if (blockedRecent.length) lines.push(`· 近期失败/阻塞 ${blockedRecent.length} 张：${blockedRecent.slice(0, 5).join(", ")}${blockedRecent.length > 5 ? "…" : ""}`);
  if (coverage && coverage.total > 0) {
    const pct = Math.round((coverage.verified / coverage.total) * 100);
    lines.push(`· 验收覆盖（本期新卡）：${coverage.verified}/${coverage.total}（${pct}%）${coverage.unverified?.length ? `；未验：${coverage.unverified.slice(0, 5).join(", ")}${coverage.unverified.length > 5 ? "…" : ""}（宪法 §17：补标准或声明 mode=human）` : ""}`);
  }
  if (!lines.length) return { empty: true, text: "" };
  return { empty: false, text: `[bridge 摘要] 需要你知道的：\n${lines.join("\n")}\n（详情见板；本摘要周期性发送，可配置关闭）` };
}
