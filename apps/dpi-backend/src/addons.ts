// Custom harness extensions an agent can turn on and off. Each is a plain pi-durable extension in the registry; the
// agent's stored selection (`configure({ extensions: { add | remove } })`) decides whether it runs, from the next
// request on. Neither is selected by default.
//
//   system-prompts       a checklist of built-in system prompts, rendered as one section
//   jev-damage-control   Jev judges every bash command before it runs and blocks destructive ones
//   book-canon           the books this estate treats as authoritative: a prompt section with the
//                        rules, plus `book_lookup` and `book_verify`, which read only extracts whose
//                        hash matches the canon register and answer CANNOT VERIFY FROM SOURCE otherwise
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineDoc, defineExtension, defineTool, hook, section, ToolTask, type Extension } from "@earendil-works/pi-durable";
// pi-ai re-exported Typebox's Type until 1.5.2 dropped it; pi-ai 1.5.2 is what carries
// kimi-k3.1-pro, so the import comes from typebox directly now.
import { Type } from "typebox";
import type { HarnessExtensionInfo } from "../../dpi-sdk/src/api.js";
import { askJev, type JevAnswer, type JevQuestion } from "./jev.js";
import { damageReport, findPassage, getBook, loadRegister, readExtract, registerPath, type Book } from "./canon.js";
import { createDeskAddon, deskAddon } from "./desk-addon.js";

const PROMPTS_DIR = join(import.meta.dirname, "../prompts");

export const PROMPTS = [
  {
    id: "smart_ass_opus_fix.md",
    title: "Smart Ass Opus fix",
    description: "Clear, concise, actionable communication: the most important point last, no filler, reference codes.",
  },
  {
    id: "one_sentence.md",
    title: "One sentence",
    description: "Replies in one sentence unless you ask for more. Easy to see turn on and off.",
  },
].map((p) => ({ ...p, text: readFileSync(join(PROMPTS_DIR, p.id), "utf8").trim() }));

/** Which built-in prompts this agent's system-prompts extension renders. */
export const PromptChecklist = defineDoc<{ enabled: string[] }>({
  kind: "ext.system-prompts",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ enabled: [PROMPTS[0].id] }),
});

// ------------------------------------------------------------------ jev-damage-control

/** The jev-bash gate's questions and thresholds (harness/extensions/jev-bash/bash-gate.ts). */
const BASH_QUESTIONS: Record<string, JevQuestion> = {
  effect: {
    type: "choice",
    instructions: "What does running `command` do to the machine?",
    criteria: {
      read_only: "Lists, reads, searches, tests, builds into a scratch directory; nothing durable changes",
      reversible: "Changes files or state that git or a reinstall can restore: edits, installs, generated output",
      irreversible:
        "Deletes or overwrites things with no way back: removing directories, force pushing, dropping data, rewriting history",
    },
  },
  destructive_intent: {
    type: "noul",
    instructions: "Does `command` aim to remove or wipe something rather than build or inspect?",
    criteria: {
      true: "rm -rf, drop, purge, force, reset --hard, truncate, overwriting real data",
      false: "Reading, listing, testing, installing, generating, or editing in place",
    },
  },
};

type Verdict = { block: boolean; reason: string };

function gate(a: Record<string, JevAnswer>): Verdict {
  const effect = a.effect as Extract<JevAnswer, { type: "choice" }>;
  const destructive = (a.destructive_intent as Extract<JevAnswer, { type: "noul" }>).noul;
  if (effect.choice === "irreversible" && effect.confidence >= 0.6)
    return { block: true, reason: `irreversible (${effect.confidence.toFixed(2)}): nothing would restore what this removes or overwrites` };
  if (destructive >= 0.7)
    return { block: true, reason: `destructive intent (${destructive.toFixed(2)}): this command aims to wipe something` };
  return { block: false, reason: `${effect.choice} (${effect.confidence.toFixed(2)}), destructive ${destructive.toFixed(2)}` };
}

/** The faux provider's stand-in for Jev, so tests and offline demos never call the network. */
const OFFLINE_DANGER = /\brm\s+-[a-z]*[rf]|\bgit\s+push\b.*--force|\bgit\s+reset\s+--hard|\bdropdb\b|\bmkfs|\bdd\s+.*of=|\btruncate\b/;
async function judgeOffline(command: string): Promise<Verdict> {
  return OFFLINE_DANGER.test(command)
    ? { block: true, reason: "destructive intent (offline rules): this command aims to wipe something" }
    : { block: false, reason: "allowed (offline rules)" };
}

// ------------------------------------------------------------------ book-canon

/**
 * The refusal both book-canon tools return when the evidence channel cannot be trusted.
 *
 * This wording is not a placeholder. `Designing AI Agents` §7.2 requires a Critic to be able to
 * return "stop as unresolved" (11236), and §7.2.4 warns that when the producing process can change
 * the test that judges its work, the review is worthless (11428). A verifier that can only say yes
 * or no is a rubber stamp. This one has a third answer, and it is the honest one.
 */
const CANNOT_VERIFY = "CANNOT VERIFY FROM SOURCE";

/** One line about a book, for the prompt and for error messages. */
const describeBook = (b: Book) =>
  `${b.id} — "${b.title}"${b.author ? ` by ${b.author}` : ""}, ${b.edition}${b.publisher ? ` (${b.publisher})` : ""}`;

/**
 * The extract carries the book's own defects, so a correct quotation can fail an exact match.
 * These substitutions are what the register's declared damage classes amount to on the page.
 * Applying them keeps a finding traceable to the text instead of turning it into a guess — and a
 * match that only holds after repair is reported as a WEAKER verdict, never as a plain confirmation.
 */
const DEFECT_NORMALIZATION: [RegExp, string][] = [
  [/[\u201c\u201d]/g, '"'], // curly quote where a straight one belongs (the book's, 9 occurrences)
  // A non-newline space before the dash, deliberately: `\s` would also match a line break and the
  // substitution would then merge two lines, shifting every line number after it. The line numbers
  // are the citation, so they have to survive the repair.
  [/[^\S\n][\u2013\u2014](?=[a-z])/g, " --"], // en/em dash where `--` was meant (the book's, 7)
  [/`r`n/g, "\\r\\n"], // literal backtick-r-n leak (the book's, 1 occurrence)
];

const normalizeForDefects = (s: string) => DEFECT_NORMALIZATION.reduce((acc, [re, to]) => acc.replace(re, to), s);

const cite = (p: { line: number; text: string }) => `extract line ${p.line}:\n${p.text}`;

/** The provenance block every answer from this extension carries, so a claim can be traced. */
function provenance(book: Book, sha256: string, path: string): string {
  return [
    `book: ${book.id}`,
    `edition: ${book.edition}${book.edition_modified ? ` (modified ${book.edition_modified})` : ""}`,
    `author: ${book.author ?? "unknown"}`,
    `extract sha256: ${sha256}`,
    `extract path: ${path}`,
    `source: ${book.source ? `${book.source.path} (${book.source.format ?? "?"}, ${book.source.bytes ?? "?"} bytes)` : "not declared"}`,
    book.unverified?.length ? `UNRESOLVED BOOK DEFECTS: ${book.unverified.join(" | ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function createBookCanon() {
  const bookLookup = defineTool({
    name: "book_lookup",
    description:
      "Read a passage from an authoritative book, with its edition, hash and line number. Resolves the book BY NAME from the canon register, never a file path. Returns the passage, or CANNOT VERIFY FROM SOURCE when the extract no longer matches the hash the register pins. Use this instead of recalling a book from memory.",
    parameters: Type.Object({
      book: Type.String({ description: "Register name of the book, such as designing-ai-agents-v3. A partial name works." }),
      query: Type.String({ description: "Text to find. A phrase works better than keywords." }),
      context: Type.Optional(Type.Number({ description: "Lines of context either side. Default 0." })),
      max: Type.Optional(Type.Number({ description: "Maximum passages to return. Default 5." })),
    }),
    replay: "safe",
    execute: async (args) => {
      let book: Book;
      try {
        book = getBook(args.book);
      } catch (e) {
        return { content: [{ type: "text" as const, text: `${CANNOT_VERIFY}: ${(e as Error).message}` }] };
      }
      const extract = readExtract(book);
      if (!extract.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${CANNOT_VERIFY}\n${extract.reason}\n${provenance(book, extract.expected ?? "?", extract.path ?? "?")}`,
            },
          ],
        };
      }
      const passages = findPassage(extract.text, args.query, { context: args.context, max: args.max });
      if (!passages.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `No passage in ${book.id} ${book.edition} contains that text.`,
                "This is not proof the book does not say it. The extract is derived text, and the register may record damage that makes a quotation unfindable verbatim.",
                "Try a shorter or differently-worded phrase, or read the source itself.",
                "",
                provenance(book, extract.sha256, extract.path),
              ].join("\n"),
            },
          ],
        };
      }
      const broken = damageReport(book, extract.text).filter((d) => d.state !== "PASS");
      return {
        content: [
          {
            type: "text" as const,
            text: [
              provenance(book, extract.sha256, extract.path),
              `matches: ${passages.length}`,
              "",
              passages.map(cite).join("\n\n"),
              broken.length
                ? `\nWARNING — the register's damage table no longer matches this extract: ${broken
                    .map((d) => `${d.class} (expected ${d.expect}, found ${d.actual === -1 ? "bad pattern" : d.actual})`)
                    .join("; ")}`
                : "",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      };
    },
  });

  const bookVerify = defineTool({
    name: "book_verify",
    description:
      "Redo a claim against the book itself, from the raw extract, instead of reviewing someone's conclusion. Returns CONFIRMED with the cited line, CONFIRMED_AFTER_NORMALIZATION when only the book's own declared defects made it unfindable, or CANNOT VERIFY FROM SOURCE. It never reports a claim as false from absence: a missing passage is an unresolved review, not a refutation.",
    parameters: Type.Object({
      book: Type.String({ description: "Register name of the book the claim is said to come from." }),
      claim: Type.String({ description: "The exact text claimed to be in the book. Quote it; do not summarise." }),
      context: Type.Optional(Type.Number({ description: "Lines of context around a hit. Default 1." })),
    }),
    replay: "safe",
    execute: async (args) => {
      let book: Book;
      try {
        book = getBook(args.book);
      } catch (e) {
        return { content: [{ type: "text" as const, text: `${CANNOT_VERIFY}: ${(e as Error).message}` }] };
      }
      const extract = readExtract(book);
      if (!extract.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${CANNOT_VERIFY}\n${extract.reason}\n${provenance(book, extract.expected ?? "?", extract.path ?? "?")}`,
            },
          ],
        };
      }

      const context = args.context ?? 1;
      const exact = findPassage(extract.text, args.claim, { context, max: 3 });
      if (exact.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: ["verdict: CONFIRMED", provenance(book, extract.sha256, extract.path), "", exact.map(cite).join("\n\n")].join(
                "\n",
              ),
            },
          ],
        };
      }

      // The book's own defects can hide a correct quotation. Retry against a repaired copy of the
      // extract, and label the weaker verdict honestly: text that only matches after repair did not
      // match on the page, and quoting it as-is would paste the defect into real work.
      const repairedText = normalizeForDefects(extract.text);
      const repaired =
        repairedText !== extract.text
          ? findPassage(repairedText, normalizeForDefects(args.claim), { context, max: 3 })
          : [];
      if (repaired.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "verdict: CONFIRMED_AFTER_NORMALIZATION",
                "The text is present, but only after accounting for a defect the register declares in this extract (a curly quote, an en-dash where `--` was meant, or a literal backtick-r-n leak). Quote it from the source, not from the extract.",
                provenance(book, extract.sha256, extract.path),
                "",
                repaired.map(cite).join("\n\n"),
              ].join("\n"),
            },
          ],
        };
      }

      const broken = damageReport(book, extract.text).filter((d) => d.state !== "PASS");
      // Show where the claim would live if the book made it at all. The opening words are searched
      // at decreasing length, because the useful thing to show is the real sentence beside the
      // claimed one — a reader can then see the difference. It is labelled as a near miss, never
      // as a match, and it is never the basis of a verdict.
      const words = args.claim.trim().split(/\s+/);
      let near: ReturnType<typeof findPassage> = [];
      for (const n of [8, 6, 4]) {
        if (words.length < n) continue;
        near = findPassage(extract.text, words.slice(0, n).join(" "), { context, max: 2 });
        if (near.length) break;
      }
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `verdict: ${CANNOT_VERIFY}`,
              `The claim was not found in ${book.id} ${book.edition}. It is NOT thereby false. The extract is derived text and may carry damage the register declares, and a quotation can span a figure, a table, or an image folding the extract cannot reach.`,
              near.length
                ? `Closest match, on the claim's opening words — for you to judge, not a match:\n${near.map(cite).join("\n\n")}`
                : "No similar passage was found either.",
              broken.length ? `Register damage rows that no longer match this extract: ${broken.map((d) => d.class).join("; ")}` : "",
              "",
              provenance(book, extract.sha256, extract.path),
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      };
    },
  });

  const canonSection = section(
    "book-canon",
    async () => {
      let listing: string;
      try {
        listing = loadRegister()
          .books.map((b) => `- ${describeBook(b)}`)
          .join("\n");
      } catch (e) {
        return [
          `The canon register could not be read (${registerPath()}): ${(e as Error).message}`,
          "Book claims are therefore unverifiable in this session. Say so rather than quoting a book from memory.",
        ].join("\n");
      }
      return [
        "The books this estate treats as authoritative, and their editions:",
        listing,
        "",
        "Rules for anything you attribute to one of these books:",
        "1. Read it with `book_lookup`. Never quote a book from memory, and never type a file path: the register resolves books by name.",
        "2. Cite the edition, the extract hash and the line number you read. A claim without a location cannot be checked by anyone else.",
        "3. CANNOT VERIFY FROM SOURCE is a complete answer. If a tool returns it, say you could not verify the claim. Do not reconstruct the passage from expectation.",
        "4. The extracts are derived text and carry known defects. Quoting a command or a code fragment from one can paste a defect into real work. `book_verify` reports when a quotation only matches after normalising those defects.",
        "5. Call `book_verify` when you need to check a claim rather than make one. It redoes the claim against the raw extract, and it will refuse.",
      ].join("\n");
    },
    { tag: true },
  );

  return defineExtension({ name: "book-canon", sections: [canonSection], tools: [bookLookup, bookVerify] });
}

// ------------------------------------------------------------------ the extensions

export const ADDON_INFO: Omit<HarnessExtensionInfo, "enabled" | "prompts">[] = [
  {
    name: "system-prompts",
    title: "System prompts",
    description: "Adds the checked prompts to this agent's system prompt. A change applies from the next request.",
  },
  {
    name: "jev-damage-control",
    title: "Jev damage control",
    description:
      "Before every bash call, Jev judges the command in about 300 ms and blocks irreversible or destructive ones. The decision is a durable memo, so a restart never re-asks. If Jev is down, commands run.",
  },
  {
    name: "book-canon",
    title: "Book canon",
    description:
      "Adds the authoritative books, their editions and the rules for citing them to this agent's system prompt, plus `book_lookup` and `book_verify`. Both tools read only extracts whose hash matches the canon register and answer CANNOT VERIFY FROM SOURCE otherwise. The register is DevPaulE/agent-patterns/canon/canon.yaml; move it with BOOK_CANON_REGISTER.",
  },
  { name: "desk", title: "Desk ledger", description: "The per-project ledger: `ledger_add` is the only writer of log.jsonl and state.json, and the code that derives the desk's pages from them." },
];

export function createAddons(opts: { offline: boolean; threadName?: () => string | undefined }) {
  const prompts = defineExtension({
    name: "system-prompts",
    sections: [
      section(
        "system-prompts",
        async (input, ctx) => {
          const checklist = await input.read.snapshot(PromptChecklist, input.conversationId, ctx);
          const enabled = checklist?.enabled ?? [PROMPTS[0].id];
          const text = PROMPTS.filter((p) => enabled.includes(p.id)).map((p) => p.text);
          return text.length ? text.join("\n\n") : undefined;
        },
        { tag: false },
      ),
    ],
  });
  const judge = opts.offline ? judgeOffline : async (command: string) => gate(await askJev({ command }, BASH_QUESTIONS));
  const jev = defineExtension({
    name: "jev-damage-control",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, ctx) => {
          if (call.name !== "bash") return;
          const command = String((call.arguments as { command?: unknown }).command ?? "");
          let verdict = await api.memo<Verdict>("jev-damage-control", ctx);
          if (!verdict) {
            try {
              verdict = await api.memo<Verdict>("jev-damage-control", await judge(command), ctx);
            } catch {
              return; // Fails open: a Jev outage must not stop bash.
            }
          }
          if (verdict.block) return { block: `jev-damage-control blocked this command: ${verdict.reason}` };
        },
      }),
    ],
  });
  const canon = createBookCanon();
  // The desk add-on belongs to a thread, not to the process: `ledger_add` writes to the project the
  // *calling* thread belongs to, and one backend serves every project's thread at once. With no
  // thread named, the module's own `deskAddon` is the instance, so there is exactly one of them.
  const desk = opts.threadName ? createDeskAddon({ threadName: opts.threadName }) : deskAddon;
  const all: Record<string, Extension> = { "system-prompts": prompts, "jev-damage-control": jev, "book-canon": canon, desk };
  return { all, list: [prompts, jev, canon, desk] };
}

export type Addons = ReturnType<typeof createAddons>;
