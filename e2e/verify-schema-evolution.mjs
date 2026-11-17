// 机械验证：事件 schema 版本化规则四判据（docs/design/2026-10-02-设计-事件schema版本化规则.md §3）
//   A) 未来格式事件（新 kind + payload.v:2 + 未知键）按 computeHash 公式续链写入 → 链完好、读者透传
//   B) tasks 表 ADD COLUMN 后 Board API 照常工作、链完好（加法安全）
//   C) CLI 在含未知 kind 的板上照常工作（多版本读者并存）
//   D) 改旧行一个字符 → brokenAtSeq 精确命中（R1 不可改写是机器强制的）
// 全程系统临时目录测试板，真板零接触。D 放最后，做了链就故意断了。
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const PKG = fileURLToPath(new URL('../board', import.meta.url));
const RUN = String(Date.now());
const BOARD = join(tmpdir(), `proofdeck-board-schema-verify-${RUN}`);
const NODE = process.execPath;
const CLI = `${PKG}/dist/cli.js`;

const board = (agent, args) => execFileSync(NODE, [CLI, ...args], {
  encoding: 'utf8', env: { ...process.env, OCTOBOARD_DIR: BOARD, OCTOBOARD_AGENT: agent },
});
board('zcode', ['task', 'add', 'schema-evo-probe', '--title', 'schema 演进探针', '--desc', '测试板专用']);
board('zcode', ['claim', 'schema-evo-probe']);

// —— 用包自己的 Board.computeHash（未来写入方的唯一正解；顺带验证文档公式复刻与其一致）——
const { Board } = await import(pathToFileURL(`${PKG}/dist/board.js`));
const sha = (e) => Board.computeHash(e);

const openB = async () => Board.open({ boardDir: BOARD, agent: 'zcode' });

const head0 = await openB().then((b) => { try { return b.head(); } finally { b.close(); } });

// A) 注入未来格式事件：按写入方完整协议（行 + hash + meta head 锚更新）续链。
//    meta 的 head_seq/head_hash 是写协议的一部分——append() 每写一行就推进它，
//    verifyChain 尾部拿它做尾截断检查；裸插行不推进锚 = 故意制造"尾锚不符"。
{
  const db = new DatabaseSync(`${BOARD}/board.db`);
  const e = {
    seq: head0.seq + 1,
    at: new Date().toISOString(),
    actor: 'zcode', sessionId: null, kind: 'test_kind_v2',
    refTable: null, refId: null,
    summary: '[schema-evo] 未来格式事件：payload.v=2 + 读者不认识的键',
    payload: { v: 2, owner: '未来 risks.owner 的占位', due: '2026-10-09', unknownTomorrow: { nested: true } },
    prevHash: head0.hash,
  };
  db.prepare(`INSERT INTO timeline (id, seq, at, actor, session_id, kind, ref_table, ref_id, summary, payload, prev_hash, hash)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), e.seq, e.at, e.actor, e.sessionId, e.kind, e.refTable, e.refId, e.summary, JSON.stringify(e.payload), e.prevHash, sha(e));
  db.prepare("UPDATE meta SET value = ? WHERE key = 'head_seq'").run(String(e.seq));
  db.prepare("UPDATE meta SET value = ? WHERE key = 'head_hash'").run(sha(e));
  db.close();
}

// 判据读取
const chainOf = async () => (await openB().then((b) => { try { return b.verifyChain(); } finally { b.close(); } }));
const sinceEvent = async (afterSeq) => (await openB().then((b) => {
  try { return b.since(afterSeq).find((e) => e.kind === 'test_kind_v2') ?? null; } finally { b.close(); }
}));

const chainA = await chainOf();
const ev = await sinceEvent(head0.seq);

// B) 加列后 Board API 照常
{
  const db = new DatabaseSync(`${BOARD}/board.db`);
  db.exec("ALTER TABLE tasks ADD COLUMN zcode_test_owner TEXT");
  db.close();
}
{
  const b = await openB();
  try { b.setProgress('zcode', 'schema-evo-probe', 50); b.taskCard('schema-evo-probe'); } finally { b.close(); }
}
const chainB = await chainOf();

// C) CLI 照常（timeline 输出含未知 kind，status 正常退出）
const cliTimeline = board('zcode', ['timeline']);
const cliStatus = board('zcode', ['status']);

// D) 最后做：改写防线两连测
//    D1: DB 触发器直接拒绝 UPDATE（共享包 schema 自带的 append-only 守卫——第一道防线）
//    D2: 测试板上卸掉触发器再改一个字符 → 链校验精确指出断点（哈希链=第二道防线）
{
  const db = new DatabaseSync(`${BOARD}/board.db`);
  let rejected = false;
  try { db.prepare("UPDATE timeline SET summary = summary || 'x' WHERE seq = 1").run(); }
  catch (e) { rejected = /append-only/.test(e.message); }
  db.exec("DROP TRIGGER timeline_no_update; DROP TRIGGER timeline_no_delete;");
  db.prepare("UPDATE timeline SET summary = summary || 'x' WHERE seq = 1").run();
  db.close();
  globalThis.__d1 = rejected;
}
const chainD = await chainOf();

const checks = [
  ['A: 未来格式续链 → verifyChain ok', chainA.ok && chainA.brokenAtSeq === null && chainA.length === head0.seq + 1],
  ['A: since() 透传 payload.v=2 与未知键', ev?.payload?.v === 2 && ev?.payload?.unknownTomorrow?.nested === true],
  ['B: ADD COLUMN 后 Board API 写读正常、链完好', chainB.ok && chainB.brokenAtSeq === null],
  ['C: CLI timeline 照常渲染未知 kind 事件（按 summary）', cliTimeline.includes('未来格式事件')],
  ['C: CLI status 正常', cliStatus.includes('schema-evo-probe')],
  ['D1: DB 触发器拒绝 UPDATE（append-only 第一道防线）', globalThis.__d1 === true],
  ['D2: 绕过触发器改一行 → brokenAtSeq 精确命中 seq=1（链=第二道防线）', chainD.brokenAtSeq === 1],
];
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
console.log(checks.every(([, ok]) => ok) ? 'SCHEMA-EVO VERIFY PASS' : 'SCHEMA-EVO VERIFY FAIL');
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
