/**
 * Generate ready-to-paste MCP client configuration so any CLI can connect to
 * the blackboard with one step. The server is provider-independent and speaks
 * standard MCP over stdio, so the same command works everywhere; only the
 * config file format and location differ per client.
 */
export const MCP_CLIENTS = [
    "json",
    "claude-code",
    "cursor",
    "codex",
    "gemini",
    "vscode",
    "windsurf",
];
function serverSpec(agent, opts) {
    const command = opts.localEntry ? "node" : "npx";
    const args = opts.localEntry
        ? [opts.localEntry]
        : ["-y", "octopus-blackboard-mcp"];
    const env = { OCTOBOARD_AGENT: agent };
    if (opts.boardDir) {
        env.OCTOBOARD_DIR = opts.boardDir;
    }
    return { command, args, env };
}
/** The standard `mcpServers` JSON block used by most clients. */
function mcpServersJson(spec) {
    return JSON.stringify({ mcpServers: { blackboard: spec } }, null, 2);
}
/** Codex uses TOML (`~/.codex/config.toml`). */
function codexToml(spec) {
    const argsToml = spec.args.map((a) => JSON.stringify(a)).join(", ");
    const envToml = Object.entries(spec.env)
        .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
        .join("\n");
    return [
        "[mcp_servers.blackboard]",
        `command = ${JSON.stringify(spec.command)}`,
        `args = [${argsToml}]`,
        "",
        "[mcp_servers.blackboard.env]",
        envToml,
    ].join("\n");
}
export function mcpConfig(client, opts = {}) {
    const agent = opts.agent ?? (client === "json" ? "claude" : client);
    const spec = serverSpec(agent, opts);
    switch (client) {
        case "claude-code":
            return {
                path: "<project>/.mcp.json  (or run: claude mcp add-json)",
                content: mcpServersJson(spec),
                note: "Project-scoped: commit .mcp.json to share the board with your team. Or user-scoped via `claude mcp add`.",
            };
        case "cursor":
            return {
                path: "~/.cursor/mcp.json  (or <project>/.cursor/mcp.json)",
                content: mcpServersJson(spec),
            };
        case "vscode":
            return {
                path: "<project>/.vscode/mcp.json",
                content: JSON.stringify({ servers: { blackboard: spec } }, null, 2),
                note: "VS Code uses a top-level `servers` key.",
            };
        case "windsurf":
            return {
                path: "~/.codeium/windsurf/mcp_config.json",
                content: mcpServersJson(spec),
            };
        case "gemini":
            return {
                path: "~/.gemini/settings.json  (merge the mcpServers key)",
                content: mcpServersJson(spec),
            };
        case "codex":
            return { path: "~/.codex/config.toml", content: codexToml(spec) };
        case "json":
        default:
            return {
                path: "your client's MCP config (mcpServers block)",
                content: mcpServersJson(spec),
                note: "Standard MCP stdio config — works with any MCP-compatible client.",
            };
    }
}
//# sourceMappingURL=mcp-config.js.map