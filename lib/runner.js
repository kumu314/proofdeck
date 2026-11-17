// runner: spawn an agent headless, stream logs, enforce timeout, classify exit.
import { spawn } from "node:child_process";
import { createWriteStream, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { killTree } from "./platform.js";
import * as codex from "./adapters/codex.js";

// Adapter registry: an adapter is a small module with
//   buildRun({agentCfg, runDir, promptFile, workdir}) -> spawn spec
//   parseEvent(line) -> {milestone, step, raw} | null
//   readMeta(run)? / readResult(run)? / readUsage({runDir})?
//   resumeSpec(o)? (optional — session-level resume)
// The reference implementation ships in-box (codex = generic CLI adapter).
// Additional faces register their own module at bootstrap:
//   registerAdapter("myface", await import("./adapters/myface.js"))
const ADAPTERS = { codex };

export function registerAdapter(name, mod) {
  ADAPTERS[name] = mod;
}

export function getAdapter(name) {
  const a = ADAPTERS[name];
  if (!a) throw new Error(`adapter '${name}' not registered — call registerAdapter('${name}', mod) at bootstrap, or ship lib/adapters/${name}.js`);
  return a;
}

/**
 * runTask({agentCfg, adapter, runDir, promptFile, workdir, fm, runId, log, onMilestone, resume})
 * -> Promise<{exitCode, killed, stalled, items, resultText, threadId, spawnError?}>
 *    `stalled` = 无进展判停掐的；`items` = 累计 milestone 数（0 表示一步没走）。
 *    `resume` = {threadId, segment} 时，优先让适配器的 resumeSpec 接管建令；
 *    该面没有会话级续跑（或拿不到 threadId）就退回 buildRun —— 检查点题面照样带过去。
 */
export function runTask(o) {
  const adapter = getAdapter(o.adapter);
  const spec = (o.resume && adapter.resumeSpec ? adapter.resumeSpec(o) : null) ?? adapter.buildRun(o);
  spec.segment = o.resume?.segment ?? 1;
  const jsonlPath = join(o.runDir, `${o.adapter}.jsonl`);
  const errPath = join(o.runDir, "stderr.txt");
  o.log(`spawn: ${spec.exe} ${spec.args.map(a => (a.length > 60 ? a.slice(0, 57) + "..." : a)).join(" ")}`);

  return new Promise((resolve) => {
    const child = spawn(spec.exe, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env, BRIDGE_RUN: o.runId },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const state = { killed: false, stalled: false, threadId: null, lastMsgCount: 0, model: null, provider: null };
    o.onSpawn?.(child.pid);
    // 无进展判停（#25）：计时只被 milestone 重置，不被 stdout 字节重置。
    // 理由是实测决定的：四面都在「每完成一个 step / 每起一个工具」时吐 milestone
    // （codex=item.completed，pi=tool_execution_start，trae=Step N: Completed，
    // dsh=ITEM n），所以「有字节但无 milestone」= 模型在原地说话不干活；
    // 反过来按字节重置会让最话痨的失败跑法永远判不停。
    // 首个 milestone 前用更宽的 startupMs：长任务书 + 冷启动的首轮思考本来就慢。
    const stallMs = o.agentCfg.stallMs ?? o.stall?.ms ?? 600000;
    const startupStallMs = o.agentCfg.stallStartupMs ?? o.stall?.startupMs ?? 900000;
    let sawFirstMilestone = false;
    let stallTimer = null;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        state.stalled = true;
        o.log(`no progress for ${sawFirstMilestone ? stallMs : startupStallMs}ms（milestone 未增长）— killing pid ${child.pid} tree`);
        killTree(child.pid, { log: o.log });
      }, sawFirstMilestone ? stallMs : startupStallMs);
    };
    armStall();
    const out = createWriteStream(jsonlPath, { flags: "a" });
    const err = createWriteStream(errPath, { flags: "a" });
    let lineBuf = "";
    child.stdout.on("data", (c) => {
      out.write(c);
      lineBuf += c.toString("utf8");
      let i;
      while ((i = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, i).trim();
        lineBuf = lineBuf.slice(i + 1);
        if (!line) continue;
        try {
          const ev = adapter.parseEvent(line);
          if (ev?.threadId && !state.threadId) state.threadId = ev.threadId;
          if (ev?.model && !state.model) state.model = ev.model;
          if (ev?.provider && !state.provider) state.provider = ev.provider;
          if (ev?.milestone) {
            state.lastMsgCount += ev.milestone === "item" ? 1 : 0;
            sawFirstMilestone = true;
            armStall();
            o.onMilestone?.(ev.milestone, state);
          }
        } catch (e) { o.log(`parseEvent error: ${e.message}`); }
      }
    });
    child.stderr.on("data", (c) => err.write(c));
    if (spec.stdin !== false) { // adapters that take the task by file must not get a stdin write
      child.stdin.write(readFileSync(o.promptFile, "utf8"));
    }
    child.stdin.end();

    const killer = setTimeout(() => {
      state.killed = true;
      o.log(`timeout after ${o.agentCfg.timeoutMs}ms — killing pid ${child.pid} tree`);
      killTree(child.pid, { log: o.log });
    }, o.agentCfg.timeoutMs ?? 3600000);

    child.on("error", (e) => {
      clearTimeout(killer);
      clearTimeout(stallTimer);
      o.log(`spawn error: ${e.message}`);
      writeFileSync(join(o.runDir, "exit-code"), `-1 spawn-error ${e.message}`);
      resolve({ exitCode: -1, killed: false, stalled: false, resultText: null, threadId: null, spawnError: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      clearTimeout(stallTimer);
      out.end(); err.end();
      // 服务端实际用的模型名只在 run 结束后的产物里（trae 轨迹的 response.model），
      // 可能与请求名不同 ⇒ readMeta 的权威戳优先于 stdout 流里首见的那个。
      const stamp = (adapter.readMeta ? adapter.readMeta({ lastMsgFile: spec.lastMsgFile }) : null) ?? {};
      const model = stamp.model ?? state.model;
      const provider = stamp.provider ?? state.provider;
      // 遥测落盘绝不能反过来砸进程：spawn 失败等场景 runDir 可能已被清理。
      try {
        writeFileSync(join(o.runDir, "exit-code"), String(code));
        writeFileSync(join(o.runDir, "meta.json"), JSON.stringify({
        runId: o.runId, agent: o.adapter, pid: child.pid, exitCode: code,
        killed: state.killed, stalled: state.stalled,
        segment: spec.segment, resumed: !!spec.resumed,
        threadId: state.threadId, items: state.lastMsgCount,
        model, provider, agentSuccess: stamp.success ?? null,
        starve: stamp.starve ?? null, starvedTotal: stamp.starvedTotal ?? null,
      }, null, 1));
      } catch { /* runDir 已被清理等场景——遥测丢了就丢了，resolve 照常 */ }
      resolve({
        exitCode: code ?? -1,
        killed: state.killed,
        stalled: state.stalled,
        items: state.lastMsgCount,
        threadId: state.threadId,
        model,
        provider,
        agentSuccess: stamp.success ?? null,
        // 该面自报 success=true 也可能一个字没写出（输出预算在落笔前被切）⇒ 饿死读数单独透传
        starve: stamp.starve ?? null,
        starvedTotal: stamp.starvedTotal ?? null,
        resultText: adapter.readResult ? adapter.readResult({ lastMsgFile: spec.lastMsgFile }) : null,
      });
    });
  });
}
