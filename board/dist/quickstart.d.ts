/**
 * Zero-config onboarding for the blackboard — the single command that makes it
 * the easiest entry point of the stack. `octoboard quickstart` initializes a
 * board in the cwd (if absent), detects which MCP client you are running from
 * the surrounding files, prints a ready-to-paste config snippet, and (unless
 * told not to) proves the board works with one write + one read.
 *
 * This module is purely additive. It does not touch board logic or storage: it
 * reuses the real init path (`Board`), the real board discovery (`config.ts`),
 * and the real config generator (`mcp-config.ts`). Everything here is
 * idempotent and safe to re-run — it never clobbers an existing board or DB.
 */
import { mcpConfig, type McpClient } from "./mcp-config.js";
/** An MCP client we can auto-detect from files in the working tree. */
export interface DetectedClient {
    /** The `mcp-config` client id to generate a snippet for. */
    client: McpClient;
    /** Human-facing label, e.g. "Claude Code". */
    label: string;
    /** The marker path (relative to cwd) that gave it away, if any. */
    marker: string | null;
}
/**
 * Detect the MCP client from the environment by looking for the marker files a
 * client leaves in a project (`.claude/` → Claude Code, `.cursor/` → Cursor,
 * …). Falls back to the generic JSON snippet when nothing matches. Pure: it
 * only reads `cwd`, so a test can point it at a fixture directory.
 */
export declare function detectClient(cwd?: string): DetectedClient;
export interface QuickstartOptions {
    /** Where to init / detect from. Defaults to `process.cwd()`. */
    cwd?: string;
    /** Force a specific client instead of auto-detecting. */
    client?: McpClient;
    /** Identity the connected client writes under (defaults to the client id). */
    agent?: string;
    /** Skip the one-write + one-read proof step. */
    noProbe?: boolean;
    /** Use a local build path instead of the published npx bin (dev). */
    localEntry?: string;
}
export interface QuickstartResult {
    /** The `.octoboard/` directory that now holds the board. */
    boardDir: string;
    /** Absolute path to the SQLite database. */
    dbPath: string;
    /** True when this run created the board; false when one already existed. */
    created: boolean;
    /** The detected (or forced) client and how it was found. */
    detected: DetectedClient;
    /** Where to paste the snippet + the snippet itself. */
    config: ReturnType<typeof mcpConfig>;
    /** The write+read proof, unless it was skipped. */
    probe: {
        seq: number;
        agents: string[];
        chainOk: boolean;
    } | null;
}
/**
 * Run the zero-config quickstart. Idempotent: initializes `.octoboard/` only if
 * absent (reusing the real `Board` init path), never overwrites an existing
 * board or DB. Returns a structured result so callers (CLI, tests) can render
 * or assert on it.
 */
export declare function runQuickstart(opts?: QuickstartOptions): QuickstartResult;
/** True if `<dir>` already contains an initialized board DB. */
export declare function boardExistsAt(dir: string): boolean;
/**
 * Render a quickstart result as the human-facing terminal output: what was
 * initialized, the paste-ready snippet, the 3-line "paste → reload → done"
 * guide, and the proof line.
 */
export declare function renderQuickstart(r: QuickstartResult): string;
//# sourceMappingURL=quickstart.d.ts.map