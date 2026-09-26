import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Divider } from '@/components/ui/block';
import { palette } from '@/constants/theme';
import { combineConsequence, combinedName, type CombinePlan } from '@/lib/nutrition/combine';

/**
 * `Combine` / `Cancel` — the one control on a day's meal list that acts on the
 * list as a whole, on the plate's own label line. The Eat tab's today and a day
 * in History (2026-09-25) draw this same control, so the two lists offer the
 * act in the same words and the same place. Label voice, ink-secondary, no
 * accent: it opens a mode, it is not the day's next action.
 */
export function CombineToggle({ active, onPress }: { active: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={active ? 'Stop combining meals' : 'Combine meals that were one meal'}
      accessibilityState={{ expanded: active }}
      hitSlop={16}
      onPress={onPress}
      className="active:opacity-60">
      <Text className="font-label text-[11px] uppercase tracking-[1.2px] text-ink-secondary">
        {active ? 'Cancel' : 'Combine'}
      </Text>
    </Pressable>
  );
}

/**
 * The square at a meal row's leading edge while meals are being chosen —
 * `square-outline`, then `checkbox`, in ink and never the accent; muted on a
 * meal the combine would refuse (one still waiting on its estimate). Shared by
 * both lists' rows, so a row being chosen reads the same on either.
 */
export function CombineMark({ checked, locked }: { checked: boolean; locked: boolean }) {
  return (
    <View className="pt-0.5">
      <Ionicons
        name={checked ? 'checkbox' : 'square-outline'}
        size={18}
        color={locked ? palette.inkMuted : palette.ink}
      />
    </View>
  );
}

/**
 * The foot of the Eaten-today plate while meals are being chosen to combine
 * (owner, device, 2026-09-23: *"some way to easily combine multiple food logs
 * that are the same meal"*) — and, since 2026-09-25, of a past day's Meals
 * plate in History (*"also allow combine on past days, from History"*), the
 * same foot over the same plan, through `useCombineMeals`
 * (src/hooks/use-combine-meals.ts).
 *
 * ## Where the entry point is, and why there
 *
 * The meals to combine are rows of ONE list, so the act lives on that list: a
 * `Combine` control on the plate's own label line — the label voice, the same
 * anatomy as the Today block's targets corner — turns the rows into checkboxes
 * and this block appears under them. It costs the resting screen one word, and
 * only on a day with two meals that could combine; nothing is added to any row
 * until it is asked for. A swipe or a long-press was the alternative and is
 * refused for the reason the water tile's long-press was deleted
 * (src/components/log/quick-add-grid.tsx): an invisible affordance is one the
 * owner never finds.
 *
 * ## What it draws
 *
 * - **Fewer than two chosen**: one sentence saying what to tap.
 * - **A refusal** (different days, a pending estimate, two recipes): the
 *   planner's own sentence, which names the meal it is about.
 * - **A plan**: the name field — prefilled with the earliest meal's name, which
 *   is what the result is called if nothing is typed, so a quick combine is two
 *   taps and never waits on typing — then the consequence in future tense
 *   (00-design-spec.md §5: a pending write says what it will do before it does
 *   it), then the button.
 * - **A tap the repository refused** (`refused`): the plan was drawn from the
 *   screen's copy of the day, and `combineMeals` re-checks the database — an
 *   estimate queued meanwhile, a meal deleted. Its sentence sits above the
 *   button in ink, so the tap is answered rather than silently undone; it goes
 *   when the choice or the name changes. Not repeated when the re-read plan is
 *   already saying the same thing.
 *
 * ## Conformed Set
 *
 * Ruled rows of the SAME plate (a `Divider`), never a nested device. The field
 * is form (b) of the capture rule — `border-paper-deep bg-paper-dim` on the
 * input itself, serif because a meal's name is speech. **No accent**: Photo and
 * Describe hold this screen's pine in every state (app/nutrition.tsx), so the
 * button is outlined in ink — the confirm of a mode, drawn the way the selected
 * window chip on the history screen is drawn.
 */
export function CombineFooter({
  plan,
  name,
  refused = null,
  onName,
  onCombine,
}: {
  plan: CombinePlan;
  /** The typed name, or null while the field is untouched. */
  name: string | null;
  /** Why the last Combine tap was refused, or null. */
  refused?: string | null;
  onName: (text: string) => void;
  onCombine: () => void;
}) {
  const ok = plan.kind === 'ok';
  const resolved = ok ? combinedName(name, plan.keep) : '';
  const answer = refused !== null && !(plan.kind === 'refused' && plan.reason === refused);
  return (
    <View className="mt-1">
      <Divider />
      <View className="py-3">
        {plan.kind === 'too-few' ? (
          <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
            {plan.count === 0 ? 'Tap the meals that were one meal.' : 'Tap at least one more.'}
          </Text>
        ) : plan.kind === 'refused' ? (
          <Text className="font-serif text-[13px] leading-5 text-ink-secondary">{plan.reason}</Text>
        ) : (
          <>
            <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
              Name
            </Text>
            <TextInput
              value={name ?? plan.keep.name}
              onChangeText={onName}
              placeholder={plan.keep.name}
              placeholderTextColor={palette.inkMuted}
              autoCapitalize="sentences"
              accessibilityLabel="Name of the combined meal"
              returnKeyType="done"
              className="mt-1.5 border border-paper-deep bg-paper-dim px-3 py-2.5 font-serif text-[15px] text-ink"
            />
            <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-secondary">
              {combineConsequence(plan, resolved)}
            </Text>
          </>
        )}

        {answer ? (
          <Text className="mt-3 font-serif text-[13px] leading-5 text-ink">{refused}</Text>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            ok ? `Combine ${plan.count} meals into ${resolved}` : 'Combine the chosen meals'
          }
          accessibilityState={{ disabled: !ok }}
          disabled={!ok}
          onPress={onCombine}
          className={
            ok
              ? 'mt-3 min-h-[46px] items-center justify-center rounded-btn border border-ink active:bg-paper-dim'
              : 'mt-3 min-h-[46px] items-center justify-center rounded-btn border border-paper-deep'
          }>
          <Text
            className={
              ok
                ? 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink'
                : 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
            }>
            {ok ? `Combine ${plan.count} meals` : 'Combine'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
