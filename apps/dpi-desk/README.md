# dpi-desk — the desk shell (slice 1)

The second local server of the chief-of-staff desk (SPEC cos-app v1.1 §13a, option B). It serves the
front end (`web/`) and the desk data root, and proxies `/v1/*` to the desk's own backend on
`127.0.0.1:4790`, holding the device token server-side so the browser never does.

## Run (two commands)

```sh
# 1. the desk's own backend — its own ports, home and data root. DESK_ROOT is what makes this
#    backend the desk: it is both where ledger_add writes and why a fresh conversation here comes
#    up with the `desk` extension selected (ledger_add + the beforeTool guard, no human step).
DPI_HOME="$HOME/.dpi-desk" DESK_ROOT="$PWD/fixtures/desk" DPI_PROVIDER=faux DPI_PORT=4790 npm --prefix apps/dpi-backend start

# 2. the desk shell (dev data root = the Appendix B fixture inside the clone)
DPI_HOME="$HOME/.dpi-desk" DESK_ROOT="$PWD/fixtures/desk" node apps/dpi-desk/server.ts
```

Open <http://127.0.0.1:4791/>.

Isolation: backend `4790`, shell `4791`, `DPI_HOME=~/.dpi-desk`, `DESK_ROOT` default `~/Desk`
(overridable). The shell reads the token from `$DPI_HOME/backend.env`, or generates one and writes it
`0600`; it never prints the token. It makes no call except the local `/v1` proxy.

`web/` is a **placeholder**: one plain page that lists the projects and prints each data file. The
three-pane front end is a later artifact.

## The guard is the second layer, not the wall

The chat agent that talks to this desk runs with a tool filter of `ledger_add` plus read-only tools
(`read`, `book_lookup`); it has no `bash`, `write` or `edit`. On a desk backend (`DESK_ROOT` set) a
fresh conversation selects the `desk` extension by default, so the filter is live and `ledger_add` is
present without a human turning anything on; elsewhere the extension stays installed-and-unselected. The `beforeTool` hook in
`apps/dpi-backend/src/desk-addon.ts` is a *second* line of defence for any tool that does reach it:
it resolves the target through symlinks and compares device+inode with the record files, so a write
that reaches `log.jsonl`/`state.json` directly — or through a symlink or a hard link to them — is
refused. The desk still relies on the ledger being the only record: a cache that a hostile or buggy
tool corrupts is rebuilt from `log.jsonl` on the next call, and an unparseable cache is rendered
unreadable rather than trusted.
