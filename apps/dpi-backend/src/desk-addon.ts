// The desk add-on: one project's ledger, and the pages derived from it.
//
// SPEC cos-app v1.1 §1b, §5, §7, §13a-B, §19. This file is the ONLY writer of `log.jsonl` and
// `state.json` (one writer, DAI 4.4 line 9940). It writes DATA, never HTML (amendment C):
//
//   * `ledger_add` accepts a line only with a `date` and a `source`, refuses a line whose `date`
//     precedes its `source` date, and on acceptance appends to `log.jsonl` and updates `state.json`.
//   * a refused line is NEVER written to the ledger. The refusal appends
//     `{at, reason, chars, sha256}` to `refused.jsonl` — reason and time only, never the text
//     (amendment A).
//   * `deriveViews` turns those two files into the code-derived data the front end renders:
//     `views/where-we-left-off.json`, `views/receipts.json`, `views/egress.json`,
//     `views/brief.json` and `projects.json`. No model writes these; no template renders them.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { Type } from "typebox";

/** A capture as it reaches the ledger. `date` and `source` are what `ledger_add` insists on. */
export type LedgerLine = { date?: string; source?: string; text?: string; kind?: string };
export type LedgerResult = { ok: true } | { ok: false; reason: string };
export type Fact = { date: string; source: string; text: string };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const nowIso = () => new Date().toISOString();
const projectDir = (root: string, slug: string) => join(root, "projects", slug);

/** The date a source string names, if it names one. Appendix B sources do; `call, transcribed` does not. */
export function sourceDate(source: string): string | undefined {
  return (source.match(/(\d{4}-\d{2}-\d{2})/) || [])[1];
}

const KIND_BUCKET: Record<string, "decisions" | "open_items" | "follow_ups"> = {
  decision: "decisions",
  open: "open_items",
  follow_up: "follow_ups",
};

/**
 * Add one line to a project's ledger. The only writer of `log.jsonl` and `state.json`.
 * Refuses a line with no date and a line with no source; refuses a `date` earlier than its
 * `source` date. A refusal writes nothing to the ledger and appends the refusal record instead.
 */
export function ledgerAdd(line: LedgerLine, opts: { root: string; slug: string }): LedgerResult {
  const dir = projectDir(opts.root, opts.slug);
  mkdirSync(join(dir, "views"), { recursive: true });
  const at = nowIso();
  const text = String(line.text ?? "");
  const refuse = (reason: string): LedgerResult => {
    appendFileSync(join(dir, "refused.jsonl"), JSON.stringify({ at, reason, chars: text.length, sha256: sha256(text) }) + "\n");
    return { ok: false, reason };
  };

  if (!line.date) return refuse("missing date");
  if (!line.source) return refuse("missing source");
  const sd = sourceDate(line.source);
  if (sd && line.date < sd) return refuse("date precedes source");

  const kind = line.kind ?? "note";
  const rec = { date: line.date, source: line.source, text, kind };
  appendFileSync(join(dir, "log.jsonl"), JSON.stringify(rec) + "\n");

  const statePath = join(dir, "state.json");
  const st = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : { project: opts.slug, revision: 0, updated_at: at, last_touch: line.date, decisions: [], open_items: [], follow_ups: [] };
  st.revision += 1;
  st.updated_at = at;
  st.last_touch = line.date;
  const bucket = KIND_BUCKET[kind];
  if (bucket && Array.isArray(st[bucket])) st[bucket].push({ date: rec.date, source: rec.source, text: rec.text });
  writeFileSync(statePath, JSON.stringify(st, null, 1));
  return { ok: true };
}

const readJson = <T>(p: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return fallback;
  }
};
const logLines = (dir: string): { date?: string; source?: string; text?: string; kind?: string }[] => {
  const p = join(dir, "log.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return {};
      }
    });
};
const refusedCount = (dir: string): number => {
  const p = join(dir, "refused.jsonl");
  if (!existsSync(p)) return 0;
  return readFileSync(p, "utf8").split("\n").filter(Boolean).length;
};
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const slugs = (root: string): string[] => {
  const base = join(root, "projects");
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((e) => statSync(join(base, e)).isDirectory());
};

/**
 * Derive every page file from the ledger (amendment C: pages are a render of the ledger, by code).
 * Writes per-project `views/where-we-left-off.json`, `views/receipts.json`, `views/egress.json`,
 * the cross-project `views/brief.json`, and the nav index `projects.json`. It never writes
 * `log.jsonl`/`state.json` — that is `ledger_add`'s alone.
 */
export function deriveViews(root: string, slug: string, opts: { today?: string; windowDays?: number } = {}): void {
  const today = opts.today ?? nowIso().slice(0, 10);
  const windowDays = opts.windowDays ?? 14;
  const dir = projectDir(root, slug);
  const state = readJson<Record<string, unknown>>(join(dir, "state.json"), {});
  const facts = (k: string): Fact[] => (Array.isArray(state[k]) ? (state[k] as Fact[]) : []);
  const lastTouch = typeof state.last_touch === "string" ? state.last_touch : today;

  mkdirSync(join(dir, "views"), { recursive: true });
  writeFileSync(
    join(dir, "views", "where-we-left-off.json"),
    JSON.stringify({
      project: slug,
      gap_days: daysBetween(lastTouch, today),
      last_touch: lastTouch,
      refused_count: refusedCount(dir),
      decisions: facts("decisions"),
      open_items: facts("open_items"),
      follow_ups: facts("follow_ups"),
    }),
  );
  const receiptPath = join(dir, "views", "receipts.json");
  if (!existsSync(receiptPath)) writeFileSync(receiptPath, JSON.stringify({ runs: [] }));
  const egressPath = join(dir, "views", "egress.json");
  if (!existsSync(egressPath)) writeFileSync(egressPath, JSON.stringify({ rows: [], none_rows: 0 }));

  const all = slugs(root);
  const projects = all.map((s) => {
    const d = projectDir(root, s);
    const st = readJson<Record<string, unknown>>(join(d, "state.json"), {});
    const open = Array.isArray(st.open_items) ? st.open_items.length : 0;
    const follow = Array.isArray(st.follow_ups) ? st.follow_ups.length : 0;
    return {
      slug: s,
      name: typeof st.project === "string" ? st.project : s,
      last_touch: typeof st.last_touch === "string" ? st.last_touch : today,
      needs: open + follow,
      refused_count: refusedCount(d),
    };
  });
  const floor = new Date(Date.parse(today) - windowDays * 86_400_000).toISOString().slice(0, 10);
  const briefLines: { project: string; date: string; source: string; text: string }[] = [];
  let briefRefused = 0;
  for (const s of all) {
    const d = projectDir(root, s);
    briefRefused += refusedCount(d);
    for (const l of logLines(d)) {
      if (l.date && l.source && l.text && l.date >= floor) briefLines.push({ project: s, date: l.date, source: l.source, text: l.text });
    }
  }
  briefLines.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  mkdirSync(join(root, "views"), { recursive: true });
  writeFileSync(
    join(root, "views", "brief.json"),
    JSON.stringify({ window_days: windowDays, generated_at: nowIso(), lines: briefLines.slice(0, 5), refused_count: briefRefused }),
  );
  writeFileSync(join(root, "projects.json"), JSON.stringify({ projects, today }));
}

/** The desk root the tool writes to; the fixture lives inside the clone during development. */
const deskRoot = () => process.env.DESK_ROOT ?? join(homedir(), "Desk");

const ledgerAddTool = defineTool({
  name: "ledger_add",
  description:
    "Add one dated, sourced line to a project's ledger. The only writer of log.jsonl and state.json. Refuses a line with no date or no source, and a date earlier than its source date; a refused line is never written to the ledger.",
  parameters: Type.Object({
    project: Type.String({ description: "The project slug (its folder under the desk root)." }),
    date: Type.Optional(Type.String({ description: "The line's date, YYYY-MM-DD." })),
    source: Type.Optional(Type.String({ description: "Where the line came from, e.g. 'in-app capture 2026-02-14'." })),
    text: Type.String({ description: "The line itself." }),
    kind: Type.Optional(Type.String({ description: "decision | open | follow_up | note" })),
  }),
  replay: "safe",
  execute: async (args) => {
    const root = deskRoot();
    const result = ledgerAdd(args, { root, slug: args.project });
    if (!result.ok) return { content: [{ type: "text" as const, text: `refused: ${result.reason}` }] };
    deriveViews(root, args.project);
    return { content: [{ type: "text" as const, text: `added to ${args.project}` }] };
  },
});

/** The extension `addons.ts` registers; its one tool is `ledger_add`. */
export const deskAddon: Extension = defineExtension({ name: "desk", tools: [ledgerAddTool] });
