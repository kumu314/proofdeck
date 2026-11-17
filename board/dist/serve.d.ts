import { type Server } from "node:http";
import type { Board } from "./board.js";
/**
 * A read-only local web dashboard for a board. Dependency-free (`node:http`),
 * serves a self-contained HTML page plus a small JSON API. Strictly read-only:
 * non-GET requests are refused, and there are no mutation endpoints — the
 * dashboard observes the board, it never changes it.
 */
export declare function serve(board: Board, port: number, host?: string): Server;
//# sourceMappingURL=serve.d.ts.map