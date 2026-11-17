// 复核队列（验证层 V2 交叉 / V3 人工，2026-10-02 设计稿 Part B.2 的落地）。
// mode=cross / mode=human 的任务执行完成后**不自动关单**：进队列、落 REVIEW note、
// 私信复核人；复核人用 bridge-ctl review-accept / review-reject 裁决。
// cross 的机械项（若有 checks）仍在关单前先跑（失败走 work 类失败路径），本模块只管
// "机械项已过或未声明后，等独立复核"这一段。
export function queueReview({ b, io, store, ID, key, agent, mode, reviewer, runDir, v1Note = "" }) {
  const level = mode === "human" ? "V3" : "V2";
  (store.s.review ??= {})[key] = { at: Date.now(), agent, mode, reviewer, runDir };
  io.note(b, ID, `[[verify]] key=${key} verdict=REVIEW level=${level} reviewer=${reviewer} by=${ID}`);
  io.note(b, ID, `[${ID}→${agent}] ${key} 执行完成，提请${mode === "human" ? "人工" : "交叉"}复核（未关单）${v1Note}。复核: node bridge-ctl.js review-accept ${key} / review-reject ${key}「理由」。工件: ${runDir}`);
  io.message(b, ID, reviewer, `[${ID}] 任务 ${key} 提请复核（${level}）${v1Note}：任务书+工件见 ${runDir}。通过: review-accept ${key}；驳回: review-reject ${key}「理由」。`);
  return { level, reviewer };
}

export function applyReviewAccept({ b, io, store, ID, key }) {
  const r = store.s.review?.[key];
  if (!r) return { ok: false, why: "该卡不在复核队列" };
  io.done(b, ID, key);
  const level = r.mode === "human" ? "V3" : "V2";
  io.verify?.(b, ID, key, "pass", { level, summary: `verify PASS ${key} (${level}, reviewer=${r.reviewer})` });
  io.note(b, ID, `[[verify]] key=${key} verdict=PASS level=${level} by=${ID}(复核人=${r.reviewer})`);
  if (r.agent) io.message(b, ID, r.agent, `[${ID}] 任务 ${key} 复核通过，已关单。`);
  delete store.s.review[key];
  delete store.s.retries?.[key]; // 防御：复核关单后残留的重试台账会在 dueAt 把 done 卡再派一次
  store.save();
  return { ok: true, mode: r.mode, reviewer: r.reviewer };
}

export function applyReviewReject({ b, io, store, ID, key, reason }) {
  const r = store.s.review?.[key];
  if (!r) return { ok: false, why: "该卡不在复核队列" };
  const level = r.mode === "human" ? "V3" : "V2";
  io.setStatus(b, ID, key, "open");
  io.verify?.(b, ID, key, "fail", { level, summary: `verify FAIL ${key} (${level}, reviewer=${r.reviewer}) — ${reason ?? "未给理由"}` });
  io.note(b, ID, `[[verify]] key=${key} verdict=FAIL level=${level} by=${ID}(复核人=${r.reviewer}) — 复核驳回：${reason ?? "未给理由"}`);
  if (r.agent) io.message(b, ID, r.agent, `[${ID}] 任务 ${key} 复核被驳回（${reason ?? "未给理由"}）。已回 open；修正后重派: node bridge-ctl.js requeue ${key} ${r.agent}。`);
  delete store.s.review[key];
  store.save();
  return { ok: true, mode: r.mode };
}
