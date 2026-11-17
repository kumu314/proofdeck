// guard-core — testable decision core of guard.js (gaps ①② of the 2026-10-02 incident).
//   ① Liveness = process existence AND control-port responsiveness. A frozen event
//      loop keeps the process alive (existence probes report "alive" forever) while
//      the control port accepts TCP and never answers — that silence is the signal.
//   ② Two-strike: every "dead" verdict must be observed on two consecutive guard
//      runs (~1 min apart) before spawning/killing, which closes the restart race
//      where guard reads the old state.json lock in the ~7s before the new daemon
//      replaces it (that race spawned a duplicate launcher on 2026-10-02).
// Safety interlocks on kill: only after a command-line confirmation that the pid
// really is this daemon; 30 min cooldown between kills; hard cap of 3 kills/hour.
// When in doubt, stand down — the next minute's run re-decides.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const readStrikes = (ctx) => {
  try { return JSON.parse(readFileSync(ctx.strikeFile, "utf8")); } catch { return { key: null, count: 0, lastAt: 0, lastKillAt: 0, kills: [] }; }
};
const saveStrikes = (ctx, s) => { try { writeFileSync(ctx.strikeFile, JSON.stringify(s)); } catch { /* ledger loss degrades to one extra strike cycle */ } };
const clearStrikes = (ctx) => { try { if (existsSync(ctx.strikeFile)) writeFileSync(ctx.strikeFile, JSON.stringify({ key: null, count: 0, lastAt: 0, lastKillAt: 0, kills: [] })); } catch { } };

async function maybeSpawn(ctx) {
  try { ctx.spawnLauncher(); return true; } catch (e) { ctx.log(`spawn launcher failed: ${e.message}`); return false; }
}

// ctx: { log(m), now(), readState(): {pid}|null, stopPresent(), processAlive(pid),
//        probe(statePid): "ok"|"mismatch"|"dead", confirmDaemon(pid): true|false|null,
//        kill(pid), spawnLauncher(), strikeFile }
export async function runGuardCheck(ctx) {
  const now = ctx.now();
  if (ctx.stopPresent()) { ctx.log("STOP present — guard standing down"); return { state: "stopped", action: "none" }; }

  const st = ctx.readState();
  const pid = Number.isInteger(st?.pid) ? st.pid : null;
  const prev = readStrikes(ctx);
  const key = pid ?? "none";
  // pid changed → a new daemon lineage, its own fresh strike budget
  const s = prev.key !== key ? { key, count: 0, lastAt: 0, lastKillAt: 0, kills: [] } : prev;

  if (pid == null) {
    s.count += 1; saveStrikes(ctx, s);
    if (s.count >= 2) {
      const ok = await maybeSpawn(ctx);
      return { state: "no-state", action: ok ? "spawn" : "spawn-failed", detail: `no readable state.json (strike ${s.count})` };
    }
    ctx.log(`no readable state.json (strike ${s.count}/2) — waiting one cycle before spawning launcher`);
    return { state: "no-state", action: "wait" };
  }

  if (!ctx.processAlive(pid)) {
    s.count += 1; saveStrikes(ctx, s);
    if (s.count >= 2) {
      const ok = await maybeSpawn(ctx);
      return { state: "dead", action: ok ? "spawn" : "spawn-failed", detail: `pid=${pid} gone (strike ${s.count})` };
    }
    ctx.log(`daemon DOWN? pid=${pid} gone (strike ${s.count}/2) — waiting one cycle (may be a restart window)`);
    return { state: "dead", action: "wait" };
  }

  const probe = await ctx.probe(pid);
  if (probe === "ok") {
    clearStrikes(ctx);
    ctx.log(`daemon alive pid=${pid} (control responsive)`);
    return { state: "alive", action: "none" };
  }
  if (probe === "mismatch") {
    clearStrikes(ctx);
    ctx.log(`control port answers with a DIFFERENT daemon pid (state.json=${pid}) — stale lock or second daemon; not touching`);
    return { state: "mismatch", action: "none" };
  }

  // 超时 ≠ 死。10-05 实测：一个健在但被饿死的守护回答 /ps 用了 36.989433s，而 guard 的探针预算
  // 只有 3500ms（它必须秒级退出）。把「超时」当死，就会杀掉健在的守护——所以超时这一轮
  // 既不做正身确认、也不落 strike 账；冻结自愈交给进程内看门狗（它有 60s 量级的耐心预算）。
  if (probe === "timeout") {
    ctx.log(`daemon pid=${pid} 探针超时（3.5s 量级无法区分冻结与饥饿）— 不落账不确认，交给进程内看门狗`);
    return { state: "inconclusive", action: "abstain" };
  }

  // refused = 内核直接 RST，端口上没人监听 → 这是支持「杀/重启」的判据。
  // 但判据成立之前不落账（2026-10-06 缺口②续）：先正身确认，确认成立才吃一次 strike 预算，
  // 于是每一次记账都对应一次「已经证明是自己人」的观测。
  if (probe !== "refused") {
    ctx.log(`daemon pid=${pid} 探针返回未知判据 ${probe} — 弃权`);
    return { state: "unknown-probe", action: "abstain" };
  }
  const confirmed = await ctx.confirmDaemon(pid);
  if (confirmed !== true) {
    ctx.log(`daemon pid=${pid} 端口拒连但命令行 ${confirmed === false ? "确认不是本守护" : "确认不确定"} — 不落账、站立不动`);
    return { state: "refused-unconfirmed", action: "abstain" };
  }
  s.count += 1; saveStrikes(ctx, s);
  if (s.count < 2) {
    ctx.log(`daemon pid=${pid} 拒连且正身已确认 (strike ${s.count}/2) — 下一轮再判一次`);
    return { state: "refused", action: "wait" };
  }
  if (s.kills.length >= 3 && now - (s.kills[0] ?? 0) < 3600000) {
    ctx.log(`daemon pid=${pid} 1 小时内已杀 ${s.kills.length} 次 — 停止自动杀，需人工介入`);
    return { state: "refused", action: "manual" };
  }
  if (s.lastKillAt && now - s.lastKillAt < 30 * 60000) {
    ctx.log(`daemon pid=${pid} 拒连（strike ${s.count}）但杀冷却生效 — 等待`);
    return { state: "refused", action: "cooldown" };
  }
  ctx.kill(pid);
  s.lastKillAt = now; s.kills = [...s.kills, now].slice(-5); s.count = 0;
  saveStrikes(ctx, s);
  ctx.log(`daemon pid=${pid} 端口拒连、命令行确认、两振成立 — SIGKILL 让 launcher 重启`);
  return { state: "refused", action: "kill" };
}
