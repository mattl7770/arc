import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import {
  getKnowledgeEntry,
  listKnowledgeTopics,
  saveKnowledgeEntry,
  updateKnowledgeEntry,
} from '@/lib/db/repositories/knowledge';
import { consumeKnowledgeDraft } from '@/lib/knowledge/draft-handoff';

/**
 * Write or edit a knowledge entry (docs/knowledge-subapp.md §4) — the manual
 * floor of this whole sub-app, and the one rung that works with no key, no
 * network and no model, forever.
 *
 * Reached four ways: the hub's "Write" ghost action, the pack reader's "write
 * your own entry on this topic" (topic prefilled), the reader's Edit, and the
 * import screen's fall-through when a source can't be read.
 *
 * ## What save actually does
 *
 * One transaction: the entry row plus its derived `knowledge_chunks` rows
 * (`source='user-knowledge'`, `entry_id` set, passage-ordered). Editing REPLACES
 * the chunks rather than appending — the `ingestMemory` mirror — so a rewritten
 * entry can never leave a stale passage behind for the Coach to retrieve and
 * cite. All of that is the repository's business; this screen only collects text.
 *
 * ## Conformed Set treatment
 *
 * A **form**, so no device at all: `SectionLabel` names each group and
 * whitespace separates them (form (b) of the capture-surface rule in
 * src/components/ui/block.tsx). Every field wears the well's own surface
 * directly — `border-paper-deep bg-paper-dim`. An input is never `bg-paper-hi`.
 *
 * **Accent budget: one.** Save. The topic chips are neutral, selected-state
 * carried by ink weight and a filled ground rather than by hue — a topic is
 * neither biology nor the next action.
 */

const INPUT = 'border border-paper-deep bg-paper-dim px-3.5 py-3 font-serif text-[15px] text-ink';
/** Written out in full, never composed — Tailwind only sees literal names. */
const INPUT_BODY =
  'min-h-[240px] leading-7 border border-paper-deep bg-paper-dim px-3.5 py-3 font-serif text-[15px] text-ink';
const INPUT_TOPIC =
  'border border-paper-deep bg-paper-dim px-3.5 py-3 font-serif text-[15px] text-ink';

/**
 * Topic chips, on and off. Lifted verbatim from app/metric-entry.tsx so the two
 * switch-chip surfaces in the app read as one control, and both carry the 44pt
 * floor explicitly. Whole class strings, never a built prefix — Tailwind's
 * scanner only sees literals.
 */
const CHIP = 'min-h-[44px] justify-center rounded-btn border border-hairline px-3.5';
const CHIP_ON = 'min-h-[44px] justify-center rounded-btn border border-ink bg-ink px-3.5';

/** Soft guidance, not enforcement — the chunker handles anything. */
const COMFORTABLE_WORDS = 1000;

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

export default function KnowledgeEntryEditScreen() {
  const router = useRouter();
  const { id, topic: topicParam, draft: draftParam } = useLocalSearchParams<{
    id?: string;
    topic?: string;
    draft?: string;
  }>();
  const editing = typeof id === 'string' ? getKnowledgeEntry(getDb(), id) : undefined;

  const [title, setTitle] = useState(editing?.title ?? '');
  const [topic, setTopic] = useState(
    editing?.topic ?? (typeof topicParam === 'string' ? topicParam : 'other')
  );
  // A draft body arrives from the import screen's fall-through through MEMORY,
  // not a route param: text the user already pasted must never be thrown away
  // because the model couldn't read it, and it must not be mangled by URL
  // decoding on the way (src/lib/knowledge/draft-handoff.ts). Read-and-clear in
  // the initializer, which is why that function has a replay window.
  //
  // Only consume when this mount is the stash's intended recipient — the import
  // fall-through sets `draft: '1'`. Without that gate the handoff's replay window
  // (scoped by elapsed time, not by mount) would leak an abandoned paste into a
  // fresh "Write an entry" opened within its window.
  const [draft] = useState(() =>
    editing || draftParam !== '1' ? null : consumeKnowledgeDraft()
  );
  const [body, setBody] = useState(editing?.body ?? draft?.body ?? '');
  const [topics] = useState<string[]>(() => listKnowledgeTopics(getDb()));

  const words = wordCount(body);
  const canSave = title.trim() !== '' && body.trim() !== '';

  const save = () => {
    if (!canSave) return;
    const db = getDb();
    if (editing) {
      updateKnowledgeEntry(db, editing.id, { title, topic, body });
      router.back();
      return;
    }
    // A fall-through from a failed URL import keeps its source URL — the entry
    // is still "written by you", but the provenance line can say where from.
    const newId = saveKnowledgeEntry(db, {
      title,
      topic,
      body,
      source: 'user',
      sourceUrl: draft?.sourceUrl ?? undefined,
    });
    // `replace`, not `push`: coming back from the reader should land on the hub,
    // not on the empty editor the entry was just written in.
    router.replace({ pathname: '/knowledge-entry', params: { id: newId, kind: 'entry' } });
  };

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title={editing ? 'Edit entry' : 'Write an entry'} parent="Knowledge" />
      </View>

      <View className="mt-5">
        <SectionLabel label="Title" />
        <TextInput
          accessibilityLabel="Title"
          value={title}
          onChangeText={setTitle}
          placeholder="What this entry commits to"
          placeholderTextColor={palette.inkMuted}
          className={INPUT}
          style={{ marginTop: 8 }}
        />
      </View>

      {/* Topic: chips of the vocabulary already in use, plus free text for a new
          one. The vocabulary is data-owned (0035 leaves `topic` free text), so
          wanting "dental" is never a migration. */}
      <View className="mt-7">
        <SectionLabel label="Topic" />
        <View className="mt-2 flex-row flex-wrap gap-2">
          {topics.map((t) => {
            const selected = t === topic;
            return (
              <Pressable
                key={t}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={t}
                onPress={() => setTopic(t)}
                className={selected ? CHIP_ON : CHIP}>
                <Text
                  className={
                    selected
                      ? 'font-label text-[13px] font-semibold text-paper-hi'
                      : 'font-label text-[13px] font-semibold text-ink-secondary'
                  }>
                  {t}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <TextInput
          accessibilityLabel="Topic"
          value={topic}
          onChangeText={setTopic}
          placeholder="or a new one"
          placeholderTextColor={palette.inkMuted}
          autoCapitalize="none"
          autoCorrect={false}
          className={INPUT_TOPIC}
          style={{ marginTop: 8 }}
        />
      </View>

      <View className="mt-7">
        <SectionLabel
          label="The entry"
          note={words > 0 ? `${words} word${words === 1 ? '' : 's'}` : undefined}
        />
        <TextInput
          accessibilityLabel="Entry body"
          value={body}
          onChangeText={setBody}
          placeholder={
            'What you’ve decided, and why — the claim, the mechanism, the numbers you trust.\n\n' +
            'Blank lines separate paragraphs and are kept.'
          }
          placeholderTextColor={palette.inkMuted}
          multiline
          textAlignVertical="top"
          className={INPUT_BODY}
          style={{ marginTop: 8 }}
        />
        {/* Guidance, and only when it is relevant. Never a hard limit: the
            chunker splits anything, so an over-long entry is a reading problem,
            not a storage one — and the app says so rather than refusing. */}
        <Text className="mt-2 font-serif text-[12px] leading-5 text-ink-muted">
          {words > COMFORTABLE_WORDS
            ? `Long for one entry (${words} words). It will save and search fine — doctrine just reads better split into a few entries than run together in one.`
            : 'An entry is a page, not a paper. What you commit to, stated so the Coach can cite it.'}
        </Text>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={editing ? 'Save changes' : 'Save entry'}
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
          {editing ? 'Save changes' : 'Save entry'}
        </Text>
      </Pressable>
    </Screen>
  );
}
