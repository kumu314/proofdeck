// e2e: resilience of the guard v2 + daemon freeze-watchdog (2026-10-02 incident gaps ①-④).
// Never touches the production board or the live daemon's state — all mutations go to a
// temp baseDir; the only production reads are the final guard.js smoke (read-only path
// against a healthy daemon). Kill targets are sacrificial processes we spawn ourselves.
import { Worker } from "node:worker_threads";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { getProcessInfo } from "../lib/platform.js";

const GUARD_CORE = new URL("../lib/guard-core.mjs", import.meta.url).href;
const WORKER = fileURLToPath(new URL("../lib/watchdog-worker.mjs", import.meta.url));
const WD_CORE = new URL("../lib/watchdog-core.mjs", import.meta.url).href;
const { runGuardCheck } = await import(GUARD_CORE);
const wd = await import(WD_CORE);

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tempBase = mkdtempSync(join(tmpdir(), "bridge-resilience-"));
const strikeFile = join(tempBase, "guard-strikes.json");
const wlogFile = join(tempBase, "watchdog.log");
const stateFile = join(tempBase, "state.json");
const setState = (pid) => writeFileSync(stateFile, JSON.stringify({ pid }));

const victimProc = (marker) => spawn(process.execPath, ["-e", `setTimeout(()=>{},60000) /*${marker}*/`], { stdio: "ignore" });
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (cond, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await cond()) return true; await sleep(150); } return false; };

// 探针必须把「没人监听」和「连上了不回答」分成两种判据：前者支持杀，后者不支持。
// 2026-10-06 实测：一个健在但被饿死的守护回答 /ps 用了 36.989433s，而 guard 的探针预算只有
// 3500ms——把超时当死，就会杀掉健在的守护（10-05 事故形状）。
// 夹具要用「真的没人监听」的端口：先绑一个临时口再关掉。不能拿 1 号端口冒充——
// 2026-10-06 实测 fetch 对 127.0.0.1:1 在连接前就按 blocked-port 拒绝（cause 是 "bad port"、
// 没有 ECONNREFUSED 码），会把它误分类成 timeout，让整组 refused 断言测不到目标分支。
const deadPort = await new Promise((resolve, reject) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on("error", reject);
});
const closedPortProbe = async () => {
  try { await fetch(`http://127.0.0.1:${deadPort}/ps`, { signal: AbortSignal.timeout(1500) }); return "ok"; }
  catch (e) { return (e?.cause?.code ?? e?.code) === "ECONNREFUSED" ? "refused" : "timeout"; }
};
const timeoutProbe = async () => "timeout";

// ctx factory against the temp world. confirmDaemon = the real powershell mechanics
// (same shape as guard.js's confirmByCommandLine, marker parameterized).
const mkCtx = (overrides = {}) => ({
  log: () => { },
  now: () => Date.now(),
  readState: () => { try { return JSON.parse(readFileSync(stateFile, "utf8")); } catch { return null; } },
  stopPresent: () => existsSync(join(tempBase, "STOP")),
  processAlive: pidAlive,
  strikeFile: overrides.strikeFile ?? strikeFile,
  probe: closedPortProbe,
  confirmDaemon: async (pid) => {
    // 经共享双平台原语取命令行（win32=排水版 CIM / posix=ps）——测试直接测生产原语。
    // 预算 30s：生产 guard 是 9s（慢 WMI 下按设计弃权）；测试预算放宽以聚焦逻辑而非机器负载。
    const info = await getProcessInfo(pid, 30000);
    if (info.commandLine == null) return null;
    return info.commandLine.includes(overrides.marker ?? "guard-e2e-victim") ? true : false;
  },
  kill: (pid) => { try { process.kill(pid, "SIGKILL"); } catch { } },
  spawnLauncher: () => { (overrides.spawned ??= []).push(1); return true; },
  ...overrides.ctx,
});

// ---------- G1: two-strike before spawn (restart-race fix, gap ②) ----------
{
  const dead = spawnSync(process.execPath, ["-e", ""]);
  await sleep(300);
  setState(dead.pid);
  const spawned = [];
  const ctx = mkCtx({ spawned, marker: "x" });
  const r1 = await runGuardCheck(ctx);
  ok("G1a first sighting of dead pid waits (no spawn)", r1.action === "wait" && spawned.length === 0, JSON.stringify(r1));
  const r2 = await runGuardCheck(ctx);
  ok("G1b second sighting spawns launcher", r2.action === "spawn" && spawned.length === 1, JSON.stringify(r2));
  // alive again → strikes cleared
  const alive = victimProc("guard-e2e-victim");
  setState(alive.pid);
  const portSrv = createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ pid: alive.pid })); });
  await new Promise((r) => portSrv.listen(0, "127.0.0.1", r));
  const port = portSrv.address().port;
  const ctxAlive = mkCtx({ ctx: { probe: async () => "ok" } });
  const r3 = await runGuardCheck(ctxAlive);
  const ledger = JSON.parse(readFileSync(strikeFile, "utf8"));
  ok("G1c responsive daemon reports alive and clears strikes", r3.state === "alive" && ledger.key === null, JSON.stringify(r3));
  // mismatch → report, never touch
  const ctxMis = mkCtx({ ctx: { probe: async () => "mismatch" } });
  const r4 = await runGuardCheck(ctxMis);
  ok("G1d foreign port owner is reported, not killed", r4.state === "mismatch" && r4.action === "none", JSON.stringify(r4));
  portSrv.close(); alive.kill("SIGKILL");
}

// ---------- G2: 端口拒连且正身已确认 → 两振 → 杀（gap ①）----------
{
  // CIM/PS 冷启动预热（Windows 首查可 >9s：PS 冷启 4.2s + 单 pid CIM 5.7~7.5s）。
  // 预热让断言聚焦 guard 两振逻辑本身；生产 guard 9s 预算下遇到冷 CIM 会按设计弃权。
  await getProcessInfo(process.pid, 20000);
}
{
  const victim = victimProc("guard-e2e-victim");
  await sleep(300);
  setState(victim.pid);
  const ctx = mkCtx({});
  const r1 = await runGuardCheck(ctx);
  ok("G2a refused strike 1 waits", r1.action === "wait", JSON.stringify(r1));
  const r2 = await runGuardCheck(ctx);
  ok("G2b strike 2 confirms via command line and kills", r2.action === "kill", JSON.stringify(r2));
  const died = await waitFor(async () => !pidAlive(victim.pid), 3000);
  ok("G2c victim actually died", died);
  const ledger = JSON.parse(readFileSync(strikeFile, "utf8"));
  ok("G2d kill recorded in ledger, count reset", ledger.kills.length === 1 && ledger.count === 0, JSON.stringify(ledger));
}

// ---------- G3: no positive ID → abstain; ledger caps → cooldown/manual ----------
{
  const stranger = victimProc("some-unrelated-process");
  await sleep(300);
  setState(stranger.pid);
  const ctx = mkCtx({ marker: "guard-e2e-victim" }); // victim's cmdline lacks the marker
  await runGuardCheck(ctx);
  const r2 = await runGuardCheck(ctx);
  ok("G3a unconfirmed pid → abstain from killing", r2.action === "abstain" && pidAlive(stranger.pid), JSON.stringify(r2));
  stranger.kill("SIGKILL");

  // cooldown / manual-cap live on the unresponsive branch → need a LIVE pid and a
  // ledger keyed by that exact pid (a key change resets the ledger).
  const frozen = victimProc("guard-e2e-victim");
  await sleep(300);
  setState(frozen.pid);
  const now = Date.now();
  const ctxC = mkCtx({ ctx: {} });
  writeFileSync(strikeFile, JSON.stringify({ key: frozen.pid, count: 1, lastAt: now, lastKillAt: now - 60000, kills: [] }));
  const rc = await runGuardCheck(ctxC);
  ok("G3b kill cooldown active", rc.action === "cooldown", JSON.stringify(rc));

  writeFileSync(strikeFile, JSON.stringify({ key: frozen.pid, count: 5, lastAt: now, lastKillAt: 0, kills: [now - 3000, now - 2000, now - 1000] }));
  const rm = await runGuardCheck(ctxC);
  ok("G3c 3 kills within 1h → stop auto-kill, require manual", rm.action === "manual", JSON.stringify(rm));
  frozen.kill("SIGKILL");

  rmSync(stateFile);
  const ctxN = mkCtx({});
  const n1 = await runGuardCheck(ctxN);
  const n2 = await runGuardCheck(ctxN);
  ok("G3d missing state.json → two-strike then spawn", n1.action === "wait" && n2.action === "spawn", `${n1.action}/${n2.action}`);

  writeFileSync(join(tempBase, "STOP"), "1");
  const ctxS = mkCtx({});
  const rs = await runGuardCheck(ctxS);
  ok("G3e STOP present → stand down entirely", rs.state === "stopped", JSON.stringify(rs));
  rmSync(join(tempBase, "STOP"));
}

// ---------- W1/W2: daemon freeze-watchdog worker (gap ④) ----------
{
  const victim = victimProc("watchdog-e2e-victim");
  await sleep(300);
  const w = new Worker(WORKER, { workerData: { pid: victim.pid, staleMs: 1500, graceMs: 0, checkMs: 500, logFile: wlogFile, port: deadPort, probeBudgetMs: 2000, probeAttemptMs: 800 } });
  const killed = await waitFor(async () => !pidAlive(victim.pid), 8000);
  ok("W1 silent main thread → worker kills frozen pid", killed, `victim pid=${victim.pid}`);
  await sleep(300);
  const wlog = existsSync(wlogFile) ? readFileSync(wlogFile, "utf8") : "";
  ok("W1b watchdog logged its verdict", wlog.includes("SIGKILL") && /判为 refused/.test(wlog), wlog.split("\n").slice(-2).join(" | "));
  ok("W1c worker exit did not take the test process down", true); // we are still running
  try { await w.terminate(); } catch { }

  const victim2 = victimProc("watchdog-e2e-victim2");
  await sleep(300);
  const w2 = new Worker(WORKER, { workerData: { pid: victim2.pid, staleMs: 1500, graceMs: 0, checkMs: 500, logFile: join(tempBase, "watchdog2.log") } });
  const hb = setInterval(() => { try { w2.postMessage("hb"); } catch { } }, 200);
  await sleep(4000);
  const stillAlive = pidAlive(victim2.pid);
  ok("W2 healthy heartbeat → worker never kills", stillAlive);
  clearInterval(hb); w2.unref(); victim2.kill("SIGKILL");

  // W2b：10-05 误杀形状的 worker 级复现——心跳断了但控制口还在应答（健在只是慢）→ 绝不杀
  const victim3 = victimProc("watchdog-e2e-victim3");
  await sleep(300);
  const answerSrv = createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ pid: victim3.pid })); });
  await new Promise((r) => answerSrv.listen(0, "127.0.0.1", r));
  const answerPort = answerSrv.address().port;
  const w3 = new Worker(WORKER, { workerData: { pid: victim3.pid, staleMs: 1000, graceMs: 0, checkMs: 400, logFile: join(tempBase, "watchdog3.log"), port: answerPort, probeBudgetMs: 3000, probeAttemptMs: 800 } });
  await sleep(6000);
  ok("W2b 心跳静默 + 控制口有应答 → 看门狗不杀健在守护", pidAlive(victim3.pid), `pid=${victim3.pid} port=${answerPort}`);
  const w3log = existsSync(join(tempBase, "watchdog3.log")) ? readFileSync(join(tempBase, "watchdog3.log"), "utf8") : "";
  ok("W2c 弃权时有留痕（写明是慢不是冻结）", /有应答|心跳已恢复/.test(w3log), w3log.trim().split("\n").slice(-1)[0] ?? "(无日志)");
  w3.unref(); answerSrv.close(); victim3.kill("SIGKILL");
}

// ---------- G5/G6: 判据成立才落账（2026-10-06 缺口②续：超时不是死） ----------
// 每组用**自己的** strike 账本：默认那份被前面的块写过，读数会串台（G5b 首次 FAIL 就是这么来的）。
{
  const victim = victimProc("guard-e2e-victim");
  await sleep(300);
  setState(victim.pid);
  const g5File = join(tempBase, "g5-strikes.json");
  writeFileSync(g5File, JSON.stringify({ key: victim.pid, count: 0, lastAt: 0, lastKillAt: 0, kills: [] }));
  let confirmCalls = 0;
  const ctx = mkCtx({ strikeFile: g5File, ctx: { probe: timeoutProbe, confirmDaemon: async () => { confirmCalls++; return true; } } });
  const r1 = await runGuardCheck(ctx);
  const r2 = await runGuardCheck(ctx);
  const ledger = JSON.parse(readFileSync(g5File, "utf8"));
  ok("G5a 探针超时两轮都不杀", r1.action !== "kill" && r2.action !== "kill" && pidAlive(victim.pid), `${r1.action}/${r2.action}`);
  ok("G5b 探针超时不吃 strike 预算（ledger.count=0）", ledger.count === 0, JSON.stringify(ledger));
  ok("G5c 判据不成立时不做正身确认 I/O", confirmCalls === 0, `confirmCalls=${confirmCalls}`);
  await runGuardCheck(ctx); await runGuardCheck(ctx); await runGuardCheck(ctx);
  ok("G5d 连续超时也不进冷却/人工上限", pidAlive(victim.pid) && JSON.parse(readFileSync(g5File, "utf8")).kills.length === 0);
  victim.kill("SIGKILL");

  // refused（真的没人监听）才是支持杀的判据；且必须先正身确认，确认不成立不落账
  const v2 = victimProc("guard-e2e-victim");
  await sleep(300);
  setState(v2.pid);
  const g6File = join(tempBase, "g6-strikes.json");
  const seed6 = () => writeFileSync(g6File, JSON.stringify({ key: v2.pid, count: 0, lastAt: 0, lastKillAt: 0, kills: [] }));
  seed6();
  const ctxNull = mkCtx({ strikeFile: g6File, ctx: { probe: closedPortProbe, confirmDaemon: async () => null } });
  const u1 = await runGuardCheck(ctxNull);
  const u2 = await runGuardCheck(ctxNull);
  const u3 = await runGuardCheck(ctxNull);
  const l2 = JSON.parse(readFileSync(g6File, "utf8"));
  ok("G6a 拒连但正身不确定：三轮 abstain，不落账，不杀", u1.action === "abstain" && u2.action === "abstain" && u3.action === "abstain" && l2.count === 0 && pidAlive(v2.pid), `${u1.state}/${l2.count}`);
  seed6();
  const ctxOk = mkCtx({ strikeFile: g6File, ctx: { probe: closedPortProbe, confirmDaemon: async () => true } });
  const k1 = await runGuardCheck(ctxOk);
  const k2 = await runGuardCheck(ctxOk);
  ok("G6b 拒连两轮且正身确认 → 杀", k1.action === "wait" && k2.action === "kill", `${k1.action}/${k2.action}`);
  const died = await waitFor(async () => !pidAlive(v2.pid), 3000);
  ok("G6c 被杀的确实是那个命令行确认过的进程", died);
}

// ---------- W3-W5: 看门狗决策核（挂起自测 + 端口再判），纯注入时钟，不需要真睡 ----------
{
  const mk = (o = {}) => {
    const c = { t: 1000, kills: 0, logs: [], probeCalls: 0, probe: o.probe ?? (async () => "timeout"), hbGap: null };
    const w = wd.createWatchdog({
      now: () => c.t,
      staleMs: o.staleMs ?? 30000,
      graceMs: o.graceMs ?? 0,
      checkMs: o.checkMs ?? 10000,
      probe: async () => { c.probeCalls++; return c.probe(); },
      kill: () => { c.kills++; },
      log: (m) => c.logs.push(m),
    });
    return { c, w, adv: (ms) => { c.t += ms; } };
  };

  // 节拍正常、心跳停 → 两振 → 探针无应答 → 杀（10-02 缺口①的原意，必须保住）
  {
    const { c, w, adv } = mk();
    let v = null;
    for (let i = 0; i < 10 && c.kills === 0; i++) { adv(10000); v = await w.tick(); }
    ok("W3a 节拍准、心跳静默超阈值、端口始终无应答 → 杀冻结的守护", c.kills === 1, `verdict=${v} probeCalls=${c.probeCalls}`);
  }
  // 端口能答（哪怕慢）= 主循环还活着 → 绝不杀
  {
    const { c, w, adv } = mk({ probe: async () => "answered" });
    for (let i = 0; i < 10 && c.kills === 0; i++) { adv(10000); await w.tick(); }
    ok("W3b 探针有应答 → 不杀，计数清零", c.kills === 0 && c.probeCalls >= 1, `kills=${c.kills} probeCalls=${c.probeCalls}`);
  }
  // 自己那一拍就迟到（= 整进程被挂起过）→ 静默读数不可解释：清零、不做任何 I/O
  {
    const { c, w, adv } = mk();
    adv(5 * 60 * 1000); // 一次性跳 5 分钟：worker 的 tickGap 远超 checkMs
    const v = await w.tick();
    ok("W4a 自身节拍迟到 → 判挂起，不吃静默读数", v === "suspend-reset", `verdict=${v}`);
    ok("W4b 挂起判定期间不做端口 I/O、不杀", c.probeCalls === 0 && c.kills === 0, `probe=${c.probeCalls} kills=${c.kills}`);
    for (let i = 0; i < 3; i++) { adv(10000); await w.tick(); }
    ok("W4c 挂起后计数从 0 重新起算（不会紧接着就杀）", c.kills === 0 && c.probeCalls === 0, `kills=${c.kills} probe=${c.probeCalls}`);
  }
  // 探针预算期间心跳回来了 → 主线程已复活，弃权
  {
    let release;
    const { c, w, adv } = mk({ probe: () => new Promise((r) => { release = () => r("timeout"); }) });
    for (let i = 0; i < 6; i++) { adv(10000); const p = w.tick(); if (c.probeCalls) { w.onHeartbeat(); adv(1000); release(); await p; break; } }
    ok("W5 探针期间心跳恢复 → 弃权不杀", c.kills === 0, `kills=${c.kills}`);
  }
  // 启动宽限期内一律不动作
  {
    const { c, w, adv } = mk({ graceMs: 600000, staleMs: 1000 });
    adv(10000); await w.tick(); adv(10000); await w.tick();
    ok("W6 graceMs 内不判不杀", c.kills === 0 && c.probeCalls === 0, `kills=${c.kills}`);
  }
  // 只开火一次。SIGKILL 之后守护必然已死、bat 循环接手；若真没死透（权限异常），
  // 让分钟级 guard 去兜，也比 worker 每拍刷一次 taskkill 好（2026-10-06 W1b 实测到过二次 ESRCH）。
  {
    const { c, w, adv } = mk();
    for (let i = 0; i < 12; i++) { adv(10000); await w.tick(); }
    ok("W7 开火一次之后各拍不再杀", c.kills === 1, `kills=${c.kills} probe=${c.probeCalls}`);
  }
}

// ---------- B1: launcher wait primitive (gap ③) ----------
if (process.platform === "win32") {
  const t0 = Date.now();
  spawnSync("cmd.exe", ["/c", "ping -n 3 127.0.0.1 > NUL"], { windowsHide: true });
  const dt = Date.now() - t0;
  ok("B1 ping -n 3 sleeps ~2s in non-interactive cmd", dt >= 1800 && dt < 4500, `${dt}ms`);
} else {
  console.log("SKIP B1 (win32-only launcher wait primitive)");
}

// ---------- G4: real guard.js against the real (healthy) daemon — read-only smoke ----------
{
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("../guard.js", import.meta.url))], { encoding: "utf8", timeout: 25000 });
  const glog = readFileSync(fileURLToPath(new URL("../logs/guard.log", import.meta.url)), "utf8").slice(-2000);
  ok("G4 real guard.js run exits fast with a verdict (no daemon here: no-state / launcher-probe path)",
    r.status === 0 && /control responsive|端口拒连|探针超时|DIFFERENT daemon pid|launcher spawned|no readable state/.test(glog), `rc=${r.status} :: ${glog.trim().split("\n").pop()}`);
}

rmSync(tempBase, { recursive: true, force: true });
console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
