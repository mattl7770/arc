# Home Screen Information Architecture

**Status:** Target design — Foundation phase  
**Principle:** The home screen exists to answer one question extremely well:

> “What should I do right now, and what are the non-negotiables for today?”

Full data and exploration live in other tabs. The home screen must stay directive, calm, and fast.

---

## Layout (Top → Bottom)

### 1. Top Status Bar (persistent)
- Current recovery / readiness signal (color + short label)
- Optional: Biological age or aging velocity (small)
- Optional: Multi-pillar mini status (Sleep • Recovery • Nutrition • Strain)
- Date / day context

### 2. Hero Card — “Do This Next”
- Single highest-priority action right now
- Clear title + estimated time
- One-tap “Done” / “Snooze” / “Skip”
- Very short reason why (“Recovery is low — prioritize this”)

### 3. Today’s Mission
Ordered, dynamic checklist of the day’s non-negotiables.

Grouped sections (collapsible if needed):
- Morning Protocol
- Nutrition (exact meals / templates + logging)
- Training
- Supplements & Medications (timed)
- Therapies
- Evening Wind-down

Each item shows:
- Checkbox / completion state
- Time or window
- Short context or “Why” expander
- Source protocol (if any)

### 4. AI Coach Daily Brief
- 3–6 sentence personalized summary
- Generated from last night’s data + today’s plan + longer trends
- Tone: calm, precise, slightly direct
- Tappable to open full chat

### 5. Minimal Live Metrics Strip
Only the highest-signal current numbers:
- Sleep last night (score + key stages)
- Current recovery / HRV context
- Steps or strain progress
- Next meal / hydration status (optional)

### 6. Quick Actions Dock — ~~cut 2026-07-24~~
Originally: log something, chat with Coach, override modes, jump to Dashboard.

**Removed** (owner call). Three of its four buttons — Log, Coach, Data — were the tab bar sitting two inches above itself, and the fourth (Mode) was inert. The home screen ends at the metrics strip. Mode override needs a real home when the override model exists; it is not a dock button.

---

## Behavioral Rules

- The checklist must be achievable. Ruthlessly prioritize.
- Incomplete items from earlier in the day should surface intelligently.
- Support “imperfect days” gracefully (partial credit, mode switches).
- Everything on this screen should be completable or actionable in ≤ 2 taps when possible.
- Never turn this screen into a dashboard.

---

## States to Design For

- Perfect execution day
- Low recovery day
- Travel day
- Sick / deload day
- Data-gappy day (missing wearables or labs)
- First-time / onboarding day

---

## Implementation Notes (v1)

- Start with static + rule-based generation of the checklist
- Move to AI-generated / AI-adjusted “Today’s Mission” once core data flows exist
- Mock data is fine for the first visual version
- Measure time-to-clarity: user should understand what to do within 3 seconds of opening the app

---

## Implementation Status

**Shipped:** `app/(tabs)/index.tsx` renders five sections on mock data (`src/lib/home/mock-day.ts`). Components live in `src/components/home/`; the mission/hero logic is in `src/hooks/use-mission.ts`.

**Section order revised (2026-07-24, owner decision — supersedes the Layout order above for v1):** only the **date eyebrow** sits above the hero, so the first real element on screen is the action. The readiness block (verdict + pillar **segment bar**, option D from the mock-up round) moved **below** the hero as supporting evidence. Reviewed on a real device via the dev build.

**Shipped order:** date → hero → readiness → mission → Coach brief → metrics. Six sections became five when the quick actions dock was cut.

**No horizontal rules between sections (2026-07-24, owner call, after device review).** The first build separated the date and the metrics strip with hairlines. On a real screen a rule above and below one short block closes a box around it, and the owner read all three as "weird little boxes". Sections are now separated by whitespace only. Hairlines remain correct for **card edges** and **row separators inside a list** (mission rows) — the distinction is that those enclose something that genuinely is one object, whereas a page-slicing rule just adds furniture.

Key design decisions:

- **The hero card is derived, not authored.** "Do this next" is the first unresolved mission item, so completing it advances the screen automatically — the checklist and the hero can never disagree. This is what makes the screen directive rather than a static mockup.
- **The accent colour is reserved for the hero.** Everything else is neutral ink. Restraint is what keeps this from becoming a dashboard.
- **Pillars render as a segment bar** (`readiness-strip.tsx`): four slim signal-coloured segments with labels beneath — more scannable than dots, still not a chart.
- **Grouped but not collapsible.** The IA allows collapsing "if needed"; an achievable list should not need it. If it ever does, the list is too long — the fix is prioritisation, not a disclosure triangle.
- The mock models a **low-recovery day**, the state the design most has to survive.

**Not yet built:** the remaining states (travel, sick/deload, data-gappy, first-run); reading from `daily_logs` / `log_entries`; persistence (mission state is in-memory); the Mode override control (no longer present anywhere — it went out with the dock and needs a real home).
