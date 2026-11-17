// gating.next.js — 候选补丁 v2：否定语境豁免 + 词边界 + 路径遮蔽 + 词分级。
// **未生效** —— 生产用的仍是 lib/gating.js（09-25 原版）。
//
// 改动全部集中在 decide() 内部，对外 API 与 gating.js 完全一致。
// 四个问题、四个手段，按准确度排列：
//
//  ① 否定语境误伤（lib/gating.js L79 的 hay.includes(w) 分不清「推送」与「不推送」）
//     → 前置 + 后置否定窗口
//  ② ASCII 词无边界的子串误伤（max_tokens 命中 token；SEC_E_NO_CREDENTIALS 命中 credential）
//     → ASCII 词一律走 \b 词边界。CJK 无「词」概念，仍用子串。
//  ③ 非散文文本误伤（任务书里的 Windows 路径 …-stamp-deploy.md 命中 deploy）
//     → 扫描前把路径/URL 遮蔽成等长 \0，保下标不变（否定窗口仍能正确取前后文）
//  ④ 真险词与易误伤词不分级（25 个词一视同仁地硬拦）
//     → TIER1 真险硬拦；TIER2 命中只写板面 note 不 park。
//
// 边界（已知残留，故意不治）：
//  · POST 否定窗口刻意保持紧邻。放宽能多救 2 条（F05/F06），但会让
//    「部署之后不动任何配置」被误豁免 —— 误伤是效率损失，漏放是安全事故。
//    e2e/test-gating-negation.mjs 的 N07/N08 就是钉住这条边界的反面对照。
//  · TIER2 的发布类词一旦降到 note，就不再硬拦「真实部署」——这是**有意的安全降级**，
//    换取的是不再为 5 类非语义命中反复作废重开卡。是否接受由人拍板。

import { readFileSync, existsSync } from "node:fs";

const DISPATCH_PATH_RE = /[A-Za-z]:[\\/][^\s"'`<>|]*?\.md/gi;

// ---- ① 否定语境 ----
// v2.1 规则收紧：否定标记必须**紧邻**禁词（其后最多 1 个空白），不再「往回看 12 字符」。
// 反面对照：「确认无误后 force push」里的「无误」不是对 force push 的否定 ——
// 宽窗口会把它误豁免（实测由 N11 抓出）。中文里 无/非/只/仅/免 大量存在于
// 无误/非常/只有/不仅/免费 等词内部，按字符回看必然误判。
// 单字否定标记（无/非/未/仅/只）在**紧邻**规则下是安全的：「无凭据」豁免，
// 而「确认无误后 force push」的「无」不紧邻 force push，仍会拦（N11 守住这条）。
const NEG_BEFORE = /(?:^|[^A-Za-z0-9_])(不|勿|禁|免|无|非|未|仅|只|不得|禁止|不能|不可|不再|不会|无需|无须|一律不|只读)\s{0,1}$/;
const NEG_AFTER  = /^\s{0,1}(不动|不进|不写|不上|不改|不删|不推|不发|不部署|不安装|不提交|不碰|后补|后再|后统一|再补)/;
// 已知残留（故意不治）：否定词与禁词之间隔了字时无法识别，例如
//   「SECRET 一行不动」「SECRET/data.sqlite 不进仓库」
// 放宽间隔能救，但会把「部署之后不动任何配置」误豁免 —— 误伤是效率损失，
// 漏放是安全事故。N07/N08 两颗钉子就是守住这条边界的。

const PRE_WINDOW = 16;
const POST_WINDOW = 12;

// ---- ② 词边界 ----
// 只给「首尾都是词字符」的 ASCII 词加 \b。
// 反面对照：`--force` 的首字符 `-` 是非词字符，`\b--force\b` 永远不匹配 ——
// 无差别套 \b 会把 `git push --force` 这类真险写法直接放过（实测由 N09 用例抓出）。
const ASCII_TOKEN = /^[\x20-\x7e]+$/;
const WORDY_EDGE = /^[A-Za-z0-9_]/;
const needsBoundary = (w) => ASCII_TOKEN.test(w) && WORDY_EDGE.test(w[0]) && WORDY_EDGE.test(w[w.length - 1]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const reCache = new Map();
function tokenRe(w) {
  if (reCache.has(w)) return reCache.get(w);
  // CJK 或首尾带标点 → null ⇒ 退回无边界子串
  const re = needsBoundary(w) ? new RegExp(`\\b${escapeRe(w)}\\b`, "g") : null;
  reCache.set(w, re);
  return re;
}

// ---- ③ 非散文遮蔽（等长 \0，保下标）----
const PATH_RE = /[A-Za-z]:[\\/][^\s，。；、"'<>|]*/g;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/g;
const BLANK = "\u0000";
export function maskNonProse(s) {
  const blank = (m) => BLANK.repeat(m.length);
  return String(s ?? "").replace(PATH_RE, blank).replace(URL_RE, blank);
}

export function hasUnnegatedHit(hay, w) {
  const re = tokenRe(w);
  if (!re) {                                  // CJK：子串 + 否定窗口
    let i = hay.indexOf(w);
    while (i !== -1) {
      const pre = hay.slice(Math.max(0, i - PRE_WINDOW), i);
      const post = hay.slice(i + w.length, i + w.length + POST_WINDOW);
      if (!NEG_BEFORE.test(pre) && !NEG_AFTER.test(post)) return true;
      i = hay.indexOf(w, i + w.length);
    }
    return false;
  }
  for (const m of hay.matchAll(re)) {         // ASCII：词边界 + 否定窗口
    const i = m.index;
    const pre = hay.slice(Math.max(0, i - PRE_WINDOW), i);
    const post = hay.slice(i + w.length, i + w.length + POST_WINDOW);
    if (!NEG_BEFORE.test(pre) && !NEG_AFTER.test(post)) return true;
  }
  return false;
}

// ---- ④ 词分级（cfg.gating.tokenTier 可覆盖；不配就用这份默认）----
export const DEFAULT_TIER = {
  // 真险：破坏性操作 + 凭据泄露。命中即 park，等人工批准。
  hard: ["rm -rf", "drop table", "delete", "--force", "force push",
         "danger-full-access", "bypass", "api_key", "password",
         "删除", "密码", "密钥", "生产环境"],
  // 易误伤：这些词本身不一定是坏事，取决于语境。命中只记 note，不 park。
  soft: ["install", "publish", "deploy", "credential", "secret", "token",
         "上架", "推送", "发布", "部署", "安装", "凭据"],
};
export function resolveTiers(cfg) {
  const t = cfg?.tokenTier ?? DEFAULT_TIER;
  const hard = new Set((t.hard ?? []).map((s) => s.toLowerCase()));
  const soft = new Set((t.soft ?? []).map((s) => s.toLowerCase()));
  return { hard, soft };
}

export async function faceReachable(agentCfg, ms = 6000) {
  const url = agentCfg?.healthUrl;
  if (!url) return true;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    await fetch(url, { signal: ac.signal, redirect: "manual" }).finally(() => clearTimeout(timer));
    return true;
  } catch {
    return false;
  }
}

export function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.+?)\s*$/.exec(line);
    if (kv) out[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export function findDispatchFiles(texts) {
  const found = [];
  for (const t of texts.filter(Boolean)) {
    for (const m of t.matchAll(DISPATCH_PATH_RE)) {
      const p = m[0].replace(/\//g, "\\");
      if (existsSync(p) && !found.includes(p)) found.push(p);
    }
  }
  return found;
}

const ASCII_ONLY_RE = /^[\x20-\x7E\r\n\t]+$/;
const PRODUCT_NAME_RE = /[^\s"'`<>|、，。：（）()]+(?:\.[A-Za-z][A-Za-z0-9]{0,5})\b/g;

export function nonAsciiProductNames(text) {
  const hay = String(text ?? "");
  if (ASCII_ONLY_RE.test(hay)) return [];
  const hits = new Set();
  for (const m of hay.matchAll(PRODUCT_NAME_RE)) {
    if (!ASCII_ONLY_RE.test(m[0])) hits.add(m[0]);
  }
  return [...hits].slice(0, 8);
}

export function createGating(cfg) {
  const { hard, soft } = resolveTiers(cfg);
  const rest = (cfg.forbiddenTokens ?? [])
    .map((s) => s.toLowerCase())
    .filter((w) => !hard.has(w) && !soft.has(w));
  return {
    /**
     * decide(card, dispatchText) -> {action:'auto'|'stop'|'ask', reason, fm}
     * v2 新增：reason 前缀 [软命中] 时表示 soft 词命中——只记 note，不 park。
     * 调用方（daemon.js L414）目前把任何 'ask' 都 park；接线时须按 softHits 分流，
     * 否则 soft 分级形同虚设。**这是应用本补丁时必须一并改的第二处。**
     */
    decide(card, dispatchText) {
      const task = card.task;
      const fm = dispatchText ? parseFrontMatter(dispatchText) : {};
      const raw = [task.title, task.description, dispatchText].filter(Boolean).join("\n").toLowerCase();
      const hay = maskNonProse(raw);              // ← ③ 遮蔽后再扫
      const risk = (task.riskLevel ?? "").toString().trim().toLowerCase();
      const impact = (task.impact ?? "").toString().trim().toLowerCase();
      const hitHard = [...hard, ...rest].filter((w) => hasUnnegatedHit(hay, w));
      const hitSoft = [...soft].filter((w) => hasUnnegatedHit(hay, w));   // ← ④ 分级

      if (fm.sandbox && fm.sandbox.toLowerCase().includes("danger")) {
        return { action: "ask", reason: "任务书要求 danger 沙箱", fm, softHits: [] };
      }
      if (hitHard.length > 0) {
        return { action: "ask", reason: `命中禁词: ${hitHard.join(", ")}`, fm, softHits: hitSoft };
      }
      if (hitSoft.length > 0) {
        return { action: "soft", reason: `软命中(不拦截): ${hitSoft.join(", ")}`, fm, softHits: hitSoft };
      }
      if ((fm.auto ?? "").match(/^(yes|true|1)$/i)) {
        return { action: "auto", reason: "任务书 auto: 标记", fm, softHits: [] };
      }
      if (!dispatchText) {
        return { action: "ask", reason: "未找到可读的任务书文件", fm, softHits: [] };
      }
      if (!cfg.autoRisk.includes(risk)) {
        return { action: "ask", reason: `risk='${risk || "未填"}' 不在自动白名单`, fm, softHits: [] };
      }
      if (cfg.blockImpact.some((b) => impact.includes(b))) {
        return { action: "ask", reason: `impact='${impact}' 属高危面`, fm, softHits: [] };
      }
      return { action: "auto", reason: `risk=${risk}, 无禁词, 任务书在案`, fm, softHits: [] };
    },
    redact(text) {
      let out = String(text ?? "");
      for (const p of cfg.redactPatterns ?? []) {
        try { out = out.replace(new RegExp(p, "gi"), "[REDACTED]"); } catch { /* skip bad pattern */ }
      }
      return out;
    },
    readDispatch(paths) {
      for (const p of paths) {
        try {
          const t = readFileSync(p, "utf8");
          if (t.trim().length > 0) return { path: p, text: t };
        } catch { /* try next */ }
      }
      return null;
    },
  };
}