import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { openDb } from "./db.js";
import { loadConfig, } from "./config.js";
import * as git from "./git.js";
import { generateSessionKeypair, signHash, verifyHash } from "./signing.js";
const GENESIS_HASH = "0".repeat(64);
/** Valid project lifecycle values (step 2). Enforced by `setProjectStatus`. */
const PROJECT_STATUSES = ["active", "paused", "archived"];
// evidence-ledger (2026-10-10): the controlled vocabulary for `evidence.kind`.
// A whitelist, not free text, so the sedimentation register cannot fragment into
// spelling variants the way `tasks.project` once did.
const EVIDENCE_KINDS = ["memory", "skill", "hook", "lesson", "playbook"];
/**
 * Agent-identity aliases (2026-10-10). The same assistant is registered on the
 * board under two identities: `xiaoyu` (this session's persona) and `workbuddy`
 * (the WorkBuddy MCP-client identity that other agents such as lingyu message).
 * With no merge, a message sent to `workbuddy` is invisible in `xiaoyu`'s inbox,
 * so the assistant "never received" things it was told about. `recipientSet`
 * expands an agent to the full set of identities that share ONE inbox, so
 * reading or acking either identity covers both. Agents absent from the map keep
 * their original single-identity behaviour — fully backward compatible.
 */
const AGENT_ALIASES = {
    xiaoyu: ["xiaoyu", "workbuddy"],
    workbuddy: ["xiaoyu", "workbuddy"],
};
function recipientSet(agent) {
    return AGENT_ALIASES[agent] ?? [agent];
}
function now() {
    return new Date().toISOString();
}
function id() {
    return randomUUID();
}
/** Schema tag for the portable attribution bundle. Bump on breaking changes. */
export const BUNDLE_VERSION = "octopus-blackboard/attribution-bundle@1";
/**
 * The blackboard. A thin, synchronous wrapper over a SQLite database. Every
 * mutation also appends one tamper-evident entry to the timeline within the
 * same transaction, so the board and its audit log can never diverge.
 *
 * The board is deliberately passive: it records and reports. It never triggers
 * an agent, schedules work, or decides anything on an agent's behalf.
 */
export class Board {
    config;
    db;
    /** Active session id for the acting agent; stamped onto every write. */
    activeSession;
    constructor(config) {
        this.config = config;
        this.db = openDb(config.dbPath);
        // LOCAL PUSH PATCH (best-effort doorbell): after the OUTERMOST committed
        // transaction, overwrite <boardDir>/notify.json with a hint so resident
        // watchers wake on an OS file event instead of polling. The timeline hash
        // chain stays the source of truth; hint loss or staleness is recoverable.
        this._pending = [];
        this._doorbell = process.env.OCTOBOARD_NOTIFY?.trim() ||
            join(config.boardDir, "notify.json");
        this._wrapTransactions();
        // An explicit env/flag session wins; otherwise resolve the agent's active
        // session from the DB (set transactionally by session start/stop).
        this.activeSession =
            config.sessionId ?? this.currentSessionFromDb(config.agent);
    }
    /** Guard every transaction flavor so the doorbell fires only after a real
     *  commit (never on rollback) and only from the outermost one (savepoint
     *  children still run inside the transaction). */
    _wrapTransactions() {
        const db = this.db;
        const rawTx = db.transaction.bind(db);
        db.transaction = (fn) => {
            const t = rawTx(fn);
            const board = this;
            const guard = (m) => (...a) => {
                try {
                    return m.apply(t, a);
                }
                catch (e) {
                    board._pending = []; // rolled back — stay silent
                    throw e;
                }
                finally {
                    if (!db.inTransaction)
                        board._notify();
                }
            };
            const wrapped = (...a) => guard(t)(...a);
            wrapped.deferred = guard(t.deferred);
            wrapped.immediate = guard(t.immediate);
            wrapped.exclusive = guard(t.exclusive);
            return wrapped;
        };
    }
    /** Overwrite the doorbell hint atomically. Never throws: a failed fan-out
     *  must not affect the write that already committed. */
    _notify() {
        try {
            const q = this._pending;
            this._pending = [];
            if (!q.length)
                return;
            const last = q[q.length - 1];
            mkdirSync(dirname(this._doorbell), { recursive: true });
            const tmp = `${this._doorbell}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify({
                head: last.seq,
                n: q.length,
                at: last.at,
                kind: last.kind,
                actor: last.actor,
            }));
            renameSync(tmp, this._doorbell);
        }
        catch {
            /* hint is advisory; drop it on failure */
        }
    }
    currentSessionFromDb(agent) {
        const row = this.db
            .prepare("SELECT session_id FROM current_sessions WHERE agent = ?")
            .get(agent);
        return row?.session_id ?? null;
    }
    /** The active session id for this board's agent (null if none). */
    activeSessionId() {
        return this.activeSession;
    }
    static open(overrides = {}) {
        const config = loadConfig(overrides);
        // Per-handle session overrides are required when one process writes on
        // behalf of concurrent tasks. They win over the process-wide env default.
        if (Object.prototype.hasOwnProperty.call(overrides, "sessionId")) {
            config.sessionId = overrides.sessionId ?? null;
        }
        return new Board(config);
    }
    close() {
        this.db.close();
    }
    // --- timeline (hash chain) -------------------------------------------------
    headHash() {
        const row = this.db
            .prepare("SELECT seq, hash FROM timeline ORDER BY seq DESC LIMIT 1")
            .get();
        return row
            ? { seq: row.seq, hash: row.hash }
            : { seq: 0, hash: GENESIS_HASH };
    }
    /**
     * The tamper-evident core of a timeline entry.
     *
     * ⚠️ `project` / `task_key` (step 2) are deliberately EXCLUDED. Adding them
     * would change the array length and therefore break the recomputed hash of
     * every pre-existing row — i.e. it would make `verifyChain()` report the whole
     * history as altered. Consequence to be aware of: those two columns are
     * *attached attributes*, not hash-protected. Falsifying them does not break
     * `verifyChain()`. They are safe for ownership/aggregation, not for proof.
     * (The same is true of the `project` columns on the other six trace tables,
     * which live in separate tables and were never inside the chain either.)
     */
    static computeHash(e) {
        const canonical = JSON.stringify([
            e.seq,
            e.at,
            e.actor,
            e.sessionId,
            e.kind,
            e.refTable,
            e.refId,
            e.summary,
            e.payload ?? null,
            e.prevHash,
        ]);
        return createHash("sha256").update(canonical).digest("hex");
    }
    /** Append one entry to the timeline. Must run inside a transaction.
     *  `opts.project` / `opts.taskKey` (step 2) record four-layer ownership.
     *  NOTE: they are deliberately NOT part of `computeHash` — see the comment on
     *  `computeHash` for why, and the caveat that follows from it. */
    append(actor, kind, summary, refTable, refId, payload, opts = {}) {
        const head = this.headHash();
        const seq = head.seq + 1;
        const at = now();
        const event = {
            id: id(),
            seq,
            at,
            actor,
            sessionId: this.activeSession,
            kind,
            refTable,
            refId,
            summary,
            payload: payload ?? null,
            prevHash: head.hash,
            hash: "",
        };
        event.hash = Board.computeHash(event);
        this.db
            .prepare(`INSERT INTO timeline (id, seq, at, actor, session_id, kind, ref_table, ref_id, summary, payload, prev_hash, hash, project, task_key)
         VALUES (@id, @seq, @at, @actor, @sessionId, @kind, @refTable, @refId, @summary, @payload, @prevHash, @hash, @project, @taskKey)`)
            .run({
            ...event,
            payload: event.payload === null ? null : JSON.stringify(event.payload),
            project: opts.project ?? null,
            taskKey: opts.taskKey ?? null,
        });
        // Anchor the head (seq + hash) so tail truncation is detectable: deleting
        // the newest rows leaves an internally-consistent chain, but no longer
        // matches the recorded head. Same transaction as the insert.
        this.db
            .prepare("INSERT INTO meta (key, value) VALUES ('head_seq', @seq), ('head_hash', @hash) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run({ seq: String(event.seq), hash: event.hash });
        // LOCAL PUSH PATCH: queue the hint; flushed post-commit by the
        // transaction guard. Must never break a write.
        try {
            (this._pending ??= []).push({ seq: event.seq, at: event.at, kind, actor });
        }
        catch { }
        return event;
    }
    /** The current timeline head (seq + hash). Record this OUTSIDE the DB — in a
     *  commit, a log, a second machine — to anchor against tail truncation. */
    head() {
        return this.headHash();
    }
    /**
     * Check the chain against an anchor recorded earlier (e.g. committed to git).
     * `ok` = the anchored row still exists with that hash and history through it
     * is intact; `truncated` = rows at/below the anchor were deleted; `altered` =
     * history at/below the anchor was edited. This is what closes the "attacker
     * drops the trigger and truncates" gap — an external anchor makes truncation
     * provable.
     */
    verifyAnchor(seq, hash) {
        const chain = this.verifyChain();
        const headSeq = this.headHash().seq;
        if (headSeq < seq) {
            return { status: "truncated", headSeq };
        }
        const row = this.db
            .prepare("SELECT hash FROM timeline WHERE seq = ?")
            .get(seq);
        if (!row) {
            return { status: "truncated", headSeq };
        }
        if (row.hash !== hash) {
            return { status: "altered", headSeq };
        }
        if (!chain.ok && chain.brokenAtSeq !== null && chain.brokenAtSeq <= seq) {
            return { status: "altered", headSeq };
        }
        return { status: "ok", headSeq };
    }
    headAnchor() {
        const rows = this.db
            .prepare("SELECT key, value FROM meta WHERE key IN ('head_seq','head_hash')")
            .all();
        const map = new Map(rows.map((r) => [r.key, r.value]));
        const seq = map.get("head_seq");
        const hash = map.get("head_hash");
        return seq !== undefined && hash !== undefined
            ? { seq: Number(seq), hash }
            : null;
    }
    /** Re-walk the chain and confirm every hash links to its predecessor. */
    verifyChain() {
        const rows = this.db
            .prepare("SELECT * FROM timeline ORDER BY seq ASC")
            .all();
        const anchor = this.headAnchor();
        const anchored = anchor !== null;
        let prevHash = GENESIS_HASH;
        let prevSeq = 0;
        for (const row of rows) {
            // Contiguity: seq must increment by exactly 1 (catches a missing middle
            // row even before the hash check).
            if (row.seq !== prevSeq + 1) {
                return {
                    ok: false,
                    length: rows.length,
                    brokenAtSeq: row.seq,
                    anchored,
                };
            }
            const recomputed = Board.computeHash({
                seq: row.seq,
                at: row.at,
                actor: row.actor,
                sessionId: row.session_id,
                kind: row.kind,
                refTable: row.ref_table,
                refId: row.ref_id,
                summary: row.summary,
                payload: row.payload === null ? null : JSON.parse(row.payload),
                prevHash,
            });
            if (row.prev_hash !== prevHash || row.hash !== recomputed) {
                return {
                    ok: false,
                    length: rows.length,
                    brokenAtSeq: row.seq,
                    anchored,
                };
            }
            prevHash = row.hash;
            prevSeq = row.seq;
        }
        // Tail-truncation check against the recorded head anchor. When no anchor is
        // present on a non-empty timeline (legacy board, OR a deleted anchor), tail
        // truncation cannot be detected from the DB alone — reported via `anchored`
        // so callers don't present it as a clean pass.
        if (anchor) {
            const lastSeq = rows.length > 0 ? rows[rows.length - 1].seq : 0;
            const lastHash = rows.length > 0 ? rows[rows.length - 1].hash : GENESIS_HASH;
            if (lastSeq !== anchor.seq || lastHash !== anchor.hash) {
                return {
                    ok: false,
                    length: rows.length,
                    brokenAtSeq: anchor.seq,
                    anchored,
                };
            }
        }
        return { ok: true, length: rows.length, brokenAtSeq: null, anchored };
    }
    timeline(limit = 50) {
        const rows = this.db
            .prepare("SELECT * FROM timeline ORDER BY seq DESC LIMIT ?")
            .all(limit);
        return this.applyRedactions(rows.map(rowToTimeline).reverse());
    }
    /** The current head sequence number (0 if the board is empty). */
    headSeq() {
        return this.headHash().seq;
    }
    /** Timeline events after `afterSeq`, oldest first — the polling primitive
     *  behind `watch`/`subscribe`. Passive: callers poll; the board never pushes. */
    since(afterSeq) {
        return this.applyRedactions(this.db
            .prepare("SELECT * FROM timeline WHERE seq > ? ORDER BY seq ASC")
            .all(afterSeq).map(rowToTimeline));
    }
    /**
     * Filter events down to those an agent should be notified about: messages to
     * it (or broadcast), handoffs to it, and claim conflicts on keys it holds. An
     * agent's own actions are excluded. This is what makes `watch --for <agent>`
     * a useful inbox rather than a firehose.
     */
    notable(events, agent) {
        return events.filter((e) => {
            if (e.actor === agent) {
                return false;
            }
            const payload = (e.payload ?? {});
            switch (e.kind) {
                case "message":
                    return payload.to === agent || payload.to === null;
                case "claim":
                    return payload.conflict === agent;
                case "handoff": {
                    if (!e.refId) {
                        return false;
                    }
                    const row = this.db
                        .prepare("SELECT to_agent FROM handoffs WHERE id = ?")
                        .get(e.refId);
                    return row?.to_agent === agent;
                }
                default:
                    return false;
            }
        });
    }
    // --- agents ----------------------------------------------------------------
    /**
     * Register the agent if new and stamp `last_seen`. Idempotent by name. When
     * registering the acting agent, its full provider-independent identity
     * (provider/model/cli/version) is merged in; non-null fields never overwrite
     * with null, so a later bare touch cannot erase identity.
     */
    ensureAgent(name, identity) {
        const id0 = identity ??
            (name === this.config.agent ? this.config.identity : undefined);
        const existing = this.db
            .prepare("SELECT * FROM agents WHERE name = ?")
            .get(name);
        const at = now();
        if (existing) {
            this.db
                .prepare(`UPDATE agents SET last_seen = ?,
             kind = COALESCE(?, kind), provider = COALESCE(?, provider),
             model = COALESCE(?, model), cli = COALESCE(?, cli), version = COALESCE(?, version)
           WHERE id = ?`)
                .run(at, id0?.kind ?? null, id0?.provider ?? null, id0?.model ?? null, id0?.cli ?? null, id0?.version ?? null, existing.id);
            return rowToAgent(this.db.prepare("SELECT * FROM agents WHERE id = ?").get(existing.id));
        }
        const agent = {
            id: id(),
            name,
            kind: id0?.kind ?? null,
            provider: id0?.provider ?? null,
            model: id0?.model ?? null,
            cli: id0?.cli ?? null,
            version: id0?.version ?? null,
            createdAt: at,
            lastSeen: at,
        };
        this.db
            .prepare("INSERT INTO agents (id, name, kind, provider, model, cli, version, created_at, last_seen) VALUES (@id, @name, @kind, @provider, @model, @cli, @version, @createdAt, @lastSeen)")
            .run(agent);
        return agent;
    }
    getAgent(name) {
        const row = this.db
            .prepare("SELECT * FROM agents WHERE name = ?")
            .get(name);
        return row ? rowToAgent(row) : undefined;
    }
    // --- sessions --------------------------------------------------------------
    /**
     * Open a new session for the acting agent and make it current (persisted in
     * the DB, so later CLI invocations attribute to it). Captures the machine and
     * repository context the session runs in.
     */
    startSession(label = null, options = {}) {
        const { project = null, taskKey = null, detached = false } = options ?? {};
        const sessionId = id();
        // Generate the session keypair up front; the private key stays local (in
        // the board's keys/ dir), only the public key is recorded on the session.
        const keypair = generateSessionKeypair();
        this.saveSessionKey(sessionId, keypair.privateKeyPem);
        const tx = this.db.transaction(() => {
            this.ensureAgent(this.config.agent);
            const at = now();
            const session = {
                id: sessionId,
                agentName: this.config.agent,
                label,
                machine: hostname(),
                workingDirectory: process.cwd(),
                gitBranch: git.currentBranch() ?? null,
                repository: git.remoteUrl() ?? git.repoRoot() ?? null,
                publicKey: keypair.publicKeyPem,
                lastHeartbeat: at,
                startedAt: at,
                finishedAt: null,
                project,
                taskKey,
            };
            this.db
                .prepare(`INSERT INTO sessions (id, agent_name, label, machine, working_directory, git_branch, repository, public_key, last_heartbeat, started_at, finished_at, project, task_key)
           VALUES (@id, @agentName, @label, @machine, @workingDirectory, @gitBranch, @repository, @publicKey, @lastHeartbeat, @startedAt, @finishedAt, @project, @taskKey)`)
                .run(session);
            // Stamp subsequent events (including this one) with the new session.
            // Detached sessions deliberately avoid the per-agent current_sessions pointer:
            // the bridge can run several tasks concurrently without cross-attribution.
            this.activeSession = session.id;
            if (!detached) {
                this.db
                    .prepare("INSERT OR REPLACE INTO current_sessions (agent, session_id) VALUES (?, ?)")
                    .run(this.config.agent, session.id);
            }
            const sessionPayload = { machine: session.machine, gitBranch: session.gitBranch };
            if (project != null || taskKey != null || detached) {
                Object.assign(sessionPayload, { project, taskKey, detached: !!detached });
            }
            this.append(this.config.agent, "session-start", `session started${label ? ` (${label})` : ""}`, "sessions", session.id, sessionPayload);
            return session;
        });
        return tx.immediate();
    }
    // --- session signing (v0) --------------------------------------------------
    keyPath(sessionId) {
        return join(this.config.boardDir, "keys", `${sessionId}.key`);
    }
    saveSessionKey(sessionId, privateKeyPem) {
        const path = this.keyPath(sessionId);
        // 0700 dir + 0600 file: private keys are not listable/readable by other
        // local users.
        mkdirSync(join(this.config.boardDir, "keys"), {
            recursive: true,
            mode: 0o700,
        });
        writeFileSync(path, privateKeyPem, { mode: 0o600 });
    }
    loadSessionKey(sessionId) {
        const path = this.keyPath(sessionId);
        return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    }
    /**
     * Sign the current timeline head hash with a session's private key. The
     * signature attests "this session vouches for board state through seq N".
     * Recorded in the `signatures` table (not the chain, so the head stays put).
     */
    signHead(sessionId) {
        const sid = sessionId ?? this.activeSession;
        if (!sid) {
            return undefined;
        }
        const priv = this.loadSessionKey(sid);
        const session = this.getSession(sid);
        if (!priv || !session?.publicKey) {
            return undefined;
        }
        const head = this.headHash();
        if (head.seq === 0) {
            return undefined;
        }
        const signature = signHash(priv, head.hash);
        this.db
            .prepare(`INSERT INTO signatures (id, session_id, head_seq, head_hash, signature, public_key, created_at)
         VALUES (@id, @sessionId, @headSeq, @headHash, @signature, @publicKey, @createdAt)`)
            .run({
            id: id(),
            sessionId: sid,
            headSeq: head.seq,
            headHash: head.hash,
            signature,
            publicKey: session.publicKey,
            createdAt: now(),
        });
        return { headSeq: head.seq, headHash: head.hash };
    }
    /**
     * Verify every recorded signature. `valid` = the signature checks out against
     * its public key. `current` = the signed head hash still matches the timeline
     * row at that seq (i.e. history below it was not altered/truncated since).
     */
    verifySignatures(chain) {
        const rows = this.db
            .prepare("SELECT * FROM signatures ORDER BY head_seq ASC")
            .all();
        if (rows.length === 0) {
            return [];
        }
        // A signature only "covers" its head if the chain is actually intact up to
        // that seq — otherwise a tamper below the signed head (that leaves the head
        // row's stored hash untouched) would still read as trusted. Accept a
        // precomputed chain to avoid re-verifying the whole timeline repeatedly.
        const verified = chain ?? this.verifyChain();
        return rows.map((r) => {
            const valid = verifyHash(r.public_key, r.head_hash, r.signature);
            const row = this.db
                .prepare("SELECT hash FROM timeline WHERE seq = ?")
                .get(r.head_seq);
            const chainOkThroughHead = verified.ok ||
                (verified.brokenAtSeq !== null && r.head_seq < verified.brokenAtSeq);
            const session = this.getSession(r.session_id);
            return {
                sessionId: r.session_id,
                agent: session?.agentName ?? null,
                headSeq: r.head_seq,
                valid,
                current: row?.hash === r.head_hash && chainOkThroughHead,
                at: r.created_at,
            };
        });
    }
    /** Highest seq that a valid, still-current signature vouches for (0 = none). */
    signedThrough(chain) {
        return this.verifySignatures(chain)
            .filter((s) => s.valid && s.current)
            .reduce((max, s) => Math.max(max, s.headSeq), 0);
    }
    /** Close a session (the active one by default) and clear the pointer. */
    stopSession(sessionId) {
        const target = sessionId ?? this.activeSession;
        if (!target) {
            return undefined;
        }
        const tx = this.db.transaction(() => {
            const existing = this.getSession(target);
            if (!existing) {
                return undefined;
            }
            const at = now();
            this.db
                .prepare("UPDATE sessions SET finished_at = ? WHERE id = ?")
                .run(at, target);
            this.activeSession = target;
            // Clear the pointer transactionally (only if it still points here, so a
            // concurrent new session for the same agent is not clobbered).
            this.db
                .prepare("DELETE FROM current_sessions WHERE agent = ? AND session_id = ?")
                .run(existing.agentName ?? this.config.agent, target);
            this.append(existing.agentName ?? this.config.agent, "session-stop", "session stopped", "sessions", target, null);
            return this.getSession(target);
        });
        const session = tx.immediate();
        if (session) {
            // Sign the head (now including the session-stop event) so the session's
            // final state is vouched for. Best-effort: never fails a stop.
            try {
                this.signHead(target);
            }
            catch {
                /* signing is advisory in v0 */
            }
        }
        return session;
    }
    getSession(sessionId) {
        const row = this.db
            .prepare("SELECT * FROM sessions WHERE id = ?")
            .get(sessionId);
        return row ? rowToSession(row) : undefined;
    }
    listSessions(limit = 30) {
        return this.db
            .prepare("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?")
            .all(limit).map(rowToSession);
    }
    /** All timeline events belonging to a session, oldest first. */
    sessionTimeline(sessionId) {
        return this.applyRedactions(this.db
            .prepare("SELECT * FROM timeline WHERE session_id = ? ORDER BY seq ASC")
            .all(sessionId).map(rowToTimeline));
    }
    listAgents() {
        return this.db
            .prepare("SELECT * FROM agents ORDER BY last_seen DESC")
            .all().map(rowToAgent);
    }
    // --- writes (each is one transaction: entity + timeline entry) -------------
    /** A free-form status note broadcast to the board.
     *  `opts.project` / `opts.taskKey` (step 2) scope the note to a project/task. */
    note(actor, text, opts = {}) {
        const tx = this.db.transaction(() => {
            this.ensureAgent(actor);
            return this.append(actor, "note", text, null, null, null, {
                project: opts.project ?? null,
                taskKey: opts.taskKey ?? null,
            });
        });
        return tx.immediate();
    }
    /**
     * Claim a task by key, creating it if absent. If another agent already holds
     * an unreleased claim, the claim still records but `conflict` names the
     * holder — the board surfaces the collision rather than blocking it.
     */
    claim(actor, key, title = null) {
        const tx = this.db.transaction(() => {
            this.ensureAgent(actor);
            const at = now();
            const existing = this.db
                .prepare("SELECT * FROM tasks WHERE key = ?")
                .get(key);
            let conflict = null;
            let task;
            if (!existing) {
                this.db
                    .prepare(`INSERT INTO tasks (id, key, number, title, status, created_by, claimed_by, claimed_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?)`)
                    .run(id(), key, this.nextTaskNumber(), title, actor, actor, at, at, at);
                task = rowToTask(this.db.prepare("SELECT * FROM tasks WHERE key = ?").get(key));
            }
            else {
                if (existing.claimed_by &&
                    existing.claimed_by !== actor &&
                    !existing.released_at) {
                    conflict = existing.claimed_by;
                }
                this.db
                    .prepare("UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ?, released_at = NULL, title = COALESCE(?, title), updated_at = ? WHERE key = ?")
                    .run(actor, at, title, at, key);
                task = rowToTask(this.db.prepare("SELECT * FROM tasks WHERE key = ?").get(key));
            }
            const summary = conflict
                ? `claimed "${key}" (CONFLICT: also held by ${conflict})`
                : `claimed "${key}"`;
            this.append(actor, "claim", summary, "tasks", task.id, { key, conflict }, { project: task.project ?? null, taskKey: task.key });
            return { task, conflict };
        });
        return tx.immediate();
    }
    /** Release a claim the actor holds. */
    release(actor, key) {
        const tx = this.db.transaction(() => {
            this.ensureAgent(actor);
            const at = now();
            const existing = this.db
                .prepare("SELECT * FROM tasks WHERE key = ?")
                .get(key);
            if (!existing) {
                return undefined;
            }
            this.db
                .prepare("UPDATE tasks SET status = 'open', released_at = ?, claimed_by = NULL, updated_at = ? WHERE key = ?")
                .run(at, at, key);
            const task = rowToTask(this.db.prepare("SELECT * FROM tasks WHERE key = ?").get(key));
            this.append(actor, "release", `released "${key}"`, "tasks", task.id, {
                key,
            }, { project: task.project ?? null, taskKey: task.key });
            return task;
        });
        return tx.immediate();
    }
    /** Mark a task done. */
    complete(actor, key) {
        const tx = this.db.transaction(() => {
            this.ensureAgent(actor);
            const at = now();
            const existing = this.db
                .prepare("SELECT * FROM tasks WHERE key = ?")
                .get(key);
            if (!existing) {
                return undefined;
            }
            // Same hole as setTaskStatus: only setProgress(100) implied done, never the
            // reverse, so `done` cards kept a stale progress and readers that trusted
            // that field reported them as unfinished forever.
            const stamp = (existing.progress ?? 0) < 100;
            this.db
                .prepare("UPDATE tasks SET status = 'done', progress = ?, updated_at = ? WHERE key = ?")
                .run(stamp ? 100 : existing.progress, at, key);
            const task = rowToTask(this.db.prepare("SELECT * FROM tasks WHERE key = ?").get(key));
            this.append(actor, "complete", `completed "${key}"${stamp ? " (progress → 100)" : ""}`, "tasks", task.id, {
                key,
                ...(stamp ? { progress: 100 } : {}),
            }, { project: task.project ?? null, taskKey: task.key });
            return task;
        });
        return tx.immediate();
    }
    listTasks(status, filters = {}) {
        const clauses = [];
        const params = [];
        if (status) {
            clauses.push("status = ?");
            params.push(status);
        }
        if (filters.project) {
            clauses.push("project = ?");
            params.push(filters.project);
        }
        if (filters.stream) {
            clauses.push("stream = ?");
            params.push(filters.stream);
        }
        const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
        const rows = this.db
            .prepare(`SELECT * FROM tasks${where} ORDER BY updated_at DESC`)
            .all(...params);
        return rows.map(rowToTask);
    }
    // --- projects (four-layer: board -> project -> task -> trace) --------------
    /** Does a project with this key exist on the board? */
    projectExists(key) {
        if (!key) {
            return false;
        }
        return !!this.db.prepare("SELECT 1 FROM projects WHERE key = ?").get(key);
    }
    getProject(key) {
        const row = this.db.prepare("SELECT * FROM projects WHERE key = ?").get(key);
        return row ? rowToProject(row) : undefined;
    }
    /**
     * Create or update a project. `created_by` is stamped on first insert and never
     * rewritten; later calls only fill in fields that were actually provided.
     *
     * `opts.streams` (array, or comma-separated / JSON string) declares the
     * project's controlled stream vocabulary. Once declared, `defineTask` rejects
     * any stream outside it (see defineTask). Omitting it leaves the vocabulary
     * untouched; note COALESCE semantics mean it can never be cleared back to NULL
     * through this API.
     *
     * NOTE: the board does NOT auto-create projects as a side effect of anything
     * else (constitution §7 / project hard-constraint #3: agents must not silently
     * create projects). This is the only path that writes to `projects`, and it is
     * always an explicit, attributed action.
     */
    createProject(actor, key, opts = {}) {
        const tx = this.db.transaction(() => {
            this.ensureAgent(actor);
            const at = now();
            const existing = this.getProject(key);
            if (!existing) {
                this.db
                    .prepare(`INSERT INTO projects (id, key, name, description, status, streams, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(id(), key, opts.name ?? key, opts.description ?? null, opts.status ?? "active", streamsToStorage(opts.streams), actor, at, at);
            }
            else {
                this.db
                    .prepare(`UPDATE projects SET name = COALESCE(?, name), description = COALESCE(?, description),
               status = COALESCE(?, status), streams = COALESCE(?, streams), updated_at = ? WHERE key = ?`)
                    .run(opts.name ?? null, opts.description ?? null, opts.status ?? null, streamsToStorage(opts.streams), at, key);
            }
            const project = this.getProject(key);
            this.append(actor, "project", `${existing ? "updated" : "created"} project "${key}"`, "projects", project.id, {
                key,
                status: project.status,
            }, { project: project.key });
            return project;
        });
        return tx.immediate();
    }
    /** Set a project's lifecycle status. Returns undefined for an unknown key. */
    setProjectStatus(actor, key, status) {
        if (!PROJECT_STATUSES.includes(status)) {
            throw new Error(`status must be one of ${PROJECT_STATUSES.join(" | ")}`);
        }
        const tx = this.db.transaction(() => {
            this.ensureAgent(actor);
            const project = this.getProject(key);
            if (!project) {
                return undefined;
            }
            this.db
                .prepare("UPDATE projects SET status = ?, updated_at = ? WHERE key = ?")
                .run(status, now(), key);
            this.append(actor, "project", `project "${key}" → ${status}`, "projects", project.id, {
                key,
                status,
            }, { project: key });
            return this.getProject(key);
        });
        return tx.immediate();
    }
    /**
     * Is `agent` a member of `project`? Derived, not stored: a member is anyone who
     * has a project-scoped timeline write, is an assignee of a task under the
     * project, or has a session bound to it. Judged from what already exists, so a
     * caller cannot self-authorise by writing first (see `evidence`).
     *
     * CAVEAT: `timeline.project` / `task_key` are NOT part of `computeHash`, so this
     * is a "collaboration trust" signal, not a tamper-proof one.
     */
    isProjectMember(agent, project) {
        if (!project) {
            return false;
        }
        return this.projectMembers(project).includes(agent);
    }
    /** The derived member set of a project (union of three sources). */
    projectMembers(project) {
        if (!project) {
            return [];
        }
        const rows = this.db
            .prepare(`SELECT actor AS a FROM timeline WHERE project = ?
         UNION SELECT ta.agent AS a FROM task_assignees ta
           JOIN tasks t ON t.key = ta.task_key WHERE t.project = ?
         UNION SELECT agent_name AS a FROM sessions WHERE project = ?`)
            .all(project, project, project);
        return rows.map((r) => r.a).filter(Boolean);
    }
    /** The sedimentation register: evidence filtered by project / task / kind. */
    listEvidence(filters = {}) {
        const clauses = [];
        const params = [];
        if (filters.project !== undefined) {
            clauses.push("project = ?");
            params.push(filters.project);
        }
        if (filters.taskKey !== undefined) {
            clauses.push("task_key = ?");
            params.push(filters.taskKey);
        }
        if (filters.kind !== undefined) {
            clauses.push("kind = ?");
            params.push(filters.kind);
        }
        const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
        const rows = this.db
            .prepare(`SELECT * FROM evidence${where} ORDER BY created_at DESC`)
            .all(...params);
        return rows.map(rowToEvidence);
    }
    /** All projects, each with its live task count (and per-status breakdown). */
    listProjects() {
        const rows = this.db
            .prepare("SELECT * FROM projects ORDER BY key")
            .all();
        const counts = this.db
            .prepare(`SELECT project, status, COUNT(*) AS n FROM tasks
         WHERE project IS NOT NULL GROUP BY project, status`)
            .all();
        const byKey = new Map();
        for (const c of counts) {
            const entry = byKey.get(c.project) ?? { total: 0, byStatus: {} };
            entry.total += c.n;
            entry.byStatus[c.status] = c.n;
            byKey.set(c.project, entry);
        }
        return rows.map((r) => {
            const p = rowToProject(r);
            const agg = byKey.get(p.key) ?? { total: 0, byStatus: {} };
            return { ...p, taskCount: agg.total, tasksByStatus: agg.byStatus };
        });
    }
    /**
     * Three-level aggregation for one project: project -> tasks -> trace.
     *
     * Trace counts are read from the six trace tables that carry a `project`
     * column, plus timeline notes. Nothing here is inferred by key-prefix
     * guessing: a record counts toward a project only if it says so.
     */
    projectReport(key) {
        const project = this.getProject(key);
        if (!project) {
            return undefined;
        }
        return this.readSnapshot(() => {
            const one = (sql, ...params) => this.db.prepare(sql).get(...params)?.n ?? 0;
            const tasks = this.listTasks(undefined, { project: key });
            const byStatus = {};
            for (const t of tasks) {
                byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
            }
            const traceTable = (table) => one(`SELECT COUNT(*) AS n FROM ${table} WHERE project = ?`, key);
            // Per-task trace counts (the third level of the drilldown). The three
            // non-timeline tables are linked by task_key alone, so they stay grouped
            // (3 queries). The TIMELINE count uses BOTH exact links a row may carry
            // -- task_key OR ref_id = the task's UUID -- because the bridge stamps
            // ref_id but not task_key, so counting task_key alone undercounts most
            // cards. Either way it is an exact match, never key-prefix guessing.
            const byTaskKey = (table) => {
                const rows = this.db
                    .prepare(`SELECT task_key AS k, COUNT(*) AS n FROM ${table} WHERE project = ? AND task_key IS NOT NULL GROUP BY task_key`)
                    .all(key);
                return new Map(rows.map((r) => [r.k, r.n]));
            };
            const riskByTask = byTaskKey("risks");
            const evByTask = byTaskKey("evidence");
            const sessByTask = byTaskKey("sessions");
            const tlByTask = new Map(tasks.map((t) => [
                t.key,
                one("SELECT COUNT(*) AS n FROM timeline WHERE (ref_table = 'tasks' AND ref_id = ?) OR task_key = ?", t.id, t.key),
            ]));
            const cards = tasks.map((t) => {
                const card = this.taskCard(t.key);
                if (!card)
                    return undefined;
                return {
                    ...card,
                    trace: {
                        timeline: tlByTask.get(t.key) ?? 0,
                        risks: riskByTask.get(t.key) ?? 0,
                        evidence: evByTask.get(t.key) ?? 0,
                        sessions: sessByTask.get(t.key) ?? 0,
                    },
                };
            }).filter((c) => c !== undefined);
            return {
                project,
                tasks: { total: tasks.length, byStatus, cards },
                trace: {
                    messages: traceTable("messages"),
                    decisions: traceTable("decisions"),
                    risks: traceTable("risks"),
                    handoffs: traceTable("handoffs"),
                    evidence: traceTable("evidence"),
                    filesChanged: traceTable("files_changed"),
                    notes: one("SELECT COUNT(*) AS n FROM timeline WHERE project = ? AND kind = 'note'", key),
                },
                timeline: {
                    total: one("SELECT COUNT(*) AS n FROM timeline WHERE project = ?", key),
                    firstSeq: one("SELECT MIN(seq) AS n FROM timeline WHERE project = ?", key) || null,
                    lastSeq: one("SELECT MAX(seq) AS n FROM timeline WHERE project = ?", key) || null,
                },
            };
        });
    }
    /**
     * The trace entries attributable to ONE task, newest first -- the fourth level
     * of the drilldown (task -> trace).
     *
     * A timeline row belongs to the task when it names it EXACTLY, by either of
     * the two links the board actually uses:
     *   - task_key = the task's key (notes / evidence scoped with --task), or
     *   - ref_table = 'tasks' AND ref_id = the task's UUID (the claim / progress /
     *     complete events written by the bridge, plus defineTask itself).
     * Both are exact matches -- nothing is inferred by key-prefix guessing.
     */
    taskTrace(ref, limit = 50) {
        const t = this.resolveTask(String(ref));
        if (!t) {
            return undefined;
        }
        const where = "(ref_table = 'tasks' AND ref_id = ?) OR task_key = ?";
        const total = this.db
            .prepare(`SELECT COUNT(*) AS n FROM timeline WHERE ${where}`)
            .get(t.id, t.key).n;
        const rows = this.db
            .prepare(`SELECT * FROM timeline WHERE ${where} ORDER BY seq DESC LIMIT ?`)
            .all(t.id, t.key, limit);
        return {
            taskKey: t.key,
            taskNumber: t.number,
            total,
            entries: this.applyRedactions(rows.map(rowToTimeline)),
        };
    }
    // --- tasks (kanban) --------------------------------------------------------
    nextTaskNumber() {
        const row = this.db
            .prepare("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tasks")
            .get();
        return row.n;
    }
    getTask(key) {
        const row = this.db.prepare("SELECT * FROM tasks WHERE key = ?").get(key);
        return row ? rowToTask(row) : undefined;
    }
    /** Resolve a task by key OR by its human number (`"145"` / `"#145"`). */
    resolveTask(ref) {
        const m = /^#?(\d+)$/.exec(ref.trim());
        if (m) {
            const row = this.db
                .prepare("SELECT * FROM tasks WHERE number = ?")
                .get(Number(m[1]));
            if (row)
                return rowToTask(row);
        }
        return this.getTask(ref);
    }
    /**
     * Create or update a task's kanban fields (title, description, project,
     * impact/blast-radius, risk level). Creates the task (with a fresh number) if
     * the key is new; otherwise updates only the provided fields.
     *
     * Stream is CONTROLLED: if the target project has declared a non-empty
     * vocabulary (`projects.streams`), a supplied stream outside it is REJECTED
     * (fail-closed). Projects with no declared vocabulary accept any stream, so
     * legacy boards are unaffected.
     */
    defineTask(actor, key, opts = {}) {
        const tx = this.db.transaction(() => {
            this.ensureAgent(actor);
            const at = now();
            const existing = this.getTask(key);
            // --- project-existence guard (fail-closed, step8) ---------------------
            // `tasks.project` MUST reference an existing `projects.key` — it is the
            // one field whose value is validated (design §1.5 chose the `projects`
            // table exactly for "校验引用 + 不会继续漂移"). Two real orphans slipped
            // through this method before any check: #116 `agent-evals` (typo of the
            // GitHub repo name) and #162 `zz-nonexistent-proj-20261018` (a negative-
            // test probe whose own description recorded "接受且只 warn 不拒"). A
            // non-null project that does not exist is now rejected on BOTH the
            // create and re-point paths; NULL/omitted stays accepted (a fresh task
            // without a project still asks the human first — hard-constraint #3).
            const suppliedProject = opts.project == null ? null : String(opts.project).trim();
            if (suppliedProject && !this.projectExists(suppliedProject)) {
                const known = this.listProjects().map((p) => p.key).sort();
                throw new Error(`defineTask: project "${suppliedProject}" does not exist. Known projects: [${known.join(", ")}]. Create it first with \`project add ${suppliedProject}\`.`);
            }
            // --- stream controlled-vocabulary guard (fail-closed) ----------------
            // Only fires when a stream is being SUPPLIED and the target project has
            // DECLARED a non-empty vocabulary. Unknown projects and vocabulary-less
            // projects accept anything, so this stays purely additive.
            const suppliedStream = opts.stream == null ? null : String(opts.stream).trim();
            if (suppliedStream) {
                const projKey = opts.project ?? existing?.project ?? null;
                const allowed = projKey ? this.getProject(projKey)?.streams ?? [] : [];
                if (allowed.length > 0 && !allowed.includes(suppliedStream)) {
                    throw new Error(`defineTask: stream "${suppliedStream}" is not in project "${projKey}"'s vocabulary [${allowed.join(", ")}]. Declare it first with \`project add ${projKey} --streams "..."\`.`);
                }
            }
            if (!existing) {
                this.db
                    .prepare(`INSERT INTO tasks (id, key, number, title, description, status, project, stream, impact, risk_level, acceptance, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(id(), key, this.nextTaskNumber(), opts.title ?? null, opts.description ?? null, opts.project ?? null, opts.stream ?? null, opts.impact ?? null, opts.riskLevel ?? null, acceptanceToStorage(opts.acceptance), actor, at, at);
            }
            else {
                this.db
                    .prepare(`UPDATE tasks SET title = COALESCE(?, title), description = COALESCE(?, description),
               project = COALESCE(?, project), stream = COALESCE(?, stream), impact = COALESCE(?, impact),
               risk_level = COALESCE(?, risk_level), acceptance = COALESCE(?, acceptance), updated_at = ? WHERE key = ?`)
                    .run(opts.title ?? null, opts.description ?? null, opts.project ?? null, opts.stream ?? null, opts.impact ?? null, opts.riskLevel ?? null, acceptanceToStorage(opts.acceptance), at, key);
            }
            const task = this.getTask(key);
            this.append(actor, "task", `defined task #${task.number} "${key}"`, "tasks", task.id, {
                key,
                ...(task.acceptance ? { acceptance: task.acceptance } : {}),
            }, { project: task.project ?? null, taskKey: task.key });
            return task;
        });
        return tx.immediate();
    }
    /**
     * Assign a task to an agent and notify them — records the assignee AND drops a
     * message in that agent's inbox ("please look at task #145 …"). This is the
     * passive form of "notify Claude to look at 145": the board records the ask;
     * the agent reads its inbox and decides to act. The board never launches it.
     */
    assign(actor, key, toAgent) {
        const tx = this.db.transaction(() => {
            this.ensureAgent(actor);
            this.ensureAgent(toAgent);
            const task = this.getTask(key);
            if (!task) {
                return undefined;
            }
            const at = now();
            this.db
                .prepare("INSERT OR IGNORE INTO task_assignees (task_key, agent, assigned_by, assigned_at) VALUES (?, ?, ?, ?)")
                .run(key, toAgent, actor, at);
            // The notification: a message in the assignee's inbox.
            const label = `task #${task.number}${task.title ? ` "${task.title}"` : ` (${key})`}`;
            const where = task.project ? ` · project ${task.project}` : "";
            const risk = task.riskLevel ? ` · risk ${task.riskLevel}` : "";
            this.message(actor, toAgent, `please look at ${label}${where}${risk}`);
            this.append(actor, "assign", `assigned ${label} → ${toAgent}`, "tasks", task.id, {
                key,
                to: toAgent,
            });
            return this.getTask(key);
        });
        return tx.immediate();
    }
    /** Report progress (0–100). Moves status to in-progress, or done at 100. */
    setProgress(actor, key, progress) {
        const tx = this.db.transaction(() => {
            this.ensureAgent(actor);
            const task = this.getTask(key);
            if (!task) {
                return undefined;
            }
            const p = Math.max(0, Math.min(100, Math.round(progress)));
            const status = p >= 100
                ? "done"
                : p > 0 && (task.status === "open" || task.status === "claimed")
                    ? "in-progress"
                    : task.status;
            this.db
                .prepare("UPDATE tasks SET progress = ?, status = ?, updated_at = ? WHERE key = ?")
                .run(p, status, now(), key);
            this.append(actor, "progress", `task #${task.number} "${key}" → ${p}%`, "tasks", task.id, { key, progress: p }, { project: task.project ?? null, taskKey: task.key });
            return this.getTask(key);
        });
        return tx.immediate();
    }
    /** Set a task's status directly (e.g. blocked). */
    setTaskStatus(actor, key, status) {
        const tx = this.db.transaction(() => {
            this.ensureAgent(actor);
            const task = this.getTask(key);
            if (!task) {
                return undefined;
            }
            // setProgress(100) already implies "done"; the reverse was never true, so a
            // card could read `status: done` with `progress: 5` and every reader had to
            // guess which field to trust (dsh, 2026-09-26 on task #33). Only `done`
            // stamps — cancelled/failed keep whatever progress they died at.
            const stamp = status === "done" && (task.progress ?? 0) < 100;
            if (stamp) {
                this.db
                    .prepare("UPDATE tasks SET status = ?, progress = 100, updated_at = ? WHERE key = ?")
                    .run(status, now(), key);
            }
            else {
                this.db
                    .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE key = ?")
                    .run(status, now(), key);
            }
            const extra = stamp ? " (progress → 100)" : "";
            this.append(actor, "task-status", `task #${task.number} "${key}" → ${status}${extra}`, "tasks", task.id, { key, status, ...(stamp ? { progress: 100 } : {}) }, { project: task.project ?? null, taskKey: task.key });
            return this.getTask(key);
        });
        return tx.immediate();
    }
    assigneesFor(key) {
        return this.db
            .prepare("SELECT agent FROM task_assignees WHERE task_key = ? ORDER BY assigned_at ASC")
            .all(key).map((r) => r.agent);
    }
    risksForTask(key) {
        return this.db
            .prepare("SELECT * FROM risks WHERE task_key = ? ORDER BY created_at DESC")
            .all(key).map(rowToRisk);
    }
    /**
     * How many agents are actively working the task right now: assignees (or the
     * claimer) that have an active (heartbeating) session.
     */
    activeAgentsOnTask(key) {
        const active = new Set(this.activeSessions().map((s) => s.agentName));
        const involved = new Set(this.assigneesFor(key));
        const claimer = this.getTask(key)?.claimedBy;
        if (claimer)
            involved.add(claimer);
        return [...involved].filter((a) => active.has(a)).length;
    }
    /** Full kanban card for one task. */
    taskCard(key) {
        const task = this.getTask(key);
        if (!task) {
            return undefined;
        }
        return {
            task,
            assignees: this.assigneesFor(key),
            activeAgents: this.activeAgentsOnTask(key),
            impactFiles: [...new Set(this.filesForTask(key).map((f) => f.path))],
            risks: this.risksForTask(key),
        };
    }
    /** Every task as a kanban card, newest-updated first. */
    listTaskCards(filters = {}) {
        return this.readSnapshot(() => this.listTasks(undefined, filters)
            .map((t) => this.taskCard(t.key))
            .filter((c) => c !== undefined));
    }
    /**
     * Record a verification outcome for a task as a first-class timeline event
     * (kind "verify"). This is the public write path for the verification layer:
     * callers (CLI, MCP, the task bridge) record pass/fail plus check evidence,
     * and the entry lands in the tamper-evident chain like every other write.
     * `verdict` is fail-closed: anything but "pass"/"fail" throws, so a buggy
     * caller can never poison the audit trail with an unparseable outcome.
     */
    verify(actor, key, verdict, opts = {}) {
        const v = String(verdict ?? "").toLowerCase();
        if (v !== "pass" && v !== "fail") {
            throw new Error(`verify: verdict must be "pass" or "fail" (got ${JSON.stringify(verdict)})`);
        }
        const tx = this.db.transaction(() => {
            this.ensureAgent(actor);
            const task = this.getTask(key);
            if (!task) {
                return undefined;
            }
            const level = typeof opts.level === "string" && opts.level.trim() ? opts.level.trim() : "V1";
            const payload = {
                key,
                verdict: v,
                level,
                ...(opts.checks !== undefined ? { checks: opts.checks } : {}),
                ...(opts.evidence !== undefined ? { evidence: opts.evidence } : {}),
            };
            const summary = typeof opts.summary === "string" && opts.summary.trim()
                ? opts.summary.trim()
                : `verify ${v.toUpperCase()} ${key} (${level})`;
            return this.append(actor, "verify", summary, "tasks", task.id, payload);
        });
        return tx.immediate();
    }
    /** Verification events recorded for a task, newest first. */
    verificationsFor(key) {
        const task = this.getTask(key);
        if (!task) {
            return [];
        }
        return this.db
            .prepare("SELECT * FROM timeline WHERE kind = 'verify' AND ref_id = ? ORDER BY seq DESC")
            .all(task.id)
            .map((r) => {
            let payload = null;
            try {
                payload = r.payload ? JSON.parse(r.payload) : null;
            }
            catch { /* malformed payload reads back without fields */ }
            return { seq: r.seq, at: r.at, actor: r.actor, summary: r.summary, ...(payload ?? {}) };
        });
    }
    /** Leave a message for another agent, or broadcast (to = null). */
    message(actor, to, body, opts = {}) {
        const tx = this.db.transaction(() => {
            this.ensureAgent(actor);
            if (to) {
                this.ensureAgent(to);
            }
            const at = now();
            const msg = {
                id: id(),
                fromAgent: actor,
                toAgent: to,
                body,
                createdAt: at,
                readAt: null,
            };
            this.db
                .prepare("INSERT INTO messages (id, from_agent, to_agent, body, created_at, read_at, project) VALUES (@id, @fromAgent, @toAgent, @body, @createdAt, @readAt, @project)")
                .run({ ...msg, project: opts.project ?? null });
            // Metadata-only summary: the message BODY lives only in messages.body
            // (which redact() blanks), never in the hashed, append-only timeline — so
            // redacting a message truly erases its content from all storage. The
            // timeline still records who messaged whom, and when.
            const dest = to ? `→ ${to}` : "(broadcast)";
            this.append(actor, "message", `message ${dest}`, "messages", msg.id, {
                to,
            }, { project: opts.project ?? null, taskKey: opts.taskKey ?? null });
            return msg;
        });
        return tx.immediate();
    }
    /** Messages addressed to `agent` (or broadcast) that it has not acked yet. */
    inbox(agent, includeRead = false) {
        // The filter is the per-agent message_reads ledger, NOT messages.read_at:
        // read_at is a single global column, so acking one broadcast would hide it
        // from every other agent on the board. Switching the predicate from
        // `read_at IS NULL` to the ledger cannot hide anything that used to show,
        // because read_at was NULL on every row in production (0/26 read).
        // UNION ALL of two disjoint branches (direct vs broadcast) so each can use
        // idx_messages_to; a single `to_agent = ? OR to_agent IS NULL` predicate
        // would force a full table scan.
        // 2026-10-10: a recipient is now the alias set (recipientSet), so xiaoyu and
        // workbuddy share one inbox. A direct message is unread only if NONE of the
        // recipient identities has acked it; the ledger-agent set is the same set.
        const recips = recipientSet(agent);
        const ph = recips.map(() => "?").join(", ");
        const unread = includeRead
            ? ""
            : ` AND NOT EXISTS (SELECT 1 FROM message_reads mr
                  WHERE mr.message_id = messages.id AND mr.agent IN (${ph}))`;
        const sql = `SELECT * FROM messages WHERE to_agent IN (${ph})${unread}
         UNION ALL SELECT * FROM messages WHERE to_agent IS NULL${unread}
         ORDER BY created_at DESC`;
        // Direct branch binds [recips (to_agent)] + [recips (ledger)]; broadcast
        // branch binds [recips (ledger)]. When includeRead, no ledger predicate.
        const params = includeRead ? [...recips] : [...recips, ...recips, ...recips];
        return this.db.prepare(sql).all(...params).map(rowToMessage);
    }
    /**
     * Ack a message on behalf of `agent`. Without an agent it falls back to the
     * legacy global stamp only — callers that represent a reader should always
     * pass one, or the ack is invisible to everyone else's inbox.
     */
    markRead(messageId, agent = null) {
        const at = now();
        let acked = false;
        const recips = agent ? recipientSet(agent) : [];
        const tx = this.db.transaction(() => {
            // Guard: without it an unknown id silently "succeeds" and leaves an
            // orphan ledger row keyed on a message that never existed.
            if (!this.db.prepare("SELECT 1 FROM messages WHERE id = ?").get(messageId)) {
                return;
            }
            acked = true;
            // 2026-10-10: ack every identity in the recipient set, so reading as
            // xiaoyu also clears workbuddy's copy (and vice-versa). This keeps the
            // sender's pendingAcks (which checks mr.agent = m.to_agent) correct and
            // prevents double-processing by another reader of the same merged inbox.
            for (const a of recips) {
                this.ensureAgent(a);
                this.db
                    .prepare(`INSERT OR IGNORE INTO message_reads (message_id, agent, read_at)
                    VALUES (?, ?, ?)`)
                    .run(messageId, a, at);
            }
            // Legacy flag: first reader wins, so pre-ledger consumers (status,
            // allUnread, the dashboard) still see "has anyone opened this".
            this.db
                .prepare("UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL")
                .run(at, messageId);
        });
        tx.immediate();
        return acked;
    }
    /** Ack everything currently sitting in `agent`'s unread inbox. Returns the ids. */
    markInboxRead(agent) {
        const ids = this.inbox(agent).map((m) => m.id);
        for (const mid of ids)
            this.markRead(mid, agent);
        return ids;
    }
    /** Who has acked a message, oldest ack first. */
    readers(messageId) {
        return this.db
            .prepare(`SELECT agent, read_at FROM message_reads WHERE message_id = ?
         ORDER BY read_at ASC`)
            .all(messageId);
    }
    /**
     * Messages `agent` dispatched that nobody has opened yet — the sender's half
     * of the ack loop. Without this, "did they see it?" is unanswerable and every
     * dispatch is a guess. Broadcasts are excluded: they have no intended reader.
     */
    pendingAcks(agent) {
        return this.db
            .prepare(`SELECT m.id, m.to_agent AS toAgent, m.created_at AS createdAt,
               (SELECT COUNT(*) FROM message_reads mr WHERE mr.message_id = m.id) AS acks
         FROM messages m
         WHERE m.from_agent = ? AND m.to_agent IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM message_reads mr
             WHERE mr.message_id = m.id AND mr.agent = m.to_agent)
         ORDER BY m.created_at DESC`)
            .all(agent);
    }
    decision(actor, title, opts = {}) {
        const tx = this.db.transaction(() => {
            this.ensureAgent(actor);
            const dec = {
                id: id(),
                agentId: actor,
                sessionId: this.activeSession,
                title,
                rationale: opts.rationale ?? null,
                evidence: opts.evidence ?? null,
                relatedCommits: opts.relatedCommits ?? [],
                relatedTasks: opts.relatedTasks ?? [],
                createdAt: now(),
            };
            this.db
                .prepare(`INSERT INTO decisions (id, agent_id, session_id, title, rationale, evidence, related_commits, related_tasks, created_at, project)
           VALUES (@id, @agentId, @sessionId, @title, @rationale, @evidence, @relatedCommits, @relatedTasks, @createdAt, @project)`)
                .run({
                ...dec,
                relatedCommits: JSON.stringify(dec.relatedCommits),
                relatedTasks: JSON.stringify(dec.relatedTasks),
                project: opts.project ?? null,
            });
            // The free-text rationale lives only in decisions.rationale (redactable);
            // the timeline keeps the (short) title + related commits, not the rationale.
            this.append(actor, "decision", `decided: ${title}`, "decisions", dec.id, {
                relatedCommits: dec.relatedCommits,
            }, { project: opts.project ?? null, taskKey: opts.taskKey ?? null });
            return dec;
        });
        return tx.immediate();
    }
    decisionsForCommit(commitSha) {
        // A stored related-commit `c` matches when it is a prefix of the query sha
        // (or vice-versa), but only if it is at least a git short-sha (7 chars) —
        // this rejects false positives from empty strings (which prefix-match every
        // commit) and 1–2 char typos. Non-string elements are coerced defensively.
        const matches = (c, sha) => {
            const s = String(c);
            if (s.length < 7) {
                return s.length === sha.length && s === sha; // only an exact full match
            }
            return s.startsWith(sha) || sha.startsWith(s);
        };
        return this.db
            .prepare("SELECT * FROM decisions ORDER BY created_at DESC")
            .all()
            .map(rowToDecision)
            .filter((d) => d.relatedCommits.some((c) => matches(c, commitSha)));
    }
    evidence(actor, ref, note = null, target = null, project = null, opts = {}) {
        // Content-address the evidence when it is a readable local file, so the
        // referenced content is integrity-protected: a later swap/edit of the file
        // is detectable via verifyEvidence(). URLs / non-files store sha256 = null.
        //
        // Beyond the original shape this doubles as the project "sedimentation
        // register": `opts.taskKey` scopes the entry to a task, `opts.kind` tags it
        // (see EVIDENCE_KINDS). Old 5-arg callers keep byte-identical behaviour.
        const taskKey = opts.taskKey ?? null;
        const kind = opts.kind ?? null;
        if (kind !== null && !EVIDENCE_KINDS.includes(kind)) {
            throw new Error(`kind must be one of ${EVIDENCE_KINDS.join(" | ")}`);
        }
        const sha256 = Board.hashFileIfLocal(ref);
        const tx = this.db.transaction(() => {
            this.ensureAgent(actor);
            // Write gate: a project-scoped register entry requires membership, unless
            // the entry carries a taskKey (being assigned a task is itself admission).
            // Membership is judged BEFORE this write lands, so a caller cannot
            // self-authorise by writing a project note first.
            if (project && !taskKey && !this.isProjectMember(actor, project)) {
                this.append(actor, "note", `evidence not registered: ${actor} is not a member of "${project}"`, null, null, null, { project });
                return { skipped: "not-a-member", project, ref };
            }
            const ev = {
                id: id(),
                agentId: actor,
                ref,
                note,
                target,
                sha256,
                createdAt: now(),
            };
            this.db
                .prepare("INSERT INTO evidence (id, agent_id, ref, note, target, sha256, created_at, project, task_key, kind) VALUES (@id, @agentId, @ref, @note, @target, @sha256, @createdAt, @project, @taskKey, @kind)")
                .run({ ...ev, project, taskKey, kind });
            this.append(actor, "evidence", `evidence: ${ref}${sha256 ? ` (sha256 ${sha256.slice(0, 12)})` : ""}`, "evidence", ev.id, { target, sha256, ...(kind ? { kind } : {}) }, { project, taskKey });
            return ev;
        });
        return tx.immediate();
    }
    /** SHA-256 of a local file's content, or null if `ref` is not a readable file. */
    static hashFileIfLocal(ref) {
        try {
            if (!existsSync(ref) || !statSync(ref).isFile()) {
                return null;
            }
            return createHash("sha256").update(readFileSync(ref)).digest("hex");
        }
        catch {
            return null;
        }
    }
    /**
     * Re-check every content-hashed evidence file against its attach-time hash.
     * `ok` = unchanged, `changed` = content differs (tampered/edited), `missing`
     * = the file is gone, `unhashed` = a URL / non-file (never hashed).
     */
    verifyEvidence() {
        const rows = this.db
            .prepare("SELECT id, ref, sha256 FROM evidence ORDER BY created_at ASC")
            .all();
        return rows.map(({ id, ref, sha256 }) => {
            let status;
            if (sha256 === null) {
                status = "unhashed";
            }
            else if (!existsSync(ref) || !statSync(ref).isFile()) {
                status = "missing";
            }
            else {
                const now256 = createHash("sha256")
                    .update(readFileSync(ref))
                    .digest("hex");
                status = now256 === sha256 ? "ok" : "changed";
            }
            return { id, ref, status };
        });
    }
    fileChanged(actor, path, change, taskKey = null, project = null) {
        const tx = this.db.transaction(() => {
            this.ensureAgent(actor);
            const fc = {
                id: id(),
                agentId: actor,
                sessionId: this.activeSession,
                path,
                change,
                taskKey,
                createdAt: now(),
            };
            this.db
                .prepare("INSERT INTO files_changed (id, agent_id, session_id, path, change, task_key, created_at, project) VALUES (@id, @agentId, @sessionId, @path, @change, @taskKey, @createdAt, @project)")
                .run({ ...fc, project });
            this.append(actor, "file", `${change}: ${path}`, "files_changed", fc.id, {
                taskKey,
            }, { project, taskKey });
            return fc;
        });
        return tx.immediate();
    }
    /** Files another agent reports touching for a task — conflict awareness. */
    filesForTask(taskKey) {
        return this.db
            .prepare("SELECT * FROM files_changed WHERE task_key = ? ORDER BY created_at DESC")
            .all(taskKey).map(rowToFileChange);
    }
    risk(actor, title, severity = "medium", taskKey = null, project = null) {
        const tx = this.db.transaction(() => {
            this.ensureAgent(actor);
            const r = {
                id: id(),
                agentId: actor,
                title,
                severity,
                status: "open",
                taskKey,
                createdAt: now(),
                resolvedAt: null,
                resolvedBy: null,
            };
            this.db
                .prepare("INSERT INTO risks (id, agent_id, title, severity, status, task_key, created_at, project) VALUES (@id, @agentId, @title, @severity, @status, @taskKey, @createdAt, @project)")
                .run({ ...r, project });
            const on = taskKey ? ` (task ${taskKey})` : "";
            this.append(actor, "risk", `risk [${severity}]: ${title}${on}`, "risks", r.id, null, {
                project,
                taskKey,
            });
            return r;
        });
        return tx.immediate();
    }
    listRisks(status = "open") {
        const rows = status
            ? this.db
                .prepare("SELECT * FROM risks WHERE status = ? ORDER BY created_at DESC")
                .all(status)
            : this.db
                .prepare("SELECT * FROM risks ORDER BY created_at DESC")
                .all();
        return rows.map(rowToRisk);
    }
    /**
     * Look one risk up by full id, unique id prefix (uuids are hex, prefixes are
     * how agents quote them on the board), or the exact title. Returns undefined
     * when nothing matches; throws on an ambiguous prefix so a typo cannot close
     * the wrong card.
     */
    getRisk(ref) {
        const key = String(ref ?? "").trim();
        if (!key) {
            return undefined;
        }
        const exact = this.db.prepare("SELECT * FROM risks WHERE id = ?").get(key);
        if (exact) {
            return rowToRisk(exact);
        }
        const byTitle = this.db
            .prepare("SELECT * FROM risks WHERE title = ? ORDER BY created_at DESC LIMIT 2")
            .all(key);
        if (byTitle.length > 1) {
            throw new Error(`ambiguous risk title "${key}" — ${byTitle.length} cards share it, quote the id`);
        }
        if (byTitle.length === 1) {
            return rowToRisk(byTitle[0]);
        }
        // Prefix lookup only for things that can actually be an id prefix: a title
        // containing % or _ would otherwise be read as LIKE wildcards and could
        // settle the wrong card.
        if (!/^[0-9a-f][0-9a-f-]{3,}$/i.test(key)) {
            return undefined;
        }
        const byPrefix = this.db
            .prepare("SELECT * FROM risks WHERE id LIKE ? ORDER BY created_at DESC")
            .all(`${key}%`);
        if (byPrefix.length > 1) {
            throw new Error(`ambiguous risk id prefix "${key}" — matches ${byPrefix.length} risks, quote more characters`);
        }
        return byPrefix.length === 1 ? rowToRisk(byPrefix[0]) : undefined;
    }
    /**
     * Close the loop on a risk card: move it out of `open` (or back into it).
     * `status` is the upstream RiskStatus vocabulary — "open" | "mitigated" |
     * "closed". Settling stamps resolved_at/resolved_by; reopening clears them.
     * The `note` (how/why it was settled) goes into the append-only timeline.
     */
    resolveRisk(actor, ref, status = "closed", note = null) {
        const allowed = ["open", "mitigated", "closed"];
        if (!allowed.includes(status)) {
            throw new Error(`invalid risk status "${status}" — use: ${allowed.join(" | ")}`);
        }
        const tx = this.db.transaction(() => {
            this.ensureAgent(actor);
            const existing = this.getRisk(ref);
            if (!existing) {
                return undefined;
            }
            const at = now();
            const settled = status !== "open";
            this.db
                .prepare("UPDATE risks SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ?")
                .run(status, settled ? at : null, settled ? actor : null, existing.id);
            const why = note ? ` — ${note}` : "";
            this.append(actor, "risk-resolve", `risk "${existing.title}" → ${status}${why}`, "risks", existing.id, {
                id: existing.id,
                status,
                note: note ?? null,
                previousStatus: existing.status,
            });
            return this.getRisk(existing.id);
        });
        return tx.immediate();
    }
    handoff(actor, to, summary, opts = {}) {
        const tx = this.db.transaction(() => {
            this.ensureAgent(actor);
            this.ensureAgent(to);
            const h = {
                id: id(),
                fromAgent: actor,
                toAgent: to,
                fromSession: this.activeSession,
                toSession: null,
                summary,
                context: opts.context ?? null,
                relatedFiles: opts.relatedFiles ?? [],
                openQuestions: opts.openQuestions ?? [],
                taskKey: opts.taskKey ?? null,
                createdAt: now(),
                acceptedAt: null,
            };
            this.db
                .prepare(`INSERT INTO handoffs (id, from_agent, to_agent, from_session, to_session, summary, context, related_files, open_questions, task_key, created_at, accepted_at, project)
           VALUES (@id, @fromAgent, @toAgent, @fromSession, @toSession, @summary, @context, @relatedFiles, @openQuestions, @taskKey, @createdAt, @acceptedAt, @project)`)
                .run({
                ...h,
                relatedFiles: JSON.stringify(h.relatedFiles),
                openQuestions: JSON.stringify(h.openQuestions),
                project: opts.project ?? null,
            });
            this.append(actor, "handoff", `handoff → ${to}: ${summary}`, "handoffs", h.id, {
                taskKey: h.taskKey,
                openQuestions: h.openQuestions,
            }, { project: opts.project ?? null, taskKey: h.taskKey });
            return h;
        });
        return tx.immediate();
    }
    // --- attribution -----------------------------------------------------------
    /** Resolve the AI identity (agent + provider/model/cli) for a session. */
    identityForSession(sessionId) {
        if (sessionId) {
            const s = this.getSession(sessionId);
            if (s) {
                const a = this.getAgent(s.agentName);
                return {
                    actor: s.agentName,
                    provider: a?.provider ?? null,
                    model: a?.model ?? null,
                    cli: a?.cli ?? null,
                    sessionId,
                };
            }
        }
        return {
            actor: this.config.agent,
            provider: this.config.identity.provider,
            model: this.config.identity.model,
            cli: this.config.identity.cli,
            sessionId: this.activeSession,
        };
    }
    /** Record a single attribution — who actually produced a change. */
    attribute(commit, opts = {}) {
        const sha = git.resolveRev(commit) ?? commit;
        const actorType = opts.actorType ?? "ai";
        const ident = actorType === "ai"
            ? this.identityForSession(opts.sessionId ?? this.activeSession)
            : {
                actor: this.config.agent,
                provider: null,
                model: null,
                cli: null,
                sessionId: opts.sessionId ?? null,
            };
        const attr = {
            id: id(),
            commit: sha,
            file: opts.file ?? null,
            hunk: opts.hunk ?? null,
            actorType,
            actor: opts.actor ?? ident.actor,
            provider: opts.provider ?? ident.provider,
            model: opts.model ?? ident.model,
            cli: opts.cli ?? ident.cli,
            sessionId: opts.sessionId ?? ident.sessionId,
            createdAt: now(),
        };
        const tx = this.db.transaction(() => {
            this.insertAttribution(attr);
            const where = attr.file ? ` ${attr.file}` : "";
            this.append(attr.actor, "attribution", `${attr.actorType} produced ${sha.slice(0, 8)}${where}`, "attributions", attr.id, {
                commit: sha,
                file: attr.file,
            });
        });
        tx.immediate();
        return attr;
    }
    insertAttribution(attr) {
        this.db
            .prepare(`INSERT INTO attributions (id, commit_sha, file, hunk, actor_type, actor, provider, model, cli, session_id, created_at)
         VALUES (@id, @commit, @file, @hunk, @actorType, @actor, @provider, @model, @cli, @sessionId, @createdAt)`)
            .run(attr);
    }
    /**
     * Associate a Git commit with the work that produced it. Resolves the rev to
     * a full sha, reads the files it touched from Git, and records one AI
     * attribution per file for the given (or active) session. Optionally writes
     * an additive `git notes` entry — Git history is never rewritten.
     */
    link(rev, opts = {}) {
        const sha = git.resolveRev(rev);
        if (!sha) {
            return undefined;
        }
        // Never attribute the board's own storage.
        const files = git
            .filesInCommit(sha)
            .filter((f) => !f.startsWith(".octoboard/"));
        const actorType = opts.actorType ?? "ai";
        const ident = actorType === "ai"
            ? this.identityForSession(opts.sessionId ?? this.activeSession)
            : {
                actor: opts.actor ?? this.config.agent,
                provider: null,
                model: null,
                cli: null,
                sessionId: opts.sessionId ?? null,
            };
        const targets = files.length > 0 ? files : [null];
        const tx = this.db.transaction(() => {
            for (const file of targets) {
                this.insertAttribution({
                    id: id(),
                    commit: sha,
                    file,
                    hunk: null,
                    actorType,
                    actor: opts.actor ?? ident.actor,
                    provider: ident.provider,
                    model: ident.model,
                    cli: ident.cli,
                    sessionId: ident.sessionId,
                    createdAt: now(),
                });
            }
            // A link event spans N attribution rows, so it references the commit
            // itself (ref_table "commit"), not any single attribution row id.
            this.append(opts.actor ?? ident.actor, "link", `linked ${sha.slice(0, 8)} → ${actorType} ${opts.actor ?? ident.actor} (${targets.length} file${targets.length === 1 ? "" : "s"})`, "commit", sha, { sha, files });
        });
        tx.immediate();
        if (opts.writeNote) {
            const label = `${ident.cli ?? ident.actor}${ident.model ? ` (${ident.model})` : ""}`;
            git.writeNote(sha, `blackboard: produced by ${label}, session ${ident.sessionId ?? "n/a"}`);
        }
        return { sha, files, count: targets.length };
    }
    attributionsForCommit(commitSha) {
        return this.db
            .prepare("SELECT * FROM attributions WHERE commit_sha = ? ORDER BY created_at ASC")
            .all(commitSha).map(rowToAttribution);
    }
    attributionsForFile(file) {
        return this.db
            .prepare("SELECT * FROM attributions WHERE file = ? ORDER BY created_at DESC")
            .all(file).map(rowToAttribution);
    }
    /**
     * Attributions on a commit that concern a specific file — the rows whose
     * `file` matches (or is null, i.e. whole-commit). Falls back to all of the
     * commit's attributions if none name the file. Used by `blame`, so tracing a
     * line doesn't surface attributions for the commit's other files.
     */
    attributionsForCommitFile(commitSha, file) {
        const all = this.attributionsForCommit(commitSha);
        const scoped = all.filter((a) => a.file === file || a.file === null);
        return scoped.length > 0 ? scoped : all;
    }
    // --- reviews ---------------------------------------------------------------
    /** Record who reviewed a commit and the outcome. */
    review(commit, opts = {}) {
        const sha = git.resolveRev(commit) ?? commit;
        const rev = {
            id: id(),
            commit: sha,
            reviewerType: opts.reviewerType ?? "ai",
            reviewer: opts.reviewer ?? this.config.agent,
            sessionId: opts.sessionId ?? this.activeSession,
            outcome: opts.outcome ?? "approved",
            note: opts.note ?? null,
            createdAt: now(),
        };
        const tx = this.db.transaction(() => {
            this.db
                .prepare(`INSERT INTO reviews (id, commit_sha, reviewer_type, reviewer, session_id, outcome, note, created_at)
           VALUES (@id, @commit, @reviewerType, @reviewer, @sessionId, @outcome, @note, @createdAt)`)
                .run(rev);
            this.append(rev.reviewer, "review", `${rev.reviewerType} review of ${sha.slice(0, 8)}: ${rev.outcome}`, "reviews", rev.id, { commit: sha, outcome: rev.outcome });
        });
        tx.immediate();
        return rev;
    }
    reviewsForCommit(commitSha) {
        return this.db
            .prepare("SELECT * FROM reviews WHERE commit_sha = ? ORDER BY created_at ASC")
            .all(commitSha).map(rowToReview);
    }
    /** Handoffs left FOR an agent — "what was passed to me", newest first. */
    handoffsFor(toAgent) {
        return this.db
            .prepare("SELECT * FROM handoffs WHERE to_agent = ? ORDER BY created_at DESC")
            .all(toAgent).map(rowToHandoff);
    }
    // --- queries ---------------------------------------------------------------
    /**
     * Who touched a file: Git authors, distinct (session, agent) pairs that
     * recorded a change, and commit attributions. The `agent` is the actor name
     * recorded on the change; one entry per distinct (session, agent), collapsing
     * repeated edits within a session to a single row (its latest timestamp).
     */
    whoTouched(file) {
        const rows = this.db
            .prepare(`SELECT session_id, agent_id, MAX(created_at) AS at FROM files_changed
         WHERE path = ?
         GROUP BY session_id, agent_id ORDER BY at DESC`)
            .all(file);
        return {
            gitAuthors: git.fileAuthors(file),
            attributions: this.attributionsForFile(file),
            sessions: rows.map((r) => ({
                sessionId: r.session_id,
                agent: r.agent_id,
                at: r.at,
            })),
        };
    }
    /**
     * Commits attributed to an actor, CLI, provider, or model (matched broadly
     * across those columns). Returns the actual matching attribution rows, so the
     * reported `actor`/`cli` always reflect a row that matched the query — never
     * an unrelated attribution on the same commit.
     */
    commitsByActor(query) {
        const rows = this.db
            .prepare(`SELECT DISTINCT commit_sha, actor, cli, created_at FROM attributions
         WHERE actor = ? OR cli = ? OR provider = ? OR model = ?
         ORDER BY created_at DESC`)
            .all(query, query, query, query);
        // Collapse to one row per (commit, actor, cli); keep the earliest time.
        const seen = new Map();
        for (const r of rows) {
            const key = `${r.commit_sha}\u0000${r.actor}\u0000${r.cli ?? ""}`;
            const existing = seen.get(key);
            if (!existing || r.created_at < existing.at) {
                seen.set(key, {
                    commit: r.commit_sha,
                    actor: r.actor,
                    cli: r.cli,
                    at: r.created_at,
                });
            }
        }
        return [...seen.values()].sort((x, y) => (x.at < y.at ? 1 : -1));
    }
    /**
     * AI-attributed commits with no APPROVED human review — the accountability
     * gap. A commit reviewed but rejected/changes-requested is still unreviewed
     * for this purpose (sign-off was withheld), so it appears here.
     */
    unreviewedCommits() {
        const rows = this.db
            .prepare(`SELECT a.commit_sha, a.actor, MIN(a.created_at) AS at FROM attributions a
         WHERE a.actor_type = 'ai'
           AND NOT EXISTS (
             SELECT 1 FROM reviews r
             WHERE r.commit_sha = a.commit_sha AND r.reviewer_type = 'human' AND r.outcome = 'approved'
           )
         GROUP BY a.commit_sha ORDER BY at DESC`)
            .all();
        return rows.map((r) => ({
            commit: r.commit_sha,
            actor: r.actor,
            at: r.at,
        }));
    }
    /**
     * Files touched by BOTH agents — joint-modification / collision surface.
     * Paths are normalized (leading `./` stripped) so a CLI-relative form and
     * git's repo-root form for the same file reconcile. Case and deeper path
     * differences are not reconciled.
     */
    jointFiles(agentA, agentB) {
        const norm = (p) => p.replace(/^\.\//, "");
        const filesOf = (agent) => {
            const fc = this.db
                .prepare("SELECT DISTINCT path FROM files_changed WHERE agent_id = ?")
                .all(agent);
            const at = this.db
                .prepare("SELECT DISTINCT file FROM attributions WHERE actor = ? AND file IS NOT NULL")
                .all(agent);
            return new Set([
                ...fc.map((r) => norm(r.path)),
                ...at.map((r) => norm(r.file)),
            ]);
        };
        const a = filesOf(agentA);
        const b = filesOf(agentB);
        return [...a].filter((f) => b.has(f)).sort();
    }
    // --- governance (CI gate) --------------------------------------------------
    distinctAttributedCommits() {
        return this.db
            .prepare("SELECT DISTINCT commit_sha FROM attributions")
            .all().map((r) => r.commit_sha);
    }
    hasAttribution(sha) {
        return (this.db
            .prepare("SELECT 1 FROM attributions WHERE commit_sha = ? LIMIT 1")
            .get(sha) !== undefined);
    }
    // NB: the "approved human review" and "AI attribution" checks are now
    // expressed set-based inside report()/unreviewedCommits()/check() rather than
    // per-commit helpers, to avoid N+1 query loops.
    /**
     * Evaluate governance policy over a set of commits — the read-only basis for
     * a CI gate. The board only reports pass/fail and the specific violations; it
     * never blocks anything itself (the CI system decides what to do with a
     * non-zero result). This keeps the blackboard passive while still enabling
     * "no unreviewed AI work reaches main".
     */
    check(opts) {
        const violations = [];
        let chain = null;
        if (opts.verifyChain) {
            chain = this.verifyChain();
            if (!chain.ok) {
                violations.push({
                    kind: "chain-broken",
                    commit: null,
                    detail: `timeline hash chain broken at seq ${chain.brokenAtSeq}`,
                });
            }
        }
        // Attribution is required only for an explicit commit scope (otherwise the
        // "all attributed commits" scope trivially satisfies it).
        if (opts.requireAttribution && opts.commits) {
            for (const c of opts.commits) {
                if (!this.hasAttribution(c)) {
                    violations.push({
                        kind: "unattributed",
                        commit: c,
                        detail: "no attribution recorded for this commit",
                    });
                }
            }
        }
        const scope = opts.commits ?? this.distinctAttributedCommits();
        if (opts.requireHumanReview) {
            // Set-based (was an N+1 of hasAiAttribution+hasHumanReview per commit):
            // unreviewedCommits() is the board-wide set of AI commits lacking an
            // approved human review; intersect it with the scope.
            const unreviewed = new Set(this.unreviewedCommits().map((c) => c.commit));
            for (const c of scope) {
                if (unreviewed.has(c)) {
                    violations.push({
                        kind: "unreviewed",
                        commit: c,
                        detail: "AI-produced commit has no approved human review",
                    });
                }
            }
        }
        return {
            ok: violations.length === 0,
            violations,
            chain,
            checked: scope.length,
        };
    }
    // --- portability (export / import / trailers) ------------------------------
    allAttributions() {
        return this.db.prepare("SELECT * FROM attributions").all().map(rowToAttribution);
    }
    allReviews() {
        return this.db.prepare("SELECT * FROM reviews").all().map(rowToReview);
    }
    /**
     * Bundle attribution for a set of commits into a portable, version-stamped
     * object. This is how local-first attribution survives `git push`: export on
     * the machine that did the work, import into a team board (or CI) on the
     * other side. Git carries the code; the bundle carries the accountability.
     */
    exportBundle(commits) {
        const scope = new Set(commits ?? this.distinctAttributedCommits());
        const attributions = this.allAttributions().filter((a) => scope.has(a.commit));
        const reviews = this.allReviews().filter((r) => scope.has(r.commit));
        const sessionIds = new Set([...attributions, ...reviews]
            .map((x) => x.sessionId)
            .filter((s) => s !== null));
        const sessions = [...sessionIds]
            .map((sid) => this.getSession(sid))
            .filter((s) => s !== undefined);
        const decisions = this.db.prepare("SELECT * FROM decisions").all()
            .map(rowToDecision)
            .filter((d) => d.relatedCommits.some((c) => scope.has(c)));
        const bundle = {
            version: BUNDLE_VERSION,
            exportedAt: now(),
            attributions,
            reviews,
            sessions,
            decisions,
            signature: null,
            signedBy: null,
            signedSession: null,
        };
        // Sign the bundle with the active session's key so the importer can verify
        // it came from a holder of that key (origin authenticity), and that it was
        // not altered in transit (integrity).
        const sid = this.activeSession;
        const priv = sid ? this.loadSessionKey(sid) : undefined;
        const session = sid ? this.getSession(sid) : undefined;
        if (priv && session?.publicKey) {
            bundle.signature = signHash(priv, Board.bundleDigest(bundle));
            bundle.signedBy = session.publicKey;
            bundle.signedSession = sid;
        }
        return bundle;
    }
    /** Canonical SHA-256 over a bundle's records (excludes the signature fields). */
    static bundleDigest(bundle) {
        const sortById = (rows) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const canonical = JSON.stringify({
            version: bundle.version,
            attributions: sortById(bundle.attributions),
            reviews: sortById(bundle.reviews),
            sessions: sortById(bundle.sessions),
            decisions: sortById(bundle.decisions),
        });
        return createHash("sha256").update(canonical).digest("hex");
    }
    /** Verify a bundle's signature, if any: true/false, or null when unsigned. */
    static verifyBundle(bundle) {
        if (!bundle.signature || !bundle.signedBy) {
            return null;
        }
        return verifyHash(bundle.signedBy, Board.bundleDigest(bundle), bundle.signature);
    }
    /**
     * Merge a bundle into this board. Idempotent: rows already present (by id)
     * are left untouched, so re-importing is safe. One `import` event is appended
     * to the local timeline; the imported rows keep their original ids/times.
     */
    importBundle(bundle, opts = {}) {
        if (!bundle || bundle.version !== BUNDLE_VERSION) {
            throw new Error(`unsupported bundle version: ${bundle?.version ?? "(none)"}`);
        }
        // Authenticity/integrity: null = unsigned, true = valid, false = tampered.
        const verified = Board.verifyBundle(bundle);
        if (opts.requireSigned && verified !== true) {
            throw new Error(verified === false
                ? "bundle signature is INVALID (tampered or wrong key)"
                : "bundle is unsigned and --require-signed was set");
        }
        const counts = { attributions: 0, reviews: 0, sessions: 0, decisions: 0 };
        const tx = this.db.transaction(() => {
            const insSession = this.db.prepare(`INSERT OR IGNORE INTO sessions (id, agent_name, label, machine, working_directory, git_branch, repository, public_key, last_heartbeat, started_at, finished_at)
         VALUES (@id, @agentName, @label, @machine, @workingDirectory, @gitBranch, @repository, @publicKey, @lastHeartbeat, @startedAt, @finishedAt)`);
            for (const s of bundle.sessions ?? []) {
                // Normalize: an external bundle may predate newer session columns, so
                // fill any missing field with null before binding.
                counts.sessions += insSession.run({
                    id: s.id,
                    agentName: s.agentName,
                    label: s.label ?? null,
                    machine: s.machine ?? null,
                    workingDirectory: s.workingDirectory ?? null,
                    gitBranch: s.gitBranch ?? null,
                    repository: s.repository ?? null,
                    publicKey: s.publicKey ?? null,
                    lastHeartbeat: s.lastHeartbeat ?? null,
                    startedAt: s.startedAt,
                    finishedAt: s.finishedAt ?? null,
                }).changes;
            }
            const insAttr = this.db.prepare(`INSERT OR IGNORE INTO attributions (id, commit_sha, file, hunk, actor_type, actor, provider, model, cli, session_id, created_at)
         VALUES (@id, @commit, @file, @hunk, @actorType, @actor, @provider, @model, @cli, @sessionId, @createdAt)`);
            for (const a of bundle.attributions ?? []) {
                counts.attributions += insAttr.run(a).changes;
            }
            const insReview = this.db.prepare(`INSERT OR IGNORE INTO reviews (id, commit_sha, reviewer_type, reviewer, session_id, outcome, note, created_at)
         VALUES (@id, @commit, @reviewerType, @reviewer, @sessionId, @outcome, @note, @createdAt)`);
            for (const r of bundle.reviews ?? []) {
                counts.reviews += insReview.run(r).changes;
            }
            const insDecision = this.db.prepare(`INSERT OR IGNORE INTO decisions (id, agent_id, session_id, title, rationale, evidence, related_commits, related_tasks, created_at)
         VALUES (@id, @agentId, @sessionId, @title, @rationale, @evidence, @relatedCommits, @relatedTasks, @createdAt)`);
            for (const d of bundle.decisions ?? []) {
                counts.decisions += insDecision.run({
                    ...d,
                    relatedCommits: JSON.stringify(d.relatedCommits ?? []),
                    relatedTasks: JSON.stringify(d.relatedTasks ?? []),
                }).changes;
            }
            // Skip the audit event on a pure no-op re-import (all rows already
            // present) so re-syncing the same bundle doesn't accrete noise.
            if (counts.attributions +
                counts.reviews +
                counts.sessions +
                counts.decisions >
                0) {
                const trust = verified === true
                    ? " [signed ✓]"
                    : verified === false
                        ? " [signature INVALID]"
                        : " [unsigned]";
                this.append(this.config.agent, "import", `imported bundle: ${counts.attributions} attribution(s), ${counts.reviews} review(s)${trust}`, null, null, { ...counts, verified });
            }
        });
        tx.immediate();
        return { ...counts, verified };
    }
    /**
     * Git trailer lines encoding a commit's attribution, for embedding in a
     * commit message so it travels with the commit itself (a lightweight
     * alternative to a bundle). Blackboard-namespaced — it does not hijack
     * `Co-Authored-By`.
     */
    trailersFor(rev) {
        const sha = git.resolveRev(rev) ?? rev;
        const attrs = this.attributionsForCommit(sha);
        const lines = [];
        const seen = new Set();
        for (const a of attrs) {
            const model = a.model ? ` ${a.model}` : "";
            const line = `Blackboard-Attribution: ${a.actorType} ${a.actor}${model}${a.cli ? ` via ${a.cli}` : ""}`;
            if (!seen.has(line)) {
                seen.add(line);
                lines.push(line);
            }
        }
        const sessionIds = [
            ...new Set(attrs.map((a) => a.sessionId).filter((s) => s !== null)),
        ];
        for (const sid of sessionIds) {
            lines.push(`Blackboard-Session: ${sid}`);
        }
        return lines;
    }
    /** Everything the board knows about a commit — the `explain` view. */
    explain(rev) {
        const sha = git.resolveRev(rev) ?? rev;
        const info = git.commitInfo(sha) ?? { sha };
        const attributions = this.attributionsForCommit(sha);
        if (attributions.length === 0 && !git.resolveRev(rev)) {
            return undefined;
        }
        return {
            commit: info,
            attributions,
            reviews: this.reviewsForCommit(sha),
            decisions: this.decisionsForCommit(sha),
            note: git.readNote(sha) ?? null,
        };
    }
    /** Which session introduced a line — Git blame → attribution. */
    blame(file, line) {
        const b = git.blameLine(file, line);
        if (!b) {
            return undefined;
        }
        return {
            sha: b.sha,
            gitAuthor: b.author,
            attributions: this.attributionsForCommitFile(b.sha, file),
        };
    }
    /**
     * Blame → narrative: from a single line, trace back to the session that
     * introduced it and surface that session's whole story — what else it did,
     * the decisions it made, and the handoffs it left. Turns `git blame` into
     * "why does this line exist".
     */
    blameNarrative(file, line) {
        const b = git.blameLine(file, line);
        if (!b) {
            return undefined;
        }
        const attributions = this.attributionsForCommitFile(b.sha, file);
        const sessionId = attributions
            .map((a) => a.sessionId)
            .find((s) => s !== null) ?? null;
        const session = sessionId ? (this.getSession(sessionId) ?? null) : null;
        const sessionTimeline = sessionId ? this.sessionTimeline(sessionId) : [];
        const decisions = sessionId
            ? this.db
                .prepare("SELECT * FROM decisions WHERE session_id = ? ORDER BY created_at ASC")
                .all(sessionId).map(rowToDecision)
            : [];
        const handoffs = sessionId
            ? this.db
                .prepare("SELECT * FROM handoffs WHERE from_session = ? ORDER BY created_at ASC")
                .all(sessionId).map(rowToHandoff)
            : [];
        return {
            sha: b.sha,
            gitAuthor: b.author,
            attributions,
            session,
            sessionTimeline,
            decisions,
            handoffs,
        };
    }
    // --- reporting -------------------------------------------------------------
    /** Aggregate metrics for a scorecard: coverage, AI/human ratio, per-agent. */
    /**
     * Accountability scorecard. With `projectKey`, returns the three-level
     * project -> task -> trace aggregation instead (a DIFFERENT shape — callers
     * that need both must call twice). Unknown key returns undefined.
     */
    report(projectKey = null) {
        if (projectKey) {
            return this.projectReport(projectKey);
        }
        return this.readSnapshot(() => this.reportSnapshot());
    }
    reportSnapshot() {
        const one = (sql, ...params) => {
            const row = this.db.prepare(sql).get(...params);
            return row?.n ?? 0;
        };
        const attrTotal = one("SELECT COUNT(*) AS n FROM attributions");
        const attrAi = one("SELECT COUNT(*) AS n FROM attributions WHERE actor_type = 'ai'");
        const attrHuman = one("SELECT COUNT(*) AS n FROM attributions WHERE actor_type = 'human'");
        const commitsTotal = one("SELECT COUNT(DISTINCT commit_sha) AS n FROM attributions");
        // Set-based (was an N+1 loop of hasHumanReview per AI commit): count AI
        // commits, and those with an approved human review, in two queries.
        const aiProduced = one("SELECT COUNT(DISTINCT commit_sha) AS n FROM attributions WHERE actor_type = 'ai'");
        const reviewed = one(`SELECT COUNT(*) AS n FROM (
         SELECT DISTINCT a.commit_sha FROM attributions a
         WHERE a.actor_type = 'ai'
           AND EXISTS (SELECT 1 FROM reviews r
                       WHERE r.commit_sha = a.commit_sha
                         AND r.reviewer_type = 'human' AND r.outcome = 'approved')
       )`);
        const unreviewed = aiProduced - reviewed;
        // N/A (null), not 100%, when there is no AI work to review.
        const reviewCoverage = aiProduced === 0 ? null : reviewed / aiProduced;
        const perAgentRows = this.db
            .prepare(`SELECT actor AS agent, actor_type AS actorType, COUNT(*) AS attributions,
                COUNT(DISTINCT commit_sha) AS commits, COUNT(DISTINCT file) AS files
         FROM attributions GROUP BY actor, actor_type ORDER BY attributions DESC`)
            .all();
        return {
            attributions: { total: attrTotal, ai: attrAi, human: attrHuman },
            commits: {
                total: commitsTotal,
                aiProduced,
                humanReviewed: reviewed,
                unreviewed,
            },
            reviewCoverage,
            aiHumanRatio: { ai: attrAi, human: attrHuman },
            perAgent: perAgentRows,
            sessions: {
                total: one("SELECT COUNT(*) AS n FROM sessions"),
                open: one("SELECT COUNT(*) AS n FROM sessions WHERE finished_at IS NULL"),
            },
            risks: {
                open: one("SELECT COUNT(*) AS n FROM risks WHERE status = 'open'"),
                mitigated: one("SELECT COUNT(*) AS n FROM risks WHERE status = 'mitigated'"),
                closed: one("SELECT COUNT(*) AS n FROM risks WHERE status = 'closed'"),
            },
        };
    }
    // --- liveness (heartbeat) --------------------------------------------------
    /** Stamp a session's liveness. Cheap; not recorded on the timeline. */
    heartbeat(sessionId) {
        const sid = sessionId ?? this.activeSession;
        if (!sid) {
            return undefined;
        }
        this.db
            .prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?")
            .run(now(), sid);
        return this.getSession(sid);
    }
    /** Open sessions whose heartbeat is within `withinMs` — genuinely active. */
    activeSessions(withinMs = 120_000) {
        const cutoff = new Date(Date.now() - withinMs).toISOString();
        return this.db
            .prepare("SELECT * FROM sessions WHERE finished_at IS NULL AND last_heartbeat >= ? ORDER BY last_heartbeat DESC")
            .all(cutoff).map(rowToSession);
    }
    /**
     * Other active sessions that recorded a change to the same file — real-time
     * collision awareness (two live agents editing one file), a step beyond the
     * same-task conflict surfaced by `fileChanged`.
     */
    activeEditorsOfFile(file, excludeSession, withinMs = 120_000) {
        const active = new Set(this.activeSessions(withinMs).map((s) => s.id));
        const rows = this.db
            .prepare("SELECT DISTINCT session_id, agent_id FROM files_changed WHERE path = ? AND session_id IS NOT NULL")
            .all(file);
        return rows
            .filter((r) => active.has(r.session_id) && r.session_id !== excludeSession)
            .map((r) => ({ sessionId: r.session_id, agent: r.agent_id }));
    }
    // --- retention & redaction -------------------------------------------------
    /**
     * Delete potentially-sensitive, bulky rows (messages, evidence, file-change
     * records) created before a horizon. The append-only timeline is NEVER pruned
     * — it is the audit trail — so pruning is recorded as one `prune` event.
     */
    prune(beforeIso) {
        const tx = this.db.transaction(() => {
            const del = (table) => this.db
                .prepare(`DELETE FROM ${table} WHERE created_at < ?`)
                .run(beforeIso).changes;
            const counts = {
                messages: del("messages"),
                evidence: del("evidence"),
                filesChanged: del("files_changed"),
            };
            this.append(this.config.agent, "prune", `pruned rows before ${beforeIso}: ${counts.messages} message(s), ${counts.evidence} evidence, ${counts.filesChanged} file-change(s)`, null, null, counts);
            return counts;
        });
        return tx.immediate();
    }
    /**
     * Redact a timeline entry's content across ALL read paths. Two things happen:
     * (1) the timeline row's displayed summary/payload is overlaid with a
     * tombstone (`timeline`/`since`/`sessionTimeline`), and (2) the underlying
     * source row that the entry points at (a message body, evidence note, handoff
     * text, decision rationale, risk title) is blanked in its own table — because
     * those tables are read directly by `inbox`/`status`/the dashboard and would
     * otherwise leak the content the overlay only hid on the timeline.
     *
     * The timeline row's stored hash input is left intact so the chain still
     * verifies. NOTE: this hides content at the read layer — it is not
     * cryptographic erasure (the original summary remains in the timeline row to
     * keep the chain valid). Don't store secrets you must be able to destroy.
     */
    redact(seq, reason = null) {
        const row = this.db
            .prepare("SELECT ref_table, ref_id FROM timeline WHERE seq = ?")
            .get(seq);
        if (!row) {
            return false;
        }
        const tx = this.db.transaction(() => {
            this.db
                .prepare("INSERT OR REPLACE INTO redactions (seq, reason, actor, created_at) VALUES (?, ?, ?, ?)")
                .run(seq, reason, this.config.agent, now());
            // Blank the free-text columns of the source row, if any, so no direct
            // read path can surface the redacted content.
            const TOMB = "[redacted]";
            const blanks = {
                messages: "UPDATE messages SET body = ? WHERE id = ?",
                evidence: "UPDATE evidence SET ref = ?, note = ? WHERE id = ?",
                handoffs: "UPDATE handoffs SET summary = ?, context = ? WHERE id = ?",
                decisions: "UPDATE decisions SET rationale = ? WHERE id = ?",
                risks: "UPDATE risks SET title = ? WHERE id = ?",
            };
            if (row.ref_table && row.ref_id && blanks[row.ref_table]) {
                const sql = blanks[row.ref_table];
                const argCount = (sql.match(/\?/g) ?? []).length;
                const params = Array(argCount - 1).fill(TOMB);
                this.db.prepare(sql).run(...params, row.ref_id);
            }
            this.append(this.config.agent, "redaction", `redacted #${seq}${reason ? `: ${reason}` : ""}`, "timeline", String(seq), { seq });
        });
        tx.immediate();
        return true;
    }
    /** Seqs that have been redacted, with their reason. */
    redactionMap() {
        const rows = this.db
            .prepare("SELECT seq, reason FROM redactions")
            .all();
        return new Map(rows.map((r) => [r.seq, r.reason]));
    }
    /** Apply the redaction overlay to a set of events (content → tombstone). */
    applyRedactions(events) {
        const redacted = this.redactionMap();
        if (redacted.size === 0) {
            return events;
        }
        return events.map((e) => redacted.has(e.seq)
            ? {
                ...e,
                summary: `[redacted${redacted.get(e.seq) ? `: ${redacted.get(e.seq)}` : ""}]`,
                payload: null,
            }
            : e);
    }
    // --- ingestion -------------------------------------------------------------
    /**
     * Record a batch of normalized ingest events (from a transcript adapter)
     * under the acting agent and active session, then append one `ingest`
     * summary event. Each file/decision/note is attributed like any other write.
     */
    ingest(events) {
        const counts = { files: 0, decisions: 0, notes: 0 };
        // One transaction for the whole batch: a crash mid-transcript leaves the
        // board unchanged (all-or-nothing), rather than a half-applied prefix that
        // a re-run would double-record. The per-item writes nest as savepoints.
        const tx = this.db.transaction(() => {
            for (const e of events) {
                if (e.type === "file") {
                    this.fileChanged(this.config.agent, e.path, e.change);
                    counts.files += 1;
                }
                else if (e.type === "decision") {
                    this.decision(this.config.agent, e.title, {
                        rationale: e.rationale ?? null,
                    });
                    counts.decisions += 1;
                }
                else if (e.type === "note") {
                    this.note(this.config.agent, e.text);
                    counts.notes += 1;
                }
            }
            // Skip the summary event for an empty ingest — it would be pure noise in
            // the immutable timeline on a no-op transcript.
            if (counts.files + counts.decisions + counts.notes > 0) {
                this.append(this.config.agent, "ingest", `ingested ${counts.files} file(s), ${counts.decisions} decision(s), ${counts.notes} note(s)`, null, null, counts);
            }
        });
        tx.immediate();
        return counts;
    }
    // --- read ------------------------------------------------------------------
    status(forAgent) {
        // One read snapshot for the whole view: a concurrent writer committing
        // between these queries can't produce a status that mixes pre- and
        // post-write state.
        return this.readSnapshot(() => ({
            agents: this.listAgents(),
            openTasks: this.listTasks().filter((t) => t.status !== "done"),
            unreadMessages: forAgent ? this.inbox(forAgent) : this.allUnread(),
            openRisks: this.listRisks("open"),
            recentTimeline: this.timeline(10),
        }));
    }
    /**
     * Run a read-only function inside a single SQLite snapshot so every query it
     * makes sees a consistent point-in-time view of the board. Nested calls (a
     * snapshot within a snapshot) reuse the outer one.
     */
    readSnapshot(fn) {
        if (this.db.inTransaction) {
            return fn();
        }
        return this.db.transaction(fn)();
    }
    allUnread() {
        return this.db
            .prepare("SELECT * FROM messages WHERE read_at IS NULL ORDER BY created_at DESC")
            .all().map(rowToMessage);
    }
}
// --- row mappers -------------------------------------------------------------
function rowToAgent(r) {
    return {
        id: r.id,
        name: r.name,
        kind: r.kind,
        provider: r.provider ?? null,
        model: r.model ?? null,
        cli: r.cli ?? null,
        version: r.version ?? null,
        createdAt: r.created_at,
        lastSeen: r.last_seen,
    };
}
function rowToSession(r) {
    return {
        id: r.id,
        agentName: r.agent_name,
        label: r.label,
        machine: r.machine ?? null,
        workingDirectory: r.working_directory ?? null,
        gitBranch: r.git_branch ?? null,
        repository: r.repository ?? null,
        publicKey: r.public_key ?? null,
        lastHeartbeat: r.last_heartbeat ?? null,
        startedAt: r.started_at,
        finishedAt: r.finished_at ?? null,
        project: r.project ?? null,
        taskKey: r.task_key ?? null,
    };
}
function parseJsonObject(value) {
    if (typeof value !== "string" || value.length === 0) {
        return null;
    }
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
function acceptanceToStorage(value) {
    if (value === undefined || value === null) {
        return null;
    }
    const obj = typeof value === "string" ? parseJsonObject(value) : value;
    return obj && typeof obj === "object" && !Array.isArray(obj) ? JSON.stringify(obj) : null;
}
/**
 * Normalize a project stream vocabulary to its stored form: a JSON string array
 * of unique, non-empty, trimmed strings. Accepts an array or a raw string
 * (either a JSON array, or a comma-separated list like "串讲,译文,精读").
 * Returns null when nothing usable was supplied -- which the store reads back as
 * "no vocabulary declared", meaning `defineTask` rejects nothing.
 */
function streamsToStorage(value) {
    if (value === undefined || value === null)
        return null;
    let arr = value;
    if (typeof value === "string") {
        const raw = value.trim();
        if (!raw)
            return null;
        try {
            const parsed = JSON.parse(raw);
            arr = Array.isArray(parsed) ? parsed : raw.split(",");
        }
        catch {
            arr = raw.split(",");
        }
    }
    if (!Array.isArray(arr))
        return null;
    const cleaned = [...new Set(arr.map((e) => String(e).trim()).filter((s) => s.length > 0))];
    return cleaned.length ? JSON.stringify(cleaned) : null;
}
function parseJsonArray(value) {
    if (typeof value !== "string" || value.length === 0) {
        return [];
    }
    try {
        const parsed = JSON.parse(value);
        // Coerce every element to a string so the `string[]` type is honored even
        // if a caller stored non-strings (which would otherwise crash consumers
        // that call string methods on the elements).
        return Array.isArray(parsed) ? parsed.map((e) => String(e)) : [];
    }
    catch {
        return [];
    }
}
function rowToDecision(r) {
    return {
        id: r.id,
        agentId: r.agent_id,
        sessionId: r.session_id ?? null,
        title: r.title,
        rationale: r.rationale,
        evidence: r.evidence ?? null,
        relatedCommits: parseJsonArray(r.related_commits),
        relatedTasks: parseJsonArray(r.related_tasks),
        createdAt: r.created_at,
    };
}
function rowToAttribution(r) {
    return {
        id: r.id,
        commit: r.commit_sha,
        file: r.file,
        hunk: r.hunk,
        actorType: r.actor_type,
        actor: r.actor,
        provider: r.provider ?? null,
        model: r.model ?? null,
        cli: r.cli ?? null,
        sessionId: r.session_id ?? null,
        createdAt: r.created_at,
    };
}
function rowToReview(r) {
    return {
        id: r.id,
        commit: r.commit_sha,
        reviewerType: r.reviewer_type,
        reviewer: r.reviewer,
        sessionId: r.session_id ?? null,
        outcome: r.outcome,
        note: r.note ?? null,
        createdAt: r.created_at,
    };
}
function rowToHandoff(r) {
    return {
        id: r.id,
        fromAgent: r.from_agent,
        toAgent: r.to_agent,
        fromSession: r.from_session ?? null,
        toSession: r.to_session ?? null,
        summary: r.summary,
        context: r.context ?? null,
        relatedFiles: parseJsonArray(r.related_files),
        openQuestions: parseJsonArray(r.open_questions),
        taskKey: r.task_key ?? null,
        createdAt: r.created_at,
        acceptedAt: r.accepted_at ?? null,
    };
}
function rowToProject(r) {
    return {
        id: r.id,
        key: r.key,
        name: r.name,
        description: r.description ?? null,
        status: r.status,
        streams: parseJsonArray(r.streams),
        createdBy: r.created_by,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}
function rowToTask(r) {
    return {
        id: r.id,
        key: r.key,
        number: r.number ?? null,
        title: r.title,
        description: r.description ?? null,
        status: r.status,
        project: r.project ?? null,
        stream: r.stream ?? null,
        impact: r.impact ?? null,
        riskLevel: r.risk_level ?? null,
        acceptance: parseJsonObject(r.acceptance),
        progress: r.progress ?? 0,
        createdBy: r.created_by,
        claimedBy: r.claimed_by,
        claimedAt: r.claimed_at,
        releasedAt: r.released_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}
function rowToMessage(r) {
    return {
        id: r.id,
        fromAgent: r.from_agent,
        toAgent: r.to_agent,
        body: r.body,
        createdAt: r.created_at,
        readAt: r.read_at,
    };
}
function rowToRisk(r) {
    return {
        id: r.id,
        agentId: r.agent_id,
        title: r.title,
        severity: r.severity,
        status: r.status,
        taskKey: r.task_key ?? null,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at ?? null,
        resolvedBy: r.resolved_by ?? null,
    };
}
function rowToEvidence(r) {
    return {
        id: r.id,
        agentId: r.agent_id,
        ref: r.ref,
        note: r.note ?? null,
        target: r.target ?? null,
        sha256: r.sha256 ?? null,
        project: r.project ?? null,
        taskKey: r.task_key ?? null,
        kind: r.kind ?? null,
        createdAt: r.created_at,
    };
}
function rowToFileChange(r) {
    return {
        id: r.id,
        agentId: r.agent_id,
        sessionId: r.session_id ?? null,
        path: r.path,
        change: r.change,
        taskKey: r.task_key,
        createdAt: r.created_at,
    };
}
function rowToTimeline(r) {
    return {
        id: r.id,
        seq: r.seq,
        at: r.at,
        actor: r.actor,
        sessionId: r.session_id ?? null,
        kind: r.kind,
        refTable: r.ref_table,
        refId: r.ref_id,
        summary: r.summary,
        payload: r.payload === null ? null : JSON.parse(r.payload),
        // step 2: four-layer ownership. Attached attributes, NOT inside computeHash.
        project: r.project ?? null,
        taskKey: r.task_key ?? null,
        prevHash: r.prev_hash,
        hash: r.hash,
    };
}
//# sourceMappingURL=board.js.map