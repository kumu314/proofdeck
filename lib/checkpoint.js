// 检查点与分段续跑（#29）。
//
// 存在的理由：一张卡撞步数上限/超时被掐时，已完成的工作只存在于那个被杀掉的进程里，
// 下一次派发是从零开始——实测 trae #34 死在第 15 步，正文已经写进 write_round3.py 却没执行。
// 这里只管两件事：① 把「做到哪了」落成一份可核对的文本；② 把这份文本变成下一段的题面。
//
// 检查点有两个来源，可信度不同，所以必须标 kind：
//   agent    —— 模型自己写的 CHECKPOINT.md，知道「打算做什么」，但可能与实际磁盘不符；
//   derived  —— 桥从 run 产物（meta.json/用量）+ workdir 实际文件清单派生，只说事实，不说意图。
// 段题面里明确「以磁盘为准」，就是为了让下一段自己去核对 agent 的自述。
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, renameSync } from "node:fs";
import { join, relative } from "node:path";

export const CP_NAME = "CHECKPOINT.md";
export const SEGMENT_CAP = 3;          // 每卡最多段数（2026-09-29 定档：默认 1，封顶 3）
const CP_MAX_CHARS = 4000;
const LIST_MAX_FILES = 25;

/** 任务书 front matter 里的 segments；不写或写 <=1 就是今天的一次性派发。 */
export function maxSegments(fm) {
  const n = Number.parseInt(String(fm?.segments ?? "").trim(), 10);
  if (!Number.isFinite(n) || n <= 1) return 1;
  return Math.min(n, SEGMENT_CAP);
}

function walkFiles(dir, root, out, depth = 0) {
  if (depth > 4 || out.length >= LIST_MAX_FILES * 4) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules" || e.name === "__pycache__") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { walkFiles(p, root, out, depth + 1); continue; }
    try {
      const st = statSync(p);
      out.push({ rel: relative(root, p).replace(/\\/g, "/"), size: st.size, mtime: st.mtimeMs });
    } catch { /* 刚被删掉的文件不算异常 */ }
  }
}

/**
 * 落一份检查点到本段 runDir，返回 { file, kind, text }。
 * workdir 里的 CHECKPOINT.md 是 agent 写的；派生内容一律来自磁盘与 run 产物，不做任何推测。
 */
export function capture({ agent, workdir, runDir, segment, result, usage, why }) {
  const lines = [];
  let kind = "derived";
  let own = null;
  const ownPath = join(workdir, CP_NAME);
  if (existsSync(ownPath)) {
    try { own = readFileSync(ownPath, "utf8").trim(); } catch { own = null; }
  }
  if (own && own.length > 0) { kind = "agent"; lines.push(own); }
  else lines.push("（本段没有留下 " + CP_NAME + "，以下由桥从产物与工作目录派生，只含事实、不含模型自述）");

  const facts = [];
  facts.push(`面=${agent} 段=${segment}`);
  facts.push(`结束原因=${why ?? "未知"}`);
  if (result) {
    facts.push(`exitCode=${result.exitCode} items(里程碑数)=${result.items ?? 0}` +
      `${result.killed ? " 超时被杀" : ""}${result.stalled ? " 无进展被掐" : ""}` +
      `${result.agentSuccess === false ? " agent 自报 success=false" : ""}`);
    if (result.threadId) facts.push(`thread=${result.threadId}`);
    if (result.model) facts.push(`model=${result.model}`);
  }
  if (usage) {
    facts.push(`用量=${usage.missing ? `missing(${usage.reason})` : `prompt=${usage.prompt} completion=${usage.completion}`}` +
      `${usage.steps != null ? ` steps=${usage.steps}/${usage.maxSteps ?? "?"}${usage.overflow ? "(达上限)" : ""}` : ""}`);
  }
  lines.push("", "===== 桥侧事实 =====", facts.join("\n"));

  const found = [];
  walkFiles(workdir, workdir, found);
  found.sort((a, b) => b.mtime - a.mtime);
  const listing = found.slice(0, LIST_MAX_FILES)
    .map((f) => `  ${new Date(f.mtime).toISOString()}  ${String(f.size).padStart(9)}B  ${f.rel}`);
  lines.push("", `===== 工作目录实际文件（${workdir}，按修改时间倒序，共 ${found.length} 个${found.length > LIST_MAX_FILES ? `，只列前 ${LIST_MAX_FILES}` : ""}）=====`,
    listing.length ? listing.join("\n") : "  （空目录：本段没产出任何文件）");

  const text = lines.join("\n").slice(0, CP_MAX_CHARS * 2);
  const file = join(runDir, `checkpoint-seg${segment}.md`);
  writeFileSyncAtomic(file, text);
  return { file, kind, text: text.slice(0, CP_MAX_CHARS), fileCount: found.length };
}

function writeFileSyncAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

/** 下一段的题面：原题之外唯一新增的东西。 */
export function renderPriming({ segment, total, cp, why, resumed }) {
  return [
    `===== 第 ${segment}/${total} 段：同一工作目录续跑 =====`,
    `上一段结束原因：${why}`,
    `上一段检查点（来源：${cp.kind === "agent" ? "模型自写的 " + CP_NAME : "桥从 run 产物与工作目录派生"}，落盘 ${cp.file}）：`,
    "",
    cp.text,
    "",
    "本段要求：",
    "1) 先核对上面的检查点与工作目录里的实际文件，**以磁盘为准**；检查点说写了但文件不在，就当没写。",
    "2) 只做检查点里的未尽事项，不要重复已完成的工作，不要重写已存在的产物。",
    resumed
      ? "3) 你会接上上一段的会话，上下文还在，不必复述已完成部分。"
      : "3) 你是新会话（这一面没有会话级续跑），状态只能靠上面的检查点与工作目录恢复；需要细节时去读工作目录里的文件，别猜。",
    `4) 段末若任务已完成，正常收尾；若再次逼近步数或时间上限，先更新工作目录根部的 ${CP_NAME}：已完成 / 现存产物文件 / 下一步（三步以内、可直接执行）。`,
  ].join("\n");
}

// 供单测：把纯文本判据集中一处，免得 daemon 里散落字符串比较。
export function shouldStopSegmenting({ ok, segment, total, killedBy, stopFilePresent, supplyLatched, starved }) {
  if (ok) return "本段已成功，无需续跑";
  if (killedBy === "manual") return "人工掐死（bridge-ctl kill），不再续跑";
  if (stopFilePresent) return "STOP 在位，调度暂停";
  if (supplyLatched) return "供应方熔断，续跑也是白烧";
  if (starved) return "输出预算饿死（落笔前被切成环），续跑只是再烧一遍预算";
  if (segment >= total) return `分段用尽（${total} 段）仍未收敛`;
  return null; // null = 可以再起一段
}

/**
 * 调用点硬闸：段号一旦越过本卡预算或全局封顶，无论判据（shouldStopSegmenting）说什么都不再起段。
 * 判据是一个可以写反的纯函数（2026-10-01 P0：`if (ok) return null` ⇒ 成功反而无限分段，
 * 7 段 / 29 步 / 466,241 token 烧在一段已完成的活上）。这条用的是另一条独立算出来的界，
 * 两件事同时错才会漏，且错的那件不再等于烧钱。
 */
export function segmentOverrun({ segment, total }) {
  return segment > total || segment > SEGMENT_CAP;
}
