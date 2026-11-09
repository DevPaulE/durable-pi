# REPORT — Durable Pi Network Console mockups v0.1

> Against `DESIGN-CONTRACT.md` v0.1.1 (frozen, unedited). Builder: Claude Code (designer). Reviewer: Paul. Rulings: pi.
> Dark only. No light variant was drawn (R-A: optional and secondary).

## Screens produced

| File | Screen | Frames |
|---|---|---|
| `index.html` | Click-through, live thumbnails of D1–D6, status legend | — |
| `d1-console.html` | D1 full console, calm | 1 frame, 1280×800: `main` streaming with job #14 running; `pi5-garage` offline and folded into the OfflinePanel |
| `d2-escalation.html` | D2 escalation | **D2a** the glance (watching another session, `deployer` needs you) · **D2b** one key later (the gate inline, focused) |
| `d3-job-card.html` | D3 job card expanded | phases, checkpoint trail, steps of the current phase, live command log, step ledger in the inspector, a failed run for contrast |
| `d4-states.html` | D4 honesty states | **D4a** no sessions · **D4b** offline device · **D4c** disconnected stream |
| `d5-dialogs.html` | D5 dialogs | **D5a** new session + dir browser · **D5b** model picker · **D5c** command palette |
| `d6-narrow.html` | D6 ≤900px | **D6a** tree collapsed to a rail · **D6b** tree as drawer · **D6c** inspector as bottom sheet (860×780) |

Every file is self-contained: inline `<style>`, no scripts, no fonts, no images, no network. Only the §6 tokens are used.
Outside `:root` there are no hex colours (grep-checked). The one derived value is the dialog scrim,
`color-mix(in srgb, var(--bg) 72%, transparent)`, which comes from `--bg`. Nothing in `src/` was touched,
and there's no build step.

## References followed

- **R2 Linear (primary for surface):** one accent, hairline borders, 30px rows, no shadows, restraint everywhere.
- **R4 ATC / Bloomberg (primary for attention):** the screen is grey and quiet until something needs a human. Exceptions roll up from agent → session → device → top bar, the way a sector lights up on a scope.
- **R1 Palantir Foundry/AIP:** mono metadata, status dots on every node, "ledger ›" on every stream item.
- **R3 Warp/Ghostty:** the command log in D3: timestamped, one live line, no spinner noise.
- **R5 not used.** I didn't open `~/Projects/aifund-fixture/out/index.html`. It's only needed for a light theme, which wasn't drawn.

## The glyph system (how DG2 and P2 are met with three hues)

| Meaning | Glyph | Hue | Text |
|---|---|---|---|
| ok / online / passed | filled circle | `--ok` | `✓ 14/14`, `online` |
| running / busy | **hollow ring** | `--warn` | `running 4m` |
| **needs you** | **filled diamond + solid chip** | `--warn` fill, `--bg` text | `NEEDS YOU` |
| approval gate not yet reached | hollow diamond | `--muted` | `gate · will wait for you` |
| offline | hollow square | `--err` | `offline` |
| failed | filled square | `--err` | `✕ exit 1` |
| idle / pending | hollow circle | `--muted` | `idle 2h` |
| stale (stream down) | dashed ring | `--muted` | `as of 14:41:52` |

Every glyph sits next to a status word. The D2a frame was re-rendered with `filter: grayscale(1)`: diamond, ring, circle and square all stay distinct, and the needs-you chip is still the brightest solid block on screen.

## How D2 passes the one-second test

In D2a only one thing changes from D1, and it's the **only solid-filled amber shape on the screen**. It appears in two places that agree with each other:

1. **Top bar chip:** `◆ 1 needs you · deployer [G N]`, filled `--warn`, dark text, 11:1 contrast. Everything else in the top bar is grey text.
2. **Tree row:** `deployer ◆ NEEDS YOU`, the same chip. Its session and device take the diamond glyph too, so it still shows when collapsed. In D6 it also shows on the rail.

Running work (`main`, job #14) stays a hollow amber ring with small amber text. It's the same hue, but a different shape and a lower weight. So the screen has exactly one heavy amber object.

D2b shows what one keystroke (`G N`) gets you. The gate sits inline in the transcript with a `--warn` hairline. It shows what approving will run (the exact commands), what declining does, and the evidence (tests, tsc, evals, diff). The inspector says what approval does, whether it can be undone, and which files changed. The Approve button is `--text`-filled (the strongest neutral) and has the accent focus ring: `A` approves, `D` declines. The command palette (D5c) always ranks needs-you items first, so `⌘K ⏎` approves from anywhere.

**This hasn't been tested on people.** DG9 asks for a timed glance with at least 3 people. My only check was the greyscale screenshot.

## Contract criteria I'm unsure about (for pi to rule on)

1. **P2: "three status hues (ok/warn/err/busy)" lists four meanings on three hues.** Running and needs-review both use `--warn`. I told them apart by shape and weight (ring vs. filled diamond + solid chip). That makes the escalation's salience depend on *fill area*, not a separate hue. Is a solid `--warn` fill for needs-you within "colour carries state and nothing else"? I think yes, because it's the same state family, escalated. A ruling would settle it.
2. **The Approve button isn't the accent.** The accent is reserved for selection and focus. Approve is `--text`-filled, and the accent shows on it only as a focus ring. If pi wants approve in the accent, that would spend the accent on a verb and break P2's "only for selection/focus".
3. **Accent `#c8794f` and `--warn` `#fbbf24` sit next to each other in hue.** A copper selection outline could be read as state. I limited the accent to 1px outlines and the active-tab underline, and never use it as a fill. Worth watching in the timed test.
4. **DG4 and `--faint`.** `--faint` is 3.26:1 on `--bg` and 2.81:1 on `--surface-2`, which is below 4.5. I use it only where §6 says to: disabled text, ghost text, queued steps, units. Body and secondary text use `--text` (14.5:1) or `--muted` (5.9:1 on bg, 5.1:1 on surface-2). If DG4 is meant to cover every text token, `--faint` fails as specified.
5. **DG3 scope.** Ids, paths, params, model names, agent names, commands, timestamps and logs are mono. **Session titles** ("aifund fixture refresh") are typed by a human, so I left them in sans. Tell me if they count as machine strings.
6. **DG6 is shown, not exhaustively.** Every stream item carries a `ledger ›` affordance, and an expanded tool call shows its TypeScript declaration (IP5). Full ledger views are drawn only for a job step (D3 inspector) and an approval (D2b inspector). There's no ledger mock for a plain user or agent turn.
7. **IP2 pulse.** At most one element per frame pulses: the current phase glyph of the running job. The streaming cursor is a static block. In D2b nothing pulses, so the gate isn't competing.
8. **"Hairlines only" and the gate border.** The gate's border is 1px in `--warn`. It's a hairline, but a coloured one. The offline banner in D4b does the same with `--err`.
9. **Top-bar overflow at 1280px.** With the needs-you chip present, the health strip gets tight at 1280. I removed the hub address and the agent count to fit. A long agent name in the chip would need ellipsis rules. That's an implementation note.
10. **Things I added that the contract doesn't specify:** the `G N` jump-to-needs-you shortcut, `A`/`D` on the gate, a hollow diamond for "gate ahead", the dashed "stale" ring and `as of` stamps for D4c, and a rail-plus-drawer for D6 (the contract says only "tree collapses").
11. **D4c behaviour claims** are design intent, not verified against the hub: the draft is kept, editing pauses while disconnected, and missed events replay in order on reconnect. Someone needs to confirm `stream.ts` can do the replay.

## R6: an enforcement point per principle (proposed)

| Principle | Enforcement point |
|---|---|
| P1 attention | DG9 timed glance on D2a; also "one pulse per screen" (grep `pulse` count ≤ 1 per frame) |
| P2 colour = state | DG8 token count + grep: no hex outside `:root`; accent appears only in `outline`/focus/tab rules |
| P3 mono | DG3 grep: every id/path/model token wrapped in `.m`/`code`/`pre` |
| P4 inspectable | DG6 click-through: every `.item` has a ledger target |
| P5 approve | gate has a keyboard binding and focus on arrival (D2b); palette ranks needs-you first (D5c) |
| P6 density | DG1 screenshot at 1280×800, all three panes visible |
| P7 honesty | DG7: D4a/b/c present; every stale surface carries one shared `as of` timestamp |

## Checks run on the artifact

- DG5: zero matches for `box-shadow`, `linear-gradient`, `radial-gradient` or `conic-gradient` across all files.
- No `http(s)` src/href, no `url(` and no `@import` in any file.
- Contrast was computed from the §6 values (WCAG). The numbers are in item 4 above.
- DG1: every D1–D5 frame is exactly 1280×800, with tree, transcript and inspector all visible.
- Everything was rendered in Chromium and inspected by screenshot, including a greyscale render of D2a.

Stopping here for Paul's review.
