/**
 * Resolved configuration for a single blackboard. Local-first: the board is a
 * SQLite file under a `.octoboard/` directory, discovered by walking up from
 * the current working directory (like `.git`). A future Postgres sync backend
 * will plug in here behind `databaseUrl`.
 */
export interface AgentIdentity {
    /** Stable handle written to the board, e.g. "claude". */
    name: string;
    /** Free-form product/kind label, e.g. "claude-code". */
    kind: string | null;
    /** Vendor, e.g. "anthropic", "openai", "local". */
    provider: string | null;
    /** Model id, e.g. "claude-opus-4-8". */
    model: string | null;
    /** CLI / surface, e.g. "claude-code". */
    cli: string | null;
    /** Integration version. */
    version: string | null;
}
export interface BoardConfig {
    /** Directory holding the board (the `.octoboard/` folder). */
    boardDir: string;
    /** Absolute path to the SQLite database file. */
    dbPath: string;
    /** Identity this process writes under, e.g. "claude". */
    agent: string;
    /** Product/kind label for the agent, e.g. "claude-code". */
    agentKind: string | null;
    /** Full provider-independent identity for this agent. */
    identity: AgentIdentity;
    /** Active session id for this agent, if one is running. */
    sessionId: string | null;
}
/**
 * Walk up from `start` looking for an existing `.octoboard/` directory. Returns
 * the directory path if found, otherwise undefined.
 */
export declare function findBoardDir(start?: string): string | undefined;
/**
 * Resolve the board directory for read/write operations. Honors an explicit
 * override (`OCTOBOARD_DIR` or the `--board` flag), then an existing
 * `.octoboard/` up the tree. Falls back to `<cwd>/.octoboard` (the path
 * `init` will create).
 */
export declare function resolveBoardDir(explicit?: string): string;
export interface ConfigOverrides {
    boardDir?: string;
    agent?: string;
    agentKind?: string;
    provider?: string;
    model?: string;
    cli?: string;
    version?: string;
}
export declare function loadConfig(overrides?: ConfigOverrides): BoardConfig;
//# sourceMappingURL=config.d.ts.map