import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import {
  applyRecipeRevision,
  getRecipe,
  listIngredients,
  parseSteps,
} from '@/lib/db/repositories/recipes';
import { fmtQty } from '@/lib/nutrition/format';
import {
  catalogResolveRecipe,
  diffRecipeLines,
  droppedRecipeLines,
  isRecipeRevisionAvailable,
  type RecipeRevision,
  RecipeRevisionUnavailableError,
  reviseRecipe,
  type RevisionDiffRow,
} from '@/lib/recipes/estimate';
import type { RecipeIngredientRow } from '@/lib/recipes/types';

/**
 * Editing a recipe in plain English (owner, 2026-08-12): *"Add a button to edit
 * a recipe with plain-text input to the coach. (i.e. 'change the milk for
 * almond milk and add something to keep the sweetness the same' or 'make it
 * higher protein and lower calorie')"*
 *
 * ## The two examples are two different jobs, and both are the model's
 *
 * The first is a substitution that needs a compensating change nobody named.
 * The second is a goal, not an edit — it says nothing about which line to
 * touch, and deciding that IS the request. Neither is expressible as a rule,
 * which is exactly why this is a model turn and not a form (the
 * coach-judgment-not-rules memory).
 *
 * ## A proposal, never a silent overwrite
 *
 * A recipe is a document the owner keeps for years, and by the time this screen
 * opens it may hold lines he priced by hand. So this is a pending write in the
 * strict sense of 00-design-spec.md §5: the model's answer lands as a DIFF
 * against what the recipe says now — every line marked kept, new or dropped —
 * and nothing is written until Save. Going back writes nothing.
 *
 * It is a pushed screen and not an inline panel for the same reason
 * app/meal-revise.tsx is: inline, it would have had to draw the recipe and its
 * replacement at once, which is the one thing §5 forbids.
 *
 * ## Provenance survives the edit, and the screen says how
 *
 * `applyRecipeRevision` keeps any line whose wording is unchanged — the row
 * itself, with its food link, its per-batch snapshots and its `resolved_by`.
 * A line whose wording changed is a different line and lands unresolved, which
 * is right: "whole milk" becoming "almond milk" must not inherit the milk's
 * numbers. Then the DETERMINISTIC catalog pass runs before anything reaches a
 * model (`catalogResolveRecipe`, the same pass `save_recipe` runs), and only
 * what it cannot reach falls through to the model pass on the recipe screen,
 * stamped `estimated`.
 *
 * The review states both halves before the user commits — including, by name,
 * when a line HE priced is about to be reworded, because that is the strongest
 * provenance in the book and losing it silently would be the worst outcome
 * here.
 *
 * ## Cost
 *
 * One no-tools turn (src/lib/recipes/estimate.ts): the Coach's tool catalog is
 * never uploaded, the system prompt is a constant so it rides the cached
 * prefix, and the reply is raw lines rather than a per-line object. The owner
 * flagged a ~10¢ Coach turn; this is the cheap shape of the same capability.
 *
 * ## Conformed Set surface system
 *
 *   Instruction  → **recessed well**: a capture surface is stock you write on,
 *                  so the well IS the field and the `TextInput` inside it is
 *                  bare (form (a), src/components/ui/block.tsx).
 *   Current/diff → **ruled plate**: both are records, and a record is a table.
 *   Prose        → **margin annotation** (the model's note, the error reason).
 *
 * **Accent budget: one per phase.** Apply (input), Save changes (review). The
 * phases are exclusive.
 */

type Phase =
  | { kind: 'input' }
  | { kind: 'working' }
  | { kind: 'review'; revision: RecipeRevision }
  | { kind: 'error'; message: string };

/** How a diff row is drawn. Whole class literals in a lookup — Tailwind's
 *  scanner never sees a built fragment (the house rule). */
const DIFF_TEXT: Record<RevisionDiffRow['state'], string> = {
  same: 'flex-1 font-serif text-[15px] leading-5 text-ink-secondary',
  added: 'flex-1 font-serif text-[15px] leading-5 text-ink',
  removed: 'flex-1 font-serif text-[15px] leading-5 text-ink-muted line-through',
};

/** The word beside each row. Every state says what it is: a blank mark on a
 *  kept line would read as agreement with the changed ones. */
const DIFF_MARK: Record<RevisionDiffRow['state'], string> = {
  same: 'kept',
  added: 'new',
  removed: 'dropped',
};

const DIFF_MARK_CLASS: Record<RevisionDiffRow['state'], string> = {
  same: 'font-label text-[10px] uppercase tracking-[1px] text-ink-muted',
  added: 'font-label text-[10px] font-semibold uppercase tracking-[1px] text-ink',
  removed: 'font-label text-[10px] uppercase tracking-[1px] text-ink-muted',
};

/** One plate of diff rows. Rows are ruled by `Divider`, never `border-t`. */
function DiffPlate({ rows }: { rows: RevisionDiffRow[] }) {
  return (
    <Block device="plate">
      {rows.map((row, index) => (
        <View key={`${index}-${row.text}`}>
          <Divider first={index === 0} />
          <View className="min-h-[44px] flex-row items-center gap-3 py-2.5">
            <Text className={DIFF_TEXT[row.state]}>{row.text}</Text>
            <Text className={DIFF_MARK_CLASS[row.state]}>{DIFF_MARK[row.state]}</Text>
          </View>
        </View>
      ))}
    </Block>
  );
}

export default function RecipeReviseScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const recipeId = typeof id === 'string' ? id : '';

  // Read once in the initializer (op-sqlite is synchronous). Re-reading on
  // focus would swap the "before" out from under an open proposal, and the
  // proposal is a statement about the recipe as it was when it was made.
  const [recipe] = useState(() => getRecipe(getDb(), recipeId));
  const [before] = useState<RecipeIngredientRow[]>(() => listIngredients(getDb(), recipeId));

  const available = isRecipeRevisionAvailable();
  const [phase, setPhase] = useState<Phase>({ kind: 'input' });
  const [instruction, setInstruction] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const beforeLines = before.map((line) => line.raw_text);
  const beforeSteps = recipe ? parseSteps(recipe.steps) : [];

  const run = async () => {
    if (!recipe) return;
    const text = instruction.trim();
    if (text === '') return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: 'working' });
    try {
      const revision = await reviseRecipe(
        {
          title: recipe.title,
          servings: recipe.servings,
          ingredients: beforeLines,
          steps: beforeSteps,
        },
        text,
        controller.signal
      );
      setPhase({ kind: 'review', revision });
    } catch (error) {
      // A cancel is not a failure and gets no message — the screen is gone.
      if (controller.signal.aborted) return;
      setPhase({
        kind: 'error',
        message:
          error instanceof RecipeRevisionUnavailableError
            ? error.message
            : 'Couldn’t work that change out. Check your connection and try again, or edit the recipe by hand.',
      });
    }
  };

  const save = (revision: RecipeRevision) => {
    if (!recipe) return;
    // THE WRITE, alone in its own try. What follows it is pricing, and pricing
    // must never be able to report a committed write as a failed one: this
    // screen's `recipe` and `before` are frozen at mount, so telling the user
    // "couldn't save, try again" after the revision landed would send them
    // back to a review that describes a recipe which no longer exists — and
    // the second Apply would diff against the wrong "before".
    try {
      const applied = applyRecipeRevision(getDb(), recipe.id, {
        title: revision.title === '' ? recipe.title : revision.title,
        servings: revision.servings,
        ingredients: revision.ingredients,
        steps: revision.steps,
      });
      if (applied === null) {
        setPhase({ kind: 'error', message: 'This recipe is gone — it may have been deleted.' });
        return;
      }
    } catch (error) {
      console.warn('[recipe-revise] save failed', error);
      setPhase({ kind: 'error', message: 'Couldn’t save that change. Try again.' });
      return;
    }
    // The deterministic, offline, free pass — exactly as save_recipe does:
    // anything a mass quantity and an exact catalog name can settle is settled
    // without a model, landing as `catalog` rather than `estimated`. It is
    // best-effort by design: it is idempotent and the recipe screen runs it on
    // every open, so a failure here costs nothing but a moment's delay, and
    // must not be dressed up as a lost edit.
    try {
      catalogResolveRecipe(getDb(), recipe.id);
    } catch (error) {
      console.warn('[recipe-revise] catalog pass failed after a successful save', error);
    }
    router.back();
  };

  if (!recipe) {
    return (
      <Screen>
        <View className="pt-2">
          <StackHeader title="Edit in words" />
        </View>
        <Text className="mt-6 font-serif text-[14px] leading-6 text-ink-secondary">
          This recipe is gone — it may have been deleted.
        </Text>
      </Screen>
    );
  }

  if (!available) {
    return (
      <Screen scroll>
        <View className="pt-2">
          <StackHeader title="Edit in words" parent="Recipe" />
        </View>
        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[15px] leading-6 text-ink-secondary">
              Editing a recipe in words needs a model key — the same one the Coach uses.
            </Text>
            <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-muted">
              Add one in Settings › Coach, then come back. The recipe editor works offline.
            </Text>
          </Block>
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Edit in words" parent="Recipe" />
      </View>

      <Text className="mt-2 font-serif text-[15px] leading-6 text-ink">{recipe.title}</Text>
      <Text className="font-mono text-[11px] text-ink-muted">
        {fmtQty(recipe.servings)} serving{recipe.servings === 1 ? '' : 's'} · {before.length}{' '}
        ingredient{before.length === 1 ? '' : 's'}
      </Text>

      {phase.kind === 'input' || phase.kind === 'working' ? (
        <>
          {/* AS IT STANDS — the recipe the instruction is about, drawn first so
              the user is describing a change to something they can see. */}
          <View className="mt-6">
            <SectionLabel label="As it stands" note={String(before.length)} />
            {before.length === 0 ? (
              <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
                This recipe has no ingredient lines yet — there is nothing to change in words.
              </Text>
            ) : (
              <View className="mt-2">
                <Block device="plate">
                  {before.map((line, index) => (
                    <View key={line.id}>
                      <Divider first={index === 0} />
                      <View className="min-h-[44px] flex-row items-center gap-3 py-2.5">
                        <Text className="flex-1 font-serif text-[15px] leading-5 text-ink">
                          {line.raw_text}
                        </Text>
                        {line.resolved_by === 'user' ? (
                          <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-secondary">
                            your pick
                          </Text>
                        ) : null}
                      </View>
                    </View>
                  ))}
                </Block>
              </View>
            )}
          </View>

          {/* THE INSTRUCTION — a capture surface, so a well with a bare input. */}
          <View className="mt-6">
            <Block device="well">
              <SectionLabel label="What should change" />
              <TextInput
                value={instruction}
                onChangeText={setInstruction}
                placeholder="e.g. swap the milk for almond milk and keep the sweetness"
                placeholderTextColor={palette.inkMuted}
                multiline
                editable={phase.kind === 'input'}
                accessibilityLabel="Describe what should change"
                className="mt-2 min-h-[72px] font-serif text-[15px] leading-6 text-ink"
              />
            </Block>
          </View>

          {phase.kind === 'working' ? (
            <View className="mt-8 items-center">
              <ActivityIndicator color={palette.ink} />
              <Text className="mt-3 font-serif text-[14px] text-ink-secondary">
                Working the change out…
              </Text>
            </View>
          ) : (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Apply this change"
                accessibilityState={{ disabled: instruction.trim() === '' }}
                disabled={instruction.trim() === ''}
                onPress={() => void run()}
                className={
                  instruction.trim() === ''
                    ? 'mt-3 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-paper-deep py-3'
                    : 'mt-3 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn bg-pine py-3 active:opacity-70'
                }>
                <Ionicons
                  name="sparkles-outline"
                  size={18}
                  color={instruction.trim() === '' ? palette.inkMuted : palette.pineOn}
                />
                <Text
                  className={
                    instruction.trim() === ''
                      ? 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
                      : 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-pine-on'
                  }>
                  Apply
                </Text>
              </Pressable>

              <View className="mt-4">
                <Block device="margin">
                  <Text className="font-serif text-[13px] leading-5 text-ink-muted">
                    You’ll see every line that changed before anything is saved. Your notes, photo,
                    tags and everything you’ve already cooked from this recipe are never touched.
                  </Text>
                </Block>
              </View>
            </>
          )}
        </>
      ) : null}

      {phase.kind === 'error' ? (
        <View className="mt-6">
          <Block device="margin">
            <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
              {phase.message}
            </Text>
          </Block>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try again"
            onPress={() => setPhase({ kind: 'input' })}
            className="mt-4 min-h-[44px] items-center justify-center rounded-btn border border-ink py-3 active:opacity-60">
            <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink">
              Try again
            </Text>
          </Pressable>
        </View>
      ) : null}

      {phase.kind === 'review' ? (
        <Review
          recipeTitle={recipe.title}
          recipeServings={recipe.servings}
          before={before}
          beforeSteps={beforeSteps}
          revision={phase.revision}
          onSave={() => save(phase.revision)}
          onDiscard={() => setPhase({ kind: 'input' })}
        />
      ) : null}
    </Screen>
  );
}

/**
 * The proposal, as a decision: what the recipe would become, what it costs in
 * provenance, and the two ways out.
 *
 * The consequence is stated in future tense immediately above the control that
 * causes it, and nothing follows it but its other branch (§5).
 */
function Review({
  recipeTitle,
  recipeServings,
  before,
  beforeSteps,
  revision,
  onSave,
  onDiscard,
}: {
  recipeTitle: string;
  recipeServings: number;
  before: RecipeIngredientRow[];
  beforeSteps: string[];
  revision: RecipeRevision;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const beforeLines = before.map((line) => line.raw_text);
  const rows = diffRecipeLines(beforeLines, revision.ingredients);
  const stepRows = diffRecipeLines(beforeSteps, revision.steps);
  const dropped = droppedRecipeLines(before, revision.ingredients);

  const addedCount = rows.filter((r) => r.state === 'added').length;
  const keptCount = rows.filter((r) => r.state === 'same').length;
  // A line the USER priced by hand is the strongest provenance in the book.
  // Rewording it hands it back to the automatic passes, and that must be said
  // out loud before the user accepts, not discovered afterwards.
  const droppedHandPicks = dropped.filter((line) => line.resolved_by === 'user').length;
  // Lines that carried numbers of any origin and are being reworded.
  const droppedPriced = dropped.filter((line) => line.resolved_by !== null).length;

  const newTitle = revision.title === '' ? recipeTitle : revision.title;
  const titleChanged = newTitle !== recipeTitle;
  const servingsChanged = revision.servings !== recipeServings;
  const stepsChanged = stepRows.some((r) => r.state !== 'same');
  const nothingChanged =
    addedCount === 0 && dropped.length === 0 && !titleChanged && !servingsChanged && !stepsChanged;

  return (
    <View className="mt-6">
      {revision.notes ? (
        <View className="mb-4">
          <Block device="margin">
            <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
              {revision.notes}
            </Text>
          </Block>
        </View>
      ) : null}

      {titleChanged || servingsChanged ? (
        <View className="mb-4">
          <SectionLabel label="Recipe" />
          {titleChanged ? (
            <Text className="mt-2 font-serif text-[15px] leading-6 text-ink">{newTitle}</Text>
          ) : null}
          {servingsChanged ? (
            <Text className="mt-1 font-mono text-[12px] text-ink-secondary">
              {fmtQty(recipeServings)} → {fmtQty(revision.servings)} serving
              {revision.servings === 1 ? '' : 's'}
            </Text>
          ) : null}
        </View>
      ) : null}

      <SectionLabel
        label="Ingredients"
        note={`${keptCount} kept · ${addedCount} new · ${dropped.length} dropped`}
      />
      <View className="mt-2">
        <DiffPlate rows={rows} />
      </View>

      {stepsChanged ? (
        <View className="mt-6">
          <SectionLabel label="Steps" />
          <View className="mt-2">
            <DiffPlate rows={stepRows} />
          </View>
        </View>
      ) : null}

      {/* WHAT IT COSTS. `kept` lines keep their numbers because the row itself
          survives; the rest are re-priced, and the catalog pass gets first
          refusal before anything reaches a model. */}
      <Text className="mt-5 font-serif text-[13px] leading-5 text-ink-muted">
        {nothingChanged
          ? 'Nothing changed — the model returned the recipe as it already is. Try a more specific instruction.'
          : `On save: ${keptCount} line${keptCount === 1 ? '' : 's'} ${
              keptCount === 1 ? 'keeps' : 'keep'
            } the numbers and provenance ${keptCount === 1 ? 'it has' : 'they have'} now${
              addedCount > 0
                ? `, and ${addedCount} rewritten line${
                    addedCount === 1 ? '' : 's'
                  } will be priced automatically — your food catalog first, a model only for what it can’t reach`
                : ''
            }. Notes, tags, the photo and every meal cooked from this recipe are untouched.`}
      </Text>
      {droppedPriced > 0 ? (
        <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
          {droppedHandPicks > 0
            ? `${droppedHandPicks} line${droppedHandPicks === 1 ? '' : 's'} you priced by hand ${
                droppedHandPicks === 1 ? 'is' : 'are'
              } being rewritten, so ${
                droppedHandPicks === 1 ? 'it loses' : 'they lose'
              } that pick and gets priced again.`
            : `${droppedPriced} priced line${droppedPriced === 1 ? '' : 's'} ${
                droppedPriced === 1 ? 'is' : 'are'
              } being rewritten and will be priced again.`}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save these changes"
        onPress={onSave}
        className="mt-3 min-h-[44px] items-center justify-center rounded-btn bg-pine py-3 active:opacity-70">
        <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-pine-on">
          Save changes
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Discard this change"
        onPress={onDiscard}
        className="mt-2 min-h-[44px] items-center justify-center active:opacity-60">
        <Text className="font-label text-[12px] uppercase tracking-[1.2px] text-ink-muted">
          Discard
        </Text>
      </Pressable>
    </View>
  );
}
