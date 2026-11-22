// actions-report.ts — what works, read off the action log: counts and failure rates, real beside sandbox.
//
// SPEC-action-log-2026-11-21.md §2.3: the report is the decision input, not an argument. It reads the
// shell's own `actions.jsonl` (real use) and any number of sandbox logs, and prints one row per
// (source, action) with its count and its failure rate, then the two sources side by side.
//
//   tsx actions-report.ts [--real FILE] [--sandbox FILE ...]
//
// With no `--real`, it reads `$DPI_HOME/actions.jsonl` (default `~/.dpi-desk/actions.jsonl`). It only
// reads: no file is written, nothing is sent, and a line it cannot parse is counted, not crashed on.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The closed set, in the order the log's own pin lists it. Anything else is printed last, by name. */
const ACTIONS = ["new-session", "send", "stop", "open-view"];
const SOURCES = ["real", "sandbox"];

type Tally = { count: number; failed: number };
type Summary = { label: string; file: string; lines: number; malformed: number; actions: Map<string, Tally>; unknown: number; sources: Set<string> };

const args = process.argv.slice(2);
const values = (flag: string): string[] => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));
const bad = args.filter((a, i) => a.startsWith("--") && !["--real", "--sandbox"].includes(a));
if (bad.length) {
  console.error(`actions-report: unknown option ${bad[0]}\nusage: tsx actions-report.ts [--real FILE] [--sandbox FILE ...]`);
  process.exit(2);
}

const home = process.env.DPI_HOME ?? join(homedir(), ".dpi-desk");
const realFiles = values("--real");
const sandboxFiles = values("--sandbox");
if (realFiles.length === 0 && sandboxFiles.length === 0) realFiles.push(join(home, "actions.jsonl"));

const pct = (n: number, of: number) => (of === 0 ? "  n/a" : `${((100 * n) / of).toFixed(1)}%`.padStart(6));
const pad = (s: string, n: number) => s.padEnd(n);

function tally(label: string, file: string): Summary {
  const s: Summary = { label, file, lines: 0, malformed: 0, actions: new Map(), unknown: 0, sources: new Set() };
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return s;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    s.lines++;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      s.malformed++;
      continue;
    }
    const rec = o as { source?: unknown; action?: unknown; outcome?: unknown };
    const name = typeof rec.action === "string" ? rec.action : "(no action)";
    if (!ACTIONS.includes(name)) s.unknown++;
    if (rec.source === "real" || rec.source === "sandbox") s.sources.add(rec.source);
    else s.unknown++;
    const t = s.actions.get(name) ?? { count: 0, failed: 0 };
    t.count++;
    if (rec.outcome !== "worked") t.failed++;
    s.actions.set(name, t);
  }
  // The log's own `source` is authoritative — that is the field the pin defines — and the flag only
  // says which file to read. They agree unless someone pointed the flag at the other one's log.
  if (s.sources.size === 1) s.label = [...s.sources][0];
  return s;
}

function total(s: Summary): Tally {
  const t: Tally = { count: 0, failed: 0 };
  for (const a of s.actions.values()) {
    t.count += a.count;
    t.failed += a.failed;
  }
  return t;
}

function order(s: Summary): string[] {
  const known = ACTIONS.filter((a) => s.actions.has(a));
  const rest = [...s.actions.keys()].filter((a) => !ACTIONS.includes(a)).sort();
  return [...known, ...rest];
}

const summaries: Summary[] = [
  ...realFiles.map((f) => tally("real", f)),
  ...sandboxFiles.map((f) => tally("sandbox", f)),
];

console.log("desk actions — by count and by failure rate");
console.log(`${pad("source", 9)} ${pad("action", 13)} ${pad("count", 6)} ${pad("failed", 7)} ${pad("rate", 6)}`);
for (const s of summaries) {
  if (s.lines === 0) {
    console.log(`${pad(s.label, 9)} ${pad("-", 13)} ${pad("0", 6)} ${pad("0", 7)} ${pad("n/a", 6)}  (no log)`);
    continue;
  }
  for (const a of order(s)) {
    const t = s.actions.get(a)!;
    console.log(`${pad(s.label, 9)} ${pad(a, 13)} ${pad(String(t.count), 6)} ${pad(String(t.failed), 7)} ${pct(t.failed, t.count)}`);
  }
  const t = total(s);
  console.log(`${pad(s.label, 9)} ${pad("(all)", 13)} ${pad(String(t.count), 6)} ${pad(String(t.failed), 7)} ${pct(t.failed, t.count)}`);
  if (s.malformed || s.unknown || s.sources.size > 1) {
    console.log(`${pad(s.label, 9)} ${pad("(notes)", 13)} ${s.malformed} unparseable line(s), ${s.unknown} line(s) off the closed set${s.sources.size > 1 ? `, ${s.sources.size} sources in one file` : ""}`);
  }
}

const beside = SOURCES.map((src) => {
  const mine = summaries.filter((s) => s.label === src);

  const t: Tally = { count: 0, failed: 0 };
  for (const s of mine) {
    const x = total(s);
    t.count += x.count;
    t.failed += x.failed;
  }
  return `${src} ${t.count} (${t.failed} failed, ${t.count ? ((100 * t.failed) / t.count).toFixed(1) + "%" : "n/a"})`;
});
console.log(`real beside sandbox: ${beside.join(" | ")}`);
