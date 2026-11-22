// sandbox.ts — play a scenario of user actions against a throwaway desk and leave the same action log.
//
// SPEC-action-log-2026-11-21.md §3.2 and §8: `tsx sandbox.ts --scenario FILE --out DIR`. FILE is a
// JSON array of `{action:"new-session"}` | `{action:"send",text}` | `{action:"stop"}` |
// `{action:"open-view",view}`. The runner brings up a real desk shell on an OS-chosen loopback port
// with a temp data root, a temp DPI_HOME and a loopback stub for the backend — no real desk, no real
// key, no model, no spend — drives each step over HTTP, and copies the shell's own
// `$DPI_HOME/actions.jsonl` to `DIR/actions.jsonl`. One line per step, `source` sandbox.
//
// It never binds 4790/4791 and never reads the real desk: DPI_HOME and DESK_ROOT are both under a
// fresh temp directory, and the child shell is started with DESK_ACTION_SOURCE=sandbox.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The desk's real ports: a sandbox must never bind them, and the runner refuses them by name. */
const REAL_PORTS = [4780, 4781, 4790, 4791];
const CLONE = resolve(import.meta.dirname, "..", "..");

type Step = { action: string; text?: string; view?: string };

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

function usage(m: string): never {
  console.error(`sandbox: ${m}\nusage: tsx sandbox.ts --scenario FILE --out DIR`);
  process.exit(2);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

/** An OS-chosen loopback port. Never one of the desk's own. */
async function freePort(): Promise<number> {
  for (let i = 0; i < 25; i++) {
    const port = await new Promise<number>((ok) => {
      const s = createServer();
      s.on("error", () => ok(0));
      s.listen(0, "127.0.0.1", () => {
        const a = s.address();
        const p = a && typeof a === "object" ? a.port : 0;
        s.close(() => ok(p));
      });
    });
    if (port && !REAL_PORTS.includes(port)) return port;
  }
  throw new Error("could not pick a free loopback port");
}

/** One request to the sandbox shell. The Host header is the shell's own authority, as the page sends. */
function ask(port: number, method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((ok, fail) => {
    const req = request(
      { host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => ok({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The stand-in desk backend: a loopback stub, so no model and no key are ever involved. */
function stubBackend(port: number) {
  const server = createServer((req, res) => {
    const target = (req.url ?? "/").split("?")[0];
    req.on("data", () => {});
    req.on("end", () => {
      const send = (o: unknown) => {
        const b = JSON.stringify(o);
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
        res.end(b);
      };
      if (/\/messages$/.test(target)) return send({ status: "done", answer: { text: "sandbox answer" } });
      if (/\/abort$/.test(target)) return send({ ok: true });
      send({ id: "sandbox-session", name: "sandbox", stub: true });
    });
  });
  server.listen(port, "127.0.0.1");
  return server;
}

/** The shell's TypeScript runner, from this clone: node cannot load server.ts without it. */
function tsx(): string {
  for (const p of [join(CLONE, "apps", "dpi-backend", "node_modules", ".bin", "tsx"), join(CLONE, "node_modules", ".bin", "tsx")]) {
    if (existsSync(p)) return p;
  }
  return "tsx";
}

function logLineCount(home: string): number {
  try {
    return readFileSync(join(home, "actions.jsonl"), "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  const scenarioFile = arg("--scenario");
  const outArg = arg("--out");
  if (!scenarioFile || !outArg) usage("--scenario and --out are required");
  const out = resolve(outArg!);
  const scenario = JSON.parse(readFileSync(scenarioFile!, "utf8")) as Step[];
  if (!Array.isArray(scenario)) usage("the scenario file is not a JSON array");

  const tmp = mkdtempSync(join(tmpdir(), "desk-sandbox-"));
  const home = join(tmp, "home");
  const dpiHome = join(tmp, "dpi");
  const deskRoot = join(tmp, "desk");
  mkdirSync(out, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(dpiHome, { recursive: true, mode: 0o700 });
  // A throwaway data root with a throwaway token: nothing here is the real desk.
  copyDirectory(join(CLONE, "fixtures", "desk"), deskRoot);
  writeFileSync(join(dpiHome, "backend.env"), `DPI_TOKEN=dpi_sandbox_${randomBytes(24).toString("base64url")}\n`, { mode: 0o600 });

  const shellPort = await freePort();
  const backendPort = await freePort();
  const stub = stubBackend(backendPort);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    DPI_HOME: dpiHome,
    DESK_ROOT: deskRoot,
    DESK_PORT: String(shellPort),
    DESK_ACTION_SOURCE: "sandbox",
    DPI_BACKEND_URL: `http://127.0.0.1:${backendPort}`,
  };
  // No provider credentials reach the sandbox; the stub is the only backend.
  for (const k of ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "RADIUS_API_KEY", "OLLAMA_API_KEY"]) delete env[k];

  // `detached` so the shell and anything tsx starts under it can be killed as one group: tsx is a
  // wrapper that re-executes node, so killing only the wrapper would leave the server behind.
  const shell = spawn(tsx(), [join(CLONE, "apps", "dpi-desk", "server.ts")], { cwd: CLONE, env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let shellErr = "";
  shell.stderr?.on("data", (c: Buffer) => (shellErr += c.toString()));

  try {
    let up = false;
    for (let i = 0; i < 150 && !up; i++) {
      up = await ask(shellPort, "GET", "/").then(() => true).catch(() => false);
      if (!up) await sleep(100);
    }
    if (!up) throw new Error(`the sandbox shell did not start: ${shellErr.replace(/\s+/g, " ").slice(0, 240)}`);

    let session = "sandbox-session";
    for (const [i, step] of scenario.entries()) {
      if (step.action === "new-session") {
        const r = await ask(shellPort, "POST", "/v1/sessions", JSON.stringify({ name: `sandbox-${i}`, cwd: tmp, model: { provider: "faux", modelId: "echo" } }));
        try {
          const id = (JSON.parse(r.body) as { id?: string }).id;
          if (id) session = id;
        } catch {
          /* the stub's shape is not the point; the step's line is */
        }
      } else if (step.action === "open-view") {
        const name = typeof step.view === "string" && /^[a-z0-9-]{1,32}$/.test(step.view) ? step.view : "other";
        await ask(shellPort, "GET", `/desk/views/${name}.json`);
      } else if (step.action === "send") {
        await ask(shellPort, "POST", `/v1/sessions/${session}/agents/main/messages`, JSON.stringify({ content: step.text ?? "", requestId: `req-${i}`, waitMs: 1000 }));
      } else if (step.action === "stop") {
        await ask(shellPort, "POST", `/v1/sessions/${session}/agents/main/abort`, "{}");
      } else {
        throw new Error(`unknown step ${JSON.stringify(step)}`);
      }
    }

    for (let i = 0; i < 100 && logLineCount(dpiHome) < scenario.length; i++) await sleep(100);
    copyFileSync(join(dpiHome, "actions.jsonl"), join(out, "actions.jsonl"));
    console.log(`sandbox: ${scenario.length} step(s) played; log at ${join(out, "actions.jsonl")}`);
  } finally {
    try {
      if (shell.pid) process.kill(-shell.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    stub.closeAllConnections();
    stub.close();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* a temp dir that will be collected anyway */
    }
  }
}

/** A small recursive copy of the throwaway data root. */
function copyDirectory(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) copyDirectory(src, dst);
    else copyFileSync(src, dst);
  }
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((e: unknown) => {
    console.error(`sandbox: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  // The scenario is over and every child is dead by now; leave rather than wait on a stray handle,
  // after a beat that lets the one line of stdout reach the caller.
  .finally(() => {
    setTimeout(() => process.exit(process.exitCode ?? 0), 50);
  });
