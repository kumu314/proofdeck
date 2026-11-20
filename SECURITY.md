# Security Policy

## Scope

ProofDeck runs processes on your machine, holds local credentials, and writes
an append-only evidence ledger. We treat the following as security issues:

- Anything that lets an unauthenticated caller reach the control plane
  (`lib/http.js`, `control.token` handling).
- Ways to bypass, disable, or forge the verification gate or hash chain
  (`lib/verify.js`, `board/dist` signing, `board.js` verify API).
- Credential leakage: tokens/API keys ending up in logs, transcripts, the
  state file, or the evidence ledger.
- Path traversal or command injection through task definitions, task
  descriptions, or acceptance-check paths.

## Reporting

Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**), or open a security advisory draft.
Please do not open a public issue for exploitable problems.

Include: affected version/commit, platform, minimal repro, and impact
assessment. We respond within 7 days and will credit reporters in the release
notes unless you prefer otherwise.

## Design notes for reviewers

- The control plane binds to `127.0.0.1` and requires a bearer token
  (`control.token`, generated on first boot). It is intentionally local-only.
- The vendored `board/` derives from octopus-blackboard (Apache-2.0); hash-chain
  and signing logic live there — see `board/docs/attribution.md`.
- `config.example.json` contains no credentials; `control.token` and
  `daemon.config.json` are git-ignored. Never commit real tokens — the CI
  native cell runs without any.
