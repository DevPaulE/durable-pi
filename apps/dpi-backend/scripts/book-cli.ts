// book-cli — the canon tools, outside a session.
//
// WHY. `book_lookup` and `book_verify` are declared in src/addons.ts and reachable only from a
// durable-pi session. The pi seat and Claude Code therefore had no way to check a book claim and
// fell back to `grep`, which is how the G7 defect stayed invisible: `grep` matched text that the
// tool's own line mapping placed 634 lines away (VERIFY-G2.md). "Never quote a book from memory"
// was a rule with one enforcement point and two seats that could not reach it.
//
// WHAT THIS IS. A thin wrapper. It calls createAddons() and executes the SAME tool object a model
// would call — not a second implementation. If canon.ts is wrong, this is wrong the same way, and
// the backend test suite is what catches that. There is one implementation in the estate.
//
// Usage:
//   bun scripts/book-cli.ts books
//   bun scripts/book-cli.ts lookup <book> "<query>" [--context N] [--max N]
//   bun scripts/book-cli.ts verify <book> "<exact quote>" [--context N]
//   bun scripts/book-cli.ts damage <book>
// Exit: 0 if the tool answered, 1 if it returned CANNOT VERIFY FROM SOURCE or the args were wrong.
//       A CANNOT VERIFY is a real answer and prints in full; it is not a crash.

import { createAddons } from "../src/addons.js";
import { damageReport, getBook, loadRegister, readExtract } from "../src/canon.js";

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name: string): number | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : undefined;
}

/** The tool's text, exactly as a model would see it — never reformatted, so the CLI cannot
 *  flatter a verdict the session would have printed differently. */
async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const canon = createAddons({ offline: false }).all["book-canon"];
  const tool = canon?.tools?.find((t) => t.name === name);
  if (!tool?.execute) throw new Error(`book-canon declares no executable tool named ${name}`);
  const result = (await tool.execute(args as never, {} as never, {} as never)) as {
    content: { type: string; text: string }[];
  };
  return result.content.map((c) => c.text).join("\n");
}

// Positional args after the command, with each flag's value consumed so a number cannot be
// mistaken for the book name. (`lookup designing-ai-agents-v3 "x" --max 5` -> ["designing...", "x"].)
const VALUED_FLAGS = new Set(["--context", "--max"]);
const positional: string[] = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (VALUED_FLAGS.has(a)) {
    i++;
    continue;
  }
  if (a.startsWith("--")) continue;
  positional.push(a);
}

async function main(): Promise<number> {
  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(
      [
        "book-cli — read and check the estate's authoritative books, outside a session.",
        "",
        "  books                                  list the register",
        "  lookup <book> \"<query>\"  [--context N] [--max N]   read passages, with line numbers",
        "  verify <book> \"<exact quote>\" [--context N]       redo a claim against the raw extract",
        "  damage <book>                          the register's damage table, re-measured now",
        "",
        "A CANNOT VERIFY FROM SOURCE verdict is a complete answer and exits 1.",
      ].join("\n"),
    );
    return 0;
  }

  if (cmd === "books") {
    for (const b of loadRegister().books) {
      console.log(`- ${b.id}  (${b.edition})  ${b.title ?? ""}`);
    }
    return 0;
  }

  if (cmd === "lookup" || cmd === "verify") {
    const [book, ...rest] = positional;
    const text = rest.join(" ");
    if (!book || !text) {
      console.error(`usage: book-cli ${cmd} <book> "<text>"`);
      return 1;
    }
    const args =
      cmd === "lookup"
        ? { book, query: text, context: flag("--context"), max: flag("--max") }
        : { book, claim: text, context: flag("--context") };
    const out = await call(cmd === "lookup" ? "book_lookup" : "book_verify", args);
    console.log(out);
    return out.includes("CANNOT VERIFY FROM SOURCE") ? 1 : 0;
  }

  if (cmd === "damage") {
    const book = getBook(positional[0] ?? "");
    const extract = readExtract(book);
    if (!extract.ok) {
      console.log(`CANNOT VERIFY FROM SOURCE\n${extract.reason}`);
      return 1;
    }
    console.log(`${book.id} ${book.edition}  sha256 ${extract.sha256}`);
    for (const d of damageReport(book, extract.text)) {
      const actual = d.actual === -1 ? "bad pattern" : String(d.actual);
      console.log(`  ${d.state.padEnd(6)} ${d.class} — expected ${d.expect}, found ${actual}`);
    }
    return 0;
  }

  console.error(`unknown command: ${cmd}`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);
