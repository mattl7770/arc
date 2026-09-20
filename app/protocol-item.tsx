import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import { CadenceControl } from '@/components/protocols/cadence-control';
import { Chip } from '@/components/ui/chip';
import {
  FormField,
  normalizeTime,
  ProblemLine,
  SaveButton,
  SaveFootnote,
} from '@/components/protocols/form-controls';
import { TimeControl } from '@/components/protocols/time-control';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { newId } from '@/lib/db/id';
import { rederiveMissionFromToday } from '@/lib/db/repositories/mission-generate';
import { addVersion, getCurrentVersion } from '@/lib/db/repositories/protocols';
import { syncReminderNotifications } from '@/lib/notifications/reminders';
import { DAILY, parseProtocolContent, validateContent } from '@/lib/protocols/content';
import { applyItemToContent, itemChangeNote, phaseOfItem } from '@/lib/protocols/item-edit';
import type { Cadence, ProtocolItem } from '@/lib/protocols/types';
import { useProtocol } from '@/hooks/use-protocols';

/**
 * One item of one protocol — the screen the two-week complaint was really about.
 *
 * Changing a dose used to be: Home → Protocols → the row (a guess, when two
 * protocols run, because the row on Home did not say which one put the item
 * there) → *Edit* → scroll to the item → its dose field → scroll to the foot →
 * *Save as vN*. Five taps, two scrolls and a guess. From the mission row it is
 * now chevron → *Edit this item* → the field → *Save as vN*.
 *
 * ## It does NOT call `reviseProtocol`, and that is structural
 *
 * `reviseProtocol` has no identity-untouched branch: `name`, `type`,
 * `description` and `active` are required and always written, and a defaulted
 * `active: true` would stamp `started_on` on a protocol whose clock was still
 * null — starting a titration from a dose tweak. So this screen writes through
 * **`addVersion`**, the Coach's own path, which touches the `protocols` row not
 * at all. A per-item save therefore leaves `name`, `type`, `description`,
 * `is_active`, `started_on`, `carry_over` and `checkoff_mode` byte-identical by
 * construction rather than by care.
 *
 * ## The live version is re-read AT SAVE, not at mount
 *
 * `useProtocol` seeds once. A Coach `update_protocol` approved while this sheet
 * is open would otherwise be reverted by a save built from mount-time content —
 * the model's change silently undone by a dose edit. So the document is rebuilt
 * from `getCurrentVersion` at the moment of saving, with this one item replaced,
 * appended or removed. If the item's id is no longer in the live version the
 * save refuses and says so; it does not resurrect it.
 *
 * ## Every item save is a version, deliberately
 *
 * Folding several edits into one version would need a draft state on the detail
 * screen — a dirty form on a navigation surface — and would make *Restore*
 * mean "to a fold". Whether a version per dose tweak reads as a record or as
 * noise after a month is a device question.
 *
 * Conformed Set: a form, so **no block** — every field is recessed stock,
 * named by a `SectionLabel`, separated by whitespace (form (b) of the
 * capture-surface rule). Accent budget: exactly one, Save.
 */

export default function ProtocolItemScreen() {
  // A deep link can repeat either param, which expo-router delivers as string[]
  // despite the generic — coerce so a malformed link degrades to the "no longer
  // exists" branch instead of throwing at the SQLite bind.
  const params = useLocalSearchParams<{ id?: string | string[]; item?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const itemId = Array.isArray(params.item) ? params.item[0] : params.item;
  // key remounts the form if this mounted instance is ever re-targeted at a
  // different item, so the fields reseed instead of saving item A over item B.
  return <ProtocolItemEditor key={`${id ?? '?'}:${itemId ?? 'new'}`} id={id} itemId={itemId} />;
}

/** The editable shape of one item. Times and lengths are text so they can be blank. */
type Draft = {
  title: string;
  dose: string;
  why: string;
  time: string;
  remind: boolean;
  cadence: Cadence;
  /** Index of the phase this item sits in. Only meaningful when phased. */
  phase: number;
};

function draftOf(item: ProtocolItem | null, phase: number): Draft {
  return {
    title: item?.title ?? '',
    dose: item?.dose ?? '',
    why: item?.notes ?? '',
    time: item?.scheduled_time ?? '',
    remind: item?.remind ?? false,
    cadence: item?.cadence ?? DAILY,
    phase,
  };
}

function ProtocolItemEditor({
  id,
  itemId,
}: {
  id: string | undefined;
  itemId: string | undefined;
}) {
  const router = useRouter();
  const detail = useProtocol(id);
  const mountedPhase = detail ? phaseOfItem(detail.content, itemId) : -1;
  const mountedItem =
    mountedPhase >= 0
      ? (detail?.content.phases[mountedPhase]?.items.find((it) => it.id === itemId) ?? null)
      : null;

  // Seeded from the first read only, like every form in this app: a focus
  // refresh must never clobber an edit in progress. The save re-reads instead.
  const [draft, setDraft] = useState<Draft>(() =>
    draftOf(mountedItem, mountedPhase >= 0 ? mountedPhase : 0)
  );
  // Re-entrancy guard: the screen stays touchable during the pop transition,
  // and a double-tap would otherwise write two versions.
  const inFlight = useRef(false);

  if (!detail) {
    return (
      <Screen>
        <View className="pt-2">
          <StackHeader title="Item" parent="Protocols" />
        </View>
        <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-muted">
          This protocol no longer exists.
        </Text>
      </Screen>
    );
  }

  const editing = itemId !== undefined;
  // An item asked for by id that the live version no longer lists. A real
  // state — a Coach edit or another save removed it — and the honest answer is
  // to say so rather than offer a form that would re-create it.
  if (editing && mountedItem === null) {
    return (
      <Screen>
        <View className="pt-2">
          <StackHeader title="Item" parent={detail.protocol.name} />
        </View>
        <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-muted">
          This item is not in the live version any more. Open the protocol to see what it asks for
          now.
        </Text>
      </Screen>
    );
  }

  const phases = detail.content.phases;
  const phased = phases.length > 1;
  const nextVersion = (detail.version?.version_number ?? 0) + 1;
  const titled = draft.title.trim() !== '';
  const timeValid = draft.time.trim() === '' || normalizeTime(draft.time) !== null;
  const canSave = titled && timeValid;
  const problem = !titled
    ? 'An item needs a name.'
    : !timeValid
      ? 'A time reads as HH:MM, on the 24-hour clock.'
      : null;

  /**
   * Rebuild the live document with this one item written into it, and write it
   * as a version. Returns a refusal string, or null when it saved.
   */
  const commit = (remove: boolean): string | null => {
    const db = getDb();
    // THE RE-READ. Everything below is built from the version that is live at
    // this instant, not the one that was live at mount.
    const live = parseProtocolContent(getCurrentVersion(db, detail.protocol.id)?.content ?? null);
    const at = phaseOfItem(live, itemId);
    if (editing && at < 0) {
      return 'This item is not in the live version any more. Nothing was changed.';
    }

    const written: ProtocolItem = {
      id: itemId ?? newId(db),
      title: draft.title.trim(),
      scheduled_time: draft.time.trim() === '' ? null : normalizeTime(draft.time),
      dose: draft.dose.trim() || null,
      notes: draft.why.trim() || null,
      cadence: draft.cadence,
      remind: draft.remind,
    };
    // The placement rules are pure and live in src/lib/protocols/item-edit.ts,
    // where they are pinned against the full editor's own output — the rule
    // being that a per-item save must produce a byte-identical document for the
    // same change. A version-less protocol reads as one empty open-ended phase,
    // so the add path needs no special case: this writes v1.
    const rebuilt = applyItemToContent(live, written, { phase: draft.phase, remove });

    // The same gate the Coach's tool and the full editor pass through, so a
    // document neither of them could write cannot be hand-authored here.
    const invalid = validateContent(rebuilt);
    if (invalid) return invalid;

    // One canonical shape on both sides, so a string compare is "nothing
    // changed" — no no-op versions from opening a form and closing it.
    if (detail.version !== null && JSON.stringify(rebuilt) === JSON.stringify(live)) {
      return null;
    }

    const note = itemChangeNote(written.title, remove ? 'removed' : editing ? 'edited' : 'added');
    addVersion(db, detail.protocol.id, rebuilt, note, 'user');
    // The edit reaches TODAY through the same diff a mode change uses, and the
    // OS schedule follows the new plan (C10) — which is what cancels the
    // notification of an item this save retimed or removed.
    rederiveMissionFromToday(db, todayISODate());
    void syncReminderNotifications(db);
    return null;
  };

  const run = (remove: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const refusal = commit(remove);
      if (refusal) {
        inFlight.current = false;
        Alert.alert('Not saved', refusal);
        return;
      }
      router.back();
    } catch (error) {
      // addVersion is one transaction: nothing partial persisted. Keep the
      // form, say so, and let the user retry.
      inFlight.current = false;
      console.warn('[protocols] item save failed', error);
      Alert.alert('Save failed', 'Nothing was changed. Please try again.');
    }
  };

  const confirmRemove = () => {
    Alert.alert('Remove this item?', `"${draft.title.trim()}" leaves the protocol from today.`, [
      { text: 'Keep it', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => run(true) },
    ]);
  };

  const itemLabel = draft.title.trim() || 'this item';

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader
          title={editing ? (mountedItem?.title ?? 'Item') : 'New item'}
          parent={detail.protocol.name}
        />
      </View>

      <View className="mt-6">
        <SectionLabel label="Item" />
        <View className="mt-2">
          <FormField
            value={draft.title}
            onChange={(title) => setDraft((d) => ({ ...d, title }))}
            placeholder="Creatine"
            accessibilityLabel="Item name"
          />
        </View>
        <View className="mt-2">
          <FormField
            value={draft.dose}
            onChange={(dose) => setDraft((d) => ({ ...d, dose }))}
            placeholder="5 g — or a short how-to"
            accessibilityLabel="Dose or how-to"
          />
        </View>
        <View className="mt-2">
          {/* The why-line. It is the owner's writing: the generator stamps it
              on every row this item makes, and Home's hero prints it in serif
              italic under the title. The Coach reads it and re-sends it, and
              may reword or clear it in an update you approve. */}
          <FormField
            value={draft.why}
            onChange={(why) => setDraft((d) => ({ ...d, why }))}
            placeholder="Why this is here — the line Home prints under it"
            multiline
            accessibilityLabel="Why this item is here"
          />
        </View>
      </View>

      <View className="mt-7">
        <SectionLabel label="When" />
        <TimeControl
          time={draft.time}
          remind={draft.remind}
          itemLabel={itemLabel}
          defaultOpen
          onChange={(next) => setDraft((d) => ({ ...d, time: next.time, remind: next.remind }))}
        />
      </View>

      <View className="mt-7">
        <SectionLabel label="How often" />
        <CadenceControl
          cadence={draft.cadence}
          itemLabel={itemLabel}
          defaultOpen
          onChange={(cadence) => setDraft((d) => ({ ...d, cadence }))}
        />
      </View>

      {phased ? (
        <View className="mt-7">
          <SectionLabel label="Phase" />
          <View className="mt-2 flex-row flex-wrap gap-2">
            {phases.map((phase, index) => (
              <Chip
                key={phase.id}
                label={phase.title ?? `Phase ${index + 1}`}
                on={draft.phase === index}
                onPress={() => setDraft((d) => ({ ...d, phase: index }))}
              />
            ))}
          </View>
          {/* The one thing this form cannot express, said where it matters:
              order within a phase is the full editor's. */}
          <Text className="mt-1.5 font-serif text-[12px] leading-4 text-ink-muted">
            Moving an item puts it at the end of that phase. Order is set in the full editor.
          </Text>
        </View>
      ) : null}

      <ProblemLine text={problem} />

      <SaveButton
        accessibilityLabel={editing ? 'Save item' : 'Add item'}
        disabled={!canSave}
        onPress={() => run(false)}>
        {'Save as '}
        <Text className="font-mono">{`v${nextVersion}`}</Text>
      </SaveButton>

      <SaveFootnote />

      {editing ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Remove this item"
          onPress={confirmRemove}
          className="mt-6 min-h-[44px] items-center justify-center rounded-btn active:bg-paper-dim">
          <Text className="font-label text-[13px] text-ink-secondary">Remove this item</Text>
        </Pressable>
      ) : null}
    </Screen>
  );
}
