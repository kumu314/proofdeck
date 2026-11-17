// codex adapter — headless `codex exec`.
// Prompt is fed via stdin (NEVER argv: long Chinese text corrupts through
// shells on this box). Result is taken from the per-run `-o` file (no races).
// `-p/--profile` is deliberately unused: 0.147 ProfileV2 silently no-ops
// against this machine's legacy inline [profiles.*].
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function probeModel(agentCfg) {
  try {
    const toml = readFileSync(agentCfg.modelProbe.file, "utf8");
    const head = toml.split(/^\s*\[/m)[0]; // top-level keys only
    const model = /^\s*model\s*=\s*"([^"]+)"/m.exec(head)?.[1] ?? null;
    const provider = /^\s*model_provider\s*=\s*"([^"]+)"/m.exec(head)?.[1] ?? "openai";
    return { model, provider, source: agentCfg.modelProbe.file };
  } catch {
    return { model: null, provider: null, source: "probe-failed" };
  }
}

export function buildRun({ agentCfg, runDir, promptFile, workdir, fm }) {
  const lastMsg = join(runDir, "last-message.txt");
  const args = [agentCfg.script, "exec",
    "-C", workdir,
    "-s", fm.sandbox || agentCfg.sandbox || "workspace-write",
    "--json",
    "-o", lastMsg,
    ...(agentCfg.extraArgs ?? [])];
  if (fm.model) args.push("-m", fm.model);
  if (fm.provider && !fm.model) args.push("-c", `model_provider="${fm.provider}"`);
  args.push("-"); // read prompt from stdin
  return {
    exe: agentCfg.node ?? "node",
    args,
    cwd: workdir,
    stdinFile: promptFile,
    lastMsgFile: lastMsg,
    env: { ...(agentCfg.env ?? {}) },
  };
}

/**
 * 分段续跑（#29）：codex 是四面里唯一有原生会话续跑的（`codex exec resume <SESSION_ID> [PROMPT]`，
 * 实测 --help 于 2026-09-29）。接上原 thread ⇒ 模型上下文不必靠检查点文本重建，
 * 本段的 prompt 就是「原题 + 检查点」那段续跑题面（走 stdin，与首段同一条通道）。
 * 注意 resume 子命令没有 -C/-s：工作目录靠 spawn 的 cwd（runner 已按 workdir 起），
 * 沙箱改用配置键 sandbox_mode 传，值与首段同源。
 */
export function resumeSpec(o) {
  const threadId = o.resume?.threadId;
  if (!threadId) return null;
  const { agentCfg, runDir, promptFile, workdir, fm } = o;
  const lastMsg = join(runDir, "last-message.txt");
  return {
    exe: agentCfg.node ?? "node",
    args: [agentCfg.script, "exec", "resume", threadId,
      "--json",
      "-o", lastMsg,
      "-c", `sandbox_mode="${fm.sandbox || agentCfg.sandbox || "workspace-write"}"`,
      ...(agentCfg.extraArgs ?? []),
      "-"],
    cwd: workdir,
    stdinFile: promptFile,
    lastMsgFile: lastMsg,
    env: { ...(agentCfg.env ?? {}) },
    resumed: true,
  };
}

/** Parse one codex --json JSONL line. Returns {milestone?, threadId?, raw}. */
export function parseEvent(line) {
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  const t = obj.type ?? obj.msg?.type ?? null;
  const out = { raw: obj };
  if (t === "thread.started" || obj.thread_id) out.threadId = obj.thread_id ?? obj.id ?? null;
  if (t === "turn.started") out.milestone = "turn-started";
  if (t === "turn.completed") out.milestone = "turn-completed";
  // 错误项不是进展：实测配额墙那轮（temp/segsmoke-*/codex-seg1）有 2 条 item.completed，
  // 两条都是 {"item":{"type":"error"}}，items=2 让 #25 的「0 步进展」条件判不出来，
  // 于是明知供应方停了还会一直重试。
  if (t === "item.completed" && obj.item?.type !== "error") out.milestone = "item";
  return out;
}

export function readResult(run) {
  try {
    if (existsSync(run.lastMsgFile)) return readFileSync(run.lastMsgFile, "utf8").trim();
  } catch { /* fall through */ }
  return null;
}

/**
 * 兜底源：codex 自己落盘会话轨迹 sessions/YYYY/MM/DD/rollout-<时间>-<thread_id>.jsonl，
 * 里面每完成一次模型调用就追加一条 event_msg/payload.type="token_count"，带累计 total_token_usage。
 * 被 kill 的轮我们那份 codex.jsonl 没有 turn.completed，但这里往往已经写到了最后一步。
 * 口径已对照过：三个两边都有的历史轮，input/cached/output/total 逐字段完全相等（见 out/ 里的说明）。
 */
function rolloutUsage(raw, agentCfg) {
  const threadId = (() => {
    for (const line of raw.split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      const id = ev.thread_id ?? ev.msg?.thread_id;
      if (id) return String(id).toLowerCase();
    }
    return null;
  })();
  if (!threadId) return null;

  const home = agentCfg?.env?.CODEX_HOME || process.env.CODEX_HOME || join(homedir(), ".codex");
  const sess = join(home, "sessions");
  if (!existsSync(sess)) return null;

  // 文件名里带 thread_id ⇒ 定位是精确匹配；目录只有 年/月/日 三层，走穿也不贵。
  // 只在缺 turn.completed 时才会走到这里，正常轮不碰这块磁盘扫描。
  let file = null;
  const walk = (d, depth) => {
    if (file || depth > 4) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.toLowerCase().includes(threadId)) { file = p; return; }
    }
  };
  walk(sess, 0);
  if (!file) return null;

  let last = null, counts = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const tt = ev?.payload?.type === "token_count" ? ev.payload.info?.total_token_usage : null;
    if (!tt) continue;
    counts++;
    last = tt; // 累计口径，取最后一条即整轮总量
  }
  if (!last) return { found: file, usage: null, counts };
  return { found: file, counts, usage: last };
}

/**
 * 权威用量：优先 codex.jsonl 里 type="turn.completed" 那条的顶层 usage（实测一次 run 恰好一条）。
 * 多条就相加，防未来一轮变多轮时漏记。
 * input_tokens 按 OpenAI Responses 口径已含 cached_input_tokens ⇒ prompt 直接取它，不再加缓存。
 * 没有 turn.completed（跑一半被 kill、连接超时）⇒ 退到 rollout 的 token_count 累计值。
 */
export function readUsage({ runDir, agentCfg }) {
  const file = join(runDir, "codex.jsonl");
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8");
  let acc = null, turns = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const u = ev?.type === "turn.completed" ? ev.usage : null;
    if (!u) continue;
    turns++;
    acc ??= { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
    acc.input += u.input_tokens ?? 0;
    acc.cached += u.cached_input_tokens ?? 0;
    acc.cacheWrite += u.cache_write_input_tokens ?? 0;
    acc.output += u.output_tokens ?? 0;
    acc.reasoning += u.reasoning_output_tokens ?? 0;
  }
  if (!acc) {
    // resume 段不能走 rollout 兜底：那条轨迹按 thread 累计，一个 thread 跑了 k 段就含 k 段的量，
    // 当成「本段用量」会把上一段的 token 记到这一段头上。宁可 missing，也不给一个跨段的假数。
    const resumedRun = (() => {
      try { return !!JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8")).resumed; } catch { return false; }
    })();
    const ro = resumedRun ? null : rolloutUsage(raw, agentCfg);
    if (ro?.usage) {
      const u = ro.usage;
      return {
        source: "rollout:token_count",
        // 一条 token_count = 一次模型调用回报 ⇒ 这个数能当步数用
        steps: ro.counts || null, maxSteps: null, overflow: null,
        normalized: {
          prompt: u.input_tokens ?? 0, completion: u.output_tokens ?? 0,
          cached: u.cached_input_tokens ?? 0, cacheWrite: u.cache_write_input_tokens ?? 0,
          reasoning: u.reasoning_output_tokens ?? 0,
        },
        total: u.total_tokens ?? null,
        semantics: "兜底自 codex 会话轨迹的累计值；正在飞的最后一次调用没回报 ⇒ 是下界",
        raw: u,
      };
    }
    // 两份权威产物都查过了：我们那份没 turn.completed，rollout 里一条 token_count 都没有
    // （实测：第一次调用还没回报就被掐的那几次）。token 确实烧了却再也量不到
    // ⇒ 交 normalizeUsage 落成 missing，不许当 0。
    return {
      source: `codex.jsonl+rollout${resumedRun ? "(resume 段：rollout 累计值跨段不可拆，不采用)" : ro ? "(0 条 token_count)" : "(rollout 未找到)"}`,
      steps: null, maxSteps: null, overflow: null,
    };
  }
  return {
    source: "codex.jsonl:turn.completed",
    steps: turns || null, maxSteps: null, overflow: null,
    normalized: { prompt: acc.input, completion: acc.output, cached: acc.cached, cacheWrite: acc.cacheWrite, reasoning: acc.reasoning },
    semantics: "input_tokens 含缓存（Responses 口径）",
    raw: acc,
  };
}
