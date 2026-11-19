# dpi-desk — the desk shell (slice 1)

The second local server of the chief-of-staff desk (SPEC cos-app v1.1 §13a, option B). It serves the
front end (`web/`) and the desk data root, and proxies `/v1/*` to the desk's own backend on
`127.0.0.1:4790`, holding the device token server-side so the browser never does.

## Run (two commands)

```sh
# 1. the desk's own backend — its own ports and home only
DPI_HOME="$HOME/.dpi-desk" DPI_PROVIDER=faux DPI_PORT=4790 npm --prefix apps/dpi-backend start

# 2. the desk shell (dev data root = the Appendix B fixture inside the clone)
DPI_HOME="$HOME/.dpi-desk" DESK_ROOT="$PWD/fixtures/desk" node apps/dpi-desk/server.ts
```

Open <http://127.0.0.1:4791/>.

Isolation: backend `4790`, shell `4791`, `DPI_HOME=~/.dpi-desk`, `DESK_ROOT` default `~/Desk`
(overridable). The shell reads the token from `$DPI_HOME/backend.env`, or generates one and writes it
`0600`; it never prints the token. It makes no call except the local `/v1` proxy.

`web/` is a **placeholder**: one plain page that lists the projects and prints each data file. The
three-pane front end is a later artifact.
