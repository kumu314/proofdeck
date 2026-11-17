import { type AttributionBundle } from "./board.js";
/**
 * Team sync. A board stays local-first; a `SyncTarget` is a shared place
 * several boards push their attribution bundles to and pull each other's from.
 * Sync moves the portable, id-keyed records (attributions, reviews, sessions,
 * decisions) — never a board's private hash chain, which cannot merge. Merges
 * are idempotent (dedup by id).
 *
 * Two targets ship: a file (a JSON bundle on a shared drive — the reference,
 * fully tested) and Postgres (a team database — requires `pg` + a URL).
 */
export interface SyncCounts {
    attributions: number;
    reviews: number;
    sessions: number;
    decisions: number;
}
export interface SyncTarget {
    push(bundle: AttributionBundle): Promise<SyncCounts>;
    pull(): Promise<AttributionBundle>;
    close(): Promise<void>;
}
/** A shared JSON bundle file — e.g. on a network drive. */
export declare class FileSyncTarget implements SyncTarget {
    private readonly path;
    constructor(path: string);
    private read;
    push(bundle: AttributionBundle): Promise<SyncCounts>;
    pull(): Promise<AttributionBundle>;
    close(): Promise<void>;
}
/**
 * A Postgres team board. Records are stored one-row-per-record with a JSONB
 * `data` column keyed by id, so the sync store never has to track the
 * blackboard's evolving column set. Requires the optional `pg` dependency and a
 * reachable connection URL.
 */
export declare class PostgresSyncTarget implements SyncTarget {
    private readonly url;
    private clientPromise;
    constructor(url: string);
    private client;
    push(bundle: AttributionBundle): Promise<SyncCounts>;
    pull(): Promise<AttributionBundle>;
    close(): Promise<void>;
}
/** Build a target from a spec: a `postgres://` URL, or else a file path. */
export declare function createSyncTarget(spec: string): SyncTarget;
//# sourceMappingURL=sync.d.ts.map