// Acceptance verification V1 (the verification engine).
// Tasks declare acceptance and scheduling metadata in a ```bridge fenced block
// inside their description; the bridge judges it before the done transition —
// a claim by the executing agent does not count. FAIL rejects done: the task
// returns to open for automatic redispatch, and a face that keeps failing gets
// circuit-broken.
//
// Acceptance also exists as a first-class column on the board (see board/),
// which is preferred when present; the fenced block remains the
// backwards-compatible surface for boards without the column.
//
// 围栏格式（任务书正文任意位置，取第一个块）：
// ```bridge
// { "priority": "P1", "retry": {"max": 2},
//   "acceptance": { "baseDir": "/abs/path/to/repo", "checks": [ ... ] } }
// ```
// 检查类型（fail-closed：未知类型记 FAIL，不许静默放行；相对路径按 baseDir 解析，
// baseDir 缺省为本次运行的 workdir）：
//   fileExists      {path, minBytes?}        文件存在且 ≥ minBytes（默认 1 字节）
//   countAtLeast    {path, jsonPath, min}    JSON 取值是数组→长度、数字→值，须 ≥ min
//   countOccurrences{path, text, minCount?}  文本中字面量子串出现次数 ≥ minCount（默认 1）
//     —— 刻意不做正则：模式来自任务书文本，动态正则既不可控（ReDoS）又是注入面；
//        V1 只需要「数结构标记出现几次」这种朴素能力。
// 防刷分检查（2026-10-07，SpecBench 教训：声明式检查可被针对性刷穿，差距随规模每
// 十倍增 27-28pp；组合一致性迫使刷单必须整条链一起伪造）：
//   countMatches    {path, jsonPath, withPath, withJsonPath, min?}
//                            两份 JSON 取值（数组→长度、数字→值）必须相等且 ≥ min（默认 1）
//   referencesExist {path, jsonPath, baseDir?}
//                            JSON 取值须为字符串数组，每个引用按 baseDir（缺省检查根）解析后
//                            必须真实存在为文件；列表为空也记 FAIL（fail-closed）
// 记录：结构化 note「[[verify]] key=… verdict=… level=V1 by=… checks=n/m」+ 逐项证据。
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { retryDecision } from "./schedule.js";
import { left } from "./supply.js";

const cap = (s, n = 200) => (typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s);

export function parseBridgeBlock(description) {
  if (!description || typeof description !== "string") return null;
  const m = description.match(/```bridge\s*\n([\s\S]*?)```/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]);
    return j && typeof j === "object" && !Array.isArray(j) ? j : null;
  } catch { return null; }
}

function walkJsonPath(obj, path) {
  if (typeof path !== "string" || !path.trim()) return undefined;
  const parts = path.replace(/^\$\.?/, "").split(".").filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    const m = part.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (m?.[1]) cur = cur[m[1]];
    for (const idx of (m?.[2]?.match(/\d+/g) ?? [])) cur = cur?.[Number(idx)];
  }
  return cur;
}

// 字面量子串计数（非重叠），计数封顶 10 万防病态输入。
function countLiteral(hay, needle) {
  let n = 0, i = 0;
  while (n < 100000) {
    const j = hay.indexOf(needle, i);
    if (j === -1) break;
    n++;
    i = j + needle.length;
  }
  return n;
}

const PASS = (type, target, evidence) => ({ type, target, pass: true, evidence });
// invalid=true = 验收标准本身写错（未知类型/缺字段），不是工件不合格——调用方据此
// 区分处置：spec 类不罚面、不烧重试，打回任务作者修正后 requeue。
const FAIL = (type, target, evidence, invalid = false) => ({ type, target, pass: false, evidence, invalid });

const resolvePath = (p, root) =>
  (typeof p === "string" && p && (p.includes(":") || p.startsWith("/") || p.startsWith("\\"))) ? p : (p ? join(root, p) : null);

// JSON 取值→计数（数组→长度、数字→值），其余视为不可计数。
function readCount(p, jsonPath) {
  const j = JSON.parse(readFileSync(p, "utf8"));
  const v = walkJsonPath(j, jsonPath);
  const n = Array.isArray(v) ? v.length : (typeof v === "number" ? v : NaN);
  if (!Number.isFinite(n)) throw Object.assign(new Error(`值不可计数（${v === undefined ? "路径未命中" : typeof v}）`), { spec: true });
  return n;
}

function runCheck(c, root) {
  const type = c?.type ?? "unknown";
  const target = c?.path ?? c?.jsonPath ?? "?";
  try {
    if (type === "fileExists") {
      const p = resolvePath(c.path, root);
      if (!p) return FAIL(type, target, "缺 path", true);
      const st = statSync(p);
      if (!st.isFile()) return FAIL(type, p, "不是文件");
      const min = Number(c.minBytes ?? 1);
      return st.size >= min ? PASS(type, p, `${st.size}B`) : FAIL(type, p, `${st.size}B < minBytes ${min}`);
    }
    if (type === "countAtLeast") {
      const p = resolvePath(c.path, root);
      if (!p) return FAIL(type, target, "缺 path", true);
      const j = JSON.parse(readFileSync(p, "utf8"));
      const v = walkJsonPath(j, c.jsonPath);
      const n = Array.isArray(v) ? v.length : (typeof v === "number" ? v : NaN);
      if (!Number.isFinite(n)) return FAIL(type, `${p} ${c.jsonPath ?? ""}`, `值不是数组或数字（${v === undefined ? "路径未命中" : typeof v}）`);
      const min = Number(c.min);
      return n >= min ? PASS(type, `${p} ${c.jsonPath ?? ""}`, `${n} ≥ ${min}`) : FAIL(type, `${p} ${c.jsonPath ?? ""}`, `got ${n} < ${min}`);
    }
    if (type === "countOccurrences") {
      const p = resolvePath(c.path, root);
      if (!p) return FAIL(type, target, "缺 path", true);
      const needle = c.text;
      if (typeof needle !== "string" || !needle) return FAIL(type, target, "缺 text（要计数的是字面量子串）", true);
      const hay = readFileSync(p, "utf8");
      const count = countLiteral(hay, needle);
      const min = Number(c.minCount ?? 1);
      return count >= min
        ? PASS(type, `${p} 「${cap(needle, 40)}」`, `${count} ≥ ${min}`)
        : FAIL(type, `${p} 「${cap(needle, 40)}」`, `出现 ${count} < ${min}`);
    }
    if (type === "countMatches") {
      const p1 = resolvePath(c.path, root);
      const p2 = resolvePath(c.withPath, root);
      if (!p1 || !p2) return FAIL(type, target, "缺 path 或 withPath", true);
      if (!c.jsonPath || !c.withJsonPath) return FAIL(type, target, "缺 jsonPath / withJsonPath", true);
      const n1 = readCount(p1, c.jsonPath);
      const n2 = readCount(p2, c.withJsonPath);
      const min = Number(c.min ?? 1);
      if (n1 !== n2) return FAIL(type, `${p1} ↔ ${p2}`, `不一致：${n1} ≠ ${n2}`);
      return n1 >= min
        ? PASS(type, `${p1} ↔ ${p2}`, `${n1} = ${n2} ≥ ${min}`)
        : FAIL(type, `${p1} ↔ ${p2}`, `相等但 ${n1} < min ${min}`);
    }
    if (type === "referencesExist") {
      const p = resolvePath(c.path, root);
      if (!p) return FAIL(type, target, "缺 path", true);
      if (!c.jsonPath) return FAIL(type, target, "缺 jsonPath（指向引用列表的路径）", true);
      const j = JSON.parse(readFileSync(p, "utf8"));
      const v = walkJsonPath(j, c.jsonPath);
      const refs = Array.isArray(v) ? v : [v];
      if (!refs.length || refs.some((r) => typeof r !== "string" || !r.trim())) {
        return FAIL(type, `${p} ${c.jsonPath}`, `引用列表为空或含非字符串项（共 ${refs.length} 项）`);
      }
      const refBase = resolvePath(c.baseDir, root) ?? root;
      const missing = [];
      for (const r of refs) {
        const rp = resolvePath(r, refBase);
        try {
          if (!statSync(rp).isFile()) missing.push(r);
        } catch {
          missing.push(r);
        }
        if (missing.length >= 3) break;
      }
      return missing.length === 0
        ? PASS(type, `${p} ${c.jsonPath}`, `${refs.length} 个引用全部存在`)
        : FAIL(type, `${p} ${c.jsonPath}`, `${refs.length} 个引用中存在缺失（示例：${missing.map((m) => cap(m, 60)).join(", ")}${refs.length - missing.length > 3 ? " …" : ""}）`);
    }
    return FAIL(type, target, `未知检查类型「${type}」（fail-closed）`, true);
  } catch (e) {
    return FAIL(type, String(target), e.code === "ENOENT" ? "不存在" : cap(e.message, 160));
  }
}

// 返回 null = 无可执行的 V1 检查（无 acceptance / 空 checks / mode=human（V3 队列未建，
// 本阶段按 legacy 放行，调用方记日志））；否则 {pass, checks, mode}。
export function evaluateAcceptance({ acceptance, baseDir } = {}) {
  if (!acceptance || typeof acceptance !== "object") return null;
  if (acceptance.mode === "human") return null;
  const checks = Array.isArray(acceptance.checks) ? acceptance.checks : [];
  if (!checks.length) return null;
  const root = acceptance.baseDir ?? baseDir ?? process.cwd();
  const results = checks.map((c) => runCheck(c, root));
  return { pass: results.every((r) => r.pass), checks: results, mode: acceptance.mode ?? "auto" };
}

export function formatVerifyNote({ key, verdict, checks = [], by = "bridge" }) {
  const passed = checks.filter((c) => c.pass).length;
  const head = `[[verify]] key=${key} verdict=${verdict} level=V1 by=${by} checks=${passed}/${checks.length}`;
  if (verdict === "PASS") return head;
  return [head, ...checks.filter((c) => !c.pass).map((c) => `· FAIL ${c.type} ${cap(c.target, 120)} — ${cap(c.evidence, 200)}`)].join("\n");
}

const failingLines = (v) => v.checks.filter((c) => !c.pass).map((c) => `· ${c.type} ${cap(c.target, 120)} — ${cap(c.evidence, 200)}`).join("\n") || "（无逐项证据）";

export function applyVerifyPass({ b, io, ID, key, v }) {
  io.note(b, ID, formatVerifyNote({ key, verdict: "PASS", checks: v.checks, by: ID }));
  // 结构化裁决落链（kind=verify）；旧 dist 无 verify API 时 io.verify 为 undefined，可选调用跳过。
  io.verify?.(b, ID, key, "pass", { level: "V1", summary: `verify PASS ${key} (V1)`, checks: v.checks });
}

// 验收未通过的完整处置（在 execute() 的写板回调内调用，io = lib/board.js）。
// 与调度层共用重试台账：未用尽 → 回 open + 退避重派；用尽 → 落 blocked + 该面按
// 「verification」类熔断（复用供应熔断机器，到期自动放探针）。
export function applyVerifyFail({ b, io, store, ID, owner, key, agent, task, v, maxAttempts, baseMs, maxDelayMs, holdBase, holdMax, now }) {
  const attempts = store.s.retries?.[key]?.n ?? 0;
  const d = retryDecision({ why: "验收未通过（V1）", attempts, maxAttempts, baseMs, maxDelayMs });
  const creator = task?.createdBy ?? owner;
  const note = formatVerifyNote({ key, verdict: "FAIL", checks: v.checks, by: ID });
  io.verify?.(b, ID, key, "fail", { level: "V1", summary: `verify FAIL ${key} (V1)`, checks: v.checks });
  if (d.retry) {
    (store.s.retries ??= {})[key] = { n: d.attempt, dueAt: now + d.delayMs, agent, why: "verify-fail", lastAt: now };
    io.setStatus(b, ID, key, "open");
    io.note(b, ID, `[${ID}→${agent}] ${note}\n· 不接受 done，任务回 open；${left(d.delayMs)} 后自动重派（第 ${d.attempt}/${maxAttempts} 次）`);
    io.message(b, ID, creator, `[${ID}] 任务 ${key} 执行完成但未通过验收（V1）：\n${failingLines(v)}\n已回 open，将于 ${left(d.delayMs)} 后自动重派（第 ${d.attempt}/${maxAttempts} 次）。`);
    return { outcome: "retry-scheduled", attempts: d.attempt, delayMs: d.delayMs };
  }
  const streak0 = store.supplyGet(agent)?.streak ?? 0;
  const latch = store.supplyLatch(agent, {
    category: "verification", label: "连续验收不通过", key, to: creator, runDir: null,
    evidence: failingLines(v), evidenceFile: "verify:v1",
    holdMs: Math.min(holdBase * 2 ** streak0, holdMax),
  });
  delete store.s.retries?.[key];
  io.setStatus(b, ID, key, "blocked");
  io.note(b, ID, `[${ID}→${agent}] ${note}\n· 自动重派用尽（${maxAttempts} 次）仍不过验收 → 落 blocked；${agent} 面按「验收不通过」熔断 ${left(latch.holdMs)}（第 ${latch.streak} 次），到期自动放探针。`);
  io.message(b, ID, creator, `[${ID}] 任务 ${key} 重派 ${maxAttempts} 次仍未通过验收，已落 blocked，需要你处置：放宽或修正验收标准后 requeue，或人工检查工件。证据：\n${failingLines(v)}`);
  return { outcome: "exhausted", streak: latch.streak, holdMs: latch.holdMs };
}
