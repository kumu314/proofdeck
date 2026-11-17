// 能力匹配（2026-10-07 采纳建议③ 第一步）：任务书 bridge 块可声明 needs: ["content", ...]，
// 各面在 daemon.config.json 的 agents.<face>.capabilities 声明能力。
// 语义（向后兼容优先）：
//   - 任务未声明 needs            → 所有面都合格（现状不变）
//   - 面未声明 capabilities       → 视为"万能"，任何 needs 都合格（存量配置零改动）
//   - 双边都声明了                → needs 全集 ⊆ capabilities 才合格（大小写不敏感）
// 匹配失败时由调用方（daemon handle()）按 fallbacks 找有能力的可用面改派，
// 与 asciiOnly 硬门限同一形态；全不可用则 refuse 上板。

export function parseNeeds(block) {
  const n = block?.needs;
  if (typeof n === "string" && n.trim()) return [n.trim().toLowerCase()];
  if (Array.isArray(n)) return n.filter((x) => x != null).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  return [];
}

export function faceHasCaps(faceCaps, needs) {
  if (!needs?.length) return true;
  if (!Array.isArray(faceCaps) || faceCaps.length === 0) return true; // 未声明 = 万能
  const have = new Set(faceCaps.map((c) => String(c).trim().toLowerCase()));
  return needs.every((n) => have.has(n));
}

/** 按序挑第一个"有能力且可探活"的候选面；isReachable 异步（探活），返回 {face, skipped}。 */
export async function pickCapableFace({ candidates, needs, agentsCfg, isReachable }) {
  const skipped = [];
  for (const f of candidates) {
    if (!faceHasCaps(agentsCfg?.[f]?.capabilities, needs)) { skipped.push(f); continue; }
    try {
      if (await isReachable(f)) return { face: f, skipped };
    } catch { /* 探活异常视同不可达 */ }
    skipped.push(f);
  }
  return { face: null, skipped };
}
