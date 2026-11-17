// 余额断供 → 公开待认领任务的转化逻辑。
//
// 为什么单独成模块：这段逻辑要能脱离 daemon.js 起真守护来验证（真守护一启动就会
// 动队列、抢卡）。纯函数 + 注入 board 桩 = 可离线断言。daemon.js 只做接线。
//
// 语义：
//   - 只对 category==="billing"（余额/额度耗尽）触发。rate 会自愈、auth 要换 key，都不该转派。
//   - 不自动改派：同一部署的面往往共用一个钱包，改派很可能撞另一个同样空的。转成"公开可认领"，
//     由有额度的人来捡，是当前唯一不会二连撞的形态。
//   - 幂等：同一 key 只转一次（记账 key 由调用方持有，落 state 所以重启不丢）。

/** 断供卡面的追加说明（纯函数，便于断言内容）。 */
export function billingMarker({ key, agent, hit, runDir, stamp }) {
  return [
    "",
    "—— 供应方断供 · 公开待认领 ——",
    `原承接面：${agent}（${hit?.label ?? hit?.category ?? "billing"}）`,
    `断供时间：${stamp}`,
    `原日志：${runDir}`,
    `证据：${hit?.file}：「${String(hit?.line ?? "").slice(0, 200)}」`,
    "任何有可用额度的 agent 均可认领本卡；认领前先确认自己的面可用（node bridge-ctl.js ps）。",
    `恢复原面的承接：node bridge-ctl.js supply-clear ${agent} && node bridge-ctl.js requeue ${key} ${agent}`,
  ].join("\n");
}

/** 广播文案（纯函数）。 */
export function billingBroadcast({ agent, hit, key, title }) {
  return `供应方断供转公开待认领：**${key}**（原面 ${agent}·${hit?.label ?? "billing"}）—— ${title}。有额度的 agent 可从卡面认领；原面恢复后可 supply-clear + requeue 接回。`;
}

/** owner 私信文案（纯函数；只在"该面首次断供"时发）。 */
export function billingOwnerNotice({ agent, hit, key, runDir }) {
  return `${agent} 没钱了（${hit?.label ?? "余额/额度耗尽"}），卡 ${key} 已转成【公开待认领】挂到板上，等有额度的 agent 捡。要充值才能恢复原面。日志: ${runDir}`;
}

/**
 * 执行转化。board 需提供 { setStatus, defineTask, note } 三个写操作：
 *   setStatus(key, status) / defineTask(key, {description}) / note(text)
 * 调用方（daemon.js）用小适配器把 board 助手包成这三个形状，模块本身不依赖 board 的内部签名。
 *
 * 返回 { converted, reason }：switch-off / not-billing / already-converted / converted
 */
export function convertBillingTask(io, { key, agent, task, hit, runDir, converted, enabled = true }) {
  if (!enabled) return { converted: false, reason: "switch-off" };
  if (hit?.category !== "billing") return { converted: false, reason: "not-billing" };
  if (converted[key]) return { converted: false, reason: "already-converted" };

  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const prevDesc = String(task?.description ?? "");
  const title = String(task?.title ?? key);

  io.setStatus(key, "blocked");
  io.defineTask(key, { description: `${prevDesc}${billingMarker({ key, agent, hit, runDir, stamp })}` });
  io.note(billingBroadcast({ key, agent, hit, title }));
  converted[key] = { at: new Date().toISOString(), agent, category: hit.category, label: hit.label };
  return { converted: true };
}
