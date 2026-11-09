# FOR-CLAUDE-CODE — design the Durable Pi Network Console (mockups)

> One-shot task prompt. Paste the block below into Claude Code, run from this directory.
> Author: pi · contract to obey: `DESIGN-CONTRACT.md` (v0.1.1, frozen) · reviewer: Paul.

---

## THE TASK

Design the **Durable Pi Network Console** as **static HTML mockups**. You are the *designer*,
not the implementer. Do not touch the Vue app (`src/`), do not edit `DESIGN-CONTRACT.md`, do not
add a build step or dependencies.

**Read first, obey exactly:** `DESIGN-CONTRACT.md` in this directory. It is the frozen contract.
Where anything you'd like to do conflicts with it, the contract wins — do not "improve" it.

**Rulings in force:** dark-first (light variant optional/secondary); deliverable is self-contained
HTML mockups of the six screens.

## WHAT TO PRODUCE

A folder `design/` containing:

```
design/
  index.html        links D1–D6, each in a labeled frame; dark
  d1-console.html   full 3-pane console, populated — one session streaming, one device offline
  d2-escalation.html  one agent needs approval; everything else calm  ← the north-star test
  d3-job-card.html  a durable job card expanded — phases, checkpoints, command log
  d4-states.html    honesty states — no-sessions empty, offline device, disconnected stream
  d5-dialogs.html   new session (+ dir browser), model picker, command palette
  d6-narrow.html    ≤900px collapse — tree collapsed, inspector as a sheet
```

Each file: self-contained (inline `<style>`), no external fonts/scripts/images, no network.
Use the contract's tokens verbatim (§6). Use static representative data — invent plausible
device/session/agent names, one running job with visible phases, one approval gate.

## THE ONE THING THAT MATTERS

The north star (§1): **a control room, not a chat app — make the one thing that needs you obvious
among the many that don't.** D2 is the test. If a stranger can't find the needing-you item in
under one second, the design fails, whatever else looks good.

## HARD CONSTRAINTS (from the contract — violating any one is RED, not a style nit)

- **P2 / DG8:** one accent color; exactly three status hues; color carries *state and nothing else*.
- **P3 / DG3:** every machine-generated string is monospace (ids, paths, params, model names, logs).
- **P5:** the primary verb is *approve* — the approval affordance is first-class, not a footer button.
- **P6 / DG1:** three panes visible at ≥1280px; nothing important pushed off-screen by whitespace.
- **P7 / DG7:** D4 must actually design the empty / offline / disconnected states.
- **DG4:** body text contrast ≥ 4.5:1 on `--bg` and `--surface`.
- **DG5:** no `box-shadow`, no `linear-gradient`; hairline borders only.
- **DG2:** status conveyed by color **and** shape/text — not color alone.
- **IP6:** the disconnected state is calm and honest with a last-good timestamp — never a silent
  freeze (this is the exact failure the aifund console died of: "synchronizing context…" forever).

## REFERENCES — pick, then say which you followed

R1 Palantir Foundry/AIP (dark density, mono metadata, status dots) · R2 Linear (restraint, hairlines,
no shadows) · R3 Warp/Ghostty (calm streams/diffs) · R4 ATC / Bloomberg terminal (attention model) ·
R5 Anthropic Console + the aifund demo CSS (`~/Projects/aifund-fixture/out/index.html`).

## WHEN DONE

Write `design/REPORT.md`: screens produced · which references you followed · how D2 passes the
one-second test · every contract criterion you're unsure about. Then stop. Paul reviews; the
contract author (pi) rules on any change.
