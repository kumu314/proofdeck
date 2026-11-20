# Contributing to ProofDeck

Thanks for taking the time to contribute. This project has one strong opinion:
**agents claim done; ProofDeck demands proof.** Contributions are held to the
same standard.

## Development setup

```bash
git clone https://github.com/kumu314/proofdeck && cd proofdeck
npm install                # native cell — zero native module deps
npm test                   # 13 e2e suites against real boards (native backend)
```

Optional legacy backend:

```bash
npm install better-sqlite3
OCTOBOARD_BACKEND=better-sqlite3 npm test
```

Requirements: Node >= 22.5 (the `node:sqlite` native backend), Windows or Linux.
macOS should work (the POSIX layer is shared with Linux) but is less exercised —
if you hit an issue there, that is a valuable report on its own.

## How we review

Every change lands through a PR with CI green. Beyond that, three things get
special attention:

1. **Verification semantics.** Changes to `lib/verify.js`, the acceptance
   schema, or the judge must preserve the fail-closed contract: an unparseable
   check is a FAIL, not a skip; a missing `acceptance` is flagged, never silent.
2. **Evidence integrity.** Anything that writes to the hash chain (verify
   events, notes, task transitions) must remain append-only and hash-valid.
   `e2e/verify-schema-evolution.mjs` is the tripwire — it must stay green.
3. **Cross-platform honesty.** `lib/platform.js` owns every process-management
   primitive. Don't spawn `taskkill`/`powershell`/`ps` ad hoc in other modules;
   extend the platform primitive instead, and keep both paths tested
   (`e2e/verify-resilience.mjs` exercises guard confirmation through the
   primitive).

## Commit / PR conventions

- Branches: `feat/…`, `fix/…`, `docs/…`, `chore/…`.
- Commits: imperative mood, one logical change (`fix(verify): …`).
- PRs: describe what changed, what could break, and which suites you ran.
  Paste the tail of `node scripts/run-e2e.mjs` output — we read evidence here
  too.

## Reporting bugs

Open a [bug report](https://github.com/kumu314/proofdeck/issues/new?template=bug_report.yml)
with: OS + Node version, backend (native/better-sqlite3), minimal repro, and
the relevant log lines. Security issues go through
[SECURITY.md](./SECURITY.md), not the public tracker.

## License

By contributing you agree that your contributions are licensed under
[Apache-2.0](./LICENSE), same as the project.
