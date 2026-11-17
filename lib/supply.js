// Supply-error sentinel: tell "the model/face is broken" apart from
// "the API key/credit behind it is gone", from the artifacts a run left behind.
//
// Why this exists (measured, 2026-09-26, one long-running task): the task burned a
// full dispatch and the board only said `FAILED rc=0` — trae exits 0 even when
// every LLM call returned 402. The real cause sat in one place:
//   trae.traj.json -> agent_steps[0].error =
//   "Error code: 402 - {'error': {'message': 'Insufficient Balance (request_id: …)' …"
// rc=0 + a text-free failure note is the worst case for a dispatcher: it looks
// retryable, so the same dead key gets re-fed task after task.
//
// We scan the run *directory* rather than hooking each adapter: a new face then
// needs no adapter change to be covered, and the wording usually reaches disk in
// at least one artifact (jsonl / trajectory / stderr).
//
// Deliberately NOT matched: bare digits. `402` alone fires on step counts, byte
// counts and port numbers all over these files, so every numeric rule needs
// error-shaped context. The phrase rules carry their own context.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const SUPPLY_RULES = [
  // category=billing — spend what you have, get told no. Retrying is pure loss.
  { category: "billing", label: "Insufficient Balance", re: /insufficient\s*balance/i },
  { category: "billing", label: "insufficient_quota", re: /insufficient[_\s]quota/i },
  { category: "billing", label: "余额不足", re: /余额不足|欠费|额度不足/ },
  { category: "billing", label: "quota exceeded", re: /quota\s*(exceeded|exhausted|exceeded)/i },
  { category: "billing", label: "billing hard limit", re: /billing\s*hard\s*limit|out\s*of\s*credits/i },
  { category: "billing", label: "status 402", re: /\b(?:error\s*code|status(?:\s*code)?|http)\D{0,12}\b402\b/i },
  // 订阅额度到顶：实测 codex 2026-09-29 回「You've hit your usage limit … try again at Oct 4th」，
  // 不给 402 也不给 429，只给一句人话 ⇒ 不进表就会每张卡重试一次，一直重试到恢复日。
  { category: "billing", label: "usage limit（订阅额度到顶）", re: /usage\s*limit|hit\s*your\s*limit/i },

  // category=auth — key missing/rotated/wrong audience. Also not retryable, but
  // fixed by a human action rather than by buying credit.
  { category: "auth", label: "invalid api key", re: /invalid\s+api\s*key|incorrect\s+api\s*key|invalid_api_key/i },
  { category: "auth", label: "unauthorized", re: /\bunauthorized\b/i },
  { category: "auth", label: "authentication error", re: /authentication\s*(error|failed|problem)|missing authentication/i },
  { category: "auth", label: "status 401", re: /\b(?:error\s*code|status(?:\s*code)?|http)\D{0,12}\b401\b/i },
  { category: "auth", label: "status 403", re: /\b(?:error\s*code|status(?:\s*code)?|http)\D{0,12}\b403\b/i },

  // category=rate — transient by design: hold, then retry.
  { category: "rate", label: "rate limit", re: /rate\s*limit|too\s*many\s*requests|throttl/i },
  { category: "rate", label: "status 429", re: /\b(?:error\s*code|status(?:\s*code)?|http)\D{0,12}\b429\b/i },
];

const TEXT_EXT = /\.(jsonl|json|txt|log|md|yaml|yml|err|out)$/i;
const FILE_CAP = 2 * 1024 * 1024; // per file: sentinels must not become an I/O tax
const SCAN_CAP = 8 * 1024 * 1024; // per run dir, in file order
const LINE_MAX = 400;

const oneLine = (s) => s.replace(/\s+/g, " ").trim().slice(0, LINE_MAX);

/**
 * scanRunDir(runDir) -> {category, label, file, line} | null
 * First rule that hits wins; numeric rules carry their own context so a match is
 * quotable evidence, not a guess.
 */
export function scanRunDir(runDir) {
  let names;
  try { names = readdirSync(runDir); } catch { return null; }
  let budget = SCAN_CAP;
  for (const name of names) {
    if (budget <= 0) break;
    let size = 0;
    try {
      const st = statSync(join(runDir, name));
      if (!st.isFile() || !TEXT_EXT.test(name)) continue;
      size = st.size;
    } catch { continue; }
    const take = Math.min(size, FILE_CAP, budget);
    budget -= take;
    let text;
    try { text = readFileSync(join(runDir, name), { encoding: "utf8" }).slice(0, take); } catch { continue; }
    for (const rule of SUPPLY_RULES) {
      const m = rule.re.exec(text);
      if (!m) continue;
      // widen the hit into its surrounding line so the board text is verifiable
      const at = m.index;
      const from = Math.max(0, text.lastIndexOf("\n", at - 1) + 1);
      const to = (() => { const i = text.indexOf("\n", at); return i < 0 ? text.length : i; })();
      return { category: rule.category, label: rule.label, file: name, line: oneLine(text.slice(from, to)) || oneLine(m[0]) };
    }
  }
  return null;
}

/** Human sentence for the board. Keeps the quoted evidence line, no editorialising. */
export function supplyReason(hit) {
  if (!hit) return null;
  const head = hit.category === "billing" ? "供应方额度/账单耗尽"
    : hit.category === "auth" ? "供应方鉴权失败（key 失效或未配）"
      : hit.category === "rate" ? "供应方限流"
        : hit.category;
  return `${head}〔${hit.label}〕`;
}

// 时长写法：不足 90 秒一律用秒。板与日志里出现「暂停派发 0 分钟」会被读成「根本没冻」，
// 出现「剩 1min」而实为 5 秒会让人怀疑 hold 逻辑没生效。
export const hold = (ms) => (ms < 90000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}min`);
export const left = (ms) => (ms < 90000 ? `${Math.max(1, Math.ceil(ms / 1000))}s` : `${Math.ceil(ms / 60000)}min`);
