import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import {
  createCustomExercise,
  getExercise,
  listExercises,
} from '@/lib/db/repositories/exercise-catalog';
import { MUSCLE_LABEL, MUSCLE_ORDER } from '@/lib/exercise/constants';
import type { CatalogExercise, Equipment, Muscle } from '@/lib/exercise/types';

/**
 * The exercise picker — a modal reused by the routine builder and the live
 * logger. Loads the whole catalog once (69 seeded + any custom) and filters
 * in-memory by search + muscle, so there are no DB reads during render. Also
 * creates a custom exercise inline and selects it. Porcelain Ledger throughout:
 * one pine action per view (Create), mono for the muscle/equipment meta.
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
  const [creating, setCreating] = useState(false);

  const reloadCatalog = useCallback(() => setAll(listExercises(getDb())), []);

  const filtered = useMemo(
    () => all.filter((ex) => matches(ex, search, muscle)),
    [all, search, muscle]
  );

  const close = () => {
    setCreating(false);
    setSearch('');
    setMuscle(null);
    onClose();
  };

  const select = (ex: CatalogExercise) => {
    close();
    onSelect(ex);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close} transparent={false}>
      <SafeAreaView edges={['top', 'bottom']} className="flex-1 bg-paper">
        <View className="flex-1 px-5">
          {/* Header */}
          <View className="flex-row items-center gap-1 pb-1 pt-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={close}
              className="-ml-2 h-9 w-9 items-center justify-center rounded-btn active:opacity-60">
              <Ionicons name="close" size={22} color={palette.ink} />
            </Pressable>
            <Text className="font-serif text-lg font-semibold text-ink">
              {creating ? 'New exercise' : 'Add exercise'}
            </Text>
          </View>

          {creating ? (
            <CreateExerciseForm
              onCancel={() => setCreating(false)}
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
              onNew={() => setCreating(true)}
            />
          )}
        </View>
      </SafeAreaView>
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
  onNew,
}: {
  search: string;
  setSearch: (v: string) => void;
  muscle: Muscle | null;
  setMuscle: (m: Muscle | null) => void;
  filtered: CatalogExercise[];
  onSelect: (ex: CatalogExercise) => void;
  onNew: () => void;
}) {
  return (
    <>
      {/* Search */}
      <View className="mt-2 min-h-[44px] flex-row items-center gap-2 rounded-btn border border-hairline-soft bg-paper-deep px-3.5">
        <Ionicons name="search" size={16} color={palette.inkMuted} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search exercises"
          placeholderTextColor={palette.inkMuted}
          className="flex-1 py-2.5 text-[15px] text-ink"
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

      {/* New custom exercise */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Create a custom exercise"
        onPress={onNew}
        className="mt-3 h-11 flex-row items-center justify-center gap-2 rounded-btn border border-hairline-strong active:bg-paper-deep">
        <Ionicons name="add" size={17} color={palette.inkSecondary} />
        <Text className="text-[13px] font-medium text-ink">New exercise</Text>
      </Pressable>

      {/* List */}
      <ScrollView
        className="-mx-5 mt-3 flex-1 px-5"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="pb-8">
        {filtered.length === 0 ? (
          <Text className="mt-4 text-[13px] leading-5 text-ink-muted">
            No exercises match. Try a different search, or create a custom one above.
          </Text>
        ) : (
          <View className="rounded-card border border-hairline bg-porcelain">
            {filtered.map((ex, i) => (
              <Pressable
                key={ex.id}
                accessibilityRole="button"
                accessibilityLabel={`Add ${ex.name}`}
                onPress={() => onSelect(ex)}
                className={`flex-row items-center gap-3 px-4 py-3 active:bg-paper-deep ${
                  i === 0 ? '' : 'border-t border-hairline-soft'
                }`}>
                <View className="flex-1">
                  <Text className="text-[15px] text-ink">{ex.name}</Text>
                  <Text className="mt-0.5 font-mono text-[10.5px] uppercase tracking-[1px] text-ink-muted">
                    {ex.primaryMuscles.map((m) => MUSCLE_LABEL[m]).join(', ') || '—'} ·{' '}
                    {equipmentLabel(ex.equipment)}
                  </Text>
                </View>
                {ex.isCustom ? (
                  <View className="rounded-btn bg-paper-deep px-2 py-0.5">
                    <Text className="font-mono text-[9px] uppercase tracking-[1px] text-ink-muted">
                      Custom
                    </Text>
                  </View>
                ) : null}
                <Ionicons name="add" size={18} color={palette.inkMuted} />
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </>
  );
}

function FilterChip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      className={`rounded-btn border px-3 py-1.5 active:bg-paper-deep ${
        on ? 'border-hairline-strong bg-paper-deep' : 'border-hairline bg-porcelain'
      }`}>
      <Text className={`text-[12.5px] ${on ? 'font-medium text-ink' : 'text-ink-secondary'}`}>
        {label}
      </Text>
    </Pressable>
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
      <View className="min-h-[44px] justify-center rounded-btn border border-hairline-soft bg-paper-deep px-3.5">
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Exercise name"
          placeholderTextColor={palette.inkMuted}
          className="py-2.5 text-[15px] text-ink"
          accessibilityLabel="Exercise name"
          autoFocus
        />
      </View>

      <Text className="mt-6 text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
        Equipment
      </Text>
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

      <Text className="mt-6 text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
        Primary muscle
      </Text>
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

      {/* The one pine action in this view. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Create exercise"
        accessibilityState={{ disabled: !canCreate }}
        disabled={!canCreate}
        onPress={create}
        className={`mt-8 h-12 items-center justify-center rounded-btn ${
          canCreate ? 'bg-pine active:opacity-70' : 'bg-hairline'
        }`}>
        <Text
          className={`text-[15px] font-semibold ${canCreate ? 'text-pine-on' : 'text-ink-muted'}`}>
          Create & add
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        onPress={onCancel}
        className="mt-3 h-11 items-center justify-center rounded-btn active:bg-paper-deep">
        <Text className="text-[13px] text-ink-secondary">Back to search</Text>
      </Pressable>
    </ScrollView>
  );
}
