import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Pressable, Text, TextInput, type TextInputProps, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import {
  createProtocolWithVersion,
  deleteProtocol,
  reviseProtocol,
} from '@/lib/db/repositories/protocols';
import type { ProtocolType } from '@/lib/db/types';
import { normalizeItem } from '@/lib/protocols/content';
import { PROTOCOL_TYPES } from '@/lib/protocols/format';
import type { ProtocolContent } from '@/lib/protocols/types';
import { type ProtocolDetail, useProtocol } from '@/hooks/use-protocols';

/**
 * Protocol editor — create/edit, pushed from the Protocols list.
 *
 * Versioning discipline: the identity fields (name, type, description, paused
 * state) update the `protocols` row in place; the ITEMS are the versioned
 * content — saving writes a NEW immutable `protocol_versions` row and moves
 * the live pointer, unless the items are unchanged (no no-op versions).
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
 * inversion block.tsx exists to stop, pointing the other way. The rules BETWEEN
 * the item rows went with it: a rule separates rows inside an enclosure, and
 * with the enclosure gone they are strokes floating on the sheet, which is the
 * artefact reading that cost the grid and margin devices their marks.
 *
 * The `<Block>` nesting guard could not catch this: the inner surfaces are plain
 * `TextInput`s, not blocks, so nothing was nested as far as the runtime could
 * see. capture.tsx, symptom.tsx, screening-form.tsx and appointment-form.tsx are
 * the reference form and always were.
 *
 * **This screen is the ONE de-plating of 2026-08-10 that survives.** The plate
 * rule that sweep invented — "no plate around one row or an empty state" — was
 * withdrawn and every other plate it removed has been restored (docs/decisions.md
 * §1a). This one stays off, and not because of that rule: it stays off because
 * of the standing one, **devices never nest**, and because the owner reported
 * this exact screen as "boxes on top of other boxes". Do not restore it, and do
 * not cite it as precedent for de-plating anything that is not a form.
 *
 * Accent budget: exactly one — Save. It is the single primary action on the
 * screen and the one sanctioned accent here; the type chips, the status chips,
 * "Add item" and "Delete protocol" are all neutral ink. The version number is a
 * measured value, so it is set in mono wherever it appears.
 */

/** One item row under edit. `key` is a mount-local id for React lists only. */
type EditItem = {
  key: number;
  title: string;
  time: string;
  dose: string;
  /** Not edited here yet (Coach territory) — carried through so a saved
   *  version never silently drops notes an earlier author wrote. */
  notes: string;
};

function blankItem(key: number): EditItem {
  return { key, title: '', time: '', dose: '', notes: '' };
}

function initialItems(detail: ProtocolDetail | null): EditItem[] {
  if (!detail || detail.content.items.length === 0) return [blankItem(0)];
  return detail.content.items.map((it, i) => ({
    key: i,
    title: it.title,
    time: it.scheduled_time ?? '',
    dose: it.dose ?? '',
    notes: it.notes ?? '',
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

/** A neutral selection chip — the label voice, square-ish, no hue. */
function Chip({
  label,
  on,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      className={`min-h-[44px] justify-center rounded-btn border px-3 py-2 active:bg-paper-dim ${
        on ? 'border-ink bg-paper-dim' : 'border-hairline bg-paper-hi'
      }`}>
      <Text
        className={`font-label text-[13px] ${on ? 'font-semibold text-ink' : 'text-ink-secondary'}`}>
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
 * — and four of this screen's six fields are children of a **column**, not a
 * row: the protocol name, the description, the time (inside a `w-24`) and the
 * change note.
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
 * collapse is total. It survived the 2026-08-10 pass because that pass read the
 * complaint as a *surface* problem and answered it by removing the plate around
 * the item list. The plate was a real second issue (a raised box full of
 * recessed boxes, and it stays off — see the screen docblock above); it was
 * simply not this one. Nothing about de-plating could fix a collapsed wrapper.
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
      maxLength={maxLength}
      multiline={multiline}
      accessibilityLabel={accessibilityLabel}
      className={`border border-paper-deep bg-paper-dim px-3.5 py-3 text-[15px] text-ink ${
        fill ? 'flex-1' : ''
      } ${mono ? 'font-mono' : ''} ${multiline ? 'max-h-28 min-h-[64px] leading-5' : ''}`}
    />
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
  const [items, setItems] = useState<EditItem[]>(() => initialItems(detail));
  const [changeNotes, setChangeNotes] = useState('');
  const nextKey = useRef(items.length);
  // Re-entrancy guard: the screen stays touchable during the pop transition,
  // and a double-tap would otherwise run the whole save twice (duplicate
  // protocol / duplicate version). Reset only on failure so a retry can save.
  const inFlight = useRef(false);

  const nextVersion = (detail?.version?.version_number ?? 0) + 1;

  // Items with a blank title are dropped at save; a titled item may leave its
  // time blank, but a typed time must read as a real clock time.
  const timesValid = items.every(
    (it) => it.title.trim() === '' || it.time.trim() === '' || normalizeTime(it.time) !== null
  );
  const canSave = name.trim() !== '' && timesValid;
  const problem = timesValid ? null : 'Times read as HH:MM, e.g. 07:30 — or leave them blank.';

  const addItem = () => {
    const key = nextKey.current;
    nextKey.current += 1;
    setItems((prev) => [...prev, blankItem(key)]);
  };

  const updateItem = (key: number, patch: Partial<Omit<EditItem, 'key'>>) => {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  };

  const removeItem = (key: number) => {
    setItems((prev) => prev.filter((it) => it.key !== key));
  };

  const save = () => {
    if (inFlight.current || !canSave) return;
    inFlight.current = true;
    const content: ProtocolContent = {
      items: items
        .filter((it) => it.title.trim() !== '')
        .map((it) =>
          normalizeItem({
            title: it.title,
            scheduled_time: it.time.trim() === '' ? null : normalizeTime(it.time),
            dose: it.dose,
            notes: it.notes,
          })
        ),
    };
    try {
      const db = getDb();
      if (detail) {
        // normalizeItem gives both sides one canonical shape, so a plain
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
          changeNotes: changeNotes.trim() || null,
        });
      } else {
        createProtocolWithVersion(
          db,
          { name: name.trim(), type, description: description.trim() || null },
          content
        );
      }
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
              deleteProtocol(getDb(), detail.protocol.id);
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
          the gap between the two rows WITHIN an item, which is what groups
          them). */}
      <View className="mt-8">
        {/* No tally here on purpose: blank rows are dropped at save, so a count
            of the rows on screen would not be the count that gets written. */}
        <SectionLabel label="Items" />
        {items.map((it, index) => (
          <View key={it.key} className={index === 0 ? 'mt-2' : 'mt-5'}>
            <View className="flex-row items-center gap-2">
              {/* `fill` because this shares a row with the remove button. */}
              <FormField
                value={it.title}
                onChange={(title) => updateItem(it.key, { title })}
                placeholder="e.g. Creatine"
                fill
                accessibilityLabel="Item title"
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove item"
                onPress={() => removeItem(it.key)}
                className="h-11 w-11 items-center justify-center rounded-btn active:bg-paper-dim">
                <Ionicons name="close" size={18} color={palette.inkMuted} />
              </Pressable>
            </View>
            <View className="mt-2 flex-row gap-2">
              <View className="w-24">
                <FormField
                  value={it.time}
                  onChange={(time) => updateItem(it.key, { time })}
                  placeholder="07:30"
                  keyboardType="numbers-and-punctuation"
                  maxLength={5}
                  mono
                  accessibilityLabel="Item time"
                />
              </View>
              {/* `fill` because this shares a row with the fixed-width time. */}
              <FormField
                value={it.dose}
                onChange={(dose) => updateItem(it.key, { dose })}
                placeholder="Dose or note — 5 g, with food…"
                fill
                accessibilityLabel="Item dose or note"
              />
            </View>
          </View>
        ))}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add item"
          onPress={addItem}
          className="mt-5 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline active:bg-paper-dim">
          <Ionicons name="add" size={17} color={palette.inkSecondary} />
          <Text className="font-label text-[13px] font-medium text-ink">Add item</Text>
        </Pressable>
      </View>

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

          {/* The way into the history the versioning has been writing all
              along (app/protocol-versions.tsx). Neutral ink, not accent: Save
              is the one accent on this screen, and a link to a read-only
              record is not a primary action. Drawn only once a version exists
              — a protocol with nothing saved has no history to open, and a row
              that leads to an authored "no versions yet" is a wasted tap. */}
          {detail?.version ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Version history, currently at version ${detail.version.version_number}`}
              onPress={() =>
                router.push({
                  pathname: '/protocol-versions',
                  params: { id: detail.protocol.id },
                })
              }
              className="mt-8 min-h-[44px] flex-row items-center gap-2.5 rounded-btn border border-hairline px-3.5 py-3 active:bg-paper-dim">
              <Ionicons name="time-outline" size={17} color={palette.inkSecondary} />
              <Text className="flex-1 font-label text-[13px] font-medium text-ink">
                Version history
              </Text>
              {/* The live version number is a measurement — mono. */}
              <Text className="font-mono text-[11px] text-ink-muted">
                {`now v${detail.version.version_number}`}
              </Text>
              <Ionicons name="chevron-forward" size={15} color={palette.inkMuted} />
            </Pressable>
          ) : null}

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
