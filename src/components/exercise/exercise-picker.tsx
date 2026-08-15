import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
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
  isExerciseSearchAvailable,
  searchExercisesWithAI,
  type ExerciseSearchResult,
} from '@/lib/exercise/ai-search';
import { MUSCLE_LABEL, MUSCLE_ORDER } from '@/lib/exercise/constants';
import type { CatalogExercise, Equipment, Muscle, NewExercise } from '@/lib/exercise/types';

/**
 * The exercise picker — a modal reused by the routine builder and the live
 * logger. Loads the whole catalog once (69 seeded + any custom) and filters
 * in-memory by search + muscle, so there are no DB reads during render. Also
 * creates a custom exercise inline and selects it.
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

function matches(ex: CatalogExercise, search: string, muscle: Muscle | null): boolean {
  if (muscle && !ex.primaryMuscles.includes(muscle) && !ex.secondaryMuscles.includes(muscle)) {
    return false;
  }
  const q = search.trim().toLowerCase();
  if (q === '') return true;
  return ex.name.toLowerCase().includes(q) || ex.aliases.some((a) => a.toLowerCase().includes(q));
}

export function ExercisePicker({ visible, onClose, onSelect }: Props) {
  const [all, setAll] = useState<CatalogExercise[]>(() => listExercises(getDb()));
  const [search, setSearch] = useState('');
  const [muscle, setMuscle] = useState<Muscle | null>(null);
  const [mode, setMode] = useState<'browse' | 'create' | 'ai'>('browse');
  // Set when the user asks for a detail screen; consumed by onDismiss below.
  const [pendingDetailId, setPendingDetailId] = useState<string | null>(null);

  const reloadCatalog = useCallback(() => setAll(listExercises(getDb())), []);

  const filtered = useMemo(
    () => all.filter((ex) => matches(ex, search, muscle)),
    [all, search, muscle]
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
          {/* Header */}
          <View className="flex-row items-center gap-1 pb-1 pt-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={close}
              className="-ml-2 h-11 w-11 items-center justify-center active:opacity-60">
              <Ionicons name="close" size={22} color={palette.ink} />
            </Pressable>
            <Text className="font-serif text-lg font-semibold text-ink">
              {mode === 'create' ? 'New exercise' : mode === 'ai' ? 'Find with AI' : 'Add exercise'}
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
            <AiSearchView
              onCancel={() => setMode('browse')}
              onSelect={select}
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
              onAi={isExerciseSearchAvailable() ? () => setMode('ai') : null}
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
  /** null when no model key is configured — the door simply isn't drawn. */
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

      {/* The other two doors: the manual form, and — when a model key is set —
          AI search ("name it, describe it, or say what you want to do"). */}
      <View className="mt-3 flex-row gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Create a custom exercise"
          onPress={onNew}
          className="min-h-[44px] flex-1 flex-row items-center justify-center gap-2 rounded-btn border border-hairline active:bg-paper-dim">
          <Ionicons name="add" size={17} color={palette.inkSecondary} />
          <Text className="font-label text-[12px] font-semibold uppercase tracking-[1px] text-ink">
            New exercise
          </Text>
        </Pressable>
        {onAi ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Find an exercise with AI"
            onPress={onAi}
            className="min-h-[44px] flex-1 flex-row items-center justify-center gap-2 rounded-btn border border-hairline active:bg-paper-dim">
            <Ionicons name="sparkles-outline" size={15} color={palette.inkSecondary} />
            <Text className="font-label text-[12px] font-semibold uppercase tracking-[1px] text-ink">
              Find with AI
            </Text>
          </Pressable>
        ) : null}
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
                        </Text>
                      </View>
                      {/* A one-word marker, not an object: it used to sit in its
                        own hairline box, which put a border inside a plate row
                        that is already ruled top and bottom (owner, 2026-08-10 —
                        boxes around a single item). The label voice is what
                        marks it, the same as the muscle/equipment line above. */}
                      {ex.isCustom ? (
                        <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
                          Custom
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
 * AI search — "name it, describe it, or say what you want to do". One model
 * turn (src/lib/exercise/ai-search.ts) resolves the words against the catalog:
 * matched movements come back as plain rows (tap adds, exactly like browsing),
 * and genuinely-new movements come back as REVIEW CARDS with the full vetted
 * definition and a ghost "Create & add" — the model proposes, the user
 * disposes, nothing writes silently.
 *
 * **Accent budget: one — the Search action.** Result rows add by plain tap and
 * creation cards use an outlined button, so the accent never multiplies as
 * results appear.
 */
function AiSearchView({
  onCancel,
  onSelect,
  onCreated,
}: {
  onCancel: () => void;
  onSelect: (ex: CatalogExercise) => void;
  onCreated: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [phase, setPhase] = useState<
    | { kind: 'idle' }
    | { kind: 'searching' }
    | { kind: 'results'; result: ExerciseSearchResult }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const canSearch = query.trim().length > 1 && phase.kind !== 'searching';

  const runSearch = async () => {
    if (!canSearch) return;
    setPhase({ kind: 'searching' });
    try {
      const result = await searchExercisesWithAI(getDb(), query);
      setPhase({ kind: 'results', result });
    } catch (error) {
      setPhase({
        kind: 'error',
        message:
          error instanceof Error && error.name === 'ExerciseSearchUnavailableError'
            ? error.message
            : 'Couldn’t search. Check your connection and try again, or browse the catalog.',
      });
    }
  };

  const createFromCard = (definition: NewExercise) => {
    try {
      onCreated(createCustomExercise(getDb(), definition));
    } catch (error) {
      console.warn('[exercise] AI-search create failed', error);
      setPhase({ kind: 'error', message: 'Couldn’t save that exercise. Please try again.' });
    }
  };

  return (
    <ScrollView
      className="-mx-5 mt-2 flex-1 px-5"
      keyboardShouldPersistTaps="handled"
      contentContainerClassName="pb-8">
      <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
        Name it, describe it, or say what you want to train — &ldquo;landmine press&rdquo;,
        &ldquo;that one where you row lying face-down&rdquo;, &ldquo;rear delts with only
        bands&rdquo;.
      </Text>

      {/* The ask — recessed stock: you write into it. */}
      <View className="mt-3 min-h-[64px] border border-paper-deep bg-paper-dim px-3.5">
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="What are you looking for?"
          placeholderTextColor={palette.inkMuted}
          multiline
          className="py-2.5 font-serif text-[15px] leading-5 text-ink"
          accessibilityLabel="Describe the exercise you want"
          autoFocus
        />
      </View>

      {/* The one primary action in this view. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Search with AI"
        accessibilityState={{ disabled: !canSearch }}
        disabled={!canSearch}
        onPress={runSearch}
        className={`mt-3 h-12 flex-row items-center justify-center gap-2 rounded-btn ${
          canSearch ? 'bg-pine active:opacity-70' : 'border border-hairline'
        }`}>
        <Ionicons
          name="sparkles-outline"
          size={15}
          color={canSearch ? palette.pineOn : palette.inkMuted}
        />
        <Text
          className={`font-label text-[15px] font-semibold ${
            canSearch ? 'text-pine-on' : 'text-ink-muted'
          }`}>
          Search
        </Text>
      </Pressable>

      {phase.kind === 'searching' ? (
        <View className="mt-8 items-center">
          <ActivityIndicator color={palette.ink} />
          <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-secondary">
            Looking through the catalog…
          </Text>
        </View>
      ) : null}

      {phase.kind === 'error' ? (
        <Text className="mt-4 font-serif text-[13px] leading-5 text-ink-secondary">
          {phase.message}
        </Text>
      ) : null}

      {phase.kind === 'results' ? (
        <>
          {phase.result.note ? (
            <Text className="mt-4 font-serif text-[12px] leading-5 text-ink-muted">
              {phase.result.note}
            </Text>
          ) : null}

          {phase.result.matches.length > 0 ? (
            <View className="mt-4">
              <Block device="plate">
                <SectionLabel label="In the catalog" note={String(phase.result.matches.length)} />
                <View className="mt-1">
                  {phase.result.matches.map((ex, i) => (
                    <View key={ex.id}>
                      <Divider first={i === 0} />
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Add ${ex.name}`}
                        onPress={() => onSelect(ex)}
                        className="min-h-[44px] flex-row items-center gap-3 py-2 active:opacity-60">
                        <View className="flex-1">
                          <Text className="font-serif text-[15px] text-ink">{ex.name}</Text>
                          <Text className="mt-0.5 font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
                            {ex.primaryMuscles.map((m) => MUSCLE_LABEL[m]).join(', ') || '—'} ·{' '}
                            {equipmentLabel(ex.equipment)}
                          </Text>
                        </View>
                        <Ionicons name="add" size={18} color={palette.inkMuted} />
                      </Pressable>
                    </View>
                  ))}
                </View>
              </Block>
            </View>
          ) : null}

          {phase.result.creations.map((c, i) => (
            <View key={`${c.name}-${i}`} className="mt-4">
              <Block device="plate">
                <SectionLabel label="Not in the catalog — proposed" />
                <Text className="mt-2 font-serif text-[16px] font-semibold text-ink">{c.name}</Text>
                <Text className="mt-0.5 font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
                  {c.primaryMuscles.map((m) => MUSCLE_LABEL[m]).join(', ')} ·{' '}
                  {equipmentLabel(c.equipment)}
                  {c.secondaryMuscles && c.secondaryMuscles.length > 0
                    ? ` · assists ${c.secondaryMuscles.map((m) => MUSCLE_LABEL[m]).join(', ')}`
                    : ''}
                </Text>
                {c.instructions && c.instructions.length > 0 ? (
                  <View className="mt-2">
                    {c.instructions.map((step, si) => (
                      <Text
                        key={si}
                        className="mt-0.5 font-serif text-[12.5px] leading-5 text-ink-secondary">
                        {si + 1}. {step}
                      </Text>
                    ))}
                  </View>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Create ${c.name} and add it`}
                  onPress={() => createFromCard(c)}
                  className="mt-3 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline active:bg-paper-dim">
                  <Ionicons name="add" size={16} color={palette.inkSecondary} />
                  <Text className="font-label text-[12px] font-semibold uppercase tracking-[1px] text-ink">
                    Create &amp; add
                  </Text>
                </Pressable>
              </Block>
            </View>
          ))}
        </>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to search"
        onPress={onCancel}
        className="mt-4 min-h-[44px] items-center justify-center active:opacity-60">
        <Text className="font-label text-[11px] font-semibold uppercase tracking-[1px] text-ink-secondary">
          Back to browse
        </Text>
      </Pressable>
    </ScrollView>
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
