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
