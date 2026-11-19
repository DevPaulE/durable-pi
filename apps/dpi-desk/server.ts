// The desk shell (SPEC cos-app v1.2 §13a, option B). Two local servers, both loopback:
//
//   * this shell serves the front end (`web/`) and the desk data root through `serveRequest`, so the
//     browser reads the ledger files directly as data, confined to the two roots;
//   * it proxies `/v1/*` to the desk's own backend on 127.0.0.1:4790, holding the device token
//     here so the browser never does.
//
// Its own isolation: backend port 4790, shell port 4791, DPI_HOME=~/.dpi-desk, DESK_ROOT
// (default ~/Desk, the fixture inside the clone during development). It generates its own local
// token if there is none, and never prints it.
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { serveRequest } from "./static.js";

const DPI_HOME = process.env.DPI_HOME ?? join(homedir(), ".dpi-desk");
const DESK_ROOT = resolve(process.env.DESK_ROOT ?? join(homedir(), "Desk"));
const WEB_DIR = join(import.meta.dirname, "web");
const BACKEND = process.env.DPI_BACKEND_URL ?? "http://127.0.0.1:4790";
const SHELL_PORT = Number(process.env.DESK_PORT ?? 4791);

/** The device token, read from $DPI_HOME/backend.env, or generated once and written 0600. Never printed. */
function deviceToken(): string {
  const envFile = join(DPI_HOME, "backend.env");
  let token = "";
  try {
    token = (readFileSync(envFile, "utf8").match(/^DPI_TOKEN=(.+)$/m)?.[1] ?? "").trim();
  } catch {
    token = "";
  }
  if (token.length >= 32) return token;
  token = `dpi_${randomBytes(32).toString("base64url")}`;
  mkdirSync(DPI_HOME, { recursive: true, mode: 0o700 });
  writeFileSync(envFile, `DPI_TOKEN=${token}\n`, { mode: 0o600 });
  return token;
}

/** Forward `/v1/*` to the desk backend, injecting the device token server-side. */
function proxy(req: IncomingMessage, res: ServerResponse, token: string): void {
  let upstream: ReturnType<typeof httpRequest>;
  try {
    upstream = httpRequest(
      `${BACKEND}${req.url}`,
      { method: req.method, headers: { ...req.headers, host: "127.0.0.1:4790", "x-dpi-token": token } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
  } catch {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("bad request");
    return;
  }
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("desk backend unavailable on 127.0.0.1:4790");
  });
  req.pipe(upstream);
}

const token = deviceToken();

const server = createServer((req, res) => {
  try {
    handle(req, res);
  } catch {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("internal error");
  }
});
server.on("clientError", (_e, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

function handle(req: IncomingMessage, res: ServerResponse): void {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://127.0.0.1:${SHELL_PORT}`);
  } catch {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("bad request");
    return;
  }
  if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
    proxy(req, res, token);
    return;
  }
  serveRequest(res, url.pathname, { webDir: WEB_DIR, deskRoot: DESK_ROOT });
}

server.listen(SHELL_PORT, "127.0.0.1", () => {
  console.log(`desk shell on http://127.0.0.1:${SHELL_PORT}`);
  console.log(`data: ${DESK_ROOT}  backend: 127.0.0.1:4790  shell port: 4791`);
});

export { DPI_HOME, DESK_ROOT, BACKEND, SHELL_PORT };
