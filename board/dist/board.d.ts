import { type AgentIdentity, type BoardConfig, type ConfigOverrides } from "./config.js";
import * as git from "./git.js";
import type { IngestEvent } from "./adapters.js";
import type { Agent, ActorType, Attribution, BoardStatus, Decision, Evidence, EvidenceCheck, EvidenceSkipped, FileChange, FileChangeKind, Handoff, Message, Project, ProjectReport, ProjectSummary, ProjectStatus, Review, ReviewerType, ReviewOutcome, Risk, RiskSeverity, RiskStatus, RiskLevel, Session, Task, TaskCard, TaskFilters, TaskStatus, TaskTrace, TimelineEvent } from "./types.js";
/** Result of claiming a task — `conflict` is set if another agent holds it. */
export interface ClaimResult {
    task: Task;
    /** The agent currently holding the key, if it was already claimed. */
    conflict: string | null;
}
/** Result of verifying the timeline hash chain. */
export interface ChainVerification {
    ok: boolean;
    length: number;
    /** Seq of the first entry whose hash does not validate, if any. */
    brokenAtSeq: number | null;
    /**
     * Whether a head anchor was present. When false on a non-empty timeline, tail
     * truncation is undetectable from the DB alone (the anchor may be absent
     * because the board predates anchoring, or because it was deleted) — callers
     * should present this as "links intact but unanchored", not a clean pass.
     */
    anchored: boolean;
}
export type PolicyViolationKind = "unreviewed" | "unattributed" | "chain-broken";
export interface PolicyViolation {
    kind: PolicyViolationKind;
    commit: string | null;
    detail: string;
}
/** Outcome of a governance check — the basis for a CI gate. */
export interface PolicyResult {
    ok: boolean;
    violations: PolicyViolation[];
    chain: ChainVerification | null;
    /** How many commits were in scope for review checks. */
    checked: number;
}
export interface PolicyOptions {
    /** Explicit commit scope (e.g. a PR's `main..HEAD` shas). */
    commits?: string[];
    /** Fail if any AI-produced commit in scope lacks a human review. */
    requireHumanReview?: boolean;
    /** Fail if any explicitly-scoped commit has no attribution at all. */
    requireAttribution?: boolean;
    /** Fail if the timeline hash chain does not verify. */
    verifyChain?: boolean;
}
/** Schema tag for the portable attribution bundle. Bump on breaking changes. */
export declare const BUNDLE_VERSION = "octopus-blackboard/attribution-bundle@1";
/** A portable bundle of attribution that travels with (but outside) Git. */
export interface AttributionBundle {
    version: string;
    exportedAt: string;
    attributions: Attribution[];
    reviews: Review[];
    sessions: Session[];
    decisions: Decision[];
    /** Ed25519 signature (base64) over the bundle's records, if signed on export. */
    signature?: string | null;
    /** PEM public key that produced `signature`. */
    signedBy?: string | null;
    /** Session id that signed the bundle. */
    signedSession?: string | null;
}
/** Aggregate scorecard for a board — the `report` view. */
export interface Report {
    attributions: {
        total: number;
        ai: number;
        human: number;
    };
    commits: {
        total: number;
        aiProduced: number;
        humanReviewed: number;
        unreviewed: number;
    };
    /**
     * Fraction (0..1) of AI-produced commits with an approved human review, or
     * `null` when there is no AI work to review (N/A — not 100%).
     */
    reviewCoverage: number | null;
    aiHumanRatio: {
        ai: number;
        human: number;
    };
    perAgent: {
        agent: string;
        actorType: string;
        attributions: number;
        commits: number;
        files: number;
    }[];
    sessions: {
        total: number;
        open: number;
    };
    risks: {
        open: number;
        mitigated: number;
        closed: number;
    };
}
/**
 * The blackboard. A thin, synchronous wrapper over a SQLite database. Every
 * mutation also appends one tamper-evident entry to the timeline within the
 * same transaction, so the board and its audit log can never diverge.
 *
 * The board is deliberately passive: it records and reports. It never triggers
 * an agent, schedules work, or decides anything on an agent's behalf.
 */
export declare class Board {
    readonly config: BoardConfig;
    private readonly db;
    /** Active session id for the acting agent; stamped onto every write. */
    private activeSession;
    constructor(config: BoardConfig);
    private currentSessionFromDb;
    /** The active session id for this board's agent (null if none). */
    activeSessionId(): string | null;
    static open(overrides?: ConfigOverrides & { sessionId?: string | null }): Board;
    close(): void;
    private headHash;
    private static computeHash;
    /** Append one entry to the timeline. Must run inside a transaction. */
    private append;
    /** The current timeline head (seq + hash). Record this OUTSIDE the DB — in a
     *  commit, a log, a second machine — to anchor against tail truncation. */
    head(): {
        seq: number;
        hash: string;
    };
    /**
     * Check the chain against an anchor recorded earlier (e.g. committed to git).
     * `ok` = the anchored row still exists with that hash and history through it
     * is intact; `truncated` = rows at/below the anchor were deleted; `altered` =
     * history at/below the anchor was edited. This is what closes the "attacker
     * drops the trigger and truncates" gap — an external anchor makes truncation
     * provable.
     */
    verifyAnchor(seq: number, hash: string): {
        status: "ok" | "truncated" | "altered";
        headSeq: number;
    };
    private headAnchor;
    /** Re-walk the chain and confirm every hash links to its predecessor. */
    verifyChain(): ChainVerification;
    timeline(limit?: number): TimelineEvent[];
    /** The current head sequence number (0 if the board is empty). */
    headSeq(): number;
    /** Timeline events after `afterSeq`, oldest first — the polling primitive
     *  behind `watch`/`subscribe`. Passive: callers poll; the board never pushes. */
    since(afterSeq: number): TimelineEvent[];
    /**
     * Filter events down to those an agent should be notified about: messages to
     * it (or broadcast), handoffs to it, and claim conflicts on keys it holds. An
     * agent's own actions are excluded. This is what makes `watch --for <agent>`
     * a useful inbox rather than a firehose.
     */
    notable(events: TimelineEvent[], agent: string): TimelineEvent[];
    /**
     * Register the agent if new and stamp `last_seen`. Idempotent by name. When
     * registering the acting agent, its full provider-independent identity
     * (provider/model/cli/version) is merged in; non-null fields never overwrite
     * with null, so a later bare touch cannot erase identity.
     */
    ensureAgent(name: string, identity?: Partial<AgentIdentity>): Agent;
    getAgent(name: string): Agent | undefined;
    /**
     * Open a new session for the acting agent and make it current (persisted in
     * the DB, so later CLI invocations attribute to it). Captures the machine and
     * repository context the session runs in.
     */
    startSession(label?: string | null, options?: { project?: string | null; taskKey?: string | null; detached?: boolean }): Session;
    private keyPath;
    private saveSessionKey;
    private loadSessionKey;
    /**
     * Sign the current timeline head hash with a session's private key. The
     * signature attests "this session vouches for board state through seq N".
     * Recorded in the `signatures` table (not the chain, so the head stays put).
     */
    signHead(sessionId?: string): {
        headSeq: number;
        headHash: string;
    } | undefined;
    /**
     * Verify every recorded signature. `valid` = the signature checks out against
     * its public key. `current` = the signed head hash still matches the timeline
     * row at that seq (i.e. history below it was not altered/truncated since).
     */
    verifySignatures(chain?: ChainVerification): {
        sessionId: string;
        agent: string | null;
        headSeq: number;
        valid: boolean;
        current: boolean;
        at: string;
    }[];
    /** Highest seq that a valid, still-current signature vouches for (0 = none). */
    signedThrough(chain?: ChainVerification): number;
    /** Close a session (the active one by default) and clear the pointer. */
    stopSession(sessionId?: string): Session | undefined;
    getSession(sessionId: string): Session | undefined;
    listSessions(limit?: number): Session[];
    /** All timeline events belonging to a session, oldest first. */
    sessionTimeline(sessionId: string): TimelineEvent[];
    listAgents(): Agent[];
    /** A free-form status note broadcast to the board. */
    note(actor: string, text: string, opts?: {
        project?: string | null;
        taskKey?: string | null;
    }): TimelineEvent;
    /**
     * Claim a task by key, creating it if absent. If another agent already holds
     * an unreleased claim, the claim still records but `conflict` names the
     * holder — the board surfaces the collision rather than blocking it.
     */
    claim(actor: string, key: string, title?: string | null): ClaimResult;
    /** Release a claim the actor holds. */
    release(actor: string, key: string): Task | undefined;
    /** Mark a task done. */
    complete(actor: string, key: string): Task | undefined;
    listTasks(status?: string, filters?: TaskFilters): Task[];
    // --- projects (four-layer: board -> project -> task -> trace) --------------
    /** Does a project with this key exist on the board? */
    projectExists(key: string): boolean;
    getProject(key: string): Project | undefined;
    /**
     * Create or update a project. `created_by` is stamped on first insert and never
     * rewritten. The board never auto-creates a project as a side effect of
     * anything else — this is always an explicit, attributed action.
     */
    createProject(actor: string, key: string, opts?: {
        name?: string | null;
        description?: string | null;
        status?: ProjectStatus;
        streams?: string[] | string | null;
    }): Project;
    /** Set a project's lifecycle status. Undefined for an unknown key; throws on a bad status. */
    setProjectStatus(actor: string, key: string, status: ProjectStatus): Project | undefined;
    /** All projects, each with its live task count and per-status breakdown. */
    listProjects(): ProjectSummary[];
    /** Three-level aggregation: project -> tasks -> trace. */
    projectReport(key: string): ProjectReport | undefined;
    /**
     * The trace entries for ONE task (task -> trace, the fourth drilldown level).
     * A row belongs to the task by either exact link it uses: `task_key` equals
     * the task's key, or `ref_table='tasks'` with `ref_id` = the task's UUID.
     * Returns undefined for an unknown task.
     */
    taskTrace(ref: string, limit?: number): TaskTrace | undefined;
    /**
     * Derived project membership (union of project-scoped timeline writes, task
     * assignees under the project, and sessions bound to it). NOT tamper-proof.
     */
    isProjectMember(agent: string, project: string): boolean;
    projectMembers(project: string): string[];
    /** The sedimentation register: evidence filtered by project / task / kind. */
    listEvidence(filters?: {
        project?: string | null;
        taskKey?: string | null;
        kind?: string | null;
    }): Evidence[];
    private nextTaskNumber;
    getTask(key: string): Task | undefined;
    /** Resolve a task by key OR by its human number (`"145"` / `"#145"`). */
    resolveTask(ref: string): Task | undefined;
    /**
     * Create or update a task's kanban fields (title, description, project,
     * impact/blast-radius, risk level). Creates the task (with a fresh number) if
     * the key is new; otherwise updates only the provided fields.
     */
    defineTask(actor: string, key: string, opts?: {
        title?: string | null;
        description?: string | null;
        /** Project key. Must be null/omitted, or an existing `projects.key` — a
            non-existent key is rejected (fail-closed, step8). */
        project?: string | null;
        /** Sub-line within a project (step 2). */
        stream?: string | null;
        impact?: string | null;
        riskLevel?: RiskLevel | null;
        /** Machine-checkable acceptance spec; stored canonical-JSON on the task row. */
        acceptance?: Record<string, unknown> | null;
    }): Task;
    /**
     * Assign a task to an agent and notify them — records the assignee AND drops a
     * message in that agent's inbox ("please look at task #145 …"). This is the
     * passive form of "notify Claude to look at 145": the board records the ask;
     * the agent reads its inbox and decides to act. The board never launches it.
     */
    assign(actor: string, key: string, toAgent: string): Task | undefined;
    /** Report progress (0–100). Moves status to in-progress, or done at 100. */
    setProgress(actor: string, key: string, progress: number): Task | undefined;
    /** Set a task's status directly (e.g. blocked). */
    setTaskStatus(actor: string, key: string, status: TaskStatus): Task | undefined;
    assigneesFor(key: string): string[];
    private risksForTask;
    /**
     * How many agents are actively working the task right now: assignees (or the
     * claimer) that have an active (heartbeating) session.
     */
    private activeAgentsOnTask;
    /** Full kanban card for one task. */
    taskCard(key: string): TaskCard | undefined;
    /** Every task as a kanban card, newest-updated first. */
    listTaskCards(filters?: TaskFilters): TaskCard[];
    /**
     * Record a verification outcome for a task as a first-class timeline event
     * (kind "verify"). `verdict` is fail-closed: only "pass"/"fail" accepted.
     */
    verify(actor: string, key: string, verdict: "pass" | "fail", opts?: {
        /** Verification level label, e.g. "V1" (mechanical), "V2", "V3". */
        level?: string;
        summary?: string;
        checks?: Array<Record<string, unknown>>;
        evidence?: unknown;
    }): TimelineEvent | undefined;
    /** Verification events recorded for a task, newest first. */
    verificationsFor(key: string): Array<Record<string, unknown> & {
        seq: number;
        at: string;
        actor: string;
        summary: string;
    }>;
    /** Leave a message for another agent, or broadcast (to = null). */
    message(actor: string, to: string | null, body: string, opts?: {
        project?: string | null;
        taskKey?: string | null;
    }): Message;
    /** Messages addressed to `agent` (or broadcast) that it has not acked yet. */
    inbox(agent: string, includeRead?: boolean): Message[];
    markRead(messageId: string, agent?: string | null): boolean;
    /** Ack everything currently in `agent`'s unread inbox. Returns the ids acked. */
    markInboxRead(agent: string): string[];
    /** Who has acked a message, oldest ack first. */
    readers(messageId: string): Array<{
        agent: string;
        read_at: string;
    }>;
    /** Direct messages `agent` sent that the intended recipient has not acked. */
    pendingAcks(agent: string): Array<{
        id: string;
        toAgent: string | null;
        createdAt: string;
        acks: number;
    }>;
    decision(actor: string, title: string, opts?: {
        /** Four-layer ownership (step 2). */
        project?: string | null;
        taskKey?: string | null;
        rationale?: string | null;
        evidence?: string | null;
        relatedCommits?: string[];
        relatedTasks?: string[];
    }): Decision;
    decisionsForCommit(commitSha: string): Decision[];
    evidence(actor: string, ref: string, note?: string | null, target?: string | null, project?: string | null, opts?: {
        /** Scope the register entry to a task. */
        taskKey?: string | null;
        /** One of EVIDENCE_KINDS: memory | skill | hook | lesson | playbook. */
        kind?: string | null;
    }): Evidence | EvidenceSkipped;
    /** SHA-256 of a local file's content, or null if `ref` is not a readable file. */
    private static hashFileIfLocal;
    /**
     * Re-check every content-hashed evidence file against its attach-time hash.
     * `ok` = unchanged, `changed` = content differs (tampered/edited), `missing`
     * = the file is gone, `unhashed` = a URL / non-file (never hashed).
     */
    verifyEvidence(): EvidenceCheck[];
    fileChanged(actor: string, path: string, change: FileChangeKind, taskKey?: string | null, project?: string | null): FileChange;
    /** Files another agent reports touching for a task — conflict awareness. */
    filesForTask(taskKey: string): FileChange[];
    risk(actor: string, title: string, severity?: RiskSeverity, taskKey?: string | null, project?: string | null): Risk;
    listRisks(status?: string | null): Risk[];
    /** Look up by full id, unique id prefix, or exact title. */
    getRisk(ref: string): Risk | undefined;
    /**
     * Close the loop on a risk card. Settled statuses stamp resolved_at/resolved_by;
     * back to "open" clears them. The note lands on the append-only timeline.
     */
    resolveRisk(actor: string, ref: string, status?: RiskStatus, note?: string | null): Risk | undefined;
    handoff(actor: string, to: string, summary: string, opts?: {
        /** Four-layer ownership (step 2). */
        project?: string | null;
        context?: string | null;
        relatedFiles?: string[];
        openQuestions?: string[];
        taskKey?: string | null;
    }): Handoff;
    /** Resolve the AI identity (agent + provider/model/cli) for a session. */
    private identityForSession;
    /** Record a single attribution — who actually produced a change. */
    attribute(commit: string, opts?: {
        file?: string | null;
        hunk?: string | null;
        actorType?: ActorType;
        actor?: string;
        provider?: string | null;
        model?: string | null;
        cli?: string | null;
        sessionId?: string | null;
    }): Attribution;
    private insertAttribution;
    /**
     * Associate a Git commit with the work that produced it. Resolves the rev to
     * a full sha, reads the files it touched from Git, and records one AI
     * attribution per file for the given (or active) session. Optionally writes
     * an additive `git notes` entry — Git history is never rewritten.
     */
    link(rev: string, opts?: {
        sessionId?: string | null;
        actorType?: ActorType;
        actor?: string;
        writeNote?: boolean;
    }): {
        sha: string;
        files: string[];
        count: number;
    } | undefined;
    attributionsForCommit(commitSha: string): Attribution[];
    attributionsForFile(file: string): Attribution[];
    /**
     * Attributions on a commit that concern a specific file — the rows whose
     * `file` matches (or is null, i.e. whole-commit). Falls back to all of the
     * commit's attributions if none name the file. Used by `blame`, so tracing a
     * line doesn't surface attributions for the commit's other files.
     */
    private attributionsForCommitFile;
    /** Record who reviewed a commit and the outcome. */
    review(commit: string, opts?: {
        reviewerType?: ReviewerType;
        reviewer?: string;
        outcome?: ReviewOutcome;
        note?: string | null;
        sessionId?: string | null;
    }): Review;
    reviewsForCommit(commitSha: string): Review[];
    /** Handoffs left FOR an agent — "what was passed to me", newest first. */
    handoffsFor(toAgent: string): Handoff[];
    /**
     * Who touched a file: Git authors, distinct (session, agent) pairs that
     * recorded a change, and commit attributions. The `agent` is the actor name
     * recorded on the change; one entry per distinct (session, agent), collapsing
     * repeated edits within a session to a single row (its latest timestamp).
     */
    whoTouched(file: string): {
        gitAuthors: string[];
        attributions: Attribution[];
        sessions: {
            sessionId: string | null;
            agent: string;
            at: string;
        }[];
    };
    /**
     * Commits attributed to an actor, CLI, provider, or model (matched broadly
     * across those columns). Returns the actual matching attribution rows, so the
     * reported `actor`/`cli` always reflect a row that matched the query — never
     * an unrelated attribution on the same commit.
     */
    commitsByActor(query: string): {
        commit: string;
        actor: string;
        cli: string | null;
        at: string;
    }[];
    /**
     * AI-attributed commits with no APPROVED human review — the accountability
     * gap. A commit reviewed but rejected/changes-requested is still unreviewed
     * for this purpose (sign-off was withheld), so it appears here.
     */
    unreviewedCommits(): {
        commit: string;
        actor: string;
        at: string;
    }[];
    /**
     * Files touched by BOTH agents — joint-modification / collision surface.
     * Paths are normalized (leading `./` stripped) so a CLI-relative form and
     * git's repo-root form for the same file reconcile. Case and deeper path
     * differences are not reconciled.
     */
    jointFiles(agentA: string, agentB: string): string[];
    private distinctAttributedCommits;
    private hasAttribution;
    /**
     * Evaluate governance policy over a set of commits — the read-only basis for
     * a CI gate. The board only reports pass/fail and the specific violations; it
     * never blocks anything itself (the CI system decides what to do with a
     * non-zero result). This keeps the blackboard passive while still enabling
     * "no unreviewed AI work reaches main".
     */
    check(opts: PolicyOptions): PolicyResult;
    private allAttributions;
    private allReviews;
    /**
     * Bundle attribution for a set of commits into a portable, version-stamped
     * object. This is how local-first attribution survives `git push`: export on
     * the machine that did the work, import into a team board (or CI) on the
     * other side. Git carries the code; the bundle carries the accountability.
     */
    exportBundle(commits?: string[]): AttributionBundle;
    /** Canonical SHA-256 over a bundle's records (excludes the signature fields). */
    private static bundleDigest;
    /** Verify a bundle's signature, if any: true/false, or null when unsigned. */
    static verifyBundle(bundle: AttributionBundle): boolean | null;
    /**
     * Merge a bundle into this board. Idempotent: rows already present (by id)
     * are left untouched, so re-importing is safe. One `import` event is appended
     * to the local timeline; the imported rows keep their original ids/times.
     */
    importBundle(bundle: AttributionBundle, opts?: {
        requireSigned?: boolean;
    }): {
        attributions: number;
        reviews: number;
        sessions: number;
        decisions: number;
        verified: boolean | null;
    };
    /**
     * Git trailer lines encoding a commit's attribution, for embedding in a
     * commit message so it travels with the commit itself (a lightweight
     * alternative to a bundle). Blackboard-namespaced — it does not hijack
     * `Co-Authored-By`.
     */
    trailersFor(rev: string): string[];
    /** Everything the board knows about a commit — the `explain` view. */
    explain(rev: string): {
        commit: git.CommitInfo | {
            sha: string;
        };
        attributions: Attribution[];
        reviews: Review[];
        decisions: Decision[];
        note: string | null;
    } | undefined;
    /** Which session introduced a line — Git blame → attribution. */
    blame(file: string, line: number): {
        sha: string;
        gitAuthor: string;
        attributions: Attribution[];
    } | undefined;
    /**
     * Blame → narrative: from a single line, trace back to the session that
     * introduced it and surface that session's whole story — what else it did,
     * the decisions it made, and the handoffs it left. Turns `git blame` into
     * "why does this line exist".
     */
    blameNarrative(file: string, line: number): {
        sha: string;
        gitAuthor: string;
        attributions: Attribution[];
        session: Session | null;
        sessionTimeline: TimelineEvent[];
        decisions: Decision[];
        handoffs: Handoff[];
    } | undefined;
    /** Aggregate metrics for a scorecard: coverage, AI/human ratio, per-agent. */
    /** With a project key, returns the three-level aggregation instead (a DIFFERENT shape). */
    report(projectKey?: string | null): Report | ProjectReport | undefined;
    private reportSnapshot;
    /** Stamp a session's liveness. Cheap; not recorded on the timeline. */
    heartbeat(sessionId?: string): Session | undefined;
    /** Open sessions whose heartbeat is within `withinMs` — genuinely active. */
    activeSessions(withinMs?: number): Session[];
    /**
     * Other active sessions that recorded a change to the same file — real-time
     * collision awareness (two live agents editing one file), a step beyond the
     * same-task conflict surfaced by `fileChanged`.
     */
    activeEditorsOfFile(file: string, excludeSession: string | null, withinMs?: number): {
        sessionId: string;
        agent: string;
    }[];
    /**
     * Delete potentially-sensitive, bulky rows (messages, evidence, file-change
     * records) created before a horizon. The append-only timeline is NEVER pruned
     * — it is the audit trail — so pruning is recorded as one `prune` event.
     */
    prune(beforeIso: string): {
        messages: number;
        evidence: number;
        filesChanged: number;
    };
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
    redact(seq: number, reason?: string | null): boolean;
    /** Seqs that have been redacted, with their reason. */
    private redactionMap;
    /** Apply the redaction overlay to a set of events (content → tombstone). */
    private applyRedactions;
    /**
     * Record a batch of normalized ingest events (from a transcript adapter)
     * under the acting agent and active session, then append one `ingest`
     * summary event. Each file/decision/note is attributed like any other write.
     */
    ingest(events: IngestEvent[]): {
        files: number;
        decisions: number;
        notes: number;
    };
    status(forAgent?: string): BoardStatus;
    /**
     * Run a read-only function inside a single SQLite snapshot so every query it
     * makes sees a consistent point-in-time view of the board. Nested calls (a
     * snapshot within a snapshot) reuse the outer one.
     */
    private readSnapshot;
    private allUnread;
}
//# sourceMappingURL=board.d.ts.map