# Durable Pi — provider status

**As of 2026-10-12.** This is a dated snapshot, not a live document. Re-check the repo before
treating anything here as current.

This file began as the build handoff for the provider-integration work order. That work is finished
and merged, so it now records **what is true**, and — just as importantly — what the original handoff
said that is no longer true, because agents read this file and act on it.

## Where things are

- **One checkout:** `~/Projects/durable-pi`, branch `main` at `67cb2a4`, pushed to `origin`.
  There is **no worktree any more** — `wo-provider-integrations` was fast-forwarded into `main` and
  the worktree was removed. Both branches remain as markers.
- **Deployed:** `local` (M1 Max) and `m6` (Mac mini) both run OpenRouter with **30 models**
  (29 OpenRouter + Faux Echo), default `anthropic/claude-sonnet-5.5`. `compass` (exe.dev) is the only
  Faux-only seat.
- **Both M1 seats are launchd services:** `dev.dpi.hub` (cockpit on `:4781`) and `dev.dpi.backend`
  (`:4780`). Both verified to restart themselves after `kill -9`.
- **Model selection is per device and per session.** `DPI_PROVIDER` sets the default for new
  sessions; `DPI_PROVIDERS` lists every provider the device registers, default first. **Faux is
  always registered**, so an existing Faux session is never silently re-pointed at a paid model.

## Corrections to the original handoff — do not act on the old claims

| The handoff said | Actually true now |
|---|---|
| "Nothing is deployed. M6 still runs Faux from the frozen checkout." | Both `local` and `m6` are deployed on OpenRouter with 30 models. |
| "No real provider call has ever been made." | A real call has been made: `anthropic/claude-sonnet-5.5`, 8 max tokens, returned `working`, 17+3 tokens. |
| "Worktree `~/Projects/durable-pi-worktrees/provider-integrations`" | Deleted. The branch is merged into `main`. |
| "11/11 tests pass" | Now **13/13** — two more tests pin the Faux-session protection. |
| "Next safe action: choose one provider." | Chosen and shipped twice. The next action is Phase 2. |

## What is proven

```bash
cd ~/Projects/durable-pi/apps/dpi-backend
npx tsx --test tests/providers.test.ts tests/store.test.ts tests/api.test.ts   # 13/13
npm run check                                                                 # tsc clean
```

- An unknown `DPI_PROVIDER` or `DPI_PROVIDERS` entry **throws**, naming the accepted values. It never
  silently becomes OpenRouter.
- Adding a remote provider does not re-point a stored Faux session; a Faux session reopened on an
  OpenRouter device keeps its own model.
- OpenRouter inference works end to end from the credential path.

## What is NOT proven

- **Radius has never been exercised.** Registered through pi-ai's built-in provider; its
  OAuth/API-key path is untested.
- **Ollama Cloud has never been contacted.** Its catalog is read from the endpoint at runtime and no
  list was invented; `OLLAMA_ASSUMED_CONTEXT_WINDOW = 32768` is a floor, not a measurement.
- **Full macOS reboot recovery is untested.** launchd agents start at *login*, so with FileVault on
  and no auto-login the post-reboot login is manual.
- **`rg` is absent from the agent's shell on both machines.** The backend's PATH comes from the
  generated plist; Pi's bundled ripgrep lives at `~/.pi/agent/bin/rg`, which is not on it. Agents
  that reach for `rg` get exit 127.
- **Trailing whitespace in `.env` values is not trimmed** by `localEnv`
  (`apps/dpi-sdk/src/node/drivers.ts:51`). Leading whitespace, CR and quotes are handled.

## Credential

One inference key, `OPENROUTER_API_KEY`, in `~/Projects/durable-pi/.env` (mode 600, gitignored),
copied by **name** into each device's `~/.dpi/backend.env`. Never sent to clients, never printed.

A **provisioning/management** key cannot run inference and fails chat completions with
`401 User not found.` If a 401 like that appears, check `GET https://openrouter.ai/api/v1/auth/key`
and look at `is_provisioning_key`. Note that `GET /api/v1/models` returns 200 **with no auth at
all** — a populated model catalog is not evidence that a key works.

## Boundaries

- Foundry is a no-write zone (53 uncommitted entries; WO-041 in flight). Nothing here authorizes
  edits there.
- No `0.0.0.0` bind, no public port. The Tailscale mesh is the access boundary.
- Never read, copy or print credential values. Names only.
- The backend shell is **not a sandbox**: a token is a shell. `start_dirs` only set where sessions
  begin.

## Next — Phase 2

One synthetic event → classifier → durable task → **Ready for Review**. No auto-send, no production
data. `apps/proactive-dpi-demo` is the reference implementation and is a loopback-only mock whose
agent shell is unsandboxed.
