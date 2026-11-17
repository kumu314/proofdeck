/**
 * Generate ready-to-paste MCP client configuration so any CLI can connect to
 * the blackboard with one step. The server is provider-independent and speaks
 * standard MCP over stdio, so the same command works everywhere; only the
 * config file format and location differ per client.
 */
export interface McpConfigOptions {
    /** Identity the server writes under (defaults to the client name). */
    agent?: string;
    /** Explicit board directory; omitted → the server discovers .octoboard/. */
    boardDir?: string;
    /** Use a local build path instead of the published npx bin (dev). */
    localEntry?: string;
}
export declare const MCP_CLIENTS: readonly ["json", "claude-code", "cursor", "codex", "gemini", "vscode", "windsurf"];
export type McpClient = (typeof MCP_CLIENTS)[number];
export interface McpConfigResult {
    /** Where the user should put this config. */
    path: string;
    /** The config text to paste. */
    content: string;
    /** Optional extra guidance. */
    note?: string;
}
export declare function mcpConfig(client: McpClient, opts?: McpConfigOptions): McpConfigResult;
//# sourceMappingURL=mcp-config.d.ts.map