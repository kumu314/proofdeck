// Local control plane for the daemon: 127.0.0.1 only, token-gated.
// Token auto-generated at <base>/control.token on first boot.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { killTree } from "./platform.js";
import * as board from "./board.js";
import { left } from "./supply.js";
import { applyReviewAccept, applyReviewReject } from "./review.js";

export function createControlServer(cfg, ctx) {
  const { store, wake, log, BASE } = ctx;
  const tokenPath = join(BASE, "control.token");
  if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(24).toString("hex"));
  const token = readFileSync(tokenPath, "utf8").trim();

  const srv = createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (u.searchParams.get("token") !== token) return send(401, { error: "bad token" });
    const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
    const s = store.s;

    if (u.pathname === "/ps") {
      return send(200, {
        pid: s.pid, startedAt: s.startedAt, cursor: s.cursor, dryRun: cfg.runtime.dryRun,
        runs: s.runs, pending: s.pending, lanes: s.lanes, supply: s.supply ?? {},
        review: s.review ?? {},
        recent: Object.entries(s.finished).slice(-10).reduce((a, [k, v]) => (a[k] = v, a), {}),
      });
    }
    if (u.pathname === "/state") return send(200, s);
    // ---- 供应方熔断台账（#25）：看、手工放行、手工冻结 ----
    if (u.pathname === "/supply") {
      const now = Date.now();
      const supply = s.supply ?? {};
      return send(200, {
        now: new Date(now).toISOString(),
        held: Object.fromEntries(Object.entries(supply).map(([a, r]) => [a, r.holdUntil > now])),
        supply,
      });
    }
    if (u.pathname === "/supply-clear" && req.method === "POST") {
      const agent = body.agent;
      if (!agent) return send(400, { error: "缺 agent" });
      const prev = store.supplyRelease(agent);
      if (!prev) return send(404, { error: `${agent} 本来就没有熔断记录`, supply: s.supply ?? {} });
      store.save();
      await board.withBoard(cfg.board, (b) =>
        board.note(b, cfg.board.identity, `[${cfg.board.identity}] 人工解除 ${agent} 的供应方熔断（原 ${prev.category} streak=${prev.streak}，本来还剩 ${left(prev.holdUntil - Date.now())} 被跳过）${body.reason ? "：" + body.reason : ""}`));
      log(`supply cleared for ${agent} (was ${prev.category} streak=${prev.streak})`);
      wake(`supply clear ${agent}`);
      return send(200, { ok: true, agent, was: prev });
    }
    if (u.pathname === "/supply-freeze" && req.method === "POST") {
      const agent = body.agent;
      if (!agent) return send(400, { error: "缺 agent" });
      if (!cfg.agents[agent]) return send(400, { error: `未知 agent ${agent}`, known: Object.keys(cfg.agents) });
      const minutes = Math.max(1, Number(body.minutes) || 30);
      const rec = store.supplyLatch(agent, {
        category: "manual", label: "人工冻结", key: null, to: cfg.owner,
        runDir: null, evidence: body.reason ?? "人工判定该面暂不可用", evidenceFile: "bridge-ctl",
        holdMs: minutes * 60000,
      });
      store.save();
      await board.withBoard(cfg.board, (b) =>
        board.note(b, cfg.board.identity, `[${cfg.board.identity}] ${agent} 面已人工冻结 ${minutes} 分钟（不再派发，队列保留）${body.reason ? "：" + body.reason : ""}`));
      log(`manual freeze ${agent} for ${minutes}min (streak=${rec.streak})`);
      // 冻结到点也要自己叫醒，别等下一个 reconcile
      setTimeout(() => wake(`supply freeze ${agent} 到点`), rec.holdMs + 500).unref?.();
      return send(200, { ok: true, agent, record: rec });
    }
    if (u.pathname === "/approve" && req.method === "POST") {
      const p = s.pending[body.key];
      if (!p) return send(404, { error: `nothing pending for ${body.key}` });
      delete s.pending[body.key];
      s.finished[body.key] && delete s.finished[body.key];
      (s.approved ??= {})[body.key] = { at: new Date().toISOString() };
      (s.lanes[p.agent] ??= []).unshift(body.key);
      (s.laneAt ??= {})[body.key] = { at: Date.now(), priority: null }; // 与 queue() 对齐：审批放行也记入队元数据
      store.save();
      wake(`approve ${body.key}`);
      return send(200, { ok: true, key: body.key, agent: p.agent });
    }
    if (u.pathname === "/deny" && req.method === "POST") {
      const p = s.pending[body.key];
      if (!p) return send(404, { error: `nothing pending for ${body.key}` });
      delete s.pending[body.key];
      s.finished[body.key] = { at: new Date().toISOString(), result: "denied", agent: p.agent ?? null };
      store.save();
      await board.withBoard(cfg.board, (b) =>
        board.note(b, cfg.board.identity, `[${cfg.board.identity}] ${body.key} 被人工拒绝${body.reason ? "：" + body.reason : ""}`));
      return send(200, { ok: true });
    }
    // ---- 复核队列（验证层 V2/V3）：cross/human 任务完成后等独立复核才关单 ----
    if (u.pathname === "/review-accept" && req.method === "POST") {
      if (!body.key) return send(400, { error: "缺 key" });
      const res = await board.withBoard(cfg.board, (b) =>
        applyReviewAccept({ b, io: board, store, ID: cfg.board.identity, key: body.key }));
      if (!res.ok) return send(404, { error: res.why, review: s.review ?? {} });
      log(`review-accept ${body.key} (${res.mode}, reviewer=${res.reviewer})`);
      return send(200, res);
    }
    if (u.pathname === "/review-reject" && req.method === "POST") {
      if (!body.key) return send(400, { error: "缺 key" });
      const res = await board.withBoard(cfg.board, (b) =>
        applyReviewReject({ b, io: board, store, ID: cfg.board.identity, key: body.key, reason: body.reason }));
      if (!res.ok) return send(404, { error: res.why, review: s.review ?? {} });
      log(`review-reject ${body.key} (${res.mode})`);
      return send(200, res);
    }
    if (u.pathname === "/requeue" && req.method === "POST") {
      const fin = s.finished[body.key];
      const agent = body.agent ?? fin?.agent ?? null;
      if (!agent) return send(400, { error: `${body.key} 没有可沿用的面，请显式指定 agent` });
      if (!cfg.agents[agent]?.enabled) return send(400, { error: `agent ${agent} 未启用`, enabled: Object.entries(cfg.agents).filter(([, a]) => a.enabled).map(([n]) => n) });
      const r = store.requeue(body.key, agent);
      if (!r.ok) return send(409, { error: `未能重派：${r.why}` });
      store.save();
      await board.withBoard(cfg.board, (b) =>
        board.note(b, cfg.board.identity, `[${cfg.board.identity}] ${body.key} 已重派回 ${agent} 队列${fin ? `（上次结案：${fin.result}）` : ""}`));
      log(`requeued ${body.key} -> ${agent}${fin ? ` (was: ${fin.result})` : ""}`);
      wake(`requeue ${body.key}`);
      return send(200, { ok: true, key: body.key, agent, was: fin?.result ?? null });
    }
    if (u.pathname === "/kill" && req.method === "POST") {
      const r = s.runs[body.key];
      if (!r || !r.pid) return send(404, { error: `${body.key} not running with a pid` });
      r.killedBy = "manual"; // survives into the FAILED report: a kill is not an agent failure
      store.save();
      killTree(r.pid, { log });
      log(`manual kill ${body.key} pid=${r.pid}`);
      return send(200, { ok: true, pid: r.pid });
    }
    if (u.pathname === "/tail") {
      const file = join(BASE, u.searchParams.get("file") ?? "");
      if (!file.startsWith(BASE) || !existsSync(file)) return send(404, { error: "no such file within base dir" });
      // 不给 file= 时 join 落在 BASE 本身（目录）：readFileSync 抛 EISDIR，整条请求靠 unhandledRejection 兜底
      const st = statSync(file);
      if (!st.isFile()) return send(400, { error: `不是文件，是目录：${st.isDirectory() ? "dir" : "special"}`, file: u.searchParams.get("file") });
      const n = Math.min(64000, Number(u.searchParams.get("bytes") ?? 4000));
      const text = readFileSync(file, "utf8");
      return send(200, { file: u.searchParams.get("file"), tail: text.slice(-n) });
    }
    return send(404, { error: "unknown path" });
  });
  const port = cfg.http?.port ?? 8790;
  // 端口即单实例锁：bind 成功才算自己是唯一守护。旧写法 listen/error 各自
  // fire-and-forget，抢输的实例只留一行日志就继续跑，成了 guard 看不见的孤儿。
  srv.on("error", (e) => log(`control server failed: ${e.message}`));
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => {
      log(`control http on 127.0.0.1:${port}`);
      resolve(srv);
    });
  });
}

const readBody = (req) => new Promise((res) => { let b = ""; req.on("data", (c) => b += c); req.on("end", () => res(b)); });
