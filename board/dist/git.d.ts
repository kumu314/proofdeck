export declare function isRepo(cwd?: string): boolean;
export declare function repoRoot(cwd?: string): string | undefined;
export declare function currentBranch(cwd?: string): string | undefined;
export declare function remoteUrl(cwd?: string): string | undefined;
/** Resolve any revision (HEAD, a tag, short sha) to a full commit sha. */
export declare function resolveRev(rev: string, cwd?: string): string | undefined;
/**
 * List commit shas in a revision range (e.g. `main..HEAD`), newest first.
 * `--end-of-options` blocks flag injection via a dashed range.
 */
export declare function revList(range: string, cwd?: string): string[];
export interface CommitInfo {
    sha: string;
    author: string;
    authorEmail: string;
    date: string;
    subject: string;
}
export declare function commitInfo(rev: string, cwd?: string): CommitInfo | undefined;
/** Files touched by a commit (paths relative to the repo root). */
export declare function filesInCommit(rev: string, cwd?: string): string[];
/** Distinct Git authors that have touched a file (from `git log`). */
export declare function fileAuthors(file: string, cwd?: string): string[];
/** Resolve which commit last modified a specific line — `git blame -L`. */
export declare function blameLine(file: string, line: number, cwd?: string): {
    sha: string;
    author: string;
} | undefined;
/**
 * Append attribution as a Git note under `refs/notes/blackboard`. Notes are
 * additive: they never alter the commit or its sha. Returns true on success.
 */
export declare function writeNote(rev: string, note: string, cwd?: string): boolean;
export declare function readNote(rev: string, cwd?: string): string | undefined;
//# sourceMappingURL=git.d.ts.map