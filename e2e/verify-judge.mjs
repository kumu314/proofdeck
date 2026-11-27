// e2e: V1.5 judge（采纳建议①）—— parseVerdict 容错提取 / prompt 构建 / runJudge
// 基础设施不可用时 fail-open（verdict=unavailable，不阻塞任务流）。不真跑模型。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const J = await import(new URL("../lib/judge.js", import.meta.url).href);

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
};

const dir = mkdtempSync(join(tmpdir(), "bridge-judge-"));

try {
  // ---- parseVerdict ----
  ok("J1a 严格 JSON", JSON.stringify(J.parseVerdict('{"pass":true,"reason":"ok"}')) === JSON.stringify({ pass: true, reason: "ok" }));
  ok("J1b markdown 围栏包裹", J.parseVerdict('结论如下\n```json\n{"pass":false,"reason":"台账对不上"}\n```\n完')?.pass === false);
  ok("J1c 前后杂讯夹 JSON", J.parseVerdict('评审完成。{"pass": true, "reason": "自洽"} 请查收。')?.pass === true);
  ok("J1d 缺 pass 字段 → null", J.parseVerdict('{"verdict":"pass"}') === null);
  ok("J1e 空串/非串 → null", J.parseVerdict("") === null && J.parseVerdict(null) === null);
  ok("J1f 纯文本无 JSON → null", J.parseVerdict("我觉得可以。") === null);
  ok("J1g pass 非布尔 → null", J.parseVerdict('{"pass":"yes"}') === null);
  ok("J1h reason 缺省为空串", J.parseVerdict('{"pass":true}')?.reason === "");

  // ---- buildJudgePrompt ----
  {
    const p = J.buildJudgePrompt({ key: "t-1", description: "写 30 首诗", rubric: null, workdir: "D:/w" });
    ok("J2a prompt 含任务书与默认 rubric", p.includes("写 30 首诗") && p.includes("占位符"));
    ok("J2b prompt 要求严格 JSON", p.includes('{"pass"') && p.includes("宁可错报给人工复核"));
    const p2 = J.buildJudgePrompt({ key: "t-1", description: "x", rubric: "只看错别字", workdir: "D:/w" });
    ok("J2c 自定义 rubric 覆盖默认", p2.includes("只看错别字") && !p2.includes("无占位符"));
    // 2026-11-28 柯木裁定：judge 盲评——prompt 不得泄露前置检查结果，防往宽松方向的先验
    ok("J2d 盲评：prompt 不含\"机械检查已通过\"锚定", !p.includes("机械检查已通过") && !p2.includes("机械检查已通过"));
  }

  // ---- runJudge 不可用路径（fail-open）----
  {
    const r = await J.runJudge({ judgeAgent: "no-such-face", agentCfg: {}, key: "t-2", description: "x", workdir: "D:/w", runDirBase: dir, log: () => { } });
    ok("J3a 未知面 → unavailable（不炸）", r.verdict === "unavailable" && String(r.reason).includes("spawn"), r.reason);
  }
  {
    const r = await J.runJudge({ judgeAgent: "dsh", agentCfg: { script: "D:/nonexistent/run.mjs", node: "node" }, key: "t-3", description: "x", workdir: "D:/w", runDirBase: dir, log: () => { } });
    ok("J3b 面脚本不存在 → unavailable", r.verdict === "unavailable", r.reason);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { }
}
