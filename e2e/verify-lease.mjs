// 隔离验证：认领租约三态（lib/lease.js）
//   A) 自己身份（bridge）的过期 claim，不在 busyKeys → apply 后被释放 + note 上链
//   B) 自己身份但正在跑（busyKeys 命中）→ 豁免不动
//   C) 他人身份（codex）的过期 claim → 只进报告，绝不代释放
// 附带：report-only 轮必须零写板（head seq 不变）；apply 前后 verifyChain brokenAt=null。
// 全程第二实例 + 系统临时目录测试板，零 token，不碰真板真 state。
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const PKG = fileURLToPath(new URL('../board', import.meta.url));
const RUN = String(Date.now());
const BOARD = join(tmpdir(), `proofdeck-board-lease-verify-${RUN}`);
const NODE = process.execPath;
const CLI = `${PKG}/dist/cli.js`;
const TTL_MS = 24 * 3600000;

const board = (agent, args) => execFileSync(NODE, [CLI, ...args], {
  encoding: 'utf8',
  env: { ...process.env, OCTOBOARD_DIR: BOARD, OCTOBOARD_AGENT: agent },
});

for (const k of ['lease-own-stale', 'lease-own-busy', 'lease-other-stale']) {
  board('qoder', ['task', 'add', k, '--title', `租约验证 ${k}`, '--desc', '租约冒烟卡（测试板，勿在真板执行）']);
}
board('bridge', ['claim', 'lease-own-stale']);
board('bridge', ['claim', 'lease-own-busy']);
board('bridge', ['progress', 'lease-own-busy', '30']);
board('codex', ['claim', 'lease-other-stale']);

// 把 A、C 的 updated_at/claimed_at 回拨 30 小时（列名从 schema 动态认，别赌命名）
{
  const db = new DatabaseSync(`${BOARD}/board.db`);
  const cols = db.prepare("SELECT name FROM pragma_table_info('tasks')").all().map((r) => r.name);
  const updCol = cols.find((c) => /update/i.test(c));
  const claimCol = cols.find((c) => /claim/i.test(c) && !/by/i.test(c));
  const old = new Date(Date.now() - 30 * 3600000).toISOString();
  for (const k of ['lease-own-stale', 'lease-other-stale']) {
    db.prepare(`UPDATE tasks SET ${updCol} = ?${claimCol ? `, ${claimCol} = ?` : ''} WHERE key = ?`)
      .run(...(claimCol ? [old, old, k] : [old, k]));
  }
  db.close();
}

const boardLib = await import(pathToFileURL(`${SRC}/lib/lease.js`));
const boardChannel = await import(pathToFileURL(`${SRC}/lib/board.js`));
await boardChannel.init(PKG);   // daemon 启动同样先 init，Board 库是惰性装载的
const headOf = async () => {
  const { Board } = await import(pathToFileURL(`${PKG}/dist/board.js`));
  const b = Board.open({ boardDir: BOARD, agent: 'zcode' });
  try { return { seq: b.head().seq, chain: b.verifyChain() }; } finally { b.close(); }
};

const cfgB = { dir: BOARD, identity: 'bridge' };
const head0 = await headOf();

// 轮 1：report-only —— 分类必须正确，且零写板
const rep = await boardLib.leaseSweep({
  boardCfg: cfgB, identity: 'bridge', ttlMs: TTL_MS, sessionMs: 600000,
  busyKeys: new Set(['lease-own-busy']), apply: false, now: Date.now(),
});
const head1 = await headOf();

// 轮 2：apply —— 只释放 A；B 豁免；C 原样
const res = await boardLib.leaseSweep({
  boardCfg: cfgB, identity: 'bridge', ttlMs: TTL_MS, sessionMs: 600000,
  busyKeys: new Set(['lease-own-busy']), apply: true, now: Date.now(),
});
const head2 = await headOf();

const claimOf = async (k) => {
  const { Board } = await import(pathToFileURL(`${PKG}/dist/board.js`));
  const b = Board.open({ boardDir: BOARD, agent: 'zcode' });
  try { return b.taskCard(k)?.task.claimedBy ?? null; } finally { b.close(); }
};

const checks = [
  ['report-only: own-stale 识别 A', rep.ownStale.some((s) => s.key === 'lease-own-stale')],
  ['report-only: busy 豁免 B（在 aliveOwn，不在 ownStale）', rep.aliveOwn.some((s) => s.key === 'lease-own-busy') && !rep.ownStale.some((s) => s.key === 'lease-own-busy')],
  ['report-only: other-stale 识别 C', rep.otherStale.some((s) => s.key === 'lease-other-stale' && s.holder === 'codex')],
  ['report-only: 零写板（head seq 不变）', head1.seq === head0.seq],
  ['apply: 释放了 A', res.released.includes('lease-own-stale')],
  ['apply: A 的 claim 已清', (await claimOf('lease-own-stale')) === null],
  ['apply: B 原样（仍 bridge 持有）', (await claimOf('lease-own-busy')) === 'bridge'],
  ['apply: C 原样（仍 codex 持有，未被代释放）', (await claimOf('lease-other-stale')) === 'codex'],
  ['apply: 链校验 brokenAt=null', head2.chain.brokenAtSeq === null && head2.chain.ok],
  ['apply: C 出现在 otherStale 报告（本轮与上轮一致）', res.otherStale.some((s) => s.key === 'lease-other-stale')],
];
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
console.log(`head: ${head0.seq} -> ${head1.seq} -> ${head2.seq}`);
console.log(checks.every(([, ok]) => ok) ? 'LEASE VERIFY PASS' : 'LEASE VERIFY FAIL');
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
