// The desk shell (SPEC cos-app v1.1 §13a, option B). Two local servers, both loopback:
//
//   * this shell serves the front end (`web/`) and the desk data root, so the browser can read the
//     ledger files directly as data;
//   * it proxies `/v1/*` to the desk's own backend on 127.0.0.1:4790, holding the device token
//     here so the browser never does.
//
// Its own isolation: backend port 4790, shell port 4791, DPI_HOME=~/.dpi-desk, DESK_ROOT
// (default ~/Desk, the fixture inside the clone during development). It generates its own local
// token if there is none, and never prints it.
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";

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

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

/** Serve one file if it is inside `base` and exists; otherwise 404. */
function serveFile(res: ServerResponse, base: string, rel: string): void {
  const target = resolve(base, normalize(rel).replace(/^(\.\.(\/|\\|$))+/, ""));
  if (target !== base && !target.startsWith(base + "/")) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream" });
  res.end(readFileSync(target));
}

/** Forward `/v1/*` to the desk backend, injecting the device token server-side. */
function proxy(req: IncomingMessage, res: ServerResponse, token: string): void {
  const upstream = httpRequest(
    `${BACKEND}${req.url}`,
    { method: req.method, headers: { ...req.headers, host: "127.0.0.1:4790", "x-dpi-token": token } },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("desk backend unavailable on 127.0.0.1:4790");
  });
  req.pipe(upstream);
}

const token = deviceToken();

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${SHELL_PORT}`);
  if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
    proxy(req, res, token);
    return;
  }
  if (url.pathname === "/desk" || url.pathname.startsWith("/desk/")) {
    serveFile(res, DESK_ROOT, url.pathname.slice("/desk/".length));
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    serveFile(res, WEB_DIR, "index.html");
    return;
  }
  serveFile(res, WEB_DIR, url.pathname);
});

server.listen(SHELL_PORT, "127.0.0.1", () => {
  console.log(`desk shell on http://127.0.0.1:${SHELL_PORT}`);
  console.log(`data: ${DESK_ROOT}  backend: 127.0.0.1:4790  shell port: 4791`);
});

export { DPI_HOME, DESK_ROOT, BACKEND, SHELL_PORT };
