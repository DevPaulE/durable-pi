# dpi-desk — the desk shell (slice 1)

The second local server of the chief-of-staff desk (SPEC cos-app v1.1 §13a, option B). It serves the
front end (`web/`) and the desk data root, and proxies `/v1/*` to the desk's own backend on
`127.0.0.1:4790`, holding the device token server-side so the browser never does.

## Run (one command)

> **Known defect, and the workaround until it is fixed.** A thread that already existed when the desk
> restarted loses its stored model and then never answers again — the page shows *"The assistant
> didn't answer that one."* for that project. A brand-new thread on the same desk is fine.
> **After a restart, open a new project thread.**

```sh
apps/dpi-desk/start.sh          # both servers; Ctrl-C stops both
```

Open <http://127.0.0.1:4791/>.

Overridable: `DESK_DPI_HOME` (default `~/.dpi-desk`) and `DESK_ROOT` (default `~/Desk`; the dev
recipe uses `fixtures/desk` inside the clone).

**Why a script and not two commands.** Agent shells on this host export the hub's `DPI_*`
(`DPI_TOKEN`, `DPI_PORT=4780`, `DPI_PROVIDER`, `DPI_HOME`, `DPI_START_DIRS`, `DPI_HOST`,
`DPI_DEVICE_NAME`, `DPI_PROVIDERS`). The backend reads `DPI_TOKEN` from the environment **before** it
reads its own env file, and `process.loadEnvFile` does not override a variable that is already set —
so a desk backend started in an agent shell authenticates with the **hub's** token and every `/v1`
call is 401 against the desk's own token. Measured 2026-11-19: `desk token 401 / hub token 200`
before the fix, `desk token 200 / hub token 401` after. `start.sh` drops every inherited `DPI_*`
first, so the desk's own env file is the only source of the desk's configuration. It also runs the
shell under `tsx`: `node apps/dpi-desk/server.ts` exits `ERR_MODULE_NOT_FOUND` because the shell's
`import "./static.js"` is not remapped to `static.ts`.

Isolation: backend `4790`, shell `4791`, `DESK_DPI_HOME=~/.dpi-desk`, `DESK_ROOT` default `~/Desk`.
The shell owns the token: it reads `$DESK_DPI_HOME/backend.env`, or generates one and writes it
`0600`, and it never prints it. The backend starts after the shell for that reason. It makes no call
except the local `/v1` proxy.

`web/` is a **placeholder**: one plain page that lists the projects and prints each data file. The
three-pane front end is a later artifact.

## The guard is the second layer, not the wall

The chat agent that talks to this desk runs under a **default-deny** `beforeTool` filter: only
`ledger_add` and `read` pass, so `bash`, `write` and `edit` are refused when the model asks for them
(the tools are offered, the calls are blocked). On a desk backend (`DESK_ROOT` set) a
fresh conversation selects the `desk` extension by default, so the filter is live and `ledger_add` is
present without a human turning anything on; elsewhere the extension stays installed-and-unselected. The `beforeTool` hook in
`apps/dpi-backend/src/desk-addon.ts` is a *second* line of defence for any tool that does reach it:
it resolves the target through symlinks and compares device+inode with the record files, so a write
that reaches `log.jsonl`/`state.json` directly — or through a symlink or a hard link to them — is
refused. The desk still relies on the ledger being the only record: a cache that a hostile or buggy
tool corrupts is rebuilt from `log.jsonl` on the next call, and an unparseable cache is rendered
unreadable rather than trusted.
