// 输出预算饿死（第五类死因）的识别：一次 LLM 调用 finish_reason=length，且在落笔前就被切
// （content 空 **且** 无 tool_calls）⇒ 模型"想写"但一个字都没写出。连续 N 次即判死环路。
//
// 为什么只能事后判：这面的轨迹在进程结束时才落盘，跑到一半读不到 ⇒ 不能在段中途掐，
// 只能做到"识别出来就判死，并且不再起下一段"（续跑对一个纯配置缺陷是白烧）。
//
// 实测标本（2026-10-01，面级 max_tokens: 4096 时代的一次探针轮次）：14 次调用里 6 次饿死
// （步 7/9/11/12/13/14），最长连续 4，每次 output_tokens 恰为 4096；抬到 32768 后同一面
// 8 段/35 步命中 0 次。
// 反面对照（不能误伤）：另一仍配 4096 的面 success=true 却有 2 次饿死 ⇒ 阈值取 3，
// 恰好放过"偶发截断但整体做成"的正常轮次。
//
// 注意 usage.reasoning_tokens 在本机该面轨迹里恒为 0（供应方未报该字段），
// 所以判据不许依赖它——只看可观测的三件事：finish_reason / content / tool_calls。

export const STARVE_LIMIT = 3;

export function isStarved(response) {
  if (!response || response.finish_reason !== "length") return false;
  if (String(response.content ?? "").trim()) return false;
  return !(response.tool_calls ?? []).length;
}

/** 最长连续饿死次数（环路证据）。 */
export function maxStarveRun(interactions) {
  let best = 0, cur = 0;
  for (const x of interactions ?? []) {
    if (isStarved(x?.response)) { cur += 1; if (cur > best) best = cur; }
    else cur = 0;
  }
  return best;
}

export function starveTotal(interactions) {
  let n = 0;
  for (const x of interactions ?? []) if (isStarved(x?.response)) n += 1;
  return n;
}

/** 达阈值即真。给调用点一个唯一入口，免得两处各写一遍比较。 */
export function isStarveLoop(interactions, limit = STARVE_LIMIT) {
  return maxStarveRun(interactions) >= limit;
}
