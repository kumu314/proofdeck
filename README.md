<p align="center">
  <img src="docs/assets/logo.svg" width="150" alt="ProofDeck logo">
</p>

# ProofDeck

**A verification-first task board and orchestrator for coding-agent fleets.**

Agents claim done. ProofDeck demands proof.

[![CI](https://github.com/kumu314/proofdeck/actions/workflows/ci.yml/badge.svg)](https://github.com/kumu314/proofdeck/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
![node](https://img.shields.io/badge/node-%E2%89%A522.5-green.svg)

![A fake "done" — count=1 where the acceptance said ≥3 — gets rejected by the real verify engine](docs/assets/demo.gif)

> `board/` 目录内含 [octopus-blackboard](https://github.com/octoryn/octopus-blackboard)（Apache-2.0）的修改版发行，见 [NOTICE](./NOTICE)。中文说明：[README.zh-CN.md](./README.zh-CN.md)。

## Why

If you run one coding agent (Claude Code, Codex CLI, Gemini CLI, …) you review everything it does, and review works. The moment you run **several** agents in parallel, review becomes the bottleneck — and two failure modes compound:

- **False affirmatives.** The agent adds a fallback so the code "works", tests pass, and the flaw ships anyway. The industry has a name for the general problem: *reward hacking* — it is now an active research topic (ImpossibleBench, 2025; Anthropic's work on emergent misalignment from reward hacking, 2026).
- **Silent death.** An agent stalls, exits 0 with nothing done, or burns its budget on a dead-end loop. Nobody notices until the deadline.

ProofDeck's answer is to make **acceptance criteria a first-class column on every task** and to refuse "done" that lacks evidence:

1. Every task carries machine-checkable acceptance criteria.
2. On completion, a fail-closed verification engine runs them (file existence, occurrence counts, JSON-path matches, reference existence — five check families).
3. An LLM judge reviews the trajectory against the criteria when machine checks are not enough; its verdict lands in an **append-only sha256 hash chain** next to who claimed the task, who verified it, and when.
4. Tasks that fail are retried with backoff, parked for human review, or routed to a different agent by capability — never silently marked done.

Around that gate, ProofDeck runs the fleet: a shared SQLite-backed blackboard with MCP surface, priority lanes with aging, automatic retry with a supply breaker, SLA due-dates, digest emails, full event replay (time travel), and OpenTelemetry-style spans.

## Status

`v0.1.0-preview`. Battle-tested in daily production use (a personal multi-agent fleet; hundreds of tasks) **on Windows**. The POSIX layer is new and marked **beta**: CI runs the test matrix on ubuntu as well, but real-world macOS/Linux mileage is thin — expect rough edges and please report them.

## Quick start

```bash
npx proofdeck init        # scaffold: daemon.config.json + .proofdeck/ + control.token
# edit daemon.config.json — point agents.codex.script at a CLI you have
npx proofdeck daemon      # start the daemon (board + control plane + scheduler)
npx proofdeck status      # board head, task counts, acceptance coverage
```

From a git checkout instead of npm:

```bash
git clone https://github.com/kumu314/proofdeck && cd proofdeck && npm install
node bin/proofdeck.js init && node bin/proofdeck.js daemon
```

Any agent that speaks MCP can read/write the board (tasks, notes, messages, verification events).

## Architecture

```
                       ┌───────────────────────────────────────────┐
                       │                ProofDeck                  │
  human ──define──────▶│  daemon: claim → run face → verify gate   │
  agents ◀──MCP────────│          │                                │
  (CLI faces)  ──run──▶│          ├─ V1 checks (fail-closed)       │
                       │          ├─ V1.5 LLM judge               │
                       │          ├─ retry / breaker / routing    │
                       │          ▼                                │
                       │  blackboard: SQLite WAL + append-only     │
                       │  sha256 hash chain (tasks, notes, verify  │
                       │  events, messages — tamper-evident)       │
                       └───────────────────────────────────────────┘
```

- **board/** — vendored, modified distribution of octopus-blackboard: the shared task board with an append-only hash chain, MCP surface, and the acceptance/verification schema.
- **lib/** — verification engine (`verify.js`), LLM judge (`judge.js`), scheduling core with priority aging and retry policy (`schedule.js`), capability routing (`caps.js`), event replay (`replay.js`), spans, digest, leases, supply breaker.
- **Adapters** — each agent face is one small module (`lib/adapters/`); a generic CLI adapter (`codex.js`) is the reference implementation. Prompts are fed via stdin, never argv — long CJK text corrupts through some shells (a real cross-platform lesson from production).

## Design principles

- **Fail closed.** A task without acceptance criteria is not silently accepted — it is flagged, every dispatch, until it has them.
- **Evidence over vibes.** Verification results are events in a hash chain, not chat messages.
- **The board is the truth.** Agents come and go; the append-only timeline remembers.
- **Boring storage.** One SQLite file per deployment. `node:sqlite` natively, `better-sqlite3` as fallback (`OCTOBOARD_BACKEND=better-sqlite3`).

## Testing

15 end-to-end suites (verification, anti-fraud, judge, scheduling, resilience, replay, SLA/digest, …) run against real boards:

```bash
node e2e/verify-verify-firstclass.mjs   # naming: verify-<topic>.mjs, see e2e/
```

## Contributing & security

Contribution guide in [CONTRIBUTING.md](./CONTRIBUTING.md) — PRs need CI green
and evidence, same as our agents. Security disclosures via
[SECURITY.md](./SECURITY.md) (private reporting, 7-day response). Releases are
tagged; see [CHANGELOG.md](./CHANGELOG.md).

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE) — this project includes a modified distribution of [octopus-blackboard](https://github.com/octoryn/octopus-blackboard) by Ran Tao / octoryn.
