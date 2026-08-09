# Implementation kit — the Conformed Set

Everything needed to build the adopted mockup into ARC. **This kit was applied on 2026-08-08** — the Conformed Set is now the shipped visual system across the whole app, superseding Porcelain Ledger. What actually shipped, and what was deliberately left out, is recorded in `02-migration-plan.md`; the adoption ADR is in `docs/decisions.md`. This folder is now the reference, not a pending handoff.

**The design:** `../arc-conformed-set.html` — 14 sheets (10 screens + 4 alternate states), devices surface system, petrol/redline accent toggle.

## Files

| File | What it is |
| --- | --- |
| `00-design-spec.md` | The visual system: surface devices, colour, type, geometry, and the honesty rules the hostile reviews produced. Read first. |
| `01-rn-port-guide.md` | How it becomes React Native — including the three CSS features RN lacks and their native equivalents. The engineering risk lives here. |
| `02-migration-plan.md` | Phased, shippable-at-every-step plan, plus the decisions that block implementation. |
| `tailwind.tokens.js` | Drop-in replacement for `theme.extend` in `tailwind.config.js`. |
| `theme.ts` | Drop-in replacement for `src/constants/theme.ts`. |

## Start here

1. Read `00-design-spec.md`.
2. Make the three Phase 0 decisions in `02-migration-plan.md` — **adopt or not**, **petrol or redline**, **which typefaces**.
3. If adopting, do Phase 1 + Phase 2 on Home only, look at it on a real iPhone, then decide whether to continue.

## The three things worth knowing up front

**React Native can't do what the mockup does.** The surface system uses `:has()`, `::before/::after`, and CSS grid — none exist in RN. All three have clean native equivalents (component variants, absolutely-positioned bordered Views, per-cell borders), and **none needs a new dependency**, so no EAS rebuild. `01-rn-port-guide.md` §1 has the code.

**The token swap is small; the type swap is not.** Colours and surfaces are a two-file change that the whole app follows automatically. But type is styled with arbitrary values (`text-[11px]`, `tracking-[2px]`) in ~63 files, so a new type scale is a real sweep — sequenced last, and optional.

**Nobody has seen this on an iPhone.** The typefaces were chosen in a browser (the mockup's Bahnschrift/Constantia don't exist on iOS — the drop-in already substitutes iOS-native families), and the corner-tick motif has no precedent inside the app's own screens. Per `docs/decisions.md`, the web preview is a logic-check surface only and never a look/feel judgement. Phase 1+2 on Home is the cheap way to find out.
