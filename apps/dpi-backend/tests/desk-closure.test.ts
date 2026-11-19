/**
 * G14 (SPEC G14) — the closure gate. "An answered follow-up stops counting as a need."
 *
 * Estate rule: a gate is trusted only after it has been shown FAILING on a planted fault (RED first),
 * so this file is written before the behaviour it tests exists. On the build as of 2026-11-19 it fails
 * for two reasons: a follow-up carries no `id`, and no line can close one. Both are the defect.
 *
 * The plant is one project with one sourced follow-up. Nothing about it is unusual: it is the ordinary
 * shape of "ask the builder about the drain", and the ledger's only failure is that it can never be
 * discharged. The closer is an ordinary appended line carrying `closes`, so the mechanism stays inside
 * the append-only law — no rewrite, no new kind, no second writer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveViews, ledgerAdd } from "../src/desk-addon.js";

const TODAY = "2026-11-19";
const SLUG = "closure-gate";

type State = {
  needs: number;
  follow_ups: { id?: string; text?: string; closed?: boolean; closed_by?: string; closed_date?: string }[];
};

async function readState(root: string): Promise<State> {
  return JSON.parse(await readFile(join(root, "projects", SLUG, "state.json"), "utf8")) as State;
}

async function planted() {
  const root = await mkdtemp(join(tmpdir(), "desk-g14-"));
  const opts = { root, slug: SLUG, name: "Closure gate", today: TODAY };
  const a = ledgerAdd({ date: "2026-11-18", source: "call transcript 2026-11-18", text: "Ship the shed door in March.", kind: "decision" }, opts);
  assert.equal(a.ok, true, `plant decision refused: ${a.ok ? "" : a.reason}`);
  const b = ledgerAdd({ date: "2026-11-18", source: "call transcript 2026-11-18", text: "Ask the builder about the drain.", kind: "follow_up" }, opts);
  assert.equal(b.ok, true, `plant follow-up refused: ${b.ok ? "" : b.reason}`);
  return { root, opts };
}

test("G14 closure: an answered follow-up stops counting as a need", async () => {
  const { root, opts } = await planted();
  try {
    deriveViews(root, SLUG, { today: TODAY });
    const before = await readState(root);
    assert.equal(before.needs, 1, "one open follow-up counts as one need");

    // A later line cannot name the item unless the item has a stable id. This is the first thing the
    // build lacks, and it is why the closing rule needs a writer change and not only a derivation one.
    const fu = before.follow_ups[0];
    assert.ok(fu?.id, "a follow-up must carry an id so a later line can name it");

    // The closer is an ordinary appended line. Nothing is rewritten and no new kind is introduced.
    const closed = ledgerAdd(
      { date: TODAY, source: "in-app capture 2026-11-19", text: "Builder answered: the drain goes east of the pad.", kind: "note", closes: fu.id } as never,
      opts,
    );
    assert.equal(closed.ok, true, `closing line refused: ${closed.ok ? "" : closed.reason}`);

    deriveViews(root, SLUG, { today: TODAY });
    const after = await readState(root);
    assert.equal(after.needs, 0, "a closed follow-up must stop counting as a need");

    const closedFu = after.follow_ups.find((x) => x.id === fu.id);
    assert.ok(closedFu, "the follow-up must still be in the record after closing — append-only means nothing is deleted");
    assert.equal(closedFu.closed, true, "the follow-up must read as closed");
    assert.ok(closedFu.closed_by, "a closed item must name the line that closed it");
    assert.equal(closedFu.closed_date, TODAY, "a closed item must carry the closing date");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("G14 closure: a closer naming no item is refused and is not written", async () => {
  const { root, opts } = await planted();
  try {
    const dangling = ledgerAdd(
      { date: TODAY, source: "in-app capture 2026-11-19", text: "Close something that does not exist.", kind: "note", closes: "no-such-item" } as never,
      opts,
    );
    assert.equal(dangling.ok, false, "a closes naming no item must be refused");
    assert.match(dangling.ok ? "" : dangling.reason, /close/i, "the refusal must say it is a dangling close");

    const log = await readFile(join(root, "projects", SLUG, "log.jsonl"), "utf8");
    assert.equal(log.includes("no-such-item"), false, "a refused line must not reach the ledger");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("G14 closure: a closer without a date or a source is refused by the existing rules", async () => {
  const { root, opts } = await planted();
  try {
    deriveViews(root, SLUG, { today: TODAY });
    const fu = (await readState(root)).follow_ups[0];
    assert.ok(fu?.id, "precondition: the follow-up carries an id");

    const noSource = ledgerAdd({ date: TODAY, text: "Closed with no source.", kind: "note", closes: fu.id } as never, opts);
    assert.equal(noSource.ok, false, "a closer with no source must be refused");

    const noDate = ledgerAdd({ date: "", source: "in-app capture 2026-11-19", text: "Closed with no date.", kind: "note", closes: fu.id } as never, opts);
    assert.equal(noDate.ok, false, "a closer with no date must be refused");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
