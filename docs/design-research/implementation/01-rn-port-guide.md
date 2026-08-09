# React Native port guide

How the browser mockup becomes ARC (Expo SDK 57 · RN 0.86 · NativeWind 4 · Tailwind v3 · iOS-only · light-only).

Read `00-design-spec.md` first for *what* the design is. This file is *how it ships*.

---

## 1. The three things the mockup uses that React Native does not have

The mockup's surface system leans on three CSS features with **no RN equivalent**. Each has a clean native answer — none requires a new dependency.

### 1.1 `:has()` → explicit component variants

The mockup picks a device by inspecting a block's content:

```css
/* mockup only — impossible in RN */
#c-conformed .cf-block:has(> .cf-verdict) { /* corner ticks */ }
#c-conformed .cf-block:has(> .cf-note)    { /* margin rule */ }
```

RN has no parent/content selectors. **Ship the device as a prop**, which is better practice anyway — it makes the choice explicit at the call site instead of implicit in a selector:

```tsx
// src/components/ui/block.tsx
type Device = 'plate' | 'field' | 'margin' | 'grid' | 'well';

const DEVICE: Record<Device, string> = {
  plate:  'border border-paper-line bg-paper-hi p-3',
  field:  'relative px-3 py-3',              // ticks drawn as children, see 1.2
  margin: 'border-l-2 border-paper-line py-px pl-3',
  grid:   '',                                 // rules live on the cells, see 1.3
  well:   'border border-paper-deep bg-paper-dim p-3',
};

export function Block({ device = 'plate', children }: { device?: Device; children: ReactNode }) {
  return (
    <View className={DEVICE[device]}>
      {device === 'field' ? <CornerTicks /> : null}
      {children}
    </View>
  );
}
```

> Use **whole-string class maps**, never `` `border-${x}` `` — Tailwind's scanner only sees literal class names. This is the documented ARC pattern already used in `src/components/home/signal.tsx`.

### 1.2 `::before` / `::after` (the corner ticks) → two absolutely-positioned Views

RN has no pseudo-elements, but it *does* support absolute positioning and per-side borders, so the measured-field ticks are trivial — **no SVG needed**:

```tsx
function CornerTicks() {
  return (
    <>
      <View pointerEvents="none" className="absolute left-0 top-0 h-3 w-3 border-l border-t border-ink-faint" />
      <View pointerEvents="none" className="absolute bottom-0 right-0 h-3 w-3 border-b border-r border-ink-faint" />
    </>
  );
}
```

### 1.3 CSS grid (the metrics ruled grid) → flex-wrap with per-cell borders

`display: grid` and `nth-child(odd)` don't exist. Compute the modulo in JS and put the rules on the cells:

```tsx
{metrics.map((m, i) => (
  <View
    key={m.label}
    className={`w-1/2 px-2.5 py-2.5 border-t border-paper-line ${i % 2 === 0 ? 'border-r border-paper-line' : ''}`}>
    …
  </View>
))}
```

Wrap them in a `flex-row flex-wrap` parent. `w-1/2` gives the two columns.

### 1.4 Bonus: the redline hatch

The mockup's diagonal hatch on `bio-poor` fills is a `repeating-linear-gradient` — **not available in RN** without adding `expo-linear-gradient` (a native module → EAS rebuild). It existed only as the redline-mode firewall aid. **Petrol was chosen (ADR, 2026-08-08), so the hatch was dropped entirely** and the problem disappeared — no `expo-linear-gradient`, and therefore no EAS rebuild forced by the restyle.

---

## 2. Token swap — the two files that must move together

`docs/project-status.md` §3: *"Any palette change must touch both files."*

**`tailwind.config.js`** — replace `theme.extend`. A drop-in block is provided at `tailwind.tokens.js` in this folder. Notes:
- Keep `fontFamily` as a **plain array of family names**. Do *not* use `nativewind/theme`'s `platformSelect` — it cannot carry family names containing spaces and silently compiles to an empty declaration. This cost an hour once already; the gotcha is recorded in both the config and `project-status.md` §3.
- `theme.extend` currently holds only `colors`, `fontFamily`, `borderRadius`. This design also wants a **type scale** — see §4.

**`src/constants/theme.ts`** — mirror the palette for imperative APIs. A drop-in is provided at `theme.ts` in this folder.
- ⚠️ **Keep the exported key names identical** (`paper`, `paperDeep`, `porcelain`, `hairline`, `ink`, `pine`, `signal.*`). `palette` is imported by **51 files** (44 when this guide was drafted; the restyle added importers — recounted 2026-08-09), almost all for `<Ionicons color={...}>`. Preserving key names meant every one of them needed **zero edits** — only their values changed. Renaming `pine` → `accent` is cosmetically tempting and costs a 51-file sweep; the drop-in kept the old names and documents the mapping instead.

**Third and fourth copies of the page colour — easy to miss:**
- `app.json` → splash `backgroundColor: "#F6F3EC"` must become the new `paper`.
- `app/_layout.tsx` (`porcelainTheme` from `navColors`) and `app/(tabs)/_layout.tsx` (tab bar styled imperatively) **do not respond to a Tailwind change** — they read `theme.ts`. Verify both after the swap.

---

## 3. Component inventory — mockup class → RN component

| Mockup class | Ships as | Notes |
| --- | --- | --- |
| `.cf-block` (+ device) | `ui/block.tsx` **(new)** | the surface system; see §1.1 |
| `.cf-hero` | `home/hero-card.tsx` *(exists — restyle)* | plate + 1.5px accent border, square corners |
| `.cf-sec` / `.cf-sec-t` | `ui/section-label.tsx` **(new)** | uppercase label voice + optional right-aligned mono note |
| `.cf-mission` / `.cf-mrow` | `home/mission.tsx`, `mission-item.tsx` *(exist — restyle)* | keep explicit hairlines, not `divide-y` (no RN sibling selector) |
| `.cf-fold` | inside `mission.tsx` *(exists)* | tally row must reconcile: folded + visible = total |
| `.cf-verdict` / `.cf-pillars` | `home/readiness-strip.tsx` *(exists — restyle)* | wrap in `<Block device="field">` |
| `.cf-note` | `home/coach-brief.tsx` *(exists — restyle)* | `<Block device="margin">` |
| `.cf-dims` / `.cf-dim` | `home/metrics-strip.tsx` *(exists — restyle)* | `<Block device="grid">`; see §1.3 |
| `.cf-rev` (REV bar-diff) | `coach/pending-write-card.tsx` *(exists — restyle)* | the dimensioned old→new diff; keep future-tense consequence |
| `.cf-command` | `log/command-field.tsx` *(exists — restyle)* | `<Block device="well">` |
| `.cf-thread` / bubbles | `coach/*` *(exist — restyle)* | user bubble = solid accent, one squared corner |
| `.cf-axis` (Screenings horizon) | **new** | a flex row of positioned Views — no SVG (see §5) |
| `.cf-vhist` (version timeline) | **new** | Protocols; v2 dashed "proposed", v1 solid "current" |
| `.cf-spark` | `ui/sparkline.tsx` *(exists)* | already dependency-free Views — keep as-is |
| Icons | `@expo/vector-icons/Ionicons` | `color` from `palette` — the reason `theme.ts` exists |

## 4. Type scale — the largest hidden cost

The codebase styles type with **arbitrary values everywhere** (`text-[11px]`, `tracking-[2px]`, `h-[6px]`, `border-[1.5px]`, `rounded-[1px]`). A colours-only swap leaves all of that untouched — so the new typography would *not* actually apply.

Two options:

1. **Add `fontSize` + `letterSpacing` tokens** to `theme.extend` and sweep the arbitrary values out of components. Correct, and makes the system enforceable — but it is a real sweep across ~63 files.
2. **Ship colours + surfaces first, keep the existing type scale**, and do the type pass as a second change. Lower risk, and the surface system is what carries most of the visual change.

Recommended: **option 2**, then option 1 as a follow-up. The migration plan sequences it that way.

## 5. Things that would need a new native dependency (avoid for v1)

The current app has **no `react-native-svg`**, no `expo-linear-gradient`, and no shadows — deliberately (`ui/sparkline.tsx`: *"react-native-svg is not installed, and this intentionally stays that way"*). Adding one means an **EAS rebuild**.

Everything in this design can ship without one:
- corner ticks → bordered Views (§1.2)
- ruled grids → per-cell borders (§1.3)
- dimension strings → a thin View + two 1px end-cap Views
- the Screenings horizon axis → a positioned row of Views (diamond = a rotated square View)
- sparklines → the existing View-based `Sparkline`
- the hatch → **drop it** (§1.4)

## 6. Verification checklist (before calling a screen done)

Ported from the standard that caught 89 findings across the exploration:

- [ ] Accent count per screen within budget; **Settings has none**
- [ ] No signal colour on chrome; no accent on biology
- [ ] Every tappable row/button ≥ 44pt (measure, don't eyeball)
- [ ] Faintest text ≥ 4.5:1 **on the surface it actually sits on** (plate vs sheet vs recessed differ)
- [ ] No text under 9px rendered
- [ ] Ledgers sum; tallies reconcile; empty states authored; no invented codes
- [ ] Pending write reads as a live decision with nothing after it
- [ ] Checked on a **real iPhone**, not the web preview — per `docs/decisions.md`, web is a logic-check surface only and never a look/feel judgement
