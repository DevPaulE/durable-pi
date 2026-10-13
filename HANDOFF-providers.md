# HANDOFF — Durable Pi provider integration

State of record for this build. A fresh session should be able to read this file alone and know
the mission, what is proven, what is open, and the next safe action.

**Branch:** `wo-provider-integrations`
**Worktree:** `~/Projects/durable-pi-worktrees/provider-integrations`
**Base:** `37165c6` (Dan's upstream fork point)
**Commits:** `57ffb21` (RED anchor) → `6ccaf37` (implementation, green)
**Status:** Phase 1 complete and verified. Phase 2 not started. Nothing deployed. No credentials used.

## Mission

Let a Durable Pi device run an explicitly chosen model provider — Faux, OpenRouter, Radius, or
Ollama Cloud — instead of being hard-wired to Faux or OpenRouter. Faux stays the default for
offline work. Verification belongs to Paul; this file does not grade its own work.

## Why this exists

`DPI_PROVIDER` was silently coerced before this branch:

```
DPI_PROVIDER=nope   -> "openrouter"
DPI_PROVIDER=ollama -> "openrouter"
```

Any unknown or unimplemented value became OpenRouter. That is why an unimplemented provider could
look supported without being supported.

## What is proven (run these yourself)

```bash
cd ~/Projects/durable-pi-worktrees/provider-integrations/apps/dpi-backend
npm ci                # first time in a fresh worktree
npx tsx --test tests/providers.test.ts tests/store.test.ts tests/api.test.ts
npm run check
```

Result on 2026-10-12: **11/11 tests pass**, `tsc --noEmit` clean.

Specifically:

- An unknown `DPI_PROVIDER` now throws (`config.ts`), naming the accepted values.
- `faux` and `openrouter` behave exactly as before; the pre-existing store/api suites are untouched and green.
- The Ollama Cloud catalog fetch is tested against a **local stub server**, not the real endpoint:
  the bearer key is sent, ids map to `ollama` models on `openai-completions`, a non-200 fails
  loudly, and an empty catalog is an error rather than a silent empty list.

## Files

| Path | What it does |
|---|---|
| `apps/dpi-backend/src/providers.ts` | Provider ids, `parseProvider`, Ollama catalog fetch, `registerProvider`, `modelInfos`, `defaultModelFor` |
| `apps/dpi-backend/src/config.ts` | `DPI_PROVIDER` parsed through `parseProvider` — refuse, never default |
| `apps/dpi-backend/src/store.ts` | Registers the chosen provider; provider-aware model listing, routing and validation |
| `apps/dpi-backend/tests/providers.test.ts` | The RED anchor plus the new tests |

## What is NOT proven — read this before believing anything

- **No real provider call has ever been made.** Every test uses a local stub. OpenRouter, Radius and
  Ollama Cloud have not been contacted.
- **Ollama Cloud model names are not verified.** The provider reads them from the endpoint at
  runtime. No hardcoded list was invented.
- **The Ollama context window is assumed**, not measured — `OLLAMA_ASSUMED_CONTEXT_WINDOW = 32768`,
  because the catalog endpoint does not report one. Treat it as a floor.
- **Radius has not been exercised at all.** It is registered through pi-ai's built-in provider; its
  OAuth/API-key path is untested here.
- **Nothing is deployed.** M6 still runs Faux from the frozen checkout. Serving from this branch is
  a separate, explicit decision.
- **No credential has been read, copied, or printed.** `~/.pi/agent/auth.json` was never opened.

## Next safe action

**Paul's gate:** choose one provider and its credential path, then decide whether to serve this
branch to a device. Two options, and the first needs no new code:

1. **OpenRouter — already implemented, no new code.** Add `OPENROUTER_API_KEY` to the Durable Pi
   `.env` (Paul's hands; Aria never reads the value), list it in `dpi-network.yaml` `env_keys`, and
   set that device's `DPI_PROVIDER=openrouter`. `just net up <id>` re-provisions.
2. **Ollama Cloud — this branch.** Same shape with `OLLAMA_API_KEY` and `DPI_PROVIDER=ollama`.

Until then the device offers no model and creation fails loudly, which is the intended fail-closed
behaviour.

## Boundaries

- Foundry is a no-write zone (53 uncommitted entries; WO-041 in flight). This is a **local** scope,
  not a formal Foundry EWO, and nothing here authorizes edits there.
- Do not bind to `0.0.0.0`; do not expose a public port; Tailscale is the access boundary.
- Do not read or copy `.env` or credential files. Names only, never values.
- Do not switch M6 away from Faux, install a model, or make a real provider call without Paul's
  explicit go for that specific action.
- Discarding this work: `git worktree remove ~/Projects/durable-pi-worktrees/provider-integrations`
  and `git branch -D wo-provider-integrations`. Confirm with Paul first — it is reversible only by
  re-creating the branch from the commits above.

## Phase 2 — not started

The synthetic event → classifier → durable task → Ready-for-Review proof. Deferred until a
permitted model/classifier path is configured. The existing `apps/proactive-dpi-demo` is the
reference, and it is a loopback-only mock whose agent shell is unsandboxed.
