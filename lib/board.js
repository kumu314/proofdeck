// Daemon-side board channel. Uses the SHARED octopus-blackboard Board library
// directly (same code the CLI/MCP run) — never raw SQL, never text parsing.
// Every op opens/closes its own handle (like the MCP server does).
import { pathToFileURL } from "node:url";

let Board = null;

export async function init(pkgDir) {
  const mod = await import(pathToFileURL(pkgDir + "/dist/board.js").href);
  Board = mod.Board;
}

export async function withBoard(boardCfg, fn, sessionId = null) {
  const b = Board.open({ boardDir: boardCfg.dir, agent: boardCfg.identity, ...(sessionId ? { sessionId } : {}) });
  try {
    return await fn(b);
  } finally {
    try { b.close(); } catch { /* already closed */ }
  }
}

// --- thin named helpers (all synchronous over Board) ---
export const head = (b) => b.head();
export const since = (b, cursor) => b.since(cursor);
export const card = (b, key) => b.taskCard(key) ?? null;
export const claim = (b, actor, key) => b.claim(actor, key);
export const progress = (b, actor, key, pct) => b.setProgress(actor, key, pct);
export const done = (b, actor, key) => b.complete(actor, key);
export const setStatus = (b, actor, key, status) => b.setTaskStatus(actor, key, status);
// defineTask：创建或更新卡的 title/description 等字段（key 已存在时只更新传入字段）。
// 2026-10-06 补：billing-convert 要在卡面追加"断供待认领"说明时用；此前 lib/board.js 漏了这个助手。
export const defineTask = (b, actor, key, opts) => b.defineTask(actor, key, opts);
export const note = (b, actor, text) => b.note(actor, text);
export const message = (b, actor, to, body) => b.message(actor, to, body);
export const heartbeat = (b, sessionId) => b.heartbeat(sessionId);
export const startSession = (b, label, options) => b.startSession(label, options);
export const stopSession = (b, sessionId) => b.stopSession(sessionId);
export const listCards = (b) => b.listTaskCards();
export const activeSessions = (b, withinMs) => b.activeSessions(withinMs);
// 验证层一等公民 API（2026-10-07 共享包扩展后可用）：verify 落 kind=verify 的
// 时间线事件（进哈希链，verdict fail-closed 只收 pass/fail）。旧 dist 无此方法时
// 返回 null/[]，调用方（io.verify?. / board.verify?.）判空跳过——不阻塞任务流。
export const verify = (b, actor, key, verdict, opts) =>
  typeof b.verify === "function" ? b.verify(actor, key, verdict, opts ?? {}) : null;
export const verificationsFor = (b, key) =>
  typeof b.verificationsFor === "function" ? b.verificationsFor(key) : [];
