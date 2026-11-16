import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// book-cli — the wrapper that puts book_lookup/book_verify in reach of the pi seat and Claude Code.
//
// WHY THIS TEST EXISTS. `grep` is what the seats used before the CLI, and `grep` is what produced
// the G7 defect: it matched text at a line number 634 lines away from the tool's own mapping
// (VERIFY-G2.md). A wrapper that answers differently from the session tool is the same defect one
// layer out. So the assertions here are the tool's OWN strings — CONFIRMED, the extract line
// number, CANNOT VERIFY FROM SOURCE — not a paraphrase of them.
//
// It also guards the thing that actually broke while this file was being written: argv parsing.
// Two bugs got through by hand — `positional.slice(1)` dropping the book name, and `--context N`
// letting N be read as a positional — so the parsing is asserted here rather than trusted.

const CLI = join(import.meta.dirname, "..", "scripts", "book-cli.ts");

function run(...args: string[]): { out: string; code: number } {
  const r = spawnSync("bun", [CLI, ...args], { encoding: "utf8" });
  return { out: `${r.stdout}${r.stderr}`, code: r.status ?? -1 };
}

test("books: lists the register and resolves all three", () => {
  const { out, code } = run("books");
  assert.equal(code, 0);
  for (const id of ["local-ai-models-v6", "designing-ai-agents-v3", "spec-driven-development-v2"]) {
    assert.match(out, new RegExp(id), `register listing should name ${id}`);
  }
});

test("verify: a true claim CONFIRMS at the line CROSSWALK cites", () => {
  // The CROSSWALK row X11 pins "9.4 Pattern: Progressive Commitment" at L16227.
  // A wrapper that returns a different line is a wrapper that disagrees with the tool.
  const { out, code } = run("verify", "designing-ai-agents-v3", "9.4 Pattern: Progressive Commitment", "--context", "0");
  assert.equal(code, 0, out);
  assert.match(out, /verdict: CONFIRMED/);
  assert.match(out, /extract line 16227:/, "must cite the same line the tool maps");
  assert.doesNotMatch(out, /verdict: CANNOT VERIFY/);
});

test("verify: a false claim never CONFIRMS, and exits non-zero", () => {
  // Ch 7 of the SDD MEAP does not exist as body text. A wrapper that shrugged and confirmed
  // would be worse than no wrapper: it would launder an invented citation as verified.
  const { out, code } = run("verify", "spec-driven-development-v2", "Chapter 7 explains how to retire a specification");
  assert.equal(code, 1, "CANNOT VERIFY FROM SOURCE must exit 1, not 0");
  assert.match(out, /CANNOT VERIFY FROM SOURCE/);
  assert.doesNotMatch(out, /verdict: CONFIRMED/);
  assert.match(out, /Chapters 5-10/, "the book's own declared defect should be surfaced");
});

test("lookup: a partial book name resolves, and a flag value is not eaten as a positional", () => {
  const { out, code } = run("lookup", "designing", "Semantic compaction", "--max", "2", "--context", "0");
  assert.equal(code, 0, out);
  assert.match(out, /designing-ai-agents-v3/, "partial name must resolve via getBook");
  assert.doesNotMatch(out, /usage:/, "--max 2 must not be read as the query");
  assert.doesNotMatch(out, /CANNOT VERIFY/);
});

test("damage: reports the register's table re-measured, and names PASS rows", () => {
  const { out, code } = run("damage", "designing-ai-agents-v3");
  assert.equal(code, 0, out);
  assert.match(out, /sha256/, "a verdict without the hash it was measured against is not checkable");
});

test("usage: no args prints help and exits 0; an unknown command exits 1", () => {
  assert.equal(run().code, 0);
  assert.equal(run("frobnicate").code, 1);
});

test("usage: a missing quote is a usage error, not a silent empty verify", () => {
  const { out, code } = run("verify", "designing-ai-agents-v3");
  assert.equal(code, 1);
  assert.match(out, /usage:/);
});
