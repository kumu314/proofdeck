// #29 分段续跑判据（离线，零 API）：题面按段分叉、检查点两种来源、停手判据表、段号进台账。
// 跑法：node e2e/verify-checkpoint.mjs
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const BASE = join(dirname(fileURLToPath(import.meta.url)), "..");
const U = (p) => pathToFileURL(p).href; // Windows 下裸 D:/ 走 ESM loader 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME
const { maxSegments, capture, renderPriming, shouldStopSegmenting, segmentOverrun, CP_NAME, SEGMENT_CAP } =
  await import(U(`${BASE}/lib/checkpoint.js`));
const { getAdapter } = await import(U(`${BASE}/lib/runner.js`));
const { normalizeUsage, missingUsage } = await import(U(`${BASE}/lib/usage.js`));
const { isStarved, maxStarveRun, starveTotal, isStarveLoop, STARVE_LIMIT } = await import(U(`${BASE}/lib/starve.js`));

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const ROOT = join(BASE, "out", `verify-checkpoint-${TS}`);
mkdirSync(ROOT, { recursive: true });

const checks = [];
const ck = (name, fn) => { try { checks.push([name, fn()]); } catch (e) { checks.push([name, [false, `抛错 ${e.message}`]]); } };

// 题面分叉用真函数：从 daemon.js 源码里抠出 buildPrompt 体，注入同样的 trunc 求值。
// （不复制粘贴一份题面到测试里——那种测试只能证明测试自己没改。）
const src = readFileSync(join(BASE, "daemon.js"), "utf8");
const m = /function buildPrompt\(key, task, dispatch, agent[^)]*\)\s*\{\n([\s\S]*?)\n\}/.exec(src);
if (!m) { console.log("FAIL 取不到 buildPrompt 体，daemon.js 结构变了，这个测试要跟着改"); process.exit(1); }
const trunc = (s, n) => (s.length > n ? s.slice(0, n) + "\n…[截断]" : s);
const buildPrompt = new Function("key", "task", "dispatch", "agent", "totalSegments", "trunc", m[1]);

// ---- 1) segments 解析 ----
ck("不写 segments ⇒ 1 段（今天的行为）", () => [maxSegments({}) === 1, `得 ${maxSegments({})}`]);
ck("segments=1 / 空串 / 垃圾值都按 1 段", () =>
  [maxSegments({ segments: "1" }) === 1 && maxSegments({ segments: "" }) === 1 && maxSegments({ segments: "abc" }) === 1,
    `${maxSegments({ segments: "1" })}/${maxSegments({ segments: "" })}/${maxSegments({ segments: "abc" })}`]);
ck(`segments=5 夹到封顶 ${SEGMENT_CAP}`, () => [maxSegments({ segments: "5" }) === SEGMENT_CAP, `得 ${maxSegments({ segments: "5" })}`]);
ck("segments=3 原样", () => [maxSegments({ segments: "3" }) === 3, `得 ${maxSegments({ segments: "3" })}`]);

// ---- 2) 题面：单段字节不变，分段才提 CHECKPOINT.md ----
const one = buildPrompt("task:t1", { number: 1, title: "T" }, { path: "D:/x.md", text: "正文" }, "codex", 1, trunc);
const two = buildPrompt("task:t1", { number: 1, title: "T" }, { path: "D:/x.md", text: "正文" }, "codex", 2, trunc);
ck("单段题面不提 CHECKPOINT.md", () => [!one.includes(CP_NAME) && one.includes("3) 最后一条回复"), "题面第 4 条漏进单段"]);
ck("分段题面才要求写 CHECKPOINT.md", () => [two.includes(CP_NAME) && two.includes("分 2 段"), "分段了却没写检查点要求"]);
ck("分段只多这一条，前三条一字不差", () => {
  const head = (s) => s.split("\n").filter((l) => /^\d\) /.test(l)).slice(0, 3).join("\n");
  return [head(one) === head(two), "前三条要求被改动了"];
});

// ---- 3) 检查点两种来源 ----
const work = mkdtempSync(join(tmpdir(), "cpwork-"));
mkdirSync(join(work, "sub"), { recursive: true });
writeFileSync(join(work, "answer.md"), "# 答案\n前三题已做", "utf8");
writeFileSync(join(work, "sub", "run_round3.py"), "print(3)", "utf8");
const runDir = join(ROOT, "seg1");
mkdirSync(runDir, { recursive: true });
writeFileSync(join(runDir, "meta.json"), JSON.stringify({ agent: "trae", segment: 1 }), "utf8");

const result1 = { exitCode: 0, killed: false, stalled: false, items: 12, threadId: "thr-abc-123", model: "mimo-v2.6-pro", agentSuccess: false };
const usage1 = { ...missingUsage("trae", "测试用"), steps: 15, maxSteps: 15, overflow: true };

const derived = capture({ agent: "trae", workdir: work, runDir, segment: 1, result: result1, usage: usage1, why: "agent 自报 success=false" });
ck("无 CHECKPOINT.md ⇒ kind=derived 并点名只含事实", () =>
  [derived.kind === "derived" && derived.text.includes("只含事实、不含模型自述"), `kind=${derived.kind}`]);
ck("派生检查点带 workdir 实际文件（含子目录）", () =>
  [derived.text.includes("answer.md") && derived.text.includes("sub/run_round3.py") && derived.fileCount === 2,
    `列到 ${derived.fileCount} 个`]);
ck("派生检查点带上限读数与 thread", () =>
  [derived.text.includes("steps=15/15(达上限)") && derived.text.includes("thr-abc-123") && derived.text.includes("mimo-v2.6-pro"), "漏了用量/thread/model"]);
ck("检查点落盘在本段 runDir 且带段号", () =>
  [derived.file === join(runDir, "checkpoint-seg1.md") && existsSync(derived.file), derived.file]);

writeFileSync(join(work, CP_NAME), "已完成：前三题。现存：answer.md。下一步：做第 4、5 题。", "utf8");
const agentCp = capture({ agent: "trae", workdir: work, runDir, segment: 1, result: result1, usage: usage1, why: "超时被杀" });
ck("有 CHECKPOINT.md ⇒ kind=agent 且正文进检查点", () =>
  [agentCp.kind === "agent" && agentCp.text.includes("做第 4、5 题"), `kind=${agentCp.kind}`]);
ck("agent 自写仍附桥侧事实与文件清单（自述不当唯一依据）", () =>
  [agentCp.text.includes("桥侧事实") && agentCp.text.includes("工作目录实际文件"), "只抄了模型的话"]);

// ---- 4) 下一段题面 ----
const priming = renderPriming({ segment: 2, total: 3, cp: agentCp, why: "agent 自报 success=false", resumed: true });
ck("续跑题面标出段号/死因/检查点路径", () =>
  [priming.includes("第 2/3 段") && priming.includes("success=false") && priming.includes("checkpoint-seg1.md"), "缺锚点"]);
ck("续跑题面要求以磁盘为准核对", () => [priming.includes("以磁盘为准"), "没让下一段核对自述"]);
ck("能续会话与不能续会话的说法不同", () => {
  const fresh = renderPriming({ segment: 2, total: 3, cp: agentCp, why: "rc=1", resumed: false });
  return [priming.includes("接上上一段的会话") && !priming.includes("新会话")
    && fresh.includes("新会话") && !fresh.includes("接上上一段的会话"), "两种说法混了"];
});

// ---- 5) 停手判据表 ----
const T = (o) => shouldStopSegmenting({ ok: false, segment: 1, total: 3, killedBy: null, stopFilePresent: false, supplyLatched: false, ...o });
ck("成功 ⇒ 不再起段", () => [String(T({ ok: true })).includes("成功"), `得 ${T({ ok: true })}`]);
ck("人工掐死 ⇒ 停（人的意图高于段数）", () => [String(T({ killedBy: "manual" })).includes("人工掐死"), "还会续跑"]);
ck("STOP 在位 ⇒ 停", () => [String(T({ stopFilePresent: true })).includes("STOP"), "还会续跑"]);
ck("供应方熔断 ⇒ 停（白烧）", () => [String(T({ supplyLatched: true })).includes("熔断"), "还会续跑"]);
ck("末段仍未收敛 ⇒ 停并说「分段用尽」", () => [String(T({ segment: 3, total: 3 })).includes("分段用尽"), `得 ${T({ segment: 3, total: 3 })}`]);
ck("普通失败 + 还有段数 ⇒ 可以再起一段", () => [T({ segment: 1, total: 2, why: "rc=1" }) === null, `得 ${T({ segment: 1, total: 2 })}`]);
ck("饿死成环 ⇒ 停（对一个纯配置缺陷，续跑只再烧一遍预算）", () =>
  [String(T({ starved: true })).includes("饿死"), "还会续跑"]);
ck("反面对照：starved=false 不该被误当环路，仍可起段", () => [T({ starved: false }) === null, `得 ${T({ starved: false })}`]);

// ---- 5c) 调用点硬闸：判据万一再写反，段号这层也得拦住（P0 回归）----
ck("硬闸：单卡预算 1 段时起第 2 段 ⇒ 拦", () =>
  [segmentOverrun({ segment: 2, total: 1 }) === true && segmentOverrun({ segment: 2, total: 3 }) === false, "拦错或放错"]);
ck("硬闸：越过全局封顶（预算被写大也拦）", () =>
  [segmentOverrun({ segment: SEGMENT_CAP + 1, total: 99 }) === true, `封顶 ${SEGMENT_CAP} 没拦住`]);
ck("反面对照：合法末段不许误拦（seg=total 都要放它跑完）", () =>
  [!segmentOverrun({ segment: 3, total: 3 }) && !segmentOverrun({ segment: SEGMENT_CAP, total: SEGMENT_CAP }) && !segmentOverrun({ segment: 1, total: 1 }), "误拦合法段"]);
ck("P0 回归：seg=2..7 在 total=1 下全部被拦", () =>
  [[2, 3, 4, 5, 6, 7].every((s) => segmentOverrun({ segment: s, total: 1 })), "仍有段能溜过去"]);

// ---- 5b) 饿死判据打在真实轨迹上（零 API，读历史 run 目录；期望值先跑探针量出来，不许猜）----
// OSS 环境没有内部 runs/ 标本 ⇒ 整节显式 SKIP（不许静默算过）；有标本的环境（含 trae 适配器）才跑。
const SPECIMEN = [
  // max_tokens:4096 时代的死循环：14 次调用 6 次饿死、最长连续 4 ⇒ 判死
  { run: "runs/<specimen-4096-loop>", total: 6, best: 4, loop: true },
  // 反面对照：同一预算下 success=true 的轮次，开头连着 2 次截断后自己走通 ⇒ 阈值 3 不误伤
  { run: "runs/<specimen-4096-control>", total: 2, best: 2, loop: false },
  // 抬到 32768 之后：一次都没有
  { run: "runs/<specimen-32768-clean>", total: 0, best: 0, loop: false },
];
const presentSpecimens = SPECIMEN.filter((s) => existsSync(join(BASE, s.run, "trae.traj.json")));
if (presentSpecimens.length === 0) {
  console.log("SKIP 5b 真实轨迹饿死标本（本环境无内部 runs/ 标本；判据逻辑已由 5/5c 的合成用例覆盖）");
}
else {
  const traeAdapter = await import(U(`${BASE}/lib/adapters/trae.js`));
  for (const s of presentSpecimens) {
    ck(`真实轨迹读数 ${s.run}`, () => {
      const f = join(BASE, s.run, "trae.traj.json");
      const li = JSON.parse(readFileSync(f, "utf8")).llm_interactions ?? [];
      const meta = traeAdapter.readMeta({ lastMsgFile: f });
      return [
        starveTotal(li) === s.total && maxStarveRun(li) === s.best && isStarveLoop(li) === s.loop
        && meta.starvedTotal === s.total && meta.starve === s.best,
        `判据 total=${starveTotal(li)} best=${maxStarveRun(li)} loop=${isStarveLoop(li)} / 适配器 ${meta.starvedTotal}/${meta.starve}，期望 ${s.total}/${s.best}/${s.loop}`,
      ];
    });
  }
}
ck("判据不吃 reasoning_tokens（该面轨迹里它恒为 0，仍要判得出来）", () => {
  const mk = (n) => Array.from({ length: n }, () => ({ response: { finish_reason: "length", content: "", tool_calls: [], usage: { reasoning_tokens: 0 } } }));
  return [isStarveLoop(mk(STARVE_LIMIT)) && !isStarveLoop(mk(STARVE_LIMIT - 1)) && isStarved(mk(1)[0].response),
    `阈值错（limit=${STARVE_LIMIT}）`];
});
ck("带 tool_calls 的 length 不算饿死（模型确实在动手，只是这一步没写完）", () => {
  const li = [{ response: { finish_reason: "length", content: "", tool_calls: [{ name: "str_replace_based_edit_tool" }] } }];
  return [!isStarved(li[0].response) && maxStarveRun(li) === 0 && !isStarveLoop(li), "把在落笔的调用误判成饿死"];
});
ck("content 非空的 length 不算饿死（写出了一半）", () =>
  [!isStarved({ finish_reason: "length", content: "写出了一半的正文", tool_calls: [] }), "误判成饿死"]);
ck("fr=stop/tool_calls 永不计入饿死", () =>
  [!isStarved({ finish_reason: "stop", content: "", tool_calls: [] }) && !isStarved({ finish_reason: "tool_calls", content: "", tool_calls: [] }), "误判"]);

// ---- 6) 谁能真续会话：内置参考适配器 codex 有 resumeSpec；未注册面必须显式报错 ----
ck("codex 有 resumeSpec", () => [typeof getAdapter("codex").resumeSpec === "function", "没有"]);
ck("未注册适配器 getAdapter 直接抛错（不静默兜底）", () => {
  try { getAdapter("no-such-face"); return [false, "竟然没抛"]; }
  catch (e) { return [String(e.message).includes("not registered"), e.message]; }
});
ck("codex resumeSpec 无 threadId 时返回 null（退回新会话）", () => {
  const codex = getAdapter("codex");
  return [codex.resumeSpec({ agentCfg: {}, runDir, promptFile: "p", workdir: work, fm: {}, resume: { segment: 2 } }) === null, "没有 threadId 也硬构"];
});
ck("codex resumeSpec 构出 exec resume <thread> + stdin 题面", () => {
  const spec = getAdapter("codex").resumeSpec({
    agentCfg: { node: "node", script: "cx.js", sandbox: "workspace-write", extraArgs: ["--skip-git-repo-check"] },
    runDir, promptFile: join(runDir, "prompt.md"), workdir: work, fm: {}, resume: { threadId: "T-1", segment: 2 },
  });
  const j = spec.args.join(" ");
  return [spec.resumed === true && j.includes("exec resume T-1") && j.includes('--json')
    && j.includes('-c sandbox_mode="workspace-write"') && spec.args.at(-1) === "-" && spec.cwd === work
    && !j.includes(" -C "), `args=${j}`];
});

// ---- 7) 台账：一行一段，段号必须留痕 ----
ck("readUsage 拒绝对 resume 段用 rollout 累计兜底", () => {
  const dir = join(ROOT, "codex-resume-seg");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ agent: "codex", segment: 2, resumed: true }), "utf8");
  writeFileSync(join(dir, "codex.jsonl"), JSON.stringify({ type: "session.config.loaded" }) + "\n", "utf8");
  const codex = getAdapter("codex");
  const u = codex.readUsage({ runDir: dir, agentCfg: { env: { CODEX_HOME: join(ROOT, "fake-codex-home") } } });
  const e = normalizeUsage("codex", u);
  return [e.missing === true && String(e.reason).includes("跨段不可拆") && e.prompt === null,
    `missing=${e.missing} reason=${e.reason}`];
});
ck("段号进台账字段（缺省=1 段，历史行不炸）", () => {
  const line = { ...normalizeUsage("codex", null), segment: 2, segments: 3, resumeFrom: join(ROOT, "seg1") };
  const back = { ...normalizeUsage("codex", null), segment: 1, segments: 1, resumeFrom: null };
  return [line.segment === 2 && line.segments === 3 && back.segment === 1 && back.resumeFrom === null, "段号没并进台账"];
});

// 留档本轮全部产物，出问题能对着看
for (const [n, c] of Object.entries({ "checkpoint-derived.md": derived.text, "checkpoint-agent.md": agentCp.text, "priming-resumed.md": priming })) {
  writeFileSync(join(ROOT, n), c, "utf8");
}

let bad = 0;
for (const [name, [ok, why]] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` —— ${why}`}`);
}
console.log(`\n留档：${ROOT}`);
console.log(bad === 0 ? "CHECKPOINT PASS" : `CHECKPOINT FAIL（${bad} 条不过）`);
process.exit(bad === 0 ? 0 : 1);
