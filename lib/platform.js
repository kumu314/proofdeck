// Process-management primitives, per-OS. Part of the platform split that keeps
// daemon/runner/guard/watchdog OS-agnostic.
//
// Honest status (2026-10): the Windows paths are production-proven (months of
// fleet duty, incident-hardened — see comments). The POSIX paths are written to
// spec and exercised by CI only; real-world macOS/Linux mileage is thin, so the
// POSIX story is marked beta in the README until it has real users.
import { spawn } from "node:child_process";
import { platform } from "node:os";

export const IS_WINDOWS = platform() === "win32";

/**
 * Forceful process-tree kill.
 * - win32: `taskkill /PID <pid> /T /F` — tree kill by pid, ignores our process-group state.
 * - posix: SIGKILL the process group (`kill(-pid)`); only works when the child is a group
 *   leader (spawned with detached:true). Falls back to single-process SIGKILL otherwise —
 *   descendants may survive; faces that fork grandchildren should spawn detached.
 * Fire-and-forget: returns without waiting for exit (callers already treat rc=0 as
 * "killed, likely before it could flush" — see daemon stalled-kill semantics).
 */
export function killTree(pid, { log = () => { } } = {}) {
  if (IS_WINDOWS) {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      return true;
    } catch (e) {
      log(`killTree(${pid}): taskkill spawn failed: ${e.message}`);
      return false;
    }
  }
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch (e) {
    if (e.code === "ESRCH") return false;
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch (e2) {
      log(`killTree(${pid}): ${e2.message}`);
      return false;
    }
  }
}

/**
 * Identify a pid before acting on it (pids get recycled after reboot/restart).
 * Returns { parentPid: number|null, commandLine: string|null }; null fields mean
 * "could not observe" and callers must treat that as NOT confirmed.
 *
 * win32: PowerShell CIM query with explicit pipe draining + a timer race. The
 * drain matters: execFileSync-style timeouts kill powershell.exe but a surviving
 * conhost keeps the stdout pipe open and the caller waits forever (incidents
 * 4020 — wedged 50 minutes — and 36700, same shape). Timeout ⇒ resolve(null).
 * posix: `ps -o ppid= -o command= -p <pid>` (one roundtrip, no cold start).
 */
export function getProcessInfo(pid, timeoutMs = 5000) {
  if (IS_WINDOWS) {
    return new Promise((resolve) => {
      let out = "";
      let settled = false;
      let t = null;
      let p = null;
      const settle = (v) => {
        if (settled) return;
        settled = true;
        if (t) clearTimeout(t);
        try { p?.kill(); } catch { /* already gone */ }
        resolve(v);
      };
      try {
        // 两行输出（ppid 行 + commandline 行）——表达式里不嵌双引号，避开 node spawn
        // 在 Windows 的参数转义把 PS 插值字符串搅碎的问题（2026-11-17 实锤）。
        p = spawn("powershell.exe", ["-NoProfile", "-Command",
          `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; Write-Output ($p.ParentProcessId); Write-Output ($p.CommandLine)`],
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      } catch { resolve({ parentPid: null, commandLine: null }); return; }
      t = setTimeout(() => settle({ parentPid: null, commandLine: null }), timeoutMs);
      p.stdout.on("data", (c) => { out += c; });
      p.on("error", () => settle({ parentPid: null, commandLine: null }));
      p.on("close", (code) => {
        if (code !== 0) return settle({ parentPid: null, commandLine: null });
        const nl = out.indexOf("\n");
        if (nl === -1) return settle({ parentPid: null, commandLine: null });
        const ppid = Number(out.slice(0, nl).trim());
        const commandLine = out.slice(nl + 1).replace(/\r?\n$/, "");
        resolve({ parentPid: Number.isInteger(ppid) && ppid > 0 ? ppid : null, commandLine: commandLine || null });
      });
    });
  }
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    let t = null;
    let p = null;
    const settle = (v) => {
      if (settled) return;
      settled = true;
      if (t) clearTimeout(t);
      try { p?.kill(); } catch { /* already gone */ }
      resolve(v);
    };
    try {
      p = spawn("ps", ["-o", "ppid=", "-o", "command=", "-p", String(pid)],
        { stdio: ["ignore", "pipe", "pipe"] });
    } catch { resolve({ parentPid: null, commandLine: null }); return; }
    t = setTimeout(() => settle({ parentPid: null, commandLine: null }), timeoutMs);
    p.stdout.on("data", (c) => { out += c; });
    p.on("error", () => settle({ parentPid: null, commandLine: null }));
    p.on("close", (code) => {
      if (code !== 0) return settle({ parentPid: null, commandLine: null }); // no such process
      const line = out.split("\n").find((l) => l.trim().length > 0) ?? "";
      const m = /^(\d+)\s+(.*)$/.exec(line.trim());
      if (!m) return resolve({ parentPid: null, commandLine: null });
      const ppid = Number(m[1]);
      resolve({ parentPid: Number.isInteger(ppid) && ppid > 0 ? ppid : null, commandLine: m[2] });
    });
  });
}
