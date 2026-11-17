// Freeze self-rescue watchdog worker（2026-10-02 事故缺口④；2026-10-06 补 10-05 误杀的两道闸）。
// 决策逻辑全在 lib/watchdog-core.mjs（纯函数、注入时钟、可单测）；这颗线程只做 I/O：
// 收心跳、按拍调用 decide、探控制口、必要时 SIGKILL 自己进程让 run_daemon.bat 重启。
// 铁律不变：看门狗自己的 bug 绝不能杀健在的守护——每一步单独兜住，判据不足就弃权。
import { parentPort, workerData } from "node:worker_threads";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { killTree } from "./platform.js";
import { createWatchdog } from "./watchdog-core.mjs";

const {
  pid,
  staleMs,
  graceMs,
  checkMs,
  logFile,
  port = null,
  tokenPath = null,
  probeBudgetMs = 120000,  // 必须远大于 guard.js 的 3500ms：10-05 实测健在但饥饿的守护答 /ps 用了 36.989433s，取 3 倍余量
  probeAttemptMs = 8000,
} = workerData;

const wlog = (m) => {
  try { mkdirSync(dirname(logFile), { recursive: true }); appendFileSync(logFile, `[${new Date().toISOString()}] ${m}\n`); } catch { /* never fail on logging */ }
};

// 端口旁证：任何 HTTP 应答（哪怕 401）都证明事件循环在服务 → answered；
// 拒连（内核 RST，没人监听）→ refused；连得上但整段预算一个字没回 → timeout。
async function probePort() {
  if (!port) { wlog("watchdog: 未配置控制口，无法旁证 — 保守按 answered 弃权"); return "answered"; }
  let token = "";
  try { token = tokenPath && existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : ""; } catch { /* 空 token 仍能给 401，足以证明在服务 */ }
  const deadline = Date.now() + probeBudgetMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/ps?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(Math.max(500, probeAttemptMs)) });
      return "answered";
    } catch (e) {
      if ((e?.cause?.code ?? e?.code) === "ECONNREFUSED") return "refused";
      // TimeoutError 等：可能是慢，继续给预算，不作数
    }
    const left = deadline - Date.now();
    if (left <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(2000, left)));
  }
  return "timeout";
}

const doKill = () => {
  try {
    process.kill(pid, "SIGKILL");
  } catch (e) {
    wlog(`watchdog: SIGKILL failed (${e.message}) — falling back to platform killTree`);
    killTree(pid, { log: wlog });
  }
};

const wd = createWatchdog({
  now: () => Date.now(),
  staleMs, graceMs, checkMs,
  probe: probePort,
  kill: doKill,
  log: wlog,
});

if (parentPort) parentPort.on("message", () => { try { wd.onHeartbeat(); } catch { /* never act on a watchdog bug */ } });

let running = false;
const timer = setInterval(() => {
  if (running) return;
  running = true;
  wd.tick()
    .catch((e) => wlog(`watchdog tick failed: ${e.message}`))
    .finally(() => { running = false; });
}, checkMs);
