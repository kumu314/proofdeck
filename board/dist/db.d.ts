import Database from "better-sqlite3";
/**
 * Open (creating if needed) the SQLite database that backs a blackboard and
 * apply the schema. The schema is idempotent (`IF NOT EXISTS`), so opening an
 * existing board is safe. WAL mode lets multiple agents read while one writes —
 * the common case when several CLIs share one board.
 */
export declare function openDb(dbPath: string): Database.Database;
//# sourceMappingURL=db.d.ts.map