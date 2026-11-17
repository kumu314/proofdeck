// watchdog-core — 冻结自愈看门狗的决策核（纯函数 + 注入时钟，可单测；I/O 留给 watchdog-worker.mjs）。
//
// 为什么要有这颗核（2026-10-06，接 10-02 缺口④ 与 10-05 误杀事故）：
// 原来只有一条判据「主线程心跳静默 > staleMs 且连续两振」，而静默有两种成因，读数完全同形：
//   (a) 事件循环真冻结（10-02 形状，必须杀）；
//   (b) 整机被挂起（睡眠/休眠）后唤醒，唤醒瞬间 CPU 饥饿，主线程只是还没被调度到（10-05 形状，
//       杀错的就是健在的守护：实测它 36.989433s 后自己答了 /ps）。
// 单靠静默时长分不开，所以加两道独立闸：
//   闸一（自测节拍）：worker 自己也在被挂起之列。若自己这一拍比 checkMs 晚了 staleMs 以上，
//     说明「整进程」被挂起过，此刻的静默读数不可解释 → 清零、不做任何 I/O、不杀。
//   闸二（端口旁证）：两振成立后先问一次控制口，且给**远大于 guard 探针**的预算（饥饿中的守护
//     会慢答，冻结的事件循环永远不答）。有答 / 探针期间心跳恢复 → 弃权。
// 保留：闸二里「整段预算无一字应答」和「拒连」仍判杀——这正是 10-02 缺口①要治的那个形状，不能让
// 「超时一律弃权」把冻结自愈能力退回 0（那件事交给分钟级的 guard 反而做不了：guard 必须秒级退出）。
export function createWatchdog({ now, staleMs, graceMs, checkMs, probe, kill, log = () => {} }) {
  const startedAt = now();
  let lastMsg = startedAt;
  let lastTick = startedAt;
  let streak = 0;
  let busy = false;
  let fired = false;   // 只开火一次（2026-10-06 W1b 实测：不置闸的话，杀完之后每一拍都会再杀一次）

  const onHeartbeat = () => { lastMsg = now(); streak = 0; };

  async function tick() {
    const t = now();
    const tickGap = t - lastTick;
    lastTick = t;
    if (busy) return "probing-busy";
    if (fired) return "already-fired";
    if (t - startedAt < graceMs) return "grace";

    if (tickGap - checkMs > staleMs) {
      streak = 0; lastMsg = t;
      log(`watchdog: 自身节拍迟到 ${Math.round(tickGap / 1000)}s（checkMs=${checkMs}）— 整进程被挂起过，静默读数不可解释，计数清零且不查端口`);
      return "suspend-reset";
    }

    const silence = t - lastMsg;
    if (silence <= staleMs) { streak = 0; return "healthy"; }
    streak += 1;
    if (streak < 2) {
      log(`watchdog: main heartbeat silent ${Math.round(silence / 1000)}s (strike 1) — waiting one more check`);
      return "strike1";
    }

    busy = true;
    let outcome;
    try { outcome = await probe(); } catch (e) { outcome = "probe-error"; log(`watchdog: 探针抛错 ${e.message}`); }
    busy = false;
    lastTick = now();

    const resumed = now() - lastMsg <= staleMs;
    if (outcome === "answered" || resumed) {
      streak = 0; lastMsg = now();
      log(`watchdog: 静默 ${Math.round(silence / 1000)}s 但控制口 ${outcome === "answered" ? "有应答" : "心跳已恢复"} — 主循环只是慢，不是冻结，弃权`);
      return outcome === "answered" ? "answered-stand-down" : "heartbeat-resumed-stand-down";
    }
    if (outcome === "probe-error") { streak = 0; return "abstain-probe-error"; }

    log(`watchdog: 主线程静默 ${Math.round(silence / 1000)}s 两振成立、自身节拍正常、控制口整段预算判为 ${outcome} — SIGKILL 自杀重启`);
    fired = true;
    kill();
    return outcome === "refused" ? "kill-refused" : "kill-unanswered";
  }

  return { onHeartbeat, tick, snapshot: () => ({ streak, silence: now() - lastMsg, tickGap: now() - lastTick }) };
}
