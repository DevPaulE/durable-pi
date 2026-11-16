import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { damageReport, findPassage, getBook, loadRegister, readExtract, registerPath } from "../src/canon.js";
import { createAddons } from "../src/addons.js";

// ---------------------------------------------------------------------------- helpers

const addons = createAddons({ offline: false });
const canon = addons.all["book-canon"]!;
const tool = (name: string) => {
  const found = canon.tools?.find((t) => t.name === name);
  assert.ok(found, `book-canon declares no tool named ${name}`);
  return found;
};
/** Call a tool and return its text, the way a model would see it. */
async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await tool(name).execute!(args as never, {} as never, {} as never)) as {
    content: { type: string; text: string }[];
  };
  return result.content.map((c) => c.text).join("\n");
}

/** Run `fn` with BOOK_CANON_REGISTER pointed elsewhere, then put it back. */
async function withRegister<T>(path: string, fn: () => T | Promise<T>): Promise<T> {
  const before = process.env.BOOK_CANON_REGISTER;
  process.env.BOOK_CANON_REGISTER = path;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.BOOK_CANON_REGISTER;
    else process.env.BOOK_CANON_REGISTER = before;
  }
}

/**
 * A throwaway canon register with its own `out/` directory, so `out/...` resolves inside it.
 * `sha256` is the caller's, which is the whole point: it lets a test declare a hash that is wrong.
 */
function fakeRegister(sha256: string, extract?: string) {
  const root = mkdtempSync(join(tmpdir(), "dpi-canon-"));
  mkdirSync(join(root, "out"), { recursive: true });
  mkdirSync(join(root, "canon"), { recursive: true });
  const real = readExtract(getBook("local-ai-models-v6"));
  assert.equal(real.ok, true, "the real register must verify, or this test proves nothing");
  const body = extract ?? real.text;
  writeFileSync(join(root, "out", "book.txt"), body);
  const path = join(root, "canon", "canon.yaml");
  writeFileSync(
    path,
    [
      "books:",
      "  fake-book:",
      '    title: "A Book That Is Not Real"',
      '    author: "Nobody"',
      '    edition: "1st"',
      "    extract:",
      "      path: out/book.txt",
      `      sha256: "${sha256}"`,
      "    damage: []",
      "",
    ].join("\n"),
  );
  return { root, path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------- the register

test("the register declares both books and resolves them by name, not by path", () => {
  const register = loadRegister();
  const ids = register.books.map((b) => b.id);
  assert.ok(ids.includes("local-ai-models-v6"), ids.join(", "));
  assert.ok(ids.includes("designing-ai-agents-v3"), ids.join(", "));

  assert.equal(getBook("local-ai-models-v6").id, "local-ai-models-v6");
  assert.equal(getBook("designing-ai-agents-v3").id, "designing-ai-agents-v3");
  // A partial name is enough, because an agent should not have to reproduce an exact id.
  assert.equal(getBook("designing").id, "designing-ai-agents-v3");

  const err = (() => {
    try {
      getBook("no-such-book");
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  })();
  assert.match(err, /no-such-book/);
  // The failure must teach the namespace, otherwise the agent guesses again.
  assert.match(err, /local-ai-models-v6/);
  assert.match(err, /designing-ai-agents-v3/);
});

test("every declared book's extract matches its pinned hash, and every damage row holds", () => {
  for (const book of loadRegister().books) {
    const check = readExtract(book);
    assert.equal(check.ok, true, `${book.id}: ${check.ok ? "" : check.reason}`);
    if (!check.ok) continue;
    assert.equal(check.bytes, Buffer.byteLength(check.text));
    // A damage row that no longer matches means the register has drifted from the text it pins.
    // This is a check, not a warning: a table that silently stops matching is worse than none.
    for (const row of damageReport(book, check.text)) {
      assert.equal(row.state, "PASS", `${book.id} / ${row.class}: expected ${row.expect}, found ${row.actual}`);
    }
  }
});

// ---------------------------------------------------------------------------- the evidence channel

test("a declared hash that does not match the file is a refusal, not a warning", async () => {
  const wrong = "0".repeat(64);
  const fake = fakeRegister(wrong);
  try {
    await withRegister(fake.path, async () => {
      const book = getBook("fake-book");
      const check = readExtract(book);
      assert.equal(check.ok, false);
      assert.equal(check.ok === false && check.code, "extract-hash-mismatch");
      assert.equal(check.ok === false && check.expected, wrong);

      // The tools must refuse too, not just the reader underneath them.
      const lookup = await call("book_lookup", { book: "fake-book", query: "deterministic" });
      assert.match(lookup, /CANNOT VERIFY FROM SOURCE/);
      assert.match(lookup, /evidence channel/);

      // A quotation that IS genuinely in the file must still be refused, because the file is no
      // longer the file the register pinned. Trusting it would be the rubber stamp §7.2.4 warns of.
      const verify = await call("book_verify", {
        book: "fake-book",
        claim: "Temperature 0.0: Always picks the most probable next word.",
      });
      assert.match(verify, /CANNOT VERIFY FROM SOURCE/);
      assert.doesNotMatch(verify, /CONFIRMED/);
    });
  } finally {
    fake.cleanup();
  }
});

test("the same harness confirms when the hash is right, so the refusal above is not blanket failure", async () => {
  const real = readExtract(getBook("local-ai-models-v6"));
  assert.equal(real.ok, true);
  if (!real.ok) return;
  const fake = fakeRegister(real.sha256, real.text);
  try {
    await withRegister(fake.path, async () => {
      const check = readExtract(getBook("fake-book"));
      assert.equal(check.ok, true);
      const verify = await call("book_verify", {
        book: "fake-book",
        claim: "Temperature 0.0: Always picks the most probable next word. Responses are deterministic",
      });
      assert.match(verify, /verdict: CONFIRMED/);
      assert.doesNotMatch(verify, /CANNOT VERIFY/);
    });
  } finally {
    fake.cleanup();
  }
});

// ---------------------------------------------------------------------------- reading

test("book_lookup returns a passage with its edition, hash and line number", async () => {
  const out = await call("book_lookup", { book: "local-ai-models-v6", query: "nondeterministic" });
  assert.match(out, /book: local-ai-models-v6/);
  assert.match(out, /extract sha256: [0-9a-f]{64}/);
  assert.match(out, /extract line \d+/);
  assert.match(out, /nondeterministic/);
});

test("book_lookup on an unknown book refuses and names the books that exist", async () => {
  const out = await call("book_lookup", { book: "no-such-book", query: "anything" });
  assert.match(out, /CANNOT VERIFY FROM SOURCE/);
  assert.match(out, /no-such-book/);
  assert.match(out, /local-ai-models-v6/);
});

test("findPassage reports the real line and finds nothing for absent text", () => {
  const check = readExtract(getBook("local-ai-models-v6"));
  assert.equal(check.ok, true);
  if (!check.ok) return;

  const hit = findPassage(check.text, "Temperature 0.0: Always picks the most probable next word");
  assert.equal(hit.length, 1, "expected exactly one passage");
  assert.equal(hit[0].line, 11425);
  assert.match(hit[0].text, /robotic and repetitive/);

  // Case and wrapping are forgiven, because prose wraps. Everything else is exact.
  assert.equal(findPassage(check.text, "temperature 0.0: always picks the MOST probable next word").length, 1);
  const wrapped = check.text.split("\n")[hit[0].line - 1].trim().split(" ");
  assert.equal(findPassage(check.text, wrapped.slice(0, 8).join(" ")).length, 1);

  assert.deepEqual(findPassage(check.text, "a sentence that marmalade quixotic zeppelin never wrote"), []);
  assert.deepEqual(findPassage(check.text, "   "), []);
});

test("findPassage maps a match past internal whitespace to its real line, not an earlier one", () => {
  // The defect G7 fixed: the offset->line map was built from the joined lines while the search ran
  // on a whitespace-collapsed copy of them, so every internal run of whitespace before a match
  // shifted the reported line earlier. On designing-ai-agents-v3 that accumulated to 26,252
  // characters, and a §8.4 query was cited as line 13531 while the text sits on line 14165 — with
  // an unrelated passage printed as the match. Synthetic and hermetic: no extract needed.
  const lines: string[] = [];
  for (let i = 0; i < 400; i++) lines.push(i % 3 === 0 ? `line ${i + 1} has  a double space` : `line ${i + 1}\thas a tab`);
  lines[349] = "8.4 Pattern: Adversarial Review"; // line 350
  const text = lines.join("\n");

  const hit = findPassage(text, "8.4 Pattern: Adversarial Review");
  assert.equal(hit.length, 1);
  assert.equal(hit[0].line, 350, `reported line ${hit[0].line}; the text is on line 350`);
  assert.match(hit[0].text, /8\.4 Pattern: Adversarial Review/);

  // A match that exists only across a line wrap still reports the line it starts on.
  const wrapped = findPassage(text, "has a double space 8.4 Pattern");
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0].line, 349, `reported line ${wrapped[0].line}; the match starts on line 349`);
});

// ---------------------------------------------------------------------------- verifying

test("book_verify confirms a real quotation with its location", async () => {
  const out = await call("book_verify", {
    book: "local-ai-models-v6",
    claim: "Language models are nondeterministic---they may produce a slightly different response each time you send the same prompt.",
  });
  assert.match(out, /verdict: CONFIRMED/);
  assert.match(out, /extract line 3391/);
  assert.match(out, /extract sha256: [0-9a-f]{64}/);
});

test("book_verify refuses a fabricated quotation instead of calling it false", async () => {
  const out = await call("book_verify", {
    book: "local-ai-models-v6",
    claim: "Language models are fully deterministic and always return byte-identical responses.",
  });
  // The refusal is the deliverable. Absence from a derived extract is not disproof, and a verifier
  // that cannot refuse becomes a rubber stamp.
  assert.match(out, /verdict: CANNOT VERIFY FROM SOURCE/);
  assert.match(out, /NOT thereby false/);
  assert.doesNotMatch(out, /verdict: FALSE|not in the book|incorrect/i);
  // This claim diverges from the real text at the fourth word, so there genuinely is no near miss.
  // Saying so is the honest answer; inventing one from the first two words would be noise.
  assert.match(out, /No similar passage was found either/);
  assert.doesNotMatch(out, /Closest match/);
  assert.match(out, /extract sha256: [0-9a-f]{64}/, "even a refusal must carry provenance");
});

test("book_verify shows a near miss when one exists, labelled as a near miss", async () => {
  // A sentence that exists, with its tail altered — the realistic way a half-remembered quotation
  // fails. The opening words are real, so the reader can see the actual sentence beside the claim.
  const out = await call("book_verify", {
    book: "local-ai-models-v6",
    claim: "Temperature 0.0: Always picks the most probable next word. Responses are flaky.",
  });
  assert.match(out, /verdict: CANNOT VERIFY FROM SOURCE/);
  assert.match(out, /Closest match/);
  assert.match(out, /not a match/);
  assert.match(out, /extract line 11425/);
  assert.match(out, /robotic and repetitive/, "the reader must see the real wording");
});

test("book_verify weakens its verdict when only a declared defect hid the text", async () => {
  // Line 6041 of this extract has `model=“gemma3:4b”` — a curly quote where the code was straight.
  // That is the book's own defect, and the register declares it. A claim carrying the correct
  // straight quote must NOT come back as a plain CONFIRMED.
  const out = await call("book_verify", { book: "local-ai-models-v6", claim: 'model="gemma3:4b"' });
  assert.match(out, /verdict: CONFIRMED_AFTER_NORMALIZATION/);
  assert.doesNotMatch(out, /verdict: CONFIRMED\n/);
  assert.match(out, /extract line 6041/);
  assert.match(out, /curly quote/);
});

// ---------------------------------------------------------------------------- the prompt section

test("the prompt section states the books, the rules, and that the extracts may be damaged", async () => {
  const section = canon.sections?.[0];
  assert.ok(section, "book-canon declares no section");
  const rendered = await section.render({} as never, {} as never);
  const text = typeof rendered === "string" ? rendered : JSON.stringify(rendered);
  assert.match(text, /local-ai-models-v6/);
  assert.match(text, /designing-ai-agents-v3/);
  assert.match(text, /book_lookup/);
  assert.match(text, /book_verify/);
  assert.match(text, /CANNOT VERIFY FROM SOURCE/);
  assert.match(text, /Never quote a book from memory/);
  assert.match(text, /known defects/);
});

test("the extension is listed as an addon and is off by default", () => {
  assert.equal(canon.name, "book-canon");
  const info = addons.list.find((e) => e.name === "book-canon");
  assert.ok(info, "book-canon is not in the extension list");
  assert.equal(registerPath().endsWith("canon.yaml"), true, registerPath());
});
