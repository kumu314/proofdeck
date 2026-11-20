# Task books — how ProofDeck reads your tasks

A ProofDeck task has two halves:

1. **The card** on the board — title + a **pointer** to the task book file.
2. **The task book file** (under `briefs/`) — the actual instruction text plus a
   ```bridge fence carrying the dispatch metadata.

Why a file? The gating layer evaluates the book's content (risk words, sandbox
requests, auto flags) before dispatch, and the file is what gets archived with
the run for audit. Inline descriptions are treated as pointers only.

## Format

```markdown
<instruction text for the agent>

```bridge
{ "auto": "yes", "risk": "low", "impact": "low" }
```
```

The fence fields:

| Field | Meaning |
|---|---|
| `auto` | `"yes"` → the gate may dispatch automatically (risk words still apply) |
| `risk` | `low` / `medium` / `high` / `critical` — must be in `gating.autoRisk` for auto dispatch |
| `impact` | metadata; `high`/`critical` hits `gating.blockImpact` |
| `agent` | optional — pin the task to a specific face (otherwise first enabled face / autoAssign) |
| `priority` | optional — `P0`…`P3` lane priority |
| `acceptance` | optional — inline acceptance override (otherwise the card's `acceptance` column is used) |
| `sandbox` | optional — override the face sandbox for this task (`danger` requires approval) |

## Lifecycle

1. `proofdeck init` scaffolds `briefs/` with a starter task book.
2. Write the book, then put the pointer on a card:
   `description: "任务书：D:/path/to/briefs/my-task.md"`
3. Dispatch it: `proofdeck assign my-task codex` — or just leave it open;
   `autoAssign` (default on) queues auto-flagged books automatically.
4. The gate runs: risk words → auto/ask/soft; the face executes; the verify
   engine checks acceptance; the verdict lands in the hash chain.

## Gotchas (dogfood-tested)

- **No fence → parked.** A book without a ```bridge fence is parked with
  "未找到可读的任务书文件" — the gate refuses to guess your intent.
- **Relative `workdir` dies twice.** Face workdirs are resolved against the
  daemon BASE at load; the agent's own `-C` resolves again inside the workdir —
  use absolute paths (init normalizes them for you).
- **Codex faces need API-key mode for custom providers.** ChatGPT-account auth
  only serves OpenAI models. Give a face its own `CODEX_HOME` with
  `preferred_auth_method = "apikey"` + a DeepSeek/magpie provider to mix
  account-quota and API-quota faces on one machine.
- **Windows sandbox blocks shell writes by default.** For tasks that must run
  shell commands, set the face `sandbox` accordingly (`workspace-write` allows
  workspace writes; anything broader is gated).
