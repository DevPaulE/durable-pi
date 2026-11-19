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
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { defineExtension, defineTool, hook, ToolTask, type Extension } from "@earendil-works/pi-durable";
import { Type } from "typebox";

export type Line = {
  date?: string;
  source?: string;
  text?: string;
  kind?: string;
  /** Acceptance time. Ignored by the duplicate check so a retry of the same line is not a second line. */
  at?: string;
  /** Set on a capture line, so the inbox item is recoverable from the log line alone. */
  capture?: "text" | "image";
  image_path?: string;
  /** The project's display name; the latest line that carries one wins. */
  name?: string;
};
export type AddOpts = { root: string; slug: string; name?: string; today?: string };
export type Result = { ok: true; appended?: boolean } | { ok: false; reason: string };

const KINDS = ["decision", "open", "follow_up", "note"];
const SLUG_RE = /^[a-z0-9-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RECORD_NAMES = new Set(["log.jsonl", "state.json", "refused.jsonl"]);

/**
 * A ledger line is a note, not a document. A 20 MB line is a page of noise in a record the desk
 * renders as JSON and rebuilds into every view, so one line is capped at the same 256 KiB the desk
 * already refuses on its own request body (`express.json({ limit: "256kb" })` in main.ts). Refused
 * like any other bad line: to `refused.jsonl`, reason and size, never the text (§1b.2, amendment A).
 */
export const MAX_TEXT_BYTES = 256 * 1024;

/**
 * Characters that carry no text at all: zero-width space, word joiner, zero-width no-break
 * space (BOM), soft hyphen. Removed before a line is compared, so a line that only differs by one
 * of them is recognised as the same line. ZWNJ/ZWJ (U+200C/200D) are deliberately kept: they are
 * meaningful in some scripts and in emoji sequences, so dropping them could swallow a real
 * difference between two lines.
 */
const INVISIBLE_RE = /[\u00AD\u200B\u2060\uFEFF]/g;

/**
 * How a line is compared for duplication: NFC (so an accent written as one code point or two is the
 * same line), no invisible characters, no surrounding whitespace. It is a comparison key only — the
 * text is stored exactly as given (trimmed), so the record keeps the bytes the writer sent.
 */
const canonicalText = (s: unknown): string => String(s ?? "").normalize("NFC").replace(INVISIBLE_RE, "").trim();

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
/** Does the file end in a newline (an empty or absent file counts as terminated)? */
function endsWithNewline(p: string): boolean {
  let fd: number | undefined;
  try {
    const st = statSync(p);
    if (st.size === 0) return true;
    fd = openSync(p, "r");
    const b = Buffer.alloc(1);
    readSync(fd, b, 0, 1, st.size - 1);
    return b[0] === 0x0a;
  } catch {
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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
  // The verdict was made about one directory at one moment. Re-check *immediately* before the
  // rename: still the same inode, and its owner still not a live process. Otherwise the directory
  // we are about to move may be a lock another writer has just taken.
  if (devIno(lock) !== v.ino) return false;
  const now = readOwner(lock);
  if (now && now.host === HOST && pidAlive(now.pid)) return false;
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
function acquire(lock: string): number {
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
      return mine;
    } catch (e) {
      // The owner write failed. If the directory is still the one we made, it is ours to clean up;
      // if it is gone or replaced, we never held the lock and must not touch whatever is there now.
      if (devIno(lock) === mine) release(lock, mine);
      else continue;
      throw e;
    }
  }
}
/**
 * Release *our* lock and only our lock. The retry loop must stop as soon as the directory at the
 * lock path is no longer the one this process created: a `force` remove would otherwise delete the
 * next holder's fresh lock, and two writers would be inside the read-modify-write at once.
 */
const release = (lock: string, mine: number) => {
  if (!mine) return;
  for (let i = 0; i < 50; i++) {
    if (devIno(lock) !== mine) return; // gone, or someone else's lock is here now — never touch it
    try {
      rmSync(lock, { recursive: true, force: true });
    } catch {
      /* retry */
    }
    if (devIno(lock) !== mine) return;
    sleep(1);
  }
};

type ApplyResult = { ok: true; appended: boolean } | { ok: false; reason: string };

const statePath = (dir: string) => join(dir, "state.json");
const inboxPath = (dir: string) => join(dir, "inbox.json");

/**
 * Read the record. `log.jsonl` is the only record; `state.json` is a cache. Its *readability* is the
 * desk's readability gate (§1b.9): a cache that cannot be parsed means the desk cannot prove the
 * record is intact, so the project is shown unreadable and nothing is invented from it.
 */
function readRecord(dir: string): { lines: Line[]; unreadable: string | null; name: string | null; tornAt?: number } {
  const st = statePath(dir);
  let cached: string | null = null;
  if (existsSync(st)) {
    try {
      const parsed = JSON.parse(readFileSync(st, "utf8")) as { project?: unknown };
      cached = typeof parsed?.project === "string" ? parsed.project : null;
    } catch {
      return { lines: [], unreadable: "state.json is unreadable", name: null };
    }
  }
  const lp = logPath(dir);
  if (!existsSync(lp)) {
    if (existsSync(st)) return { lines: [], unreadable: "log.jsonl is missing", name: cached };
    return { lines: [], unreadable: null, name: cached };
  }
  const lines: Line[] = [];
  const raw = readFileSync(lp);
  const text = raw.toString("utf8");
  const rows = text.split("\n");
  // A torn final line: the file does not end in a newline and its last row does not parse. It is a
  // crashed append, not corruption — ignored on read, truncated away before the next add.
  let tornAt: number | undefined;
  if (!text.endsWith("\n") && rows[rows.length - 1].trim()) {
    const last = rows[rows.length - 1];
    let ok = true;
    try {
      const l = JSON.parse(last);
      if (!l || typeof l !== "object" || Array.isArray(l)) ok = false;
    } catch {
      ok = false;
    }
    if (!ok) {
      tornAt = Buffer.byteLength(text.slice(0, text.length - last.length), "utf8");
      rows.pop();
    }
  }
  for (const row of rows) {
    if (!row.trim()) continue;
    try {
      const l = JSON.parse(row) as Line;
      if (!l || typeof l !== "object" || Array.isArray(l)) throw new Error("not a line");
      lines.push(l);
    } catch {
      return { lines: [], unreadable: "log.jsonl is unreadable", name: cached };
    }
  }
  // The name lives in the log too, so the record alone rebuilds it; the cache is only a fallback.
  const named = lines.filter((l) => typeof l.name === "string" && l.name.trim()).pop();
  return { lines, unreadable: null, name: named?.name ?? cached, tornAt };
}

const factsOf = (lines: Line[], kind: string) =>
  lines.filter((l) => (l.kind ?? "note") === kind).map((l) => ({ date: l.date, source: l.source, text: l.text }));

/**
 * Two lines are the same ledger line when everything but the acceptance time matches, and their text
 * and source match after canonicalisation. Byte-exactness was the defect: a trailing space, an
 * NFC-vs-NFD accent and a zero-width space each appended a second copy of one line. A genuinely
 * different line (a different word, a different case) still compares different.
 */
const sameLine = (a: Line, b: Line): boolean =>
  a.date === b.date &&
  canonicalText(a.source) === canonicalText(b.source) &&
  canonicalText(a.text) === canonicalText(b.text) &&
  (a.kind ?? "note") === (b.kind ?? "note") &&
  (a.capture ?? null) === (b.capture ?? null) &&
  (a.image_path ?? null) === (b.image_path ?? null);

export type Summary = { slug: string; name: string; readable: boolean; last_touch?: string; needs?: number; refused_count: number };

/**
 * Rebuild one project's caches from its log. No fact is ever read out of a cache: the facts come from
 * `log.jsonl`, so a wrong or stale cache cannot reach a page. An unreadable cache/record yields an
 * unreadable page with no numbers in it.
 */
function rebuildProject(root: string, slug: string, today: string): Summary {
  const dir = pdir(root, slug);
  mkdirSync(join(dir, "views"), { recursive: true });
  const rec = readRecord(dir);
  const refused = refusalCount(dir);
  if (rec.unreadable) {
    atomicWrite(join(dir, "views", "where-we-left-off.json"), JSON.stringify({ project: slug, slug, unreadable: true, refused_count: refused }));
    return { slug, name: slug, readable: false, refused_count: refused };
  }
  const lines = rec.lines;
  const name = rec.name ?? slug;
  const decisions = factsOf(lines, "decision");
  const open = factsOf(lines, "open");
  const follow = factsOf(lines, "follow_up");
  const last = maxDate(lines);
  const needs = open.length + follow.length;

  atomicWrite(
    statePath(dir),
    JSON.stringify(
      { project: name, slug, revision: lines.length, updated_at: nowIso(), ...(last ? { last_touch: last } : {}), decisions, open_items: open, follow_ups: follow, needs },
      null,
      1,
    ),
  );

  // A capture's inbox item is recovered from its log line alone: `capture` marks it, `at` time-stamps it,
  // `image_path` names the stored image. No separate inbox write is needed or trusted.
  const items = lines
    .filter((l) => l.capture)
    .map((l) => ({ at: l.at ?? "", kind: l.capture === "image" ? "image" : "text", source: l.source, text: l.text, ...(l.image_path ? { image_path: l.image_path } : {}) }));
  if (items.length || existsSync(inboxPath(dir))) atomicWrite(inboxPath(dir), JSON.stringify({ items }));

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

  atomicWrite(
    join(dir, "views", "where-we-left-off.json"),
    JSON.stringify({
      project: name,
      slug,
      ...(last ? { gap_days: Math.max(0, Math.round((Date.parse(today) - Date.parse(last)) / 86_400_000)) } : {}),
      ...(last ? { last_touch: last } : {}),
      needs,
      refused_count: refused,
      decisions,
      open_items: open,
      follow_ups: follow,
    }),
  );
  return { slug, name, readable: true, ...(last ? { last_touch: last } : {}), needs, refused_count: refused };
}

/** Rebuild every cache in the desk from the logs, then the nav index and the brief. */
function rebuildAll(root: string, today: string, windowDays = 14): Summary[] {
  const floor = addDays(today, -windowDays);
  const summaries: Summary[] = projectDirs(root).map((s) => rebuildProject(root, s, today));
  const projects = summaries.map((s) =>
    s.readable
      ? { slug: s.slug, name: s.name, ...(s.last_touch ? { last_touch: s.last_touch } : {}), needs: s.needs ?? 0, refused_count: s.refused_count, readable: true }
      : { slug: s.slug, name: s.name, unreadable: true, refused_count: s.refused_count },
  );
  mkdirSync(root, { recursive: true });
  atomicWrite(join(root, "projects.json"), JSON.stringify({ projects, today }));

  const lines: Record<string, unknown>[] = [];
  const goneQuiet: Record<string, unknown>[] = [];
  let refused = 0;
  for (const s of summaries) {
    if (!s.readable) continue;
    refused += s.refused_count;
    const last = s.last_touch ?? today;
    for (const l of readRecord(pdir(root, s.slug)).lines) {
      if ((l.kind === "open" || l.kind === "follow_up") && l.date && l.source && l.text && l.date >= floor && l.date <= today)
        lines.push({ project: s.slug, date: l.date, source: l.source, text: l.text, kind: l.kind });
    }
    if ((s.needs ?? 0) > 0 && last < floor) goneQuiet.push({ slug: s.slug, name: s.name, last_touch: last, quiet_days: Math.round((Date.parse(today) - Date.parse(last)) / 86_400_000), needs: s.needs });
  }
  lines.sort((a, b) => (String(b.date) + b.project).localeCompare(String(a.date) + a.project));
  goneQuiet.sort((a, b) => String(b.quiet_days).localeCompare(String(a.quiet_days)));
  mkdirSync(join(root, "views"), { recursive: true });
  atomicWrite(join(root, "views", "brief.json"), JSON.stringify({ window_days: windowDays, generated_at: nowIso(), lines, gone_quiet: goneQuiet, refused_count: refused }));
  return summaries;
}

/** Validation only; returns the refusal reason or null. Kept separate so a capture can fail before it writes. */
function validateLine(line: Line, today: string): string | null {
  const raw = String(line.text ?? "");
  if (Buffer.byteLength(raw, "utf8") > MAX_TEXT_BYTES) return "text too long";
  if (!canonicalText(raw)) return "empty text";
  if (!line.date || !isRealDate(line.date)) return "invalid date";
  if (line.date > today) return "date after today";
  const source = line.source;
  if (typeof source !== "string" || !source.trim()) return "missing source";
  const sdates = sourceDates(source);
  if (!sdates.length) return "source names no date";
  if (line.date < sdates.sort()[0]) return "date precedes source";
  if (!KINDS.includes(line.kind ?? "note")) return "invalid kind";
  return null;
}

/**
 * The one writer. Validates, then under the project lock appends the log line (unless an identical
 * line is already there) and rebuilds every cache from the log — a duplicate retry included, so a
 * retry after a crash reconciles the caches instead of leaving them stale.
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
    const rp = join(dir, "refused.jsonl");
    appendFileSync(rp, (endsWithNewline(rp) ? "" : "\n") + JSON.stringify({ at: nowIso(), reason, chars: text.length, sha256: sha256(text) }) + "\n");
    return { ok: false, reason };
  };

  const bad = validateLine({ ...line, text }, today);
  if (bad) return refuse(bad);
  const kind = line.kind ?? "note";
  const source = String(line.source).trim();

  mkdirSync(dir, { recursive: true });
  const lock = join(dir, ".lock");
  const mine = acquire(lock);
  try {
    const rec = readRecord(dir);
    if (rec.unreadable) throw new Error(`desk: ${rec.unreadable}`);
    if (rec.tornAt !== undefined) truncateSync(logPath(dir), rec.tornAt);
    const already = rec.lines.some((l) => sameLine(l, { ...line, text, kind }));
    if (!already) {
      // A complete JSON row with no trailing newline is a valid record, not a torn one. Terminate it
      // with exactly one `\n` before appending, or the new row would be glued onto the old one and
      // the whole ledger would become unreadable. No other byte is touched.
      const lp = logPath(dir);
      appendFileSync(
        lp,
        (endsWithNewline(lp) ? "" : "\n") +
          JSON.stringify({
          date: line.date,
          source,
          text,
          kind,
          at: nowIso(),
          ...(line.capture ? { capture: line.capture } : {}),
          ...(line.image_path ? { image_path: line.image_path } : {}),
          ...(opts.name ? { name: opts.name } : {}),
        }) + "\n",
      );
    }
    const rp = join(dir, "refused.jsonl");
    if (!existsSync(rp)) atomicWrite(rp, "");
    rebuildAll(root, today);
    return { ok: true, appended: !already };
  } finally {
    release(lock, mine);
  }
}

/** `ledger_add`: the only writer of the ledger. */
export function ledgerAdd(line: Line, opts: AddOpts): Result {
  const r = apply(line, opts);
  return r.ok ? { ok: true, appended: r.appended } : r;
}

/** Capture text: one ledger line carrying `capture:"text"`; the inbox item is rebuilt from it. */
export function captureText(input: { text?: string; date?: string; source?: string; kind?: string }, opts: AddOpts): Result {
  const r = apply({ date: input.date, source: input.source, text: input.text, kind: input.kind ?? "note", capture: "text" }, opts);
  return r.ok ? { ok: true } : r;
}

/** Capture an image given by path: the image is stored first (an orphan is harmless), then the log line. */
export function captureImage(input: { path?: string; caption?: string; date?: string; source?: string; kind?: string }, opts: AddOpts): Result {
  if (!input.path || !existsSync(input.path)) return { ok: false, reason: "image not found" };
  const today = opts.today ?? todayIso();
  const bad = validateLine({ date: input.date, source: input.source, text: input.caption, kind: input.kind ?? "follow_up" }, today);
  if (bad) return { ok: false, reason: bad };
  const dir = pdir(opts.root, opts.slug);
  mkdirSync(join(dir, "inbox"), { recursive: true });
  const bytes = readFileSync(input.path);
  const ext = extname(input.path);
  let target = join(dir, "inbox", basename(input.path));
  if (existsSync(target) && !readFileSync(target).equals(bytes)) target = join(dir, "inbox", `${basename(input.path, ext)}-${sha256(bytes.toString("latin1")).slice(0, 8)}${ext}`);
  if (!existsSync(target)) copyFileSync(input.path, target);
  const r = apply({ date: input.date, source: input.source, text: input.caption, kind: input.kind ?? "follow_up", capture: "image", image_path: `inbox/${basename(target)}` }, opts);
  return r.ok ? { ok: true } : r;
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
  const lock = join(dir, ".lock");
  const mine = acquire(lock);
  try {
    const doc = readJson<{ runs: RunInput[] }>(p, { runs: [] });
    if (!Array.isArray(doc.runs)) doc.runs = [];
    const row = { ...run, egress: run.egress ?? [] };
    const i = doc.runs.findIndex((r) => r.run === run.run);
    if (i >= 0) doc.runs[i] = row;
    else doc.runs.push(row);
    atomicWrite(p, JSON.stringify(doc));
  } finally {
    release(lock, mine);
  }
}

function projectDirs(root: string): string[] {
  const base = join(root, "projects");
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((e) => {
      const d = join(base, e);
      try {
        return statSync(d).isDirectory() && (existsSync(join(d, "state.json")) || existsSync(join(d, "log.jsonl")));
      } catch {
        return false;
      }
    })
    .sort();
}

/** Derive the pages from the record: every cache is rebuilt from the logs, then the views are written. */
export function deriveViews(root: string, slug: string, opts: { today?: string; windowDays?: number } = {}): void {
  rebuildAll(root, opts.today ?? todayIso(), opts.windowDays ?? 14);
}

/** §1b.8: deny a tool call whose resolved target is a record file. `write`/`edit`/`bash` cannot reach the ledger. */
const GUARD_REASON = "the desk's ledger is written only through ledger_add";
const READ_REASON = "a seat may read only what lives under the desk root";

/** Resolve a path through symlinks, falling back to its nearest existing ancestor for a missing leaf. */
function realOrParent(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p;
    return join(realOrParent(parent), basename(p));
  }
}
/**
 * Does this path resolve to a record file or the lock? A symlink is followed to its target first; a
 * hard link keeps its own name, so the resolved file is also compared by device+inode with the
 * record files beside it. A name check alone would let either one through.
 */
function isRecordPath(p: string, root: string): boolean {
  const real = realOrParent(p);
  const base = basename(real);
  if (base.startsWith(".lock") || RECORD_NAMES.has(base)) return true;
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(real);
  } catch {
    return false;
  }
  const same = (q: string) => {
    try {
      const s = statSync(q);
      return s.dev === st.dev && s.ino === st.ino;
    } catch {
      return false;
    }
  };
  // A hard link can live anywhere: compare the resolved file with the records beside it *and* with
  // every record file in the desk. A file with no other links cannot be one of them.
  if (st.nlink < 2) return false;
  for (const n of [...RECORD_NAMES, ".lock"]) if (same(join(dirname(real), n))) return true;
  const base_dir = join(root, "projects");
  if (!existsSync(base_dir)) return false;
  for (const e of readdirSync(base_dir)) {
    for (const n of [...RECORD_NAMES, ".lock"]) if (same(join(base_dir, e, n))) return true;
  }
  return false;
}

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

/** The path a call carries: `read`, `write` and `edit` spell it `path`, `file_path` or `filePath`. */
function pathArg(args: Record<string, unknown> | undefined): unknown {
  if (!args) return undefined;
  for (const key of ["path", "file_path", "filePath"]) if (args[key] !== undefined) return args[key];
  return undefined;
}

/**
 * The read half of the guard (§1b.8): a seat may read what the desk *holds* — anything that really
 * lives under the desk root — and nothing else. The path is resolved against the desk root and then
 * resolved through symlinks, so a symlink that sits inside the desk but points outside it is refused,
 * and a sibling directory whose name merely starts with the root's name is not inside it. A target
 * that does not exist is resolved through its nearest existing ancestor, so "it does not exist" is
 * never mistaken for "it is inside". An empty or non-string path is refused: a call the desk cannot
 * place is not a call it should allow, and refusing it must not throw.
 */
function readConfined(p: unknown, root: string): boolean {
  if (typeof p !== "string" || !p.trim()) return false;
  const realRoot = realOrParent(root);
  const realTarget = realOrParent(resolve(root, p));
  return realTarget.startsWith(realRoot + sep);
}

/**
 * The runtime guard (§1b.8). Three policies, by tool:
 *   * `read` is confined to the desk root (`readConfined`): the seat reads the desk, not the host.
 *   * `write`/`edit` may not touch the record files or the lock.
 *   * `bash` may not write into the desk tree (a plain read of a record file is still allowed).
 * The hook's default-deny filter sits above this; nothing here is reached for an unknown tool.
 */
export function guardToolCall(toolName: string, args: Record<string, unknown> | undefined, opts: { root: string }): { block: boolean; reason?: string } {
  const blocked = (reason: string) => ({ block: true, reason });
  const root = opts.root;
  if (toolName === "read") {
    // A read the desk cannot confine to its own root is refused, whatever argument spelling it used.
    if (!readConfined(pathArg(args), root)) return blocked(READ_REASON);
    return { block: false };
  }
  if (toolName === "write" || toolName === "edit") {
    const path = String((args?.path as string) ?? (args?.file_path as string) ?? (args?.filePath as string) ?? "");
    if (!path) return { block: false };
    // The record files and the lock are the add-on's; a note written beside them is nobody's business.
    const target = resolve(root, path);
    if (isRecordPath(target, root)) return blocked(GUARD_REASON);
    return { block: false };
  }
  if (toolName === "bash") {
    const cmd = String((args?.command as string) ?? "");
    if (!cmd.trim()) return { block: false };
    const strip = (w: string) => w.replace(/^['"]|['"]$/g, "");
    const words = cmd.split(/[\s|;&()+<>=]+/).filter(Boolean);
    const touches = (w: string) => namesRecord(w) || isRecordPath(resolve(root, strip(w)), root) || insideDesk(resolve(root, strip(w)), root);
    // 1. a redirection whose target is a record file or anything inside the desk.
    for (const m of cmd.matchAll(/>>?\s*([^\s&|;>]+)/g)) if (touches(m[1])) return blocked(GUARD_REASON);
    // 2. a command that is not a plain read, aimed at a record file or the desk tree. `cat log.jsonl`
    //    and `cat log.jsonl > /tmp/backup` are reads of the record and are allowed; `cp log out` is a
    //    copy out and is allowed; everything else that reaches inside the desk is a write.
    // Every segment of a pipeline or list is checked on its own: `echo x | tee log.jsonl` is a write
    // even though the first word is a reader.
    const inPlace = /\b(sed|perl|ruby|awk)\b[\s\S]*\s-i/.test(cmd);
    for (const seg of cmd.split(/[|;&]+|&&|\|\|/).map((x) => x.trim()).filter(Boolean)) {
      const sw = seg.split(/[\s<>=]+/).filter(Boolean);
      const verb = strip(sw[0] ?? "").replace(/^.*\//, "");
      if (READERS.has(verb) && !inPlace) continue;
      const namesRecordish = [...RECORD_NAMES].some((n) => seg.includes(n)) || /\.lock\b/.test(seg);
      if (!(sw.some(touches) || namesRecordish || destroys(seg))) continue;
      const dest = strip(sw[sw.length - 1] ?? "");
      const copiesOut = COPY_OUT.has(verb) && !insideDesk(resolve(root, dest), root) && !namesRecord(dest);
      if (!copiesOut) return blocked(GUARD_REASON);
    }
    return { block: false };
  }
  return { block: false };
}

const ALLOWED_TOOLS = new Set(["ledger_add", "read"]);

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
        // Default deny: only the ledger's own writer and plain reads pass; an unknown tool is blocked.
        if (!ALLOWED_TOOLS.has(call.name)) return { block: GUARD_REASON };
        const v = guardToolCall(call.name, call.arguments as Record<string, unknown>, { root: deskRoot() });
        return v.block ? { block: v.reason ?? GUARD_REASON } : undefined;
      },
    }),
  ],
});
