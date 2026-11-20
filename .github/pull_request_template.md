## What changed

<!-- one paragraph: what this PR does -->

## Verification evidence

<!-- paste the tail of `node scripts/run-e2e.mjs` (and platform/backend info) -->

```
(paste output here)
```

## Break-risk

<!-- what could this break? verify semantics, hash chain, adapters, platform paths -->

## Checklist

- [ ] `npm test` green on my machine
- [ ] No tokens/credentials in logs or fixtures
- [ ] `e2e/verify-schema-evolution.mjs` still green (hash-chain tripwire)
- [ ] Platform-sensitive changes cover both win32 and posix paths
