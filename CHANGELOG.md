# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning:
[SemVer](https://semver.org/).

## [0.1.2] — 2026-11-28

### Changed

- **The judge is blind to prior results.** The V1.5 judge prompt no longer
  tells the reviewer that machine checks passed — any "everything before you
  passed" signal is a leniency prior, and this gate exists to catch false
  affirmatives. The machine/judge division of labor is unchanged; the judge
  just isn't told the machine verdict anymore. Guarded by a new e2e
  invariant (J2d).
- Docs: the design principle "ceremony scales with blast radius" is now named
  in both READMEs alongside the others (implemented via gate risk tiers).

### Changed

- **The judge is blind to prior results.** The V1.5 judge prompt no longer
  tells the reviewer that machine checks passed — any "everything before you
  passed" signal is a leniency prior, and this gate exists to catch false
  affirmatives. The machine/judge division of labor is unchanged; the judge
  just isn't told the machine verdict anymore. Guarded by a new e2e
  invariant (J2d).

## [0.1.1] — 2026-11-21

### Added

- Brand assets: `docs/assets/logo.svg` + rendered PNGs, GitHub social preview.
- `docs/task-book.md` — task-book format guide: fence fields, lifecycle, and
  dogfood-tested gotchas (inline fence parked, ChatGPT-account mode vs custom
  providers, Windows sandbox defaults).
- Commercial-grade README restructure (English + Chinese mirror).

### Changed

- `init` probes a free control port instead of assuming 8790 (a fixed port
  collided with any other ProofDeck on the machine), creates per-face
  workdirs and `briefs/` with a starter pointer-style task book, and gains an
  `assign <key> <agent>` command.
- `autoAssign` (default on): open tasks carrying an auto-flagged bridge fence
  queue to their face without a manual assign event.
- Face workdirs are normalized to absolute at config load (relative paths
  resolved twice through the spawn chain and died with os error 3).
- README quick start now teaches the task-book step (pointer + fence).

## [0.1.0] — 2026-11-17

First public release. Battle-tested in daily production use on Windows; POSIX
validated on Linux (13/13 suites) and covered by the CI matrix.

### Added

- **Verification-first task board** — `acceptance` as a first-class column;
  fail-closed V1 checks (fileExists / countAtLeast / countOccurrences /
  countMatches / referencesExist); unknown check types are FAIL, never skip.
- **LLM judge (V1.5)** — trajectory review against acceptance when machine
  checks are insufficient; verdicts recorded in the hash chain; unavailable
  judges fail open without blocking the fleet.
- **Append-only sha256 evidence chain** — tasks, notes, messages, verify
  events; tamper-evident with head anchoring and `verifyChain()`.
- **Fleet orchestration** — claim → run face → verify gate → write-back;
  priority lanes with aging; automatic retry with backoff and a supply
  breaker; capability routing (`needs` × face capabilities); SLA due-dates;
  owner digest.
- **Observability** — full event replay (time travel to any seq), OpenTelemetry-
  style spans, per-run usage ledger.
- **MCP surface** — any MCP-speaking agent can read/write the board.
- **Dual SQLite backend** — native `node:sqlite` preferred, `better-sqlite3`
  fallback (`OCTOBOARD_BACKEND=better-sqlite3`); zero native deps on Node ≥22.5.
- **Cross-platform process primitives** — `lib/platform.js` (killTree /
  getProcessInfo); Windows production-proven, Linux CI-validated.
- **CLI** — `proofdeck init / daemon / status` (`npx proofdeck init`).
- **CI** — Windows/ubuntu × native/better-sqlite3 matrix; the native cell
  installs with `--omit=optional` to prove zero-native-dependency installs.
- **Docs** — demo GIF rendered from an actual verify-engine run (no fabricated
  output); attribution for the vendored octopus-blackboard fork.

[0.1.0]: https://github.com/kumu314/proofdeck/releases/tag/v0.1.0
