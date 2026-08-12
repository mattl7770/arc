import { Pressable, Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { humanizeToolName } from '@/lib/ai/coach-service';
import type { PendingWrite } from '@/types/coach';

/**
 * The consequential-write gate, made visible: when the Coach wants to log or
 * change something, the agentic loop suspends and this card asks. Nothing is
 * written until Approve; Decline sends the model a "user declined" result it
 * must respect.
 *
 * ## A pending write is a live decision (00-design-spec.md §5)
 *
 * The rule this card exists to satisfy has four parts, and the card used to meet
 * one of them:
 *
 *   1. **It is the last object.** It sits pinned between the thread and the
 *      composer, so nothing in the conversation can render below it. Pinned
 *      rather than appended into the scroll flow on purpose: this is the one
 *      control in the app that must never be scrolled past, and an appended card
 *      is only visible if the reader happens to be at the bottom.
 *   2. **Its consequence is stated in future tense.** This is what was missing.
 *      The card said "Coach wants to" and showed the summary — a request with no
 *      stated outcome, which is the half of the decision the owner is actually
 *      being asked about. It now draws the outcome as a two-lane revision diff:
 *      what the record says NOW, and what it will say ON APPROVE. The lanes are
 *      set in type alone — no rules, no indent (see {@link ConsequenceLanes}),
 *      and they are drawn for every write but the self-evident ones (below).
 *   3. **The decision and its outcome are never drawn at once.** The ON APPROVE
 *      lane is a future, not a receipt: it is set apart by its label and its
 *      tense, and it disappears the instant the decision is made. The screen also
 *      suppresses the live activity line while this card is open — the loop is
 *      suspended, so "reading your data…" underneath a gate would be a lie.
 *   4. **The composer is disabled.** The screen passes a `blockedReason` to
 *      ChatInput while this is up, which closes the field and says why.
 *
 * **No invented numbers.** The mockup's diff carries "45 → 35 MIN"; the real
 * `PendingWrite` carries only a tool name and one human summary line, so the
 * lanes state the *fact* of the change and nothing more. Fabricating a
 * dimension string here would be exactly the estimate §5 forbids.
 *
 * ## …and the card is only as long as the decision is heavy
 *
 * All of the above shipped on every write, and on a small one it is absurd.
 * Adding milk to the shopping list drew a title, a tool name, "Nothing has been
 * written. The Coach is suspended until you answer." and "This is written to
 * your on-device record, once, and the Coach carries on from there." — five
 * blocks of type to say *milk* (owner, 2026-08-11: "very wordy and long, I think
 * we can do better").
 *
 * The rule the lanes actually encode is narrower than "every write": **state the
 * consequence the summary does not.** For a protocol revision that is most of
 * the decision — "Revise Morning Routine" does not say that a version is
 * superseded, that it happens once, or that nothing has happened yet. For
 * "Add 1 item to the grocery list: Milk" the summary IS the consequence, already
 * in the proposed tense, and the lanes restate it twice at greater length. §5
 * throws out drafting chrome that does not pay rent, and a consequence statement
 * that only paraphrases the line above it is not paying any.
 *
 * So the card has two forms, chosen by {@link isSelfEvidentWrite}, and the
 * DEFAULT IS THE LONG ONE — the short form is an allowlist, so a tool this file
 * has never heard of keeps its consequence statement. That direction is the
 * whole safety argument: a needlessly wordy card on a trivial write is an
 * irritation, a silently terse card on a destructive one is a write the owner
 * approved without being told what it costs.
 */

/**
 * The writes whose summary is already the whole consequence.
 *
 * The test is deliberately strict, and it is not "small": the write's entire
 * effect must be one line item on a **working list** — a list the owner can see
 * and edit by hand elsewhere in the app, and undo with a tap — rather than
 * anything that enters the durable health record. The grocery list and a one-off
 * reminder qualify. Logs, protocol revisions, modes, experiments, memory and
 * recipes do not: they are the record, or they supersede something in it.
 *
 * Two neighbours are deliberately absent to show where the line falls.
 * `set_reminder` also arms an OS notification, which the summary does not say.
 * `dismiss_reminder` ends a recurring reminder **permanently** — its own tool
 * description uses that word — and permanence is exactly the consequence a
 * summary cannot carry on its own.
 *
 * ## This list should not live here, and here is the smallest fix
 *
 * A `PendingWrite` is `{ id, tool, summary }` (src/types/coach.ts), built in
 * use-coach-chat from `WriteConfirmation` `{ tool, summary }`
 * (src/lib/ai/coach-service.ts) — so the card genuinely cannot tell a grocery add
 * from a protocol revision by anything but the tool's NAME, which is why this
 * map exists. The registry is where the answer belongs: `CoachTool` already
 * carries `readOnly` as its safety pivot (src/lib/ai/tools/types.ts), and the
 * smallest honest change is one more optional field beside it —
 * `selfEvident?: boolean`, set on the four tools below — threaded through
 * `WriteConfirmation` and `PendingWrite` as one boolean. Each tool would then
 * declare its own weight next to its `confirmSummary`, which is the only place
 * that knows what that summary says. Until then the map is here, and it fails
 * closed.
 */
const SELF_EVIDENT_WRITES = new Set([
  'add_grocery_items',
  'add_recipe_to_grocery_list',
  'complete_grocery_items',
  'complete_reminder',
]);

/** Is this write's summary the whole story? Unknown tools are never assumed to be. */
function isSelfEvidentWrite(tool: string): boolean {
  return SELF_EVIDENT_WRITES.has(tool);
}

/**
 * The before/after lanes: what the record says NOW, and what it will say ON
 * APPROVE. Drawn for every write except the self-evident ones — see
 * {@link SELF_EVIDENT_WRITES}.
 *
 * **No lane rules.** Each lane used to carry a 2px left rule (neutral for Now,
 * pine for On approve) with a 10px indent. That is the exact mark the `margin`
 * device lost on 2026-08-09 for the exact reason: beside a paragraph it is not
 * annotating, a lone vertical stroke reads as a rendering artefact rather than
 * as structure, and the owner has now raised stray rules twice (2026-08-10).
 * The tense and the two labels were always what told the lanes apart — "Now" in
 * muted ink, "On approve" in pine — and they still do, inside a stamp that is
 * already drawn. Nothing here needed a second enclosure.
 */
function ConsequenceLanes() {
  return (
    <View className="mt-3">
      <View>
        <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
          Now
        </Text>
        <Text className="mt-0.5 font-serif text-[13px] leading-5 text-ink-secondary">
          Nothing has been written. The Coach is suspended until you answer.
        </Text>
      </View>

      <View className="mt-2.5">
        <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-pine-deep">
          On approve
        </Text>
        <Text className="mt-0.5 font-serif text-[13px] leading-5 text-ink">
          This is written to your on-device record, once, and the Coach carries on from there.
        </Text>
      </View>
    </View>
  );
}

/**
 * The gate itself — the card the owner answers. See the notes at the head of
 * this file for why it has two lengths.
 *
 * ## Conformed Set treatment
 *
 * The **stamped plate** device: `paper-hi` inside a 1.5px accent border. It is
 * the one next action on the screen, which is precisely what the stamp is for —
 * and while it is open the composer's send button is disabled and drops out of
 * the accent, so the screen never shows two accent actions at once.
 *
 * **It takes the hatched cap**, and the sheet is specific about which cards do.
 * `.cf-rev` — this card — carries the same `::before` barber hatch as
 * `.cf-card--accent`, a 3pt accent/ink band laid across the top edge; `.cf-hero`
 * has the identical 1.5px accent border and no cap at all. The distinction being
 * drawn is between a card that is merely the most important thing on its screen
 * and one that is *asking for a decision*, and that band is most of what makes
 * this read as **stamped** rather than as bordered — it was the loudest mark in
 * the whole set and the app had no equivalent until `Block` grew `cap`. Home's
 * hero is the former and stays uncapped; a gate is the latter. The mark itself
 * is drawn by `HatchCap` (ui/block.tsx) as filled bars inside a clipped band —
 * no gradient library, and no one-sided border anywhere near it.
 */
export function PendingWriteCard({
  pending,
  onResolve,
}: {
  pending: PendingWrite;
  /** Carries the request's nonce so a tap can only answer what it was shown. */
  onResolve: (id: number, approved: boolean) => void;
}) {
  const brief = isSelfEvidentWrite(pending.tool);

  return (
    <View accessibilityLiveRegion="polite" className="bg-paper">
      {/* The pinned card's top edge — a drawn rule, not a `border-t`, which
          would box the whole docked band (see Divider). Outside the padding so
          it spans the full width. */}
      <Divider />
      <View className="px-5 py-3">
        <Block device="stamp" cap>
          <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-pine-deep">
            Proposed change · needs your OK
          </Text>

          <Text className="mt-2 font-serif text-[17px] font-semibold leading-6 text-ink">
            {pending.summary}
          </Text>

          {/* The tool name is transparency, and on a self-evident write it is
            transparency about a fact the line above already states: "ADD GROCERY
            ITEMS" under "Add 1 item to the grocery list: Milk" is the same
            sentence twice, once in a voice that reads as machinery. It stays on
            every other write, where the summary is prose and the tool is the
            audit detail — and it is never actually lost, because the turn's tool
            chips carry it in the thread once the write lands
            (coach/message-bubble.tsx). */}
          {brief ? null : (
            <Text className="mt-1 font-mono text-[10px] uppercase tracking-[1px] text-ink-muted">
              {humanizeToolName(pending.tool)}
            </Text>
          )}

          {brief ? null : <ConsequenceLanes />}

          {/* The sheet draws `.cf-btnrow--3`: Approve / Edit / Reject in
            `grid-template-columns: 1fr 1fr 1fr`. **Two of those three can ship
            honestly, and the third cannot.** A `PendingWrite` is
            `{ id, tool, summary }` (src/types/coach.ts) and the gate it answers
            is `confirmWrite: (request) => Promise<boolean>`
            (src/lib/ai/coach-service.ts) — this card is never handed the tool's
            ARGUMENTS, and the resolver has no third outcome to return. So there
            is nothing here to edit and nowhere to send an edit to: an "Edit"
            button would key no user action, which is precisely the drafting
            chrome §5 throws out ("must pay rent or go"), and dressing a Decline
            up as an Edit would be worse than omitting it. Making it real is a
            change to the service seam and the pending-write payload, not to this
            file; until then two buttons is the true count.

            What the row DOES take from the sheet is the equal columns. Approve
            was `flex-1` beside an intrinsically-sized Decline, so the decision
            was sized by the length of its own labels and the affirmative answer
            got four times the target. Both are `flex-1` now: declining is a real
            answer to a gate — the model is told and must respect it — and a row
            that makes it the small option argues for approval by geometry. */}
          <View className="mt-3.5 flex-row gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Approve: ${pending.summary}`}
              onPress={() => onResolve(pending.id, true)}
              className="min-h-[44px] flex-1 items-center justify-center bg-pine px-4 active:opacity-70">
              <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-pine-on">
                Approve
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Decline: ${pending.summary}`}
              onPress={() => onResolve(pending.id, false)}
              className="min-h-[44px] flex-1 items-center justify-center border border-hairline px-4 active:opacity-60">
              <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-secondary">
                Decline
              </Text>
            </Pressable>
          </View>
        </Block>
      </View>
    </View>
  );
}
