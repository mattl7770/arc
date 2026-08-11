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
 *      set in type alone — no rules, no indent (see the note at the call site).
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
 * ## Conformed Set treatment
 *
 * The **stamped plate** device: `paper-hi` inside a 1.5px accent border. It is
 * the one next action on the screen, which is precisely what the stamp is for —
 * and while it is open the composer's send button is disabled and drops out of
 * the accent, so the screen never shows two accent actions at once.
 */
export function PendingWriteCard({
  pending,
  onResolve,
}: {
  pending: PendingWrite;
  /** Carries the request's nonce so a tap can only answer what it was shown. */
  onResolve: (id: number, approved: boolean) => void;
}) {
  return (
    <View accessibilityLiveRegion="polite" className="bg-paper">
      {/* The pinned card's top edge — a drawn rule, not a `border-t`, which
          would box the whole docked band (see Divider). Outside the padding so
          it spans the full width. */}
      <Divider />
      <View className="px-5 py-3">
        <Block device="stamp">
          <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-pine-deep">
            Proposed change · needs your OK
          </Text>

          <Text className="mt-2 font-serif text-[17px] font-semibold leading-6 text-ink">
            {pending.summary}
          </Text>

          <Text className="mt-1 font-mono text-[10px] uppercase tracking-[1px] text-ink-muted">
            {humanizeToolName(pending.tool)}
          </Text>

          {/* The revision diff — current state above, proposed state below.
            **No lane rules.** Each lane used to carry a 2px left rule (neutral
            for Now, pine for On approve) with a 10px indent. That is the exact
            mark the `margin` device lost on 2026-08-09 for the exact reason:
            beside a paragraph it is not annotating, a lone vertical stroke
            reads as a rendering artefact rather than as structure, and the
            owner has now raised stray rules twice (2026-08-10). The tense and
            the two labels were always what told the lanes apart — "Now" in
            muted ink, "On approve" in pine — and they still do, inside a stamp
            that is already drawn. Nothing here needed a second enclosure. */}
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
              className="min-h-[44px] items-center justify-center border border-hairline px-6 active:opacity-60">
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
