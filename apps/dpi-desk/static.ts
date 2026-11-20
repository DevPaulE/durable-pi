// The shell's static file handler, side-effect free so it can be exercised without a server.
// SPEC cos-app v1.2 §13a (ruling 13): the shell has exactly two roots — the web root and the data
// root. A request path is resolved against its root, realpath() is taken, and the result must still
// be inside that root; only real files are served, never a directory listing, never a path built
// from the client's string alone. Assets (/app.js, /style.css) resolve against the web root.
// It also holds the shell's origin decision, `sameOriginHeaders`, for the same reason: no server is
// needed to exercise it, and every route can share the one copy.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * §13a ruling 1A: every route the shell answers — the page, the assets, `/desk/*` and the proxied
 * `/v1/*` alike — is answered only to the shell's own origin. A request is same-origin when its Host
 * is exactly the shell's authority, its Origin (when sent) is exactly that authority over http, and
 * its Sec-Fetch-Site (when sent) is same-origin or none. Exact match, never a prefix: with the shell
 * on 4791, `127.0.0.1:47910` and `http://127.0.0.1:4791.evil` are not us.
 *
 * It lives here, not in `server.ts`, because `static.ts` is side-effect free and `server.ts` binds a
 * port on import: this way the decision can be exercised without a server, and there is one copy of
 * it for every route. Names are lower-case, as node hands them over.
 *
 * The third clause is narrower than it looks, and deliberately so: it exists to stop what can read or
 * write, not what can only display. A cross-site `fetch` of `/desk/projects.json` is a read (`cors`,
 * `no-cors`, `same-origin`), and it is refused. A cross-site *navigation* (`Sec-Fetch-Mode: navigate`)
 * is refused by the first two clauses alone if its Host or Origin is wrong — and if they are right it
 * is only a display: the browser's own same-origin policy still stops a foreign page reading the
 * result, and a `file://` wrapper (used to show the desk at a phone width) sends our Host and no
 * Origin at all, so refusing it would stop a display without stopping a read.
 *
 * Two limits, stated so nobody reads this as "no foreign page can touch the desk":
 *   * a foreign page may still **display** the desk in a frame — it cannot read it. This slice sends
 *     no `X-Frame-Options` and no `frame-ancestors`, so framing is not refused here;
 *   * a **local process that sends no headers at all is still trusted** — the desk trusts its machine.
 * What the check does stop is the measured defect: a page that rebound a hostname to 127.0.0.1 sends
 * `Host: evil.example`, which the first clause refuses on every route, whatever headers follow.
 */
export function sameOriginHeaders(headers: Record<string, string | string[] | undefined>, port: number): boolean {
  const one = (name: string): string | undefined => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const host = one("host");
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const origin = one("origin");
  if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return false;
  const site = one("sec-fetch-site");
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    // Cross-site or same-site: only a navigation passes, and only because it cannot read the reply.
    // Anything else — `cors`, `no-cors`, `same-origin`, or no mode at all, which is not a browser
    // navigation — is a scripted request and is refused.
    if (one("sec-fetch-mode") !== "navigate") return false;
  }
  return true;
}

type Res = { writeHead: (status: number, headers?: Record<string, string | number>) => unknown; end: (body?: unknown) => unknown };

function notFound(res: Res): void {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

/** Serve one request from the web root or the data root, or answer 404. */
export function serveRequest(res: Res, pathname: string, opts: { webDir: string; deskRoot: string }): void {
  const { webDir, deskRoot } = opts;
  let base: string;
  let rel: string;
  if (pathname === "/desk" || pathname.startsWith("/desk/")) {
    base = deskRoot;
    rel = pathname.slice("/desk/".length);
  } else if (pathname === "/" || pathname === "/index.html") {
    base = webDir;
    rel = "index.html";
  } else {
    base = webDir;
    rel = pathname.replace(/^\//, "");
  }

  let decoded = rel;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    decoded = rel;
  }
  if (decoded.includes("\0")) return notFound(res);

  let rootReal: string;
  try {
    rootReal = realpathSync(base);
  } catch {
    rootReal = resolve(base);
  }
  let target: string;
  try {
    target = realpathSync(resolve(base, decoded));
  } catch {
    return notFound(res);
  }
  if (target !== rootReal && !target.startsWith(rootReal + "/")) return notFound(res);
  let stat;
  try {
    stat = statSync(target);
  } catch {
    return notFound(res);
  }
  if (!stat.isFile()) return notFound(res);

  const body = readFileSync(target);
  res.writeHead(200, { "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream", "content-length": body.length });
  res.end(body);
}
