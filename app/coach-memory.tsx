import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import {
  deleteMemory,
  forgetMemory,
  getMemory,
  MEMORY_PROMPT_LIMIT,
  rememberFact,
  restoreMemory,
  updateMemory,
  type MemoryCategory,
} from '@/lib/db/repositories/coach-memory';

/**
 * Write or edit ONE durable memory — the line the Coach carries in every turn.
 *
 * ## What this screen used to be (C14)
 *
 * It was the whole memory surface: Settings › Coach memory, a read-and-delete
 * list. The owner's call was to RELOCATE, not merge — *"I should be able to
 * manually add stuff to coach memory that it should know every turn"* — so the
 * LIST moved onto the Knowledge hub (app/knowledge.tsx, first run) where the
 * owner already writes, and this route became the editor that hub opens. The
 * route is kept rather than deleted precisely so there is no second list to
 * drift: the hub reads, this writes, and Settings links.
 *
 * It is `push`ed two ways: with no `id` to write a new memory, and with one to
 * edit, forget, restore or delete an existing one.
 *
 * ## Why a whole screen for one sentence
 *
 * Because it is not one sentence — it is one sentence THAT IS BILLED ON EVERY
 * REQUEST, forever, until it is removed. The cap is stated on the hub and the
 * cost is stated here, under the field, so the owner writing his 41st memory
 * learns what it displaces at the moment he is writing it rather than the day
 * the Coach stops acting on something he can still read on screen.
 *
 * ## Conformed Set treatment
 *
 * A **form**, so no device at all: `SectionLabel` names each group and
 * whitespace separates them, the app/knowledge-entry-edit.tsx model verbatim —
 * the two things the owner writes into the knowledge sub-app should not be two
 * different kinds of form. Every field wears the well's own surface directly
 * (`border-paper-deep bg-paper-dim`); an input is never `bg-paper-hi`.
 *
 * **Accent budget: one.** Save. The category chips are neutral — a category is
 * neither biology nor the next action, so selection is carried by ink weight and
 * a filled ground, never by hue.
 */

/** Written out in full, never composed — Tailwind only sees literal names. */
const INPUT =
  'min-h-[96px] leading-6 border border-paper-deep bg-paper-dim px-3.5 py-3 font-serif text-[15px] text-ink';

/** The chip pair, lifted from knowledge-entry-edit so the two forms match. */
const CHIP = 'min-h-[44px] justify-center rounded-btn border border-hairline px-3.5';
const CHIP_ON = 'min-h-[44px] justify-center rounded-btn border border-ink bg-ink px-3.5';

const CATEGORIES: [MemoryCategory, string, string][] = [
  ['preference', 'Preference', 'How you like things done.'],
  ['constraint', 'Constraint', 'A limit or a reaction the Coach must work around.'],
  ['context', 'Context', 'Stable background — who you are, what your life looks like.'],
  ['goal', 'Goal', 'What you are working toward.'],
];

export default function CoachMemoryScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  // Read ONCE into state, not on every render: the delete and forget paths
  // below navigate away, and a re-read after the row is gone would throw on the
  // frame between the write and the pop.
  const [editing] = useState(() => (typeof id === 'string' ? getMemory(getDb(), id) : undefined));
  const [content, setContent] = useState(editing?.content ?? '');
  const [category, setCategory] = useState<MemoryCategory>(editing?.category ?? 'context');
  const forgotten = editing?.archived_at != null;

  const canSave = content.trim() !== '';

  const save = () => {
    if (!canSave) return;
    const db = getDb();
    if (editing) updateMemory(db, editing.id, { content, category });
    // `source: 'user'` — this is the owner's own hand, and the provenance has
    // to survive it: a line he wrote is not a line the Coach proposed and he
    // approved, even though both end up in the same column.
    else rememberFact(db, { content, category, source: 'user' });
    router.back();
  };

  const confirmDelete = () => {
    if (!editing) return;
    Alert.alert('Delete this memory?', editing.content, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          deleteMemory(getDb(), editing.id);
          router.back();
        },
      },
    ]);
  };

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader
          title={editing ? 'Edit memory' : 'Remember something'}
          parent="Knowledge"
        />
      </View>

      <View className="mt-5">
        <SectionLabel label="The memory" />
        <TextInput
          accessibilityLabel="The memory"
          value={content}
          onChangeText={setContent}
          placeholder="One sentence that stays true — “Trains fasted before 9am”, “Magnesium citrate upsets my stomach”."
          placeholderTextColor={palette.inkMuted}
          multiline
          textAlignVertical="top"
          className={INPUT}
          style={{ marginTop: 8 }}
        />
        {/* The cost, stated where the line is being written. This is the LENGTH
            litmus from docs/knowledge-subapp.md §8, put in front of the owner
            at the moment the choice is live — anything longer than a line
            belongs in a Personal entry, which is retrieved instead of carried. */}
        <Text className="mt-2 font-serif text-[12px] leading-5 text-ink-muted">
          The Coach carries this in every single turn, so keep it to a line. Anything longer — a
          surgery and what it still costs you, a full account of how you react to something — is a
          Personal entry instead, and the Coach reads that back when it bears on what you asked.
        </Text>
      </View>

      <View className="mt-7">
        <SectionLabel label="Kind" />
        <View className="mt-2 flex-row flex-wrap gap-2">
          {CATEGORIES.map(([value, label]) => {
            const selected = value === category;
            return (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={label}
                onPress={() => setCategory(value)}
                className={selected ? CHIP_ON : CHIP}>
                <Text
                  className={
                    selected
                      ? 'font-label text-[13px] font-semibold text-paper-hi'
                      : 'font-label text-[13px] font-semibold text-ink-secondary'
                  }>
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text className="mt-2 font-serif text-[12px] leading-5 text-ink-muted">
          {CATEGORIES.find(([value]) => value === category)?.[2]}
        </Text>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={editing ? 'Save changes' : 'Remember this'}
        accessibilityState={{ disabled: !canSave }}
        disabled={!canSave}
        onPress={save}
        className={
          canSave
            ? 'mt-7 min-h-[48px] items-center justify-center rounded-btn bg-pine active:opacity-70'
            : 'mt-7 min-h-[48px] items-center justify-center rounded-btn border border-hairline bg-paper-dim'
        }>
        <Text
          className={
            canSave
              ? 'font-label text-[15px] font-semibold text-pine-on'
              : 'font-label text-[15px] font-semibold text-ink-muted'
          }>
          {editing ? 'Save changes' : 'Remember this'}
        </Text>
      </Pressable>

      {/* Removal, and only when there is something to remove. Two rungs, because
          they are two different acts: forgetting is reversible and keeps the
          record of having known it; deleting is not and does not. Both are
          muted — a destructive control never competes with Save for the accent. */}
      {editing ? (
        <View className="mt-7">
          <SectionLabel label={forgotten ? 'Forgotten' : 'Stop using this'} />
          <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
            {forgotten
              ? `Forgotten ${(editing.archived_at ?? '').slice(0, 10)}. It stays here, out of every turn, until you restore it.`
              : 'Forgetting drops it out of every turn and keeps it on this screen, so you can see what the Coach used to know. Deleting removes it for good.'}
          </Text>
          <View className="mt-3 flex-row items-stretch gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={forgotten ? 'Restore this memory' : 'Forget this memory'}
              onPress={() => {
                const db = getDb();
                if (forgotten) restoreMemory(db, editing.id);
                else forgetMemory(db, editing.id);
                router.back();
              }}
              className="min-h-[46px] flex-1 items-center justify-center rounded-btn border border-hairline py-3 active:bg-paper-dim">
              <Text
                className={
                  forgotten
                    ? 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-pine'
                    : 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink'
                }>
                {forgotten ? 'Restore' : 'Forget'}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Delete this memory permanently"
              onPress={confirmDelete}
              className="min-h-[46px] flex-1 items-center justify-center rounded-btn border border-hairline py-3 active:bg-paper-dim">
              <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
                Delete
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* A memory opened from a link that no longer resolves — the
          knowledge-entry.tsx idiom. Authored, never a blank screen. */}
      {typeof id === 'string' && !editing ? (
        <View className="mt-5">
          <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
            That memory is no longer here. It was deleted; what you write above will be saved as a
            new one.
          </Text>
        </View>
      ) : null}

      <Text className="mt-7 font-serif text-[12px] leading-5 text-ink-muted">
        The Coach carries the {MEMORY_PROMPT_LIMIT} most recent memories into every turn. Past that
        the oldest stop riding along — they stay on this list, and the Coach can still find them by
        searching.
      </Text>
    </Screen>
  );
}
