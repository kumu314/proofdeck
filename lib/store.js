// Atomic JSON state store for the bridge daemon.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export class Store {
  constructor(path) {
    this.path = path;
    this.state = this.#load();
  }
  #load() {
    try {
      if (existsSync(this.path)) return JSON.parse(readFileSync(this.path, "utf8"));
    } catch (e) {
      console.error("store: unreadable state.json, starting fresh:", e.message);
    }
    return {
      cursor: null,
      pid: null,
      startedAt: null,
      runs: {},    // key -> {agent, dir, pid, startedAt, model}
      finished: {},// key -> {at, result}
      pending: {}, // key -> {agent, at, reason}  (awaiting approval)
      approved: {},// key -> {at}  (one-shot human approval, consumed by handle)
      lanes: {},   // agent -> [key,...]
      laneAt: {},  // key -> {at, priority}  入队元数据（优先级排序与 aging 用）
      retries: {}, // key -> {n, dueAt, agent, why, lastAt}  自动重派台账
      supply: {},  // agent -> {category, streak, latchedAt, holdUntil, ...}  供应方熔断台账
    };
  }
  save() {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    renameSync(tmp, this.path);
  }
  get s() { return this.state; }

  // meta: {priority} —— assign 事件或调用方给的优先级（P0..P3），随入队记进 laneAt。
  queue(key, agent, meta = {}) {
    const lane = (this.state.lanes[agent] ??= []);
    if (!lane.includes(key) && !this.state.runs[key] && !this.state.finished[key] && !this.state.pending[key]) {
      lane.push(key);
      (this.state.laneAt ??= {})[key] = { at: Date.now(), priority: meta.priority ?? null };
      return true;
    }
    return false;
  }
  shiftLane(agent) {
    const lane = this.state.lanes[agent] ?? [];
    const key = lane.shift();
    if (key) delete this.state.laneAt?.[key];
    return key ?? null;
  }
  // 优先级出队（调度层 C.2）：按 schedule.bestLaneIndex 选最优一张并出队。
  // priorityOf(key) 由调用方提供（assign 时的 laneAt 记录 → 卡 payload → 缺省 P2）。
  pickBest(agent, priorityOf, now, agingMs, bestLaneIndex) {
    const lane = this.state.lanes[agent] ?? [];
    const i = bestLaneIndex({ lane, laneAt: this.state.laneAt ?? {}, priorityOf, now, agingMs });
    if (i < 0) return null;
    const [key] = lane.splice(i, 1);
    delete this.state.laneAt?.[key];
    return key ?? null;
  }
  // queue() 会对「已结案」的 key 静默返回 false——重派一张已完成的卡必须先清 finished。
  // 把这条规则收在一个地方，免得调用方各写一遍删键、漏掉 pending。
  requeue(key, agent, meta = {}) {
    if (this.state.runs[key]) return { ok: false, why: "该卡正在运行" };
    delete this.state.finished[key];
    delete this.state.pending[key];
    return this.queue(key, agent, meta)
      ? { ok: true }
      : { ok: false, why: `已在 ${agent} 的队列里` };
  }
  runningCount() { return Object.keys(this.state.runs).length; }
  runsFor(agent) { return Object.values(this.state.runs).filter((r) => r.agent === agent).length; }
  laneIdle(agent) { return !Object.values(this.state.runs).some(r => r.agent === agent); }

  // ---- 供应方熔断台账（#25）--------------------------------------------------
  // 台账按面存，不按供应方存：同一供应商的不同面（pi 与 dsh 都走 deepseek）在本机
  // 配置里没有可比对的供应方标识，宁可少冻一面，也不要错冻三面。
  supplyAll() { return (this.state.supply ??= {}); }
  supplyGet(agent) { return this.supplyAll()[agent] ?? null; }
  // streak = 这一面上「连续」的供应方失败次数，只在跑成功一次或人工 clear 时归零
  // （归零走 supplyRelease）。holdUntil 过期不算归零：探针又撞同样的墙就该继续加倍退避。
  supplyLatch(agent, info) {
    const all = this.supplyAll();
    const streak = (all[agent]?.streak ?? 0) + 1;
    all[agent] = { ...info, streak, latchedAt: Date.now(), holdUntil: Date.now() + info.holdMs };
    return all[agent];
  }
  supplyRelease(agent) {
    const all = this.supplyAll();
    const prev = all[agent] ?? null;
    delete all[agent];
    return prev;
  }
  supplyHeld(agent, now = Date.now()) {
    const rec = this.supplyGet(agent);
    return !!rec && rec.holdUntil > now;
  }
  beginRun(key, info) { this.state.runs[key] = info; }
  endRun(key, result, agent) {
    const r = this.state.runs[key] ?? {};
    delete this.state.runs[key];
    // 记下 agent：requeue 默认沿用上一次的面，不必人工再指一次。
    this.state.finished[key] = { at: new Date().toISOString(), result, agent: agent ?? r.agent ?? null };
  }
}
