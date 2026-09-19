import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import { CadenceControl } from '@/components/protocols/cadence-control';
import {
  Chip,
  FormField,
  normalizeTime,
  parseDays,
  ProblemLine,
  SaveButton,
  SaveFootnote,
} from '@/components/protocols/form-controls';
import { TimeControl } from '@/components/protocols/time-control';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { newId } from '@/lib/db/id';
import { rederiveMissionForDay } from '@/lib/db/repositories/mission-generate';
import {
  createProtocolWithVersion,
  deleteProtocol,
  reviseProtocol,
} from '@/lib/db/repositories/protocols';
import type { CheckoffMode, ProtocolType } from '@/lib/db/types';
import { syncReminderNotifications } from '@/lib/notifications/reminders';
import { normalizeContent, validateContent } from '@/lib/protocols/content';
import { PROTOCOL_TYPES } from '@/lib/protocols/format';
import type { Cadence, ProtocolContent } from '@/lib/protocols/types';
import { type ProtocolDetail, useProtocol } from '@/hooks/use-protocols';

/**
 * Protocol editor — create/edit, pushed from the Protocols hub.
 *
 * Versioning discipline: the identity fields (name, type, description, paused
 * state, start date) update the `protocols` row in place; the PHASES and their
 * ITEMS are the versioned content — saving writes a NEW immutable
 * `protocol_versions` row and moves the live pointer, unless the content is
 * unchanged (no no-op versions).
 *
 * **A save applies to TODAY.** After the version lands, this re-derives today's
 * mission through the same diff a mode change uses: untouched machine-made rows
 * follow the edit, and anything completed, skipped, partial or captured by hand
 * is preserved exactly. That is the owner's call of 2026-08-25, and it replaces
 * the old rule ("an edit made today shapes tomorrow's mission") that had to be
 * explained in fine print at the bottom of a list screen.
 *
 * ## What schema 2 added to this form, and what it deliberately did not
 *
 * Two things: a **cadence** per item, and **ordered phases**. Everything else
 * is as it was.
 *
 * The simple case must cost nothing. A new protocol opens as ONE open-ended
 * phase with no phase chrome at all — no phase header, no length field, no
 * start date — so "creatine, daily" is still a name and a title. Phase controls
 * appear only once a second phase exists, which is the only point at which they
 * carry information. Cadence is one collapsed row per item that STATES the
 * cadence in words; it opens to the controls on a tap, so nothing is hidden and
 * the default costs one line rather than four chips.
 *
 * There is **no wizard**. The Conformed Set has no vocabulary for one, and a
 * protocol is a document being drafted, not a flow being completed.
 *
 * Conformed Set treatment: every field is **recessed stock** (a capture surface
 * is a well — paper-dim on a paper-deep edge, square) and NOTHING on this screen
 * is boxed. This whole screen is a form, and a form is controls, not content —
 * form (b) of the capture-surface rule in src/components/ui/block.tsx: a group
 * of fields carries no block at all, is named by a `SectionLabel`, and is
 * separated from its neighbours by whitespace.
 *
 * The items used to sit inside a `<Block device="plate">` on the argument that
 * the item list is "the record being drafted". On hardware that read as boxes
 * stacked on boxes (owner, 2026-08-10, on the CREATE path specifically), and the
 * reading was right: a plate is `border-hairline` on RAISED paper-hi, every
 * field inside it is `border-paper-deep` on RECESSED paper-dim, so the block
 * drew a raised box whose entire contents were recessed boxes — the surface
 * inversion block.tsx exists to stop, pointing the other way.
 *
 * **This screen is the ONE de-plating of 2026-08-10 that survives.** The plate
 * rule that sweep invented — "no plate around one row or an empty state" — was
 * withdrawn and every other plate it removed has been restored (docs/decisions.md
 * §1a). This one stays off, and not because of that rule: it stays off because
 * of the standing one, **devices never nest**, and because the owner reported
 * this exact screen as "boxes on top of other boxes". Do not restore it, and do
 * not cite it as precedent for de-plating anything that is not a form.
 *
 * Accent budget: exactly one — Save. The type chips, the status chips, the
 * cadence chips, "Add item", "Add a phase" and "Delete protocol" are all
 * neutral ink. Version numbers are measured values, so they are set in mono.
 */

/** One item row under edit. `key` is a mount-local id for React lists only. */
type EditItem = {
  key: number;
  /**
   * The stored item id, carried through a save so the version diff and the
   * quota counter still recognise this item afterwards. Empty on a row the user
   * just added; minted at save, where a `db` is in hand.
   */
  id: string;
  title: string;
  time: string;
  dose: string;
  /** Not edited here (Coach territory) — carried so a save never drops it. */
  notes: string;
  cadence: Cadence;
  /** Whether this item asks the OS for a notification at its time (C10). */
  remind: boolean;
};

/** One phase under edit. `days` is text so the field can be empty = open-ended. */
type EditPhase = {
  key: number;
  id: string;
  title: string;
  days: string;
  items: EditItem[];
};

const DAILY: Cadence = { kind: 'daily' };

function blankItem(key: number): EditItem {
  return { key, id: '', title: '', time: '', dose: '', notes: '', cadence: DAILY, remind: false };
}

function initialPhases(detail: ProtocolDetail | null): EditPhase[] {
  if (!detail) return [{ key: 0, id: '', title: '', days: '', items: [blankItem(1)] }];
  let key = 100;
  return detail.content.phases.map((phase, p) => ({
    key: p,
    id: phase.id,
    title: phase.title ?? '',
    days: phase.duration_days === null ? '' : String(phase.duration_days),
    items:
      phase.items.length === 0
        ? [blankItem(key++)]
        : phase.items.map((it) => ({
            key: key++,
            id: it.id,
            title: it.title,
            time: it.scheduled_time ?? '',
            dose: it.dose ?? '',
            notes: it.notes ?? '',
            cadence: it.cadence,
            remind: it.remind,
          })),
  }));
}

/** "2026-08-25" and nothing else. Blank is not a date; the caller decides. */
function isDate(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(text.trim());
}

export default function ProtocolEditScreen() {
  // A deep link can repeat the param (?id=a&id=b) and expo-router then delivers
  // string[] despite the generic — coerce so a malformed link degrades to the
  // "no longer exists" branch instead of throwing at the SQLite bind.
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  // key remounts the form if this mounted instance is ever re-targeted at a
  // different protocol (router.navigate / a deep link while open), so the
  // fields reseed instead of saving protocol A's form over protocol B.
  return <ProtocolEditor key={id ?? 'new'} id={id} />;
}

function ProtocolEditor({ id }: { id: string | undefined }) {
  const router = useRouter();
  const detail = useProtocol(id);
  const editing = id != null;

  const [name, setName] = useState(detail?.protocol.name ?? '');
  const [type, setType] = useState<ProtocolType>(detail?.protocol.type ?? 'daily_routine');
  const [description, setDescription] = useState(detail?.protocol.description ?? '');
  const [active, setActiveState] = useState(detail ? detail.protocol.is_active === 1 : true);
  const [phases, setPhases] = useState<EditPhase[]>(() => initialPhases(detail));
  const [startedOn, setStartedOn] = useState(detail?.protocol.started_on ?? todayISODate());
  // Execution policy (0050). It lives on the protocols ROW, not in the version,
  // so changing it writes no revision — see the migration header.
  const [carryOver, setCarryOver] = useState(detail?.protocol.carry_over === 1);
  const [checkoffMode, setCheckoffMode] = useState<CheckoffMode>(
    detail?.protocol.checkoff_mode ?? 'strict'
  );
  const [changeNotes, setChangeNotes] = useState('');
  const nextKey = useRef(1000);
  // Re-entrancy guard: the screen stays touchable during the pop transition,
  // and a double-tap would otherwise run the whole save twice (duplicate
  // protocol / duplicate version). Reset only on failure so a retry can save.
  const inFlight = useRef(false);

  const nextVersion = (detail?.version?.version_number ?? 0) + 1;
  const phased = phases.length > 1;

  const takeKey = () => {
    const key = nextKey.current;
    nextKey.current += 1;
    return key;
  };

  // Items with a blank title are dropped at save; a titled item may leave its
  // time blank, but a typed time must read as a real clock time.
  const timesValid = phases.every((phase) =>
    phase.items.every(
      (it) => it.title.trim() === '' || it.time.trim() === '' || normalizeTime(it.time) !== null
    )
  );
  // Every phase but the last needs a length. The last may be open-ended, which
  // is what a protocol that simply runs looks like.
  const lengthsValid = phases.every(
    (phase, index) => index === phases.length - 1 || parseDays(phase.days) !== null
  );
  const startValid = !phased || isDate(startedOn);
  const canSave = name.trim() !== '' && timesValid && lengthsValid && startValid;
  const problem = !timesValid
    ? 'Times read as HH:MM, e.g. 07:30 — or leave them blank.'
    : !lengthsValid
      ? 'Every phase but the last needs a length in whole days.'
      : !startValid
        ? 'The start date reads as YYYY-MM-DD, e.g. 2026-09-01.'
        : null;

  const patchPhase = (key: number, patch: Partial<Omit<EditPhase, 'key'>>) =>
    setPhases((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  const addItem = (phaseKey: number) =>
    setPhases((prev) =>
      prev.map((p) => (p.key === phaseKey ? { ...p, items: [...p.items, blankItem(takeKey())] } : p))
    );

  const updateItem = (phaseKey: number, itemKey: number, patch: Partial<Omit<EditItem, 'key'>>) =>
    setPhases((prev) =>
      prev.map((p) =>
        p.key === phaseKey
          ? { ...p, items: p.items.map((it) => (it.key === itemKey ? { ...it, ...patch } : it)) }
          : p
      )
    );

  const removeItem = (phaseKey: number, itemKey: number) =>
    setPhases((prev) =>
      prev.map((p) =>
        p.key === phaseKey ? { ...p, items: p.items.filter((it) => it.key !== itemKey) } : p
      )
    );

  /**
   * Adding a phase gives the phase BEFORE it a length, because an open-ended
   * phase in the middle would make everything after it unreachable — the one
   * rule `validateContent` refuses outright. Four weeks is the shape of nearly
   * every titration and is the least surprising number to start from.
   */
  const addPhase = () =>
    setPhases((prev) => [
      ...prev.map((p, i) =>
        i === prev.length - 1 && parseDays(p.days) === null ? { ...p, days: '28' } : p
      ),
      { key: takeKey(), id: '', title: '', days: '', items: [blankItem(takeKey())] },
    ]);

  const removePhase = (key: number) =>
    setPhases((prev) => (prev.length <= 1 ? prev : prev.filter((p) => p.key !== key)));

  const save = () => {
    if (inFlight.current || !canSave) return;
    inFlight.current = true;
    const db = getDb();
    const content: ProtocolContent = normalizeContent({
      phases: phases.map((phase, index) => ({
        // Minted here, not at "Add phase": a `db` is in hand at save and
        // nowhere else on this screen, and an id only has to be stable from the
        // moment it is stored.
        id: phase.id || newId(db),
        title: phase.title.trim() || null,
        // A blank length on the LAST phase means open-ended; every earlier one
        // is validated above, so a parse failure cannot reach storage.
        duration_days: index === phases.length - 1 ? parseDays(phase.days) : parseDays(phase.days),
        items: phase.items
          .filter((it) => it.title.trim() !== '')
          .map((it) => ({
            id: it.id || newId(db),
            title: it.title,
            scheduled_time: it.time.trim() === '' ? null : normalizeTime(it.time),
            dose: it.dose,
            notes: it.notes,
            cadence: it.cadence,
            remind: it.remind,
          })),
      })),
    });
    // The same gate the Coach's tool passes through, so a document the model
    // could not write cannot be hand-authored either.
    const invalid = validateContent(content);
    if (invalid) {
      inFlight.current = false;
      Alert.alert('Not saved', invalid);
      return;
    }
    try {
      if (detail) {
        // normalizeContent gives both sides one canonical shape, so a plain
        // string compare detects "nothing changed" — no no-op versions. Typed
        // change notes force a version anyway: they're user data, and skipping
        // would silently discard them.
        const unchanged =
          detail.version !== null &&
          changeNotes.trim() === '' &&
          JSON.stringify(content) === JSON.stringify(detail.content);
        reviseProtocol(db, detail.protocol.id, {
          name: name.trim(),
          type,
          description: description.trim() || null,
          active,
          content: unchanged ? null : content,
          // Only a phased protocol writes a start date: with one open-ended
          // phase the anchor changes nothing that lands on a day, and passing
          // null leaves whatever anchor the protocol already had.
          startedOn: phased ? startedOn.trim() : null,
          carryOver,
          checkoffMode,
          changeNotes: changeNotes.trim() || null,
        });
      } else {
        createProtocolWithVersion(
          db,
          {
            name: name.trim(),
            type,
            description: description.trim() || null,
            // Only a phased protocol names its own start; an unphased one is
            // anchored by the first generation, which the save triggers below.
            startedOn: phased ? startedOn.trim() : null,
          },
          content
        );
      }
      // The edit lands on TODAY (owner call, 2026-08-25), through the same diff
      // a mode change uses: untouched machine-made rows follow the new content,
      // and anything completed / skipped / partial / ad-hoc is preserved.
      rederiveMissionForDay(db, todayISODate());
      // …and the OS schedule follows the plan (C10). This is what cancels the
      // notification of an item the edit just removed, retimed, or turned the
      // reminder off for: the sync cancels everything and rebuilds from the new
      // plan, so there is nothing per-item to remember to undo.
      void syncReminderNotifications(db);
      router.back();
    } catch (error) {
      // Atomic writes: nothing partial persisted. Keep the form, say so, and
      // let the user retry.
      inFlight.current = false;
      console.warn('[protocols] save failed', error);
      Alert.alert('Save failed', 'Nothing was changed. Please try again.');
    }
  };

  const confirmDelete = () => {
    if (!detail) return;
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
              // A deleted protocol must stop buzzing the phone. Same rebuild.
              void syncReminderNotifications(db);
              router.back();
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

  // Pushed with an id that no longer resolves (deleted elsewhere) — say so.
  if (editing && !detail) {
    return (
      <Screen>
        <View className="pt-2">
          <StackHeader title="Edit Protocol" />
        </View>
        <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-muted">
          This protocol no longer exists.
        </Text>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title={editing ? 'Edit Protocol' : 'New Protocol'} />
      </View>

      {/* Identity — lives on the protocol row, not in the version. */}
      <View className="mt-3">
        <SectionLabel label="Protocol" />
        <View className="mt-2">
          <FormField
            value={name}
            onChange={setName}
            placeholder="e.g. Morning stack"
            accessibilityLabel="Protocol name"
          />
        </View>
        <View className="mt-3">
          <FormField
            value={description}
            onChange={setDescription}
            placeholder="What it's for (optional)"
            multiline
            accessibilityLabel="Protocol description"
          />
        </View>
      </View>

      <View className="mt-8">
        <SectionLabel label="Type" />
        <View className="mt-2 flex-row flex-wrap gap-2">
          {PROTOCOL_TYPES.map((t) => (
            <Chip
              key={t.type}
              label={t.label}
              on={type === t.type}
              onPress={() => setType(t.type)}
            />
          ))}
        </View>
      </View>

      {/* The versioned content — every save of these becomes a new version.
          No plate and no rules: a form is controls, and one item is separated
          from the next by air (the gap between items is deliberately wider than
          the gap between the rows WITHIN an item, which is what groups them). */}
      {phases.map((phase, phaseIndex) => (
        <View key={phase.key} className="mt-8">
          {/* No tally on the items label on purpose: blank rows are dropped at
              save, so a count of the rows on screen would not be the count that
              gets written. */}
          <SectionLabel
            label={phased ? `Phase ${phaseIndex + 1}` : 'Items'}
            note={phased && phaseIndex === phases.length - 1 ? 'runs on' : undefined}
          />

          {/* Phase chrome exists only once there is more than one phase. With a
              single phase there is nothing to name and nothing to time, and the
              controls would be furniture on the common case. */}
          {phased ? (
            <View className="mt-2 flex-row items-center gap-2">
              <FormField
                value={phase.title}
                onChange={(title) => patchPhase(phase.key, { title })}
                placeholder={phaseIndex === 0 ? 'e.g. Loading' : 'e.g. Maintenance'}
                fill
                accessibilityLabel={`Phase ${phaseIndex + 1} name`}
              />
              <View className="w-20">
                <FormField
                  value={phase.days}
                  onChange={(days) => patchPhase(phase.key, { days })}
                  placeholder="28"
                  keyboardType="number-pad"
                  maxLength={4}
                  mono
                  accessibilityLabel={`Phase ${phaseIndex + 1} length in days`}
                />
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove phase ${phaseIndex + 1}`}
                onPress={() => removePhase(phase.key)}
                className="h-11 w-11 items-center justify-center rounded-btn active:bg-paper-dim">
                <Ionicons name="close" size={18} color={palette.inkMuted} />
              </Pressable>
            </View>
          ) : null}

          {phase.items.map((it, index) => (
            <View key={it.key} className={index === 0 && !phased ? 'mt-2' : 'mt-5'}>
              <View className="flex-row items-center gap-2">
                {/* `fill` because this shares a row with the remove button. */}
                <FormField
                  value={it.title}
                  onChange={(title) => updateItem(phase.key, it.key, { title })}
                  placeholder="e.g. Creatine"
                  fill
                  accessibilityLabel="Item title"
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Remove item"
                  onPress={() => removeItem(phase.key, it.key)}
                  className="h-11 w-11 items-center justify-center rounded-btn active:bg-paper-dim">
                  <Ionicons name="close" size={18} color={palette.inkMuted} />
                </Pressable>
              </View>
              {/* The dose now takes the whole width: the time moved into its
                  own collapsed control below, beside the cadence, so an item
                  reads title → dose → when → how often. No `fill` here — this
                  is a child of a COLUMN, and `flex-1` in a column is what drew
                  boxes over other boxes (see FormField). */}
              <View className="mt-2">
                <FormField
                  value={it.dose}
                  onChange={(dose) => updateItem(phase.key, it.key, { dose })}
                  placeholder="Dose or note — 5 g, with food…"
                  accessibilityLabel="Item dose or note"
                />
              </View>
              <TimeControl
                time={it.time}
                remind={it.remind}
                itemLabel={it.title.trim() || 'this item'}
                onChange={(next) => updateItem(phase.key, it.key, next)}
              />
              <CadenceControl
                cadence={it.cadence}
                itemLabel={it.title.trim() || 'this item'}
                onChange={(cadence) => updateItem(phase.key, it.key, { cadence })}
              />
            </View>
          ))}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={phased ? `Add item to phase ${phaseIndex + 1}` : 'Add item'}
            onPress={() => addItem(phase.key)}
            className="mt-5 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline active:bg-paper-dim">
            <Ionicons name="add" size={17} color={palette.inkSecondary} />
            <Text className="font-label text-[13px] font-medium text-ink">Add item</Text>
          </Pressable>
        </View>
      ))}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add a phase"
        onPress={addPhase}
        className="mt-4 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn active:bg-paper-dim">
        <Ionicons name="git-commit-outline" size={16} color={palette.inkSecondary} />
        <Text className="font-label text-[13px] text-ink-secondary">Add a phase</Text>
      </Pressable>

      {/* The phase clock. Drawn only when there are phases to clock — with one
          open-ended phase the start date changes nothing that lands on a day,
          and a field that cannot matter is furniture. */}
      {phased ? (
        <View className="mt-8">
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

      {editing ? (
        <>
          {/* Paused protocols keep their versions; the generator skips them. */}
          <View className="mt-8">
            <SectionLabel label="Status" />
            <View className="mt-2 flex-row gap-2">
              {(
                [
                  { label: 'Active', value: true },
                  { label: 'Paused', value: false },
                ] as const
              ).map((s) => (
                <Chip
                  key={s.label}
                  label={s.label}
                  on={active === s.value}
                  onPress={() => setActiveState(s.value)}
                />
              ))}
            </View>
          </View>

          {/* Execution POLICY (0050), between the protocol's other identity
              facts and the version note — because that is what it is. It writes
              the `protocols` row, never a version: turning carry-over on is not
              a revision of the plan, and a restore must bring back the plan and
              not the policy (see db/migrations/0050_protocol_carry_over.sql).

              Only on the EDIT path, like Status and the change notes. A policy
              for running a protocol you have not run yet is furniture on the
              create form, which opens as one open-ended phase for a reason.

              A form carries no block: a `SectionLabel`, the controls, air
              (src/components/ui/block.tsx, form (b)). Both pairs are the
              neutral `Chip` — the Status pair's exact shape — so the accent
              budget is unchanged at exactly one, Save. */}
          <View className="mt-8">
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
              A missed item is offered again for up to 7 days. The day you missed it still counts
              as a miss.
            </Text>
          </View>

          <View className="mt-8">
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

          <View className="mt-8">
            {/* The version number is a measured value — mono, in the note slot. */}
            <SectionLabel label="What changed (optional)" note={`→ v${nextVersion}`} />
            <View className="mt-2">
              <FormField
                value={changeNotes}
                onChange={setChangeNotes}
                placeholder="Why this revision — dropped X, moved Y earlier…"
                multiline
                accessibilityLabel="Change notes"
              />
            </View>
          </View>
        </>
      ) : null}

      <ProblemLine text={problem} />

      {/* The one accent on this screen, and the same button the per-item editor
          and the settings sheet draw (src/components/protocols/form-controls). */}
      <SaveButton
        accessibilityLabel={editing ? 'Save protocol' : 'Create protocol'}
        disabled={!canSave}
        onPress={save}>
        {editing ? (
          <>
            {'Save as '}
            <Text className="font-mono">{`v${nextVersion}`}</Text>
          </>
        ) : (
          'Create protocol'
        )}
      </SaveButton>

      {/* Where a save lands. One sentence, because it is now one rule — the
          asymmetry that needed explaining (mode changes re-derived, protocol
          edits did not) is gone. */}
      <SaveFootnote />

      {editing ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Delete protocol"
          onPress={confirmDelete}
          className="mt-6 min-h-[44px] items-center justify-center rounded-btn active:bg-paper-dim">
          <Text className="font-label text-[13px] text-ink-secondary">Delete protocol</Text>
        </Pressable>
      ) : null}
    </Screen>
  );
}
