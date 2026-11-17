import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
// Dual SQLite backend (2026-10-24): prefer Node's built-in node:sqlite (zero native
// deps, ABI-independent — survives Node upgrades like the 10-24 v26 swap that broke
// better-sqlite3's ABI-137 build), fall back to better-sqlite3 for runtimes older
// than ~22.13 where node:sqlite is absent/flagged. Force legacy with
// OCTOBOARD_BACKEND=better-sqlite3 (rollback lever). better-sqlite3 is loaded
// LAZILY (only when the legacy branch actually runs) so a fresh install on a
// modern Node needs no native module at all. The probes use createRequire
// (NOT top-level await) so this file stays a synchronous ESM graph and CJS
// consumers can still require() the dist build.
let NodeSqliteDb = null;
try {
    NodeSqliteDb = createRequire(import.meta.url)("node:sqlite").DatabaseSync ?? null;
}
catch { /* runtime without node:sqlite — legacy path below */ }
function loadLegacyDatabase() {
    try {
        return createRequire(import.meta.url)("better-sqlite3");
    }
    catch {
        throw new Error("node:sqlite unavailable (need Node >=22.13) and better-sqlite3 not installed — run: npm install better-sqlite3");
    }
}
// node:sqlite 缺 better-sqlite3 的三个面，直接补在 DatabaseSync 实例上（返回原对象）：
//   pragma(name)  —— 带返回行的 PRAGMA 查询（migrate 的 table_info 靠它读列）；
//   transaction() —— 含 better-sqlite3 的嵌套语义：外层 BEGIN/COMMIT、内层 SAVEPOINT/RELEASE
//                    （assign() 里套 message() 就是嵌套事务，平铺 BEGIN 会断写路径）；
//   inTransaction —— 事务内标志。所有 SQL 语句均为静态字面量。
function adaptNodeSqlite(raw) {
    let txDepth = 0;
    raw.pragma = (name) => raw.prepare("PRAGMA " + name).all();
    Object.defineProperty(raw, "inTransaction", { get: () => txDepth > 0 });
    const withTx = (fn, args, begin) => {
        const outer = txDepth === 0;
        if (outer)
            begin();
        else
            raw.exec("SAVEPOINT sp");
        txDepth++;
        try {
            const out = fn(...args);
            txDepth--;
            if (outer)
                raw.exec("COMMIT");
            else
                raw.exec("RELEASE SAVEPOINT sp");
            return out;
        }
        catch (e) {
            txDepth--;
            try {
                if (outer)
                    raw.exec("ROLLBACK");
                else
                    raw.exec("ROLLBACK TO SAVEPOINT sp; RELEASE SAVEPOINT sp");
            }
            catch { /* connection-level failure: surface the original error */ }
            throw e;
        }
    };
    raw.transaction = (fn) => {
        // better-sqlite3 形态：transaction 返回「可调用对象」（默认 BEGIN），
        // .deferred/.immediate/.exclusive 挂在函数上——board 的 _wrapTransactions 按此形态包门铃。
        const main = (...args) => withTx(fn, args, () => raw.exec("BEGIN"));
        main.deferred = (...args) => withTx(fn, args, () => raw.exec("BEGIN DEFERRED"));
        main.immediate = (...args) => withTx(fn, args, () => raw.exec("BEGIN IMMEDIATE"));
        main.exclusive = (...args) => withTx(fn, args, () => raw.exec("BEGIN EXCLUSIVE"));
        return main;
    };
    return raw;
}
// SQLite does NOT apply busy_timeout to the journal_mode switch: that pragma needs
// an exclusive lock and throws `database is locked` immediately if another agent
// holds a write txn or a hot -wal needs recovery. Retry in-process for the budget a
// busy handler would have given, then rethrow so a genuinely stuck board stays loud.
const WAL_SWITCH_RETRY_MS = 5000;
const WAL_SWITCH_RETRY_STEP_MS = 200;
const WAL_SWITCH_SLEEP = new Int32Array(new SharedArrayBuffer(4));
/**
 * Open (creating if needed) the SQLite database that backs a blackboard and
 * apply the schema. The schema is idempotent (`IF NOT EXISTS`), so opening an
 * existing board is safe. WAL mode lets multiple agents read while one writes —
 * the common case when several CLIs share one board.
 */
export function openDb(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    let db = null;
    if (process.env.OCTOBOARD_BACKEND !== "better-sqlite3" && NodeSqliteDb) {
        try { db = adaptNodeSqlite(new NodeSqliteDb(dbPath)); } catch { db = null; }
    }
    if (!db)
        db = new (loadLegacyDatabase())(dbPath); // legacy better-sqlite3 (needs matching ABI build)
    {
        const deadline = Date.now() + WAL_SWITCH_RETRY_MS;
        for (;;) {
            try {
                db.pragma("journal_mode = WAL");
                break;
            } catch (err) {
                if (Date.now() >= deadline) throw err;
                Atomics.wait(WAL_SWITCH_SLEEP, 0, 0, WAL_SWITCH_RETRY_STEP_MS);
            }
        }
    }
    // Durability to match the tamper-evident audit-log promise: FULL fsyncs each
    // commit so the most recent timeline entries + head anchor survive OS crash /
    // power loss, not just an app crash (WAL's default NORMAL would risk them).
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000"); // applies to the writes below, not to the WAL switch above
    applySchema(db);
    migrate(db);
    db.exec(INDEXES); // after migrate: indexes may reference newly-added columns
    return db;
}
function applySchema(db) {
    db.exec(SCHEMA);
}
/**
 * Additive, in-place migration for boards created by an earlier version. Only
 * ever ADDS nullable columns and new tables — never drops or rewrites — so
 * upgrading an existing `.octoboard/board.db` is safe and lossless.
 */
function migrate(db) {
    const columns = (table) => new Set(db.pragma(`table_info(${table})`).map((c) => c.name));
    const ensure = (table, column, decl) => {
        if (!columns(table).has(column)) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
        }
    };
    // agents: provider-independent identity fields
    ensure("agents", "provider", "TEXT");
    ensure("agents", "model", "TEXT");
    ensure("agents", "cli", "TEXT");
    ensure("agents", "version", "TEXT");
    // sessions: reshaped for first-class attribution (old boards had a stub,
    // never-written table using agent_id/ended_at; add the new columns beside it)
    ensure("sessions", "agent_name", "TEXT");
    ensure("sessions", "finished_at", "TEXT");
    ensure("sessions", "machine", "TEXT");
    ensure("sessions", "working_directory", "TEXT");
    ensure("sessions", "git_branch", "TEXT");
    ensure("sessions", "repository", "TEXT");
    ensure("sessions", "public_key", "TEXT");
    ensure("sessions", "last_heartbeat", "TEXT");
    // session linkage on writes
    ensure("timeline", "session_id", "TEXT");
    ensure("files_changed", "session_id", "TEXT");
    // decisions: evidence & relations
    ensure("decisions", "session_id", "TEXT");
    ensure("decisions", "evidence", "TEXT");
    ensure("decisions", "related_commits", "TEXT");
    ensure("decisions", "related_tasks", "TEXT");
    // handoffs: richer context
    ensure("handoffs", "from_session", "TEXT");
    ensure("handoffs", "to_session", "TEXT");
    ensure("handoffs", "context", "TEXT");
    ensure("handoffs", "related_files", "TEXT");
    ensure("handoffs", "open_questions", "TEXT");
    // tasks: kanban fields
    ensure("tasks", "number", "INTEGER");
    ensure("tasks", "description", "TEXT");
    ensure("tasks", "project", "TEXT");
    ensure("tasks", "impact", "TEXT");
    ensure("tasks", "risk_level", "TEXT");
    ensure("tasks", "progress", "INTEGER NOT NULL DEFAULT 0");
    // tasks: first-class acceptance spec (JSON) for the verification layer;
    // nullable, so tasks defined before this migration simply read back as null
    ensure("tasks", "acceptance", "TEXT");
    // --- four-layer partition: board -> project -> task -> trace ---------------
    // Purely additive: the `projects` table itself is created by SCHEMA above
    // (CREATE TABLE IF NOT EXISTS), so pre-existing boards only need the new
    // nullable columns. Nothing is renamed or dropped; old readers that never
    // mention these columns keep working unchanged.
    ensure("tasks", "stream", "TEXT");
    // projects.streams: the controlled stream vocabulary (JSON string array) that
    // `defineTask` enforces. Additive + nullable; boards predating this migration
    // simply read back NULL, which means "no vocabulary declared -> no rejection".
    ensure("projects", "streams", "TEXT");
    ensure("sessions", "project", "TEXT");
    ensure("sessions", "task_key", "TEXT");
    ensure("messages", "project", "TEXT");
    ensure("decisions", "project", "TEXT");
    ensure("risks", "project", "TEXT");
    ensure("handoffs", "project", "TEXT");
    ensure("evidence", "project", "TEXT");
    ensure("files_changed", "project", "TEXT");
    ensure("risks", "task_key", "TEXT");
    // timeline: the 7th trace table. Added in step 2 because §3.2 requires
    // `note --project/--task`, and `note` writes ONLY to timeline — without these
    // two columns a project-scoped note has nowhere to record its owner.
    // Nullable, purely additive: old readers never mention them.
    ensure("timeline", "project", "TEXT");
    ensure("timeline", "task_key", "TEXT");
    // risks: the close path (who resolved it, and when). Nullable, so risks
    // registered before this migration simply read back as "unresolved".
    ensure("risks", "resolved_at", "TEXT");
    ensure("risks", "resolved_by", "TEXT");
    ensure("evidence", "sha256", "TEXT");
    // evidence ledger (2026-10-10): `evidence` doubles as the project
    // "sedimentation register" -- each entry may be scoped to a task and tagged
    // with a kind (memory/skill/hook/lesson/playbook). Purely additive; rows
    // written before this migration simply read back null for both columns.
    ensure("evidence", "task_key", "TEXT");
    ensure("evidence", "kind", "TEXT");
    // Backfill stable, unique numbers for tasks created before numbering existed,
    // in creation order (rowid is unique, so no two tasks collide).
    db.exec(`UPDATE tasks SET number = (SELECT COUNT(*) FROM tasks t2 WHERE t2.rowid <= tasks.rowid)
     WHERE number IS NULL`);
    // Drop indexes that turned out redundant/low-value (present on boards created
    // by earlier versions): the implicit index on the UNIQUE seq column, and the
    // low-selectivity actor_type index.
    db.exec("DROP INDEX IF EXISTS idx_timeline_seq");
    db.exec("DROP INDEX IF EXISTS idx_attr_type");
}
/**
 * The board schema. Mirrors the domain model in `types.ts`. `timeline` is the
 * append-only hash chain every other write also records into.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  kind       TEXT,
  provider   TEXT,
  model      TEXT,
  cli        TEXT,
  version    TEXT,
  created_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  agent_name        TEXT NOT NULL,
  label             TEXT,
  machine           TEXT,
  working_directory TEXT,
  git_branch        TEXT,
  repository        TEXT,
  public_key        TEXT,
  last_heartbeat    TEXT,
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  project           TEXT,
  task_key          TEXT
);

CREATE TABLE IF NOT EXISTS redactions (
  seq        INTEGER PRIMARY KEY,
  reason     TEXT,
  actor      TEXT,
  created_at TEXT NOT NULL
);

-- Each agent's active session, kept in the DB (not a JSON file) so start/stop
-- are transactional and cannot race between concurrent CLI processes.
CREATE TABLE IF NOT EXISTS current_sessions (
  agent      TEXT PRIMARY KEY,
  session_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signatures (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  head_seq   INTEGER NOT NULL,
  head_hash  TEXT NOT NULL,
  signature  TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Projects: a first-class partition above tasks (board -> project -> task -> trace).
-- "key" is the stable English slug and the ONLY anchor tasks/traces reference;
-- "name" is the human-readable (Chinese) display name. "created_by" records the
-- project's author, which the four-layer design requires to be traceable.
-- "streams" is the project's controlled stream vocabulary (JSON array of strings);
-- NULL/empty means "no vocabulary declared" and tasks may carry any stream.
-- Additive: new table, so boards created before this migration are untouched.
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  streams     TEXT,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  number      INTEGER,
  title       TEXT,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  project     TEXT,
  stream      TEXT,
  impact      TEXT,
  risk_level  TEXT,
  progress    INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT,
  claimed_by  TEXT,
  claimed_at  TEXT,
  released_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Agents assigned to a task (many-to-many). Assigning is how "notify Claude to
-- look at task #145" is recorded — it also drops a message in the assignee's
-- inbox. The board records the assignment; it never launches the agent.
CREATE TABLE IF NOT EXISTS task_assignees (
  task_key    TEXT NOT NULL,
  agent       TEXT NOT NULL,
  assigned_by TEXT,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (task_key, agent)
);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent   TEXT,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at    TEXT,
  project    TEXT
);

-- Per-agent ack ledger. messages.read_at is one column on the message row, so it
-- can only record "someone has seen this" — and for a broadcast (to_agent IS
-- NULL) a single agent's read would hide the message from every other agent.
-- Reads are therefore keyed by (message, agent). messages.read_at is still
-- stamped on first read as the legacy global "seen by anyone" flag.
CREATE TABLE IF NOT EXISTS message_reads (
  message_id TEXT NOT NULL,
  agent      TEXT NOT NULL,
  read_at    TEXT NOT NULL,
  PRIMARY KEY (message_id, agent)
);

CREATE TABLE IF NOT EXISTS decisions (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  session_id      TEXT,
  title           TEXT NOT NULL,
  rationale       TEXT,
  evidence        TEXT,
  related_commits TEXT,
  related_tasks   TEXT,
  created_at      TEXT NOT NULL,
  project         TEXT
);

CREATE TABLE IF NOT EXISTS evidence (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  ref        TEXT NOT NULL,
  note       TEXT,
  target     TEXT,
  sha256     TEXT,
  created_at TEXT NOT NULL,
  project    TEXT,
  task_key   TEXT,
  kind       TEXT
);

CREATE TABLE IF NOT EXISTS files_changed (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  session_id TEXT,
  path       TEXT NOT NULL,
  change     TEXT NOT NULL,
  task_key   TEXT,
  created_at TEXT NOT NULL,
  project    TEXT
);

CREATE TABLE IF NOT EXISTS risks (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  title      TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'medium',
  status     TEXT NOT NULL DEFAULT 'open',
  task_key   TEXT,
  created_at TEXT NOT NULL,
  project    TEXT
);

CREATE TABLE IF NOT EXISTS handoffs (
  id             TEXT PRIMARY KEY,
  from_agent     TEXT NOT NULL,
  to_agent       TEXT NOT NULL,
  from_session   TEXT,
  to_session     TEXT,
  summary        TEXT NOT NULL,
  context        TEXT,
  related_files  TEXT,
  open_questions TEXT,
  task_key       TEXT,
  created_at     TEXT NOT NULL,
  accepted_at    TEXT,
  project        TEXT
);

CREATE TABLE IF NOT EXISTS attributions (
  id         TEXT PRIMARY KEY,
  commit_sha TEXT NOT NULL,
  file       TEXT,
  hunk       TEXT,
  actor_type TEXT NOT NULL,
  actor      TEXT NOT NULL,
  provider   TEXT,
  model      TEXT,
  cli        TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id            TEXT PRIMARY KEY,
  commit_sha    TEXT NOT NULL,
  reviewer_type TEXT NOT NULL,
  reviewer      TEXT NOT NULL,
  session_id    TEXT,
  outcome       TEXT NOT NULL,
  note          TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS timeline (
  id         TEXT PRIMARY KEY,
  seq        INTEGER NOT NULL UNIQUE,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  session_id TEXT,
  kind       TEXT NOT NULL,
  ref_table  TEXT,
  ref_id     TEXT,
  summary    TEXT NOT NULL,
  payload    TEXT,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL
);

-- Enforce append-only at the database layer, for EVERY connection (not just the
-- board's code): the timeline can be INSERTed into, never UPDATEd or DELETEd.
-- This turns "append-only by convention" into "append-only by default" — a
-- casual sqlite3 edit or a buggy write is refused. A determined attacker with
-- DB access can still DROP these triggers, but then the hash chain + head anchor
-- detect the tamper (belt and braces). No legitimate code path updates/deletes
-- timeline rows (redaction uses an overlay; prune never touches the timeline).
CREATE TRIGGER IF NOT EXISTS timeline_no_update BEFORE UPDATE ON timeline
BEGIN SELECT RAISE(ABORT, 'timeline is append-only: rows cannot be modified'); END;
CREATE TRIGGER IF NOT EXISTS timeline_no_delete BEFORE DELETE ON timeline
BEGIN SELECT RAISE(ABORT, 'timeline is append-only: rows cannot be deleted'); END;

`;
/**
 * Indexes, applied after migration so they may safely reference columns added
 * to pre-existing tables during an upgrade.
 */
const INDEXES = `
-- NB: timeline.seq is INTEGER UNIQUE, which already creates an implicit index —
-- so no explicit idx_timeline_seq (it would be a redundant duplicate B-tree).
-- actor_type is too low-selectivity (2-3 values) for an index to help.
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent, read_at);
CREATE INDEX IF NOT EXISTS idx_files_task ON files_changed(task_key);
CREATE INDEX IF NOT EXISTS idx_files_session ON files_changed(session_id);
CREATE INDEX IF NOT EXISTS idx_files_path ON files_changed(path);
CREATE INDEX IF NOT EXISTS idx_timeline_session ON timeline(session_id);
CREATE INDEX IF NOT EXISTS idx_risks_status ON risks(status);
CREATE INDEX IF NOT EXISTS idx_attr_commit ON attributions(commit_sha);
CREATE INDEX IF NOT EXISTS idx_attr_file ON attributions(file);
CREATE INDEX IF NOT EXISTS idx_attr_actor ON attributions(actor);
CREATE INDEX IF NOT EXISTS idx_reviews_commit ON reviews(commit_sha);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(finished_at, last_heartbeat);
CREATE INDEX IF NOT EXISTS idx_assignees_task ON task_assignees(task_key);
CREATE INDEX IF NOT EXISTS idx_risks_task ON risks(task_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_number ON tasks(number);
-- four-layer partition: filter tasks by project/stream, and join traces by project.
-- projects.key is UNIQUE so it already has an implicit index (no duplicate B-tree).
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project);
CREATE INDEX IF NOT EXISTS idx_tasks_stream ON tasks(stream);
CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project);
CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project);
CREATE INDEX IF NOT EXISTS idx_risks_project ON risks(project);
CREATE INDEX IF NOT EXISTS idx_handoffs_project ON handoffs(project);
CREATE INDEX IF NOT EXISTS idx_evidence_project ON evidence(project);
-- evidence ledger (2026-10-10): filter the register by task / kind.
CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence(task_key);
CREATE INDEX IF NOT EXISTS idx_evidence_kind ON evidence(kind);
CREATE INDEX IF NOT EXISTS idx_files_project ON files_changed(project);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
`;
//# sourceMappingURL=db.js.map