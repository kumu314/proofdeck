import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BUNDLE_VERSION } from "./board.js";
const EMPTY = () => ({
    version: BUNDLE_VERSION,
    exportedAt: "",
    attributions: [],
    reviews: [],
    sessions: [],
    decisions: [],
});
/** Merge `incoming` into `base`, deduping by row id. Returns [merged, added]. */
function mergeById(base, incoming) {
    const merged = EMPTY();
    merged.exportedAt = incoming.exportedAt || base.exportedAt;
    const counts = {
        attributions: 0,
        reviews: 0,
        sessions: 0,
        decisions: 0,
    };
    for (const key of [
        "attributions",
        "reviews",
        "sessions",
        "decisions",
    ]) {
        const seen = new Set(base[key].map((r) => r.id));
        const out = [...base[key]];
        for (const row of incoming[key]) {
            if (!seen.has(row.id)) {
                seen.add(row.id);
                out.push(row);
                counts[key] += 1;
            }
        }
        merged[key] = out;
    }
    return [merged, counts];
}
/** A shared JSON bundle file — e.g. on a network drive. */
export class FileSyncTarget {
    path;
    constructor(path) {
        this.path = path;
    }
    read() {
        if (!existsSync(this.path)) {
            return EMPTY();
        }
        try {
            const parsed = JSON.parse(readFileSync(this.path, "utf8"));
            return { ...EMPTY(), ...parsed };
        }
        catch {
            return EMPTY();
        }
    }
    async push(bundle) {
        const [merged, counts] = mergeById(this.read(), bundle);
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(this.path, JSON.stringify(merged, null, 2), "utf8");
        return counts;
    }
    async pull() {
        return this.read();
    }
    async close() {
        /* nothing to close */
    }
}
/**
 * A Postgres team board. Records are stored one-row-per-record with a JSONB
 * `data` column keyed by id, so the sync store never has to track the
 * blackboard's evolving column set. Requires the optional `pg` dependency and a
 * reachable connection URL.
 */
export class PostgresSyncTarget {
    url;
    clientPromise = null;
    constructor(url) {
        this.url = url;
    }
    async client() {
        if (this.clientPromise) {
            return this.clientPromise;
        }
        this.clientPromise = (async () => {
            let pg;
            try {
                // Non-literal specifier: `pg` is an optional dependency, so it is
                // imported dynamically and typed loosely rather than resolved at build.
                const mod = "pg";
                pg = await import(mod);
            }
            catch {
                throw new Error("Postgres sync requires the optional 'pg' package: npm install pg");
            }
            const Client = pg.default?.Client ?? pg.Client;
            const client = new Client({ connectionString: this.url });
            await client.connect();
            for (const t of ["attributions", "reviews", "sessions", "decisions"]) {
                await client.query(`CREATE TABLE IF NOT EXISTS bb_${t} (id TEXT PRIMARY KEY, data JSONB NOT NULL)`);
            }
            return client;
        })();
        return this.clientPromise;
    }
    async push(bundle) {
        const client = await this.client();
        const counts = {
            attributions: 0,
            reviews: 0,
            sessions: 0,
            decisions: 0,
        };
        for (const key of [
            "attributions",
            "reviews",
            "sessions",
            "decisions",
        ]) {
            for (const row of bundle[key]) {
                const res = await client.query(`INSERT INTO bb_${key} (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [row.id, JSON.stringify(row)]);
                counts[key] += res.rowCount ?? 0;
            }
        }
        return counts;
    }
    async pull() {
        const client = await this.client();
        const bundle = EMPTY();
        for (const key of [
            "attributions",
            "reviews",
            "sessions",
            "decisions",
        ]) {
            const res = await client.query(`SELECT data FROM bb_${key}`);
            bundle[key] = res.rows.map((r) => typeof r.data === "string" ? JSON.parse(r.data) : r.data);
        }
        return bundle;
    }
    async close() {
        if (this.clientPromise) {
            const client = await this.clientPromise;
            await client.end();
        }
    }
}
/** Build a target from a spec: a `postgres://` URL, or else a file path. */
export function createSyncTarget(spec) {
    if (spec.startsWith("postgres://") || spec.startsWith("postgresql://")) {
        return new PostgresSyncTarget(spec);
    }
    return new FileSyncTarget(spec);
}
//# sourceMappingURL=sync.js.map