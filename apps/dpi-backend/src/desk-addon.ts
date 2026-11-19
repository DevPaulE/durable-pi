// The desk add-on: one project's ledger, the capture path, the derived pages, and the runtime
// guards. SPEC cos-app v1.2 §1b (nine rules), §5–§7, §13a, §17, §19.
//
// `ledger_add` is the ONLY writer of `log.jsonl` and `state.json`, enforced at runtime:
//   * a line's `date` is a real calendar date, not after today (§1b.1);
//   * a `source` is non-blank and names a date (§1b.2); a line whose date precedes its source date
//     is refused — backdating cannot enter the record;
//   * `kind` is one of the enum (§1b.3); the `slug` matches [a-z0-9-]{1,64} (§1b.4);
//   * `last_touch` is the latest date in the record, never the most recent write (§1b.5);
//   * `needs` = open_items + follow_ups (§1b.6);
//   * writes are atomic (temp + fsync + rename) and serialised under a per-project lock, and an
//     identical line is never appended twice (§1b.7);
//   * a refused line is never written to the ledger: the refusal appends {at,reason,chars,sha256}
//     to `refused.jsonl` — reason and time only, never the text (§1b.2, amendment A).
// Pages are DATA derived from the record by code (§1b.3): `deriveViews` writes
// `views/where-we-left-off.json`, `views/receipts.json`, `views/egress.json`, `views/brief.json`
// and `projects.json`. An unreadable record renders as unreadable, never as an empty project (§1b.9).
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { Type } from "typebox";

export type Line = { date?: string; source?: string; text?: string; kind?: string };
export type AddOpts = { root: string; slug: string; name?: string; today?: string };
export type Result = { ok: true } | { ok: false; reason: string };

const KINDS = ["decision", "open", "follow_up", "note"];
const SLUG_RE = /^[a-z0-9-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RECORD_NAMES = new Set(["log.jsonl", "state.json", "refused.jsonl"]);

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const nowIso = () => new Date().toISOString();
const todayIso = () => nowIso().slice(0, 10);
const pdir = (root: string, slug: string) => join(root, "projects", slug);
const logPath = (dir: string) => join(dir, "log.jsonl");

/** A real calendar date in YYYY-MM-DD (not `2026-02-30`, not `not-a-date`). */
function isRealDate(s: unknown): s is string {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
/** Every real date named in a source string. Appendix B sources name their own date. */
function sourceDates(source: string): string[] {
  return (source.match(/\d{4}-\d{2}-\d{2}/g) ?? []).filter(isRealDate);
}
function addDays(iso: string, n: number): string {
  const d = new Date(Date.parse(iso));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const readJson = <T>(p: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return fallback;
  }
};
const logLines = (dir: string): Line[] => {
  const p = logPath(dir);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Line;
      } catch {
        return {};
      }
    });
};
const refusalCount = (dir: string): number => {
  const p = join(dir, "refused.jsonl");
  if (!existsSync(p)) return 0;
  return readFileSync(p, "utf8").split("\n").filter(Boolean).length;
};
const maxDate = (lines: Line[]): string | undefined => lines.map((l) => l.date ?? "").filter(Boolean).sort().pop();

/** Atomic replace: write a temp file, fsync it, rename over the target (no half-file is ever read). */
function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/** A single exclusive lock per project, held across the read-modify-write (across processes too). */
function acquire(lock: string): void {
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (Date.now() - started > 15_000) throw new Error("desk: lock timeout");
      sleep(2);
    }
  }
}
const release = (lock: string) => {
  try {
    rmSync(lock, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
};

type ApplyResult = { ok: true; appended: boolean } | { ok: false; reason: string };

/**
 * The one writer. Validates, then under the project lock appends the log line and updates the state
 * together. A replay of an identical line returns the original outcome and writes nothing (§1b.7).
 */
function apply(line: Line, opts: AddOpts): ApplyResult {
  const root = opts.root;
  const slug = String(opts.slug ?? "");
  const today = opts.today ?? todayIso();
  const text = String(line.text ?? "").trim();
  const dir = pdir(root, slug);

  // §1b.4: the slug is never free text — validated before any path is joined.
  if (!SLUG_RE.test(slug)) return { ok: false, reason: "invalid slug" };

  const refuse = (reason: string): ApplyResult => {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "refused.jsonl"), JSON.stringify({ at: nowIso(), reason, chars: text.length, sha256: sha256(text) }) + "\n");
    return { ok: false, reason };
  };

  // §1b.1: a real calendar date, never after today.
  if (!line.date || !isRealDate(line.date)) return refuse("invalid date");
  if (line.date > today) return refuse("date after today");
  // §1b.2: a source, non-blank, naming a date; and not backdated.
  const source = line.source;
  if (typeof source !== "string" || !source.trim()) return refuse("missing source");
  const sdates = sourceDates(source);
  if (!sdates.length) return refuse("source names no date");
  if (line.date < sdates.sort()[0]) return refuse("date precedes source");
  // §1b.3: kind in the enum.
  const kind = line.kind ?? "note";
  if (!KINDS.includes(kind)) return refuse("invalid kind");

  mkdirSync(dir, { recursive: true });
  const lock = join(dir, ".lock");
  acquire(lock);
  try {
    const stPath = join(dir, "state.json");
    let state: Record<string, unknown> | null = null;
    if (existsSync(stPath)) {
      try {
        state = JSON.parse(readFileSync(stPath, "utf8"));
      } catch {
        // §1b.9 / F3: an unreadable record accepts nothing, and never a partial log line.
        throw new Error("desk: state.json is unreadable");
      }
    }
    const existing = logLines(dir);
    const already = existing.some((l) => l.date === line.date && l.source === source && l.text === text && (l.kind ?? "note") === kind);
    if (already) return { ok: true, appended: false };

    appendFileSync(logPath(dir), JSON.stringify({ date: line.date, source, text, kind }) + "\n");
    const st = state ?? { project: opts.name ?? slug, slug, revision: 0, updated_at: "", last_touch: "", decisions: [], open_items: [], follow_ups: [] };
    if (opts.name) st.project = opts.name;
    if (!st.slug) st.slug = slug;
    for (const b of ["decisions", "open_items", "follow_ups"]) if (!Array.isArray(st[b])) st[b] = [];
    st.revision = (Number(st.revision) || 0) + 1;
    st.updated_at = nowIso();
    const bucket = KIND_BUCKET[kind];
    if (bucket) (st[bucket] as unknown[]).push({ date: line.date, source, text });
    const lines = logLines(dir);
    st.last_touch = maxDate(lines);
    st.needs = (st.open_items as unknown[]).length + (st.follow_ups as unknown[]).length;
    atomicWrite(stPath, JSON.stringify(st, null, 1));
    // Every project keeps a (possibly empty) refused log, so a refusal has somewhere to land.
    const rp = join(dir, "refused.jsonl");
    if (!existsSync(rp)) atomicWrite(rp, "");
    return { ok: true, appended: true };
  } finally {
    release(lock);
  }
}

const KIND_BUCKET: Record<string, "decisions" | "open_items" | "follow_ups" | undefined> = {
  decision: "decisions",
  open: "open_items",
  follow_up: "follow_ups",
};

/** `ledger_add`: the only writer of the ledger. */
export function ledgerAdd(line: Line, opts: AddOpts): Result {
  const r = apply(line, opts);
  return r.ok ? { ok: true } : r;
}

function addInboxItem(dir: string, item: Record<string, unknown>): void {
  const p = join(dir, "inbox.json");
  const doc = readJson<{ items: unknown[] }>(p, { items: [] });
  if (!Array.isArray(doc.items)) doc.items = [];
  doc.items.push(item);
  atomicWrite(p, JSON.stringify(doc));
}

/** Capture text: one ledger line and one inbox item (§6, ruling 11). */
export function captureText(input: { text?: string; date?: string; source?: string; kind?: string }, opts: AddOpts): Result {
  const r = apply({ date: input.date, source: input.source, text: input.text, kind: input.kind ?? "note" }, opts);
  if (!r.ok) return r;
  if (r.appended) addInboxItem(pdir(opts.root, opts.slug), { at: nowIso(), kind: "text", source: input.source, text: String(input.text ?? "").trim() });
  return { ok: true };
}

/** Capture an image given by file path with a caption: the image is copied in and referenced by path (§6, ruling 11). */
export function captureImage(input: { path?: string; caption?: string; date?: string; source?: string; kind?: string }, opts: AddOpts): Result {
  if (!input.path || !existsSync(input.path)) return { ok: false, reason: "image not found" };
  const r = apply({ date: input.date, source: input.source, text: input.caption, kind: input.kind ?? "follow_up" }, opts);
  if (!r.ok) return r;
  if (r.appended) {
    const dir = pdir(opts.root, opts.slug);
    mkdirSync(join(dir, "inbox"), { recursive: true });
    const name = basename(input.path);
    copyFileSync(input.path, join(dir, "inbox", name));
    addInboxItem(dir, { at: nowIso(), kind: "image", source: input.source, text: String(input.caption ?? "").trim(), image_path: `inbox/${name}` });
  }
  return { ok: true };
}

export type RunInput = {
  run: string;
  outcome: string;
  at: string;
  ms: number;
  tokens: number;
  cost: number;
  stepped_in: boolean;
  egress?: { at: string; what: string; to: string; bytes: number }[];
};

/** Receipts and egress: one row per run from a real run event; a replay of the same run replaces its row (§10, §11). */
export function recordRun(run: RunInput, opts: { root: string; slug: string }): void {
  const dir = pdir(opts.root, opts.slug);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "runs.json");
  const doc = readJson<{ runs: RunInput[] }>(p, { runs: [] });
  if (!Array.isArray(doc.runs)) doc.runs = [];
  const row = { ...run, egress: run.egress ?? [] };
  const i = doc.runs.findIndex((r) => r.run === run.run);
  if (i >= 0) doc.runs[i] = row;
  else doc.runs.push(row);
  atomicWrite(p, JSON.stringify(doc));
}

const readable = (dir: string): boolean => {
  const p = join(dir, "state.json");
  if (!existsSync(p)) return false;
  try {
    JSON.parse(readFileSync(p, "utf8"));
    return true;
  } catch {
    return false;
  }
};

function projectDirs(root: string): string[] {
  const base = join(root, "projects");
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((e) => {
      const d = join(base, e);
      return statSync(d).isDirectory() && (existsSync(join(d, "state.json")) || existsSync(join(d, "log.jsonl")));
    })
    .sort();
}

/**
 * Derive the pages from the record (§1b.3): where-we-left-off, receipts, egress for the project,
 * and projects.json + brief.json across projects. An unreadable record is shown unreadable (§1b.9).
 */
export function deriveViews(root: string, slug: string, opts: { today?: string; windowDays?: number } = {}): void {
  const today = opts.today ?? todayIso();
  const windowDays = opts.windowDays ?? 14;
  const floor = addDays(today, -windowDays);
  const dirs = projectDirs(root);
  for (const s of dirs) deriveProject(root, s, today);
  const dir = pdir(root, slug);
  if (!existsSync(dir)) return;

  const readableDirs = dirs.filter((s) => readable(pdir(root, s)));
  const projects = dirs.map((s) => {
    const d = pdir(root, s);
    if (!readable(d)) return { slug: s, name: readJson<Record<string, unknown>>(join(d, "state.json"), {}).project ?? s, unreadable: true, needs: 0, refused_count: refusalCount(d) };
    const st = readJson<Record<string, unknown>>(join(d, "state.json"), {});
    const last = maxDate(logLines(d)) ?? (typeof st.last_touch === "string" ? st.last_touch : undefined);
    return {
      slug: s,
      name: typeof st.project === "string" ? st.project : s,
      last_touch: last,
      needs: (Array.isArray(st.open_items) ? st.open_items.length : 0) + (Array.isArray(st.follow_ups) ? st.follow_ups.length : 0),
      refused_count: refusalCount(d),
      readable: true,
    };
  });
  mkdirSync(root, { recursive: true });
  atomicWrite(join(root, "projects.json"), JSON.stringify({ projects, today }));

  const lines: Record<string, unknown>[] = [];
  const goneQuiet: Record<string, unknown>[] = [];
  let refused = 0;
  for (const s of readableDirs) {
    const d = pdir(root, s);
    const st = readJson<Record<string, unknown>>(join(d, "state.json"), {});
    refused += refusalCount(d);
    const last = maxDate(logLines(d)) ?? (typeof st.last_touch === "string" ? st.last_touch : today);
    const needs = (Array.isArray(st.open_items) ? st.open_items.length : 0) + (Array.isArray(st.follow_ups) ? st.follow_ups.length : 0);
    for (const l of logLines(d)) {
      if ((l.kind === "open" || l.kind === "follow_up") && l.date && l.source && l.text && l.date >= floor && l.date <= today)
        lines.push({ project: s, date: l.date, source: l.source, text: l.text, kind: l.kind });
    }
    if (needs > 0 && last < floor) goneQuiet.push({ slug: s, name: typeof st.project === "string" ? st.project : s, last_touch: last, quiet_days: Math.round((Date.parse(today) - Date.parse(last)) / 86_400_000), needs });
  }
  lines.sort((a, b) => (String(b.date) + b.project).localeCompare(String(a.date) + a.project));
  goneQuiet.sort((a, b) => String(b.quiet_days).localeCompare(String(a.quiet_days)));
  mkdirSync(join(root, "views"), { recursive: true });
  atomicWrite(join(root, "views", "brief.json"), JSON.stringify({ window_days: windowDays, generated_at: nowIso(), lines, gone_quiet: goneQuiet, refused_count: refused }));
}

function deriveProject(root: string, slug: string, today: string): void {
  const dir = pdir(root, slug);
  mkdirSync(join(dir, "views"), { recursive: true });
  if (!readable(dir)) {
    atomicWrite(join(dir, "views", "where-we-left-off.json"), JSON.stringify({ project: slug, slug, unreadable: true, refused_count: refusalCount(dir) }));
    return;
  }
  const st = readJson<Record<string, unknown>>(join(dir, "state.json"), {});
  const lines = logLines(dir);
  const last = maxDate(lines) ?? (typeof st.last_touch === "string" ? st.last_touch : today);
  const fact = (k: string) => (Array.isArray(st[k]) ? st[k] : []);
  atomicWrite(
    join(dir, "views", "where-we-left-off.json"),
    JSON.stringify({
      project: typeof st.project === "string" ? st.project : slug,
      slug,
      gap_days: Math.round((Date.parse(today) - Date.parse(last)) / 86_400_000),
      last_touch: last,
      needs: (st.open_items as unknown[] ?? []).length + (st.follow_ups as unknown[] ?? []).length,
      refused_count: refusalCount(dir),
      decisions: fact("decisions"),
      open_items: fact("open_items"),
      follow_ups: fact("follow_ups"),
    }),
  );
  const runs = readJson<{ runs: RunInput[] }>(join(dir, "runs.json"), { runs: [] }).runs ?? [];
  atomicWrite(join(dir, "views", "receipts.json"), JSON.stringify({ runs: runs.map((r) => ({ run: r.run, outcome: r.outcome, at: r.at, ms: r.ms, tokens: r.tokens, cost: r.cost, stepped_in: r.stepped_in })) }));
  const rows: Record<string, unknown>[] = [];
  let noneRows = 0;
  for (const r of runs) {
    const eg = Array.isArray(r.egress) ? r.egress : [];
    if (eg.length) for (const e of eg) rows.push({ run: r.run, at: e.at, what: e.what, where: e.to, bytes: e.bytes, why: "egress during run" });
    else {
      noneRows += 1;
      rows.push({ run: r.run, at: r.at, what: "nothing", where: "—", why: "this run made no outbound call" });
    }
  }
  atomicWrite(join(dir, "views", "egress.json"), JSON.stringify({ rows, none_rows: noneRows }));
}

/** §1b.8: deny a tool call whose resolved target is a record file. `write`/`edit`/`bash` cannot reach the ledger. */
export function guardToolCall(toolName: string, args: Record<string, unknown> | undefined, opts: { root: string }): { block: boolean; reason?: string } {
  const blocked = (reason: string) => ({ block: true, reason });
  if (toolName === "write" || toolName === "edit") {
    const path = String((args?.path as string) ?? "");
    if (path && RECORD_NAMES.has(basename(resolve(opts.root, path)))) return blocked("record file");
    return { block: false };
  }
  if (toolName === "bash") {
    const cmd = String((args?.command as string) ?? "");
    if ([...RECORD_NAMES].some((n) => cmd.includes(n))) return blocked("command touches a record file");
    return { block: false };
  }
  return { block: false };
}

/** The desk root the tool writes to; the fixture lives inside the clone during development. */
const deskRoot = () => process.env.DESK_ROOT ?? join(homedir(), "Desk");

const ledgerAddTool = defineTool({
  name: "ledger_add",
  description:
    "Add one dated, sourced line to a project's ledger. The only writer of log.jsonl and state.json. Refuses a line with no real date, no date-bearing source, an out-of-enum kind, or a date earlier than its source date. A refused line is never written to the ledger.",
  parameters: Type.Object({
    project: Type.String({ description: "The project slug (its folder under the desk root)." }),
    text: Type.String({ description: "The line itself." }),
    date: Type.Optional(Type.String({ description: "The line's date, YYYY-MM-DD." })),
    source: Type.Optional(Type.String({ description: "Where the line came from; must name its own date." })),
    kind: Type.Optional(Type.String({ description: "decision | open | follow_up | note" })),
    name: Type.Optional(Type.String({ description: "The project's display name." })),
  }),
  replay: "safe",
  execute: async (args) => {
    const root = deskRoot();
    const a = args as Record<string, unknown>;
    const result = ledgerAdd(a as Line, { root, slug: String(a.project), name: a.name as string | undefined });
    if (!result.ok) return { content: [{ type: "text" as const, text: `refused: ${result.reason}` }] };
    deriveViews(root, String(a.project));
    return { content: [{ type: "text" as const, text: `added to ${String(a.project)}` }] };
  },
});

/** The extension `addons.ts` registers; its one tool is `ledger_add`. */
export const deskAddon: Extension = defineExtension({ name: "desk", tools: [ledgerAddTool] });
