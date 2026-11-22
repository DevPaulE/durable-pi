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
//
// The action log (SPEC-action-log-2026-11-21.md §8). The shell already sees every action that
// matters — a new session, a message, a stop, a view fetch — and the reply it sent back, so it
// writes the log itself: one append-only JSON object per line at $DPI_HOME/actions.jsonl, private
// mode, `source` real unless started with DESK_ACTION_SOURCE=sandbox. Four actions, a closed set;
// nothing else writes a line, and no line carries anything a person typed. The log is a shadow: if
// it cannot be written the desk answers exactly as before.
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { sameOriginHeaders, serveRequest } from "./static.js";

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

/**
 * The `/v1` routes the page is allowed to reach. The decision is made on the RAW request target with
 * the query string stripped and nothing else done to it — no decoding, no `..` collapsing, no prefix
 * match — and that same value is what gets forwarded. A route off this list is refused here, so the
 * backend is never contacted for it.
 *
 * `:s`, `:a` and a submission id must be one segment of `[A-Za-z0-9_~-][A-Za-z0-9._~-]*`: no `%`, no
 * dot-segments (the first character cannot be `.`).
 */
const SEGMENT = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/;

type RouteDecision = { allow: true } | { allow: false; status: number };

function v1Route(method: string, target: string): RouteDecision {
  const parts = target.split("/");
  if (parts[0] !== "" || parts[1] !== "v1") return { allow: false, status: 404 };
  const rest = parts.slice(2);
  const get = method === "GET";
  const post = method === "POST";
  const wrongMethod: RouteDecision = { allow: false, status: 405 };
  if (rest.length === 1 && rest[0] === "device") return get ? { allow: true } : wrongMethod;
  if (rest.length === 1 && rest[0] === "sessions") return get || post ? { allow: true } : wrongMethod;
  if (rest.length === 2 && rest[0] === "sessions" && SEGMENT.test(rest[1])) return get ? { allow: true } : wrongMethod;
  if (rest.length === 3 && rest[0] === "sessions" && SEGMENT.test(rest[1]) && rest[2] === "agents") {
    return get || post ? { allow: true } : wrongMethod;
  }
  if (rest.length === 5 && rest[0] === "sessions" && SEGMENT.test(rest[1]) && rest[2] === "agents" && SEGMENT.test(rest[3])) {
    const leaf = rest[4];
    if (leaf === "entries" || leaf === "transcript" || leaf === "events" || leaf === "config") {
      return get ? { allow: true } : wrongMethod;
    }
    if (leaf === "messages" || leaf === "abort") return post ? { allow: true } : wrongMethod;
    return { allow: false, status: 404 };
  }
  if (rest.length === 4 && rest[0] === "sessions" && SEGMENT.test(rest[1]) && rest[2] === "submissions" && SEGMENT.test(rest[3])) {
    return get ? { allow: true } : wrongMethod;
  }
  return { allow: false, status: 404 };
}

/**
 * The action log. `$DPI_HOME/actions.jsonl`, one JSON object per line, append-only and private.
 *
 * A name in the log is a lower-case name of at most 32 characters and nothing else — no `..`, no
 * `/`, no `%`, no upper case — so a project slug or a file name can never smuggle a path or a
 * hostile string into the file. Anything else becomes `-` (project) or `other` (view).
 */
const ACTION_LOG = join(DPI_HOME, "actions.jsonl");
const ACTION_SOURCE = process.env.DESK_ACTION_SOURCE === "sandbox" ? "sandbox" : "real";
const LOG_NAME = /^[a-z0-9-]{1,32}$/;

type ActionName = "new-session" | "send" | "stop" | "open-view";
type Action = { action: ActionName; project: string; view?: string };

/**
 * The action a request is, or `null` if it is not one of the four. Read from the same raw request
 * target the router uses: nothing is decoded, so a hostile name stays visible and is judged above.
 *   POST /v1/sessions                        -> new-session
 *   POST /v1/sessions/:s/agents/:a/messages  -> send
 *   POST /v1/sessions/:s/agents/:a/abort     -> stop
 *   GET  /desk/**\/views/<name>.json         -> open-view (project = the slug after /desk/projects/)
 * Every other request — the page, the assets, projects.json, any GET /v1/*, POST …/agents, anything
 * the shell refuses — is not an action and writes nothing.
 */
function actionFor(method: string, target: string): Action | null {
  const p = target.split("/");
  if (method === "POST" && target === "/v1/sessions") return { action: "new-session", project: "-" };
  if (method === "POST" && p.length === 7 && p[1] === "v1" && p[2] === "sessions" && p[4] === "agents" && (p[6] === "messages" || p[6] === "abort")) {
    return { action: p[6] === "messages" ? "send" : "stop", project: "-" };
  }
  if (method === "GET" && p[1] === "desk" && p.length >= 4 && p[p.length - 2] === "views" && p[p.length - 1].endsWith(".json")) {
    const view = p[p.length - 1].slice(0, -5);
    const project = p[2] === "projects" && p.length === 6 && LOG_NAME.test(p[3]) ? p[3] : "-";
    return { action: "open-view", project, view: LOG_NAME.test(view) ? view : "other" };
  }
  return null;
}

/** Write one line. Never throws: the log may not break the desk. */
function logAction(a: Action, status: number): void {
  const line: Record<string, string | number> = {
    time: new Date().toISOString(),
    source: ACTION_SOURCE,
    project: a.project,
    action: a.action,
  };
  if (a.action === "open-view") line.view = a.view ?? "other";
  line.outcome = status >= 200 && status < 300 ? "worked" : "failed";
  line.status = status;
  try {
    appendFileSync(ACTION_LOG, JSON.stringify(line) + "\n", { mode: 0o600 });
  } catch {
    /* the log is a shadow: an unwritable log changes no reply */
  }
}

/** The reply's status is the first `writeHead` — log it once, then leave the reply alone. */
function logOnReply(res: ServerResponse, a: Action): void {
  const original = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
  let logged = false;
  res.writeHead = ((...args: unknown[]) => {
    if (!logged) {
      logged = true;
      logAction(a, Number(args[0]));
    }
    return original(...args);
  }) as unknown as ServerResponse["writeHead"];
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
  // Every route this shell answers — `/v1/*`, the page, the assets, `/desk/*` — is answered only to
  // the shell's own origin. The check is first, so a request that is not ours is refused before
  // anything is read off disk, before a directory listing could be built, and before the device token
  // is ever attached to a proxied call. One decision, in `static.ts`, shared by every route.
  if (!sameOriginHeaders(req.headers, SHELL_PORT)) {
    // A local process that sends no headers at all is still trusted — the desk trusts its machine.
    // A page is not: its Host, Origin and Sec-Fetch-Site come from the browser, not the script.
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("forbidden: request from another origin");
    return;
  }
  const raw = req.url ?? "/";
  const target = raw.split("?")[0];
  if (target === "/v1" || target.startsWith("/v1/")) {
    const route = v1Route(req.method ?? "GET", target);
    if (!route.allow) {
      // Off-list (or wrong method): the backend is never contacted. Decide on the raw target above,
      // forward on the same raw target below — never on a normalised one. A refused route is not an
      // action and writes no line, so the log is decided after the allowlist, never before it.
      res.writeHead(route.status, { "content-type": "text/plain" });
      res.end("not allowed");
      return;
    }
    const action = actionFor(req.method ?? "GET", target);
    if (action) logOnReply(res, action);
    proxy(req, res, token);
    return;
  }
  const viewed = actionFor(req.method ?? "GET", target);
  if (viewed) logOnReply(res, viewed);
  serveRequest(res, url.pathname, { webDir: WEB_DIR, deskRoot: DESK_ROOT });
}

server.listen(SHELL_PORT, "127.0.0.1", () => {
  console.log(`desk shell on http://127.0.0.1:${SHELL_PORT}`);
  console.log(`data: ${DESK_ROOT}  backend: 127.0.0.1:4790  shell port: 4791`);
});

export { DPI_HOME, DESK_ROOT, BACKEND, SHELL_PORT };
