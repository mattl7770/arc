import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import {
  Chip,
  FormField,
  ProblemLine,
  SaveButton,
  SaveFootnote,
} from '@/components/protocols/form-controls';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { rederiveMissionForDay } from '@/lib/db/repositories/mission-generate';
import {
  deleteProtocol,
  getCurrentVersion,
  getProtocol,
  reviseProtocol,
} from '@/lib/db/repositories/protocols';
import type { CheckoffMode, ProtocolType } from '@/lib/db/types';
import { syncReminderNotifications } from '@/lib/notifications/reminders';
import { parseProtocolContent } from '@/lib/protocols/content';
import { PROTOCOL_TYPES } from '@/lib/protocols/format';
import { useProtocol } from '@/hooks/use-protocols';

/**
 * What a protocol IS and how it is run — everything about it that is not the
 * plan.
 *
 * ## Why these left the editor
 *
 * The editor asked identity questions first: seven type chips and a description
 * the Coach never sees, all above the items, on a screen you open to change a
 * dose. None of them is a daily decision. Pausing — one bit, and not even a
 * version — walked the whole form past every item.
 *
 * So the editor keeps the plan and this sheet keeps the rest. It writes through
 * `reviseProtocol` with **`content: null`**, which is the branch that mints no
 * version: renaming a protocol is not a revision of it, and neither is turning
 * carry-over on. It draws all four identity fields, which is exactly why it can
 * call a function that always writes all four — the editor no longer can, and
 * that is the reason the two had to land together.
 *
 * ## The type chips, and what moves with them
 *
 * `protocols.type` does three things, none of them daily: it selects the
 * `log_entries.type` a generated row takes, which is **the category word on
 * every mission row and in the hero's tag**; it is what Sick mode drops; and it
 * shares its vocabulary with the Coach's `adjust_today`. Re-typing a Daily
 * routine as a Supplement stack therefore turns `ROUTINE` into `SUPPLEMENTS` on
 * every row it generates — **from tomorrow**, because the re-derive's kept-row
 * UPDATE writes `value` and `scheduled_time` only, never `type`. The sheet says
 * so in one line under the chips, and that consequence is the whole reason the
 * chips are settings rather than a control on the working screen.
 *
 * Conformed Set: a form, so **no block** — fields are recessed stock, groups
 * are named by a `SectionLabel` and separated by whitespace (form (b) of the
 * capture-surface rule). Accent budget exactly one: Save. Delete is neutral ink
 * at the foot, where an irreversible action belongs.
 */

export default function ProtocolSettingsScreen() {
  // A deep link can repeat the param (?id=a&id=b), which expo-router delivers
  // as string[] despite the generic — coerce so a malformed link degrades to
  // the "no longer exists" branch instead of throwing at the SQLite bind.
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  return <ProtocolSettings key={id ?? 'none'} id={id} />;
}

function ProtocolSettings({ id }: { id: string | undefined }) {
  const router = useRouter();
  const detail = useProtocol(id);

  // Seeded from the first read only, like every form here: a focus refresh must
  // never clobber an edit in progress.
  const [name, setName] = useState(detail?.protocol.name ?? '');
  const [description, setDescription] = useState(detail?.protocol.description ?? '');
  const [type, setType] = useState<ProtocolType>(detail?.protocol.type ?? 'daily_routine');
  const [active, setActive] = useState(detail ? detail.protocol.is_active === 1 : true);
  const [startedOn, setStartedOn] = useState(detail?.protocol.started_on ?? '');
  const [carryOver, setCarryOver] = useState(detail?.protocol.carry_over === 1);
  const [checkoffMode, setCheckoffMode] = useState<CheckoffMode>(
    detail?.protocol.checkoff_mode ?? 'strict'
  );
  // Re-entrancy guard: the screen stays touchable during the pop transition.
  const inFlight = useRef(false);

  if (!detail) {
    return (
      <Screen>
        <View className="pt-2">
          <StackHeader title="Settings" parent="Protocols" />
        </View>
        <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-muted">
          This protocol no longer exists.
        </Text>
      </Screen>
    );
  }

  const named = name.trim() !== '';
  const dateValid = startedOn.trim() === '' || /^\d{4}-\d{2}-\d{2}$/.test(startedOn.trim());
  const canSave = named && dateValid;
  const problem = !named
    ? 'A protocol needs a name.'
    : !dateValid
      ? 'A start date reads as YYYY-MM-DD.'
      : null;

  const save = () => {
    if (inFlight.current || !canSave) return;
    inFlight.current = true;
    const db = getDb();
    // THE RE-READ. Whether this protocol is phased decides whether the anchor
    // is written at all, and a Coach `update_protocol` approved while this
    // sheet is open can have added a phase. Read at save, not at mount.
    const protocol = getProtocol(db, detail.protocol.id);
    if (!protocol) {
      inFlight.current = false;
      Alert.alert('Not saved', 'This protocol no longer exists.');
      return;
    }
    const live = parseProtocolContent(getCurrentVersion(db, protocol.id)?.content ?? null);
    const phased = live.phases.length > 1;
    try {
      reviseProtocol(db, protocol.id, {
        name: name.trim(),
        type,
        description: description.trim() || null,
        active,
        // The branch that mints NO version. This screen changes nothing about
        // the plan, so it must leave the version history untouched.
        content: null,
        // Only a phased protocol names its own start: with one open-ended phase
        // the anchor changes nothing that lands on a day, and passing null
        // leaves whatever anchor the protocol already had rather than clearing
        // it — clearing would restart a titration on the next generation.
        startedOn: phased && startedOn.trim() !== '' ? startedOn.trim() : null,
        carryOver,
        checkoffMode,
      });
      // A save reaches TODAY, the same rule the full editor has followed since
      // 2026-08-25 and through the same diff a mode change uses: pausing pulls
      // this protocol's untouched rows off today, resuming puts them back, and
      // anything already done or skipped is preserved exactly.
      rederiveMissionForDay(db, todayISODate());
      // Pausing must also stop it buzzing the phone; resuming must start it
      // again. The sync cancels the whole schedule and rebuilds from the
      // current plan, so there is nothing per-item to remember to undo.
      void syncReminderNotifications(db);
      router.back();
    } catch (error) {
      // reviseProtocol is one transaction: nothing partial persisted.
      inFlight.current = false;
      console.warn('[protocols] settings save failed', error);
      Alert.alert('Save failed', 'Nothing was changed. Please try again.');
    }
  };

  const confirmDelete = () => {
    Alert.alert(
      'Delete this protocol?',
      'Its versions are deleted with it. Anything already logged keeps its history — entries stay, just unlinked.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            if (inFlight.current) return;
            inFlight.current = true;
            try {
              const db = getDb();
              deleteProtocol(db, detail.protocol.id);
              // A deleted protocol must stop putting rows on today, and must
              // stop buzzing the phone. Same diff, same rebuild.
              rederiveMissionForDay(db, todayISODate());
              void syncReminderNotifications(db);
              // Past the detail, which is now a protocol that no longer exists.
              // `navigate` returns to the hub already in the stack rather than
              // pushing a second copy of it.
              router.navigate('/protocols');
            } catch (error) {
              inFlight.current = false;
              console.warn('[protocols] delete failed', error);
              Alert.alert('Delete failed', 'Nothing was changed. Please try again.');
            }
          },
        },
      ]
    );
  };

  const phased = detail.content.phases.length > 1;

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Settings" parent={detail.protocol.name} />
      </View>

      <View className="mt-6">
        <SectionLabel label="Name" />
        <View className="mt-2">
          <FormField
            value={name}
            onChange={setName}
            placeholder="Morning stack"
            accessibilityLabel="Protocol name"
          />
        </View>
      </View>

      <View className="mt-7">
        <SectionLabel label="Description" />
        <View className="mt-2">
          <FormField
            value={description}
            onChange={setDescription}
            placeholder="What this is for"
            multiline
            accessibilityLabel="Protocol description"
          />
        </View>
      </View>

      <View className="mt-7">
        <SectionLabel label="Type" />
        <View className="mt-2 flex-row flex-wrap gap-2">
          {PROTOCOL_TYPES.map((option) => (
            <Chip
              key={option.type}
              label={option.label}
              on={type === option.type}
              onPress={() => setType(option.type)}
            />
          ))}
        </View>
        {/* The consequence, said once where the control is. */}
        <Text className="mt-1.5 font-serif text-[12px] leading-4 text-ink-muted">
          The type is the word each item wears on Today&rsquo;s Mission. Changing it applies from
          tomorrow.
        </Text>
      </View>

      <View className="mt-7">
        <SectionLabel label="Status" />
        <View className="mt-2 flex-row gap-2">
          {(
            [
              { label: 'Active', value: true },
              { label: 'Paused', value: false },
            ] as const
          ).map((option) => (
            <Chip
              key={option.label}
              label={option.label}
              on={active === option.value}
              onPress={() => setActive(option.value)}
            />
          ))}
        </View>
      </View>

      {/* The phase clock. Drawn only when there are phases to clock — with one
          open-ended phase the start date changes nothing that lands on a day,
          and a field that cannot matter is furniture. */}
      {phased ? (
        <View className="mt-7">
          <SectionLabel label="Phase 1 starts" />
          <View className="mt-2 w-40">
            <FormField
              value={startedOn}
              onChange={setStartedOn}
              placeholder="2026-09-01"
              keyboardType="numbers-and-punctuation"
              maxLength={10}
              mono
              accessibilityLabel="Start date"
            />
          </View>
        </View>
      ) : null}

      {/* Execution POLICY (0050). It writes the `protocols` row, never a
          version: turning carry-over on is not a revision of the plan, and a
          restore must bring back the plan and not the policy. */}
      <View className="mt-7">
        <SectionLabel label="If you miss it" />
        <View className="mt-2 flex-row gap-2">
          {(
            [
              { label: 'Stays until done', value: true },
              { label: 'Stays on its day', value: false },
            ] as const
          ).map((option) => (
            <Chip
              key={option.label}
              label={option.label}
              on={carryOver === option.value}
              onPress={() => setCarryOver(option.value)}
            />
          ))}
        </View>
        <Text className="mt-1.5 font-serif text-[12px] leading-4 text-ink-muted">
          A missed item is offered again for up to 7 days. The day you missed it still counts as a
          miss.
        </Text>
      </View>

      <View className="mt-7">
        <SectionLabel label="When you check it off" />
        <View className="mt-2 flex-row gap-2">
          {(
            [
              { label: 'Keep the schedule', value: 'strict' },
              { label: 'Count from when I did it', value: 'adjusting' },
            ] as const
          ).map((option) => (
            <Chip
              key={option.label}
              label={option.label}
              on={checkoffMode === option.value}
              onPress={() => setCheckoffMode(option.value)}
            />
          ))}
        </View>
        <Text className="mt-1.5 font-serif text-[12px] leading-4 text-ink-muted">
          Only changes items set to every N days.
        </Text>
      </View>

      <ProblemLine text={problem} />

      <SaveButton accessibilityLabel="Save settings" disabled={!canSave} onPress={save}>
        Save
      </SaveButton>

      {/* Nothing here writes a VERSION, but a save still reaches today: a
          pause pulls this protocol off it. Same sentence as every other form
          that does. */}
      <SaveFootnote />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Delete protocol"
        onPress={confirmDelete}
        className="mt-8 min-h-[44px] items-center justify-center rounded-btn active:bg-paper-dim">
        <Text className="font-label text-[13px] text-ink-secondary">Delete protocol</Text>
      </Pressable>
    </Screen>
  );
}
