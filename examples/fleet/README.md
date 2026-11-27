# fleet example — a sanitized production deployment

This is a **sanitized snapshot of a real fleet config** that has run daily for
months (a personal multi-agent fleet, hundreds of tasks through the gate). The
values are real; names, paths, and faces are neutralized.

## What to look at

| Section | Why it matters |
|---|---|
| `runtime.autoAssign: true` | open tasks with an auto-flagged bridge fence queue to their face without a manual assign event |
| `runtime.maxConcurrentTotal: 2` | the whole fleet runs 2 agents at once — saturation is a choice, not an accident |
| `runtime.priority.agingMs: 7200000` | P3 tasks promote one lane every 2h of waiting — nothing starves |
| `runtime.retry` | exponential backoff, 30 min → 4 h cap, 2 attempts max, then human review |
| `runtime.supply` | provider-breaker: a face that burns its quota gets latched and probed, not hammered |
| `runtime.stall` | no-progress detection separates "thinking" from "stuck" (startup gets a longer budget) |
| `runtime.watchdog` | control-port liveness probe — a hung main loop with a live process gets caught |
| `runtime.judge` | LLM judge in acceptance-only mode; an unavailable judge skips without blocking |
| `gating` | auto-risk whitelist, impact blocking, forbidden-word list, secret redaction patterns |
| `agents.*.fallbacks` | a face that fails hands its lane to the next (capability routing) |

## Faces

Two faces, one adapter. The registry is adapter-based: any face that speaks the
same CLI contract plugs in as `lib/adapters/<name>.js` (the bundled `codex.js`
is the reference implementation — stdin prompts, JSONL events, per-run output
files). `second-cli` shows the shape of a disabled standby face with a
fallback chain.

## Real numbers, real behavior

- `maxConcurrentTotal: 2` — two agents in parallel is where review cost and
  machine load stay sane for a solo operator.
- `digest.everyMs: 21600000` — one owner digest per 6 h; all-empty digests skip
  silently and re-arm.
- `verify.enforce` (in the full config) and the judge's acceptance-only mode
  mean a task without acceptance criteria is flagged on every dispatch until it
  carries them.

## Adaptation notes

- Windows paths shown; on Linux swap to `/home/…` and the POSIX launcher.
- `CODEX_HOME` per face lets one machine mix account-quota faces (ChatGPT
  login) and API-key faces (custom providers like DeepSeek) without the two
  auth modes colliding.
- The `board.package` placeholder is filled by `proofdeck init` — point it at
  the packaged `board/` or a checkout.
