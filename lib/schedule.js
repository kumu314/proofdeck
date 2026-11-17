// Scheduling core (pure, no I/O) — priority lanes with aging + auto-retry policy.
// Part of the 2026-10-02 调度层 design (docs/design/2026-10-02-评估-*.md Part C).
// Daemon wiring lives in daemon.js/store.js; this module stays testable.

export const PRIORITY_INDEX = { P0: 0, P1: 1, P2: 2, P3: 3 };

// Unknown/absent → P2 so legacy tasks keep FIFO-within-same-rank behaviour.
export function normPriority(p, fallback = "P2") {
  const k = String(p ?? "").toUpperCase();
  return Object.prototype.hasOwnProperty.call(PRIORITY_INDEX, k) ? k : fallback;
}

// Aging: every agingMs of waiting lifts the task one priority rank toward P0.
// A P3 task ranks as P2 after agingMs, P1 after 2*agingMs … floor at P0.
export function effectiveRank(basePriority, waitMs, agingMs) {
  const base = PRIORITY_INDEX[normPriority(basePriority)] ?? 2;
  const lift = Math.floor(Math.max(0, waitMs) / Math.max(1, agingMs));
  return Math.max(0, base - lift);
}

// Index of the lane entry to dispatch next: lowest effective rank wins, ties break
// FIFO by enqueue time (older first), then by lane position for stability.
// laneAt: key -> {at, priority} enqueue metadata (missing at ⇒ treated as now).
export function bestLaneIndex({ lane, laneAt = {}, priorityOf, now, agingMs }) {
  if (!Array.isArray(lane) || lane.length === 0) return -1;
  let best = -1;
  let bestScore = null;
  lane.forEach((key, i) => {
    const meta = laneAt[key] ?? {};
    const at = Number.isFinite(meta.at) ? meta.at : now;
    const base = priorityOf ? priorityOf(key) : meta.priority;
    const rank = effectiveRank(base, now - at, agingMs);
    const score = [rank, at, i];
    if (bestScore === null || score[0] < bestScore[0]
      || (score[0] === bestScore[0] && (score[1] < bestScore[1]
        || (score[1] === bestScore[1] && score[2] < bestScore[2])))) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

// Auto-retry policy for FAILED runs (调度层 C.3). Retryable = transient task-level
// failures (self-reported failure, rc≠0, stall-kill, timeout-kill). NOT retryable:
// human kill (a person decided), supply-breaker failures (the face's own recovery
// path owns those), face-adapter spawn errors (provider-side, not task-side).
// maxAttempts caps burn; backoff doubles per attempt and clamps at maxDelayMs.
export function retryDecision({
  why = "", latch = null, killedBy = null, result = {},
  attempts = 0, maxAttempts = 2, baseMs = 30 * 60000, maxDelayMs = 4 * 3600000,
} = {}) {
  if (attempts >= maxAttempts) return { retry: false, reason: `已重试 ${attempts} 次达上限，转人工` };
  if (latch) return { retry: false, reason: "供应方熔断类失败，归熔断恢复路径管，不自动重试" };
  if (killedBy === "manual") return { retry: false, reason: "人工掐死，不自动重试" };
  if (result.spawnError) return { retry: false, reason: "面适配器 spawn 失败（供应方侧），不自动重试" };
  const delayMs = Math.min(baseMs * Math.pow(2, attempts), maxDelayMs);
  return { retry: true, attempt: attempts + 1, delayMs };
}
