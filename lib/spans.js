// spans（2026-10-07 采纳建议⑤）：守护的关键动作产出 OTel GenAI 语义风格的 span，
// 落 logs/spans-YYYYMMDD.jsonl（本地 JSONL；将来接 Langfuse/Phoenix/OTLP 只是格式转换）。
// 命名对齐 open-telemetry/semantic-conventions-genai 的 gen_ai.* 约定（未 Stable，取其形）：
//   gen_ai.agent.dispatch        {task, agent, attempt?}
//   gen_ai.agent.verify          {task, level, verdict, checks}
//   gen_ai.agent.review          {task, mode, verdict, reviewer}
//   gen_ai.agent.retry           {task, agent, attempt, delayMs, why}
//   gen_ai.agent.breaker         {agent, category, streak, holdMs}
//   gen_ai.agent.reap            {task, killed}
//   gen_ai.agent.sla             {task}
// span != LLM 调用级 tracing（那在 faces 各自的轨迹里）；这里是编排层动作链。
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let SPANS_DIR = null;
let enabled = true;

export function initSpans({ dir, enabled: en = true }) {
  SPANS_DIR = dir;
  enabled = !!en;
  if (enabled) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
  }
}

export function emitSpan(name, attrs = {}) {
  if (!enabled || !SPANS_DIR) return;
  try {
    const rec = {
      ts: new Date().toISOString(),
      name,
      ...attrs,
    };
    appendFileSync(join(SPANS_DIR, `spans-${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify(rec) + "\n", "utf8");
  } catch { /* 遥测绝不砸主流程 */ }
}
