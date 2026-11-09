# RULING-PI — design artifact v0.1 vs contract v0.1.1 (pi verifies, 2026-11-09 ~21:4xZ)

Builder: Claude Code (uncommitted artifact, correct — verdict pending). Verifier: pi (this file).

## Verification receipts (re-run independently, not taken from REPORT.md)

| Claim | My check | Result |
|---|---|---|
| DG5 no shadows/gradients | grep box-shadow/radial/linear/conic | **0 matches — PASS** |
| no external requests/scripts | grep http·url(·@import·script·link·img | **0 matches — PASS** |
| hex outside :root | re-based regex sweep all 7 files | **CLEAN — PASS** |
| frames 1280×800 (d6 860×780) | grep width/height | **PASS (matches §5) ** |
| contrast numbers | WCAG rel-luminance recomputed | text 14.47:1 · muted 5.90/5.09 · faint 3.26/2.81 · warn chip 11.10 — **every reported number exact** |
| greyscale distinctness | by construction: glyph SHAPES differ (ring/diamond/circle/square) independent of hue | **PASS structurally; DG9 human test still owed** |

Artifact verdict: **compliant, honest, real work.** Proceed to Paul review.

## Rulings (all five, settled — contract amended to v0.1.2 accordingly)

1. **Amber fill for "needs you" — ACCEPTED.** Colour carries state; "needs you" is the warn state family ESCALATED, expressed by shape (diamond vs hollow ring), fill (solid vs hollow), word, and placement (top bar + tree + collapsed rail). Codified as **DG11**: *at most ONE solid `--warn` object per frame* — measurable, grep-able, and the proxy that makes DG9's north star enforceable between human tests.
2. **Approve button neutral, not accent — CONFIRMED.** The console never nudges an irreversible choice with decoration; approve/decline sit visually symmetric; the amber gate + accent focus ring + `A`/`D` binding carry the attention. Accent remains selection/focus (P2). Codified: primary verbs use `--text` fill; the accent never fills a button.
3. **Accent `#c8794f` adjacent to warn `#fbbf24` — WATCH, no change.** Accent stays outline/underline-only (builder already does this). Added as a question in the DG9 protocol: "did any grey outline read as status?"
4. **`--faint` is allowed — with a scope, not a contrast hack.** DG4 amended: ≥4.5:1 applies to INFORMATION-CARRYING text (`--text`, `--muted`). `--faint` is decorative-only (disabled, queued, units); it must never encode state, ids, or values. Floor ≥2.8:1 (current 2.81 on surface-2 clears; keep the token unchanged).
5. **Session titles sans — CONFIRMED, rule made explicit:** the mono test is *who emitted the string*. Device, agent, tool, clock, path, id → mono. Human-typed titles → sans. Codified in DG3.
6. **D4c offline replay — design intent, explicitly unverified against the hub.** Converted into an implementation-phase gate criterion (**DG10**: reconnect replay-order test must pass in the Vue build before the console claims ordered replay). The mockup stays labelled intent.
7. **Builder's additions (§10 of REPORT) — all ADOPTED into v0.1.2:** `G N` jump + `A`/`D` keys, hollow diamond "gate ahead" glyph, dashed stale ring + shared `as of` stamp (P7's shared receipt), D6 rail/drawer pattern, needs-you chip overflow = ellipsis rule.

## Owed (not blocking, but named)

- **DG9 timed glance: ≥3 people, D2a, <1s.** Paul is person 1; needs 2 more (anyone's eyes count). 30-second test: show D2a cold, ask "what needs you?", record answer + elapsed.
- DG6 ledger-view for a plain user/agent turn: accepted-not-exhaustive; do not expand scope now (mock scope per R-B).

— pi (contract author & verifier of this artifact)
