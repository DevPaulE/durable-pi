// canon.ts — the book canon register, as this device reads it.
//
// WHY THIS FILE EXISTS. `canon/canon.yaml` in the DevPaulE/agent-patterns repo declares one
// authoritative master per book: the source, its extract, the extract's hash, the damage table,
// and the mirrors. Until now the only thing that read it was `canon-check.ts`, which runs by hand
// in that repo. So an agent reasoning about a book had nothing but its own memory of the text —
// which is exactly the failure the register was built to kill.
//
// THE RULE THIS FILE ENFORCES, in one line: resolve BY NAME, verify BY HASH, and refuse when you
// cannot. A path typed into an agent is the defect; a name is the interface.
//
// WHY HASH VERIFICATION GATES THE READ, NOT JUST THE CHECK
// `Designing AI Agents` §7.2.4 names the failure mode: "The producing process can change the test,
// rubric, or threshold that judges its work. Protect the evidence channel." An extract whose hash
// no longer matches the register is a changed evidence channel. Returning text from it would be
// exactly the Generator marking its own homework. So a mismatch is a REFUSAL: the tools built on
// this module return `CANNOT VERIFY FROM SOURCE` rather than the passage.
//
// WHY SOURCE AND EXTRACT ARE HASH-PINNED BUT `derived` IS NOT
// The register's own reasoning, kept here so a reader of this file does not have to go find it:
// a hash answers "has this changed?", which is the right question for a book and its extract and
// the wrong one for our own living notes. Pinning those would fail on every edit and teach
// everyone to ignore the check.
//
// WHY `yaml` IS A DEPENDENCY HERE. This backend runs on tsx/node, where `bun.YAML` — what
// `canon-check.ts` uses — does not exist. The alternative was a hand-rolled parser for a real YAML
// subset, and a parser that is subtly wrong reads a wrong register while reporting success. That is
// this estate's most-repeated defect. `yaml@2.9.1` is the version `dpi-tui` and `dpi-sdk` already
// depend on, so this adds no new dialect to the monorepo.
//
// TWO READERS, ONE REGISTER. `canon-check.ts` (bun, in agent-patterns) and this module both read
// the same YAML file. That is deliberate and is NOT the two-copies defect: the data has exactly
// one home. What would be the defect is copying the data here, so nothing below restates a hash,
// an edition, or a damage expectation. Every one of those comes off disk.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export type DamageRow = {
  class: string;
  pattern: string;
  expect: number;
  count_before?: number;
  cause?: string;
  action?: string;
};

export type Mirror = { path: string; must_equal: string };

export type Book = {
  id: string;
  title: string;
  author?: string;
  edition: string;
  publisher?: string;
  isbn?: string;
  edition_modified?: string;
  source?: { path: string; sha256: string; bytes?: number; format?: string };
  extract?: { path: string; sha256: string; words?: number; command?: string; forbidden_flags?: string[] };
  derived?: string[];
  damage?: DamageRow[];
  mirrors?: Mirror[];
  unverified?: string[];
};

export type Register = {
  /** The register file itself. */
  path: string;
  /** The repo it belongs to; `out/...` paths in it are relative to here. */
  repo: string;
  books: Book[];
};

const HOME = process.env.HOME ?? "";
const DEFAULT_REGISTER = "Projects/agent-patterns/canon/canon.yaml";

/** `BOOK_CANON_REGISTER` wins, so a fork can point at its own register. */
export function registerPath(): string {
  const p = process.env.BOOK_CANON_REGISTER?.trim();
  if (!p) return join(HOME, DEFAULT_REGISTER);
  return p.startsWith("~/") ? join(HOME, p.slice(2)) : resolve(p);
}

/**
 * The register's own path rule, and the only two cases there are — copied from `canon-check.ts`
 * deliberately, because two readers disagreeing about where a path points is the failure the
 * `mirrors` block exists to catch. `~/...` (and bare `Projects/`, `dpi-work/`, `.claude/`) are
 * HOME-relative because that is where they live; `out/...` is relative to the repo that owns the
 * register, because that is where derivations are produced.
 */
export function resolveDeclared(p: string, repo: string): string {
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  if (p.startsWith("out/")) return join(repo, p);
  return join(HOME, p);
}

// Re-read when the file changes, and only then: the register is read on every prompt render, so
// parsing it each time would put file IO in the path of every request. The KEY INCLUDES THE PATH,
// not just mtime and size, because tests and forks point BOOK_CANON_REGISTER at other registers and
// two different files of the same size would otherwise alias onto one entry.
let cache: { path: string; mtimeMs: number; size: number; value: Register } | undefined;

export function loadRegister(): Register {
  const path = registerPath();
  if (!existsSync(path)) throw new Error(`canon register not found at ${path}`);
  const stat = statSync(path);
  if (cache && cache.path === path && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.value;

  const doc = parseYaml(readFileSync(path, "utf8")) as { books?: Record<string, Omit<Book, "id">> };
  const books = Object.entries(doc?.books ?? {}).map(([id, book]) => ({ id, ...book }));
  const value: Register = { path, repo: resolve(dirname(path), ".."), books };
  cache = { path, mtimeMs: stat.mtimeMs, size: stat.size, value };
  return value;
}

/**
 * Resolve one book BY NAME. The error lists the names that exist, because the whole point of the
 * register is that an agent never has to guess a path — and a guess that fails should teach it the
 * namespace rather than send it looking at the filesystem.
 */
export function getBook(name: string): Book {
  const register = loadRegister();
  const wanted = name.trim().toLowerCase();
  const book =
    register.books.find((b) => b.id.toLowerCase() === wanted) ??
    register.books.find((b) => b.title.toLowerCase() === wanted) ??
    register.books.find((b) => b.id.toLowerCase().includes(wanted));
  if (!book) {
    const known = register.books.map((b) => `${b.id} (${b.title}, ${b.edition})`).join("; ");
    throw new Error(`unknown book "${name}". The register declares: ${known}`);
  }
  return book;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The evidence channel, checked before anything is read from it.
 *
 * `text` is present only when the hash matched the register. Every caller must treat a non-`ok`
 * result as a refusal, never as "close enough".
 */
export type ExtractCheck =
  | { ok: true; path: string; sha256: string; bytes: number; text: string }
  | {
      ok: false;
      code: "no-extract-declared" | "extract-missing" | "extract-hash-mismatch";
      reason: string;
      path?: string;
      expected?: string;
      actual?: string;
    };

export function readExtract(book: Book): ExtractCheck {
  if (!book.extract) {
    return {
      ok: false,
      code: "no-extract-declared",
      reason: `${book.id} declares no extract. There is nothing this device may quote.`,
    };
  }
  const repo = loadRegister().repo;
  const path = resolveDeclared(book.extract.path, repo);
  if (!existsSync(path)) {
    return {
      ok: false,
      code: "extract-missing",
      reason: `the declared extract is not on this machine: ${path}`,
      path,
    };
  }
  const actual = sha256File(path);
  const expected = book.extract.sha256;
  if (actual !== expected) {
    return {
      ok: false,
      code: "extract-hash-mismatch",
      reason:
        `the extract at ${path} does not match the hash the register declares for ${book.id} ${book.edition}. ` +
        `The evidence channel has changed since it was pinned, so this device will not quote it.`,
      path,
      expected,
      actual,
    };
  }
  const text = readFileSync(path, "utf8");
  return { ok: true, path, sha256: actual, bytes: Buffer.byteLength(text), text };
}

export type Passage = {
  /** 1-indexed line number in the extract, so a claim can be traced to a location. */
  line: number;
  text: string;
};

/**
 * Find a passage, and say where it is.
 *
 * Case-insensitive and whitespace-tolerant, because the extracts are wrapped prose: a quotation
 * that spans a line break must still be findable, or the verifier would report "cannot verify"
 * on text that is plainly present. Everything else is exact — no fuzzy matching, because a near
 * match reported as a match is the rubber-stamp failure §7.2.4 warns about.
 */
export function findPassage(text: string, query: string, options?: { context?: number; max?: number }): Passage[] {
  const needle = query.trim().replace(/\s+/g, " ").toLowerCase();
  if (!needle) return [];
  const max = Math.max(1, Math.min(options?.max ?? 5, 25));
  const context = Math.max(0, Math.min(options?.context ?? 0, 20));

  const lines = text.split("\n");
  // The haystack normalises the same way as the needle, and keeps a map back to real line numbers,
  // so a match that spans a wrap reports the line it started on.
  const flat: { text: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t) flat.push({ text: t, line: i + 1 });
  }
  const haystack = flat.map((l) => l.text).join(" ").replace(/\s+/g, " ").toLowerCase();

  const found: Passage[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1 && found.length < max) {
    // Which flat line does this offset land on?
    let acc = 0;
    let line = flat.length ? flat[0].line : 1;
    for (const entry of flat) {
      const end = acc + entry.text.length + 1;
      if (at < end) {
        line = entry.line;
        break;
      }
      acc = end;
    }
    const first = Math.max(0, flat.findIndex((e) => e.line === line) - context);
    const slice = flat
      .slice(first, first + 1 + context * 2)
      .map((e) => e.text)
      .join("\n");
    found.push({ line, text: slice });
    at = haystack.indexOf(needle, at + needle.length);
  }
  return found;
}

export type DamageResult = {
  class: string;
  pattern: string;
  expect: number;
  actual: number;
  state: "PASS" | "FAIL" | "BAD-PATTERN";
};

/**
 * Re-count the register's damage table against the text in hand.
 *
 * This is the register's executable claim, and it is the collateral-damage question the verifier
 * must ask: the text is not merely present, it is the text the register says it is. Patterns are
 * ALWAYS regex, never escaped — an earlier version in `canon-check.ts` escaped patterns that did
 * not start with a slash and reported 0 against a text that plainly contained 7. The check was
 * measuring its own escaping. That lesson is why a bad pattern is a distinct state here rather
 * than a silent zero.
 */
export function damageReport(book: Book, text: string): DamageResult[] {
  return (book.damage ?? []).map((row) => {
    let actual: number;
    try {
      actual = (text.match(new RegExp(row.pattern, "gm")) ?? []).length;
    } catch {
      return { class: row.class, pattern: row.pattern, expect: row.expect, actual: -1, state: "BAD-PATTERN" as const };
    }
    return {
      class: row.class,
      pattern: row.pattern,
      expect: row.expect,
      actual,
      state: actual === row.expect ? ("PASS" as const) : ("FAIL" as const),
    };
  });
}
