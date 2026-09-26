import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import {
  Alert,
  type LayoutChangeEvent,
  Pressable,
  type ScrollView,
  Text,
  View,
} from 'react-native';

import { CadenceControl } from '@/components/protocols/cadence-control';
import {
  FormField,
  ProblemLine,
  SaveButton,
  SaveFootnote,
} from '@/components/protocols/form-controls';
import { TimeControl } from '@/components/protocols/time-control';
import { Chip } from '@/components/ui/chip';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { type ProtocolDetail, useProtocol } from '@/hooks/use-protocols';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { newId } from '@/lib/db/id';
import { rederiveMissionFromToday } from '@/lib/db/repositories/mission-generate';
import {
  createProtocolWithVersion,
  deleteProtocol,
  protocolFieldsOf,
  saveProtocolEdit,
} from '@/lib/db/repositories/protocols';
import type { CheckoffMode, ProtocolType } from '@/lib/db/types';
import { syncReminderNotifications } from '@/lib/notifications/reminders';
import { normalizeTime } from '@/lib/protocols/clock-time';
import { validateContent } from '@/lib/protocols/content';
import {
  blankItem,
  buildContent,
  type EditItem,
  type EditPhase,
  moved,
  moveToPhase,
  parseDays,
  seedPhases,
} from '@/lib/protocols/edit-form';
import { cadenceLabel, PROTOCOL_TYPES } from '@/lib/protocols/format';
import type { ProtocolFields } from '@/lib/protocols/rebase';
import type { ProtocolContent } from '@/lib/protocols/types';

/**
 * **The one protocol editor** — every fact about a protocol, in one form, which
 * opens at the item you came from.
 *
 * ## Why one form (the owner's choice, 2026-09-25)
 *
 * The 2026-09-19 re-cut split protocol editing across three forms: this one
 * (the create path, and structure on the edit path), a per-item editor
 * (`/protocol-item`) and a settings sheet (`/protocol-settings`). Two notes from
 * the device answered it — *"theres like so many protocol editing menus now, i
 * think we should compact"* and *"Having two settings menus for protocols is
 * confusing"* — and docs/spikes/protocol-menus-compact.md laid out three
 * shapes. He took **A: one editor**. Both other routes are gone; this form is
 * the only surface that writes a protocol's name, type, description, phases,
 * items, start date and policies, and *Phase 1 starts* appears on it once.
 *
 * ## How you reach it
 *
 *   - **Edit** in the protocol page's header — the page's one door to it;
 *   - **a Now row** on that page, and **Edit this item** on a mission row's
 *     sheet (`/mission-item`): `?item=<id>` opens with that item expanded and
 *     scrolled into view;
 *   - **Add an item** on the page: `?add=1` opens with a blank item added to
 *     the live phase, expanded;
 *   - **New protocol** on the hub: no id, the create path — the same form.
 *
 * Pausing is NOT here. It is a row on the protocol page with a confirmation
 * that says what leaves today (the owner's second answer), so this form never
 * writes `is_active` and a Save can never flip it back from a pause approved on
 * the Coach tab while the form was open.
 *
 * ## The items: one line each, opening in place
 *
 * Each item is one line — mono time · serif name · mono dose · label cadence,
 * the protocol page's own Now row — with ↑ ↓ × beside it. Tapping the line
 * opens that item's fields under it: name, dose, the why-line, time and
 * reminder, cadence, and (phased) which phase. One item is open at a time, so a
 * dose change is one line opened, not a scroll past every item's fields. The
 * why-line is editable here now; the old editor carried it through unseen.
 * Moving an item to another phase keeps its id (src/lib/protocols/edit-form.ts),
 * where it used to mean removing it and adding it again.
 *
 * ## The save: one transaction, only what changed, never over a moved version
 *
 * `saveProtocolEdit` (src/lib/db/repositories/protocols.ts) re-reads the row
 * and the live version inside one transaction and merges this form's changes
 * onto them (src/lib/protocols/rebase.ts). A version is written only when the
 * document or the note changed; a row field only when the form changed it. A
 * Coach edit approved while the form was open is kept; a change that collides
 * with it — the same item edited on both sides — refuses in one sentence,
 * writes nothing, and the form reloads on the protocol as it now is. Then, as
 * every protocol write does, today is re-derived and the reminders re-synced.
 *
 * The Save button says what it will do: *Save as v5* when the document or the
 * note changed, *Save* when only the name, type, start date or a policy did,
 * and it is inert when nothing did. *Create protocol* on the create path.
 *
 * ## Conformed Set
 *
 * A form, so **no block anywhere on it**: every field is recessed stock, named
 * by a `SectionLabel` and separated by whitespace (form (b) of the capture-
 * surface rule, src/components/ui/block.tsx). That is also what lets the time
 * wheel open inside an item: the wheel draws its own `field` device
 * (src/components/protocols/time-wheel.tsx), and a device must never open
 * inside another one. The owner reported this exact screen as "boxes on top of
 * other boxes" when its items sat in a plate (2026-08-10); do not put one back.
 *
 * Accent budget: exactly one — Save. The chips, ↑ ↓ ×, *Add item*, *Add a
 * phase* and *Delete protocol* are neutral ink. Version numbers and clock times
 * are measured values, so they are set in mono.
 */

/** "2026-08-25" and nothing else. Blank is not a date; the caller decides. */
function isDate(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(text.trim());
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * React list keys for form rows. Module-scoped and only ever increasing, so a
 * key is unique across every mount of the form — which is all a list key has
 * to be — and reading it is not a ref read during render.
 */
let lastKey = 0;
function nextKey(): number {
  lastKey += 1;
  return lastKey;
}

export default function ProtocolEditScreen() {
  // A deep link can repeat a param (?id=a&id=b), which expo-router delivers as
  // string[] despite the generic — coerce so a malformed link degrades to the
  // "no longer exists" branch instead of throwing at the SQLite bind.
  const params = useLocalSearchParams<{
    id?: string | string[];
    item?: string | string[];
    add?: string | string[];
  }>();
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const id = first(params.id);
  const itemId = first(params.item);
  const adding = first(params.add) === '1';
  // Bumped when a save is refused over a change made elsewhere: the key
  // remounts the form, which seeds again from the protocol as it now is. The
  // key also reseeds if this instance is ever re-targeted at another protocol,
  // so protocol A's form can never be saved over protocol B.
  const [generation, setGeneration] = useState(0);
  return (
    <ProtocolEditor
      key={`${id ?? 'new'}:${itemId ?? ''}:${adding ? 'add' : ''}:${generation}`}
      id={id}
      itemId={itemId}
      adding={adding}
      onReload={() => setGeneration((n) => n + 1)}
    />
  );
}

/** What the form opens on, computed once. */
type Seed = {
  phases: EditPhase[];
  /** The item open on arrival, if any. */
  openKey: number | null;
  /** The item to scroll into view on arrival, and the phase it sits in. */
  scrollTo: { phaseKey: number; itemKey: number } | null;
  /** `?item=` named an item the live version no longer lists. */
  missingItem: boolean;
};

function seedForm(
  detail: ProtocolDetail | null,
  itemId: string | undefined,
  adding: boolean,
  nextKey: () => number
): Seed {
  const mint = () => newId(getDb());
  if (!detail) {
    // The create path: one open-ended phase and one item, open, so "creatine,
    // daily" is a name and a title and nothing else.
    const item = blankItem(nextKey(), mint());
    return {
      phases: [{ key: nextKey(), id: mint(), title: '', days: '', items: [item] }],
      openKey: item.key,
      scrollTo: null,
      missingItem: false,
    };
  }
  const phases = seedPhases(detail.content, nextKey);
  if (adding) {
    // *Add an item* adds to the phase that is running today; a protocol not yet
    // started adds to its first, and one that has ended to its last.
    const at =
      detail.phase.kind === 'running'
        ? detail.phase.window.index
        : detail.phase.kind === 'ended'
          ? phases.length - 1
          : 0;
    const phase = phases[Math.min(Math.max(at, 0), phases.length - 1)]!;
    const item = blankItem(nextKey(), mint());
    phase.items.push(item);
    return {
      phases,
      openKey: item.key,
      scrollTo: { phaseKey: phase.key, itemKey: item.key },
      missingItem: false,
    };
  }
  if (itemId !== undefined) {
    for (const phase of phases) {
      const item = phase.items.find((it) => it.id === itemId);
      if (item) {
        return {
          phases,
          openKey: item.key,
          scrollTo: { phaseKey: phase.key, itemKey: item.key },
          missingItem: false,
        };
      }
    }
    return { phases, openKey: null, scrollTo: null, missingItem: true };
  }
  return { phases, openKey: null, scrollTo: null, missingItem: false };
}

function ProtocolEditor({
  id,
  itemId,
  adding,
  onReload,
}: {
  id: string | undefined;
  itemId: string | undefined;
  adding: boolean;
  onReload: () => void;
}) {
  const router = useRouter();
  const detail = useProtocol(id);
  const editing = id != null;

  // Everything below is seeded from the FIRST read only, like every form in
  // this app: a focus refresh must never clobber an edit in progress. What a
  // save needs from the live protocol, it re-reads at save.
  const [seed] = useState<Seed>(() => seedForm(detail, itemId, adding, nextKey));
  const [opened] = useState(() => ({
    base: detail?.content ?? null,
    fields: detail ? protocolFieldsOf(detail.protocol) : null,
    startedOn: detail?.protocol.started_on ?? todayISODate(),
  }));

  const [name, setName] = useState(opened.fields?.name ?? '');
  const [description, setDescription] = useState(opened.fields?.description ?? '');
  const [type, setType] = useState<ProtocolType>(opened.fields?.type ?? 'daily_routine');
  const [carryOver, setCarryOver] = useState(opened.fields?.carryOver ?? false);
  const [checkoffMode, setCheckoffMode] = useState<CheckoffMode>(
    opened.fields?.checkoffMode ?? 'strict'
  );
  const [startedOn, setStartedOn] = useState(opened.startedOn);
  const [phases, setPhases] = useState<EditPhase[]>(seed.phases);
  const [openKey, setOpenKey] = useState<number | null>(seed.openKey);
  const [changeNotes, setChangeNotes] = useState('');

  // Re-entrancy guard: the screen stays touchable during the pop transition,
  // and a double-tap would otherwise run the whole save twice.
  const inFlight = useRef(false);

  // Opening at an item: the phase's offset in the scroll content plus the
  // item's offset in its phase, once both have laid out. Once only — after
  // that, where the user scrolls is theirs.
  const scrollRef = useRef<ScrollView>(null);
  const scrollTarget = useRef(seed.scrollTo);
  const phaseY = useRef(new Map<number, number>());
  const itemY = useRef(new Map<number, number>());
  const tryScroll = () => {
    const target = scrollTarget.current;
    if (!target) return;
    const py = phaseY.current.get(target.phaseKey);
    const iy = itemY.current.get(target.itemKey);
    if (py === undefined || iy === undefined) return;
    scrollTarget.current = null;
    scrollRef.current?.scrollTo({ y: Math.max(py + iy - 16, 0), animated: false });
  };

  if (editing && (!detail || !opened.base || !opened.fields)) {
    return (
      <Screen>
        <View className="pt-2">
          <StackHeader title="Edit Protocol" parent="Protocols" />
        </View>
        <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-muted">
          This protocol no longer exists.
        </Text>
      </Screen>
    );
  }

  const phased = phases.length > 1;
  const content: ProtocolContent = buildContent(phases);
  const nextVersion = (detail?.version?.version_number ?? 0) + 1;

  // The row fields as this form would write them. The start date counts as
  // changed only when it was edited on a phased protocol — the only case where
  // it decides what lands on a day.
  const fields: ProtocolFields = {
    name: name.trim(),
    description: description.trim() || null,
    type,
    startedOn:
      phased && startedOn.trim() !== opened.startedOn && isDate(startedOn)
        ? startedOn.trim()
        : (opened.fields?.startedOn ?? null),
    carryOver,
    checkoffMode,
  };
  const docChanged =
    opened.base !== null && (!same(content, opened.base) || changeNotes.trim() !== '');
  const fieldsChanged = opened.fields !== null && !same(fields, opened.fields);

  // An item already in the protocol keeps its name: clearing it would drop it
  // at save without a word, and removing is what × is for. A NEW blank item is
  // simply not written.
  const stored = new Set(opened.base?.phases.flatMap((p) => p.items.map((it) => it.id)) ?? []);
  const titlesKept = phases.every((phase) =>
    phase.items.every((it) => it.title.trim() !== '' || !stored.has(it.id))
  );
  const timesValid = phases.every((phase) =>
    phase.items.every((it) => it.time.trim() === '' || normalizeTime(it.time) !== null)
  );
  // Every phase but the last needs a length; the last may run on.
  const lengthsValid = phases.every(
    (phase, index) => index === phases.length - 1 || parseDays(phase.days) !== null
  );
  const startValid = !phased || isDate(startedOn);
  const named = name.trim() !== '';
  const valid = named && titlesKept && timesValid && lengthsValid && startValid;
  const canSave = valid && (!editing || docChanged || fieldsChanged);
  // The first thing in the way, in one sentence. A blank name on the CREATE
  // path is where the form starts, not a problem to announce — the inert Save
  // says it; on the edit path it means the name was cleared.
  const problem =
    [
      !named && editing ? 'A protocol needs a name.' : null,
      !titlesKept ? 'An item needs a name. To take one out, use its ×.' : null,
      !timesValid ? 'Times read as HH:MM, e.g. 07:30 — or leave them blank.' : null,
      !lengthsValid ? 'Every phase but the last needs a length in whole days.' : null,
      !startValid ? 'The start date reads as YYYY-MM-DD, e.g. 2026-09-01.' : null,
    ].find((line) => line !== null) ?? null;

  const mint = () => newId(getDb());

  const patchPhase = (key: number, patch: Partial<Omit<EditPhase, 'key'>>) =>
    setPhases((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  const updateItem = (itemKey: number, patch: Partial<Omit<EditItem, 'key' | 'id'>>) =>
    setPhases((prev) =>
      prev.map((p) => ({
        ...p,
        items: p.items.map((it) => (it.key === itemKey ? { ...it, ...patch } : it)),
      }))
    );

  const addItem = (phaseKey: number) => {
    const item = blankItem(nextKey(), mint());
    setPhases((prev) =>
      prev.map((p) => (p.key === phaseKey ? { ...p, items: [...p.items, item] } : p))
    );
    setOpenKey(item.key);
  };

  const removeItem = (itemKey: number) => {
    setPhases((prev) =>
      prev.map((p) => ({ ...p, items: p.items.filter((it) => it.key !== itemKey) }))
    );
    setOpenKey((open) => (open === itemKey ? null : open));
  };

  const moveItem = (phaseKey: number, index: number, by: -1 | 1) =>
    setPhases((prev) =>
      prev.map((p) => (p.key === phaseKey ? { ...p, items: moved(p.items, index, by) } : p))
    );

  /**
   * Adding a phase gives the phase BEFORE it a length, because an open-ended
   * phase in the middle would make everything after it unreachable — the one
   * rule `validateContent` refuses outright. Four weeks is the shape of nearly
   * every titration and is the least surprising number to start from.
   */
  const addPhase = () => {
    const item = blankItem(nextKey(), mint());
    const phase: EditPhase = { key: nextKey(), id: mint(), title: '', days: '', items: [item] };
    setPhases((prev) => [
      ...prev.map((p, i) =>
        i === prev.length - 1 && parseDays(p.days) === null ? { ...p, days: '28' } : p
      ),
      phase,
    ]);
    setOpenKey(item.key);
  };

  const removePhase = (key: number) =>
    setPhases((prev) => (prev.length <= 1 ? prev : prev.filter((p) => p.key !== key)));

  const movePhase = (index: number, by: -1 | 1) => setPhases((prev) => moved(prev, index, by));

  /** After any write: today follows the plan, and the OS schedule follows today. */
  const landed = () => {
    const db = getDb();
    rederiveMissionFromToday(db, todayISODate());
    void syncReminderNotifications(db);
  };

  const save = () => {
    if (inFlight.current || !canSave) return;
    inFlight.current = true;
    // The same gate the Coach's tool passes through, so a document the model
    // could not write cannot be hand-authored either. Only a document this form
    // changed (or creates) is checked: a rename must not be refused over a
    // stored document nobody touched.
    const invalid = docChanged || !editing ? validateContent(content) : null;
    if (invalid) {
      inFlight.current = false;
      Alert.alert('Not saved', invalid);
      return;
    }
    const db = getDb();
    try {
      if (detail && opened.base && opened.fields) {
        const result = saveProtocolEdit(db, detail.protocol.id, {
          base: opened.base,
          content,
          changeNotes: changeNotes.trim() || null,
          opened: opened.fields,
          fields,
        });
        if (!result.ok) {
          // Nothing was written. The form cannot be saved as it stands, so it
          // reseeds from the protocol as it is now and says why.
          inFlight.current = false;
          Alert.alert(
            'Not saved',
            `${result.refusal} Nothing was changed. The form now shows the protocol as it is.`
          );
          onReload();
          return;
        }
      } else {
        createProtocolWithVersion(
          db,
          {
            name: fields.name,
            type,
            description: fields.description,
            // Only a phased protocol names its own start; an unphased one is
            // anchored by the first generation, which the save triggers below.
            startedOn: phased ? startedOn.trim() : null,
            carryOver,
            checkoffMode,
          },
          content
        );
      }
      landed();
      router.back();
    } catch (error) {
      // One transaction either way: nothing partial persisted. Keep the form,
      // say so, and let the user retry.
      inFlight.current = false;
      console.warn('[protocols] save failed', error);
      Alert.alert('Save failed', 'Nothing was changed. Try again.');
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
              // A deleted protocol must stop putting rows on today, and must
              // stop buzzing the phone.
              landed();
              // Past the page, which is now a protocol that no longer exists.
              // `navigate` returns to the hub already in the stack rather than
              // pushing a second copy of it.
              router.navigate('/protocols');
            } catch (error) {
              inFlight.current = false;
              console.warn('[protocols] delete failed', error);
              Alert.alert('Delete failed', 'Nothing was changed. Try again.');
            }
          },
        },
      ]
    );
  };

  return (
    <Screen scroll scrollRef={scrollRef}>
      <View className="pt-2">
        <StackHeader
          title={editing ? 'Edit Protocol' : 'New Protocol'}
          parent={detail ? detail.protocol.name : 'Protocols'}
        />
      </View>

      {seed.missingItem ? (
        <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-muted">
          The item you opened is not in the live version any more.
        </Text>
      ) : null}

      {/* Identity. It lives on the protocol row, not in a version, so changing
          it writes no version on its own. */}
      <View className="mt-6">
        <SectionLabel label="Protocol" />
        <View className="mt-2">
          <FormField
            value={name}
            onChange={setName}
            placeholder="e.g. Morning stack"
            accessibilityLabel="Protocol name"
          />
        </View>
        <View className="mt-2">
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
          {PROTOCOL_TYPES.map((option) => (
            <Chip
              key={option.type}
              label={option.label}
              on={type === option.type}
              onPress={() => setType(option.type)}
            />
          ))}
        </View>
        {editing ? (
          /* The consequence, said once where the control is: the re-derive's
             kept-row update never rewrites a row's type. */
          <Text className="mt-1.5 font-serif text-[12px] leading-4 text-ink-muted">
            The type is the word each item wears on Today&rsquo;s Mission. Changing it applies from
            tomorrow.
          </Text>
        ) : null}
      </View>

      {/* The versioned content. No plate and no rules: a form is controls, and
          one item is separated from the next by air. */}
      {phases.map((phase, phaseIndex) => (
        <View
          key={phase.key}
          className="mt-8"
          onLayout={(event: LayoutChangeEvent) => {
            phaseY.current.set(phase.key, event.nativeEvent.layout.y);
            tryScroll();
          }}>
          {/* No tally on the label on purpose: blank new rows are not written,
              so a count of the rows on screen would not be the count saved. */}
          <SectionLabel
            label={phased ? `Phase ${phaseIndex + 1}` : 'Items'}
            note={phased && phaseIndex === phases.length - 1 ? 'runs on' : undefined}
          />

          {/* Phase chrome exists only once there is more than one phase. */}
          {phased ? (
            <View className="mt-2 flex-row items-center gap-2">
              <FormField
                value={phase.title}
                onChange={(title) => patchPhase(phase.key, { title })}
                placeholder={phaseIndex === 0 ? 'e.g. Loading' : 'e.g. Maintenance'}
                fill
                accessibilityLabel={`Phase ${phaseIndex + 1} name`}
              />
              <View className="w-16">
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
              <MoveButtons
                what={`phase ${phaseIndex + 1}`}
                canUp={phaseIndex > 0}
                canDown={phaseIndex < phases.length - 1}
                onMove={(by) => movePhase(phaseIndex, by)}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove phase ${phaseIndex + 1}`}
                onPress={() => removePhase(phase.key)}
                className="h-11 w-9 items-center justify-center rounded-btn active:bg-paper-dim">
                <Ionicons name="close" size={18} color={palette.inkMuted} />
              </Pressable>
            </View>
          ) : null}

          {phase.items.map((item, index) => (
            <ItemRow
              key={item.key}
              item={item}
              index={index}
              count={phase.items.length}
              open={openKey === item.key}
              phases={phased ? phases : null}
              phaseKey={phase.key}
              onToggle={() => setOpenKey((open) => (open === item.key ? null : item.key))}
              onChange={(patch) => updateItem(item.key, patch)}
              onMove={(by) => moveItem(phase.key, index, by)}
              onRemove={() => removeItem(item.key)}
              onPhase={(to) => setPhases((prev) => moveToPhase(prev, item.key, to))}
              onLayout={(y) => {
                itemY.current.set(item.key, y);
                tryScroll();
              }}
            />
          ))}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={phased ? `Add item to phase ${phaseIndex + 1}` : 'Add item'}
            onPress={() => addItem(phase.key)}
            className="mt-4 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline active:bg-paper-dim">
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

      {/* The phase clock, ONCE in the app. Drawn only when there are phases to
          clock — with one open-ended phase the start date changes nothing that
          lands on a day. */}
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

      {/* Execution POLICY (0050). It writes the protocols row, never a version:
          turning carry-over on is not a revision of the plan, and a restore
          must bring back the plan and not the policy. */}
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

      {editing ? (
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
      ) : null}

      <ProblemLine text={problem} />

      {/* The one accent on this screen (src/components/protocols/form-controls). */}
      <SaveButton
        accessibilityLabel={editing ? 'Save protocol' : 'Create protocol'}
        disabled={!canSave}
        onPress={save}>
        {!editing ? (
          'Create protocol'
        ) : docChanged ? (
          <>
            {'Save as '}
            <Text className="font-mono">{`v${nextVersion}`}</Text>
          </>
        ) : (
          'Save'
        )}
      </SaveButton>

      <SaveFootnote />

      {editing ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Delete protocol"
          onPress={confirmDelete}
          className="mt-8 min-h-[44px] items-center justify-center rounded-btn active:bg-paper-dim">
          <Text className="font-label text-[13px] text-ink-secondary">Delete protocol</Text>
        </Pressable>
      ) : null}
    </Screen>
  );
}

/**
 * One item: a line that states it, and — when open — its fields under it.
 *
 * The line is the protocol page's Now row, so the item reads the same on both
 * screens: the clock in mono (an em-dash where there is none, never a blank
 * column), the name in serif with the dose in mono beside it, the cadence in
 * the label voice. ↑ ↓ × sit beside it and work whether it is open or not.
 */
function ItemRow({
  item,
  index,
  count,
  open,
  phases,
  phaseKey,
  onToggle,
  onChange,
  onMove,
  onRemove,
  onPhase,
  onLayout,
}: {
  item: EditItem;
  index: number;
  count: number;
  open: boolean;
  /** Every phase, when there is more than one — the item's phase chips. */
  phases: EditPhase[] | null;
  phaseKey: number;
  onToggle: () => void;
  onChange: (patch: Partial<Omit<EditItem, 'key' | 'id'>>) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
  onPhase: (phaseKey: number) => void;
  onLayout: (y: number) => void;
}) {
  const title = item.title.trim();
  const label = title || 'New item';
  const time = item.time.trim();
  const dose = item.dose.trim();
  const spoken = title || `item ${index + 1}`;

  return (
    <View
      className={index === 0 ? 'mt-2' : 'mt-1'}
      onLayout={(event: LayoutChangeEvent) => onLayout(event.nativeEvent.layout.y)}>
      <View className="flex-row items-center gap-1">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`${label}, ${time || 'any time'}${dose ? `, ${dose}` : ''}, ${cadenceLabel(
            item.cadence
          )}. ${open ? 'Close' : 'Edit'}`}
          onPress={onToggle}
          className="min-h-[44px] flex-1 flex-row items-baseline gap-2 py-2 active:opacity-60">
          <Text className="w-11 font-mono text-[11px] text-ink-muted">{time || '—'}</Text>
          <Text
            numberOfLines={open ? undefined : 1}
            className={`flex-1 font-serif text-[14px] leading-5 ${title ? 'text-ink' : 'text-ink-muted'}`}>
            {label}
            {dose ? (
              <Text className="font-mono text-[12px] text-ink-secondary">{`  ${dose}`}</Text>
            ) : null}
          </Text>
          <Text
            numberOfLines={1}
            className="font-label text-[10px] uppercase tracking-[0.5px] text-ink-muted">
            {cadenceLabel(item.cadence)}
          </Text>
        </Pressable>
        <MoveButtons what={spoken} canUp={index > 0} canDown={index < count - 1} onMove={onMove} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove ${spoken}`}
          onPress={onRemove}
          className="h-11 w-9 items-center justify-center rounded-btn active:bg-paper-dim">
          <Ionicons name="close" size={18} color={palette.inkMuted} />
        </Pressable>
      </View>

      {open ? (
        <View className="mb-4 mt-1">
          <FormField
            value={item.title}
            onChange={(next) => onChange({ title: next })}
            placeholder="e.g. Creatine"
            accessibilityLabel="Item name"
          />
          <View className="mt-2">
            <FormField
              value={item.dose}
              onChange={(next) => onChange({ dose: next })}
              placeholder="Dose or how-to — 5 g, with food"
              accessibilityLabel="Dose or how-to"
            />
          </View>
          <View className="mt-2">
            {/* The why-line. It is the owner's writing: the generator stamps it
                on every row this item makes, and Home's hero prints it in serif
                italic under the title. The Coach reads it and re-sends it, and
                may reword or clear it in an update you approve. */}
            <FormField
              value={item.why}
              onChange={(next) => onChange({ why: next })}
              placeholder="Why this is here — the line Home prints under it"
              multiline
              accessibilityLabel="Why this item is here"
            />
          </View>
          <TimeControl
            time={item.time}
            remind={item.remind}
            itemLabel={title || 'this item'}
            onChange={(next) => onChange({ time: next.time, remind: next.remind })}
          />
          <CadenceControl
            cadence={item.cadence}
            itemLabel={title || 'this item'}
            onChange={(cadence) => onChange({ cadence })}
          />
          {phases ? (
            <View className="mt-2">
              <View className="flex-row flex-wrap gap-2">
                {phases.map((phase, i) => (
                  <Chip
                    key={phase.key}
                    label={phase.title.trim() || `Phase ${i + 1}`}
                    compact
                    on={phase.key === phaseKey}
                    accessibilityLabel={`In ${phase.title.trim() || `phase ${i + 1}`}`}
                    onPress={() => onPhase(phase.key)}
                  />
                ))}
              </View>
              <Text className="mt-1.5 font-serif text-[12px] leading-4 text-ink-muted">
                Moving an item puts it at the end of that phase.
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Move something up or down by one. Order inside a phase is array order in the
 * version document, and phase order is the whole point of a phased protocol.
 *
 * 28pt wide with `hitSlop` out to a 44pt target — the shape
 * coach/reminders-card.tsx already ships for the same reason: three controls
 * plus a filling line do not fit three 44pt boxes at 375pt, and a target grown
 * by hit area is a real target.
 */
function MoveButtons({
  what,
  canUp,
  canDown,
  onMove,
}: {
  /** Spoken, e.g. "Creatine" or "phase 2". */
  what: string;
  canUp: boolean;
  canDown: boolean;
  onMove: (by: -1 | 1) => void;
}) {
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Move ${what} up`}
        accessibilityState={{ disabled: !canUp }}
        disabled={!canUp}
        hitSlop={{ left: 8, right: 8 }}
        onPress={() => onMove(-1)}
        className="h-11 w-7 items-center justify-center active:opacity-50">
        <Ionicons
          name="chevron-up"
          size={16}
          color={canUp ? palette.inkSecondary : palette.inkMuted}
        />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Move ${what} down`}
        accessibilityState={{ disabled: !canDown }}
        disabled={!canDown}
        hitSlop={{ left: 8, right: 8 }}
        onPress={() => onMove(1)}
        className="h-11 w-7 items-center justify-center active:opacity-50">
        <Ionicons
          name="chevron-down"
          size={16}
          color={canDown ? palette.inkSecondary : palette.inkMuted}
        />
      </Pressable>
    </>
  );
}
