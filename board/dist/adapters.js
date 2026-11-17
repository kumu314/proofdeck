function changeFromToolName(name) {
    const n = name.toLowerCase();
    if (/delete|remove|rm\b/.test(n))
        return "deleted";
    if (/write|create|add/.test(n))
        return "added";
    return "modified";
}
const EDIT_TOOL_RE = /edit|write|patch|create|apply|delete|remove/i;
/**
 * Recursively collect file-edit events from an arbitrary parsed JSON value.
 * `file_path` and `notebook_path` are treated as unambiguous edit targets; a
 * bare `path` only counts under an edit/write/patch tool. The enclosing tool
 * name is threaded down (`ctxTool`) because a transcript typically nests the
 * path inside an `input`/`args` object one level below the tool name — so the
 * change kind must be derived from the ancestor, not the leaf.
 */
const MAX_DEPTH = 200;
function collectFileEdits(value, out, ctxTool = "", depth = 0) {
    // Bound recursion so a pathologically-nested (attacker-influenced) transcript
    // cannot overflow the stack.
    if (depth > MAX_DEPTH) {
        return;
    }
    if (Array.isArray(value)) {
        for (const v of value)
            collectFileEdits(v, out, ctxTool, depth + 1);
        return;
    }
    if (value === null || typeof value !== "object") {
        return;
    }
    const obj = value;
    const localTool = [obj.name, obj.tool, obj.type, obj.function]
        .filter((v) => typeof v === "string")
        .join(" ");
    // Prefer a tool-shaped local name; otherwise keep the ancestor's.
    const toolName = EDIT_TOOL_RE.test(localTool) ? localTool : ctxTool;
    const change = changeFromToolName(toolName);
    for (const key of ["file_path", "notebook_path"]) {
        if (typeof obj[key] === "string" && obj[key].length > 0) {
            out.set(obj[key], change);
        }
    }
    if (EDIT_TOOL_RE.test(toolName) &&
        typeof obj.path === "string" &&
        obj.path.length > 0) {
        out.set(obj.path, change);
    }
    for (const v of Object.values(obj)) {
        collectFileEdits(v, out, toolName, depth + 1);
    }
}
/** Parse JSONL lines tolerantly, skipping blank/malformed lines. */
function parseJsonl(content) {
    const out = [];
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0)
            continue;
        try {
            out.push(JSON.parse(trimmed));
        }
        catch {
            /* skip malformed line */
        }
    }
    return out;
}
/** The tool-use JSONL heuristic shared by real-CLI adapters. */
function heuristicAdapter(name) {
    return {
        name,
        parse(content) {
            const edits = new Map();
            for (const entry of parseJsonl(content)) {
                collectFileEdits(entry, edits);
            }
            return [...edits.entries()].map(([path, change]) => ({
                type: "file",
                path,
                change,
            }));
        },
    };
}
/** Our normalized schema: JSON `{events:[...]}`, a bare array, or JSONL. */
export const genericAdapter = {
    name: "generic",
    parse(content) {
        const isEvent = (e) => typeof e === "object" &&
            e !== null &&
            (e.type === "file" ||
                e.type === "decision" ||
                e.type === "note");
        const trimmed = content.trim();
        let raw;
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed))
                raw = parsed;
            else if (parsed && Array.isArray(parsed.events))
                raw = parsed.events;
            else
                raw = [parsed];
        }
        catch {
            raw = parseJsonl(trimmed); // fall back to JSONL of events
        }
        return raw.filter(isEvent);
    },
};
const REGISTRY = {
    generic: genericAdapter,
    "claude-code": heuristicAdapter("claude-code"),
    codex: heuristicAdapter("codex"),
    gemini: heuristicAdapter("gemini"),
    grok: heuristicAdapter("grok"),
};
export const ADAPTERS = Object.keys(REGISTRY);
export function getAdapter(name) {
    return REGISTRY[name];
}
//# sourceMappingURL=adapters.js.map