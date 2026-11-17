// guard — invoked by the agent-bridge-guard scheduled task, rep=PT1M (registered
// cadence measured from guard.log: median gap exactly 1.00 min over 2889 samples).
// v2 (2026-10-02 incident follow-up): liveness = process existence AND control-port
// responsiveness; every "dead" verdict needs two consecutive runs (two-strike)
// before spawning/killing; kill only after command-line confirmation, with a 30min
// cooldown and a 3/hour cap. Decision logic lives in lib/guard-core.mjs (e2e-tested).
//
// Hard rule: this process MUST exit within seconds. run_daemon.bat is an
// infinite restart loop, so any blocking spawn leaves the guard hung forever and
// no future guard run restarts the daemon (that exact failure cost 1.5 days of
// silent downtime on 2026-09-23..25). Hence: async bounded I/O + detached spawn
// + unref + hard exit. Probe is capped at 3.5s and the command-line identity check at
// 9s, both under a 15s hard exit.
import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getProcessInfo, IS_WINDOWS } from "./lib/platform.js";
import { runGuardCheck } from "./lib/guard-core.mjs";

const BASE = dirname(fileURLToPath(import.meta.url));
const logFile = join(BASE, "logs", "guard.log");
const log = (m) => {
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `[${new Date().toISOString()}] ${m}\n`);
  } catch { /* guard must never fail on logging */ }
};

// Belt-and-braces: whatever happens above, don't linger past 15s. The identity confirm is a
// PowerShell call and 2026-10-06 measurement says powershell cold-start alone is ~4.0-4.4s, a
// single-pid Get-CimInstance is 5.7-7.5s — the old 8s exit capped confirm at 3.5s, so confirm
// returned null every time and the kill branch could never legitimately fire. Budget now:
// probe 3.5s + confirm 9s = 12.5s worst case, inside a 15s hard exit, inside the 60s task period.
setTimeout(() => { log("watchdog exit — something blocked"); process.exit(0); }, 15000).unref();

let cfg = {};
try { cfg = JSON.parse(readFileSync(join(BASE, "daemon.config.json"), "utf8")); } catch { /* fall back to defaults */ }
const port = cfg.http?.port ?? 8790;
const tokenPath = join(BASE, "control.token");
const token = existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : "";

// Command-line identity check over the platform primitive (drained + timer-raced
// on win32 — see lib/platform.js for the conhost-pipe incident history).
// Returns true/false, or null when inconclusive (caller must stand down — never kill on a guess).
async function confirmByCommandLine(pid, timeoutMs) {
  const info = await getProcessInfo(pid, timeoutMs);
  if (info.commandLine == null) return null;
  return info.commandLine.includes("daemon.js") && info.commandLine.includes(BASE) ? true : false;
}

const ctx = {
  log,
  now: () => Date.now(),
  readState: () => { try { return JSON.parse(readFileSync(join(BASE, "state.json"), "utf8")); } catch { return null; } },
  stopPresent: () => existsSync(join(BASE, "STOP")),
  processAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
  strikeFile: join(BASE, "logs", "guard-strikes.json"),
  probe: async (statePid) => {
    // 四种判据分开返回，别把「连不上」和「连上不答」混成一个：
    //   refused = 内核 RST，端口上没人监听 → 支持杀/重启
    //   timeout = 连上了但 3.5s 内没回 → 与「饥饿的健在守护」同形（10-05 实测慢答 36.989433s），不可当死
    try {
      const r = await fetch(`http://127.0.0.1:${port}/ps?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(3500) });
      if (r.status === 200) {
        const body = await r.json();
        return Number(body.pid) === Number(statePid) ? "ok" : "mismatch";
      }
      return "ok"; // 任何 HTTP 应答都说明事件循环在服务
    } catch (e) {
      if ((e?.cause?.code ?? e?.code) === "ECONNREFUSED") return "refused";
      return "timeout";
    }
  },
  confirmDaemon: (pid) => confirmByCommandLine(pid, 9000),
  kill: (pid) => { try { process.kill(pid, "SIGKILL"); } catch (e) { log(`SIGKILL pid=${pid} failed: ${e.message}`); } },
  spawnLauncher: () => {
    // detached + ignore stdio + unref: the loop outlives the guard and the guard
    // exits immediately. (cmd /c start via execFileSync is what hung before.)
    if (IS_WINDOWS) {
      const child = spawn("cmd.exe", ["/c", join(BASE, "run_daemon.bat")], { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      log(`launcher spawned (child pid=${child.pid})`);
      return true;
    }
    const sh = join(BASE, "scripts", "run-daemon.sh");
    if (!existsSync(sh)) { log("launcher skipped: scripts/run-daemon.sh not present"); return false; }
    const child = spawn("sh", [sh], { detached: true, stdio: "ignore" });
    child.unref();
    log(`launcher spawned (child pid=${child.pid})`);
    return true;
  },
};

runGuardCheck(ctx)
  .catch((e) => log(`guard check failed: ${e.stack || e.message}`))
  .finally(() => process.exit(0));
