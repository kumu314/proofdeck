import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const BOARD_DIRNAME = ".octoboard";
const DB_FILENAME = "board.db";
/**
 * Walk up from `start` looking for an existing `.octoboard/` directory. Returns
 * the directory path if found, otherwise undefined.
 */
export function findBoardDir(start = process.cwd()) {
    let dir = resolve(start);
    for (;;) {
        const candidate = join(dir, BOARD_DIRNAME);
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return candidate;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
}
/**
 * Resolve the board directory for read/write operations. Honors an explicit
 * override (`OCTOBOARD_DIR` or the `--board` flag), then an existing
 * `.octoboard/` up the tree. Falls back to `<cwd>/.octoboard` (the path
 * `init` will create).
 */
export function resolveBoardDir(explicit) {
    const override = explicit ?? process.env.OCTOBOARD_DIR;
    if (override && override.length > 0) {
        return resolve(override);
    }
    return findBoardDir() ?? join(process.cwd(), BOARD_DIRNAME);
}
/**
 * Content generation of this dist: first 12 hex of a sha256 over sorted
 * "name:sha256" of every .js loaded from this directory. Needed because the
 * version strings have decoupled from the bytes here (package.json says 0.3.1,
 * `cli.js -V` prints 0.2.4, and dist is patched without either being bumped).
 * Memoized per process; returns null instead of throwing so identity stamping
 * can never break a board write.
 */
let epochCache;
function distEpoch() {
    if (epochCache !== undefined)
        return epochCache;
    try {
        const dir = dirname(fileURLToPath(import.meta.url));
        const canon = readdirSync(dir)
            .filter((n) => n.endsWith(".js") && !n.includes(".bak"))
            .sort()
            .map((n) => `${n}:${createHash("sha256").update(readFileSync(join(dir, n))).digest("hex")}`)
            .join("\n");
        epochCache = createHash("sha256").update(canon).digest("hex").slice(0, 12);
    }
    catch {
        epochCache = null;
    }
    return epochCache;
}
/**
 * Provider-independent identity from flags/env. Any AI CLI can populate these
 * with minimal integration; none are required beyond a name.
 */
function resolveIdentity(overrides) {
    const env = process.env;
    const kind = overrides.agentKind ??
        env.OCTOBOARD_AGENT_KIND ??
        env.OCTOBOARD_CLI ??
        null;
    return {
        name: overrides.agent ?? env.OCTOBOARD_AGENT ?? "anon",
        kind,
        provider: overrides.provider ?? env.OCTOBOARD_PROVIDER ?? null,
        model: overrides.model ?? env.OCTOBOARD_MODEL ?? null,
        cli: overrides.cli ?? env.OCTOBOARD_CLI ?? kind,
        version: overrides.version ?? env.OCTOBOARD_VERSION ?? distEpoch(),
    };
}
export function loadConfig(overrides = {}) {
    const boardDir = resolveBoardDir(overrides.boardDir);
    const identity = resolveIdentity(overrides);
    return {
        boardDir,
        dbPath: join(boardDir, DB_FILENAME),
        agent: identity.name,
        agentKind: identity.kind,
        identity,
        // An explicit env override wins; otherwise the Board resolves the agent's
        // active session transactionally from the DB's current_sessions table.
        sessionId: process.env.OCTOBOARD_SESSION && process.env.OCTOBOARD_SESSION.length > 0
            ? process.env.OCTOBOARD_SESSION
            : null,
    };
}
//# sourceMappingURL=config.js.map