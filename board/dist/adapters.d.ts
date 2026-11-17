import type { FileChangeKind } from "./types.js";
/**
 * Transcript ingestion adapters. An adapter turns a CLI's session transcript
 * into normalized ingest events the board can record under the active session —
 * so file edits, decisions, and notes flow onto the board with minimal
 * integration, without each CLI having to call the API directly.
 *
 * Two reliable paths ship:
 *   - `generic`: our own normalized schema (JSON `{events:[...]}` or JSONL of
 *     events). This is the stable integration path for ANY CLI — normalize the
 *     transcript to this shape and it just works.
 *   - a permissive tool-use JSONL heuristic used by `claude-code`, `codex`,
 *     `gemini`, and `grok`: it scans JSONL for file-editing tool calls
 *     (file_path / notebook_path, or a `path` beside an edit/write/patch tool).
 *
 * The heuristic is deliberately conservative and best-effort; as each CLI's
 * format stabilizes, promote it to a dedicated parser. Provider-independent by
 * design — no assumptions beyond "a transcript mentions files it edited".
 */
export type IngestEvent = {
    type: "file";
    path: string;
    change: FileChangeKind;
} | {
    type: "decision";
    title: string;
    rationale?: string;
} | {
    type: "note";
    text: string;
};
export interface Adapter {
    name: string;
    parse(content: string): IngestEvent[];
}
/** Our normalized schema: JSON `{events:[...]}`, a bare array, or JSONL. */
export declare const genericAdapter: Adapter;
export declare const ADAPTERS: string[];
export declare function getAdapter(name: string): Adapter | undefined;
//# sourceMappingURL=adapters.d.ts.map