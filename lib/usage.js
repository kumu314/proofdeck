// 用量台账 — 每个 run 追加一行到 usage.jsonl，供成本统计与派单前预算校验消费。
//
// 一条硬规则：**缺字段绝不静默记 0**。0 和「没采到」在账上是两回事——记 0 会把
// 「这一面根本没花钱」伪装成「这一面很省」，而预算校验正是靠这个数决定要不要再派。
// 所以读不到权威产物时写 {missing:true, reason:…}，数值字段一律 null。
//
// 归一化口径的出处（2026-09-29 对 19 个历史 run 实测，不是猜字段名）：
//   codex  codex.jsonl 里唯一一条 type="turn.completed" 的顶层 usage：
//          input_tokens 已含 cached_input_tokens（OpenAI Responses 口径，观测 456448 ≤ 540309 一致）
//   pi     pi.jsonl 每条 assistant message_end 的 message.usage，逐轮相加：
//          input 是**不含**缓存的那一段 ⇒ 有 totalTokens 可自证：10358+2760+25856=38974
//   trae   trae.traj.json 的 llm_interactions[*].response.usage，逐次调用相加
//   dsh    dsh-events.jsonl 每条 type="assistant/message" 的 data.usage，逐轮相加（steps 走 dsh-meta.json）
// prompt 一律归一成「含缓存的全部输入」，方便跨面比；各面原始字段同时留在 raw 里，归一化不覆盖事实。
import { appendFileSync, readFileSync, existsSync } from "node:fs";

export const LEDGER_FIELDS = ["prompt", "completion", "cached", "cacheWrite", "reasoning"];

/** 把某面读到的原始 usage 归一；u 为 null ⇒ 判红（missing），不产生 0。 */
export function normalizeUsage(agent, u) {
  if (!u) return missingUsage(agent, "权威产物不存在或解析不了（跑到一半被掐、或该面这轮没落盘）");
  const n = u.normalized ?? {};
  if (LEDGER_FIELDS.every((k) => n[k] == null)) {
    // 产物读得通、就是没给用量：步数等有的是知道的，别一起丢进 null，结案时能说清缺在哪。
    return { ...missingUsage(agent, `产物在但没给用量字段（source=${u.source ?? "?"}）`),
      source: u.source ?? null, steps: u.steps ?? null, maxSteps: u.maxSteps ?? null, overflow: u.overflow ?? null };
  }
  // fail-closed（第二道）：能走到这里，说明某面的 reader 声称「读到了用量」。但若五项加
  // total 全为 0、且没有 knownZero 的正当理由，这就不是「真的一次计费都没发生」，
  // 而是读取器交了一份默认零值（空对象也是 truthy，pi 面上就这么踩过——见 adapters/pi.js）。
  // 0 在账上会被读成「这面没花钱」，而预算校验正是靠这个数决定还要不要往这面派 ⇒ 降级 missing。
  const allZero = LEDGER_FIELDS.every((k) => (n[k] ?? 0) === 0) && (u.total ?? 0) === 0;
  if (allZero && !u.knownZero) {
    return { ...missingUsage(agent, `读到的用量字段全为 0（source=${u.source ?? "?"}），无法区分「真零次计费」与「读取器给了默认零值」——按铁律不静默记 0`),
      source: u.source ?? null, steps: u.steps ?? null, maxSteps: u.maxSteps ?? null, overflow: u.overflow ?? null };
  }
  const prompt = n.prompt ?? null;
  const completion = n.completion ?? null;
  return {
    agent,
    source: u.source ?? null,
    steps: u.steps ?? null,
    maxSteps: u.maxSteps ?? null,
    overflow: u.overflow ?? null,
    // knownZero=true：产物可读、确实一次计费调用都没发生（区别于 missing=读不到、不知道）。
    knownZero: u.knownZero ?? false,
    zeroReason: u.zeroReason ?? null,
    prompt,
    completion,
    cached: n.cached ?? null,
    cacheWrite: n.cacheWrite ?? null,
    reasoning: n.reasoning ?? null,
    // total 是派生值（prompt+completion），面自己给了总数时以面的为准。
    total: u.total ?? (prompt != null && completion != null ? prompt + completion : null),
    costUsd: u.costUsd ?? null,
    semantics: u.semantics ?? null,
    raw: u.raw ?? null,
    missing: false,
  };
}

export function missingUsage(agent, reason) {
  return {
    agent, missing: true, reason,
    source: null, steps: null, maxSteps: null, overflow: null,
    prompt: null, completion: null, cached: null, cacheWrite: null,
    reasoning: null, total: null, costUsd: null, semantics: null, raw: null,
  };
}

/** 追加一行；file 由调用方给（守护用 BASE 下的 usage.jsonl，冒烟用隔离目录）。 */
export function appendUsage(file, entry) {
  appendFileSync(file, JSON.stringify(entry) + "\n");
  return entry;
}

export function readUsageLedger(file) {
  if (!existsSync(file)) return [];
  const rows = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* 末行可能被写断，跳过不影响其余 */ }
  }
  return rows;
}

/** 按面汇总窗口内的用量，给预算校验用。missing 行计入 nMissing，不计入任何 token 数。 */
export function summarizeUsage(rows, agent, sinceTs = 0) {
  const s = { agent, runs: 0, nMissing: 0, prompt: 0, completion: 0, total: 0, costUsd: 0, maxStepsHit: 0, lastTs: null };
  for (const r of rows) {
    if (r.agent !== agent) continue;
    if (sinceTs && r.ts && r.ts < sinceTs) continue;
    s.runs++;
    s.lastTs = r.ts ?? s.lastTs;
    if (r.missing) { s.nMissing++; continue; }
    s.prompt += r.prompt ?? 0;
    s.completion += r.completion ?? 0;
    s.total += r.total ?? 0;
    if (r.costUsd != null) s.costUsd += r.costUsd;
    if (r.overflow === true) s.maxStepsHit++;
  }
  return s;
}
