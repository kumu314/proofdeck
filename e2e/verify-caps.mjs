// e2e: 能力匹配（采纳建议③ 第一步）—— parseNeeds / faceHasCaps / pickCapableFace。
import { pathToFileURL } from "node:url";

const C = await import(new URL("../lib/caps.js", import.meta.url).href);

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
};

// ---- parseNeeds ----
ok("N1 数组归一化", JSON.stringify(C.parseNeeds({ needs: ["Content", " coding "] })) === JSON.stringify(["content", "coding"]));
ok("N2 单字符串", JSON.stringify(C.parseNeeds({ needs: "Content" })) === JSON.stringify(["content"]));
ok("N3 缺失/空 → []", JSON.stringify(C.parseNeeds({})) === "[]" && JSON.stringify(C.parseNeeds({ needs: [] })) === "[]" && JSON.stringify(C.parseNeeds(null)) === "[]");
ok("N4 过滤垃圾项", JSON.stringify(C.parseNeeds({ needs: ["a", "", 3, null] })) === JSON.stringify(["a", "3"]));

// ---- faceHasCaps（向后兼容语义）----
ok("C1 任务无 needs → 万能", C.faceHasCaps([], []) === true && C.faceHasCaps(undefined, []) === true);
ok("C2 面未声明能力 → 万能（存量配置零改动）", C.faceHasCaps(undefined, ["content"]) === true && C.faceHasCaps([], ["content"]) === true);
ok("C3 双边声明 → 子集才合格", C.faceHasCaps(["content", "coding"], ["content"]) === true);
ok("C4 缺能力 → 不合格", C.faceHasCaps(["coding"], ["content", "coding"]) === false);
ok("C5 大小写不敏感", C.faceHasCaps(["Content"], ["content"]) === true);

// ---- pickCapableFace ----
{
  const cfgA = { f1: { capabilities: ["coding"] }, f2: { capabilities: ["content", "coding"] }, f3: {} };
  const reach = new Set(["f1", "f2", "f3"]);
  const r1 = await C.pickCapableFace({
    candidates: ["f1", "f2", "f3"], needs: ["content"], agentsCfg: cfgA,
    isReachable: async (f) => reach.has(f),
  });
  ok("P1 缺能力的候选被跳过，选到有能力的", r1.face === "f2" && JSON.stringify(r1.skipped) === JSON.stringify(["f1"]), JSON.stringify(r1));
  const r2 = await C.pickCapableFace({
    candidates: ["f1", "f2"], needs: ["content"], agentsCfg: cfgA,
    isReachable: async (f) => f !== "f2", // f2 有能力但探不通
  });
  ok("P2 有能力但探不通 → 继续找（无 → null）", r2.face === null && JSON.stringify(r2.skipped) === JSON.stringify(["f1", "f2"]), JSON.stringify(r2));
  const r3 = await C.pickCapableFace({
    candidates: ["f3"], needs: ["whatever"], agentsCfg: cfgA, isReachable: async () => true,
  });
  ok("P3 未声明能力的面视为万能", r3.face === "f3");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
