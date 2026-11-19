// The shell's static file handler, side-effect free so it can be exercised without a server.
// SPEC cos-app v1.2 §13a (ruling 13): the shell has exactly two roots — the web root and the data
// root. A request path is resolved against its root, realpath() is taken, and the result must still
// be inside that root; only real files are served, never a directory listing, never a path built
// from the client's string alone. Assets (/app.js, /style.css) resolve against the web root.
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
