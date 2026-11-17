// V1.5 judge（验证层，2026-10-07 采纳建议①）：机械检查验"形"，judge 验"质"。
// 用指定面（缺省 dsh，成本最低）做一次性无头评审：读任务书 + 产物，按 rubric 产出
// 严格 JSON {pass, reason}。判定语义（judge 是信号不是闸门，调研报告 §4.3）：
//   judge 说 fail   → 不自动拒：升级进人工复核队列（V3），复核人才是裁决者
//   judge 说 pass   → 维持原路由（auto 全过关单 / cross·human 照旧进队）
//   judge 基础设施不可用（spawn 失败/超时/解析不出 JSON）→ 跳过 judge 记日志，
//                     不阻塞任务流——不能因为质检员请假就停生产线。
// 复用 runner.runTask（无头 spawn/超时/结果收集全套现成），judge 只是"一次性任务"。
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runTask } from "./runner.js";

export const DEFAULT_RUBRIC = [
  "产物是否真实回应了任务书的要求（对照任务书原文逐条看）",
  "内容是否自洽：无占位符（TODO/TBD/XXX/lorem）、无成段重复凑数、无明显截断",
  "产物之间是否互洽（台账数字与实际产物对得上、引用的文件真实存在）",
].join("；");

export function buildJudgePrompt({ key, description, rubric, workdir }) {
  return [
    `你是质检评审（V1.5 judge）。任务 ${key} 的执行者自报完成，机械检查已通过；现在请你读产物，判断质量是否过关。`,
    "",
    "## 任务书原文",
    (description ?? "（未提供）").slice(0, 4000),
    "",
    "## 评审要点（rubric）",
    rubric ?? DEFAULT_RUBRIC,
    "",
    "## 工作目录",
    `${workdir} —— 产物都在这里，用读文件的方式实际查看，不要凭空猜测。`,
    "",
    "## 输出要求（严格遵守）",
    "只输出一个 JSON 对象，不要任何其他文字：",
    '{"pass": true 或 false, "reason": "一句话结论，指出关键证据（引用具体文件与位置）"}',
    "拿不准就 pass:false，把疑点写进 reason——宁可错报给人工复核，不可放行假完成。",
  ].join("\n");
}

// 从模型输出提取 {pass, reason}；容忍 markdown 围栏与前后杂讯。提取不到 → null
//（调用方按 judge-unavailable 处理，不当成 fail——解析失败是基础设施问题，不是产物问题）。
export function parseVerdict(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  const i = text.indexOf("{"), j = text.lastIndexOf("}");
  if (i >= 0 && j > i) candidates.push(text.slice(i, j + 1));
  candidates.push(text);
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === "object" && !Array.isArray(v) && typeof v.pass === "boolean") {
        return { pass: v.pass, reason: typeof v.reason === "string" ? v.reason : "" };
      }
    } catch { /* 试下一个候选 */ }
  }
  return null;
}

/**
 * runJudge({judgeAgent, agentCfg, key, description, rubric, workdir, runDirBase, log})
 * -> {verdict: "pass"|"fail"|"unavailable", reason, model?, runDir}
 * agentCfg = 守护 cfg.agents[judgeAgent]，叠加 judge 自己的短超时（评审不该跑长任务）。
 */
export async function runJudge({ judgeAgent, agentCfg = {}, key, description, rubric, workdir, runDirBase, log = () => { } }) {
  const runDir = join(runDirBase, `judge-${key}-${Date.now()}`);
  mkdirSync(runDir, { recursive: true });
  const promptFile = join(runDir, "prompt.md");
  writeFileSync(promptFile, buildJudgePrompt({ key, description, rubric, workdir }), "utf8");
  const cfg = {
    ...agentCfg,
    timeoutMs: agentCfg.timeoutMs ?? 300000,
    stallMs: agentCfg.stallMs ?? 120000,
    stallStartupMs: agentCfg.stallStartupMs ?? 180000,
  };
  let r;
  try {
    r = await runTask({ agentCfg: cfg, adapter: judgeAgent, runDir, promptFile, workdir, fm: null, runId: `judge-${key}`, log });
  } catch (e) {
    return { verdict: "unavailable", reason: `judge spawn 异常：${e.message}`, runDir };
  }
  if (r.spawnError) return { verdict: "unavailable", reason: `judge 面 spawn 失败：${r.spawnError}`, runDir };
  if (r.killed || r.stalled || (r.exitCode ?? 0) !== 0) {
    return { verdict: "unavailable", reason: `judge 运行未正常结束（exit=${r.exitCode}${r.stalled ? "，判停" : ""}${r.killed ? "，超时" : ""}）`, runDir };
  }
  const v = parseVerdict(r.resultText);
  if (!v) return { verdict: "unavailable", reason: "judge 输出解析不出 {pass,reason} JSON", runDir, raw: r.resultText?.slice(0, 200) };
  return { verdict: v.pass ? "pass" : "fail", reason: v.reason, model: r.model ?? null, runDir };
}
