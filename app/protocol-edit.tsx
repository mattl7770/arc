import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Pressable, Text, TextInput, type TextInputProps, View } from 'react-native';

import { keypadDoneKey } from '@/components/ui/keyboard';
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
import { WEEKDAY_LABELS } from '@/lib/protocols/cadence';
import { normalizeContent, validateContent } from '@/lib/protocols/content';
import { cadenceLabel, PROTOCOL_TYPES } from '@/lib/protocols/format';
import type { Cadence, CadenceKind, ProtocolContent } from '@/lib/protocols/types';
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

/** "8:05" / "08:05" → "08:05"; null if it isn't a real clock time. */
function normalizeTime(text: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${m[2]}`;
}

/** A whole number of days ≥ 1, or null for "not a length". */
function parseDays(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= 1 ? n : null;
}

/** "2026-08-25" and nothing else. Blank is not a date; the caller decides. */
function isDate(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(text.trim());
}

/** A neutral selection chip — the label voice, square-ish, no hue. */
function Chip({
  label,
  on,
  onPress,
  accessibilityLabel,
  compact,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  /** Tighter padding for the cadence controls, where seven sit on one row. */
  compact?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      className={`min-h-[44px] justify-center rounded-btn border py-2 active:bg-paper-dim ${
        compact ? 'px-2' : 'px-3'
      } ${on ? 'border-ink bg-paper-dim' : 'border-hairline bg-paper-hi'}`}>
      <Text
        className={`font-label ${compact ? 'text-[12px]' : 'text-[13px]'} ${
          on ? 'font-semibold text-ink' : 'text-ink-secondary'
        }`}>
        {label}
      </Text>
    </Pressable>
  );
}

type FieldProps = {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  keyboardType?: TextInputProps['keyboardType'];
  mono?: boolean;
  maxLength?: number;
  multiline?: boolean;
  /**
   * Set ONLY when this field is a child of a `flex-row` and should take the
   * remaining width. See the note on {@link FormField} — passing it in a column
   * is the bug that made this screen draw boxes over other boxes.
   */
  fill?: boolean;
  accessibilityLabel: string;
};

/**
 * One recessed field.
 *
 * ## `flex-1` in a column is what drew "boxes covering other boxes"
 *
 * Every field used to be wrapped in `<View className="flex-1">`, unconditionally
 * — and most of this screen's fields are children of a **column**, not a row.
 *
 * In a column container the main axis is vertical, so `flex-1` resolves to
 * `flexBasis: 0%` **on the height**. The parent (`<View className="mt-2">`) has
 * no height of its own and sizes to its content, so there is no free space for
 * `flexGrow` to claim, and the wrapper lays out at **zero height**. Views do not
 * clip by default, so the `TextInput` inside it still drew at its natural
 * height — on top of whatever section came next. The description field is the
 * worst case, because it is `multiline` with a 64pt floor: 64pt of bordered
 * input painted over the block below it.
 *
 * That is the report, exactly: boxes covering other boxes, on the New Protocol
 * screen specifically — which is the path where the fields are empty and the
 * collapse is total.
 *
 * So the flex is opt-in and named for what it is: `fill` belongs to a field
 * sharing a **row**, and nowhere else. The wrapper view is gone entirely — a
 * `TextInput` takes the flex directly, one view less per field.
 */
function FormField({
  value,
  onChange,
  placeholder,
  keyboardType,
  mono,
  maxLength,
  multiline,
  fill,
  accessibilityLabel,
}: FieldProps) {
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={palette.inkMuted}
      keyboardType={keyboardType}
      returnKeyType={keypadDoneKey(keyboardType)}
      maxLength={maxLength}
      multiline={multiline}
      accessibilityLabel={accessibilityLabel}
      className={`border border-paper-deep bg-paper-dim px-3.5 py-3 text-[15px] text-ink ${
        fill ? 'flex-1' : ''
      } ${mono ? 'font-mono' : ''} ${multiline ? 'max-h-28 min-h-[64px] leading-5' : ''}`}
    />
  );
}

/**
 * Anchor times offered as one tap each (C9).
 *
 * Six, three hours apart across the waking day. They are deliberately round and
 * evenly spaced rather than tuned to any routine: a preset that guesses at the
 * user's morning would be wrong for most items and would read as advice. These
 * are a coarse jump to the right part of the day; the field beside them is how
 * you say 07:45.
 */
const TIME_PRESETS = ['07:00', '09:00', '12:00', '15:00', '18:00', '21:00'] as const;

/**
 * When one item happens, and whether it nudges (C9 + C10).
 *
 * Collapsed to a single line that STATES the time, exactly like
 * {@link CadenceControl} one row below it — the two lines under an item read
 * "when" then "how often", which is the order the questions come in. A stack of
 * eight items would otherwise carry eight open time fields, and the common case
 * (no time at all) would cost as much room as the rare one.
 *
 * **Reused, not invented.** The typed field is the app's existing time entry —
 * mono, `numbers-and-punctuation`, five characters — as on the appointment form
 * and in the meal editor. That keyboard is a FULL keyboard and already carries
 * a return key, which is why it does not take `KEYPAD_DONE`; `FormField` derives
 * that from `keyboardType` so a field cannot get the rule half-right
 * (src/components/ui/keyboard.ts).
 *
 * **Clearing is a first-class action**, not a matter of selecting five
 * characters and deleting them on a phone: an untimed item is a normal thing to
 * want, and it sorts to the end of the day exactly as it always has
 * (src/lib/home/derive-mission.ts). Clearing also turns the reminder off,
 * because a notification with no moment to fire at is an intent the scheduler
 * can never honour — `normalizeItem` enforces the same thing at the storage
 * boundary, so the two cannot disagree.
 */
function TimeControl({
  time,
  remind,
  onChange,
  itemLabel,
}: {
  time: string;
  remind: boolean;
  onChange: (next: { time: string; remind: boolean }) => void;
  itemLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const normalized = normalizeTime(time);
  const timed = normalized !== null;
  const spoken = time.trim() === '' ? 'any time' : time;

  return (
    <View className="mt-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Time for ${itemLabel}: ${spoken}${
          remind ? ', reminder on' : ''
        }. ${open ? 'Hide options' : 'Change'}`}
        onPress={() => setOpen((shown) => !shown)}
        className="min-h-[44px] flex-row items-center gap-2 py-2 active:opacity-60">
        <Ionicons name="time-outline" size={15} color={palette.inkMuted} />
        <Text className="flex-1 text-[12px] text-ink-secondary">
          {/* A clock time is a measured value, so it is set in mono; "Any time"
              is a label, so it is not. */}
          {time.trim() === '' ? (
            <Text className="font-label">Any time</Text>
          ) : (
            <Text className="font-mono">{time}</Text>
          )}
          {remind ? <Text className="font-label">{'  ·  Reminder'}</Text> : null}
        </Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={13} color={palette.inkMuted} />
      </Pressable>

      {open ? (
        <View className="mt-1">
          <View className="flex-row flex-wrap gap-1.5">
            {TIME_PRESETS.map((preset) => (
              <Chip
                key={preset}
                label={preset}
                compact
                on={normalized === preset}
                onPress={() => onChange({ time: preset, remind })}
              />
            ))}
            <Chip
              label="Clear"
              compact
              on={false}
              accessibilityLabel="Clear the time"
              onPress={() => onChange({ time: '', remind: false })}
            />
          </View>

          <View className="mt-2 flex-row items-center gap-2">
            <View className="w-24">
              <FormField
                value={time}
                onChange={(next) => onChange({ time: next, remind })}
                placeholder="07:30"
                keyboardType="numbers-and-punctuation"
                maxLength={5}
                mono
                accessibilityLabel="Item time"
              />
            </View>
            {timed ? (
              <Chip
                label={remind ? 'Reminder on' : 'Remind me'}
                on={remind}
                accessibilityLabel={`Reminder at ${normalized} for ${itemLabel}${
                  remind ? ', on' : ', off'
                }`}
                onPress={() => onChange({ time, remind: !remind })}
              />
            ) : (
              /* Authored, never blank: the slot says why the control it would
                 otherwise hold is not here. */
              <Text className="flex-1 font-serif text-[12px] leading-4 text-ink-muted">
                Give it a time to set a reminder.
              </Text>
            )}
          </View>

          {remind ? (
            /* The same one-line device the quota control uses, and for the same
               reason: the control cannot state its own limits. Whether a phone
               alert actually fires is a runtime fact (the module in the build,
               permission granted, a moment still ahead) — see
               src/lib/notifications/reminders.ts — so this says what ARC will
               ASK for and promises nothing. */
            <Text className="mt-1.5 font-serif text-[11.5px] leading-4 text-ink-muted">
              iOS alerts at {normalized} on the days this lands, unless you have already ticked it.
              Notifications must be allowed for ARC.
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** The cadence kinds, in the order the control presents them. */
const CADENCE_KINDS: { kind: CadenceKind; label: string }[] = [
  { kind: 'daily', label: 'Every day' },
  { kind: 'weekdays', label: 'Certain days' },
  { kind: 'every_n_days', label: 'Every N days' },
  { kind: 'quota', label: 'N a week' },
];

/** Switching kind keeps a sensible default rather than an empty control. */
function cadenceOfKind(kind: CadenceKind, previous: Cadence): Cadence {
  switch (kind) {
    case 'daily':
      return { kind: 'daily' };
    case 'weekdays':
      return previous.kind === 'weekdays' ? previous : { kind: 'weekdays', days: [1, 3, 5] };
    case 'every_n_days':
      return previous.kind === 'every_n_days' ? previous : { kind: 'every_n_days', n: 2 };
    case 'quota':
      return previous.kind === 'quota' ? previous : { kind: 'quota', per_week: 3 };
  }
}

/**
 * How often one item comes round.
 *
 * Collapsed to a single label-voice line that STATES the cadence, so nothing is
 * hidden and the default — every day — costs one line rather than a row of
 * chips per item. A supplement stack of eight items would otherwise open on
 * thirty-two chips the user never touches.
 */
function CadenceControl({
  cadence,
  onChange,
  itemLabel,
}: {
  cadence: Cadence;
  onChange: (next: Cadence) => void;
  itemLabel: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <View className="mt-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Cadence for ${itemLabel}: ${cadenceLabel(cadence)}. ${
          open ? 'Hide options' : 'Change'
        }`}
        onPress={() => setOpen((shown) => !shown)}
        className="min-h-[44px] flex-row items-center gap-2 py-2 active:opacity-60">
        <Ionicons name="repeat-outline" size={15} color={palette.inkMuted} />
        <Text className="flex-1 font-label text-[12px] text-ink-secondary">
          {cadenceLabel(cadence)}
        </Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={13} color={palette.inkMuted} />
      </Pressable>

      {open ? (
        <View className="mt-1">
          <View className="flex-row flex-wrap gap-2">
            {CADENCE_KINDS.map((k) => (
              <Chip
                key={k.kind}
                label={k.label}
                compact
                on={cadence.kind === k.kind}
                onPress={() => onChange(cadenceOfKind(k.kind, cadence))}
              />
            ))}
          </View>

          {cadence.kind === 'weekdays' ? (
            <View className="mt-2 flex-row flex-wrap gap-1.5">
              {WEEKDAY_LABELS.map((label, index) => {
                const day = index + 1;
                const on = cadence.days.includes(day);
                return (
                  <Chip
                    key={label}
                    label={label}
                    compact
                    on={on}
                    accessibilityLabel={`${label}${on ? ', on' : ', off'}`}
                    onPress={() =>
                      onChange({
                        kind: 'weekdays',
                        days: (on
                          ? cadence.days.filter((d) => d !== day)
                          : [...cadence.days, day]
                        ).sort((a, b) => a - b),
                      })
                    }
                  />
                );
              })}
            </View>
          ) : null}

          {cadence.kind === 'every_n_days' ? (
            <View className="mt-2 flex-row items-center gap-2">
              <View className="w-20">
                <FormField
                  value={String(cadence.n)}
                  onChange={(text) => {
                    const n = parseDays(text);
                    onChange({ kind: 'every_n_days', n: n !== null && n >= 2 ? n : 2 });
                  }}
                  keyboardType="number-pad"
                  maxLength={3}
                  mono
                  accessibilityLabel="Every how many days"
                />
              </View>
              <Text className="font-label text-[12px] text-ink-secondary">days apart</Text>
            </View>
          ) : null}

          {cadence.kind === 'quota' ? (
            <View className="mt-2 flex-row items-center gap-2">
              <View className="w-20">
                <FormField
                  value={String(cadence.per_week)}
                  onChange={(text) => {
                    const n = parseDays(text);
                    onChange({ kind: 'quota', per_week: n !== null && n <= 7 ? n : 3 });
                  }}
                  keyboardType="number-pad"
                  maxLength={1}
                  mono
                  accessibilityLabel="How many times a week"
                />
              </View>
              {/* The whole point of a quota, said once where it is chosen: ARC
                  surfaces it until the week's count is met, and the user picks
                  which days. Without this the control reads like a weekday list
                  with the days left blank. */}
              <Text className="flex-1 font-label text-[12px] text-ink-secondary">
                times a week — any days
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
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

      {problem ? (
        <Text className="mt-4 font-serif text-[12px] leading-5 text-ink-muted">{problem}</Text>
      ) : null}

      {/* The one accent on this screen. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={editing ? 'Save protocol' : 'Create protocol'}
        accessibilityState={{ disabled: !canSave }}
        disabled={!canSave}
        onPress={save}
        className={`mt-6 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn py-3.5 ${
          canSave ? 'bg-pine active:opacity-70' : 'border border-hairline bg-paper-dim'
        }`}>
        <Ionicons
          name="git-branch-outline"
          size={18}
          color={canSave ? palette.pineOn : palette.inkMuted}
        />
        <Text
          className={`font-label text-[15px] font-semibold ${
            canSave ? 'text-pine-on' : 'text-ink-muted'
          }`}>
          {editing ? (
            <>
              {'Save as '}
              <Text className="font-mono">{`v${nextVersion}`}</Text>
            </>
          ) : (
            'Create protocol'
          )}
        </Text>
      </Pressable>

      {/* Where a save lands. One sentence, because it is now one rule — the
          asymmetry that needed explaining (mode changes re-derived, protocol
          edits did not) is gone. */}
      <Text className="mt-3 text-center font-serif text-[11.5px] leading-4 text-ink-muted">
        Saving updates today&rsquo;s mission. Anything already done or skipped stays as it is.
      </Text>

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
