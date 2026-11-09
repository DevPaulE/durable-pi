# DESIGN-CONTRACT — Durable Pi Network Console

> v0.1.2 · 2026-11-09 · author: pi (design contract) · builder: Claude Code (design artifact)
> v0.1.2 amendments (RULING-PI.md, 2026-11-09): DG4 scoped to information-carrying text; DG3's
> mono test = who emitted the string; DG11 added (≤1 solid --warn object per frame);
> DG10 added (implementation-phase ordered-replay test); builder additions adopted.
> Status: **RULINGS LOCKED** (Paul, 2026-11-09). The contract is frozen before the design artifact
> is drawn (same rule as WO-057: contract first, surface second, gate-author ≠ builder).
> Where this file and any later artifact differ, THIS FILE WINS until amended with a version bump.
>
> **Rulings (2026-11-09, Paul) — binding on the builder:**
> - **R-A — Dark-first; light as backup.** The primary artifact is dark. A light variant is a
>   *secondary* deliverable, drawn only if budget remains, never a co-equal theme.
> - **R-B — Static HTML mockups.** The deliverable is self-contained HTML mockups of the six
>   screens (D1–D6). No build step, no framework install, no network. Vue implementation happens
>   only *after* the design is accepted.

## 0. What this artifact is

The **Durable Pi Playground** — the web client of a durable-agent network. It runs no agents.
It renders, over one SSE connection per tab, the live state of many devices, each holding many
sessions, each holding many agents and durable-job runs.

Three concurrent facts define the design problem:

1. **Many streams at once** — device trees, session transcripts, agent runs, job phases.
2. **Long-running and durable** — work continues while you are away; it checkpoints and resumes.
3. **You are near-loop, not in-loop** (IndyDevDan; LEVELS.md L4). The agents do the work.
   Your verbs are **scan, decide, approve** — not prompt and babysit.

## 1. The north star

**A control room, not a chat app.**

The world-class reference is not a messaging UI. It is **air-traffic control and a trading floor**:
an operator watching many concurrent processes, each carrying state, who must know *instantly*
where to intervene and must ignore everything else with confidence.

The console's single job: **make the one thing that needs you visible among the many that do not.**

If a design choice makes the calm screen busier without making the *exception* clearer, it fails.

## 2. Design principles (irreducible — an artifact violating any one is RED, not styled)

- **P1 — Attention is the scarce resource.** Default screens are calm. Escalation is earned by
  signal, never by decoration. The cost of a false alarm is a missed true one.
- **P2 — Color carries state and nothing else.** One accent for selection/focus; three status
  hues (ok/warn/err/busy). No brand color sprinkled for taste. Grayscale-warm for everything else.
- **P3 — Machine output is monospace.** Session ids, device ids, paths, tool parameters, model
  names, diffs, logs. This single rule *is* the console look. UI prose stays sans.
- **P4 — Everything is inspectable.** Every run, every transcript item, every job opens to its
  ledger — the prompt, the response, the tools, the failure behavior, the checkpoint trail
  (Palantir's "almost a ledger"). Nothing is a dead end.
- **P5 — The primary verb is approve.** Prompting exists, but the interface is built around
  review-and-gate. The approval affordance is first-class, not a footer button.
- **P6 — Density is a feature.** Tree + inspector + transcript are visible at once. Whitespace
  that pushes one of them off-screen is a defect at ≥1280px.
- **P7 — Honesty states are designed.** Empty, offline, no-session, no-signal, and error states
  are part of the deliverable, not fallbacks. A console that only shows the happy path is a demo,
  not a tool (this is the P5 panel of the aifund doctrine, applied here).

## 3. Information architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ TOP BAR   network identity · device health strip · ⌘K command · help │
├───────────────┬───────────────────────────────────┬─────────────────┤
│ NETWORK TREE  │ AGENT VIEW                        │ INSPECTOR       │
│               │                                   │                 │
│ device ●      │ transcript stream                 │ tabs:           │
│  └ session ●  │  ├ user / agent turn              │  Session  (ctx) │
│     └ agent ● │  ├ JOB CARD (phases, progress)    │  State    (live)│
│     └ agent ○ │  ├ approval gate  ← needs you     │  Tasks          │
│ device ○ off  │  └ tool call (mono, expandable)   │  Tools          │
│               │                                   │  Extend         │
│ [+ new session]│  ── composer (prompt) ──          │                 │
└───────────────┴───────────────────────────────────┴─────────────────┘
```

- **Top bar** — identity + a health strip that summarises the whole fleet in one glance.
- **Left** — the network tree: device → session → agent, each with a status dot. Offline devices
  fold into an `OfflinePanel`, not a broken tree.
- **Center** — the agent view: the transcript stream with **job cards inline** and **approval
  gates inline**. The scroll is the story of the work.
- **Right** — the inspector: Session (context bar), State (the shared App State as *live controls*,
  not a JSON blob), Tasks, Tools, Extend.
- **Overlay** — the command palette (⌘K) and dialogs.

## 4. Interaction patterns

- **IP1 — Scan, triage, open.** The tree summarises (dots). Click opens the ledger. You never
  read a tree to understand state; you read it to *find the exception*.
- **IP2 — The job card is the durable unit.** A job card shows: name, current phase, elapsed,
  checkpoint state, and — on expand — the phase list with per-phase outcome and command log.
  A running job *looks alive* without animation noise (a pulse on one element, not five).
- **IP3 — Approval is an event.** When an agent needs a human, the item escalates: it surfaces
  in the tree, inline in the transcript, and in a persistent "needs you" counter in the top bar.
  Approving is one keystroke.
- **IP4 — State is editable in place.** The State tab renders App State as typed controls
  (number, toggle, text, nested). Editing is optimistic and visible. This mirrors the demo's own
  doctrine: the shared object is a live control surface, not a read-only dump.
- **IP5 — Tool params are code.** Render tool parameters as a TypeScript declaration in mono
  (`signature.ts` already emits this shape). Expandable, copyable.
- **IP6 — Reconnection is honest.** Stream drop → a visible, calm reconnecting state with the
  last-good timestamp. Never a silent freeze (see the aifund failure: "synchronizing context…"
  frozen forever — that is the anti-pattern this console must never reproduce).

## 5. Screens the design artifact must contain (the deliverable scope)

| # | Screen | Purpose |
|---|---|---|
| **D1** | Full console, populated — one session streaming, one device offline | the default, calm state |
| **D2** | **Escalation** — one agent needs approval, everything else calm | the north-star test: is the exception obvious? |
| **D3** | Job card expanded — phases, checkpoints, command log | the durable unit, inspectable |
| **D4** | Honesty states — empty (no sessions), offline device, disconnected stream | the blanks (P7) |
| **D5** | Dialogs — new session (+ dir browser), model picker, command palette | the control surfaces |
| **D6** | Narrow collapse (≤900px) — tree collapses, inspector becomes a sheet | graceful degradation |

Six screens. Not a style guide — a set of *states you can look at and judge*.

**Format (R-B):** each screen is a **self-contained HTML file** (inline CSS, inline tokens, no
build step, no external requests). A single `index.html` linking D1–D6 is the preferred shape so
Paul can click through. Mockups use static representative data; the contract's tokens are the only
source of style values. A light variant (R-A) is optional and secondary.

## 6. Visual system (tokens — hand these to the builder verbatim)

Dark-first. Warm near-black base (already in `index.html`: `theme-color #171214`).

| Token | Value | Use |
|---|---|---|
| `--bg` | `#171214` | app background |
| `--surface` | `#1f1a1c` | panes, cards, popovers |
| `--surface-2` | `#262023` | hover, selected row, inset |
| `--border` | `rgba(255,255,255,.07)` | hairlines only |
| `--text` | `#e8e2e1` | primary text |
| `--muted` | `#9a8f8d` | labels, timestamps, secondary |
| `--faint` | `#6d6563` | disabled, ghost text |
| `--ok` | `#4ade80` | online / passed / green |
| `--warn` | `#fbbf24` | busy / running / needs-review |
| `--err` | `#f87171` | offline / failed / blocked |
| `--accent` | `#c8794f` | selection / focus ring — **the only accent** |
| `--font-ui` | `system-ui, -apple-system, sans-serif` | prose, labels |
| `--font-mono` | `ui-monospace, "SF Mono", "JetBrains Mono", monospace` | all machine text |
| radius | `6px` | controls; `3px` chips |
| row height | `30px` (tree) / `13px` text | density |
| shadow | **none** | hairlines and surfaces only |

## 7. Reference set (look at these before drawing; name which you followed in the artifact)

- **R1 — Palantir Foundry / AIP:** dark data-density, monospace metadata, status dots, zero ornament.
- **R2 — Linear:** restraint — one accent, hairline borders, 30px rows, no shadows.
- **R3 — Warp / Ghostty:** how a terminal renders streams, diffs and job progress calmly.
- **R4 — Air-traffic control / Bloomberg terminal:** the *attention model* — many concurrent
  processes, one glance finds the exception.
- **R5 — Anthropic Console + the aifund demo's own CSS** (`out/index.html`): a clean, restrained
  light/dark pair to borrow if a light theme is wanted later.

## 8. Acceptance criteria (the design gate — RED-first, checked on the artifact)

| ID | Criterion | Check |
|---|---|---|
| DG1 | Three panes visible at ≥1280px | screenshot |
| DG2 | Status is color **and** shape/text, never color alone | inspect the dots at greyscale |
| DG3 | Every machine-emitted string is monospace (test is SOURCE: device, agent, tool, clock, path, id, params, model names, logs; human-typed prose = sans) | grep the artifact's markup |
| DG4 | Body text contrast ≥ 4.5:1 on `--bg` and `--surface` (information-carrying text: `--text`, `--muted`); `--faint` decorative-only — never state, never ids, never values; floor ≥ 2.8:1 | contrast check |
| DG5 | No shadows, no gradients; borders are hairlines | grep for `box-shadow`/`linear-gradient` |
| DG6 | Every stream item expands to a ledger view | click-through |
| DG7 | Empty / offline / disconnected states all designed (D4 present) | screenshot |
| DG8 | Exactly one accent color; exactly three status hues | token count |
| DG9 | D2 (escalation) makes the needing-you item obvious in **< 1 second** — the north-star test | timed glance, ≥3 people |
| DG10 | Stream reconnect replays missed events in order (design intent in D4c; PROVEN only after a hub-disconnect test in the implementation) | hub-disconnect test, later |
| DG11 | At most ONE solid `--warn` object per frame (needs-you is the only one); running/busy stays hollow | grep fill shapes ≤ 1 per frame |

## 9. Division of labor (the seam — same as WO-057)

- **pi authors and freezes this contract** and the tokens. pi does not draw the artifact.
- **Claude Code designs the artifact** — the six screens (D1–D6) as self-contained HTML/Vue
  mockups behind this frozen contract. Claude Code never edits this file; changes come through pi
  with a version bump.
- **Paul reviews** the artifact and rules. Implementation into the real Vue components
  (`App.vue`, the four CSS files) happens only after the design is accepted.

**R6 note (from the D2 ruling):** the design must pre-agree an enforcement point for each
principle (P1–P7) — a check in the gate above — because an invariant with no enforcement is drift
waiting to happen.
