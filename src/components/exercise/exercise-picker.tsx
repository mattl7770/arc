import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Block, Divider, VerticalDivider } from '@/components/ui/block';
import { ModalScreen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import {
  createCustomExercise,
  getExercise,
  listExercises,
} from '@/lib/db/repositories/exercise-catalog';
import {
  addExerciseWithAI,
  isAiExerciseAvailable,
  type ParsedAiExercise,
} from '@/lib/exercise/ai-add';
import { MUSCLE_LABEL, MUSCLE_ORDER } from '@/lib/exercise/constants';
import { offersAiEntry, rankExerciseMatches } from '@/lib/exercise/match';
import { DEFAULT_MEASURES, measuresLabel, type Measures } from '@/lib/exercise/measures';
import type { CatalogExercise, Equipment, Muscle, NewExercise } from '@/lib/exercise/types';

/**
 * The exercise picker — a modal reused by the routine builder and the live
 * logger. Loads the whole catalog once (69 seeded + any custom) and ranks it
 * in-memory by search + muscle, so there are no DB reads during render. Also
 * creates a custom exercise inline and selects it.
 *
 * Search tolerates how people actually type (2026-09-14): misspellings,
 * alternative names, and words run together — see {@link visibleExercises}.
 *
 * ## Catalog first, then the model (C12, 2026-09-14)
 *
 * Owner: *"ai add exercise replaces ai search (search catalog first)."* The old
 * "Find with AI" door was a standing third entrance that sent the model the
 * whole catalog index and asked it to pick — a retrieval problem the ranked
 * matcher already solves offline and deterministically.
 *
 * It is gone. Typing searches the catalog, and **only when nothing above the
 * matcher's weakest tier matches** (`offersAiEntry`) does *Add with AI*
 * appear, in the empty-results state where the reader is already looking. It
 * asks the model for a catalog ENTRY — name, aliases, equipment, muscles,
 * measures, logging type — which is rendered for review and written only on
 * Save, marked `source: 'ai'`. Nothing is created silently: those muscles feed
 * freshness, weekly volume and the body figure.
 *
 * ## The surface system (00-design-spec.md §1)
 *
 *   Catalog list   plate   a catalog is a record, so the results are ruled
 *
 * The search field and the filter chips are controls, not content blocks, so
 * they take no device: the field is recessed stock drawn inline and the chips
 * are outlined in the label voice.
 *
 * **Accent budget: one per view, and only in one of the two.** Browsing has no
 * accent at all — picking a row *is* the action, and it is a plain tap. The
 * create form has exactly one: "Create & add".
 *
 * ## Two affordances per row, and why it is two
 *
 * This picker is the app's only route into `app/exercise-detail` (history,
 * estimated-1RM trend, personal records). The row itself cannot carry both jobs:
 * `onSelect` is the picker's contract with app/routine-edit.tsx and
 * app/workout-live.tsx, and tapping a name there must keep meaning "add this
 * one". So the detail sits BESIDE the row as its own 44pt button with its own
 * label — visible, not a hidden long-press, and impossible to hit by accident
 * while adding.
 *
 * Opening it has to survive the modal. A pushed route renders *under* a native
 * `Modal`, so the detail would open invisibly behind this sheet; the id is
 * parked instead and pushed from `onDismiss`, which fires once the sheet is
 * actually gone. (`onDismiss` is iOS-only, and ARC is iOS-only — CLAUDE.md §3.)
 */

type Props = {
  visible: boolean;
  onClose: () => void;
  onSelect: (exercise: CatalogExercise) => void;
};

/** Equipment offered in the custom-exercise form — the common set. */
const EQUIPMENT_OPTIONS: { value: Equipment; label: string }[] = [
  { value: 'barbell', label: 'Barbell' },
  { value: 'dumbbell', label: 'Dumbbell' },
  { value: 'cable', label: 'Cable' },
  { value: 'machine', label: 'Machine' },
  { value: 'bodyweight', label: 'Bodyweight' },
  { value: 'kettlebell', label: 'Kettlebell' },
  { value: 'other', label: 'Other' },
];

function equipmentLabel(e: Equipment): string {
  return EQUIPMENT_OPTIONS.find((o) => o.value === e)?.label ?? e.replace(/_/g, ' ');
}

/**
 * What this movement measures, appended to the muscle/equipment line — but only
 * when it is NOT the ordinary reps × load (0046).
 *
 * The owner needs to know he will be asked for a clock and a distance BEFORE he
 * picks the movement mid-session. He does not need to be told that a barbell
 * curl takes reps and a weight, which is what every row in the catalog would
 * otherwise say. Showing the measure only where it surprises keeps the line a
 * signal instead of a column.
 */
function measureNote(measures: Measures): string {
  return measures === DEFAULT_MEASURES ? '' : ` · ${measuresLabel(measures)}`;
}

function worksMuscle(ex: CatalogExercise, muscle: Muscle | null): boolean {
  return !muscle || ex.primaryMuscles.includes(muscle) || ex.secondaryMuscles.includes(muscle);
}

/**
 * The visible catalog: filtered by muscle, and — when something is typed —
 * RANKED rather than merely filtered (owner, 2026-09-14: *"more intelligent
 * search for exercises, i.e. common misspellings, alternative names"*).
 *
 * The ranking is src/lib/exercise/match.ts, the same tiers and the same folding
 * the resolver uses, so "lat pulldowns", "pull-downs", "skullcrusher" and
 * "bnech press" all find their movement here exactly as they do when the Coach
 * or a photo import resolves a name. What differs is the response to ambiguity:
 * a list can show nine presses and let a human choose, where the resolver must
 * answer with one id or none.
 *
 * With the field empty this is the plain alphabetical catalog — `listExercises`
 * already returns it name-ordered, so browsing is untouched.
 */
function visibleExercises(
  all: CatalogExercise[],
  search: string,
  muscle: Muscle | null
): CatalogExercise[] {
  const byMuscle = all.filter((ex) => worksMuscle(ex, muscle));
  if (search.trim() === '') return byMuscle;
  const byId = new Map(byMuscle.map((ex) => [ex.id, ex] as const));
  return rankExerciseMatches(byMuscle, search)
    .map((m) => byId.get(m.id))
    .filter((ex): ex is CatalogExercise => ex !== undefined);
}

export function ExercisePicker({ visible, onClose, onSelect }: Props) {
  const [all, setAll] = useState<CatalogExercise[]>(() => listExercises(getDb()));
  const [search, setSearch] = useState('');
  const [muscle, setMuscle] = useState<Muscle | null>(null);
  const [mode, setMode] = useState<'browse' | 'create' | 'ai'>('browse');
  // Set when the user asks for a detail screen; consumed by onDismiss below.
  const [pendingDetailId, setPendingDetailId] = useState<string | null>(null);

  const reloadCatalog = useCallback(() => setAll(listExercises(getDb())), []);

  const filtered = useMemo(() => visibleExercises(all, search, muscle), [all, search, muscle]);

  /**
   * Whether the AI door is drawn at all — the catalog-first gate (C12), plus a
   * model key to walk through it with.
   *
   * `offersAiEntry` (src/lib/exercise/match.ts) is asked about the WHOLE
   * catalog, not about `filtered`: the muscle chips are the reader's own
   * narrowing, and "Back" selected while searching "landmine press" must not be
   * read as ARC lacking the movement.
   */
  const aiOffered = useMemo(
    () =>
      isAiExerciseAvailable() &&
      offersAiEntry(
        all.map((ex) => ({ id: ex.id, name: ex.name, aliases: ex.aliases })),
        search
      ),
    [all, search]
  );

  const close = () => {
    setMode('browse');
    setSearch('');
    setMuscle(null);
    onClose();
  };

  const select = (ex: CatalogExercise) => {
    close();
    onSelect(ex);
  };

  /**
   * Park the id and dismiss. Nothing is selected — the caller's `onSelect` is
   * untouched — so backing out of the detail screen leaves the routine or the
   * live workout exactly as it was.
   */
  const openDetail = (ex: CatalogExercise) => {
    setPendingDetailId(ex.id);
    close();
  };

  /** Runs after the sheet is really gone, so the pushed screen is on top of it. */
  const afterDismiss = () => {
    if (pendingDetailId === null) return;
    const id = pendingDetailId;
    setPendingDetailId(null);
    router.push({ pathname: '/exercise-detail', params: { id } });
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={close}
      onDismiss={afterDismiss}
      transparent={false}>
      {/* A native Modal never passes through `<Screen>`, so `ModalScreen` prints
          the sheet, the grid and the safe-area provider this hierarchy has to
          carry itself — see that component for why the inset is otherwise zero
          and the close control lands under the status bar. */}
      <ModalScreen>
        <View className="flex-1 px-5">
          {/* Header — the modal close rule in ModalScreen's docblock. This one
              already led; the margin was −8, which put the glyph two points
              inside every other leading control in the app. −12 is
              StackHeader's, and is now the same number in all three modals. */}
          <View className="flex-row items-center gap-1 pb-1 pt-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={close}
              hitSlop={8}
              className="-ml-3 h-11 w-11 items-center justify-center active:opacity-60">
              <Ionicons name="close" size={22} color={palette.ink} />
            </Pressable>
            <Text className="flex-1 font-serif text-lg font-semibold text-ink">
              {mode === 'create' ? 'New exercise' : mode === 'ai' ? 'Add with AI' : 'Add exercise'}
            </Text>
          </View>

          {mode === 'create' ? (
            <CreateExerciseForm
              onCancel={() => setMode('browse')}
              onCreated={(id) => {
                reloadCatalog();
                const ex = getExercise(getDb(), id);
                if (ex) select(ex);
              }}
            />
          ) : mode === 'ai' ? (
            <AiAddView
              query={search}
              onCancel={() => setMode('browse')}
              onCreated={(id) => {
                reloadCatalog();
                const ex = getExercise(getDb(), id);
                if (ex) select(ex);
              }}
            />
          ) : (
            <BrowseCatalog
              search={search}
              setSearch={setSearch}
              muscle={muscle}
              setMuscle={setMuscle}
              filtered={filtered}
              onSelect={select}
              onOpenDetail={openDetail}
              onNew={() => setMode('create')}
              onAi={aiOffered ? () => setMode('ai') : null}
            />
          )}
        </View>
      </ModalScreen>
    </Modal>
  );
}

function BrowseCatalog({
  search,
  setSearch,
  muscle,
  setMuscle,
  filtered,
  onSelect,
  onOpenDetail,
  onNew,
  onAi,
}: {
  search: string;
  setSearch: (v: string) => void;
  muscle: Muscle | null;
  setMuscle: (m: Muscle | null) => void;
  filtered: CatalogExercise[];
  onSelect: (ex: CatalogExercise) => void;
  onOpenDetail: (ex: CatalogExercise) => void;
  onNew: () => void;
  /**
   * null unless the catalog has nothing confident for what was typed AND a
   * model key is configured — the door is not a standing entrance (C12).
   */
  onAi: (() => void) | null;
}) {
  return (
    <>
      {/* Search — recessed stock: you write into it. */}
      <View className="mt-2 min-h-[44px] flex-row items-center gap-2 border border-paper-deep bg-paper-dim px-3.5">
        <Ionicons name="search" size={16} color={palette.inkMuted} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search exercises"
          placeholderTextColor={palette.inkMuted}
          className="flex-1 py-2.5 font-serif text-[15px] text-ink"
          accessibilityLabel="Search exercises"
          autoCorrect={false}
        />
      </View>

      {/* Muscle filter chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="-mx-5 mt-2 grow-0 px-5"
        contentContainerClassName="gap-2 py-1">
        <FilterChip label="All" on={muscle === null} onPress={() => setMuscle(null)} />
        {MUSCLE_ORDER.map((m) => (
          <FilterChip
            key={m}
            label={MUSCLE_LABEL[m]}
            on={muscle === m}
            onPress={() => setMuscle(muscle === m ? null : m)}
          />
        ))}
      </ScrollView>

      {/* The manual door, always. The AI door used to sit beside it as a
          standing third entrance; it now lives in the results plate below,
          where it is only drawn once the catalog has come up empty-handed. */}
      <View className="mt-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Create a custom exercise"
          onPress={onNew}
          className="min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline active:bg-paper-dim">
          <Ionicons name="add" size={17} color={palette.inkSecondary} />
          <Text className="font-label text-[12px] font-semibold uppercase tracking-[1px] text-ink">
            New exercise
          </Text>
        </Pressable>
      </View>

      {/* Results — a catalog is a record, so: one ruled plate, drawn whether or
          not the search matched. A no-match state appears mid-typing here, and
          the plate holding steady across it is what keeps the results list in
          one place instead of collapsing and re-drawing under the reader's
          thumb. (The sweep of 2026-08-10 made it conditional; reverted at the
          owner's instruction.) */}
      <ScrollView
        className="-mx-5 mt-3 flex-1 px-5"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="pb-8">
        <Block device="plate">
          <SectionLabel
            label="Catalog"
            note={filtered.length > 0 ? String(filtered.length) : undefined}
          />
          {filtered.length === 0 ? (
            <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
              No exercises match. Try a different search, or create a custom one above.
            </Text>
          ) : (
            <View className="mt-1">
              {filtered.map((ex, i) => (
                // Two controls, one row. The row proper adds; the button past
                // the rule opens that exercise's history and records. The rule
                // is what says they are two things — without it the icons read
                // as one cluster of decoration on a single tap target.
                <View key={ex.id}>
                  <Divider first={i === 0} />
                  <View className="flex-row items-center">
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Add ${ex.name}`}
                      onPress={() => onSelect(ex)}
                      className="min-h-[44px] flex-1 flex-row items-center gap-3 py-2 pr-3 active:opacity-60">
                      <View className="flex-1">
                        <Text className="font-serif text-[15px] text-ink">{ex.name}</Text>
                        <Text className="mt-0.5 font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
                          {ex.primaryMuscles.map((m) => MUSCLE_LABEL[m]).join(', ') || '—'} ·{' '}
                          {equipmentLabel(ex.equipment)}
                          {measureNote(ex.measures)}
                        </Text>
                      </View>
                      {/* A one-word marker, not an object: it used to sit in its
                        own hairline box, which put a border inside a plate row
                        that is already ruled top and bottom (owner, 2026-08-10 —
                        boxes around a single item). The label voice is what
                        marks it, the same as the muscle/equipment line above.

                        Still one word, and now the more useful one where the
                        two differ (0056): a movement a model defined reads AI
                        rather than Custom. That is the whole point of recording
                        provenance — a mark nobody can see is not provenance,
                        and this row is where the owner meets the movement again
                        a month after approving it. */}
                      {ex.isCustom ? (
                        <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
                          {ex.source === 'ai' ? 'AI' : 'Custom'}
                        </Text>
                      ) : null}
                      <Ionicons name="add" size={18} color={palette.inkMuted} />
                    </Pressable>
                    {/* The rule that splits the two controls. `self-stretch` on
                      the divider matches the row's height even when a long name
                      wraps; a `border-l` here would box the button (see
                      Divider). The button width holds the 44pt floor. */}
                    <VerticalDivider />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${ex.name} history and records`}
                      onPress={() => onOpenDetail(ex)}
                      className="min-h-[44px] w-11 items-center justify-center self-stretch active:bg-paper-dim">
                      <Ionicons name="analytics-outline" size={17} color={palette.inkMuted} />
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
          )}

          {/*
            The AI door — drawn only when the ranked matcher found nothing above
            its weakest tier for what was typed (C12). That is the whole of
            "catalog first": ARC answers from its own catalog whenever it
            honestly can, and the model is asked only to DEFINE what the catalog
            lacks.

            It sits inside the results plate, below whatever the search did
            manage to turn up, because that is where the reader already is when
            a search disappoints — and because the weak guesses above it are
            still worth reading first. Outlined, never the accent: browsing this
            picker has no accent at all, and adding a door is not a reason to
            spend one. The rule above it is `Divider`, so it reads as the last
            line of the record rather than a box bolted onto it.
          */}
          {onAi ? (
            <View className="mt-1">
              <Divider first={filtered.length === 0} />
              <Text className="mt-2.5 font-serif text-[13px] leading-5 text-ink-secondary">
                {filtered.length === 0
                  ? 'ARC doesn’t have this one.'
                  : 'ARC doesn’t have a close match.'}{' '}
                AI can write the catalog entry — you review it before it’s saved.
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Add ${search.trim()} with AI`}
                onPress={onAi}
                className="mt-2.5 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline active:bg-paper-dim">
                <Ionicons name="sparkles-outline" size={15} color={palette.inkSecondary} />
                <Text className="font-label text-[12px] font-semibold uppercase tracking-[1px] text-ink">
                  Add with AI
                </Text>
              </Pressable>
            </View>
          ) : null}
        </Block>
      </ScrollView>
    </>
  );
}

/**
 * A filter / option chip in the label voice. Selection is marked by a recessed fill
 * and weight, never by the accent — a chip is chrome, and the accent budget is
 * spent on the one primary action per view.
 *
 * `min-h-[44px]` is the tap-target floor and has to be declared here: this chip
 * is laid out in a horizontal ScrollView and in two `flex-wrap` rows, none of
 * which stretch a child to a height it did not ask for. It was 36pt.
 */
function FilterChip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      className={`min-h-[44px] justify-center rounded-btn border border-hairline px-3 active:opacity-60 ${
        on ? 'bg-paper-dim' : ''
      }`}>
      <Text
        className={`font-label text-[11px] uppercase tracking-[1px] ${
          on ? 'font-semibold text-ink' : 'text-ink-secondary'
        }`}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * **Add with AI** — the model writes a catalog ENTRY, and the owner approves it.
 *
 * Reached only from the catalog-first gate in {@link BrowseCatalog}: the search
 * has already run, ARC has nothing above the matcher's weakest tier, and the
 * words the owner typed are handed straight to `src/lib/exercise/ai-add.ts`. So
 * this view opens ALREADY RUNNING — there is no second field to retype the same
 * words into, which is what the retired AI-search door made you do.
 *
 * Four beats, the house contract: ask (already made) → work → **review** →
 * save. The review card prints every fact that will land on the row, including
 * the ones the owner would otherwise never see — the aliases his future
 * searches will match, and the secondary muscles that will feed freshness,
 * weekly volume and the body figure. Those are the reason nothing is written
 * before Save.
 *
 * **Accent budget: one — Save & add.** Everything else is outlined or plain.
 */
function AiAddView({
  query,
  onCancel,
  onCreated,
}: {
  /** What was typed in the search field — the ask, already made. */
  query: string;
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  // The view opens WORKING — the ask was made on the previous screen, so there
  // is no idle state to sit in and nothing to press to begin.
  const [phase, setPhase] = useState<
    | { kind: 'working' }
    | { kind: 'review'; result: ParsedAiExercise }
    | { kind: 'error'; message: string }
  >({ kind: 'working' });
  // Bumped by Try again; the only thing that re-runs the turn. The counter is
  // the retry rather than a callback so the effect below never has to set state
  // synchronously — which is a lint error and, more to the point, a cascading
  // render on a screen that is already mid-request.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // `cancelled` is not a nicety: the sheet can be dismissed mid-flight, and a
    // `setPhase` after that is a state update on an unmounted tree.
    let cancelled = false;
    addExerciseWithAI(query)
      .then((result) => {
        if (!cancelled) setPhase({ kind: 'review', result });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPhase({
          kind: 'error',
          message:
            error instanceof Error && error.name === 'AiExerciseUnavailableError'
              ? error.message
              : error instanceof Error && /reply|JSON|movement|incomplete/i.test(error.message)
                ? // The model answered and the answer was unusable — say that,
                  // rather than blaming a connection that plainly worked.
                  error.message
                : // The honest offline state. Everything else in this picker —
                  // browsing, searching, the manual form — works with the
                  // network unplugged, so the sentence says which half is down.
                  'Couldn’t reach the model. Browsing and “New exercise” still work offline.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [query, attempt]);

  const retry = () => {
    setPhase({ kind: 'working' });
    setAttempt((n) => n + 1);
  };

  const save = (entry: NewExercise) => {
    try {
      onCreated(createCustomExercise(getDb(), entry));
    } catch (error) {
      console.warn('[exercise] AI entry save failed', error);
      setPhase({ kind: 'error', message: 'Couldn’t save that exercise. Please try again.' });
    }
  };

  return (
    <ScrollView
      className="-mx-5 mt-2 flex-1 px-5"
      keyboardShouldPersistTaps="handled"
      contentContainerClassName="pb-8">
      {/* The ask, quoted back. The owner typed it one screen ago, and a review
          card with no subject is a card about nothing. */}
      <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
        Writing a catalog entry for <Text className="text-ink">“{query.trim()}”</Text>. Nothing is
        saved until you say so.
      </Text>

      {phase.kind === 'working' ? (
        <View className="mt-8 items-center">
          <ActivityIndicator color={palette.ink} />
          <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-secondary">
            Looking it up…
          </Text>
        </View>
      ) : null}

      {phase.kind === 'error' ? (
        <>
          <Text className="mt-5 font-serif text-[13px] leading-5 text-ink-secondary">
            {phase.message}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try again"
            onPress={retry}
            className="mt-4 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline active:bg-paper-dim">
            <Text className="font-label text-[12px] font-semibold uppercase tracking-[1px] text-ink">
              Try again
            </Text>
          </Pressable>
        </>
      ) : null}

      {phase.kind === 'review' ? (
        <>
          {phase.result.note ? (
            <Text className="mt-4 font-serif text-[12px] leading-5 text-ink-muted">
              {phase.result.note}
            </Text>
          ) : null}
          <View className="mt-4">
            <EntryReview entry={phase.result.entry} />
          </View>
          {/* The one primary action in this view. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Save ${phase.result.entry.name} and add it`}
            onPress={() => save(phase.result.entry)}
            className="mt-5 h-12 flex-row items-center justify-center gap-2 rounded-btn bg-pine active:opacity-70">
            <Text className="font-label text-[15px] font-semibold text-pine-on">
              Save &amp; add
            </Text>
          </Pressable>
        </>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to the catalog"
        onPress={onCancel}
        className="mt-4 min-h-[44px] items-center justify-center active:opacity-60">
        <Text className="font-label text-[11px] font-semibold uppercase tracking-[1px] text-ink-secondary">
          Back to browse
        </Text>
      </Pressable>
    </ScrollView>
  );
}

/**
 * The proposed entry, in full — a record of what is about to become a catalog
 * row, so: ruled plate, one labelled line per fact.
 *
 * Every field the model authored is printed, and that is the point rather than
 * thoroughness for its own sake. The **muscles** decide what this movement
 * contributes to freshness, weekly volume and the body figure; the **aliases**
 * decide whether the owner ever finds it again by another name; the
 * **measures** decide which columns the logger draws for it. None of those is
 * visible anywhere else once the row exists, so this card is the only moment
 * they can be checked. The `AI` mark on the section label is on the card
 * because it will be on the row (`source: 'ai'`, 0056) — a card that hid it
 * would be the silent creation this flow exists to avoid.
 */
function EntryReview({ entry }: { entry: NewExercise }) {
  const rows: { label: string; value: string }[] = [
    { label: 'Equipment', value: equipmentLabel(entry.equipment) },
    {
      label: 'Primary',
      value: entry.primaryMuscles.map((m) => MUSCLE_LABEL[m]).join(', ') || '—',
    },
    {
      label: 'Secondary',
      value: (entry.secondaryMuscles ?? []).map((m) => MUSCLE_LABEL[m]).join(', ') || '—',
    },
    { label: 'Records', value: measuresLabel(entry.measures ?? DEFAULT_MEASURES) },
    { label: 'Also called', value: (entry.aliases ?? []).join(', ') || '—' },
  ];
  return (
    <Block device="plate">
      <SectionLabel label="Proposed entry" note="AI" />
      <Text className="mt-2 font-serif text-[16px] font-semibold text-ink">{entry.name}</Text>
      <View className="mt-1">
        {rows.map((r, i) => (
          <View key={r.label}>
            <Divider first={i === 0} />
            <View className="flex-row items-baseline gap-3 py-1.5">
              <Text className="w-20 font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
                {r.label}
              </Text>
              <Text className="flex-1 font-serif text-[13px] leading-5 text-ink">{r.value}</Text>
            </View>
          </View>
        ))}
      </View>
      {entry.instructions && entry.instructions.length > 0 ? (
        <View className="mt-2">
          <Divider />
          {entry.instructions.map((step, si) => (
            <Text key={si} className="mt-1.5 font-serif text-[12.5px] leading-5 text-ink-secondary">
              {si + 1}. {step}
            </Text>
          ))}
        </View>
      ) : null}
    </Block>
  );
}

function CreateExerciseForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [equipment, setEquipment] = useState<Equipment>('barbell');
  const [primary, setPrimary] = useState<Muscle | null>(null);

  const canCreate = name.trim() !== '' && primary !== null;

  const create = () => {
    if (!canCreate || primary === null) return;
    // Bodyweight movements log bodyweight reps; everything else weight × reps.
    const loggingType = equipment === 'bodyweight' ? 'bodyweight_reps' : 'weight_reps';
    const id = createCustomExercise(getDb(), {
      name: name.trim(),
      equipment,
      loggingType,
      primaryMuscles: [primary],
    });
    onCreated(id);
  };

  return (
    <ScrollView
      className="-mx-5 mt-2 flex-1 px-5"
      keyboardShouldPersistTaps="handled"
      contentContainerClassName="pb-8">
      <View className="min-h-[44px] justify-center border border-paper-deep bg-paper-dim px-3.5">
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Exercise name"
          placeholderTextColor={palette.inkMuted}
          className="py-2.5 font-serif text-[15px] text-ink"
          accessibilityLabel="Exercise name"
          autoFocus
        />
      </View>

      <View className="mt-6">
        <SectionLabel label="Equipment" />
      </View>
      <View className="mt-2 flex-row flex-wrap gap-2">
        {EQUIPMENT_OPTIONS.map((o) => (
          <FilterChip
            key={o.value}
            label={o.label}
            on={equipment === o.value}
            onPress={() => setEquipment(o.value)}
          />
        ))}
      </View>

      <View className="mt-6">
        <SectionLabel label="Primary muscle" />
      </View>
      <View className="mt-2 flex-row flex-wrap gap-2">
        {MUSCLE_ORDER.map((m) => (
          <FilterChip
            key={m}
            label={MUSCLE_LABEL[m]}
            on={primary === m}
            onPress={() => setPrimary(m)}
          />
        ))}
      </View>

      {/*
        The one primary action in this view. Disabled reads as an unfilled
        outline rather than a filled grey: muted ink on the sheet clears 4.5:1,
        on a hairline fill it does not.
      */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Create exercise"
        accessibilityState={{ disabled: !canCreate }}
        disabled={!canCreate}
        onPress={create}
        className={`mt-8 h-12 items-center justify-center rounded-btn ${
          canCreate ? 'bg-pine active:opacity-70' : 'border border-hairline'
        }`}>
        <Text
          className={`font-label text-[15px] font-semibold ${
            canCreate ? 'text-pine-on' : 'text-ink-muted'
          }`}>
          Create & add
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        onPress={onCancel}
        className="mt-3 min-h-[44px] items-center justify-center active:opacity-60">
        <Text className="font-label text-[11px] font-semibold uppercase tracking-[1px] text-ink-secondary">
          Back to search
        </Text>
      </Pressable>
    </ScrollView>
  );
}
