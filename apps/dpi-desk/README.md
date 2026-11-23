# dpi-desk — the desk shell (slice 1)

The second local server of the chief-of-staff desk (SPEC cos-app v1.1 §13a, option B). It serves the
three-pane page (`web/`) and the desk data root, and proxies `/v1/*` to the desk's own backend on
`127.0.0.1:4790`, holding the device token server-side so the browser never does.

## Run (one command)

The desk lives on its own branch. Clone that branch, then run it from the clone:

```sh
git clone --branch desk-slice-1 https://github.com/DevPaulE/durable-pi
cd durable-pi

npm install --prefix apps/dpi-backend   # once: the backend's dependencies, and the tsx the shell runs under
apps/dpi-desk/start.sh                  # both servers; Ctrl-C stops both
```

Open <http://127.0.0.1:4791/>.

Overridable: `DESK_DPI_HOME` (default `~/.dpi-desk`; the shell's token, the backend's catalog and its
App State live there) and `DESK_ROOT` (the desk's data root; `start.sh` defaults it to
`fixtures/desk` inside the clone — it reads and creates no other directory).

### The recipe for a local model — free, loopback, no account

Four lines in `$DESK_DPI_HOME/backend.env` put a loopback Ollama behind the desk:

```sh
DPI_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
OLLAMA_API_KEY=<any non-empty>
OLLAMA_DEFAULT_MODEL=gemma4:12b-ctx32k
```

`OLLAMA_API_KEY` is ignored by a local Ollama — the value is never checked, so **any non-empty string
will do**; it exists only because the provider's shape wants one. `OLLAMA_DEFAULT_MODEL` names the
model a *new* thread gets; the rest of the catalog is read from the endpoint's own `/v1/models`, so
every model Ollama has pulled appears in the device's model list (`GET /v1/device` lists them). No
key, or an endpoint that does not answer, leaves that provider's catalog empty and the desk stays on
the stand-in `faux/echo` model — the page carries no word saying so, which is a known gap. Naming
the provider in the file is enough: `start.sh` leaves the file's own `DPI_PROVIDER` alone and never
pins the desk to `faux`.

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

Isolation: backend `4790`, shell `4791`, `DESK_DPI_HOME=~/.dpi-desk`, `DESK_ROOT` default
`fixtures/desk`. The shell owns the token: it reads `$DESK_DPI_HOME/backend.env`, or generates one
and writes it `0600`, and it never prints it. The backend starts after the shell for that reason. It
makes no call except the local `/v1` proxy.

## The page

Three panes, plain files under `web/` — no build step, no framework, served straight off disk:

- **Left — projects.** Every project the data root holds.
- **Centre — the selected project**, as tabs: *Where we left off*, *Ledger*, *Inbox*, *Receipts*,
  *What left*. Each page is read from the data root on request; nothing is cached across a restart.
- **Right — chat.** The thread that belongs to the selected project: its transcript, a Send box, and
  Stop for a turn that is still running. A failed send, a failed Stop and an unanswered turn all say
  the one sentence: *"The desk's assistant isn't running right now."*

## Uninstall

The desk creates two things of its own — `$DESK_DPI_HOME` (default `~/.dpi-desk`) and whatever
`DESK_ROOT` it was pointed at (`fixtures/desk` inside the clone by default):

```sh
rm -rf ~/.dpi-desk
rm -rf fixtures/desk        # only if DESK_ROOT is still the default
```

That is all of the desk's own state: the token, the session catalog, the per-session `agent.sqlite`
databases and the desk's data root. `npm install` also leaves packages in npm's shared cache
(`~/.npm`), the same as any other install. The backend additionally creates its default agent start
dir, `~/dpi-work`, on first start; nothing removes it.

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
