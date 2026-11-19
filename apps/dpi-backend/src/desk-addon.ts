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
import { homedir, hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { defineExtension, defineTool, hook, ToolTask, type Extension } from "@earendil-works/pi-durable";
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

// ---------------------------------------------------------------- the single-writer lock (§1b.7)
//
// A per-project directory `<slug>/.lock`, taken with mkdir (atomic on every filesystem the desk
// runs on) and held across the whole read-modify-write. A crashed writer must not wedge the project
// forever, but a *live* writer that is merely slow must never have its lock taken away — that would
// put two writers on one ledger, which is the one thing §1b.7 exists to prevent.
//
// So the discriminator is **liveness, never age**. The holder writes an owner record
// `{pid, host, at}` inside the lock. A waiter may reclaim the lock only when it can *prove* the
// owner is gone:
//   * owner on this host and `kill(pid, 0)` says ESRCH  -> dead    -> reclaim;
//   * owner on this host and the pid answers (or EPERM) -> alive   -> **keep waiting, however old
//     the lock is**; slowness is not evidence of death;
//   * owner names another host -> not provable here -> never reclaim (the desk is one machine);
//   * no owner at all -> age past a short grace window only, which covers the microseconds between
//     `mkdir` and the owner write, not a slow writer.
// Reclaiming is itself atomic: the stale dir is renamed to a unique tombstone, so of N waiters that
// all decide a lock is stale, exactly one rename wins and the others loop — a reclaim can never
// delete a lock another writer has just re-taken.
const HOST = hostname();
const LOCK_WAIT_MS = 15_000; // how long a waiter honours a live owner before it gives up (it never breaks it)
const LOCK_GRACE_MS = 5_000; // mkdir -> owner write is microseconds; this only covers a crash in between
const LOCK_OWNER_FILES = ["owner", "pid", "info"];

type Owner = { pid: number; host: string; at: string };
/** What a waiter saw, and *which directory* it saw it in — the decision is only good for that inode. */
type Verdict = { why: "dead-pid" | "no-owner-old"; ino: number };

function lockAgeMs(lock: string): number {
  try {
    return Date.now() - statSync(lock).mtimeMs;
  } catch {
    return 0;
  }
}
function devIno(p: string): number {
  try {
    return statSync(p).ino;
  } catch {
    return 0;
  }
}
function readOwner(lock: string): Owner | null {
  for (const n of LOCK_OWNER_FILES) {
    const p = join(lock, n);
    if (!existsSync(p)) continue;
    let raw = "";
    try {
      raw = readFileSync(p, "utf8").trim();
    } catch {
      continue;
    }
    if (!raw) continue;
    try {
      const j = JSON.parse(raw) as Partial<Owner>;
      if (j && typeof j.pid === "number") return { pid: j.pid, host: typeof j.host === "string" ? j.host : HOST, at: String(j.at ?? "") };
    } catch {
      /* not JSON: fall through to a bare pid */
    }
    const pid = Number.parseInt(raw, 10);
    if (Number.isInteger(pid)) return { pid, host: HOST, at: "" };
  }
  return null;
}
/** Does the process named by the lock still exist? Signal 0 asks, it does not deliver. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, just not ours
  }
}
/** Inspect a lock: `null` means "not provably dead — leave it alone". */
function inspectLock(lock: string): Verdict | null {
  const ino = devIno(lock);
  if (!ino) return null; // gone already
  const o = readOwner(lock);
  if (o) {
    if (o.host !== HOST) return null; // cannot prove a remote owner dead -> never reclaim
    return pidAlive(o.pid) ? null : { why: "dead-pid", ino };
  }
  return lockAgeMs(lock) > LOCK_GRACE_MS ? { why: "no-owner-old", ino } : null;
}
/**
 * Break a lock we proved dead. The read and the rename are separated in time, so the rename is only
 * allowed to stand if the directory it moved is *the same directory* the verdict was about, and its
 * owner is still not a live writer on this host. Otherwise the lock is put back and the waiter keeps
 * waiting: a reclaim may never take a lock away from a writer that is alive.
 */
function stealStaleLock(lock: string, v: Verdict): boolean {
  const tomb = `${lock}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(lock, tomb);
  } catch {
    return false; // someone else won the reclaim, or the lock is gone; loop and re-check
  }
  const o = readOwner(tomb);
  const sameDir = devIno(tomb) === v.ino;
  const stillDead = o ? !(o.host === HOST && pidAlive(o.pid)) : v.why === "dead-pid" ? false : true;
  if (sameDir && stillDead) {
    rmSync(tomb, { recursive: true, force: true });
    return true;
  }
  // We moved a lock that is not the dead one we judged (or its owner came back): put it back.
  for (let i = 0; i < 250; i++) {
    try {
      renameSync(tomb, lock);
      return false;
    } catch {
      sleep(2);
    }
  }
  rmSync(tomb, { recursive: true, force: true });
  return false;
}
/** A single exclusive lock per project, held across the read-modify-write (across processes too). */
function acquire(lock: string): void {
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const v = inspectLock(lock);
      if (v && stealStaleLock(lock, v)) continue;
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error("desk: lock timeout");
      sleep(2);
      continue;
    }
    const mine = devIno(lock);
    try {
      atomicWrite(join(lock, "owner"), JSON.stringify({ pid: process.pid, host: HOST, at: nowIso() }) + "\n");
      return;
    } catch (e) {
      // The owner write failed. If the directory is still the one we made, it is ours to clean up;
      // if it is gone or replaced, we never held the lock and must not touch whatever is there now.
      if (devIno(lock) === mine) release(lock);
      else continue;
      throw e;
    }
  }
}
const release = (lock: string) => {
  for (let i = 0; i < 50; i++) {
    try {
      rmSync(lock, { recursive: true, force: true });
    } catch {
      /* retry */
    }
    if (!existsSync(lock)) return;
    sleep(1);
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
    // state.json is an *index of the log*, recomputed from it rather than accumulated: the log is the
    // record and holds nothing but appended lines, so no interleaving can drop a fact. `revision` is
    // the record's length, which is what makes a replay leave it unchanged.
    const lines = logLines(dir);
    const facts = (k: string) => lines.filter((l) => (l.kind ?? "note") === k).map((l) => ({ date: l.date, source: l.source, text: l.text }));
    const open = facts("open");
    const followUps = facts("follow_up");
    st.decisions = facts("decision");
    st.open_items = open;
    st.follow_ups = followUps;
    st.revision = lines.length;
    st.updated_at = nowIso();
    st.last_touch = maxDate(lines);
    st.needs = open.length + followUps.length;
    atomicWrite(stPath, JSON.stringify(st, null, 1));
    // Every project keeps a (possibly empty) refused log, so a refusal has somewhere to land.
    const rp = join(dir, "refused.jsonl");
    if (!existsSync(rp)) atomicWrite(rp, "");
    return { ok: true, appended: true };
  } finally {
    release(lock);
  }
}

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
    // Two captures can share a file name; each must keep its own bytes. On a collision the stored
    // name takes the content's own short hash, so no capture overwrites or shadows another.
    const bytes = readFileSync(input.path);
    const name = basename(input.path);
    let stored = join(dir, "inbox", name);
    if (existsSync(stored) && !readFileSync(stored).equals(bytes)) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      stored = join(dir, "inbox", `${stem}-${createHash("sha256").update(bytes).digest("hex").slice(0, 8)}${ext}`);
    }
    copyFileSync(input.path, stored);
    addInboxItem(dir, { at: nowIso(), kind: "image", source: input.source, text: String(input.caption ?? "").trim(), image_path: `inbox/${basename(stored)}` });
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
const GUARD_REASON = "the desk's ledger is written only through ledger_add";

/** Everything under `<root>/projects/`, plus the code-derived pages. Only this add-on writes there. */
function insideDesk(p: string, root: string): boolean {
  return (
    p === join(root, "projects.json") ||
    p.startsWith(join(root, "projects") + "/") ||
    p === join(root, "projects") ||
    p.startsWith(join(root, "views") + "/")
  );
}
/** Could this shell word name (or, with a glob, expand to) a record file or the lock? */
function namesRecord(word: string): boolean {
  const base = basename(word.replace(/^['"]|['"]$/g, ""));
  if (!base) return false;
  if (base.startsWith(".lock")) return true;
  const rx = new RegExp("^" + base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  return [...RECORD_NAMES].some((n) => rx.test(n));
}
/** Commands that only read their file arguments: naming a record file with one of these is not a write. */
const READERS = new Set([
  "cat", "head", "tail", "less", "more", "tac", "nl", "wc", "grep", "egrep", "fgrep", "rg", "ls", "find", "stat", "file", "jq", "sort", "uniq", "cut", "tr", "column", "sha256sum", "shasum", "md5", "md5sum", "diff", "tree", "du", "basename", "dirname", "pwd", "date", "echo", "printf", "true", "false", "test", "[", "which", "type", "sed", "awk",
  // `sed`/`awk` are filters here; an in-place (`-i`) form is handled separately.
]);
/** Verbs whose *last* word is a destination, so a copy out of the desk is not a write into it. */
const COPY_OUT = new Set(["cp", "rsync", "scp"]);
/** bash commands that destroy a tree outright. */
function destroys(cmd: string): boolean {
  return /(^|[\s|;&(])(rm|rmdir|mv|truncate|shred|unlink|dd|chmod|chown)(\s|$)/.test(cmd);
}

/**
 * The runtime guard (§1b.8): the ledger's record files are the add-on's to write, never a tool's.
 * Reads are allowed — `cat log.jsonl` is how a person inspects the desk; only a *write* is blocked.
 */
export function guardToolCall(toolName: string, args: Record<string, unknown> | undefined, opts: { root: string }): { block: boolean; reason?: string } {
  const blocked = (reason: string) => ({ block: true, reason });
  const root = opts.root;
  if (toolName === "write" || toolName === "edit") {
    const path = String((args?.path as string) ?? (args?.file_path as string) ?? (args?.filePath as string) ?? "");
    if (!path) return { block: false };
    // The record files and the lock are the add-on's; a note written beside them is nobody's business.
    const target = resolve(root, path);
    if (RECORD_NAMES.has(basename(target)) || basename(target).startsWith(".lock")) return blocked(GUARD_REASON);
    return { block: false };
  }
  if (toolName === "bash") {
    const cmd = String((args?.command as string) ?? "");
    if (!cmd.trim()) return { block: false };
    const strip = (w: string) => w.replace(/^['"]|['"]$/g, "");
    const words = cmd.split(/[\s|;&()+<>=]+/).filter(Boolean);
    const touches = (w: string) => namesRecord(w) || insideDesk(resolve(root, strip(w)), root);
    // 1. a redirection whose target is a record file or anything inside the desk.
    for (const m of cmd.matchAll(/>>?\s*([^\s&|;>]+)/g)) if (touches(m[1])) return blocked(GUARD_REASON);
    // 2. a command that is not a plain read, aimed at a record file or the desk tree. `cat log.jsonl`
    //    and `cat log.jsonl > /tmp/backup` are reads of the record and are allowed; `cp log out` is a
    //    copy out and is allowed; everything else that reaches inside the desk is a write.
    const verb = strip(words[0] ?? "").replace(/^.*\//, "");
    const inPlace = /\b(sed|perl|ruby|awk)\b[\s\S]*\s-i/.test(cmd);
    const plainlyReads = READERS.has(verb) && !inPlace;
    const namesRecordish = [...RECORD_NAMES].some((n) => cmd.includes(n)) || /\.lock\b/.test(cmd);
    if (!plainlyReads && (words.some(touches) || namesRecordish || destroys(cmd))) {
      const dest = strip(words[words.length - 1] ?? "");
      const copiesOut = COPY_OUT.has(verb) && !insideDesk(resolve(root, dest), root) && !namesRecord(dest);
      if (!copiesOut) return blocked(GUARD_REASON);
    }
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

/** The extension `addons.ts` registers: `ledger_add`, plus the guard wired as a `beforeTool` hook. */
export const deskAddon: Extension = defineExtension({
  name: "desk",
  tools: [ledgerAddTool],
  hooks: [
    hook(ToolTask, {
      beforeTool: (call) => {
        const v = guardToolCall(call.name, call.arguments as Record<string, unknown>, { root: deskRoot() });
        return v.block ? { block: v.reason ?? GUARD_REASON } : undefined;
      },
    }),
  ],
});
