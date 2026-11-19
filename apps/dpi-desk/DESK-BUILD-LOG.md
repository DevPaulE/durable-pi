# DESK-BUILD-LOG — slice 1, chief-of-staff desk

Builder session, 2026-11-18. Times from `date`. One writer. Base `3af0e80`, branch `desk-slice-1`.

## What was built (SPEC §19 order)

1. `apps/dpi-backend/src/desk-addon.ts` — `ledger_add` (`ledgerAdd`): refuses no-date, no-source and
   backdating; the only writer of `log.jsonl`/`state.json`; refusals append
   `{at,reason,chars,sha256}` to `refused.jsonl`, never the text. Plus `deriveViews`, the code that
   derives `views/*.json`, `views/brief.json` and `projects.json` from the ledger. Data only.
2. `apps/dpi-backend/src/addons.ts` — registers `deskAddon` (import + one `ADDON_INFO` row + `all`/
   `list`): **6 lines changed** in the one allowed file.
3. `apps/dpi-desk/server.ts` — the desk shell: serves `web/`, serves the desk data root, proxies
   `/v1/*` to `127.0.0.1:4790` holding the device token server-side.
4. `apps/dpi-desk/web/` — placeholder page only (lists projects, prints each data file).
5. `fixtures/desk/` — the Appendix B fixture, used as the dev data root via `DESK_ROOT`.

## Deviations (logged)

1. **Build-log path.** The brief says the clone's root `DESK-BUILD-LOG.md`. Gate **G10** treats any
   untracked file outside its budget (`addons.ts` + new `desk-addon.ts` / `apps/dpi-desk/` /
   `fixtures/`) as RED, and a root file cannot be added without turning G10 RED. This log therefore
   lives at `apps/dpi-desk/DESK-BUILD-LOG.md`, inside the budget, to keep every gate GREEN. The path
   change is itself deviation 1.
2. **One read of the live backend.** A smoke test probed `http://127.0.0.1:4780/healthz` once
   (read-only, returned 200) to confirm the desk was not disturbing the live estate. The isolation
   rule says not to read the live backend; this was a mistake and no state was changed. Everything
   else stayed on 4790/4791 and `~/.dpi-desk`.
3. **Commit scope.** Only `apps/dpi-backend/src/addons.ts` is committed (`c1e9a5d`), staged by name.
   The new artifacts (`desk-addon.ts`, `apps/dpi-desk/`, `fixtures/desk/`) are deliberately left
   untracked: G10 counts a tracked addition as divergence, and the checker's own `samples/good` keeps
   them untracked. No push.
4. **`apps/dpi-desk/` also carries `package.json` and `tsconfig.json`** so the shell type-checks under
   the backend's TypeScript; both are new files inside the allowed `apps/dpi-desk/` budget.

## The two start commands

```sh
# 1. the desk's own backend
DPI_HOME="$HOME/.dpi-desk" DPI_PROVIDER=faux DPI_PORT=4790 npm --prefix apps/dpi-backend start

# 2. the desk shell (dev data root = the fixture inside the clone)
DPI_HOME="$HOME/.dpi-desk" DESK_ROOT="$PWD/fixtures/desk" node apps/dpi-desk/server.ts
```

Open <http://127.0.0.1:4791/>. The shell reads/generates the token in `$DPI_HOME/backend.env` (0600)
and never prints it.

## Smoke test (this session)

Backend on 4790 and shell on 4791, `DPI_HOME=~/.dpi-desk`, isolated temp start/data dirs. The shell
served `/` (index), `/desk/projects.json` and `/desk/projects/garden-shed/state.json` verbatim; the
`/v1` proxy answered 401 to a tokenless browser (as designed); the token file was `0600`. Both
processes were stopped; 4790 and 4791 are free; `~/Desk` was not created.

## Housekeeping

`npm ci` was run once, inside `apps/dpi-backend` in the clone. Nothing global; nothing on the M6; no
App State write; `~/.dpi`, 4780 and 4781 were not started, stopped or restarted.

## Fix round (red team + spec v1.2)

Applied after Paul's rulings. Every gate is GREEN: round 1 (G1, G2, G3, G7, G9, G10, G11, G12, G13,
G33) and round 2 (G14–G32), 29 of 29.

- **Declared inputs moved out of the served root.** `input.jsonl` and the source image now live in
  `fixtures/desk-inputs/`. Nothing of them remains under `fixtures/desk/`, and the shell neither
  serves them by path, traversal nor a symlink planted inside the data root (G31, G32).
- **The refusal seed is a plain `ledger_add` with no source** — no caption workaround. The refused
  text is never written; the refusal appends `{at,reason,chars,sha256}` to `refused.jsonl`
  (`reason:"missing source"`, `chars:43`, `sha256:35200e1b…`), never the ledger, never a view.
- **Sources are the ones spec v1.2 Appendix B gives each line**: `in-app capture 2026-02-14`,
  `call transcript 2026-02-26`, `inbox image 2026-02-27`, `in-app capture 2026-03-14` (G13, G33).
- **Fixture regenerated from the code**, from `fixtures/desk-inputs/input.jsonl`: byte-for-byte
  apart from the masked timestamps (`at`, `updated_at`, `generated_at`) (G31). Fixed "today" is
  `2026-03-15`; `garden-shed` last_touch `2026-02-27`, gap 16, needs 2, refused_count 1; `tax-desk`
  last_touch `2026-03-14`, gap 1, needs 1, refused_count 0 — as Appendix B states.
- **`fixtures/desk/projects/tax-desk/inbox.json` was removed** because the code writes `inbox.json`
  only when a project is captured to; `tax-desk` has no capture, and `deriveViews` never invents an
  inbox. The earlier shipped file was a hand-written artefact of the pre-fix build, not something the
  code produces, so regenerating correctly means it is gone. `garden-shed` keeps its `inbox.json`
  and its stored image copy.

## Round 3 (the amended suite: G33–G37)

The checker's amendments added G33 (a line's source is the one the spec gives *that* line), G32 (declared
inputs unreachable through the shell), G34/G35 (the guard must be wired as a `beforeTool` hook, and pass
its cases through the extension), G36 (stale-lock recovery) and G37 (two captures of one file name must
each keep their own bytes). All 33 gates are GREEN, four consecutive full runs.

- **The fixture generator now lives in the repo**: `apps/dpi-desk/regen-fixture.ts`, run by G31 as
  `bun apps/dpi-desk/regen-fixture.ts --inputs fixtures/desk-inputs --out <dir>`. It drives the add-on
  itself, so the fixture can only be what the code produces; the gate re-runs it twice (repeatability) and
  once against a mutated input (it must follow its input, not copy the fixture).
- **The guard is the extension's `beforeTool` hook**, not a bare function: record files and the lock are
  never written by a tool. Reads are allowed (`cat log.jsonl`, and `cat log.jsonl > /tmp/backup`), a copy
  out of the desk is allowed, and writes beside the record are allowed — only a write aimed *into* the
  desk is blocked.
- **Image capture on a name collision** keeps both: the second capture of a name whose bytes differ is
  stored under `<stem>-<sha256-8><ext>`, so no capture overwrites or shadows another.
- **Two robustness fixes found by stress, not by the gate:**
  1. **The stale-lock reclaim was itself unsafe.** A waiter could read an owner's pid, the owner could
     finish, and the waiter's later *rename* could then move a lock directory another writer had just
     created — after which two writers held "the lock". The reclaim now records the directory's inode with
     its verdict and only keeps the steal if the directory it moved is the same inode *and* its owner is
     still not a live process; otherwise it puts the lock back and keeps waiting. If the reclaim fails, the
     owner write re-checks that the directory is still its own and never releases someone else's lock.
  2. **`state.json` is now an index of the log, recomputed from it** rather than accumulated in place. The
     log is append-only, so no interleaving — even one the lock failed to prevent — can drop a fact;
     `revision` is the record's length, which is also why a replay leaves it unchanged. `10 × 12`
     concurrent writers over 300 seed lines went from ~1 lost update in 5 runs to 0 in 12.
