import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Block, Divider } from '@/components/ui/block';
import { PaperGrid } from '@/components/ui/screen';
import { palette } from '@/constants/theme';
import {
  MODE_KEYS,
  accountForDay,
  getModeDefinition,
  modeDirective,
  type ModeKey,
} from '@/lib/modes/registry';

/**
 * The Home mode control (docs/information-architecture.md §Modes): "a quiet
 * control near the date/status, because a mode is a fact about *today* set in
 * the moment... A small persistent indicator shows the active mode so it's
 * never silently on."
 *
 * Deliberately NEUTRAL, never pine: Home's one sanctioned accent is already
 * spent on the hero card, and a mode is a state, not an action. So the
 * indicator is the app's standard status chip (paper-deep + tracked caps) and
 * Normal reads as a bare muted "Set mode" — quiet when nothing is on,
 * unmistakable when something is.
 *
 * Both faces of the control are the **label voice** (00-design-spec.md §3:
 * "uppercase section labels, eyebrows, buttons, chips"). The chip used to be
 * `font-mono`, which was a voice error rather than a style choice — mono is for
 * measured values, and "Travel" measures nothing. Sizing it at 10px also lifts
 * it off the 9px render floor, which §4 says should never be load-bearing.
 *
 * The chip's ink is `ink-secondary`, not `ink-muted`: muted ink is documented
 * against `paper` (5.97:1) and `paper-dim` (5.17:1), but on the `paper-deep`
 * fill it lands at 4.21:1 and misses AA. Darkening the text to `ink-secondary`
 * puts it at **5.83:1** and keeps the fill — moving the fill to `paper-dim`
 * instead would have passed too, but `paper-dim` sits 1.15:1 off the sheet, so
 * the chip would stop reading as a chip and the active mode would stop being
 * "unmistakable when something is on".
 *
 * The picker rows inside the modal go the other way: **serif, not label.** They
 * were flagged as ambiguous — a full-width `Pressable` could be read as a
 * button — but they are a list of named options each carrying a prose tagline,
 * structurally the same object as `FoodListRow` in app/food-search.tsx, and a
 * sentence like "lighter, portable version of today" cannot sit in the label
 * face without becoming a shout. The control voice for a mode is already spoken
 * by the trigger chip above in tracked caps; the modal is the *record* of what
 * the modes are, and the checkmark — not the face — is what marks the choice.
 * Splitting the row (label face on the name, serif on the tagline) would have
 * fractured one object across two voices, which is worse than either call.
 *
 * The modal's own prose (the explainer under the title and the footnote) is
 * serif for the same reason: prose is prose wherever it lands.
 *
 * Whole class strings only (no `bg-${x}` templating) — Tailwind's scanner sees
 * literals, per src/components/home/signal.tsx.
 */

/** The picker rows, Normal first so "back to normal" is always the top choice. */
const PICKER_ORDER: readonly ModeKey[] = MODE_KEYS;

/**
 * The mode banner — what makes a mode VISIBLE rather than merely set.
 *
 * Owner feedback, first hardware look: "the modes switcher right now doesn't do
 * much", and they had to be told the control existed at all. Both are the same
 * defect. The chip beside the date is a *control*; nothing on the page ever
 * said what the mode had DONE. `heroFocus` — the day's directive, and the one
 * thing a mode could most usefully change — was read by `get_today_snapshot`
 * and by nothing else, so it only ever reached the user inside a Coach chat
 * they might never open.
 *
 * This renders directly above the hero, so switching to Sick puts "Recover:
 * sleep, fluids, rest. No training today." at the top of Home. Together with
 * the mode taking the hero slot on the clock (registry `addItems`), the screen
 * now reads as a sick day rather than as the normal day minus a workout.
 *
 * ## Why it draws nothing
 *
 * No box, no rule, no fill — type and air only. That is not timidity, it is the
 * standing call from the same feedback session: three of the six devices
 * stopped drawing marks on 2026-08-09 because "there are some weird boxes and
 * lines in some places" (src/components/ui/block.tsx). Adding a fresh enclosure
 * one section above the two boxes that survived — the hero stamp and the
 * mission plate — would spend exactly the attention those two are left drawn to
 * claim. `device="field"` is still declared because this IS a verdict about
 * today; the device currently renders no marks, and the call site is the
 * documentation.
 *
 * ## Why it spends no accent
 *
 * Home's accent budget is the hero, completion stamps and the active tab
 * (00-design-spec.md §2). A mode is a state, not an action, and it sits
 * immediately above the one block on the sheet drawn in pine — colouring it
 * would put two accent claims in adjacent blocks and demote the hero. It also
 * must not take a signal colour: `signal-*` marks biology, and "today is a
 * travel day" is a fact about the calendar, not about the body. The FIREWALL
 * holds even for Sick, which is the tempting case and the wrong one — Sick is a
 * mode the user declared, not a measured biological state.
 *
 * Legibility comes from position and size instead: it is the first thing under
 * the folio line, and the directive is set two steps above the eyebrow.
 */
export function ModeBanner({ mode, skipped }: { mode: ModeKey; skipped: number }) {
  const def = getModeDefinition(mode);
  const directive = modeDirective(mode);
  // Normal has no opinion and renders nothing — the quiet default stays quiet.
  if (!directive) return null;

  const accounting = accountForDay(mode, { skipped });

  return (
    <Block device="field">
      <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.4px] text-ink-secondary">
        {def.label} mode · Today
      </Text>
      <Text className="mt-1.5 font-serif text-[16px] leading-6 text-ink">{directive}</Text>
      {/*
        The concrete face of `excusesSkips`. Mono because it leads with a count,
        and a count is a measured value. Absent — not zeroed — when the mode
        does not excuse or nothing was skipped: a mode that judges the day
        normally should say nothing about judgement.
      */}
      {accounting.note ? (
        <Text className="mt-2 font-mono text-[11px] text-ink-muted">{accounting.note}</Text>
      ) : null}
    </Block>
  );
}

export function ModeControl({
  mode,
  onSelect,
}: {
  mode: ModeKey;
  onSelect: (mode: ModeKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = mode !== 'normal';
  const def = getModeDefinition(mode);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={active ? `Mode: ${def.label}. Change` : 'Set mode'}
        onPress={() => setOpen(true)}
        // min-h-[44px] is the tap-target floor, stated here rather than inferred
        // from padding: the chip's own text is 10px, so py-2.5 alone only reached
        // ~36pt. The negative right margin keeps the optical edge flush with the
        // gutter.
        className="-mr-2 min-h-[44px] flex-row items-center gap-1.5 rounded-btn px-2 py-2.5 active:bg-paper-deep">
        {/*
          Both faces are now DRAWN chips. The resting face used to be bare
          `ink-muted` text, and the owner's first hardware session ended with
          them having to be told the control was there — unsurprising, since
          nothing distinguished it from the date eyebrow opposite it except the
          chevron. A hairline outline is the smallest mark that says "this is
          pressable" without spending accent (a mode is a state, not an action)
          and without a fill, which would make the resting state as loud as the
          active one. Filled = on, outlined = off, and the two are now
          distinguishable at a glance from across the row.
        */}
        {active ? (
          <View className="rounded-btn bg-paper-deep px-2 py-0.5">
            <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-secondary">
              {def.label}
            </Text>
          </View>
        ) : (
          <View className="rounded-btn border border-hairline px-2 py-0.5">
            <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-secondary">
              Set mode
            </Text>
          </View>
        )}
        <Ionicons name="chevron-down" size={12} color={palette.inkMuted} />
      </Pressable>

      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setOpen(false)}>
        {/* A native Modal builds its own root, so it never passes through
            `<Screen>` and has to print the sheet itself — otherwise the picker
            arrives on bare stock over a textured Home. Outside the SafeAreaView
            and outside the ScrollView: the paper is fixed, the content moves. */}
        <View className="flex-1 bg-paper">
          <PaperGrid />
          <SafeAreaView edges={['top', 'bottom']} className="flex-1">
            <View className="flex-row items-center justify-between px-5 pt-2">
              <Text className="font-serif text-lg font-semibold text-ink">Today&rsquo;s mode</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                onPress={() => setOpen(false)}
                // A 20px glyph in p-2 measures 36pt square; the floor is 44 on both axes.
                className="min-h-[44px] min-w-[44px] items-center justify-center rounded-btn active:bg-paper-deep">
                <Ionicons name="close" size={20} color={palette.inkSecondary} />
              </Pressable>
            </View>
            {/* One operative sentence. The line that opened this — "A mode
                reshapes today's plan, changes what Home leads with, and changes
                how the Coach talks" — described the feature back at the owner
                before they had picked anything, which is the kind of line they
                asked to be swept out (2026-08-10). What is left is the one rule
                that changes what picking a mode means for the day. */}
            <Text className="px-5 pt-1 font-serif text-[13px] leading-5 text-ink-secondary">
              A skipped item under Travel, Sick, or Social is excused, not a miss.
            </Text>

            <ScrollView contentContainerClassName="px-5 pb-10 pt-5">
              <View className="border border-hairline bg-paper-hi">
                {PICKER_ORDER.map((key, index) => {
                  const option = getModeDefinition(key);
                  const selected = key === mode;
                  return (
                    <View key={key}>
                      <Divider first={index === 0} />
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        accessibilityLabel={`${option.label}. ${option.tagline}`}
                        onPress={() => {
                          setOpen(false);
                          onSelect(key);
                        }}
                        className="min-h-[44px] flex-row items-center gap-3 px-4 py-3 active:bg-paper-deep">
                        <View className="flex-1">
                          {/* List ROW, not a control label — see the voice note above. */}
                          <Text className="font-serif text-[15px] text-ink">{option.label}</Text>
                          <Text className="mt-0.5 font-serif text-[12px] text-ink-muted">
                            {option.tagline}
                          </Text>
                        </View>
                        {selected ? (
                          <Ionicons name="checkmark" size={18} color={palette.inkSecondary} />
                        ) : null}
                      </Pressable>
                    </View>
                  );
                })}
              </View>
              <Text className="mt-3 font-serif text-[11px] leading-4 text-ink-muted">
                Stays on until you set it back to Normal. Work you&rsquo;ve already logged is kept —
                only untouched items change.
              </Text>
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>
    </>
  );
}
